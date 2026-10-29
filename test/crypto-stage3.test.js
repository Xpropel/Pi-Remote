"use strict";
/**
 * Crypto Phase 3 - body encryption, tier (b) (design A sections 4.1 / 5 / 7 / 8
 * phase 3 / 10), cross-end acceptance harness.
 *
 * What this file proves, end to end against a REAL relay server in-process:
 *   1. Same-corpus parity: a plaintext room and an enc room fed the same corpus
 *      produce snapshots whose bodies are deep-equal once the enc snapshot is
 *      decrypted through the ACK -> RCK path.
 *   2. Three delivery paths agree: live room_event stream, snapshot, and the
 *      seed/resync path all decrypt to the identical message sequence.
 *   3. h anchoring: seeded / appended / checkpoint-restored records keep stable
 *      h values and the stored envelopes are byte-identical across a relay
 *      restart (checkpoint cold-open performs no re-encryption).
 *   4. Version gate: a viewer that does not declare the crypto.content cap gets
 *      crypto_required for an enc room and zero message bodies; a cap viewer
 *      gets keyInfo and decrypts.
 *   5. Relay blindness: after an enc room is fully written, no body marker, no
 *      ACK and no RCK appears anywhere in the relay data directory, while
 *      role/seq metadata and the room meta (enc/ackFp/rckWrap) stay readable.
 *   6. Migration mini-flow (only when the extension surface that triggers it
 *      has landed; see the adapter probes below).
 *
 * Adapter design: the three Phase 3 implementations (extension sealing, relay
 * envelope adaptation, web decryption) land independently, so every producer /
 * consumer surface is probed at runtime:
 *   - relay:    RELAY_CAPS must contain "crypto.content"; tests that need relay
 *               envelope semantics skip with an explicit reason until it lands.
 *   - producer: if the real extension exports an envelope sealer (and declares
 *               the crypto.content client cap), envelopes are produced by the
 *               real bridge code; otherwise by the reference implementation in
 *               this file, built strictly on the pinned contract.
 *   - viewer:   if the web side exports a decryption entry point, it is used;
 *               otherwise decryption runs through WebCrypto (globalThis.crypto
 *               .subtle) - the same API the browser uses - so the stand-in is
 *               faithful to the real consumer environment.
 * The pinned contract (design A section 4.1 / task contract):
 *   envelope  = { enc:1, role, h, ct }
 *   ct        = base64( nonce12 || AES-256-GCM(RCK, utf8(normalizedJson(body))) || tag16 )
 *   h         = HMAC-SHA256(RCK, normalized form) hex
 *   rckWrap   = base64( nonce12 || AES-256-GCM(ACK, RCK) || tag16 )
 *   room meta = + enc / ackFp / rckWrap; snapshot for cap viewers carries
 *               enc:1 + keyInfo { ackFp, rckWrap }; non-cap viewers get
 *               crypto_required. Normalization is the canonical JSON form whose
 *               anchor semantics match the relay's existing hashOf (the loose
 *               role|timestamp|text anchor both ends already share verbatim).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { normalizePairCode } = require("../relay/pairing.js");
const { keyFingerprint } = require("../relay/util.js");
const { RELAY_CAPS } = require("../relay/wire.js");
const { hashOf: relayHashOf } = require("../relay/store.js");

// Test-only relay credentials, assembled from fragments.
const LOCAL_TOKEN = ["s3", "local"].join("-");
const VIEWER_TOKEN = ["s3", "viewer"].join("-");
const ADMIN_TOKEN = ["s3", "admin"].join("-");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crypto3-"));
}

/** Boot a relay with transcript persistence on (the deployment mode the user's
 *  own test box runs): store-backed snapshots and on-disk artifacts are the
 *  surfaces under test, so the in-memory-only mode would hide them. */
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

/** Reboot a second relay on an existing data dir (checkpoint cold-open). */
async function reboot(dir, overrides = {}) {
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

/** Minimal WS client with frame capture + predicate waits (stage1/2 pattern). */
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

/* ------------------------------------------------------------------ */
/* Surface probes (which implementation is bound, per adapter)         */
/* ------------------------------------------------------------------ */

const RELAY_CONTENT = RELAY_CAPS.includes("crypto.content");

let extPromise = null;
function loadExt() {
  if (!extPromise) {
    extPromise = (async () => {
      try {
        const { createJiti } = require("jiti");
        const jiti = createJiti(__filename, { interopDefault: false });
        return await jiti.import(path.join(__dirname, "..", "extension", "pi-remote-sync.ts"));
      } catch {
        return null;
      }
    })();
  }
  return extPromise;
}

const SEAL_EXPORT_CANDIDATES = [
  "sealEnvelope", "encryptEnvelope", "encryptBody", "sealBody",
  "makeEnvelope", "envelopeForMessage", "encryptMessage",
];
const UI_DECRYPT_CANDIDATES = [
  "decryptEnvelopeJson", "decryptEnvelope", "openEnvelope", "decryptBody",
  "decryptRecord", "decryptMessage", "decryptSnapshotMessage",
];
const UI_UNWRAP_CANDIDATES = ["unwrapRoomKey", "roomKeyFromWrap", "unwrapRck", "openRoomKey"];
const UI_MODULE_CANDIDATES = [
  "viewerIdentity.ts", "contentCrypto.ts", "roomCrypto.ts", "envelope.ts", "contentDecrypt.ts",
];

let uiPromise = null;
function loadUiCrypto() {
  if (!uiPromise) {
    uiPromise = (async () => {
      try {
        const { createJiti } = require("jiti");
        const jiti = createJiti(__filename, { interopDefault: false });
        const found = {};
        for (const name of UI_MODULE_CANDIDATES) {
          const file = path.join(__dirname, "..", "ui", "src", "relay", name);
          if (!fs.existsSync(file)) continue;
          const mod = await jiti.import(file).catch(() => null);
          if (!mod) continue;
          for (const fn of [...UI_DECRYPT_CANDIDATES, ...UI_UNWRAP_CANDIDATES]) {
            if (typeof mod[fn] === "function" && !found[fn]) found[fn] = mod[fn];
          }
          if (mod.default && typeof mod.default === "object") {
            for (const fn of [...UI_DECRYPT_CANDIDATES, ...UI_UNWRAP_CANDIDATES]) {
              if (typeof mod.default[fn] === "function" && !found[fn]) found[fn] = mod.default[fn];
            }
          }
        }
        return found;
      } catch {
        return {};
      }
    })();
  }
  return uiPromise;
}

/** Skip helper: returns false (after marking the test skipped) when a surface
 *  the test depends on has not landed yet. The reason strings name the exact
 *  missing surface so a skipped run still reports precisely what is missing. */
function need(t, ok, reason) {
  if (!ok) {
    t.skip(reason);
    return false;
  }
  return true;
}

const needRelay = (t) =>
  need(t, RELAY_CONTENT, "relay crypto.content not landed: RELAY_CAPS lacks crypto.content (relay envelope adaptation pending)");

/* ------------------------------------------------------------------ */
/* Reference implementation of the pinned contract                     */
/* ------------------------------------------------------------------ */

/** Canonical JSON: object keys sorted recursively, arrays in order, no
 *  whitespace - the same serialization the codebase already uses for signed
 *  canonical payloads (relay/pairing.js canonicalJson semantics). */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const parts = [];
  for (const k of Object.keys(value).sort()) {
    if (value[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalJson(value[k]));
  }
  return "{" + parts.join(",") + "}";
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function sealBytes(key, plainBuf) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  return Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64");
}

function openBytes(key, b64) {
  const raw = Buffer.from(String(b64), "base64");
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function hmacHex(key, buf) {
  return crypto.createHmac("sha256", key).update(buf).digest("hex");
}

function ackFpOf(ack) {
  return crypto.createHash("sha256").update(ack).digest("hex").slice(0, 16);
}

/** Reference envelope sealer (contract-pinned). role is lifted out of the body;
 *  h is the HMAC over the same normalized bytes that ct encrypts. */
function refSealBody(rck, body) {
  const norm = Buffer.from(canonicalJson(body), "utf8");
  return { enc: 1, role: body && body.role, h: hmacHex(rck, norm), ct: sealBytes(rck, norm) };
}

function refOpenBody(rck, env) {
  const plain = openBytes(rck, env.ct);
  const body = JSON.parse(plain.toString("utf8"));
  assert.equal(hmacHex(rck, Buffer.from(canonicalJson(body), "utf8")), env.h, "envelope h does not match decrypted body");
  return body;
}

function refWrapRck(ack, rck) {
  return sealBytes(ack, rck);
}

function refUnwrapRck(ack, blob) {
  return openBytes(ack, blob);
}

/** WebCrypto (browser-faithful) unwrap + decrypt: this is the code path shape
 *  the real web consumer runs - subtle.importKey with the ACK, AES-GCM decrypt
 *  of the rckWrap blob, then per-record decrypt under the RCK. */
async function webUnwrapRck(ack, blobB64) {
  const subtle = globalThis.crypto.subtle;
  const raw = Buffer.from(String(blobB64), "base64");
  const ackKey = await subtle.importKey("raw", ack, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: raw.subarray(0, NONCE_BYTES) },
    ackKey,
    raw.subarray(NONCE_BYTES),
  );
  return Buffer.from(plain);
}

async function webOpenBody(rck, env) {
  const subtle = globalThis.crypto.subtle;
  const raw = Buffer.from(String(env.ct), "base64");
  const key = await subtle.importKey("raw", rck, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await subtle.decrypt(
    { name: "AES-GCM", iv: raw.subarray(0, NONCE_BYTES) },
    key,
    raw.subarray(NONCE_BYTES),
  );
  const body = JSON.parse(Buffer.from(plain).toString("utf8"));
  assert.equal(hmacHex(rck, Buffer.from(canonicalJson(body), "utf8")), env.h, "envelope h does not match decrypted body");
  return body;
}

/* ------------------------------------------------------------------ */
/* Producer / consumer adapters                                        */
/* ------------------------------------------------------------------ */

let producerBinding = "reference";
let consumerBinding = "webcrypto-reference";

/** Seal one message body into an envelope. Uses the real extension sealer when
 *  the bridge has landed its Phase 3 surface (cap declared + export present);
 *  otherwise the reference implementation above. */
async function sealBody(rck, body) {
  const ext = await loadExt();
  if (ext && Array.isArray(ext.CLIENT_CAPS) && ext.CLIENT_CAPS.includes("crypto.content")) {
    for (const name of SEAL_EXPORT_CANDIDATES) {
      if (typeof ext[name] === "function") {
        try {
          const env = await ext[name](rck, body);
          if (env && env.enc === 1 && typeof env.ct === "string" && typeof env.h === "string") {
            producerBinding = `bridge:${name}`;
            return env;
          }
        } catch {
          /* signature mismatch on a candidate export: fall through to reference */
        }
      }
    }
  }
  producerBinding = "reference";
  return refSealBody(rck, body);
}

/** Decrypt one envelope through the ACK -> RCK path. When the web side's real
 *  decryption module has landed (contentDecrypt.ts: unwrapRoomKey +
 *  decryptEnvelopeJson, both CryptoKey-based), it is driven strictly - a null
 *  or a mismatch there is a product failure, not a reason to fall back.
 *  Otherwise the WebCrypto reference path stands in. keyInfo is the
 *  snapshot-carried { ackFp, rckWrap }. */
async function openBody(ack, keyInfo, env) {
  assert.equal(keyInfo.ackFp, ackFpOf(ack), "snapshot keyInfo ackFp does not match the held ACK");
  const ui = await loadUiCrypto();
  if (typeof ui.unwrapRoomKey === "function" && typeof ui.decryptEnvelopeJson === "function") {
    const subtle = globalThis.crypto.subtle;
    const ackKey = await subtle.importKey("raw", ack, { name: "AES-GCM" }, false, ["decrypt"]);
    const rckKey = await ui.unwrapRoomKey(ackKey, keyInfo.rckWrap);
    assert.ok(rckKey, "web unwrapRoomKey failed on the room's rckWrap");
    const body = await ui.decryptEnvelopeJson(rckKey, env.ct);
    assert.ok(body, "web decryptEnvelopeJson failed on a stored envelope");
    assert.equal(
      hmacHex(rckKeyMaterial(ack, keyInfo), Buffer.from(canonicalJson(body), "utf8")),
      env.h,
      "envelope h does not match the web-decrypted body",
    );
    consumerBinding = "ui:contentDecrypt";
    return body;
  }
  consumerBinding = "webcrypto-reference";
  const rck = await webUnwrapRck(ack, keyInfo.rckWrap);
  assert.equal(rck.length, 32, "unwrapped RCK must be 32 bytes");
  return webOpenBody(rck, env);
}

/** Raw RCK bytes for h verification when the consumer path holds the key as a
 *  non-extractable CryptoKey: the harness owns the ACK, so it can unwrap the
 *  raw RCK itself (test-side only; product code never does this). */
function rckKeyMaterial(ack, keyInfo) {
  return refUnwrapRck(ack, keyInfo.rckWrap);
}

/* ------------------------------------------------------------------ */
/* Corpus: one representative session, with distinctive body markers   */
/* ------------------------------------------------------------------ */

const MARK = "ZXQ3";
const IMAGE_B64 = Buffer.from(`fake-png-bytes-${MARK}-IMAGE-CONTENT`, "utf8").toString("base64");
const LONG_TEXT = `${MARK}-LONG-` + "长".repeat(2100) + `-${MARK}-TAIL-AFTER-2048`;

const CORPUS = [
  {
    role: "user",
    content: [{ type: "text", text: `${MARK}-USER 第一条提问：帮我分析这段日志 🚀` }],
    timestamp: 1730000001000,
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: `${MARK}-THINK 内部推理：先看文件再下结论` },
      { type: "text", text: `${MARK}-ASSIST 好的，我先读取相关文件。` },
      { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: `cat /tmp/${MARK}-TOOLARG.txt` } },
    ],
    timestamp: 1730000002000,
  },
  {
    role: "toolResult",
    toolCallId: "tc-1",
    content: [{ type: "text", text: `${MARK}-TOOLRES 文件内容：一切正常 ✅` }],
    isError: false,
    timestamp: 1730000003000,
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: `${MARK}-IMG 这是截图里显示的内容：` },
      { type: "image", data: IMAGE_B64, mimeType: "image/png" },
    ],
    timestamp: 1730000004000,
  },
  {
    role: "bashExecution",
    command: `echo ${MARK}-BASHCMD`,
    output: `${MARK}-BASHOUT 命令输出`,
    exitCode: 0,
    timestamp: 1730000005000,
  },
  {
    role: "user",
    content: [{ type: "text", text: LONG_TEXT }],
    timestamp: 1730000006000,
  },
  {
    role: "assistant",
    content: [{ type: "text", text: `${MARK}-UNICODE 组合字符 é + 中文 + 😀 + 日本語テスト` }],
    timestamp: 1730000007000,
  },
];

/** Plaintext body markers that must never appear in an enc room's stored bytes. */
const BODY_MARKERS = [
  `${MARK}-USER`, `${MARK}-THINK`, `${MARK}-ASSIST`, `${MARK}-TOOLARG`,
  `${MARK}-TOOLRES`, `${MARK}-IMG`, IMAGE_B64, `${MARK}-BASHCMD`,
  `${MARK}-BASHOUT`, `${MARK}-LONG`, `${MARK}-TAIL-AFTER-2048`, `${MARK}-UNICODE`,
];

/* ------------------------------------------------------------------ */
/* Wire flow helpers (stage1/2 patterns)                               */
/* ------------------------------------------------------------------ */

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

/** Token viewer auth with an explicit caps list (the caps are the version gate). */
async function authedViewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  const frame = { type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4 };
  if (caps) frame.caps = caps;
  v.send(frame);
  const res = await v.type("auth_result");
  assert.equal(res.ok, true, JSON.stringify(res));
  return { conn: v, authResult: res };
}

async function adminPairCode(v, id) {
  v.send({ type: "pair_create", id, adminToken: ADMIN_TOKEN });
  const ack = await v.type("ack", (f) => f.id === id);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  return ack.data.code;
}

/** Pair a keyed device (Phase 1 flow) so it exists in the roster as a key
 *  holder; returns its key material. */
async function pairKeyDevice(relay, adminViewer, deviceId) {
  const code = await adminPairCode(adminViewer, `pc3-${deviceId}`);
  const keys = genDeviceKeys();
  const c = client(relay.localPort);
  await c.opened;
  c.send({
    type: "pair",
    code,
    device: { id: deviceId, name: "stage3 device", platform: "linux" },
    keys: { signPub: keys.signPub, boxPub: keys.boxPub, pop: popFor(keys, code) },
  });
  const res = await c.type("pair_result");
  c.close();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.keyRegistered, true);
  return keys;
}

/** Challenge-response device login (Phase 1 contract), parameterized caps. */
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
  if (first.type === "auth_result") return { conn: c, result: first };
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
  assert.equal(result.auth, "key");
  return { conn: c, result };
}

/** Register a room on an authed device connection. encDecl (when given) is
 *  the design section 5 declaration object { ackFp, rckWrap }: it rides as
 *  room.enc on the register frame and as frame.enc on the first seed frame -
 *  the two intake points the relay validates via cleanEncMeta. The declaring
 *  connection must carry the crypto.content cap. */
async function registerRoom(conn, roomId, deviceId, encDecl) {
  const room = { id: roomId, deviceId, label: `stage3 ${roomId}`, cwd: "/tmp/stage3" };
  if (encDecl) room.enc = encDecl;
  conn.send({ type: "room_register", room });
  const ack = await conn.type("room_registered", (f) => f.room === roomId);
  return ack;
}

/** Seed a room through the existing snapshot channel (seed/merge path). */
function seedRoom(conn, roomId, messages, encDecl) {
  const frame = { type: "snapshot", room: roomId, messages };
  if (encDecl) frame.enc = encDecl;
  conn.send(frame);
}

/** Append one message through the live event channel (message_end). */
function appendMessage(conn, roomId, message) {
  conn.send({ type: "event", room: roomId, event: { type: "message_end", message } });
}

/** Subscribe a viewer and capture the snapshot frame for a room. */
async function subscribeSnapshot(viewerConn, roomId, extra = {}) {
  viewerConn.send({ type: "subscribe", room: roomId, ...extra });
  const snap = await viewerConn.type("snapshot", (f) => f.room === roomId, 8000);
  return snap;
}

/** Bodies of a plaintext snapshot: the snapshot items ARE the message bodies
 *  (the store unwraps the record's m field when building snapshot items). */
function plainBodies(snap) {
  return [...(snap.messages || [])];
}

/** Envelopes of an enc snapshot: items are envelope objects (or full stored
 *  records carrying the same fields); either way the envelope is the
 *  { enc, role, h, ct } projection. */
function encEnvelopes(snap) {
  return (snap.messages || []).map((rec) => {
    assert.equal(rec.enc, 1, "enc snapshot item must be an envelope");
    return { enc: 1, role: rec.role, h: rec.h, ct: rec.ct };
  });
}

/** Read every file under a directory as utf8 text (relay artifacts are JSON /
 *  JSONL / small text; anything unreadable is reported as an empty string). */
function walkFiles(dir) {
  const out = [];
  const step = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) step(p);
      else if (entry.isFile()) out.push(p);
    }
  };
  step(dir);
  return out;
}

function readAllFiles(dir) {
  return walkFiles(dir).map((p) => {
    let text = "";
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      text = "";
    }
    return { path: p, text };
  });
}

/* ------------------------------------------------------------------ */
/* T0: contract checks that bind real code from both ends, today       */
/* ------------------------------------------------------------------ */

test("stage3 T0a: anchor agreement - relay hashOf and extension hashOf agree on the corpus", async () => {
  const ext = await loadExt();
  assert.ok(ext, "extension module must load");
  assert.equal(typeof ext.hashOf, "function", "extension must export hashOf");
  for (const m of CORPUS) {
    assert.equal(ext.hashOf(m), relayHashOf(m), `hashOf drift for role ${m.role}`);
    assert.match(relayHashOf(m), /^[0-9a-f]{12}$/, "anchor shape is sha1[:12] hex on both ends");
  }
  // The long-body edge: hashOf truncates content text at 2048 chars by design,
  // so a tail-only change must NOT move the anchor (both ends, same behavior).
  const tailChanged = { ...CORPUS[5], content: [{ type: "text", text: LONG_TEXT.replace("TAIL-AFTER-2048", "TAIL-CHANGED-XXXX") }] };
  assert.equal(ext.hashOf(tailChanged), relayHashOf(tailChanged));
  assert.equal(relayHashOf(tailChanged), relayHashOf(CORPUS[5]), "anchor must ignore text past 2048 chars");
});

test("stage3 T0b: pinned envelope contract - roundtrip, WebCrypto cross-decrypt, wrap, h properties", async () => {
  const ack = crypto.randomBytes(32);
  const rck = crypto.randomBytes(32);

  for (const body of CORPUS) {
    const env = refSealBody(rck, body);
    assert.equal(env.enc, 1);
    assert.equal(env.role, body.role);
    assert.match(env.h, /^[0-9a-f]{64}$/, "h is HMAC-SHA256 hex");
    // node:crypto open
    assert.deepEqual(refOpenBody(rck, env), body);
    // WebCrypto open (the browser consumer's exact API): proves the ct layout
    // nonce || ct || tag is WebCrypto-compatible, not just Node-compatible.
    assert.deepEqual(await webOpenBody(rck, env), body);
    // Determinism of h (content-addressed), independence of ct (random nonce).
    const env2 = refSealBody(rck, body);
    assert.equal(env2.h, env.h, "h must be deterministic for the same body + room key");
    assert.notEqual(env2.ct, env.ct, "ct must differ per seal (fresh nonce)");
    // A different room key produces a different h for the same body.
    assert.notEqual(refSealBody(crypto.randomBytes(32), body).h, env.h);
  }

  // rckWrap: ACK wraps the RCK; the WebCrypto path unwraps it byte-identically.
  const blob = refWrapRck(ack, rck);
  assert.deepEqual(refUnwrapRck(ack, blob), rck);
  assert.deepEqual(await webUnwrapRck(ack, blob), rck);
  assert.equal(ackFpOf(ack).length, 16);

  // Tamper evidence: flipping one ct byte must fail GCM authentication on
  // both stacks instead of yielding garbled plaintext.
  const env = refSealBody(rck, CORPUS[0]);
  const raw = Buffer.from(env.ct, "base64");
  raw[20] ^= 0xff;
  const tampered = { ...env, ct: raw.toString("base64") };
  assert.throws(() => refOpenBody(rck, tampered));
  await assert.rejects(() => webOpenBody(rck, tampered));

  console.log(`[stage3 probes] relayContent=${RELAY_CONTENT} producer=${producerBinding} consumer=${consumerBinding}`);
});

test("stage3 T0c: producer cross-check - real bridge sealBody vs reference vs real web decrypt", async (t) => {
  const ext = await loadExt();
  assert.ok(ext, "extension module must load");
  const landed =
    Array.isArray(ext.CLIENT_CAPS) &&
    ext.CLIENT_CAPS.includes("crypto.content") &&
    typeof ext.sealBody === "function" &&
    typeof ext.openBody === "function" &&
    typeof ext.wrapRoomKey === "function";
  if (!need(t, landed, "extension crypto.content surface not landed (CLIENT_CAPS / sealBody / openBody / wrapRoomKey exports)")) return;

  const ack = crypto.randomBytes(32);
  const rck = crypto.randomBytes(32);
  // The bridge's rckWrap must unwrap under the harness ACK path and vice versa.
  const keyInfo = { ackFp: ackFpOf(ack), rckWrap: ext.wrapRoomKey(ack, rck) };
  assert.deepEqual(refUnwrapRck(ack, keyInfo.rckWrap), rck, "bridge wrapRoomKey must match the pinned rckWrap construction");
  assert.deepEqual(ext.unwrapRoomKey(ack, refWrapRck(ack, rck)), rck);

  for (const body of CORPUS) {
    // The adapter must bind the real bridge producer now that the cap exists.
    const viaAdapter = await sealBody(rck, body);
    assert.equal(producerBinding, "bridge:sealBody", "producer adapter must bind the real bridge sealBody");
    // Same canonical form: identical h across bridge and reference.
    assert.equal(viaAdapter.h, refSealBody(rck, body).h, "bridge h must equal reference h for the same body");
    assert.equal(ext.contentHashOf(rck, body), viaAdapter.h, "bridge contentHashOf must be the envelope h");
    // Bridge-sealed -> web-decrypted (real contentDecrypt, strict path).
    assert.deepEqual(await openBody(ack, keyInfo, viaAdapter), body);
    assert.equal(consumerBinding, "ui:contentDecrypt", "consumer adapter must bind the real web module");
    // Reference-sealed -> bridge-opened.
    assert.deepEqual(ext.openBody(rck, refSealBody(rck, body)), body);
  }
  console.log(`[stage3 T0c] producer=${producerBinding} consumer=${consumerBinding}`);
});

/* ------------------------------------------------------------------ */
/* Shared enc-room setup                                               */
/* ------------------------------------------------------------------ */

const ENC_CAPS = ["crypto.auth", "crypto.content"];

/** Boot a relay, pair one keyed device, and return everything an enc-room
 *  test needs: the device connection (key-authed, content cap declared), a
 *  fresh ACK/RCK pair, and the design section 5 enc declaration fields. */
async function setupDevice(t, deviceId = "dev-s3") {
  const relay = await boot();
  let closed = false;
  const closeRelay = async () => {
    if (!closed) {
      closed = true;
      await relay.close();
    }
  };
  t.after(closeRelay);
  const { conn: admin } = await authedViewer(relay, null);
  t.after(() => admin.close());
  const keys = await pairKeyDevice(relay, admin, deviceId);
  const { conn: dev } = await keyAuthDevice(relay, deviceId, keys, ENC_CAPS);
  t.after(() => dev.close());
  const ack = crypto.randomBytes(32);
  const rck = crypto.randomBytes(32);
  const keyInfo = { ackFp: ackFpOf(ack), rckWrap: refWrapRck(ack, rck) };
  const encFields = { ackFp: keyInfo.ackFp, rckWrap: keyInfo.rckWrap };
  return { relay, admin, dev, deviceId, keys, ack, rck, keyInfo, encFields, closeRelay };
}

async function sealCorpus(rck) {
  const out = [];
  for (const m of CORPUS) out.push(await sealBody(rck, m));
  return out;
}

/* ------------------------------------------------------------------ */
/* T1: same-corpus parity, plaintext room vs enc room                  */
/* ------------------------------------------------------------------ */

test("stage3 T1: same-corpus parity - enc snapshot decrypts to the plaintext room's bodies", { timeout: 60000 }, async (t) => {
  if (!needRelay(t)) return;
  const { relay, admin, dev, ack, rck, keyInfo, encFields } = await setupDevice(t);

  // Plaintext twin room, owned by its own freshly paired device so the two
  // rooms never fight over one connection's room binding.
  const plainKeys = await pairKeyDevice(relay, admin, "dev-s3-plain");
  const { conn: devPlain } = await keyAuthDevice(relay, "dev-s3-plain", plainKeys, ["crypto.auth"]);
  t.after(() => devPlain.close());

  await registerRoom(devPlain, "s3-plain", "dev-s3-plain", null);
  seedRoom(devPlain, "s3-plain", CORPUS, null);

  await registerRoom(dev, "s3-enc", "dev-s3", encFields);
  seedRoom(dev, "s3-enc", await sealCorpus(rck), encFields);
  await sleep(300);

  const { conn: viewer } = await authedViewer(relay, ENC_CAPS);
  t.after(() => viewer.close());

  const plainSnap = await subscribeSnapshot(viewer, "s3-plain");
  const truth = plainBodies(plainSnap);
  assert.equal(truth.length, CORPUS.length, "plaintext room must store the whole corpus");
  assert.deepEqual(truth, CORPUS, "plaintext storage must be lossless (ground truth for parity)");

  const encSnap = await subscribeSnapshot(viewer, "s3-enc");
  assert.equal(encSnap.enc, 1, "enc snapshot frame must carry enc:1");
  assert.ok(encSnap.keyInfo, "enc snapshot frame must carry keyInfo for cap viewers");
  assert.equal(encSnap.keyInfo.ackFp, keyInfo.ackFp, "keyInfo ackFp must match the room's ACK");
  assert.deepEqual(await webUnwrapRck(ack, encSnap.keyInfo.rckWrap), rck, "keyInfo rckWrap must unwrap to the room RCK");

  const decrypted = [];
  for (const env of encEnvelopes(encSnap)) decrypted.push(await openBody(ack, encSnap.keyInfo, env));
  assert.deepEqual(decrypted, truth, "decrypted enc bodies must deep-equal the plaintext room's bodies, record by record");
  console.log(`[stage3 T1] producer=${producerBinding} consumer=${consumerBinding}`);
});

/* ------------------------------------------------------------------ */
/* T2: live stream, snapshot, and seed/resync all agree                */
/* ------------------------------------------------------------------ */

test("stage3 T2: three paths agree - live events, snapshot, seed/resync decrypt identically", { timeout: 60000 }, async (t) => {
  if (!needRelay(t)) return;
  const { relay, dev, ack, rck, keyInfo, encFields } = await setupDevice(t);
  const roomId = "s3-live";
  await registerRoom(dev, roomId, "dev-s3", encFields);

  // Path A: a cap viewer subscribed first, collecting the live event stream.
  const { conn: liveViewer } = await authedViewer(relay, ENC_CAPS);
  t.after(() => liveViewer.close());
  liveViewer.send({ type: "subscribe", room: roomId });
  await liveViewer.type("subscribed", (f) => f.room === roomId);
  const liveEnvelopes = [];
  const liveDone = (async () => {
    while (liveEnvelopes.length < CORPUS.length) {
      const f = await liveViewer.type("room_event", (x) => x.room === roomId && x.event && x.event.type === "message_end", 8000);
      liveEnvelopes.push(f.event.message);
    }
  })();
  for (const env of await sealCorpus(rck)) appendMessage(dev, roomId, env);
  await liveDone;
  const liveBodies = [];
  for (const env of liveEnvelopes) liveBodies.push(await openBody(ack, keyInfo, env));
  assert.deepEqual(liveBodies, CORPUS, "live stream must decrypt to the corpus");

  // Path B: a fresh viewer's snapshot of the same room.
  const { conn: snapViewer } = await authedViewer(relay, ENC_CAPS);
  t.after(() => snapViewer.close());
  const snap = await subscribeSnapshot(snapViewer, roomId);
  const snapEnvelopes = encEnvelopes(snap);
  assert.equal(snapEnvelopes.length, CORPUS.length);
  const snapBodies = [];
  for (const env of snapEnvelopes) snapBodies.push(await openBody(ack, snap.keyInfo, env));
  assert.deepEqual(snapBodies, liveBodies, "snapshot path must agree with the live path");

  // Path C: seed/resync with freshly sealed envelopes (new nonces, same h).
  const resealed = await sealCorpus(rck);
  assert.notEqual(resealed[0].ct, snapEnvelopes[0].ct, "reseal must use fresh nonces");
  assert.equal(resealed[0].h, snapEnvelopes[0].h, "reseal must keep the same h anchors");
  seedRoom(dev, roomId, resealed, encFields);
  await sleep(300);
  const { conn: resyncViewer } = await authedViewer(relay, ENC_CAPS);
  t.after(() => resyncViewer.close());
  const snap2 = await subscribeSnapshot(resyncViewer, roomId);
  const env2 = encEnvelopes(snap2);
  assert.equal(env2.length, CORPUS.length, "resync must not duplicate records (anchor dedupe)");
  assert.deepEqual(env2.map((e) => e.h), snapEnvelopes.map((e) => e.h), "h anchors must be stable across resync");
  const bodies2 = [];
  for (const env of env2) bodies2.push(await openBody(ack, snap2.keyInfo, env));
  assert.deepEqual(bodies2, liveBodies, "resync path must agree with live and snapshot paths");
});

/* ------------------------------------------------------------------ */
/* T3: h stability + checkpoint cold-open byte identity                */
/* ------------------------------------------------------------------ */

test("stage3 T3: checkpoint cold-open - stored envelopes byte-identical after relay restart", { timeout: 60000 }, async (t) => {
  if (!needRelay(t)) return;
  const ctx = await setupDevice(t);
  const { relay, dev, ack, rck, keyInfo, encFields } = ctx;
  const roomId = "s3-ckpt";
  await registerRoom(dev, roomId, "dev-s3", encFields);
  for (const env of await sealCorpus(rck)) appendMessage(dev, roomId, env);
  await sleep(500); // let the store flush + checkpoint machinery land

  const { conn: v1 } = await authedViewer(relay, ENC_CAPS);
  const snap1 = await subscribeSnapshot(v1, roomId);
  v1.close();
  const raw1 = (snap1.messages || []).map((rec) => JSON.stringify(rec));
  const hs1 = (snap1.messages || []).map((rec) => rec.h);
  assert.equal(raw1.length, CORPUS.length);

  // Every ct on disk before the restart, for the no-re-encryption check.
  const before = readAllFiles(relay.__dir).map((f) => f.text).join("\n");
  for (const rec of snap1.messages) {
    assert.ok(before.includes(rec.ct), "stored segment bytes must contain the exact ct (no transform on write)");
  }
  const ckptFile = readAllFiles(relay.__dir).find((f) => f.text.includes("\"recent\""));
  if (ckptFile) {
    assert.ok(ckptFile.text.includes("\"enc\":1"), "checkpoint payload must carry envelope records, not plaintext");
    for (const marker of BODY_MARKERS) {
      assert.ok(!ckptFile.text.includes(marker), `checkpoint must not contain body marker ${marker}`);
    }
  } else {
    console.log("[stage3 T3] no checkpoint artifact found on disk; verifying the segment-rescan cold-open path");
  }

  const dir = relay.__dir;
  await ctx.closeRelay();
  const relay2 = await reboot(dir);
  t.after(() => relay2.close());

  const { conn: v2 } = await authedViewer(relay2, ENC_CAPS);
  t.after(() => v2.close());
  const snap2 = await subscribeSnapshot(v2, roomId);
  const raw2 = (snap2.messages || []).map((rec) => JSON.stringify(rec));
  assert.deepEqual(raw2, raw1, "stored envelopes must be byte-identical after a checkpoint cold-open");
  assert.deepEqual((snap2.messages || []).map((rec) => rec.h), hs1, "h anchors must be stable across restart");
  const bodies = [];
  for (const env of encEnvelopes(snap2)) bodies.push(await openBody(ack, snap2.keyInfo, env));
  assert.deepEqual(bodies, CORPUS, "cold-opened room must still decrypt to the corpus");
});

/* ------------------------------------------------------------------ */
/* T4: version gate                                                    */
/* ------------------------------------------------------------------ */

test("stage3 T4: version gate - non-cap viewer gets crypto_required and zero bodies; cap viewer decrypts", { timeout: 60000 }, async (t) => {
  if (!needRelay(t)) return;
  const { relay, dev, ack, rck, keyInfo, encFields } = await setupDevice(t);
  const roomId = "s3-gate";
  await registerRoom(dev, roomId, "dev-s3", encFields);
  const sealed = await sealCorpus(rck);
  for (const env of sealed.slice(0, 3)) appendMessage(dev, roomId, env);
  await sleep(300);

  // An old-generation viewer: declares other caps, but not crypto.content.
  const { conn: oldViewer } = await authedViewer(relay, ["sync.v3", "dialog.observe", "dialog.respond"]);
  t.after(() => oldViewer.close());
  const framesBefore = oldViewer.frames.length;
  oldViewer.send({ type: "subscribe", room: roomId });
  const err = await oldViewer.wait(
    (f) => f.type === "error" && f.code === "crypto_required",
    5000,
    "crypto_required error frame",
  );
  if (err.room !== undefined) assert.equal(err.room, roomId, "gate error must name the refused room");
  await sleep(700);
  const leaked = oldViewer.frames
    .slice(framesBefore)
    .filter((f) => f.room === roomId && (f.type === "snapshot" || f.type === "room_event"));
  assert.deepEqual(leaked, [], "non-cap viewer must receive no snapshot and no room events for the enc room");
  const wire = JSON.stringify(oldViewer.frames.slice(framesBefore));
  for (const env of sealed.slice(0, 3)) {
    assert.ok(!wire.includes(env.ct), "no ciphertext may be shipped to a non-cap viewer either");
  }
  for (const marker of BODY_MARKERS) {
    assert.ok(!wire.includes(marker), `no body marker may reach a non-cap viewer: ${marker}`);
  }

  // The cap viewer gets keyInfo and decrypts normally.
  const { conn: capViewer } = await authedViewer(relay, ENC_CAPS);
  t.after(() => capViewer.close());
  const snap = await subscribeSnapshot(capViewer, roomId);
  assert.equal(snap.enc, 1);
  assert.ok(snap.keyInfo && snap.keyInfo.ackFp === keyInfo.ackFp);
  const bodies = [];
  for (const env of encEnvelopes(snap)) bodies.push(await openBody(ack, snap.keyInfo, env));
  assert.deepEqual(bodies, CORPUS.slice(0, 3));
});

/* ------------------------------------------------------------------ */
/* T5: relay blindness over the whole data directory                   */
/* ------------------------------------------------------------------ */

test("stage3 T5: relay blindness - no body markers, ACK or RCK anywhere in the data dir; metadata stays readable", { timeout: 60000 }, async (t) => {
  if (!needRelay(t)) return;
  const { relay, dev, ack, rck, encFields } = await setupDevice(t);
  const roomId = "s3-blind";
  await registerRoom(dev, roomId, "dev-s3", encFields);
  const sealed = await sealCorpus(rck);
  seedRoom(dev, roomId, sealed.slice(0, 4), encFields);
  for (const env of sealed.slice(4)) appendMessage(dev, roomId, env);
  await sleep(600); // flush + checkpoint artifacts land

  const files = readAllFiles(relay.__dir);
  assert.ok(files.length > 0, "relay must have written artifacts");
  const forbidden = [
    ...BODY_MARKERS,
    ack.toString("base64"),
    rck.toString("base64"),
  ];
  for (const f of files) {
    for (const needle of forbidden) {
      assert.ok(!f.text.includes(needle), `forbidden content found in ${f.path}: ${needle.slice(0, 40)}`);
    }
  }

  // Metadata stays readable (tier b by design): an envelope segment exists,
  // role/seq are plaintext, and the room meta carries enc/ackFp/rckWrap.
  const seg = files.find((f) => f.text.includes("\"k\":\"msg\"") && f.text.includes("\"enc\":1"));
  assert.ok(seg, "an envelope segment file must exist");
  assert.ok(seg.text.includes("\"role\":\"assistant\""), "role metadata must stay readable");
  assert.ok(seg.text.includes("\"seq\":"), "seq metadata must stay readable");
  const metaLine = seg.text.split("\n").find((l) => l.startsWith("{\"k\":\"meta\""));
  assert.ok(metaLine, "room meta line must exist");
  const meta = JSON.parse(metaLine);
  assert.equal(meta.enc, 1, "room meta must carry enc:1");
  assert.equal(meta.ackFp, encFields.ackFp, "room meta must carry the ACK fingerprint");
  assert.equal(typeof meta.rckWrap, "string", "room meta must carry rckWrap");
  assert.deepEqual(refUnwrapRck(ack, meta.rckWrap), rck, "meta rckWrap must unwrap to the room RCK");
});

/* ------------------------------------------------------------------ */
/* T6: legacy migration mini-flow (conditional on the bridge surface)  */
/* ------------------------------------------------------------------ */

test("stage3 T6: legacy plaintext room migration via the device path", { timeout: 60000 }, async (t) => {
  if (!needRelay(t)) return;
  // The relay half of migration is a protocol surface (snapshot frame +
  // migration trailer + enc declaration -> migration_result), driven here
  // with envelopes from the real bridge producer - the same producer binding
  // as T1-T5. What this does NOT cover: the bridge's internal decision to
  // trigger migration on connect and its reading of the device's local pi
  // session files (the history source); here the history source is the
  // relay's own plaintext snapshot of the same corpus.
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay, null);
  t.after(() => admin.close());
  const keys = await pairKeyDevice(relay, admin, "dev-s3-mig");
  const { conn: dev } = await keyAuthDevice(relay, "dev-s3-mig", keys, ENC_CAPS);
  t.after(() => dev.close());

  const roomId = "s3-mig";
  await registerRoom(dev, roomId, "dev-s3-mig", null);
  seedRoom(dev, roomId, CORPUS, null);
  await sleep(400);

  // Sanity: the plaintext generation really is on disk before migration.
  const before = readAllFiles(relay.__dir).map((f) => f.text).join("\n");
  assert.ok(before.includes(`${MARK}-USER`), "plaintext generation must exist on disk before migration");
  const { conn: plainViewer } = await authedViewer(relay, null);
  const plainSnap = await subscribeSnapshot(plainViewer, roomId);
  assert.deepEqual(plainBodies(plainSnap), CORPUS);
  plainViewer.close();

  const ack = crypto.randomBytes(32);
  const rck = crypto.randomBytes(32);
  const keyInfo = { ackFp: ackFpOf(ack), rckWrap: refWrapRck(ack, rck) };
  const envelopes = await sealCorpus(rck);
  const trailer = { msgCount: CORPUS.length, lastHash: envelopes[envelopes.length - 1].h };

  const migrate = (tr) => {
    dev.send({ type: "snapshot", room: roomId, messages: envelopes, enc: { ...keyInfo }, migration: tr });
    return dev.type("migration_result", (f) => f.room === roomId, 8000);
  };

  // Attempt 1: a wrong trailer must be refused and the plaintext generation
  // kept (deletion only ever follows a successful verification, design 5).
  const bad = await migrate({ msgCount: trailer.msgCount, lastHash: "0".repeat(64) });
  assert.equal(bad.ok, false, `bad trailer must be refused (got ${JSON.stringify(bad)})`);
  assert.ok(
    readAllFiles(relay.__dir).map((f) => f.text).join("\n").includes(`${MARK}-USER`),
    "failed migration must not delete the plaintext generation",
  );

  // Attempt 2 (re-entrant): the correct trailer migrates the room.
  const good = await migrate(trailer);
  assert.equal(good.ok, true, `correct trailer must migrate (got ${JSON.stringify(good)})`);
  assert.equal(good.msgCount, CORPUS.length);
  await sleep(400);

  // Only the enc generation remains on disk.
  for (const f of readAllFiles(relay.__dir)) {
    for (const marker of BODY_MARKERS) {
      assert.ok(!f.text.includes(marker), `plaintext marker survived migration in ${f.path}: ${marker}`);
    }
  }

  // And the migrated room serves as a normal enc room.
  const { conn: capViewer } = await authedViewer(relay, ENC_CAPS);
  t.after(() => capViewer.close());
  const snap = await subscribeSnapshot(capViewer, roomId);
  assert.equal(snap.enc, 1);
  assert.ok(snap.keyInfo && snap.keyInfo.ackFp === keyInfo.ackFp, "migrated room must carry its keyInfo");
  const bodies = [];
  for (const env of encEnvelopes(snap)) bodies.push(await openBody(ack, snap.keyInfo, env));
  assert.deepEqual(bodies, CORPUS, "migrated room must decrypt to the original corpus");
});

/* ------------------------------------------------------------------ */
/* T7: a refused migration must leave the room's state untouched       */
/* ------------------------------------------------------------------ */

test("stage3 T7: refused migration leaves the room plaintext and readable (no state change before verification)", { timeout: 60000 }, async (t) => {
  if (!needRelay(t)) return;
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: admin } = await authedViewer(relay, null);
  t.after(() => admin.close());
  const keys = await pairKeyDevice(relay, admin, "dev-s3-mig7");
  const { conn: dev } = await keyAuthDevice(relay, "dev-s3-mig7", keys, ENC_CAPS);
  t.after(() => dev.close());

  const roomId = "s3-mig7";
  await registerRoom(dev, roomId, "dev-s3-mig7", null);
  seedRoom(dev, roomId, CORPUS, null);
  await sleep(400);

  const ack = crypto.randomBytes(32);
  const rck = crypto.randomBytes(32);
  const keyInfo = { ackFp: ackFpOf(ack), rckWrap: refWrapRck(ack, rck) };
  const envelopes = await sealCorpus(rck);
  dev.send({
    type: "snapshot",
    room: roomId,
    messages: envelopes,
    enc: { ...keyInfo },
    migration: { msgCount: CORPUS.length, lastHash: "0".repeat(64) },
  });
  const bad = await dev.type("migration_result", (f) => f.room === roomId, 8000);
  assert.equal(bad.ok, false, `bad trailer must be refused (got ${JSON.stringify(bad)})`);

  // Design section 5: verification precedes ANY change - a refused migration
  // leaves the room exactly as it was, so a viewer without the content cap
  // must still receive the plaintext snapshot (not a crypto_required refusal
  // against a room whose stored content is still plaintext).
  const { conn: plainViewer } = await authedViewer(relay, null);
  t.after(() => plainViewer.close());
  plainViewer.send({ type: "subscribe", room: roomId });
  const res = await plainViewer.wait(
    (f) => f.room === roomId && (f.type === "snapshot" || f.type === "error"),
    5000,
    "post-refusal subscribe outcome",
  );
  assert.equal(
    res.type,
    "snapshot",
    `refused migration changed the room's state: a no-cap viewer now gets "${res.type}" (${res.code || ""}) ` +
      "for a room whose content is still plaintext - the enc declaration was applied before verification " +
      "(relay/local.js snapshot case calls store.setEncMeta before the migration branch verifies the trailer)",
  );
  assert.deepEqual(plainBodies(res), CORPUS, "plaintext room must stay fully readable after a refused migration");
});
