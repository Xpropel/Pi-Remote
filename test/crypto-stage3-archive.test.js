"use strict";
/**
 * Crypto Phase 3 follow-up -- sealed session archives and sealed manifest
 * previews crossing the relay (design 4.1: session firstMessage previews
 * and sessionArchive bodies are body content and travel ACK-sealed; the
 * relay only forwards/caches ciphertext):
 *   - sanitizeArchive passes a sealed archive through untouched (no
 *     String() coercion of the envelope firstMessage, no per-message
 *     filtering of the empty outside array), while plaintext archives keep
 *     the exact legacy sanitize shape;
 *   - the size cap applies to the sealed JSON as a whole: oversize is
 *     rejected (and evicts a stale cached copy), never truncated;
 *   - a sealed archive survives store + broadcast + replay byte-identical
 *     through a live relay, and a consumer-side decrypt (a faithful Node
 *     port of useRelay.decryptAndStoreArchive) recovers the body;
 *   - manifest rows carrying firstMessageEnc are stored by the account
 *     index as a plaintext/envelope pair (never both, never a stale
 *     plaintext next to a fresh envelope) and are served to viewers folded
 *     into firstMessage, the form the web session parser reads.
 * Sealed fixtures are built with the real attach producer
 * (deploy/attach.cjs archiveWireBody) and opened with raw node:crypto
 * only, so a shape or layout drift on either side fails here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { AccountIndex, safeKey } = require("../relay/index.js");
const { sanitizeArchive, storeSessionArchive, ARCHIVE_MAX_BYTES } = require("../relay/sessionArchive.js");
const attach = require("../deploy/attach.cjs");

const LOCAL_TOKEN = "lt-archive";
const VIEWER_TOKEN = "vt-archive";
const ADMIN_TOKEN = "at-archive";

const ACK = Buffer.from("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", "hex");
const FIRST = "FIRST-MARKER the sealed archive preview";
const BODY = "BODY-MARKER the sealed archive body text";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "pi-crypto3a-"));

/** Independent open of the pinned ACK envelope layout (nonce12 || ct || tag16). */
function openAckText(ack, ctB64) {
  const raw = Buffer.from(ctB64, "base64");
  const nonce = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", ack, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

function sampleArchive() {
  return {
    id: "sess-arch-1",
    path: "/sess/t_sess-arch-1.jsonl",
    cwd: "/work/app",
    name: "arch chat",
    firstMessage: FIRST,
    messageCount: 2,
    modified: "2024-01-01T00:00:00.000Z",
    sizeBytes: 1234,
    createdAt: 1700000000000,
    updatedAt: 1700000000001,
    parentSession: "p1",
    truncated: false,
    omitted: 0,
    messages: [
      { id: "m1", role: "user", text: FIRST, timestamp: 1700000000001 },
      { id: "m2", role: "assistant", text: BODY, timestamp: 1700000000002 },
    ],
  };
}

const sealedSample = () => attach.archiveWireBody(sampleArchive(), ACK);

/* ------------------------------------------------------------------ */
/* sanitizeArchive: sealed passthrough vs plaintext legacy shape       */
/* ------------------------------------------------------------------ */

test("stage3-archive sanitize: a sealed archive passes through untouched", () => {
  const sealed = sealedSample();
  const out = sanitizeArchive(sealed);
  assert.ok(out, "sealed archive is accepted");
  assert.equal(JSON.stringify(out), JSON.stringify(sealed), "byte-identical, key order included");
  assert.equal(out.enc, 1);
  assert.equal(typeof out.ct, "string");
  assert.deepEqual(out.messages, []);
  assert.equal(typeof out.firstMessage, "object", "the envelope is not String()-coerced");
  assert.equal(out.firstMessage.enc, 1);
  assert.equal(openAckText(ACK, out.firstMessage.ct), FIRST);
  // Idempotent: the broadcast path re-sanitizes the cached body.
  assert.equal(JSON.stringify(sanitizeArchive(out)), JSON.stringify(sealed));
});

test("stage3-archive sanitize: sealed validation -- bad id, missing messages, oversize", () => {
  const sealed = sealedSample();
  assert.equal(sanitizeArchive({ ...sealed, id: "" }), null);
  assert.equal(sanitizeArchive({ ...sealed, id: "x".repeat(201) }), null);
  assert.equal(sanitizeArchive({ ...sealed, messages: undefined }), null, "a sealed body without its messages array is rejected, not mangled");
  const big = { ...sealed, ct: Buffer.alloc(ARCHIVE_MAX_BYTES, 7).toString("base64") };
  assert.ok(Buffer.byteLength(JSON.stringify(big), "utf8") > ARCHIVE_MAX_BYTES);
  assert.equal(sanitizeArchive(big), null, "oversize sealed archive is rejected whole, never truncated");
});

test("stage3-archive store: oversize sealed re-push evicts the stale cached copy", () => {
  const dev = { id: "d1" };
  const sealed = sealedSample();
  assert.equal(storeSessionArchive(dev, sealed), sealed);
  assert.equal(dev.archives.get(sealed.id), sealed);
  const big = { ...sealed, ct: Buffer.alloc(ARCHIVE_MAX_BYTES, 3).toString("base64") };
  assert.equal(storeSessionArchive(dev, big), null);
  assert.equal(dev.archives.has(sealed.id), false, "the stale sealed copy is evicted, same as plaintext oversize");
});

test("stage3-archive sanitize: plaintext archives keep the legacy shape byte for byte", () => {
  const out = sanitizeArchive({
    id: "plain-1",
    cwd: "/w",
    name: "n",
    firstMessage: "hello",
    messageCount: 5,
    messages: [
      { id: "a", role: "user", text: "hi", timestamp: 1 },
      { id: "b", role: "assistant", text: "   " },
      { id: "c", role: "system", text: "drop me" },
      { id: "d", role: "assistant", text: "x".repeat(9000) },
    ],
  });
  assert.deepEqual(Object.keys(out), ["id", "cwd", "name", "firstMessage", "messageCount", "truncated", "omitted", "messages"]);
  assert.equal(out.firstMessage, "hello");
  assert.equal(out.messageCount, 5);
  assert.equal(out.messages.length, 2, "blank and non-chat messages are dropped");
  assert.equal(out.messages[1].text.length, 8000, "long texts are still sliced");
  assert.equal(out.enc, undefined);
});

/* ------------------------------------------------------------------ */
/* AccountIndex: firstMessageEnc passthrough and pair semantics        */
/* ------------------------------------------------------------------ */

function manifestWith(idx, sessions, nowAt = 5000) {
  return idx.applyManifest("admin", "dev-1", { full: false, updatedAt: nowAt, sessions }, nowAt);
}

test("stage3-archive index: a sealed manifest row is stored as an envelope-only pair and persists", () => {
  const dir = tmpDir();
  const idx = new AccountIndex(dir);
  const env = { enc: 1, ct: "RU5W" };
  const res = manifestWith(idx, [{
    id: "s1", path: "/s/s1.jsonl", cwd: "/w", name: "S", firstMessage: null, firstMessageEnc: env,
    messageCount: 3, sizeBytes: 10, createdAt: 1, updatedAt: 1000,
  }], 2000);
  assert.equal(res.ok, true);
  const row = idx.getSession("admin", "dev-1", "s1");
  assert.equal(row.firstMessage, "", "no plaintext preview is stored next to the envelope");
  assert.deepEqual(row.firstMessageEnc, env);
  const file = path.join(dir, safeKey("admin"), "sessions", safeKey("dev-1") + ".jsonl");
  assert.ok(fs.readFileSync(file, "utf8").includes('"firstMessageEnc"'), "the envelope persists in the sessions file");
});

test("stage3-archive index: plaintext and sealed previews replace each other, never coexist", () => {
  const idx = new AccountIndex(tmpDir());
  const base = { id: "s2", path: "/s/s2.jsonl", cwd: "/w", name: "", messageCount: 1, sizeBytes: 1, createdAt: 1 };
  manifestWith(idx, [{ ...base, firstMessage: "plain preview", updatedAt: 1000 }], 2000);
  let row = idx.getSession("admin", "dev-1", "s2");
  assert.equal(row.firstMessage, "plain preview");
  assert.equal(row.firstMessageEnc, undefined, "plaintext rows keep the legacy shape (no envelope field)");

  manifestWith(idx, [{ ...base, firstMessage: null, firstMessageEnc: { enc: 1, ct: "RU5W" }, updatedAt: 2000 }], 3000);
  row = idx.getSession("admin", "dev-1", "s2");
  assert.equal(row.firstMessage, "", "sealing clears the stored plaintext preview");
  assert.deepEqual(row.firstMessageEnc, { enc: 1, ct: "RU5W" });

  // An incremental frame carrying neither preview field keeps the pair.
  manifestWith(idx, [{ id: "s2", messageCount: 9, updatedAt: 3000 }], 4000);
  row = idx.getSession("admin", "dev-1", "s2");
  assert.equal(row.messageCount, 9);
  assert.deepEqual(row.firstMessageEnc, { enc: 1, ct: "RU5W" });
  assert.equal(row.firstMessage, "");

  manifestWith(idx, [{ ...base, firstMessage: "back to plain", updatedAt: 4000 }], 5000);
  row = idx.getSession("admin", "dev-1", "s2");
  assert.equal(row.firstMessage, "back to plain");
  assert.equal(row.firstMessageEnc, undefined, "a fresh plaintext preview clears the stale envelope");
});

test("stage3-archive index: malformed envelopes are dropped; the envelope-in-firstMessage dialect is accepted", () => {
  const idx = new AccountIndex(tmpDir());
  const base = { id: "s3", path: "/s/s3.jsonl", cwd: "/w", name: "", messageCount: 1, sizeBytes: 1, createdAt: 1 };
  for (const bad of [{ enc: 2, ct: "RU5W" }, { enc: 1, ct: 42 }, { enc: 1, ct: "" }, { enc: 1, ct: "x".repeat(9000) }, "sealed?", [1, 2]]) {
    manifestWith(idx, [{ ...base, firstMessage: "keep me", firstMessageEnc: bad, updatedAt: 1000 }], 2000);
    const row = idx.getSession("admin", "dev-1", "s3");
    assert.equal(row.firstMessage, "keep me", `malformed envelope ${JSON.stringify(bad)} does not disturb the plaintext preview`);
    assert.equal(row.firstMessageEnc, undefined);
  }
  manifestWith(idx, [{ ...base, firstMessage: { enc: 1, ct: "RElBTEVDVA==" }, updatedAt: 2000 }], 3000);
  const row = idx.getSession("admin", "dev-1", "s3");
  assert.equal(row.firstMessage, "");
  assert.deepEqual(row.firstMessageEnc, { enc: 1, ct: "RElBTEVDVA==" });
});

/* ------------------------------------------------------------------ */
/* Live relay: store + broadcast + replay, consumer decrypt            */
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

async function attachWindow(relay, device) {
  const w = client(relay.localPort);
  await w.opened;
  w.send({
    type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps: [],
    client: { kind: "attach", version: "4.0.0", platform: device.platform || "linux" },
  });
  await w.type("auth_result");
  w.send({ type: "device_register", device });
  await w.wait((f) => f.type === "room_list", 3000, "device window room_list");
  return w;
}

async function tokenViewer(relay) {
  const v = client(relay.viewerPort);
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4, caps: [] });
  const res = await v.type("auth_result");
  assert.equal(res.ok, true, JSON.stringify(res));
  return v;
}

/**
 * A faithful Node port of the web consumer's whole-blob branch
 * (useRelay.decryptAndStoreArchive): open session.ct for { messages },
 * open the firstMessage envelope, and return the decrypted session.
 */
function consumerDecrypt(session, ack) {
  assert.equal(session.enc, 1);
  const parsed = JSON.parse(openAckText(ack, session.ct));
  const list = Array.isArray(parsed) ? parsed : parsed.messages;
  const messages = list.filter((m) => m && typeof m === "object" && typeof m.text === "string");
  let firstMessage = session.firstMessage ?? null;
  if (firstMessage && typeof firstMessage === "object" && firstMessage.enc === 1) {
    firstMessage = openAckText(ack, firstMessage.ct);
  }
  return { messages, firstMessage };
}

test("stage3-archive ws: a sealed archive survives store + broadcast + replay byte-identical and decrypts", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-arch-ws";
  const win = await attachWindow(relay, { id: DEV, name: "Linux", platform: "linux", projects: [] });
  t.after(() => win.close());
  const v1 = await tokenViewer(relay);
  t.after(() => v1.close());

  const sealed = sealedSample();
  const sentJson = JSON.stringify(sealed);
  win.send({ type: "session_archive", deviceId: DEV, session: sealed });

  const live = await v1.type("session_archive", (f) => f.session && f.session.id === sealed.id);
  assert.equal(JSON.stringify(live.session), sentJson, "the broadcast body is byte-identical to what the device sent");
  assert.ok(!JSON.stringify(live).includes("MARKER"), "no corpus plaintext crosses the relay");

  const cached = relay.devices.get(DEV).archives.get(sealed.id);
  assert.ok(cached, "the sealed archive is cached");
  assert.equal(JSON.stringify(cached), sentJson, "the cached body is byte-identical");

  const opened = consumerDecrypt(live.session, ACK);
  assert.deepEqual(opened.messages.map((m) => m.text), [FIRST, BODY]);
  assert.equal(opened.firstMessage, FIRST);

  // A viewer that arrives later is served the same sealed body by replay.
  const v2 = await tokenViewer(relay);
  t.after(() => v2.close());
  const replayed = await v2.type("session_archive", (f) => f.session && f.session.id === sealed.id);
  assert.equal(JSON.stringify(replayed.session), sentJson, "the replayed body is byte-identical");
});

test("stage3-archive ws: a plaintext archive still arrives in the legacy sanitized shape", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-arch-plain";
  const win = await attachWindow(relay, { id: DEV, name: "Linux", platform: "linux", projects: [] });
  t.after(() => win.close());
  const v1 = await tokenViewer(relay);
  t.after(() => v1.close());
  win.send({
    type: "session_archive", deviceId: DEV,
    session: {
      id: "plain-ws", cwd: "/w", name: "P", firstMessage: "hi", messageCount: 2, path: "/secret/local.jsonl",
      messages: [
        { id: "a", role: "user", text: "hi", timestamp: 1 },
        { id: "b", role: "assistant", text: "there", timestamp: 2 },
      ],
    },
  });
  const live = await v1.type("session_archive", (f) => f.session && f.session.id === "plain-ws");
  assert.equal(live.session.firstMessage, "hi");
  assert.equal(live.session.messages.length, 2);
  assert.equal(live.session.path, undefined, "local-only fields are still stripped");
  assert.equal(live.session.enc, undefined);
});

test("stage3-archive ws: a sealed manifest row reaches get_sessions folded as an envelope firstMessage", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-arch-manifest";
  const win = await attachWindow(relay, { id: DEV, name: "Linux", platform: "linux", projects: [] });
  t.after(() => win.close());
  const row = attach.manifestWireRow(sampleArchive(), ACK);
  assert.equal(row.firstMessage, null);
  win.send({
    type: "session_manifest", deviceId: DEV, full: true, scope: "device", root: "/sess",
    updatedAt: Date.now(), sessions: [row],
  });
  await win.wait((f) => f.type === "room_list", 3000, "room_list after manifest");

  const stored = relay.index.getSession("admin", DEV, row.id);
  assert.equal(stored.firstMessage, "");
  assert.deepEqual(stored.firstMessageEnc, row.firstMessageEnc);
  assert.equal(openAckText(ACK, stored.firstMessageEnc.ct), FIRST);

  const v = await tokenViewer(relay);
  t.after(() => v.close());
  v.send({ type: "get_sessions", id: "g1", deviceId: DEV });
  const list = await v.type("session_list", (f) => f.id === "g1");
  assert.equal(list.sessions.length, 1);
  assert.deepEqual(list.sessions[0].firstMessage, row.firstMessageEnc, "the envelope is served inside firstMessage, the form the web parser reads");
  assert.equal(openAckText(ACK, list.sessions[0].firstMessage.ct), FIRST);
});
