// Content decryption (crypto Phase 3, web side): the pinned envelope
// construction against a Node-crypto counterpart in both directions,
// rckWrap unwrap under the held ACK, streaming delta decryption and
// reassembly vs the authoritative message_end, decrypt-failure
// placeholders with position preserved, ACK-level preview decryption,
// roster enc markers, and the encrypted-room search labels.
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { readFileSync } from "node:fs"
import {
  RoomKeyCache,
  UNDECRYPTABLE_LABEL,
  UNDECRYPTABLE_TEXT,
  decryptCtText,
  decryptEnvelopeJson,
  decryptRoomEvent,
  decryptSnapshotMessages,
  isContentEnvelope,
  snapshotKeyInfoOf,
  undecryptableMessage,
} from "../ui/src/relay/contentDecrypt.ts"
import { emptyTranscript, reduceTranscript } from "../ui/src/relay/transcript.ts"
import {
  RelayError,
  errorCode,
  mergeDeviceSessions,
  parseRooms,
  parseSessionList,
} from "../ui/src/relay/devices.ts"
import { bodySearchTargetsOf, mergeBodySearchReplies } from "../ui/src/relay/bodySearch.ts"
import { bodySearchErrorText, bodySearchPartialText } from "../ui/src/shell/searchModel.ts"
import { authFrame, viewerAuthFrame } from "../ui/src/relay/protocol.ts"

const subtle = globalThis.crypto.subtle

/* ---- Node-crypto counterpart of the pinned constructions (design 7) ---- */

function nodeSeal(keyRaw, plaintext) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", keyRaw, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64")
}

function nodeOpen(keyRaw, b64) {
  const raw = Buffer.from(b64, "base64")
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyRaw, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()])
}

function nodeEnvelope(keyRaw, message) {
  return { enc: 1, role: message.role, h: "", ct: nodeSeal(keyRaw, Buffer.from(JSON.stringify(message), "utf8")) }
}

async function webKey(raw) {
  return subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["decrypt"])
}

const ACK = crypto.randomBytes(32)
const WRONG_ACK = crypto.randomBytes(32)
const RCK = crypto.randomBytes(32)

const asstMsg = (text) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m",
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop",
  timestamp: 1,
})

test("envelope: Node-sealed snapshot envelope decrypts in the module (extension -> viewer direction)", async () => {
  const key = await webKey(RCK)
  const message = asstMsg("你好，世界")
  const envelope = nodeEnvelope(RCK, message)
  assert.equal(isContentEnvelope(envelope), true)
  const opened = await decryptEnvelopeJson(key, envelope.ct)
  assert.deepEqual(opened, message)
})

test("envelope: WebCrypto-sealed ct opens under Node crypto (viewer construction == counterpart)", async () => {
  // Seal exactly the way contentDecrypt's open path expects, but with a
  // raw subtle encryption here: nonce12 || ct || tag16, base64.
  const key = await subtle.importKey("raw", new Uint8Array(RCK), { name: "AES-GCM" }, false, ["encrypt"])
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const message = { role: "user", content: "问题", timestamp: 2 }
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(JSON.stringify(message))))
  const ct = Buffer.concat([Buffer.from(nonce), Buffer.from(sealed)]).toString("base64")
  const opened = JSON.parse(nodeOpen(RCK, ct).toString("utf8"))
  assert.deepEqual(opened, message)
  // And the module reads the same frame back.
  const viaModule = await decryptEnvelopeJson(await webKey(RCK), ct)
  assert.deepEqual(viaModule, message)
})

test("rckWrap: unwrap under the held ACK yields a working RCK; wrong ACK and garbage yield null", async () => {
  const rckWrap = nodeSeal(ACK, RCK)
  const cache = new RoomKeyCache()
  const key = await cache.roomKey("room-1", "fp-ack", rckWrap, await webKey(ACK))
  assert.ok(key, "unwrap must succeed under the right ACK")
  const opened = await decryptEnvelopeJson(key, nodeEnvelope(RCK, asstMsg("ok")).ct)
  assert.equal(opened.content[0].text, "ok")
  // Wrong ACK: null, and the failure is cached per room+fp+wrap.
  assert.equal(await cache.roomKey("room-2", "fp-ack", rckWrap, await webKey(WRONG_ACK)), null)
  assert.equal(await cache.roomKey("room-2", "fp-ack", rckWrap, await webKey(WRONG_ACK)), null)
  // Garbage wrap: null, never a throw.
  assert.equal(await cache.roomKey("room-3", "fp-ack", "!!!not-base64!!!", await webKey(ACK)), null)
  // A different room with the same wrap unwraps independently.
  assert.ok(await cache.roomKey("room-4", "fp-ack", rckWrap, await webKey(ACK)))
})

/** Mirror of useRelay's handleEvent mapping for the three message event types. */
function dispatchEvent(state, event) {
  if (event.type === "message_start") return reduceTranscript(state, { type: "message-start", message: event.message })
  if (event.type === "message_update") return reduceTranscript(state, { type: "message-update", event: event.assistantMessageEvent })
  if (event.type === "message_end") return reduceTranscript(state, { type: "message-end", message: event.message })
  return state
}

function liveText(state) {
  const item = state.items[state.items.length - 1]
  if (!item || item.kind !== "assistant") return null
  return item.blocks.map((b) => b.text ?? "").join("")
}

test("streaming: sealed deltas decrypt and reassemble; message_end envelope is authoritative", async () => {
  const key = await webKey(RCK)
  const empty = { ...asstMsg(""), content: [], stopReason: "pending" }
  const full = asstMsg("你好，世界")
  const wire = [
    { type: "message_start", message: nodeEnvelope(RCK, empty) },
    // delta carried as a bare ct string
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, ct: nodeSeal(RCK, Buffer.from("你好，", "utf8")) } },
    // delta carried as an envelope JSON string
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: JSON.stringify({ enc: 1, role: "assistant", h: "", ct: nodeSeal(RCK, Buffer.from("世界", "utf8")) }) } },
    { type: "message_end", message: nodeEnvelope(RCK, full) },
  ]
  let state = emptyTranscript()
  for (const frame of wire) {
    const { event, drop, failures } = await decryptRoomEvent(key, frame)
    assert.equal(drop, false)
    assert.equal(failures, 0)
    state = dispatchEvent(state, event)
    if (frame.type === "message_update" && frame.assistantMessageEvent.ct) {
      // After the first delta the live bubble already shows decrypted text.
      assert.equal(liveText(state), "你好，")
    }
  }
  assert.equal(liveText(state), "你好，世界")
})

test("streaming: a corrupted delta is dropped (counted), message_end still settles the text", async () => {
  const key = await webKey(RCK)
  const empty = { ...asstMsg(""), content: [], stopReason: "pending" }
  let state = emptyTranscript()
  const start = await decryptRoomEvent(key, { type: "message_start", message: nodeEnvelope(RCK, empty) })
  state = dispatchEvent(state, start.event)
  const bad = await decryptRoomEvent(key, {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, ct: nodeSeal(WRONG_ACK, Buffer.from("garbage", "utf8")) },
  })
  assert.equal(bad.drop, true)
  assert.equal(bad.failures, 1, "a dropped delta is still counted, never silent")
  const end = await decryptRoomEvent(key, { type: "message_end", message: nodeEnvelope(RCK, asstMsg("最终文本")) })
  state = dispatchEvent(state, end.event)
  assert.equal(liveText(state), "最终文本")
})

test("snapshot: failures become in-place placeholders and are counted; plaintext passes through", async () => {
  const key = await webKey(RCK)
  const plainUser = { role: "user", content: "明文问题", timestamp: 1 }
  const good = nodeEnvelope(RCK, asstMsg("答案"))
  const bad = nodeEnvelope(WRONG_ACK, asstMsg("解不开"))
  const sealedUser = nodeEnvelope(RCK, { role: "user", content: "秘密提问", timestamp: 2 })
  const { messages, failures } = await decryptSnapshotMessages(key, [plainUser, good, bad, sealedUser])
  assert.equal(failures, 1)
  assert.equal(messages[0], plainUser, "plaintext element passes through untouched")
  assert.equal(messages[1].content[0].text, "答案")
  // Position preserved, role preserved, honest placeholder body.
  assert.equal(messages[2].role, "assistant")
  assert.deepEqual(messages[2].content, [{ type: "text", text: UNDECRYPTABLE_TEXT }])
  assert.equal(messages[3].content, "秘密提问")
  // The decrypted list renders through the transcript with the placeholder in place.
  const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages })
  assert.equal(state.items.length, 4)
  assert.equal(state.items[2].kind, "assistant")
  assert.equal(state.items[2].blocks[0].text, UNDECRYPTABLE_TEXT)
})

test("snapshot: with no room key every envelope becomes a placeholder (never ciphertext, never blank)", async () => {
  const { messages, failures } = await decryptSnapshotMessages(null, [
    nodeEnvelope(RCK, asstMsg("a")),
    { role: "user", content: "明文", timestamp: 1 },
    nodeEnvelope(RCK, { role: "user", content: "b", timestamp: 2 }),
  ])
  assert.equal(failures, 2)
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0].content, [{ type: "text", text: UNDECRYPTABLE_TEXT }])
  assert.equal(messages[1].content, "明文")
  assert.equal(messages[2].content, UNDECRYPTABLE_TEXT)
})

test("snapshot: a remote-echo envelope (sealed bare prompt text) decrypts to the plaintext echo record, not a failure", async () => {
  const key = await webKey(RCK)
  // The live wire shape (relay/store remoteEnvelopeJson): the bridge
  // seals the prompt text itself, never a JSON message object.
  const echo = {
    enc: 1,
    role: "user",
    remote: true,
    timestamp: 99,
    h: "ab".repeat(32),
    ct: nodeSeal(RCK, Buffer.from("请把我刚才让你记的暗号再原样说一遍。", "utf8")),
    cid: "cid-echo-1",
  }
  const stored = nodeEnvelope(RCK, { role: "user", content: "请把我刚才让你记的暗号再原样说一遍。", timestamp: 100 })
  const { messages, failures } = await decryptSnapshotMessages(key, [echo, stored])
  assert.equal(failures, 0, "an authentic echo is readable, never counted as a failure")
  // Same shape the plaintext snapshot carries for an echo (remoteJson).
  assert.deepEqual(messages[0], {
    role: "user",
    remote: true,
    content: [{ type: "text", text: "请把我刚才让你记的暗号再原样说一遍。" }],
    timestamp: 99,
    cid: "cid-echo-1",
  })
  assert.equal(messages[1].content, "请把我刚才让你记的暗号再原样说一遍。", "the real stored message still decrypts as JSON")
  // Through the transcript the echo lands as a remote user bubble the
  // real message can supersede by cid, exactly like the plaintext path.
  const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages })
  const echoItem = state.items.find((item) => item.kind === "user")
  assert.ok(echoItem)
  assert.equal(echoItem.text, "请把我刚才让你记的暗号再原样说一遍。")
  assert.equal(echoItem.remote, true)
})

test("snapshot: an echo whose prompt parses as a JSON scalar still yields the raw prompt text", async () => {
  const key = await webKey(RCK)
  const echo = { enc: 1, role: "user", remote: true, timestamp: 5, h: "cd".repeat(32), ct: nodeSeal(RCK, Buffer.from("123", "utf8")) }
  const { messages, failures } = await decryptSnapshotMessages(key, [echo])
  assert.equal(failures, 0)
  assert.deepEqual(messages[0].content, [{ type: "text", text: "123" }], "the verbatim prompt wins over the parsed scalar")
})

test("snapshot: a corrupt echo ct still counts as a failure; non-JSON text under a non-user role still counts", async () => {
  const key = await webKey(RCK)
  const corruptEcho = {
    enc: 1,
    role: "user",
    remote: true,
    timestamp: 7,
    h: "ef".repeat(32),
    ct: nodeSeal(WRONG_ACK, Buffer.from("解不开的回显", "utf8")),
    cid: "cid-echo-2",
  }
  const toolText = { enc: 1, role: "toolResult", h: "ef".repeat(32), ct: nodeSeal(RCK, Buffer.from("plain tool text, not JSON", "utf8")) }
  const { messages, failures } = await decryptSnapshotMessages(key, [corruptEcho, toolText])
  assert.equal(failures, 2, "an unopenable ct and a non-user text plaintext both stay failures")
  assert.equal(messages[0].role, "user")
  assert.equal(messages[0].content, UNDECRYPTABLE_TEXT)
  assert.equal(messages[1].role, "custom")
  assert.equal(messages[1].customType, UNDECRYPTABLE_LABEL)
})

test("placeholder shapes: user keeps a string body, toolResult degrades to a labelled custom entry", () => {
  const user = undecryptableMessage("user")
  assert.equal(user.role, "user")
  assert.equal(user.content, UNDECRYPTABLE_TEXT)
  const tool = undecryptableMessage("toolResult")
  assert.equal(tool.role, "custom")
  assert.equal(tool.customType, UNDECRYPTABLE_LABEL)
  const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [user, tool] })
  assert.equal(state.items[0].kind, "user")
  assert.equal(state.items[1].kind, "custom")
})

test("firstMessage: ACK-level text envelope decrypts; a per-ct preview cache serves repeats without re-decrypting", async () => {
  const ackKey = await webKey(ACK)
  const ctA = nodeSeal(ACK, Buffer.from("第一条消息预览", "utf8"))
  const ctB = nodeSeal(ACK, Buffer.from("另一个会话的预览", "utf8"))
  assert.equal(await decryptCtText(ackKey, ctA), "第一条消息预览")
  assert.equal(await decryptCtText(await webKey(WRONG_ACK), ctA), null, "wrong ACK opens nothing")
  // Mirror of the useRelay preview cache contract: keyed by ct, filled once.
  const cache = new Map()
  let decrypts = 0
  const previewOf = async (ct) => {
    if (!cache.has(ct)) {
      decrypts += 1
      cache.set(ct, (await decryptCtText(ackKey, ct)) ?? UNDECRYPTABLE_LABEL)
    }
    return cache.get(ct)
  }
  assert.equal(await previewOf(ctA), "第一条消息预览")
  assert.equal(await previewOf(ctA), "第一条消息预览")
  assert.equal(await previewOf(ctB), "另一个会话的预览")
  assert.equal(decrypts, 2, "each ct decrypts once; repeats hit the cache")
})

test("roster: parseRooms carries enc flags and envelope previews; listed rows inherit enc", () => {
  const preview = { enc: 1, role: "user", h: "", ct: nodeSeal(ACK, Buffer.from("预览", "utf8")) }
  const rooms = parseRooms([
    { id: "r-enc", deviceId: "d1", online: true, enc: 1, firstMessage: preview },
    { id: "r-plain", deviceId: "d1", online: true, enc: 0, firstMessage: "明文预览" },
    { id: "r-old", deviceId: "d1", online: true },
  ])
  assert.equal(rooms[0].enc, true)
  assert.equal(rooms[0].firstMessageEnc, preview.ct)
  assert.equal(rooms[0].firstMessage, null, "ciphertext never poses as the preview text")
  assert.equal(rooms[1].enc, false)
  assert.equal(rooms[1].firstMessage, "明文预览")
  assert.equal(rooms[1].firstMessageEnc, undefined)
  assert.equal(rooms[2].enc, undefined, "an old relay that says nothing leaves enc unknown")
  const device = { id: "d1", name: "D", online: true }
  const rows = mergeDeviceSessions(device, rooms, [], false)
  const byRoom = new Map(rows.map((row) => [row.id, row]))
  assert.equal(byRoom.get("r-enc").enc, true)
  assert.equal(byRoom.get("r-plain").enc, false)
  assert.equal(byRoom.get("r-old").enc, undefined)
  const sessions = parseSessionList([{ id: "s1", path: "/x/s1.jsonl", firstMessage: preview }])
  assert.equal(sessions[0].firstMessageEnc, preview.ct)
})

test("search: enc-room unsupported is relabelled encrypted, in the headline and in partial results", () => {
  const encTarget = { kind: "room", roomId: "r-enc", cwd: "/proj", enc: true }
  const targets = bodySearchTargetsOf("d1", [{ id: "r-enc", online: true, deviceId: "d1", cwd: "/proj", lastActivity: 1, enc: true }], null)
  assert.equal(targets[0].enc, true, "targets carry the room's enc flag")
  const allEnc = mergeBodySearchReplies("q", [
    { target: encTarget, ok: false, error: new RelayError("unsupported", "unsupported") },
  ])
  assert.equal(allEnc.ok, false)
  assert.equal(errorCode(allEnc.error), "encrypted")
  assert.equal(bodySearchErrorText("encrypted", ""), "该房间已加密，无法在中转侧搜索")
  const page = {
    query: "q",
    results: [],
    truncated: false,
    scannedFiles: 1,
    totalFiles: 1,
  }
  const mixed = mergeBodySearchReplies("q", [
    { target: encTarget, ok: false, error: new RelayError("unsupported", "unsupported") },
    { target: { kind: "room", roomId: "r2", cwd: "/other", enc: false }, ok: true, data: page },
  ])
  assert.equal(mixed.ok, true)
  assert.equal(mixed.page.unanswered[0].code, "encrypted")
  assert.match(bodySearchPartialText(mixed.page), /已加密，无法在中转侧搜索/)
  // A plaintext room's unsupported keeps the old-device wording and code.
  const plain = mergeBodySearchReplies("q", [
    { target: { kind: "room", roomId: "r3", cwd: "/p", enc: false }, ok: false, error: new RelayError("unsupported", "unsupported") },
  ])
  assert.equal(plain.ok, false)
  assert.equal(errorCode(plain.error), "unsupported")
  assert.equal(bodySearchErrorText("unsupported", ""), "这台设备的扩展版本不支持正文搜索")
})

test("keyInfo extraction: snapshotKeyInfoOf returns the frame's keyInfo verbatim, null for anything unusable", () => {
  const wrap = nodeSeal(ACK, RCK)
  assert.deepEqual(snapshotKeyInfoOf({ type: "snapshot", keyInfo: { ackFp: "fp-1", rckWrap: wrap } }), { ackFp: "fp-1", rckWrap: wrap })
  // Parity with the gate's original inline validation: an empty ackFp is
  // still a string and passes; the wrap must be a non-empty string.
  assert.deepEqual(snapshotKeyInfoOf({ keyInfo: { ackFp: "", rckWrap: wrap } }), { ackFp: "", rckWrap: wrap })
  assert.equal(snapshotKeyInfoOf({ type: "snapshot" }), null, "no keyInfo field")
  assert.equal(snapshotKeyInfoOf({ keyInfo: null }), null)
  assert.equal(snapshotKeyInfoOf({ keyInfo: "nope" }), null, "keyInfo must be an object")
  assert.equal(snapshotKeyInfoOf({ keyInfo: [{ ackFp: "fp", rckWrap: wrap }] }), null, "arrays are not keyInfo")
  assert.equal(snapshotKeyInfoOf({ keyInfo: { ackFp: 7, rckWrap: wrap } }), null, "ackFp must be a string")
  assert.equal(snapshotKeyInfoOf({ keyInfo: { ackFp: "fp", rckWrap: "" } }), null, "an empty wrap is unusable")
  assert.equal(snapshotKeyInfoOf({ keyInfo: { ackFp: "fp", rckWrap: 9 } }), null, "rckWrap must be a string")
  assert.equal(snapshotKeyInfoOf(null), null)
  assert.equal(snapshotKeyInfoOf("snapshot"), null)
})

test("regression: a roster-pre-flagged enc room still notes its snapshot keyInfo, and the room key resolves end to end", async () => {
  // Production sequence, replayed with the module's own pieces exactly
  // the way useRelay wires them (the gate ordering itself is pinned by
  // the static test in ui-relay-connection.test.mjs):
  //   noteRoomsCrypto pre-flags the room from a roster (enc, no keyInfo)
  //   -> the snapshot gate notes the frame's keyInfo into the entry
  //   -> awaitRoomKey unwraps it via RoomKeyCache under the held ACK
  //   -> processEncSnapshot decrypts with that key.
  const ackFp = "84bdcc7be95038de"
  const rckWrap = nodeSeal(ACK, RCK)
  const sealed = nodeEnvelope(RCK, asstMsg("暗号 ZEBRA216"))
  const snapshot = { type: "snapshot", room: "room-enc", enc: 1, keyInfo: { ackFp, rckWrap }, messages: [sealed] }

  // Roster state before the snapshot arrives: enc flagged, keyInfo absent.
  const entry = { enc: true, keyInfo: null }
  // The gate's noting step must run even though entry.enc is already
  // true; the pre-fix gate early-returned on entry.enc and skipped it.
  const noted = snapshotKeyInfoOf(snapshot)
  assert.deepEqual(noted, { ackFp, rckWrap }, "the snapshot's keyInfo is extracted regardless of the room's enc flag")
  if (noted) entry.keyInfo = noted
  assert.ok(entry.keyInfo, "keyInfo must land in the pre-flagged entry")

  const cache = new RoomKeyCache()
  const key = await cache.roomKey("room-enc", entry.keyInfo.ackFp, entry.keyInfo.rckWrap, await webKey(ACK))
  assert.ok(key, "awaitRoomKey's unwrap step must resolve a working room key")
  const { messages, failures } = await decryptSnapshotMessages(key, snapshot.messages)
  assert.equal(failures, 0)
  assert.equal(messages[0].content[0].text, "暗号 ZEBRA216")

  // The pre-fix outcome for the same room, for contrast: keyInfo never
  // noted -> no key -> every envelope degrades to a placeholder.
  const stuck = { enc: true, keyInfo: null }
  const noKey = stuck.keyInfo ? await cache.roomKey("room-enc", stuck.keyInfo.ackFp, stuck.keyInfo.rckWrap, await webKey(ACK)) : null
  assert.equal(noKey, null)
  const degraded = await decryptSnapshotMessages(noKey, snapshot.messages)
  assert.equal(degraded.failures, 1)
  assert.equal(degraded.messages[0].content[0].text, UNDECRYPTABLE_TEXT)
})

test("protocol + wiring: crypto.content rides the key-auth frame only; useRelay carries the honest states", () => {
  const keyed = viewerAuthFrame({ viewerId: "v1", keyFp: "fp", clientNonce: "n" })
  assert.ok(keyed.caps.includes("crypto.auth"))
  assert.ok(keyed.caps.includes("crypto.content"))
  assert.ok(!authFrame("tok").caps.includes("crypto.content"), "token viewers keep the byte-identical frame")
  const src = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  for (const needle of ["crypto-required", "waiting-ack", "mismatch", "processEncSnapshot", "processEncRoomEvent", "decryptedPreviews", "RoomKeyCache", "noteKeyMismatch"]) {
    assert.ok(src.includes(needle), `useRelay wiring missing: ${needle}`)
  }
})
