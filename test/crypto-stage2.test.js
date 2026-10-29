"use strict";
/**
 * Crypto Phase 2 - viewer identity (design A sections 3.2-3.5 / 7), relay side, e2e:
 *   viewer key registration + tokenless challenge-response login, forged signature and
 *   revoked viewer rejection, the adminSig dual track for management frames, content
 *   key grant routing between devices and viewers with roster stamping, and ackFp
 *   divergence raising key_mismatch.
 * Signature payloads are assembled by hand in this file from the cross-end contract
 * (never via relay helpers), so a drift between the two implementations fails here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { normalizePairCode, newPairCode, pairCheckDigits } = require("../relay/pairing.js");
const { keyFingerprint } = require("../relay/util.js");

const LOCAL_TOKEN = "stage2-local-token";
const VIEWER_TOKEN = "stage2-viewer-token";
const ADMIN_TOKEN = "stage2-admin-token";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crypto2-"));
}

async function boot(overrides = {}) {
  const dir = tmpDir();
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: dir,
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    perMessageDeflate: false,
    ...overrides,
  });
  relay.__dir = dir;
  return relay;
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const waiters = [];
  ws.on("error", () => {});
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      msg = { __raw: data.toString("utf8") };
    }
    frames.push(msg);
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue;
      msg.__taken = true;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      break;
    }
  });
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    wait(pred, ms = 3000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f));
      if (hit) {
        hit.__taken = true;
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`timeout waiting for ${what}; got: ${frames.map((f) => f.__raw || f.type).join(",")}`));
          }, ms),
        };
        w.timer.unref();
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type);
    },
    close() {
      try {
        ws.terminate();
      } catch {}
    },
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Viewer keys: BOTH signing (VIK) and box (VBK) are P-256, spki der base64. */
function genViewerKeys() {
  const sign = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    signPriv: sign.privateKey,
    boxPriv: box.privateKey,
    signPub: sign.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    boxPub: box.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** Device keys (Phase 1 material): Ed25519 signing + P-256 box. */
function genDeviceKeys() {
  const sign = crypto.generateKeyPairSync("ed25519");
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    signPriv: sign.privateKey,
    boxPriv: box.privateKey,
    signPub: sign.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    boxPub: box.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const signP256 = (keys, payload) =>
  crypto.sign("sha256", payload, { key: keys.signPriv, dsaEncoding: "ieee-p1363" }).toString("base64");

async function authedViewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  const frame = { type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4 };
  if (caps) frame.caps = caps;
  v.send(frame);
  const res = await v.type("auth_result");
  assert.equal(res.ok, true);
  return { conn: v, authResult: res };
}

/** Register a viewer identity over an admin-authorized connection (adminToken track). */
async function registerViewer(adminConn, { viewerId, keys, admin = false, id }) {
  adminConn.send({
    type: "viewer_register",
    id,
    adminToken: ADMIN_TOKEN,
    viewerId,
    name: "test viewer",
    signPub: keys.signPub,
    boxPub: keys.boxPub,
    admin,
  });
  return adminConn.type("ack", (f) => f.id === id);
}

/**
 * Viewer challenge-response login with NO token anywhere. The signed payload is the
 * shared auth payload with the viewerId as identity:
 * utf8("pi-remote-auth-v1") || utf8(viewerId) || relayNonce || clientNonce.
 */
async function viewerKeyAuth(relay, viewerId, keys, { signWith = null, keyFp = null } = {}) {
  const c = client(relay.viewerPort);
  await c.opened;
  const clientNonce = crypto.randomBytes(16);
  c.send({
    type: "auth",
    role: "viewer",
    proto: 4,
    caps: ["crypto.auth"],
    viewerId,
    keyFp: keyFp || keyFingerprint(keys.signPub),
    clientNonce: clientNonce.toString("base64"),
  });
  const first = await c.wait((f) => f.type === "auth_challenge" || f.type === "auth_result", 3000, "auth_challenge/auth_result");
  if (first.type === "auth_result") return { conn: c, result: first };
  const payload = Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from(viewerId, "utf8"),
    Buffer.from(first.nonce, "base64"),
    clientNonce,
  ]);
  c.send({ type: "auth_response", sig: signP256(signWith || keys, payload) });
  const result = await c.type("auth_result");
  return { conn: c, result, challenge: first };
}

/** Device pairing with keys via a manual pair code (Phase 1 flow, condensed). */
async function pairDeviceWithKeys(relay, adminConn, deviceId, keys) {
  adminConn.send({ type: "pair_create", id: `pc-${deviceId}`, adminToken: ADMIN_TOKEN });
  const ack = await adminConn.type("ack", (f) => f.id === `pc-${deviceId}`);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const code = normalizePairCode(ack.data.code);
  const pop = crypto.sign(null, Buffer.from(code, "utf8"), keys.signPriv).toString("base64");
  const c = client(relay.localPort);
  await c.opened;
  c.send({
    type: "pair",
    code: ack.data.code,
    device: { id: deviceId, name: "key device", platform: "linux" },
    keys: { signPub: keys.signPub, boxPub: keys.boxPub, pop },
  });
  const res = await c.type("pair_result");
  c.close();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.keyRegistered, true);
  return res;
}

/** Device challenge-response login (Phase 1 flow, condensed). */
async function deviceKeyAuth(relay, deviceId, keys) {
  const c = client(relay.localPort);
  await c.opened;
  const clientNonce = crypto.randomBytes(16);
  c.send({
    type: "auth",
    role: "local",
    proto: 4,
    caps: ["crypto.auth"],
    deviceId,
    keyFp: keyFingerprint(keys.signPub),
    clientNonce: clientNonce.toString("base64"),
  });
  const first = await c.wait((f) => f.type === "auth_challenge" || f.type === "auth_result", 3000, "auth_challenge/auth_result");
  assert.equal(first.type, "auth_challenge", JSON.stringify(first));
  const payload = Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from(deviceId, "utf8"),
    Buffer.from(first.nonce, "base64"),
    clientNonce,
  ]);
  const sig = crypto.sign(null, payload, keys.signPriv).toString("base64");
  c.send({ type: "auth_response", sig });
  const result = await c.type("auth_result");
  assert.equal(result.ok, true, JSON.stringify(result));
  return { conn: c, result };
}

/* Independent re-implementation of the pinned adminSig canonicalization:
 * payload = utf8("pi-remote-admin-v1") || utf8(frame.type) || utf8(canonical JSON of
 * the frame without adminSig/adminToken/type/id; object keys sorted recursively).
 * The id is excluded: it is a transport correlation handle the web transports
 * stamp onto the frame after signing, not management intent. */
function canonJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonJson(v[k])).join(",") + "}";
}
function adminSign(frame, keys) {
  const rest = {};
  for (const k of Object.keys(frame)) {
    if (k === "adminSig" || k === "adminToken" || k === "type" || k === "id") continue;
    rest[k] = frame[k];
  }
  const payload = Buffer.concat([
    Buffer.from("pi-remote-admin-v1", "utf8"),
    Buffer.from(String(frame.type), "utf8"),
    Buffer.from(canonJson(rest), "utf8"),
  ]);
  return signP256(keys, payload);
}

test("viewer registration + tokenless key login; roster row persisted", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());
  const keys = genViewerKeys();
  const ack = await registerViewer(admin, { viewerId: "viewer-web-1", keys, id: "reg-1" });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.data.viewerId, "viewer-web-1");
  assert.equal(ack.data.keyFp, keyFingerprint(keys.signPub));
  assert.equal(ack.data.admin, false);

  // The roster row is on disk under the account dir (public keys only).
  const stack = [relay.__dir];
  let found = null;
  while (stack.length && !found) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === "viewers.jsonl") found = p;
    }
  }
  assert.ok(found, "viewers.jsonl must exist");
  const row = JSON.parse(fs.readFileSync(found, "utf8").trim().split("\n").pop());
  assert.equal(row.viewerId, "viewer-web-1");
  assert.equal(row.signPub, keys.signPub);
  assert.equal(row.boxPub, keys.boxPub);

  // list_viewers shows the row with the contract fields.
  admin.send({ type: "list_viewers", id: "lv-1", adminToken: ADMIN_TOKEN });
  const list = await admin.type("viewer_list", (f) => f.id === "lv-1");
  const entry = list.viewers.find((v) => v.viewerId === "viewer-web-1");
  assert.ok(entry);
  assert.equal(entry.keyFp, keyFingerprint(keys.signPub));
  assert.equal(entry.admin, false);
  assert.ok(entry.createdAt > 0);
  assert.equal(entry.revokedAt, null);

  // Tokenless key login: no token field is ever sent on this connection.
  const { conn, result } = await viewerKeyAuth(relay, "viewer-web-1", keys);
  t.after(() => conn.close());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.auth, "key");
  assert.equal(result.viewerId, "viewer-web-1");
  assert.ok("ackFp" in result);
  assert.equal(result.ackFp, null);
});

test("registration validation: Ed25519 viewer sign key rejected; active re-key rejected", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());

  // A device-style key set (Ed25519 sign) is not a valid viewer key set.
  const devKeys = genDeviceKeys();
  const bad = await registerViewer(admin, { viewerId: "viewer-bad", keys: devKeys, id: "reg-bad" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "bad_args");

  const keys = genViewerKeys();
  const ok = await registerViewer(admin, { viewerId: "viewer-web-2", keys, id: "reg-2" });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // Same viewerId with different keys while active: rejected, must revoke first.
  const other = genViewerKeys();
  const rekey = await registerViewer(admin, { viewerId: "viewer-web-2", keys: other, id: "reg-3" });
  assert.equal(rekey.ok, false);
  assert.equal(rekey.code, "device_mismatch");

  // Registration without any admin proof is refused.
  admin.send({ type: "viewer_register", id: "reg-4", viewerId: "viewer-x", signPub: other.signPub, boxPub: other.boxPub });
  const denied = await admin.type("ack", (f) => f.id === "reg-4");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "admin_required");
});

test("forged viewer signature rejected (auth_failed); unknown fingerprint rejected pre-challenge", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());
  const keys = genViewerKeys();
  await registerViewer(admin, { viewerId: "viewer-web-3", keys, id: "reg-1" });

  const attacker = genViewerKeys();
  const forged = await viewerKeyAuth(relay, "viewer-web-3", keys, { signWith: attacker });
  assert.equal(forged.result.ok, false);
  assert.equal(forged.result.code, "auth_failed");
  forged.conn.close();

  const ghost = await viewerKeyAuth(relay, "viewer-web-3", attacker);
  assert.equal(ghost.result.ok, false);
  assert.equal(ghost.result.code, "device_mismatch");
  ghost.conn.close();
});

test("revoked viewer: live connection dropped, key login refused with device_revoked, ack carries ACK-rotation hint", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());
  const keys = genViewerKeys();
  await registerViewer(admin, { viewerId: "viewer-web-4", keys, id: "reg-1" });
  const { conn } = await viewerKeyAuth(relay, "viewer-web-4", keys);
  t.after(() => conn.close());

  admin.send({ type: "viewer_revoke", id: "rev-1", adminToken: ADMIN_TOKEN, viewerId: "viewer-web-4" });
  const ack = await admin.type("ack", (f) => f.id === "rev-1");
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(ack.data.ackRotationRequired, true);
  assert.match(ack.data.hint, /ACK/);
  assert.ok(ack.data.closed >= 1, "the live keyed connection must be dropped");

  const dropped = await conn.type("error", (f) => f.code === "device_revoked");
  assert.ok(dropped);

  const again = await viewerKeyAuth(relay, "viewer-web-4", keys);
  assert.equal(again.result.ok, false);
  assert.equal(again.result.code, "device_revoked");
  again.conn.close();

  admin.send({ type: "list_viewers", id: "lv-9", adminToken: ADMIN_TOKEN });
  const list = await admin.type("viewer_list", (f) => f.id === "lv-9");
  const entry = list.viewers.find((v) => v.viewerId === "viewer-web-4");
  assert.ok(entry.revokedAt > 0);
});

test("adminSig dual track: admin viewer signs management frames; bad sig and non-admin sig rejected", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());

  const adminKeys = genViewerKeys();
  const regA = await registerViewer(admin, { viewerId: "viewer-admin", keys: adminKeys, admin: true, id: "reg-a" });
  assert.equal(regA.data.admin, true);
  const plainKeys = genViewerKeys();
  await registerViewer(admin, { viewerId: "viewer-plain", keys: plainKeys, id: "reg-p" });

  const { conn: va } = await viewerKeyAuth(relay, "viewer-admin", adminKeys);
  t.after(() => va.close());

  // pair_create with adminSig instead of adminToken.
  const frame = { type: "pair_create", id: "pc-sig-1", name: "via sig" };
  va.send({ ...frame, adminSig: adminSign(frame, adminKeys) });
  const ack = await va.type("ack", (f) => f.id === "pc-sig-1");
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.ok(ack.data.code, "a pair code must be issued");

  // Regression (live breakage): the web identity core signs the frame BEFORE
  // any id exists; the transports (channel.raw / requestViewerList) stamp the
  // request id on afterwards. The relay must still verify the signature --
  // the id is a transport correlation handle, not signed intent.
  const preId = { type: "pair_create", name: "signed before transport id" };
  va.send({ ...preId, id: "pc-sig-1b", adminSig: adminSign(preId, adminKeys) });
  const ackT = await va.type("ack", (f) => f.id === "pc-sig-1b");
  assert.equal(ackT.ok, true, JSON.stringify(ackT));
  assert.ok(ackT.data.code, "a pair code must be issued");

  // The exact flow that broke live: list_viewers signed without an id, the
  // transport-stamped id echoed back on the viewer_list reply.
  const lvShape = { type: "list_viewers", adminBy: "viewer-admin" };
  va.send({ ...lvShape, id: "lv-sig-1", adminSig: adminSign(lvShape, adminKeys) });
  const lv = await va.type("viewer_list", (f) => f.id === "lv-sig-1");
  assert.ok(lv.viewers.some((v) => v.viewerId === "viewer-admin"));

  // Only the id sits outside the signature: a signature made over different
  // signed content (another name) is still rejected.
  const tampered = { type: "pair_create", id: "pc-sig-2", name: "real" };
  const sigForOther = adminSign({ type: "pair_create", id: "pc-sig-2", name: "other" }, adminKeys);
  va.send({ ...tampered, adminSig: sigForOther });
  const bad = await va.type("ack", (f) => f.id === "pc-sig-2");
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "admin_required");

  // A non-admin viewer's perfectly valid signature is still not an admin proof.
  const { conn: vp } = await viewerKeyAuth(relay, "viewer-plain", plainKeys);
  t.after(() => vp.close());
  const frame2 = { type: "pair_create", id: "pc-sig-3" };
  vp.send({ ...frame2, adminSig: adminSign(frame2, plainKeys) });
  const denied = await vp.type("ack", (f) => f.id === "pc-sig-3");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "admin_required");

  // viewer_revoke via adminSig also works (revoking the plain viewer). The signer is
  // named by adminBy: on this frame viewerId is the revocation target, not the signer.
  const rev = { type: "viewer_revoke", id: "rev-sig-1", viewerId: "viewer-plain", adminBy: "viewer-admin" };
  va.send({ ...rev, adminSig: adminSign(rev, adminKeys) });
  const revAck = await va.type("ack", (f) => f.id === "rev-sig-1");
  assert.equal(revAck.ok, true, JSON.stringify(revAck));
  assert.equal(revAck.data.ackRotationRequired, true);
});

test("content key request/grant routed device<->viewer with roster stamps intact", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());

  const devKeys = genDeviceKeys();
  await pairDeviceWithKeys(relay, admin, "dev-p2", devKeys);
  const { conn: dev } = await deviceKeyAuth(relay, "dev-p2", devKeys);
  t.after(() => dev.close());

  const viewKeys = genViewerKeys();
  await registerViewer(admin, { viewerId: "viewer-p2", keys: viewKeys, id: "reg-1" });
  const { conn: view } = await viewerKeyAuth(relay, "viewer-p2", viewKeys);
  t.after(() => view.close());

  const devFp = keyFingerprint(devKeys.signPub);
  const viewFp = keyFingerprint(viewKeys.signPub);

  // Device asks: the viewer receives the request stamped with the device's roster keys.
  dev.send({ type: "content_key_request", want: "account" });
  const reqAtViewer = await view.type("content_key_request");
  assert.equal(reqAtViewer.from, devFp);
  assert.equal(reqAtViewer.fromBoxPub, devKeys.boxPub);

  // Viewer asks: the device receives the request stamped with the viewer's roster keys.
  view.send({ type: "content_key_request", want: "account" });
  const reqAtDevice = await dev.type("content_key_request");
  assert.equal(reqAtDevice.from, viewFp);
  assert.equal(reqAtDevice.fromBoxPub, viewKeys.boxPub);

  const nonce = crypto.randomBytes(12).toString("base64");
  const ct = crypto.randomBytes(64).toString("base64");

  // Viewer grants to the device; a bogus sender-supplied fromBoxPub must be overridden
  // by the roster stamp.
  view.send({ type: "content_key_grant", to: devFp, nonce, ct, fromBoxPub: devKeys.boxPub });
  const grantAtDevice = await dev.type("content_key_grant");
  assert.equal(grantAtDevice.to, devFp);
  assert.equal(grantAtDevice.nonce, nonce);
  assert.equal(grantAtDevice.ct, ct);
  assert.equal(grantAtDevice.from, viewFp);
  assert.equal(grantAtDevice.fromBoxPub, viewKeys.boxPub);

  // Device grants back to the viewer.
  dev.send({ type: "content_key_grant", to: viewFp, nonce, ct });
  const grantAtViewer = await view.type("content_key_grant");
  assert.equal(grantAtViewer.to, viewFp);
  assert.equal(grantAtViewer.from, devFp);
  assert.equal(grantAtViewer.fromBoxPub, devKeys.boxPub);

  // A token-only viewer connection is not a keyed endpoint: grant attempts are refused.
  const { conn: tok } = await authedViewer(relay);
  t.after(() => tok.close());
  tok.send({ type: "content_key_grant", to: devFp, nonce, ct });
  const refused = await tok.type("error", (f) => f.code === "device_mismatch");
  assert.ok(refused);
});

test("regression: grant built by the real contentKeyGrantFrame passes the relay cleaner and reaches the device", async (t) => {
  // Wave 3 follow-up #7, defect A: the UI builder used to emit a nested
  // { accountId, blob: { nonce, ct } } shape that the relay's shared cleaner
  // (top-level to/nonce/ct only) always rejected with bad_args, so a viewer's
  // ACK answer never left the relay. This test sends the frame exactly as the
  // web UI builds it -- the real builder imported from protocol.ts.
  const { contentKeyGrantFrame } = require("../ui/src/relay/protocol.ts");
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());

  const devKeys = genDeviceKeys();
  await pairDeviceWithKeys(relay, admin, "dev-flat", devKeys);
  const { conn: dev } = await deviceKeyAuth(relay, "dev-flat", devKeys);
  t.after(() => dev.close());

  const viewKeys = genViewerKeys();
  await registerViewer(admin, { viewerId: "viewer-flat", keys: viewKeys, id: "reg-1" });
  const { conn: view } = await viewerKeyAuth(relay, "viewer-flat", viewKeys);
  t.after(() => view.close());

  const devFp = keyFingerprint(devKeys.signPub);
  const viewFp = keyFingerprint(viewKeys.signPub);
  const nonce = crypto.randomBytes(12).toString("base64");
  const ct = crypto.randomBytes(64).toString("base64");

  const frame = contentKeyGrantFrame({ to: devFp, blob: { nonce, ct } });
  assert.deepEqual(Object.keys(frame).sort(), ["ct", "nonce", "to", "type"], "grant frame must be the flat canonical shape");
  view.send(frame);

  const grantAtDevice = await dev.type("content_key_grant");
  assert.equal(grantAtDevice.to, devFp);
  assert.equal(grantAtDevice.nonce, nonce);
  assert.equal(grantAtDevice.ct, ct);
  assert.equal(grantAtDevice.from, viewFp);
  assert.equal(grantAtDevice.fromBoxPub, viewKeys.boxPub);

  // The sender must not be answered with bad_args (the old cleaner's verdict)
  // or offline (routing succeeded above, so neither error may appear).
  await sleep(150);
  assert.equal(
    view.frames.some((f) => f.type === "error" && (f.code === "bad_args" || f.code === "offline")),
    false,
    "the relay must not reject or strand a canonically shaped viewer grant",
  );
});

test("regression: grant reaches every same-fingerprint local connection, not just the first", async (t) => {
  // Wave 3 follow-up #7, defect B: one device normally holds two local
  // connections with the same keyFp -- an attach window connection that does
  // not process grant frames and the extension bridge connection that does.
  // First-match routing silently dropped the grant whenever the window
  // connected first. Both connections below key-auth as the same device; the
  // first stands in for the non-consuming window, the second for the bridge.
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());

  const devKeys = genDeviceKeys();
  await pairDeviceWithKeys(relay, admin, "dev-dual", devKeys);
  const { conn: windowConn } = await deviceKeyAuth(relay, "dev-dual", devKeys);
  t.after(() => windowConn.close());
  const { conn: bridgeConn } = await deviceKeyAuth(relay, "dev-dual", devKeys);
  t.after(() => bridgeConn.close());

  const viewKeys = genViewerKeys();
  await registerViewer(admin, { viewerId: "viewer-dual", keys: viewKeys, id: "reg-1" });
  const { conn: view } = await viewerKeyAuth(relay, "viewer-dual", viewKeys);
  t.after(() => view.close());

  const devFp = keyFingerprint(devKeys.signPub);
  const nonce = crypto.randomBytes(12).toString("base64");
  const ct = crypto.randomBytes(64).toString("base64");
  view.send({ type: "content_key_grant", to: devFp, nonce, ct });

  // The grant must arrive at BOTH connections: delivery is to every matching
  // endpoint, so the bridge copy lands even though the window connected first.
  const atWindow = await windowConn.type("content_key_grant");
  assert.equal(atWindow.to, devFp);
  assert.equal(atWindow.nonce, nonce);
  const atBridge = await bridgeConn.type("content_key_grant");
  assert.equal(atBridge.to, devFp);
  assert.equal(atBridge.nonce, nonce);
  assert.equal(atBridge.ct, ct);

  await sleep(150);
  assert.equal(
    view.frames.some((f) => f.type === "error" && f.code === "offline"),
    false,
    "a delivered grant must not be answered with the offline error",
  );
});

test("ackFp divergence triggers key_mismatch on both ends; convergence re-arms the warning", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());

  const devKeys = genDeviceKeys();
  await pairDeviceWithKeys(relay, admin, "dev-ack", devKeys);
  const { conn: dev, result: devAuth } = await deviceKeyAuth(relay, "dev-ack", devKeys);
  t.after(() => dev.close());
  assert.equal(devAuth.ackFp, null, "nothing reported yet");

  const FP_A = "aaaaaaaaaaaaaaaa";
  const FP_B = "bbbbbbbbbbbbbbbb";

  dev.send({ type: "ack_report", ackFp: FP_A });

  const viewKeys = genViewerKeys();
  await registerViewer(admin, { viewerId: "viewer-ack", keys: viewKeys, id: "reg-1" });
  const { conn: view, result: viewAuth } = await viewerKeyAuth(relay, "viewer-ack", viewKeys);
  t.after(() => view.close());
  assert.equal(viewAuth.ackFp, FP_A, "the device consensus is handed to the next key login");

  // Agreeing report: no warning anywhere.
  view.send({ type: "ack_report", ackFp: FP_A });
  await sleep(250);
  assert.equal(view.frames.filter((f) => f.code === "key_mismatch").length, 0);
  assert.equal(dev.frames.filter((f) => f.code === "key_mismatch").length, 0);

  // Diverging report: both reporting ends are warned, with both fingerprints listed.
  view.send({ type: "ack_report", ackFp: FP_B });
  const warnView = await view.type("error", (f) => f.code === "key_mismatch");
  const warnDev = await dev.type("error", (f) => f.code === "key_mismatch");
  assert.deepEqual([...warnView.ackFps].sort(), [FP_A, FP_B]);
  assert.deepEqual([...warnDev.ackFps].sort(), [FP_A, FP_B]);
  assert.equal(warnView.retryable, true);

  // Convergence clears the warned state; a fresh divergence warns again.
  dev.send({ type: "ack_report", ackFp: FP_B });
  await sleep(250);
  view.send({ type: "ack_report", ackFp: FP_A });
  await view.type("error", (f) => f.code === "key_mismatch" && f !== warnView);
  await dev.type("error", (f) => f.code === "key_mismatch" && f !== warnDev);
});

test("pair_lookup_result: keyed pending entry carries keyFp + boxPub; unkeyed entry carries neither", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay);
  t.after(() => admin.close());

  // Keyed link request: the device proposes its own code and proves possession
  // of the signing key (PoP over the bare code), like the Phase 1 QR flow.
  const keys = genDeviceKeys();
  const proposed = newPairCode(new Map());
  const dev = client(relay.localPort);
  t.after(() => dev.close());
  await dev.opened;
  const pop = crypto.sign(null, Buffer.from(proposed, "utf8"), keys.signPriv).toString("base64");
  dev.send({
    type: "pair_request",
    device: { id: "dev-lookup-1", name: "keyed link device", platform: "linux" },
    code: proposed,
    keys: { signPub: keys.signPub, boxPub: keys.boxPub, pop },
  });
  const rr = await dev.type("pair_request_result");
  assert.equal(rr.ok, true, JSON.stringify(rr));

  admin.send({ type: "pair_lookup", id: "lk-keyed", code: rr.code });
  const look = await admin.type("pair_lookup_result", (f) => f.id === "lk-keyed");
  assert.equal(look.keyFp, keyFingerprint(keys.signPub));
  // The web end wraps the account content key to exactly this box key when it
  // approves with a contentKeyGrant, so the value must match the entry verbatim.
  assert.equal(look.boxPub, keys.boxPub);
  assert.equal(look.checkDigits, rr.checkDigits);

  // Unkeyed link request: the result keeps its legacy shape, no key fields at all.
  const dev2 = client(relay.localPort);
  t.after(() => dev2.close());
  await dev2.opened;
  dev2.send({ type: "pair_request", device: { name: "legacy link device", platform: "linux" } });
  const rr2 = await dev2.type("pair_request_result");
  assert.equal(rr2.ok, true, JSON.stringify(rr2));

  admin.send({ type: "pair_lookup", id: "lk-plain", code: rr2.code });
  const look2 = await admin.type("pair_lookup_result", (f) => f.id === "lk-plain");
  assert.equal("keyFp" in look2, false);
  assert.equal("boxPub" in look2, false);
  assert.equal(look2.checkDigits, pairCheckDigits(normalizePairCode(rr2.code)), "unkeyed entries keep the v1 check digits");
});
