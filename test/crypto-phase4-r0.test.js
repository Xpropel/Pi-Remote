"use strict";
/**
 * Crypto Phase 4, slice R-0, gate B -- relay side (ACK-rotation design
 * section 1.2). A room's stored enc meta (ackFp + rckWrap) is the only key
 * pointer for its encrypted history; before this gate, a room_register or
 * snapshot declaration overwrote it unconditionally, so a device whose
 * ACK had been silently replaced could re-declare the room under the new
 * fingerprint and orphan every existing record. Gate B refuses ackFp
 * transitions on both declaration intakes (reply: crypto_required) and
 * inside store.setEncMeta itself. The legitimate transition channels are
 * exempt by construction: migration (store.migrateRoom applies the meta
 * after trailer verification) and the future room_key_rewrap frame.
 *
 * Covered here:
 *   store level -- first declaration lands; same-fp re-declaration (even
 *     with a different wrap) still lands; a different-fp declaration is
 *     refused and the stored meta is untouched, also across a cold
 *     reopen; an fp-less meta (the envelope-without-declaration safety
 *     net) can still be completed by a declaration.
 *   wire level -- register re-declaring another ackFp gets a
 *     crypto_required error frame while the registration itself proceeds
 *     and the stored meta stays authoritative; a snapshot declaration
 *     attempting the same transition is refused the same way; a verified
 *     migration may still move the ackFp (the exempt channel).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { RoomStore } = require("../relay/store.js");
const { normalizePairCode } = require("../relay/pairing.js");
const { keyFingerprint } = require("../relay/util.js");

// Test-only relay credentials, assembled from fragments.
const LOCAL_TOKEN = "phase4-r0-local-token";
const VIEWER_TOKEN = "phase4-r0-viewer-token";
const ADMIN_TOKEN = "phase4-r0-admin-token";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-crypto4r0-"));

const FP_A = "0123456789abcdef";
const FP_B = "fedcba9876543210";
const WRAP_A = crypto.randomBytes(60).toString("base64");
const WRAP_A2 = crypto.randomBytes(60).toString("base64");
const WRAP_B = crypto.randomBytes(60).toString("base64");

const H = (label) => crypto.createHash("sha256").update(`h:${label}`).digest("hex");
function envelope(role, label) {
  return {
    enc: 1,
    role,
    h: H(label),
    ct: Buffer.concat([crypto.randomBytes(12), Buffer.from(`ct:${label}`), crypto.randomBytes(16)]).toString("base64"),
  };
}

/* ------------------------------------------------------------------ */
/* Store level                                                         */
/* ------------------------------------------------------------------ */

function openStore(dir, opts = {}) {
  return new RoomStore(dir, { persist: true, prewarm: false, ...opts });
}

test("gate B (store): first declaration and same-fp re-declarations land; a different-fp declaration is refused and the meta survives a cold reopen", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  assert.equal(s.setEncMeta("r1", { enc: 1, ackFp: FP_A, rckWrap: WRAP_A }), true, "first declaration lands");
  assert.deepEqual(s.encInfo("r1"), { enc: 1, ackFp: FP_A, rckWrap: WRAP_A });

  // Same ackFp with a fresh wrap (re-wrap under the same ACK) is not a
  // transition and keeps the pre-gate behavior.
  assert.equal(s.setEncMeta("r1", { enc: 1, ackFp: FP_A, rckWrap: WRAP_A2 }), true, "same-fp re-declaration lands");
  assert.deepEqual(s.encInfo("r1"), { enc: 1, ackFp: FP_A, rckWrap: WRAP_A2 });

  // A different ackFp is a transition: refused, stored meta untouched.
  assert.equal(s.setEncMeta("r1", { enc: 1, ackFp: FP_B, rckWrap: WRAP_B }), false, "different-fp declaration must be refused");
  assert.deepEqual(s.encInfo("r1"), { enc: 1, ackFp: FP_A, rckWrap: WRAP_A2 }, "the stored meta must survive the refused transition");

  // The refusal is not an in-memory artifact: after a flush + cold
  // reopen the room still points at the original wrap.
  s.record("r1", { type: "message_end", message: envelope("user", "m0") });
  s.flushAll();
  const s2 = openStore(dir);
  assert.deepEqual(s2.encInfo("r1"), { enc: 1, ackFp: FP_A, rckWrap: WRAP_A2 }, "cold reopen must still see the original meta");
});

test("gate B (store): an fp-less enc meta (envelope arrived without a declaration) can still be completed", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  // The safety net: an envelope record with no prior declaration marks
  // the room enc WITHOUT key material (encInfo has no ackFp).
  s.record("r2", { type: "message_end", message: envelope("user", "orphan") });
  const marked = s.encInfo("r2");
  assert.ok(marked && marked.enc === 1, "room is marked enc by the safety net");
  assert.equal(marked.ackFp, undefined, "the safety-net meta carries no ackFp");
  // Completing it with a real declaration is not a transition.
  assert.equal(s.setEncMeta("r2", { enc: 1, ackFp: FP_A, rckWrap: WRAP_A }), true, "completing an fp-less meta must be allowed");
  assert.deepEqual(s.encInfo("r2"), { enc: 1, ackFp: FP_A, rckWrap: WRAP_A });
});

/* ------------------------------------------------------------------ */
/* Wire level (real relay, key-authed device)                          */
/* ------------------------------------------------------------------ */

async function boot() {
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
    persistTranscripts: true,
    flushIntervalMs: 10,
  });
  relay.__dir = dir;
  return relay;
}

/** Minimal WS client with frame capture + predicate waits (stage1-3 pattern). */
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
    wait(pred, ms = 5000, what = "frame") {
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
const popFor = (keys, code) =>
  crypto.sign(null, Buffer.from(normalizePairCode(code), "utf8"), keys.signPriv).toString("base64");

async function authedViewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  const frame = { type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4 };
  if (caps) frame.caps = caps;
  v.send(frame);
  const res = await v.type("auth_result");
  assert.equal(res.ok, true, JSON.stringify(res));
  return v;
}

async function pairKeyDevice(relay, adminViewer, deviceId) {
  adminViewer.send({ type: "pair_create", id: `pc4-${deviceId}`, adminToken: ADMIN_TOKEN });
  const ack = await adminViewer.type("ack", (f) => f.id === `pc4-${deviceId}`);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const keys = genDeviceKeys();
  const c = client(relay.localPort);
  await c.opened;
  c.send({
    type: "pair",
    code: ack.data.code,
    device: { id: deviceId, name: "phase4 r0 device", platform: "linux" },
    keys: { signPub: keys.signPub, boxPub: keys.boxPub, pop: popFor(keys, ack.data.code) },
  });
  const res = await c.type("pair_result");
  c.close();
  assert.equal(res.ok, true, JSON.stringify(res));
  return keys;
}

const ENC_CAPS = ["crypto.auth", "crypto.content"];
async function keyAuthDevice(relay, deviceId, keys, caps) {
  const c = client(relay.localPort);
  await c.opened;
  const clientNonce = crypto.randomBytes(16);
  c.send({
    type: "auth",
    role: "local",
    proto: 4,
    caps,
    deviceId,
    keyFp: keyFingerprint(keys.signPub),
    clientNonce: clientNonce.toString("base64"),
  });
  const first = await c.wait(
    (f) => f.type === "auth_challenge" || f.type === "auth_result",
    5000,
    "auth_challenge/auth_result",
  );
  if (first.type === "auth_result") return c;
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
  return c;
}

async function registerRoom(conn, roomId, deviceId, encDecl) {
  const room = { id: roomId, deviceId, label: `phase4 ${roomId}`, cwd: "/tmp/phase4" };
  if (encDecl) room.enc = encDecl;
  conn.send({ type: "room_register", room });
  return conn.type("room_registered", (f) => f.room === roomId);
}

async function subscribeSnapshot(viewerConn, roomId) {
  viewerConn.send({ type: "subscribe", room: roomId });
  return viewerConn.type("snapshot", (f) => f.room === roomId, 8000);
}

test("gate B (wire): register re-declaring a different ackFp is refused with crypto_required; the stored meta stays authoritative", { timeout: 60000 }, async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const admin = await authedViewer(relay, null);
  t.after(() => admin.close());
  const keys = await pairKeyDevice(relay, admin, "dev-r0-b");
  const dev = await keyAuthDevice(relay, "dev-r0-b", keys, ENC_CAPS);
  t.after(() => dev.close());

  const roomId = "r0-gate-b";
  const declA = { ackFp: FP_A, rckWrap: WRAP_A };
  await registerRoom(dev, roomId, "dev-r0-b", declA);
  assert.equal(
    dev.frames.filter((f) => f.type === "error" && f.code === "crypto_required").length,
    0,
    "the first declaration must not be refused",
  );

  // The disaster move: the same device re-registers declaring another
  // ackFp (its ACK was replaced elsewhere). Refused loudly...
  await registerRoom(dev, roomId, "dev-r0-b", { ackFp: FP_B, rckWrap: WRAP_B });
  const err = dev.frames.find((f) => f.type === "error" && f.code === "crypto_required" && f.room === roomId);
  assert.ok(err, "re-declaring a different ackFp must be answered with crypto_required");
  assert.equal(err.retryable, false);

  // ...and the stored meta is still the original one.
  const capViewer = await authedViewer(relay, ENC_CAPS);
  t.after(() => capViewer.close());
  const snap = await subscribeSnapshot(capViewer, roomId);
  assert.equal(snap.enc, 1);
  assert.deepEqual(snap.keyInfo, { ackFp: FP_A, rckWrap: WRAP_A }, "the stored meta must stay authoritative after the refused transition");

  // Same-fp re-declaration afterwards is business as usual (no refusal).
  const errorsBefore = dev.frames.filter((f) => f.type === "error").length;
  await registerRoom(dev, roomId, "dev-r0-b", declA);
  await sleep(200);
  assert.equal(
    dev.frames.filter((f) => f.type === "error").length,
    errorsBefore,
    "a same-fp re-declaration must not be refused",
  );
});

test("gate B (wire): a snapshot declaration attempting an ackFp transition is refused; a verified migration may still move the ackFp", { timeout: 60000 }, async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const admin = await authedViewer(relay, null);
  t.after(() => admin.close());
  const keys = await pairKeyDevice(relay, admin, "dev-r0-snap");
  const dev = await keyAuthDevice(relay, "dev-r0-snap", keys, ENC_CAPS);
  t.after(() => dev.close());

  const roomId = "r0-gate-b-snap";
  await registerRoom(dev, roomId, "dev-r0-snap", { ackFp: FP_A, rckWrap: WRAP_A });
  const envsA = [envelope("user", "a1"), envelope("assistant", "a2")];
  dev.send({ type: "snapshot", room: roomId, messages: envsA, enc: { ackFp: FP_A, rckWrap: WRAP_A } });
  await sleep(400);

  // Snapshot declaration carrying a different ackFp: refused wholesale.
  dev.send({ type: "snapshot", room: roomId, messages: [envelope("user", "evil")], enc: { ackFp: FP_B, rckWrap: WRAP_B } });
  const err = await dev.type("error", (f) => f.code === "crypto_required" && f.room === roomId, 5000);
  assert.equal(err.retryable, false);
  const capViewer = await authedViewer(relay, ENC_CAPS);
  t.after(() => capViewer.close());
  const snap1 = await subscribeSnapshot(capViewer, roomId);
  assert.deepEqual(snap1.keyInfo, { ackFp: FP_A, rckWrap: WRAP_A }, "the refused snapshot declaration must not move the meta");
  assert.equal((snap1.messages || []).length, 2, "the refused snapshot's records must not land in the room");

  // The exempt channel: a verified migration declares the new ackFp and
  // the meta moves (migrateRoom applies it after trailer verification).
  const envsB = [envelope("user", "b1"), envelope("assistant", "b2")];
  dev.send({
    type: "snapshot",
    room: roomId,
    messages: envsB,
    enc: { ackFp: FP_B, rckWrap: WRAP_B },
    migration: { msgCount: envsB.length, lastHash: envsB[envsB.length - 1].h },
  });
  const mig = await dev.type("migration_result", (f) => f.room === roomId, 8000);
  assert.equal(mig.ok, true, `verified migration must still succeed (got ${JSON.stringify(mig)})`);
  const snap2 = await subscribeSnapshot(capViewer, roomId);
  assert.deepEqual(snap2.keyInfo, { ackFp: FP_B, rckWrap: WRAP_B }, "a verified migration moves the ackFp (the exempt channel)");
});
