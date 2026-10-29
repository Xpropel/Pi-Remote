// Regression: key-auth startup race (found by frame capture in Wave 3
// verification). A real pi session binds its session BEFORE the relay
// socket opens, so Bridge.connect()'s onopen used to emit room_register /
// state / usage (and a session_manifest ~40ms later) in the same burst as
// the auth frame. Token auth completes synchronously at the relay, which
// masked the race; key auth is a challenge-response round trip, so those
// frames reached the relay unauthenticated and the pre-auth dispatcher
// answered them with a fatal auth_result(auth_failed) + close -- the
// bridge latched authFailed and the device never mirrored.
//
// This file pins all three sides of the fix:
//  1. The real Bridge, started exactly like the extension factory does on
//     session_start (start() + bindSession() in the same tick), completes
//     key auth against a real relay and registers its room.
//  2. Token auth under the same startup order still works (control case).
//  3. At the relay, a stray business frame pipelined between the key auth
//     frame and auth_response is dropped silently: auth still completes
//     and the frame leaves no trace.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { startRelay } = require("../relay/server.js");
const { normalizePairCode } = require("../relay/pairing.js");
const { keyFingerprint } = require("../relay/util.js");
const WebSocket = require("ws");

const LOCAL_TOKEN = "race-local-token";
const VIEWER_TOKEN = "race-viewer-token";
const ADMIN_TOKEN = "race-admin-token";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-keyauth-race-"));
const relay = await startRelay({
  localPort: 0,
  viewerPort: 0,
  dataDir: path.join(tmp, "rooms"),
  accountsDir: path.join(tmp, "accounts"),
  quiet: true,
  exitOnListenError: false,
  localToken: LOCAL_TOKEN,
  viewerToken: VIEWER_TOKEN,
  adminToken: ADMIN_TOKEN,
  perMessageDeflate: false,
});

/* ---------- raw WS client + pairing helpers (same shapes as crypto-stage1) ---------- */

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
            reject(new Error(`waiting for ${what} timed out; got: ${frames.map((f) => f.__raw || f.type).join(",")}`));
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

const until = async (pred, ms = 4000, what = "condition") => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for: " + what);
    await sleep(10);
  }
};

function genKeys() {
  const sign = crypto.generateKeyPairSync("ed25519");
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = (k, type) => k.export({ format: "der", type }).toString("base64");
  return {
    signPriv: sign.privateKey,
    boxPriv: box.privateKey,
    signPub: der(sign.publicKey, "spki"),
    boxPub: der(box.publicKey, "spki"),
    signPrivDer: der(sign.privateKey, "pkcs8"),
    boxPrivDer: der(box.privateKey, "pkcs8"),
  };
}

const popFor = (keys, code) => crypto.sign(null, Buffer.from(normalizePairCode(code), "utf8"), keys.signPriv).toString("base64");

async function authedViewer() {
  const v = client(relay.viewerPort);
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4 });
  const res = await v.type("auth_result");
  assert.equal(res.ok, true);
  return v;
}

async function adminPairCode(v, id) {
  v.send({ type: "pair_create", id, adminToken: ADMIN_TOKEN });
  const ack = await v.type("ack", (f) => f.id === id);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  return ack.data.code;
}

async function pairWithCode({ code, device, keys, pop, deviceToken }) {
  const c = client(relay.localPort);
  await c.opened;
  const frame = { type: "pair", code, device };
  if (keys) frame.keys = { signPub: keys.signPub, boxPub: keys.boxPub, pop };
  if (deviceToken) frame.deviceToken = deviceToken;
  c.send(frame);
  const res = await c.type("pair_result");
  c.close();
  return res;
}

/** §3.1 key-file shape (the material loadDeviceKey accepts). */
function keyFileData(deviceId, keys) {
  return {
    v: 1,
    deviceId,
    createdAt: Date.now(),
    sign: { alg: "ed25519", pub: keys.signPub, priv: keys.signPrivDer },
    box: { alg: "p256", pub: keys.boxPub, priv: keys.boxPrivDer },
  };
}

/* ---------- extension env: fixed BEFORE the module import (module-level relay/token) ---------- */

const attachFile = path.join(tmp, "remote-attach.json");
process.env.PI_REMOTE_RELAY = `ws://127.0.0.1:${relay.localPort}`;
process.env.PI_REMOTE_TOKEN = LOCAL_TOKEN;
process.env.PI_REMOTE_ATTACH_FILE = attachFile;
process.env.PI_REMOTE_LOG = path.join(tmp, "ext.log");
delete process.env.PI_REMOTE_DEVICE_ID;
delete process.env.PI_REMOTE_DEVICE_TOKEN;
delete process.env.PI_REMOTE_DEVICE_KEY_FILE;
delete process.env.PI_REMOTE_ALWAYS_ONLINE;

const jiti = createJiti(import.meta.url, { interopDefault: false });
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname);

/** The attach window the extension's gate reads: unexpired, owned by this test
 *  process, and bound to the device the env names. */
function openWindow(deviceId) {
  fs.writeFileSync(attachFile, JSON.stringify({ pid: process.pid, deviceId, accountId: "admin", expiresAt: Date.now() + 3600e3 }));
}

function bridgeCtx(room) {
  return {
    cwd: tmp,
    isIdle: () => true,
    model: { id: "m", provider: "p" },
    sessionManager: { sessionId: room, cwd: tmp, getBranch: () => [], getSessionName: () => null, getSessionId: () => room },
  };
}

function makeBridge() {
  const bridge = new ext.Bridge();
  bridge.pi = { sendUserMessage: () => {}, getThinkingLevel: () => "off" };
  return bridge;
}

test.after(async () => {
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/* ---------- 1) the real Bridge under the real session_start order, key auth ---------- */

const ROOM_KEY = "race-room-key";
test("key auth: start + bindSession in the same tick -> challenge completes, room registers, no authFailed latch", async (t) => {
  const v = await authedViewer();
  t.after(() => v.close());
  const deviceId = "dev-race-key";
  const keys = genKeys();
  const code = await adminPairCode(v, "race-pc-key");
  const res = await pairWithCode({ code, device: { id: deviceId, name: "race key", platform: "linux" }, keys, pop: popFor(keys, code) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.keyRegistered, true);
  assert.equal(res.deviceToken, undefined, "key pairing issues no device token");

  const keyFile = path.join(tmp, "race.key.json");
  fs.writeFileSync(keyFile, JSON.stringify(keyFileData(deviceId, keys)), { mode: 0o600 });
  process.env.PI_REMOTE_DEVICE_ID = deviceId;
  process.env.PI_REMOTE_DEVICE_KEY_FILE = keyFile;
  delete process.env.PI_REMOTE_DEVICE_TOKEN;
  openWindow(deviceId);

  const bridge = makeBridge();
  t.after(() => { try { bridge.stop(); } catch {} });
  // The extension factory's session_start handler runs start() and then
  // bindSession() synchronously: the room is bound BEFORE the socket opens,
  // which is exactly the ordering that used to spray pre-auth frames.
  bridge.start();
  bridge.bindSession(bridgeCtx(ROOM_KEY));

  await until(() => bridge.authed && relay.rooms.peek(ROOM_KEY) && relay.rooms.peek(ROOM_KEY).online, 4000, "key-authed room online");
  assert.equal(bridge.relayAuth, "key");
  assert.equal(bridge.authFailed, false);
  // Settled stability: no flap, no late latch, room stays bound to this bridge.
  await sleep(400);
  assert.equal(bridge.authed, true);
  assert.equal(bridge.authFailed, false);
  assert.equal(relay.rooms.peek(ROOM_KEY).online, true);
  bridge.stop();
});

/* ---------- 2) control: token auth under the same startup order ---------- */

const ROOM_TOKEN = "race-room-token";
test("token auth: start + bindSession in the same tick still registers the room", async (t) => {
  const v = await authedViewer();
  t.after(() => v.close());
  const deviceId = "dev-race-token";
  const code = await adminPairCode(v, "race-pc-token");
  const res = await pairWithCode({ code, device: { id: deviceId, name: "race token", platform: "linux" } });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(typeof res.deviceToken === "string" && res.deviceToken.length > 0);

  delete process.env.PI_REMOTE_DEVICE_KEY_FILE;
  process.env.PI_REMOTE_DEVICE_ID = deviceId;
  process.env.PI_REMOTE_DEVICE_TOKEN = res.deviceToken;
  openWindow(deviceId);

  const bridge = makeBridge();
  t.after(() => { try { bridge.stop(); } catch {} });
  bridge.start();
  bridge.bindSession(bridgeCtx(ROOM_TOKEN));

  await until(() => bridge.authed && relay.rooms.peek(ROOM_TOKEN) && relay.rooms.peek(ROOM_TOKEN).online, 4000, "token-authed room online");
  assert.equal(bridge.relayAuth, "token");
  assert.equal(bridge.authFailed, false);
  bridge.stop();
});

/* ---------- 3) relay: stray frame inside the challenge window ---------- */

test("relay: business frames pipelined during the key challenge are dropped; auth completes; no trace left", async (t) => {
  const v = await authedViewer();
  t.after(() => v.close());
  const deviceId = "dev-race-stray";
  const keys = genKeys();
  const code = await adminPairCode(v, "race-pc-stray");
  const res = await pairWithCode({ code, device: { id: deviceId, name: "race stray", platform: "linux" }, keys, pop: popFor(keys, code) });
  assert.equal(res.ok, true, JSON.stringify(res));

  const c = client(relay.localPort);
  t.after(() => c.close());
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
  const challenge = await c.type("auth_challenge");
  assert.ok(challenge.nonce, "the key challenge must be issued first");

  // The optimistic burst an unfixed bridge used to send in this exact window.
  c.send({ type: "room_register", room: { id: "stray-room", label: "x", cwd: "/tmp", epoch: 1, instance: "i-stray" } });
  c.send({ type: "state", room: "stray-room", busy: true });
  c.send({ type: "usage", room: "stray-room", usage: {} });

  const payload = Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from(deviceId, "utf8"),
    Buffer.from(challenge.nonce, "base64"),
    clientNonce,
  ]);
  c.send({ type: "auth_response", sig: crypto.sign(null, payload, keys.signPriv).toString("base64") });

  const authResult = await c.type("auth_result");
  assert.equal(authResult.ok, true, JSON.stringify(authResult));
  assert.equal(authResult.auth, "key");
  assert.equal(c.frames.filter((f) => f.type === "auth_result").length, 1, "no failure auth_result may precede the success");
  assert.equal(c.ws.readyState, WebSocket.OPEN, "the connection must survive the stray frames");
  assert.equal(relay.rooms.peek("stray-room"), null, "the stray room_register must leave no room behind");
  c.close();
});
