"use strict";
/**
 * Crypto Phase 3 - body encryption (design A sections 4.1 / 5 / 7), relay-side
 * gates that the cross-end harness (crypto-stage3.test.js) does not cover:
 *   - enc records across segment sealing + manifest + checkpoint cold-open,
 *     envelope bytes identical after restore, manifest carries enc fields;
 *   - pending remote envelopes (ct+h) survive a restart and still supersede by h;
 *   - h-based remote supersede is FIFO even for duplicate h values, and the
 *     plaintext text comparison is unchanged;
 *   - reset() inherits the enc flag (never washes back to plaintext);
 *   - mixed plaintext/enc generations enumerate and purge cleanly;
 *   - store-level migration: trailer mismatch keeps both generations, a live
 *     writer blocks, a verified trailer deletes the plaintext generation;
 *   - WS gates: extension plaintext writes into an enc room are rejected per
 *     write with crypto_required (cap or not), plaintext rooms are unaffected;
 *   - viewer enc message forwarding; search over an enc room returns the
 *     explicit unsupported marker;
 *   - cryptoPlaintextRooms readonly/deny policy;
 *   - perf guard: ~110MB enc room cold-open info() timing.
 * Envelopes here are shape-valid stand-ins (random ct, sha256-shaped h): the
 * relay must treat ct as opaque, so real AES output is unnecessary on this side.
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

const LOCAL_TOKEN = "local-token-0123456789abcdef";
const VIEWER_TOKEN = "viewer-token-0123456789abcdef";
const ADMIN_TOKEN = "admin-token-0123456789abcdef";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-crypto3r-"));

let n = 0;
const H = (label) => crypto.createHash("sha256").update(`h:${label}`).digest("hex");
function envelope(role, label) {
  return {
    enc: 1,
    role,
    h: H(label),
    ct: Buffer.concat([crypto.randomBytes(12), Buffer.from(`ct:${label}`), crypto.randomBytes(16)]).toString("base64"),
  };
}
const frameJson = (env) => JSON.stringify({ enc: 1, role: env.role, h: env.h, ct: env.ct });
const ACK_FP = "0123456789abcdef";
const RCK_WRAP = crypto.randomBytes(60).toString("base64");
const ENC_META = { enc: 1, ackFp: ACK_FP, rckWrap: RCK_WRAP };

function openStore(dir, opts = {}) {
  return new RoomStore(dir, { persist: true, prewarm: false, ...opts });
}

/* ------------------------------------------------------------------ */
/* Store level                                                         */
/* ------------------------------------------------------------------ */

test("stage3-relay store: enc sealing + manifest + checkpoint cold-open roundtrip", async () => {
  const dir = tmpDir();
  const opts = { segmentMaxBytes: 2048, ckptMinBytes: 1, ckptIntervalBytes: 1 };
  const s = openStore(dir, opts);
  assert.equal(s.setEncMeta("r1", ENC_META), true);
  const envs = [];
  for (let i = 0; i < 30; i++) {
    const env = envelope(i % 2 ? "assistant" : "user", `m${i}`);
    envs.push(env);
    s.record("r1", { type: "message_end", message: env });
  }
  s.flushAll();
  // Manifest carries the room-dimension enc fields.
  const man = JSON.parse(fs.readFileSync(path.join(dir, "r1.index.json"), "utf8"));
  assert.equal(man.enc, 1);
  assert.equal(man.ackFp, ACK_FP);
  assert.equal(man.rckWrap, RCK_WRAP);
  // Segment files hold envelope records and no plaintext body markers.
  const disk = fs.readdirSync(dir).filter((f) => f.startsWith("r1")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  assert.ok(disk.includes('"enc":1'), "enc records on disk");
  assert.ok(!disk.includes("ct:m0") || disk.includes("Y3Q6"), "ct stays base64-opaque");
  // Cold open: envelopes byte-identical, anchors are the h values.
  const s2 = openStore(dir, opts);
  const info = s2.info("r1");
  assert.equal(info.enc, 1);
  assert.equal(info.msgCount, 30);
  assert.equal(info.firstHash, envs[0].h);
  assert.equal(info.lastHash, envs[envs.length - 1].h);
  const snap = s2.snapshot("r1", { limit: 10000, maxBytes: 64 * 1024 * 1024 });
  assert.equal(snap.enc, 1);
  assert.deepEqual(snap.keyInfo, { ackFp: ACK_FP, rckWrap: RCK_WRAP });
  assert.deepEqual(snap.items, envs.map(frameJson), "envelope bytes identical after cold open");
});

test("stage3-relay store: pending remote ct survives restart; supersede by h still works", async () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.setEncMeta("r1", ENC_META);
  const remoteEnv = envelope("user", "remote-1");
  s.record("r1", { type: "remote_message", enc: 1, h: remoteEnv.h, ct: remoteEnv.ct, cid: "c1", at: 1000 });
  s.flushAll();
  const s2 = openStore(dir);
  let snap = s2.snapshot("r1", { limit: 100, maxBytes: 1024 * 1024 });
  assert.equal(snap.items.length, 1);
  const parsed = JSON.parse(snap.items[0]);
  assert.equal(parsed.enc, 1);
  assert.equal(parsed.remote, true);
  assert.equal(parsed.ct, remoteEnv.ct, "pending ct byte-identical after restart");
  assert.equal(parsed.h, remoteEnv.h);
  // The echo lands after the restart: the pending remote is superseded by h.
  s2.record("r1", { type: "message_end", message: envelope("user", "remote-1") });
  snap = s2.snapshot("r1", { limit: 100, maxBytes: 1024 * 1024 });
  assert.equal(snap.items.length, 1);
  assert.equal(JSON.parse(snap.items[0]).remote, undefined, "remote entry superseded by h after restart");
});

test("stage3-relay store: h supersede is FIFO for duplicate h; plaintext text path unchanged", async () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.setEncMeta("r1", ENC_META);
  const dupH = H("dup");
  const ct1 = crypto.randomBytes(40).toString("base64");
  const ct2 = crypto.randomBytes(40).toString("base64");
  s.record("r1", { type: "remote_message", enc: 1, h: dupH, ct: ct1, at: 1 });
  s.record("r1", { type: "remote_message", enc: 1, h: dupH, ct: ct2, at: 2 });
  s.record("r1", { type: "message_end", message: { enc: 1, role: "user", h: dupH, ct: crypto.randomBytes(40).toString("base64") } });
  const snap = s.snapshot("r1", { limit: 100, maxBytes: 1024 * 1024 });
  const remotes = snap.items.map((j) => JSON.parse(j)).filter((m) => m.remote);
  assert.equal(remotes.length, 1, "exactly one duplicate-h remote superseded");
  assert.equal(remotes[0].ct, ct2, "FIFO: the earliest pending remote is the one superseded");

  // Plaintext room: identical texts, one echo -> earliest text remote superseded.
  const user = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
  s.record("rp", { type: "remote_message", text: "same text", at: 1 });
  s.record("rp", { type: "remote_message", text: "same text", at: 2 });
  s.record("rp", { type: "message_end", message: user("same text", 3) });
  const snapP = s.snapshot("rp", { limit: 100, maxBytes: 1024 * 1024 });
  const remotesP = snapP.items.map((j) => JSON.parse(j)).filter((m) => m.remote);
  assert.equal(remotesP.length, 1);
});

test("stage3-relay store: reset inherits enc; reseed to envelopes purges plaintext generation", async () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.setEncMeta("r1", ENC_META);
  s.record("r1", { type: "message_end", message: envelope("user", "a") });
  s.flushAll();
  assert.equal(s.reset("r1"), true);
  assert.equal(s.info("r1").enc, 1, "reset must not wash the room back to plaintext");
  // Plaintext room reseeded with envelopes (anchor mismatch -> reset+seed):
  // the plaintext generation's bytes leave the disk files.
  const plain = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
  s.seedOrMerge("r2", [plain("PLAIN-MARKER-ONE", 1), plain("PLAIN-MARKER-TWO", 2)], {});
  s.flushAll();
  const envs = [envelope("user", "x1"), envelope("assistant", "x2")];
  const r = s.seedOrMerge("r2", envs, {});
  assert.ok(r.reset || r.seeded, "envelope reseed replaces the generation");
  s.flushAll();
  const disk = fs.readdirSync(dir).filter((f) => f.startsWith("r2")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  assert.ok(!disk.includes("PLAIN-MARKER"), "plaintext generation purged from disk");
  assert.equal(s.info("r2").enc, 1, "envelope seed marks the room enc (safety net)");
  const snap = s.snapshot("r2", { limit: 100, maxBytes: 1024 * 1024 });
  assert.deepEqual(snap.items, envs.map(frameJson));
});

test("stage3-relay store: mixed generations enumerate + drop purges every artifact", async () => {
  const dir = tmpDir();
  const s = openStore(dir, { segmentMaxBytes: 1024 });
  const plain = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
  for (let i = 0; i < 10; i++) s.record("plain-room", { type: "message_end", message: plain(`p${i}`, i) });
  s.setEncMeta("enc-room", ENC_META);
  for (let i = 0; i < 10; i++) s.record("enc-room", { type: "message_end", message: envelope("user", `e${i}`) });
  s.flushAll();
  assert.equal(s.exists("plain-room"), true);
  assert.equal(s.exists("enc-room"), true);
  assert.equal(s.info("plain-room").enc, 0);
  assert.equal(s.info("enc-room").enc, 1);
  s.drop("enc-room");
  assert.equal(s.roomFileExists("enc-room"), false, "drop removes active + sealed + manifest");
  assert.equal(s.roomFileExists("plain-room"), true, "other rooms untouched");
  const left = fs.readdirSync(dir).filter((f) => f.startsWith("enc-room"));
  assert.deepEqual(left, []);
});

test("stage3-relay store: migration verify-pass / verify-fail / live-writer", async () => {
  const dir = tmpDir();
  const s = openStore(dir);
  const plain = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
  s.seedOrMerge("rm", [plain("MIG-MARKER", 1), plain("MIG-MARKER-2", 2)], {});
  s.flushAll();
  const envs = [envelope("user", "mig-1"), envelope("assistant", "mig-2")];
  const trailer = { msgCount: envs.length, lastHash: envs[envs.length - 1].h };
  // Live writer blocks before anything else.
  let res = s.migrateRoom("rm", envs, trailer, ENC_META, { hasLiveWriter: true });
  assert.deepEqual({ ok: res.ok, reason: res.reason }, { ok: false, reason: "live_writer" });
  // Trailer mismatch: both generations survive.
  res = s.migrateRoom("rm", envs, { msgCount: 99, lastHash: trailer.lastHash }, ENC_META, {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, "trailer_mismatch");
  assert.equal(s.info("rm").enc, 0);
  let snap = s.snapshot("rm", { limit: 100, maxBytes: 1024 * 1024 });
  assert.equal(snap.items.length, 2, "plaintext generation intact after failed migration");
  // Verified trailer: plaintext generation deleted, enc generation seeded.
  res = s.migrateRoom("rm", envs, trailer, ENC_META, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.msgCount, 2);
  assert.equal(s.info("rm").enc, 1);
  s.flushAll();
  const disk = fs.readdirSync(dir).filter((f) => f.startsWith("rm")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("");
  assert.ok(!disk.includes("MIG-MARKER"), "plaintext generation deleted after verified migration");
  snap = s.snapshot("rm", { limit: 100, maxBytes: 1024 * 1024 });
  assert.deepEqual(snap.items, envs.map(frameJson));
});

test("stage3-relay perf: ~110MB enc room cold-open info() stays near the manifest-hit baseline", async () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.setEncMeta("big", ENC_META);
  const COUNT = 40000;
  const envs = [];
  // ~2.8KB of ct per record -> ~110MB total.
  const filler = crypto.randomBytes(2100).toString("base64");
  for (let i = 0; i < COUNT; i++) {
    envs.push({ enc: 1, role: i % 2 ? "assistant" : "user", h: H(`big-${i}`), ct: filler });
  }
  s.seedOrMerge("big", envs, {});
  s.flushAll();
  const bytes = fs.readdirSync(dir).filter((f) => f.startsWith("big")).reduce((acc, f) => acc + fs.statSync(path.join(dir, f)).size, 0);
  assert.ok(bytes > 100 * 1024 * 1024, `room should be ~110MB, got ${(bytes / 1048576).toFixed(1)}MB`);
  const s2 = openStore(dir);
  const t0 = performance.now();
  const info = s2.info("big");
  const ms = performance.now() - t0;
  console.log(`[stage3-relay perf] cold-open info() on ${(bytes / 1048576).toFixed(1)}MB enc room: ${ms.toFixed(1)}ms (R-4 baseline 10-22ms)`);
  assert.equal(info.enc, 1);
  assert.equal(info.msgCount, COUNT);
  assert.equal(info.lastHash, envs[COUNT - 1].h);
  // Order-of-magnitude guard vs the 10-22ms manifest-hit baseline, with
  // generous headroom for shared CI machines.
  assert.ok(ms < 2200, `cold-open info() took ${ms.toFixed(1)}ms`);
});

/* ------------------------------------------------------------------ */
/* WS level                                                            */
/* ------------------------------------------------------------------ */

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
    persistTranscripts: true,
    flushIntervalMs: 10,
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
    try { msg = JSON.parse(data.toString("utf8")); } catch { msg = { __raw: data.toString("utf8") }; }
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
    opened: new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); }),
    send(obj) { ws.send(JSON.stringify(obj)); },
    wait(pred, ms = 5000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f));
      if (hit) { hit.__taken = true; return Promise.resolve(hit); }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`timeout waiting for ${what}; got: ${frames.map((f) => f.__raw || f.type).join(",")}`));
        }, ms) };
        w.timer.unref();
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) { return api.wait((f) => f.type === type && extra(f), ms, type); },
    close() { try { ws.terminate(); } catch {} },
  };
  return api;
}

async function tokenLocal(relay, caps) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps });
  const res = await c.type("auth_result");
  assert.equal(res.ok, true, JSON.stringify(res));
  return c;
}

async function tokenViewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4, caps });
  const res = await v.type("auth_result");
  assert.equal(res.ok, true, JSON.stringify(res));
  return v;
}

test("stage3-relay ws: plaintext writes into an enc room are rejected per write; plaintext rooms unaffected", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const capDev = await tokenLocal(relay, ["crypto.content"]);
  t.after(() => capDev.close());
  capDev.send({ type: "room_register", room: { id: "w-enc", deviceId: "d1", label: "enc", cwd: "/tmp", enc: 1, ackFp: ACK_FP, rckWrap: RCK_WRAP } });
  const reg = await capDev.type("room_registered", (f) => f.room === "w-enc");
  assert.equal(reg.enc, 1);

  // A crypto-capable connection writing a PLAINTEXT message_end is rejected.
  capDev.send({ type: "event", room: "w-enc", event: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "plain" }], timestamp: 1 } } });
  const e1 = await capDev.type("error", (f) => f.room === "w-enc");
  assert.equal(e1.code, "crypto_required");

  // A connection without the cap that takes over the enc room (reconnect with
  // an old build) is rejected per write as well.
  const plainDev = await tokenLocal(relay, []);
  t.after(() => plainDev.close());
  plainDev.send({ type: "room_register", room: { id: "w-enc", deviceId: "d1", label: "enc", cwd: "/tmp" } });
  await plainDev.type("room_registered", (f) => f.room === "w-enc");
  plainDev.send({ type: "event", room: "w-enc", event: { type: "message_end", message: envelope("user", "sneak") } });
  const e2 = await plainDev.type("error", (f) => f.room === "w-enc");
  assert.equal(e2.code, "crypto_required");

  // The room stayed empty; a cap viewer sees an empty enc snapshot.
  const viewer = await tokenViewer(relay, ["crypto.content"]);
  t.after(() => viewer.close());
  viewer.send({ type: "subscribe", room: "w-enc" });
  const snap = await viewer.type("snapshot", (f) => f.room === "w-enc");
  assert.equal(snap.enc, 1);
  assert.deepEqual(snap.messages, []);

  // The same non-cap connection writing to a plaintext room works fine.
  plainDev.send({ type: "room_register", room: { id: "w-plain", deviceId: "d1", label: "plain", cwd: "/tmp" } });
  await plainDev.type("room_registered", (f) => f.room === "w-plain");
  plainDev.send({ type: "event", room: "w-plain", event: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } } });
  await sleep(250);
  assert.equal(plainDev.frames.filter((f) => f.type === "error" && f.room === "w-plain").length, 0);
});

test("stage3-relay ws: viewer enc message forwards verbatim; enc into plaintext room is bad_args; search marker", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  // One local connection owns one room at a time, so each room gets its own
  // device connection (same pattern as the cross-end harness).
  const dev = await tokenLocal(relay, ["crypto.content", "msg.cid"]);
  t.after(() => dev.close());
  dev.send({ type: "room_register", room: { id: "w-enc2", deviceId: "d1", label: "enc", cwd: "/tmp", enc: 1, ackFp: ACK_FP, rckWrap: RCK_WRAP } });
  await dev.type("room_registered", (f) => f.room === "w-enc2");
  const dev2 = await tokenLocal(relay, ["crypto.content", "msg.cid"]);
  t.after(() => dev2.close());
  dev2.send({ type: "room_register", room: { id: "w-plain2", deviceId: "d2", label: "plain", cwd: "/tmp" } });
  await dev2.type("room_registered", (f) => f.room === "w-plain2");

  const viewer = await tokenViewer(relay, ["crypto.content", "msg.cid"]);
  t.after(() => viewer.close());

  // Enc message to the enc room: forwarded to the device in envelope form.
  const env = envelope("user", "viewer-msg");
  viewer.send({ type: "message", id: "m1", room: "w-enc2", enc: { ct: env.ct, h: env.h }, cid: "cid-1" });
  const fwd = await dev.type("message", (f) => f.room === "w-enc2");
  assert.equal(fwd.enc, 1);
  assert.equal(fwd.ct, env.ct);
  assert.equal(fwd.h, env.h);
  const ack1 = await viewer.type("ack", (f) => f.id === "m1");
  assert.equal(ack1.ok, true);

  // Enc envelope aimed at a plaintext room: bad_args.
  viewer.send({ type: "message", id: "m2", room: "w-plain2", enc: { ct: env.ct, h: env.h } });
  const ack2 = await viewer.type("ack", (f) => f.id === "m2");
  assert.equal(ack2.ok, false);
  assert.equal(ack2.code, "bad_args");

  // Body search over the enc room: explicit unsupported marker, never silent.
  viewer.send({ type: "command", id: "s1", room: "w-enc2", command: "search_session_bodies", args: { query: "x" } });
  const ack3 = await viewer.type("ack", (f) => f.id === "s1");
  assert.equal(ack3.ok, false);
  assert.equal(ack3.code, "unsupported");
  assert.equal(ack3.data && ack3.data.unsupported, true);
  assert.equal(ack3.data && ack3.data.reason, "room_encrypted");
  assert.equal(ack3.data && ack3.data.roomId, "w-enc2");
});

test("stage3-relay ws: cryptoPlaintextRooms readonly rejects writes but not reads; deny rejects reads", async (t) => {
  const ro = await boot({ cryptoPlaintextRooms: "readonly" });
  t.after(() => ro.close());
  const dev = await tokenLocal(ro, []);
  t.after(() => dev.close());
  dev.send({ type: "room_register", room: { id: "ro-plain", deviceId: "d1", label: "p", cwd: "/tmp" } });
  await dev.type("room_registered", (f) => f.room === "ro-plain");
  dev.send({ type: "event", room: "ro-plain", event: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "nope" }], timestamp: 1 } } });
  const err = await dev.type("error", (f) => f.room === "ro-plain");
  assert.equal(err.code, "unsupported");
  const viewer = await tokenViewer(ro, []);
  t.after(() => viewer.close());
  viewer.send({ type: "subscribe", room: "ro-plain" });
  const sub = await viewer.type("subscribed", (f) => f.room === "ro-plain");
  assert.equal(sub.room, "ro-plain", "readonly still allows reads");

  const deny = await boot({ cryptoPlaintextRooms: "deny" });
  t.after(() => deny.close());
  const dev2 = await tokenLocal(deny, []);
  t.after(() => dev2.close());
  dev2.send({ type: "room_register", room: { id: "dn-plain", deviceId: "d1", label: "p", cwd: "/tmp" } });
  await dev2.type("room_registered", (f) => f.room === "dn-plain");
  const viewer2 = await tokenViewer(deny, []);
  t.after(() => viewer2.close());
  viewer2.send({ type: "subscribe", room: "dn-plain" });
  const err2 = await viewer2.type("error", (f) => f.room === "dn-plain");
  assert.equal(err2.code, "unsupported", "deny refuses plaintext room reads");
});
