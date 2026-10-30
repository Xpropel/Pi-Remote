// Crypto Phase 4, slice R-1 -- dual-key transition storage, extension side
// (ACK-rotation design section 1.3). The single-slot grant overwrite was
// the first link of the rotation disaster chain: the instant a new ACK
// landed, the old one vanished and every wrap sealed under it stopped
// opening. R-1 adds the previous slot (key file contentKeysPrev),
// fingerprint-selected unwrapping (current first, previous fallback),
// demote-on-overwrite for legacy grants, and the deterministic install
// rules for grants carrying the new optional purpose/supersedes fields.
// Gate A (slice R-0) must keep holding throughout: when NEITHER slot
// opens an existing wrap, the room goes key_stale and nothing is minted.
import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-phase4-r1-"))
process.env.PI_REMOTE_LOG = path.join(TMP, "ext.log")
process.env.PI_REMOTE_ATTACH_FILE = path.join(TMP, "missing-attach.json")
process.env.PI_REMOTE_TOKEN = "r1-test-token"
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
function keyDataFull(deviceId, { ack, ackPrev, roomKeys } = {}) {
  const data = makeKeyData(deviceId)
  if (ack) data.contentKeys = { admin: ack.toString("base64") }
  if (ackPrev) data.contentKeysPrev = { admin: ackPrev.toString("base64") }
  if (roomKeys) data.roomKeys = roomKeys
  return data
}
let keyFileSeq = 0
function loadKey(data) {
  const file = path.join(TMP, `r1-${++keyFileSeq}.key.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  const r = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(r.status, "ok", r.warning || "")
  return { file, key: r.key, data }
}
const readKeyFile = (file) => JSON.parse(fs.readFileSync(file, "utf8"))
const fp = (buf) => ext.contentKeyFingerprint(buf)

/** A Bridge wired for content crypto with frames captured; room binding
 *  is left null so grant handling runs without room side effects. */
function bridgeWith(key) {
  const bridge = new ext.Bridge()
  const sent = []
  bridge.ws = { bufferedAmount: 0, readyState: 1, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  bridge.connected = true
  bridge.authed = true
  bridge.deviceKey = key
  bridge.relayAuth = "key"
  bridge.relayCaps = new Set(["crypto.auth", "crypto.content"])
  bridge.roomId = null
  bridge.confirmedRoom = null
  return { bridge, sent }
}

/** Build a real grant frame from a granter device key to a receiver key. */
function grantFrame(granter, receiverKey, ack, extra = {}) {
  const g = ext.wrapAckGrant(granter.key, "admin", ack, receiverKey.keyFp, receiverKey.boxPubB64)
  assert.ok(g, "granter must be able to wrap")
  return { type: "content_key_grant", to: g.to, nonce: g.nonce, ct: g.ct, from: granter.key.keyFp, fromBoxPub: granter.key.boxPubB64, ...extra }
}

/* ---------- 1) key file: the prev slot parses, validates, roundtrips ---------- */

test("key file: contentKeysPrev loads alongside contentKeys; malformed entries drop, never fatal", () => {
  const ack = crypto.randomBytes(32)
  const ackPrev = crypto.randomBytes(32)
  const { key } = loadKey(keyDataFull("dev-parse", { ack, ackPrev }))
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack)
  assert.deepEqual(ext.heldPrevContentKey(key, "admin"), ackPrev)

  const messy = keyDataFull("dev-messy", { ack })
  messy.contentKeysPrev = { admin: 42, other: "", short: Buffer.alloc(16).toString("base64") }
  const k2 = loadKey(messy).key
  assert.equal(ext.heldPrevContentKey(k2, "admin"), null, "non-string entry drops")
  assert.equal(ext.heldPrevContentKey(k2, "short"), null, "a non-32B value counts as no key")

  const bare = loadKey(makeKeyData("dev-bare")).key
  assert.equal(ext.heldPrevContentKey(bare, "admin"), null, "absent field is simply empty")
})

/* ---------- 2) candidate ordering ---------- */

test("contentKeyCandidates: hint match first, else current then previous; duplicate slots collapse", () => {
  const ack = crypto.randomBytes(32)
  const ackPrev = crypto.randomBytes(32)
  const { key } = loadKey(keyDataFull("dev-cand", { ack, ackPrev }))
  const order = (hint) => ext.contentKeyCandidates(key, "admin", hint).map((c) => c.fp)
  assert.deepEqual(order(null), [fp(ack), fp(ackPrev)])
  assert.deepEqual(order(fp(ack)), [fp(ack), fp(ackPrev)])
  assert.deepEqual(order(fp(ackPrev)), [fp(ackPrev), fp(ack)])
  assert.deepEqual(order("0123456789abcdef"), [fp(ack), fp(ackPrev)], "unknown hint keeps default order")
  assert.deepEqual(ext.contentKeyCandidates(key, "admin", fp(ackPrev)).map((c) => c.prev), [true, false])

  const same = loadKey(keyDataFull("dev-same", { ack, ackPrev: ack })).key
  assert.equal(ext.contentKeyCandidates(same, "admin").length, 1, "identical keys in both slots are one candidate")
  assert.deepEqual(ext.contentKeyCandidates(null, "admin"), [])
})

/* ---------- 3) the install plan, branch by branch ---------- */

test("planContentKeyInstall: every branch of the deterministic rules", () => {
  const A = "aaaaaaaaaaaaaaaa"
  const B = "bbbbbbbbbbbbbbbb"
  const C = "cccccccccccccccc"
  assert.equal(ext.planContentKeyInstall(A, A, undefined), "noop")
  assert.equal(ext.planContentKeyInstall(A, A, { purpose: "rotation", supersedes: C }), "noop", "same key is a noop even mid-rotation")
  assert.equal(ext.planContentKeyInstall(A, B, undefined), "current", "legacy grant overwrites")
  assert.equal(ext.planContentKeyInstall(A, B, { purpose: "rotation", supersedes: A }), "current", "supersedes names the held key")
  assert.equal(ext.planContentKeyInstall(A, B, { purpose: "rotation", supersedes: C }), "stash", "supersedes names a third key")
  assert.equal(ext.planContentKeyInstall(A, B, { purpose: "rotation" }), "stash", "rotation without supersedes cannot switch")
  assert.equal(ext.planContentKeyInstall(A, B, { purpose: "other", supersedes: C }), "current", "unknown purpose is a legacy grant")
  assert.equal(ext.planContentKeyInstall(null, B, { purpose: "rotation", supersedes: A }), "current", "nothing held: nothing to protect")
  assert.equal(ext.planContentKeyInstall(null, B, undefined), "current")
})

/* ---------- 4) legacy grant: demote on overwrite ---------- */

test("legacy grant overwrites the current slot and demotes the displaced key into the prev slot", () => {
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const receiver = loadKey(keyDataFull("dev-legacy", { ack: ackOld }))
  const granter = loadKey(makeKeyData("dev-granter"))
  const { bridge } = bridgeWith(receiver.key)
  bridge.acceptContentKeyGrant(grantFrame(granter, receiver.key, ackNew))
  assert.deepEqual(ext.heldContentKey(receiver.key, "admin"), ackNew)
  assert.deepEqual(ext.heldPrevContentKey(receiver.key, "admin"), ackOld, "the displaced key must not vanish")
  const onDisk = readKeyFile(receiver.file)
  assert.equal(onDisk.contentKeys.admin, ackNew.toString("base64"))
  assert.equal(onDisk.contentKeysPrev.admin, ackOld.toString("base64"))
  assert.equal(onDisk.deviceId, "dev-legacy", "unrelated key-file fields pass through verbatim")
})

test("legacy grant of the already-held key is a noop: no prev slot appears", () => {
  const ack = crypto.randomBytes(32)
  const receiver = loadKey(keyDataFull("dev-noop", { ack }))
  const granter = loadKey(makeKeyData("dev-granter"))
  const { bridge } = bridgeWith(receiver.key)
  bridge.acceptContentKeyGrant(grantFrame(granter, receiver.key, ack))
  assert.deepEqual(ext.heldContentKey(receiver.key, "admin"), ack)
  assert.equal(ext.heldPrevContentKey(receiver.key, "admin"), null)
  assert.equal(readKeyFile(receiver.file).contentKeysPrev, undefined)
})

/* ---------- 5) rotation grants: switch / stash / empty-hand ---------- */

test("rotation grant with matching supersedes switches and demotes, exactly like a legacy overwrite", () => {
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const receiver = loadKey(keyDataFull("dev-rot-ok", { ack: ackOld }))
  const granter = loadKey(makeKeyData("dev-granter"))
  const { bridge } = bridgeWith(receiver.key)
  bridge.acceptContentKeyGrant(grantFrame(granter, receiver.key, ackNew, { purpose: "rotation", supersedes: fp(ackOld) }))
  assert.deepEqual(ext.heldContentKey(receiver.key, "admin"), ackNew)
  assert.deepEqual(ext.heldPrevContentKey(receiver.key, "admin"), ackOld)
})

test("rotation grant with a foreign supersedes does NOT switch: new key is only stashed in the prev slot", () => {
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const receiver = loadKey(keyDataFull("dev-rot-stash", { ack: ackOld }))
  const granter = loadKey(makeKeyData("dev-granter"))
  const { bridge } = bridgeWith(receiver.key)
  bridge.acceptContentKeyGrant(grantFrame(granter, receiver.key, ackNew, { purpose: "rotation", supersedes: fp(crypto.randomBytes(32)) }))
  assert.deepEqual(ext.heldContentKey(receiver.key, "admin"), ackOld, "current slot untouched")
  assert.deepEqual(ext.heldPrevContentKey(receiver.key, "admin"), ackNew, "incoming key parked in the prev slot")
  const onDisk = readKeyFile(receiver.file)
  assert.equal(onDisk.contentKeys.admin, ackOld.toString("base64"))
  assert.equal(onDisk.contentKeysPrev.admin, ackNew.toString("base64"))
})

test("rotation grant to an end holding nothing installs into the current slot", () => {
  const ackNew = crypto.randomBytes(32)
  const receiver = loadKey(makeKeyData("dev-rot-empty"))
  const granter = loadKey(makeKeyData("dev-granter"))
  const { bridge } = bridgeWith(receiver.key)
  bridge.acceptContentKeyGrant(grantFrame(granter, receiver.key, ackNew, { purpose: "rotation", supersedes: fp(crypto.randomBytes(32)) }))
  assert.deepEqual(ext.heldContentKey(receiver.key, "admin"), ackNew)
  assert.equal(ext.heldPrevContentKey(receiver.key, "admin"), null)
})

/* ---------- 6) dual-slot unwrapping ---------- */

test("ensureRoomKey opens a key-file wrap sealed under the PREVIOUS ack after a rotation switch", () => {
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  const wrap = ext.wrapRoomKey(ackOld, rck)
  const { key } = loadKey(keyDataFull("dev-dual", { ack: ackNew, ackPrev: ackOld, roomKeys: { roomDual: wrap } }))
  const { bridge } = bridgeWith(key)
  const entry = bridge.ensureRoomKey("roomDual")
  assert.ok(entry, "the wrap must open via the prev slot")
  assert.deepEqual(entry.rck, rck)
  assert.equal(entry.ackFp, fp(ackOld), "the entry records the key that actually opened the wrap")
  assert.equal(bridge.keyStaleRooms.has("roomDual"), false)
})

test("gate A still holds with two slots: a wrap neither key opens goes key_stale, never a mint", () => {
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const ackThird = crypto.randomBytes(32)
  const wrap = ext.wrapRoomKey(ackThird, crypto.randomBytes(32))
  const { key } = loadKey(keyDataFull("dev-stale", { ack: ackNew, ackPrev: ackOld, roomKeys: { roomStale: wrap } }))
  const { bridge, sent } = bridgeWith(key)
  assert.equal(bridge.ensureRoomKey("roomStale"), null)
  assert.equal(bridge.keyStaleRooms.has("roomStale"), true)
  assert.ok(sent.some((f) => f.type === "content_key_request"), "the consensus key is requested")
  assert.equal(readKeyFile(key.filePath ?? bridge.deviceKey.filePath).roomKeys.roomStale, wrap, "the stored wrap is never overwritten by a mint")
})

test("adoptRoomWrap: the meta ackFp hint selects the prev slot; without a hint the fallback order also lands", () => {
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  const wrap = ext.wrapRoomKey(ackOld, rck)
  const { key } = loadKey(keyDataFull("dev-adopt", { ack: ackNew, ackPrev: ackOld }))
  const { bridge } = bridgeWith(key)
  const hinted = bridge.adoptRoomWrap("roomHint", wrap, fp(ackOld))
  assert.ok(hinted)
  assert.equal(hinted.ackFp, fp(ackOld))
  assert.deepEqual(hinted.rck, rck)
  const unhinted = bridge.adoptRoomWrap("roomNoHint", wrap)
  assert.ok(unhinted, "current-then-previous fallback reaches the prev slot too")
  assert.deepEqual(unhinted.rck, rck)
})

/* ---------- 7) the rotation window end to end ---------- */

test("rotation window: after the switch, the room's not-yet-rewrapped relay wrap still opens via the prev slot", () => {
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  const relayWrap = ext.wrapRoomKey(ackOld, rck)
  const receiver = loadKey(keyDataFull("dev-window", { ack: ackOld }))
  const granter = loadKey(makeKeyData("dev-granter"))
  const first = bridgeWith(receiver.key)
  first.bridge.acceptContentKeyGrant(grantFrame(granter, receiver.key, ackNew, { purpose: "rotation", supersedes: fp(ackOld) }))
  assert.deepEqual(ext.heldContentKey(receiver.key, "admin"), ackNew)
  // A fresh bridge (restart) whose cache is empty meets the room's old
  // relay wrap before any rewrap lands: the prev slot must save it.
  const second = bridgeWith(receiver.key)
  const entry = second.bridge.adoptRoomWrap("roomWindow", relayWrap, fp(ackOld))
  assert.ok(entry, "the old wrap opens via the demoted key")
  assert.deepEqual(entry.rck, rck)
  assert.equal(second.bridge.keyStaleRooms.has("roomWindow"), false)
})
