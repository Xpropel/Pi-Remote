// Crypto Phase 4, slice R-0, gate A -- extension side (ACK-rotation design
// section 1.2). The mint fallback in ensureRoomKey is the disaster path of
// the rotation design: a grant overwrites the held ACK (single slot), the
// room's existing wraps stop opening, and the old code minted a fresh RCK
// whose re-declaration orphaned the room's whole encrypted history. Gate A
// forbids the mint whenever a wrap source exists (key-file roomKeys entry
// or relay meta enc record): the room enters key_stale, body sends stop,
// and the current content key is requested through the existing
// content_key_request path. These tests pin that behavior plus the heal
// (consensus ACK arrives -> the ORIGINAL RCK is adopted, never re-minted)
// and the control case (a room with no wrap anywhere still mints).
import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-phase4-r0-"))
process.env.PI_REMOTE_LOG = path.join(TMP, "ext.log")
process.env.PI_REMOTE_ATTACH_FILE = path.join(TMP, "missing-attach.json")
process.env.PI_REMOTE_TOKEN = "phase4-r0-token"
delete process.env.PI_REMOTE_ACCOUNT
delete process.env.PI_REMOTE_DEVICE_KEY_FILE
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

/* ---------- device key material (same shape as the Phase 1-3 tests) ---------- */

function makeKeyData(deviceId) {
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
function loadKey(data) {
  const file = path.join(TMP, `r0-${++keyFileSeq}.key.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  const r = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(r.status, "ok", r.warning || "")
  return { file, key: r.key, data }
}
function keyDataWithAck(deviceId, ack, roomKeys) {
  const data = makeKeyData(deviceId)
  if (ack) data.contentKeys = { admin: ack.toString("base64") }
  if (roomKeys) data.roomKeys = roomKeys
  return data
}
/** A Bridge wired for content encryption (key-authed, crypto.content cap,
 *  one room bound + confirmed), outgoing frames captured via a ws stub. */
function bridgeWith(key, roomId) {
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
  return { bridge, sent }
}
const keyRequestsOf = (sent) => sent.filter((f) => f.type === "content_key_request")
const tick = () => new Promise((r) => setTimeout(r, 30))

/* ---------- 1) relay wrap source: wrong ACK -> key_stale, never a mint ---------- */

test("gate A: a wrong-ACK device opening an existing enc room goes key_stale and never mints (relay wrap source)", async () => {
  const ackReal = crypto.randomBytes(32)
  const ackWrong = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  const relayWrap = ext.wrapRoomKey(ackReal, rck)
  const roomId = "room-r0-relay"
  const { file, key } = loadKey(keyDataWithAck("dev-r0-1", ackWrong))
  const { bridge, sent } = bridgeWith(key, roomId)

  // The relay reports the room as enc and offers its wrap; the wrong ACK
  // cannot adopt it.
  bridge.handle({ type: "room_registered", room: roomId, msgCount: 3, enc: 1, rckWrap: relayWrap })
  await tick()
  assert.equal(bridge.roomKeyCache.has(roomId), false, "the relay wrap must not be adoptable under the wrong ACK")

  const entry = bridge.ensureRoomKey(roomId)
  assert.equal(entry, null, "gate A must refuse key material for a stale room")
  assert.equal(bridge.roomKeyCache.has(roomId), false, "no minted RCK may enter the cache")
  assert.equal(bridge.keyStaleRooms.has(roomId), true, "the room must be in key_stale state")

  // The current key is requested exactly once through the existing path.
  assert.equal(keyRequestsOf(sent).length, 1, "key_stale must trigger one content_key_request")

  // Nothing was persisted: no fresh wrap appeared in the key file.
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(onDisk.roomKeys && onDisk.roomKeys[roomId], undefined, "no fresh wrap may be written for a stale room")

  // Re-registration must not declare enc meta under the divergent ACK.
  const payload = bridge.roomPayload()
  assert.equal(payload.enc, undefined, "a stale room must not be re-registered as enc")
  assert.equal(payload.ackFp, undefined)
  assert.equal(payload.rckWrap, undefined)
  assert.equal(keyRequestsOf(sent).length, 1, "the key request must not repeat within the connection")
})

/* ---------- 2) key-file wrap source: same refusal, stored wrap untouched ---------- */

test("gate A: an unopenable key-file wrap also forbids minting and is left untouched (key-file wrap source)", () => {
  const ackReal = crypto.randomBytes(32)
  const ackWrong = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  const storedWrap = ext.wrapRoomKey(ackReal, rck)
  const roomId = "room-r0-file"
  const { file, key } = loadKey(keyDataWithAck("dev-r0-2", ackWrong, { [roomId]: storedWrap }))
  const { bridge, sent } = bridgeWith(key, roomId)

  // No room_registered involved: the key-file entry alone is a wrap source.
  assert.equal(bridge.ensureRoomKey(roomId), null)
  assert.equal(bridge.keyStaleRooms.has(roomId), true)
  assert.equal(bridge.roomKeyCache.has(roomId), false)
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(onDisk.roomKeys[roomId], storedWrap, "the existing wrap must not be overwritten by a fresh mint")
  assert.equal(keyRequestsOf(sent).length, 1)
})

/* ---------- 3) stop discipline while stale ---------- */

test("gate A: while key_stale, body events and snapshots stop; non-body frames keep flowing", async () => {
  const ackReal = crypto.randomBytes(32)
  const ackWrong = crypto.randomBytes(32)
  const relayWrap = ext.wrapRoomKey(ackReal, crypto.randomBytes(32))
  const roomId = "room-r0-stop"
  const { key } = loadKey(keyDataWithAck("dev-r0-3", ackWrong))
  const { bridge, sent } = bridgeWith(key, roomId)
  bridge.handle({ type: "room_registered", room: roomId, msgCount: 2, enc: 1, rckWrap: relayWrap })
  await tick()
  assert.equal(bridge.ensureRoomKey(roomId), null)
  assert.equal(bridge.keyStaleRooms.has(roomId), true)

  const eventsBefore = sent.filter((f) => f.type === "event").length
  bridge.sendEvent({ type: "message_end", message: { role: "user", timestamp: 1, content: "must not cross" } }, true)
  assert.equal(
    sent.filter((f) => f.type === "event").length,
    eventsBefore,
    "a body event must not be sent for a key_stale room (no plaintext fallback)",
  )
  bridge.sendEvent({ type: "dialog_open", id: "d1", kind: "input", title: "t" }, true)
  assert.equal(
    sent.filter((f) => f.type === "event").length,
    eventsBefore + 1,
    "non-body frames (dialog) keep flowing while the room is stale",
  )
  bridge.mirror = () => [{ role: "user", timestamp: 2, content: "y" }]
  bridge.pushSnapshot("test")
  assert.equal(sent.filter((f) => f.type === "snapshot").length, 0, "no plaintext snapshot may be seeded into a stale room")
})

/* ---------- 4) heal: the consensus ACK arrives -> original RCK adopted ---------- */

test("gate A: delivery of the consensus ACK heals the room -- the original RCK is adopted, never re-minted", async () => {
  const ackReal = crypto.randomBytes(32)
  const ackWrong = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  const relayWrap = ext.wrapRoomKey(ackReal, rck)
  const roomId = "room-r0-heal"
  const { key, data } = loadKey(keyDataWithAck("dev-r0-4", ackWrong))
  const { bridge } = bridgeWith(key, roomId)
  bridge.handle({ type: "room_registered", room: roomId, msgCount: 3, enc: 1, rckWrap: relayWrap })
  await tick()
  assert.equal(bridge.ensureRoomKey(roomId), null)
  assert.equal(bridge.keyStaleRooms.has(roomId), true)

  // A holder of the consensus ACK answers the request with a real grant.
  const holder = loadKey(keyDataWithAck("dev-r0-holder", ackReal))
  const grant = ext.wrapAckGrant(holder.key, "admin", ackReal, key.keyFp, data.box.pub)
  assert.ok(grant, "the holder must be able to wrap the consensus ACK for the stale device")
  bridge.acceptContentKeyGrant({ to: grant.to, from: holder.key.keyFp, fromBoxPub: holder.data.box.pub, nonce: grant.nonce, ct: grant.ct })
  assert.deepEqual(bridge.accountAck(), ackReal, "the delivered ACK replaces the divergent one")

  // On the re-registration reply the relay offers the room wrap again; now
  // it opens, the room heals, and the recovered key is the ORIGINAL RCK.
  bridge.handle({ type: "room_registered", room: roomId, msgCount: 3, enc: 1, rckWrap: relayWrap })
  await tick()
  const entry = bridge.roomKeyCache.get(roomId)
  assert.ok(entry, "the room key must be recovered after the heal")
  assert.deepEqual(entry.rck, rck, "the recovered key is the room's original RCK, not a fresh mint")
  assert.equal(bridge.keyStaleRooms.has(roomId), false, "the room must leave key_stale once healed")
})

/* ---------- 5) control: no wrap anywhere -> minting still works ---------- */

test("gate A control: a room with no wrap anywhere still mints and persists as before", () => {
  const ack = crypto.randomBytes(32)
  const roomId = "room-r0-fresh"
  const { file, key } = loadKey(keyDataWithAck("dev-r0-5", ack))
  const { bridge } = bridgeWith(key, roomId)
  const entry = bridge.ensureRoomKey(roomId)
  assert.ok(entry, "a brand-new room must still get a fresh RCK")
  assert.equal(entry.ackFp, ext.contentKeyFingerprint(ack))
  assert.equal(bridge.keyStaleRooms.has(roomId), false)
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(onDisk.roomKeys[roomId], entry.rckWrap, "the fresh wrap is persisted for restart recovery")
})
