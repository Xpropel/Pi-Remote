// Crypto Phase 3 (tier b) -- extension side: body envelopes, canonical
// normalization + h parity against the relay, encrypted deltas, remote echo
// h replacement, image budget before encryption, and the migration client.
// The reference implementations below are written from raw node:crypto and
// the design's pinned constructions only; they deliberately do NOT reuse
// the extension's helpers on the reference side, so a shared bug cannot
// hide. Relay implementations are imported for the parity corpus.
import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createJiti } from "jiti"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const relayStore = require("../relay/store.js")
const relayRooms = require("../relay/rooms.js")

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-crypto-content-"))
const LOG_PATH = path.join(TMP, "ext.log")
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(TMP, "missing-attach.json")
process.env.PI_REMOTE_TOKEN = "content-token-placeholder"
delete process.env.PI_REMOTE_ACCOUNT
delete process.env.PI_REMOTE_DEVICE_KEY_FILE
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

/* ---------- independent reference implementation (raw node:crypto) ---------- */

function refCanonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return "[" + v.map((x) => refCanonical(x)).join(",") + "]"
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + refCanonical(v[k])).join(",") + "}"
}
function refGcmSeal(key, plainBuf) {
  const nonce = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce)
  const ct = Buffer.concat([c.update(plainBuf), c.final()])
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString("base64")
}
function refGcmOpen(key, b64) {
  try {
    const raw = Buffer.from(String(b64 || ""), "base64")
    if (raw.length < 29) return null
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12))
    d.setAuthTag(raw.subarray(raw.length - 16))
    return Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()])
  } catch { return null }
}
const refH = (rck, m) => crypto.createHmac("sha256", rck).update(Buffer.from(refCanonical(m), "utf8")).digest("hex")
const refRemoteH = (rck, text) => crypto.createHmac("sha256", rck).update(Buffer.from(String(text), "utf8")).digest("hex")
function refSeal(rck, m) {
  return { enc: 1, role: m && m.role, h: refH(rck, m), ct: refGcmSeal(rck, Buffer.from(refCanonical(m), "utf8")) }
}
function refOpen(rck, env) {
  const plain = refGcmOpen(rck, env && env.ct)
  if (!plain) return null
  let body
  try { body = JSON.parse(plain.toString("utf8")) } catch { return null }
  if (!body || refH(rck, body) !== env.h) return null
  return body
}
const refOpenText = (rck, ct) => { const p = refGcmOpen(rck, ct); return p ? p.toString("utf8") : null }

/* ---------- device key material (same shape as the Phase 1/2 tests) ---------- */

function makeKeyData(deviceId = "dev-content-1") {
  const sign = crypto.generateKeyPairSync("ed25519")
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const der = (k, type) => k.export({ format: "der", type }).toString("base64")
  return {
    v: 1, deviceId, createdAt: 1700000000000,
    sign: { alg: "ed25519", pub: der(sign.publicKey, "spki"), priv: der(sign.privateKey, "pkcs8") },
    box: { alg: "p256", pub: der(box.publicKey, "spki"), priv: der(box.privateKey, "pkcs8") },
  }
}
let keyFileSeq = 0
function loadKeyWithAck(ack) {
  const data = makeKeyData()
  if (ack) data.contentKeys = { admin: ack.toString("base64") }
  const file = path.join(TMP, `content-${++keyFileSeq}.key.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  const r = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(r.status, "ok", r.warning || "")
  return { file, key: r.key }
}

/** A Bridge wired for content encryption: key-authed, relay advertises
 *  crypto.content, an ACK is held, and one room is bound + confirmed. All
 *  outgoing frames are captured through a ws stub (objects, parsed). */
function readyBridge(roomId = "room-enc-1") {
  const ack = crypto.randomBytes(32)
  const { file, key } = loadKeyWithAck(ack)
  const bridge = new ext.Bridge()
  const sent = []
  bridge.ws = { bufferedAmount: 0, readyState: 1, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  bridge.connected = true
  bridge.authed = true
  bridge.deviceKey = key
  bridge.relayAuth = "key"
  bridge.relayCaps = new Set(["crypto.auth", "crypto.content"])
  bridge.roomId = roomId
  bridge.confirmedRoom = roomId
  return { bridge, sent, ack, file, roomId }
}
const eventsOf = (sent, type) => sent.filter((f) => f.type === "event" && f.event && f.event.type === type)

/* ---------- 1) envelope roundtrip against the reference implementation ---------- */

const CORPUS = [
  { role: "user", timestamp: 1700000000001, content: "你好，世界 🌍" },
  { role: "user", timestamp: 1700000000002, content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: "", omitted: true, omittedBytes: 123 }] },
  { role: "assistant", timestamp: 1700000000003, content: [{ type: "text", text: "answer" }, { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls -la", nested: { b: [1, 2, { z: null, a: true }] } } }] },
  { role: "toolResult", timestamp: 1700000000004, toolCallId: "tc1", toolName: "bash", isError: false, content: [{ type: "text", text: "total 0\n" }] },
  { role: "bashExecution", timestamp: 1700000000005, command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, truncated: false },
  { role: "summary", timestamp: 1700000000006, summary: "压缩摘要 with \"quotes\" and \\slashes\\" },
  { role: "assistant", timestamp: 1700000000007, content: [{ type: "thinking", thinking: "内部推理", thinkingSignature: "sig" }, { type: "text", text: "x".repeat(5000) }] },
  { role: "branchSummary", timestamp: 1700000000008, summary: "分支", details: { deep: { deeper: [3.14, 0, 1e21, "ünïcødé"] } } },
]

test("envelope: extension seal opens under the reference opener and vice versa; h matches the reference HMAC", () => {
  const rck = crypto.randomBytes(32)
  for (const m of CORPUS) {
    const env = ext.sealBody(rck, m)
    assert.equal(env.enc, 1)
    assert.equal(env.role, m.role)
    assert.equal(env.h, refH(rck, m), "h must be HMAC-SHA256(RCK, canonicalJson(m))")
    assert.deepEqual(refOpen(rck, env), m, "reference opener must recover the body")
    assert.deepEqual(ext.openBody(rck, refSeal(rck, m)), m, "extension opener must recover a reference-sealed body")
    // Resealing re-rolls the nonce: ct changes, h does not.
    const env2 = ext.sealBody(rck, m)
    assert.notEqual(env2.ct, env.ct)
    assert.equal(env2.h, env.h)
  }
})

test("envelope: tampered ct, wrong key and forged h are all rejected", () => {
  const rck = crypto.randomBytes(32)
  const m = CORPUS[2]
  const env = ext.sealBody(rck, m)
  const raw = Buffer.from(env.ct, "base64")
  raw[20] ^= 1
  assert.equal(ext.openBody(rck, { ...env, ct: raw.toString("base64") }), null)
  assert.equal(ext.openBody(crypto.randomBytes(32), env), null)
  assert.equal(ext.openBody(rck, { ...env, h: "0".repeat(64) }), null)
  assert.equal(ext.openBody(rck, null), null)
  assert.equal(ext.openBody(rck, { enc: 1, ct: "%%%" }), null)
})

test("parity corpus: extension hashOf equals relay hashOf over the whole corpus (plaintext anchoring parity)", () => {
  for (const m of CORPUS) {
    assert.equal(ext.hashOf(m), relayStore.hashOf(m), `hashOf drift on role ${m.role}`)
  }
  // Role sensitivity and timestamp inclusion mirror the relay exactly.
  const a = { role: "user", timestamp: 42, content: "same" }
  assert.notEqual(ext.hashOf(a), ext.hashOf({ ...a, role: "assistant" }))
  assert.notEqual(ext.hashOf(a), ext.hashOf({ ...a, timestamp: 43 }))
  assert.equal(ext.hashOf(a), relayStore.hashOf(a))
})

test("room key wrap: wrap/unwrap roundtrip under the ACK; wrong ACK fails; key-file persistence recovers the same RCK", () => {
  const ack = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  const wrap = ext.wrapRoomKey(ack, rck)
  assert.deepEqual(ext.unwrapRoomKey(ack, wrap), rck)
  assert.equal(ext.unwrapRoomKey(crypto.randomBytes(32), wrap), null)
  assert.equal(ext.wrapRoomKey(ack, crypto.randomBytes(16)), null)

  const { bridge, file, ack: heldAck } = readyBridge()
  const entry = bridge.ensureRoomKey(bridge.roomId)
  assert.ok(entry, "ensureRoomKey must produce an entry once content is ready")
  assert.equal(entry.ackFp, ext.contentKeyFingerprint(heldAck))
  // The wrap persisted into the key file; a fresh load recovers the same RCK.
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(onDisk.roomKeys[bridge.roomId], entry.rckWrap)
  const reloaded = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(reloaded.status, "ok")
  const bridge2 = new ext.Bridge()
  bridge2.deviceKey = reloaded.key
  bridge2.relayAuth = "key"
  bridge2.relayCaps = new Set(["crypto.content"])
  bridge2.roomId = bridge.roomId
  bridge2.confirmedRoom = bridge.roomId
  const entry2 = bridge2.ensureRoomKey(bridge.roomId)
  assert.deepEqual(entry2.rck, entry.rck, "the RCK survives a restart via the key-file wrap")
})

test("ACK-level envelope (firstMessage / sessionArchive): roundtrip under the bare ACK", () => {
  const ack = crypto.randomBytes(32)
  const env = ext.encryptAckText(ack, "会话首条预览 preview")
  assert.equal(env.enc, 1)
  assert.equal(refOpenText(ack, env.ct), "会话首条预览 preview")
  assert.equal(ext.decryptAckText(ack, env), "会话首条预览 preview")
  assert.equal(ext.decryptAckText(crypto.randomBytes(32), env), null)
})

/* ---------- 2) send path: live events, deltas, tool results ---------- */

test("send path: message_end leaves as an envelope; no body text crosses the wire; input object untouched", () => {
  const { bridge, sent } = readyBridge()
  const msg = { role: "assistant", timestamp: 99, content: [{ type: "text", text: "绝密正文 secret body" }] }
  bridge.sendEvent({ type: "message_end", message: msg }, true)
  const frames = eventsOf(sent, "message_end")
  assert.equal(frames.length, 1)
  assert.ok(!JSON.stringify(frames[0]).includes("绝密正文"), "plaintext body must not appear in the frame")
  const env = frames[0].event.message
  const rck = bridge.roomKeyCache.get(bridge.roomId).rck
  assert.equal(env.enc, 1)
  assert.equal(env.h, refH(rck, msg))
  assert.deepEqual(refOpen(rck, env), msg)
  assert.deepEqual(msg, { role: "assistant", timestamp: 99, content: [{ type: "text", text: "绝密正文 secret body" }] }, "the caller's message object must not be mutated")
})

test("deltas: encrypted text_delta chunks reassemble to exactly the message_end body text", () => {
  const { bridge, sent } = readyBridge()
  const rck = () => bridge.roomKeyCache.get(bridge.roomId).rck
  const chunks = ["Hel", "lo ", "加密", " world"]
  for (const delta of chunks) {
    bridge.sendEvent({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta } }, false)
  }
  const updates = eventsOf(sent, "message_update")
  assert.equal(updates.length, chunks.length)
  let joined = ""
  for (const f of updates) {
    const ame = f.event.assistantMessageEvent
    assert.equal(ame.enc, 1)
    // Design section 7: the delta text field itself becomes the ct string.
    assert.ok(!chunks.includes(ame.delta), "the delta field must hold ciphertext, not the plaintext chunk")
    joined += refOpenText(rck(), ame.delta)
  }
  const full = { role: "assistant", timestamp: 7, content: [{ type: "text", text: "Hello 加密 world" }] }
  bridge.sendEvent({ type: "message_end", message: full }, true)
  const endEnv = eventsOf(sent, "message_end")[0].event.message
  const body = refOpen(rck(), endEnv)
  assert.equal(joined, "Hello 加密 world")
  assert.equal(joined, body.content[0].text, "reassembled deltas must equal the sealed body text")
})

test("send path: tool result text blocks and bash output are sealed; dialog frames stay plaintext by design", () => {
  const { bridge, sent } = readyBridge()
  const rck = () => bridge.roomKeyCache.get(bridge.roomId).rck
  bridge.sendEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "文件内容秘密" }, { type: "image", mimeType: "image/png", data: "AAAA" }] }, isError: false }, true)
  const toolFrame = eventsOf(sent, "tool_execution_end")[0]
  assert.ok(!JSON.stringify(toolFrame).includes("文件内容秘密"))
  const blocks = toolFrame.event.result.content
  assert.equal(blocks[0].enc, 1)
  assert.equal(refOpenText(rck(), blocks[0].text), "文件内容秘密", "the text field itself becomes the ct string")
  assert.deepEqual(blocks[1], { type: "image", mimeType: "image/png", data: "AAAA" }, "non-text blocks pass through unsealed")

  bridge.sendEvent({ type: "bash_execution_update", id: "b1", output: "命令输出秘密" }, false)
  const bashFrame = eventsOf(sent, "bash_execution_update")[0]
  assert.equal(bashFrame.event.enc, 1)
  assert.equal(refOpenText(rck(), bashFrame.event.output), "命令输出秘密", "the output field itself becomes the ct string")

  bridge.sendEvent({ type: "dialog_open", id: "d1", kind: "select", title: "选一个", options: ["甲", "乙"] }, true)
  const dialog = eventsOf(sent, "dialog_open")[0]
  assert.equal(dialog.event.title, "选一个", "tier (b): dialog stays plaintext by design")
})

/* ---------- 3) remote echo: h replaces text comparison ---------- */

function userEnd(text, ts) {
  return { type: "message_end", message: { role: "user", timestamp: ts, content: [{ type: "text", text }] } }
}

test("remote echo: enc frame carries ct+h (no text); the superseding user message is stamped with echoH", () => {
  const { bridge, sent } = readyBridge()
  bridge.echoRemote("远程一句话", "cid-9")
  const echo = eventsOf(sent, "remote_message")[0]
  assert.ok(echo, "echo frame sent")
  assert.equal(echo.event.text, undefined)
  assert.equal(echo.event.enc, 1)
  assert.equal(echo.event.cid, "cid-9")
  const rck = bridge.roomKeyCache.get(bridge.roomId).rck
  assert.equal(refOpenText(rck, echo.event.ct), "远程一句话")
  assert.equal(echo.event.h, refRemoteH(rck, "远程一句话"))

  bridge.sendEvent(userEnd("远程一句话", 1000), true)
  const end = eventsOf(sent, "message_end")[0]
  assert.equal(end.event.message.echoH, echo.event.h, "the user envelope must carry the echo's h so the relay can retire the remote record by equality")
  assert.equal(end.event.message.h, refH(rck, userEnd("远程一句话", 1000).message), "the envelope h stays the canonical body hash")
})

test("remote echo: duplicate texts retire FIFO; an unmatched user message gets no echoH", () => {
  const { bridge, sent } = readyBridge()
  bridge.echoRemote("好", "c1")
  bridge.echoRemote("好", "c2")
  const echos = eventsOf(sent, "remote_message")
  assert.equal(echos.length, 2)
  assert.equal(echos[0].event.h, echos[1].event.h, "identical texts share one h value (that is why retirement is FIFO)")
  bridge.sendEvent(userEnd("好", 1), true)
  bridge.sendEvent(userEnd("好", 2), true)
  bridge.sendEvent(userEnd("好", 3), true)
  const ends = eventsOf(sent, "message_end")
  assert.equal(ends[0].event.message.echoH, echos[0].event.h)
  assert.equal(ends[1].event.message.echoH, echos[0].event.h)
  assert.equal(ends[2].event.message.echoH, undefined, "queue drained: the third identical message must not inherit an echo h")
  bridge.sendEvent(userEnd("没回显过的", 4), true)
  assert.equal(eventsOf(sent, "message_end")[3].event.message.echoH, undefined)
})

test("remote echo: the [Image ...] suffix rule still matches (user text = remote text + image hint lines)", () => {
  const { bridge, sent } = readyBridge()
  bridge.echoRemote("这张怎么样", "c7")
  const echo = eventsOf(sent, "remote_message")[0]
  bridge.sendEvent(userEnd("这张怎么样\n\n[Image: /tmp/shot.png]", 5), true)
  const end = eventsOf(sent, "message_end")[0]
  assert.equal(end.event.message.echoH, echo.event.h)
  // A non-image suffix must NOT match.
  bridge.echoRemote("另一句", "c8")
  bridge.sendEvent(userEnd("另一句\n\n普通后缀", 6), true)
  assert.equal(eventsOf(sent, "message_end")[1].event.message.echoH, undefined)
})

test("remote failure: the failure frame carries h (no text) and consumes the echo, so a later identical message is not stamped", () => {
  const { bridge, sent } = readyBridge()
  bridge.echoRemote("注定失败", "c5")
  const echo = eventsOf(sent, "remote_message")[0]
  bridge.failRemote("注定失败", "注入超时", null, "c5", "timeout")
  const failed = eventsOf(sent, "remote_message_failed")[0]
  assert.ok(failed)
  assert.equal(failed.event.text, undefined)
  assert.equal(failed.event.enc, 1)
  assert.equal(failed.event.h, echo.event.h)
  assert.equal(failed.event.code, "timeout")
  bridge.sendEvent(userEnd("注定失败", 8), true)
  assert.equal(eventsOf(sent, "message_end")[0].event.message.echoH, undefined, "a consumed echo must not stamp a later message")
})

/* ---------- 4) image budget before encryption ---------- */

test("image budget: oversized and over-total images are placeholdered inside the sealed body, matching the relay's plaintext trimming", () => {
  const { bridge, sent } = readyBridge()
  const big = "A".repeat(200_000)   // over the 128K per-image cap
  const mid1 = "B".repeat(100_000)  // under per-image cap
  const mid2 = "C".repeat(100_000)  // pushes the batch over the 192K total cap
  const msg = {
    role: "user", timestamp: 11,
    content: [
      { type: "image", mimeType: "image/png", data: big },
      { type: "image", mimeType: "image/jpeg", data: mid1 },
      { type: "image", mimeType: "image/png", data: mid2 },
      { type: "text", text: "三张图" },
    ],
  }
  bridge.sendEvent({ type: "message_end", message: msg }, true)
  const env = eventsOf(sent, "message_end")[0].event.message
  const rck = bridge.roomKeyCache.get(bridge.roomId).rck
  const opened = refOpen(rck, env)
  const relayTrimmed = structuredClone(msg)
  relayRooms.shrinkImagesDeep(relayTrimmed) // mutates in place, returns the omission count
  assert.deepEqual(opened, relayTrimmed, "pre-encryption trimming must equal the relay's plaintext trimming, byte for byte in structure")
  assert.deepEqual(opened.content[0], { type: "image", mimeType: "image/png", data: "", omitted: true, omittedBytes: 150000 })
  assert.equal(opened.content[1].data.length, 100_000, "the first in-budget image survives")
  assert.equal(opened.content[2].omitted, true, "the image that overflows the total budget is omitted")
  assert.equal(msg.content[0].data.length, 200_000, "the caller's message keeps its full data")
})

/* ---------- 5) crypto_required: never fall back to plaintext ---------- */

test("crypto_required: body events stop loudly (nothing sent), non-body frames keep flowing, snapshots are withheld", () => {
  const { bridge, sent } = readyBridge()
  bridge.handle({ type: "error", code: "crypto_required", message: "room requires crypto.content" })
  assert.equal(bridge.encWriteRejected, true)
  const before = sent.length
  bridge.sendEvent({ type: "message_end", message: { role: "user", timestamp: 1, content: "x" } }, true)
  assert.equal(sent.length, before, "a body event must not be sent after crypto_required")
  bridge.sendEvent({ type: "dialog_open", id: "d", kind: "input", title: "t" }, true)
  assert.equal(sent.length, before + 1, "dialog frames are not bodies and keep flowing")
  bridge.mirror = () => [{ role: "user", timestamp: 2, content: "y" }]
  bridge.pushSnapshot("test")
  assert.equal(sent.filter((f) => f.type === "snapshot").length, 0, "no plaintext snapshot fallback either")
})

/* ---------- 6) migration client ---------- */

const MIG_MSGS = [
  { role: "user", timestamp: 1001, content: "迁移问题一" },
  { role: "assistant", timestamp: 1002, content: [{ type: "text", text: "迁移回答一" }] },
  { role: "user", timestamp: 1003, content: "迁移问题二" },
]
function migrationBridge() {
  const ctx = readyBridge("room-mig-1")
  ctx.bridge.mirror = () => MIG_MSGS.map((m) => structuredClone(m))
  return ctx
}

test("migration: plaintext history triggers a re-registration carrying room meta, then a sealed seed with the verification trailer", async () => {
  const { bridge, sent, ack, roomId } = migrationBridge()
  bridge.handle({ type: "room_registered", room: roomId, msgCount: MIG_MSGS.length })
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(bridge.migrationPending, "migration must be pending after a plaintext-history registration")
  assert.equal(bridge.migrationPending.msgCount, MIG_MSGS.length)
  const rck = bridge.roomKeyCache.get(roomId).rck
  assert.equal(bridge.migrationPending.lastHash, refH(rck, MIG_MSGS[MIG_MSGS.length - 1]), "lastHash is the last record's envelope h")
  const reg = sent.find((f) => f.type === "room_register")
  assert.ok(reg, "migration re-registers the room (new epoch)")
  assert.equal(reg.room.enc, 1)
  assert.equal(reg.room.ackFp, ext.contentKeyFingerprint(ack))
  assert.deepEqual(ext.unwrapRoomKey(ack, reg.room.rckWrap), rck, "the registered wrap opens to the room key under the ACK")
  assert.equal(sent.filter((f) => f.type === "snapshot").length, 0, "no snapshot against the pre-migration reply")

  // The relay confirms the new generation (still empty): the seed goes out
  // sealed, with the verification trailer attached.
  bridge.handle({ type: "room_registered", room: roomId, msgCount: 0 })
  const snap = sent.find((f) => f.type === "snapshot")
  assert.ok(snap, "seed snapshot sent for the new generation")
  assert.equal(snap.enc, 1)
  assert.deepEqual(snap.migration, { msgCount: MIG_MSGS.length, lastHash: bridge.migrationPending.lastHash })
  assert.ok(!JSON.stringify(snap).includes("迁移问题一"), "the migrated history must not cross as plaintext")
  assert.equal(snap.messages.length, MIG_MSGS.length)
  snap.messages.forEach((env, i) => assert.deepEqual(refOpen(rck, env), MIG_MSGS[i]))

  bridge.handle({ type: "migration_result", room: roomId, ok: true })
  assert.equal(bridge.migrationPending, null)
  assert.equal(bridge.plainHistoryRooms.has(roomId), false)
})

test("migration: a failed verification keeps the pending state (re-entrant) and re-offers the trailer; a busy room defers", async () => {
  const { bridge, sent, roomId } = migrationBridge()
  bridge.handle({ type: "room_registered", room: roomId, msgCount: MIG_MSGS.length })
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(bridge.migrationPending)
  bridge.handle({ type: "room_registered", room: roomId, msgCount: 0 })
  assert.ok(sent.some((f) => f.type === "snapshot" && f.migration), "trailer offered once")
  bridge.handle({ type: "migration_result", room: roomId, ok: false, reason: "count_mismatch" })
  assert.ok(bridge.migrationPending, "verify failure must keep the migration pending for re-entry")
  assert.equal(bridge.plainHistoryRooms.has(roomId), true, "plaintext history is still the room's state until a verified migration lands")

  // Reconnect-style re-offer: the relay reports the sealed generation's
  // count and its wrap; the trailer goes out again on a fresh snapshot.
  const sentBefore = sent.filter((f) => f.type === "snapshot").length
  bridge.migrationTrailerSent = false // what socketGone resets on a real reconnect
  bridge.handle({ type: "room_registered", room: roomId, msgCount: MIG_MSGS.length, rckWrap: bridge.roomKeyCache.get(roomId).rckWrap })
  const snaps = sent.filter((f) => f.type === "snapshot")
  assert.ok(snaps.length > sentBefore && snaps.at(-1).migration, "the verification trailer is re-offered after a failed verification")

  // Busy room: migration refuses to start while live traffic is in flight.
  const busy = migrationBridge()
  busy.bridge.busy = true
  busy.bridge.handle({ type: "room_registered", room: busy.roomId, msgCount: MIG_MSGS.length })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(busy.bridge.migrationPending, null, "no migration while the room is busy")
  assert.equal(busy.bridge.plainHistoryRooms.has(busy.roomId), true)
})

test("migration: without a held ACK nothing starts (room stays plaintext, clearly skipped)", async () => {
  const { key } = loadKeyWithAck(null)
  const bridge = new ext.Bridge()
  const sent = []
  bridge.ws = { bufferedAmount: 0, readyState: 1, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  bridge.connected = true
  bridge.authed = true
  bridge.deviceKey = key
  bridge.relayAuth = "key"
  bridge.relayCaps = new Set(["crypto.auth", "crypto.content"])
  bridge.roomId = "room-mig-2"
  bridge.mirror = () => MIG_MSGS.map((m) => structuredClone(m))
  bridge.handle({ type: "room_registered", room: "room-mig-2", msgCount: MIG_MSGS.length })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(bridge.contentReady(), false)
  assert.equal(bridge.migrationPending, null)
  assert.equal(sent.some((f) => f.type === "room_register" && f.room && f.room.enc === 1), false, "no enc meta is offered without an ACK")
})
