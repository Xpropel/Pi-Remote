// Content decryption, Phase 4 slice R-1 -- the symmetric sealRoomKey and
// candidate-ordered room-key resolution (ACK-rotation design section
// 1.3). Phase 3 shipped the web side with unwrap only; R-1 adds the
// seal half (needed by any future web-side rewrap) with byte parity
// against the Node-crypto construction in both directions, and
// RoomKeyCache.roomKeyFromCandidates, which tries the dual-key
// candidates in order so a wrap sealed under the previous ACK still
// resolves during a rotation window.
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { RoomKeyCache, sealRoomKey, unwrapRoomKey } from "../ui/src/relay/contentDecrypt.ts"

const subtle = globalThis.crypto.subtle

/* Node-crypto counterpart of the pinned rckWrap construction. */
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

const webKey = (raw, usages = ["encrypt", "decrypt"]) =>
  subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, usages)

const ACK = crypto.randomBytes(32)
const ACK_PREV = crypto.randomBytes(32)
const WRONG = crypto.randomBytes(32)
const RCK = crypto.randomBytes(32)

/* ---------- sealRoomKey: roundtrip and parity ---------- */

test("sealRoomKey -> unwrapRoomKey roundtrip, and Node opens the web seal byte-for-byte", async () => {
  const ackKey = await webKey(ACK)
  const wrap = await sealRoomKey(ackKey, new Uint8Array(RCK))
  assert.equal(typeof wrap, "string")
  assert.deepEqual(nodeOpen(ACK, wrap), RCK, "the seal layout is the pinned nonce||ct||tag")
  const roomKey = await unwrapRoomKey(ackKey, wrap)
  assert.ok(roomKey)
})

test("a Node-sealed wrap unwraps on the web side (the direction Phase 3 already relied on)", async () => {
  const wrap = nodeSeal(ACK, RCK)
  assert.ok(await unwrapRoomKey(await webKey(ACK, ["decrypt"]), wrap))
})

test("sealRoomKey refuses non-32-byte input instead of producing an unusable wrap", async () => {
  const ackKey = await webKey(ACK)
  assert.equal(await sealRoomKey(ackKey, new Uint8Array(16)), null)
  assert.equal(await sealRoomKey(ackKey, new Uint8Array(0)), null)
  assert.equal(await sealRoomKey(ackKey, null), null)
})

test("a wrap sealed under one ACK does not open under another", async () => {
  const wrap = await sealRoomKey(await webKey(ACK), new Uint8Array(RCK))
  assert.equal(await unwrapRoomKey(await webKey(WRONG, ["decrypt"]), wrap), null)
})

/* ---------- roomKeyFromCandidates ---------- */

test("roomKeyFromCandidates tries candidates in order and lands on the one that opens", async () => {
  const cache = new RoomKeyCache()
  const wrap = nodeSeal(ACK_PREV, RCK)
  const wrong = await webKey(WRONG, ["decrypt"])
  const prev = await webKey(ACK_PREV, ["decrypt"])
  assert.ok(await cache.roomKeyFromCandidates("room1", wrap, [wrong, prev]), "second candidate opens")
  assert.equal(await cache.roomKeyFromCandidates("room2", wrap, [wrong]), null, "no candidate opens")
  assert.equal(await cache.roomKeyFromCandidates("room3", wrap, []), null, "no candidates at all")
})

test("roomKeyFromCandidates caches per (room, wrap): a later call reuses the resolved key", async () => {
  const cache = new RoomKeyCache()
  const wrap = nodeSeal(ACK_PREV, RCK)
  const prev = await webKey(ACK_PREV, ["decrypt"])
  const first = await cache.roomKeyFromCandidates("room1", wrap, [prev])
  const second = await cache.roomKeyFromCandidates("room1", wrap, [])
  assert.ok(first)
  assert.equal(second, first, "the cached resolution is returned even with an empty candidate list")
  cache.clear()
  assert.equal(await cache.roomKeyFromCandidates("room1", wrap, []), null, "clear drops the candidate cache too")
})
