// Viewer identity, Phase 4 slice R-1 -- dual-key transition storage, web
// side (ACK-rotation design section 1.3). StoredAckEntry gains the prev
// slot ({ackFp, sealed}, sealed with the same ACK_STORE_INFO mechanism);
// grant installs follow the deterministic rules shared with the device
// side (legacy = overwrite + demote, rotation = supersedes-checked
// switch or stash-and-report, same key = noop); and key selection for
// unwrapping is by fingerprint (ackCryptoKeyForFp / ackKeyCandidates),
// so a room wrap sealed under the previous ACK still opens during a
// rotation window.
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import {
  base64ToBytes,
  bytesToBase64,
  createViewerIdentityCore,
  memoryIdentityStore,
  planAckInstall,
} from "../ui/src/relay/viewerIdentity.ts"
import { decryptCtText, sealRoomKey, unwrapRoomKey } from "../ui/src/relay/contentDecrypt.ts"

const subtle = globalThis.crypto.subtle
const ACCOUNT = "admin"

function testPlatform(store) {
  return {
    subtle,
    randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    store: store ?? memoryIdentityStore(),
  }
}

const adminTransport = {
  sendAdminCommand: async (frame) => ({ viewerId: frame.viewerId, keyFp: "unused", admin: true }),
  requestViewerList: async () => [],
}

async function registeredCore(store) {
  const core = await createViewerIdentityCore(testPlatform(store))
  await core.enable(adminTransport)
  return core
}

function shaFp(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16)
}

/* Node-side counterpart of the Phase 1 wrap contract (device side). */
function nodeBoxKeyPair() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    priv: pair.privateKey,
    pubSpki: pair.publicKey.export({ format: "der", type: "spki" }),
  }
}

function nodeWrapAck({ granterPriv, recipientPubSpki, accountId, granterFp, recipientFp, ack }) {
  const pub = crypto.createPublicKey({ key: Buffer.from(recipientPubSpki), format: "der", type: "spki" })
  const shared = crypto.diffieHellman({ privateKey: granterPriv, publicKey: pub })
  const salt = Buffer.from(`${accountId}:${granterFp}:${recipientFp}`, "utf8")
  const wrapKey = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("pi-remote-ack-wrap-v1", "utf8"), 32))
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", wrapKey, nonce)
  const ct = Buffer.concat([cipher.update(ack), cipher.final(), cipher.getAuthTag()])
  return { nonce: nonce.toString("base64"), ct: ct.toString("base64") }
}

/** Deliver ack to core through a real Node-side grant frame. */
async function deliverGrant(core, device, ack, extra = {}) {
  const blob = nodeWrapAck({
    granterPriv: device.priv,
    recipientPubSpki: base64ToBytes(core.registrationInfo().boxPub),
    accountId: ACCOUNT,
    granterFp: shaFp(device.pubSpki),
    recipientFp: core.snapshot().keyFp,
    ack,
  })
  return core.acceptAckGrant({
    to: core.snapshot().keyFp,
    from: shaFp(device.pubSpki),
    fromBoxPub: bytesToBase64(new Uint8Array(device.pubSpki)),
    accountId: ACCOUNT,
    blob,
    ...extra,
  })
}

const webAckKey = (raw) => subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"])

/* ---------- 1) the install plan (shared rules with the device side) ---------- */

test("planAckInstall mirrors the device-side deterministic rules", () => {
  const A = "aaaaaaaaaaaaaaaa"
  const B = "bbbbbbbbbbbbbbbb"
  const C = "cccccccccccccccc"
  assert.equal(planAckInstall(A, A, undefined), "noop")
  assert.equal(planAckInstall(A, B, undefined), "current")
  assert.equal(planAckInstall(A, B, { purpose: "rotation", supersedes: A }), "current")
  assert.equal(planAckInstall(A, B, { purpose: "rotation", supersedes: C }), "stash")
  assert.equal(planAckInstall(A, B, { purpose: "rotation" }), "stash")
  assert.equal(planAckInstall(null, B, { purpose: "rotation", supersedes: A }), "current")
})

/* ---------- 2) legacy grant: demote on overwrite + persistence ---------- */

test("legacy grant demotes the displaced ACK into the prev slot, persisted across a reload", async () => {
  const store = memoryIdentityStore()
  const core = await registeredCore(store)
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  await core.storeAck(ACCOUNT, new Uint8Array(ackOld))
  const device = nodeBoxKeyPair()
  assert.equal(await deliverGrant(core, device, ackNew), true)
  assert.equal(core.ackFpFor(ACCOUNT), shaFp(ackNew))
  assert.equal(core.prevAckFpFor(ACCOUNT), shaFp(ackOld), "the displaced key must not vanish")

  const reloaded = await registeredCore(store)
  assert.equal(reloaded.ackFpFor(ACCOUNT), shaFp(ackNew))
  assert.equal(reloaded.prevAckFpFor(ACCOUNT), shaFp(ackOld), "the prev slot survives in IndexedDB")
})

test("legacy grant of the already-held key is a noop: no prev slot appears", async () => {
  const core = await registeredCore()
  const ack = crypto.randomBytes(32)
  await core.storeAck(ACCOUNT, new Uint8Array(ack))
  const device = nodeBoxKeyPair()
  assert.equal(await deliverGrant(core, device, ack), true)
  assert.equal(core.ackFpFor(ACCOUNT), shaFp(ack))
  assert.equal(core.prevAckFpFor(ACCOUNT), null)
})

/* ---------- 3) rotation grants ---------- */

test("rotation grant with matching supersedes switches and demotes", async () => {
  const core = await registeredCore()
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  await core.storeAck(ACCOUNT, new Uint8Array(ackOld))
  const device = nodeBoxKeyPair()
  assert.equal(await deliverGrant(core, device, ackNew, { purpose: "rotation", supersedes: shaFp(ackOld) }), true)
  assert.equal(core.ackFpFor(ACCOUNT), shaFp(ackNew))
  assert.equal(core.prevAckFpFor(ACCOUNT), shaFp(ackOld))
  assert.equal(core.snapshot().keyMismatch, null)
})

test("rotation grant with a foreign supersedes stashes only, keeps the current key, and surfaces the divergence", async () => {
  const core = await registeredCore()
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  await core.storeAck(ACCOUNT, new Uint8Array(ackOld))
  const device = nodeBoxKeyPair()
  assert.equal(await deliverGrant(core, device, ackNew, { purpose: "rotation", supersedes: shaFp(crypto.randomBytes(32)) }), true)
  assert.equal(core.ackFpFor(ACCOUNT), shaFp(ackOld), "current slot untouched")
  assert.equal(core.prevAckFpFor(ACCOUNT), shaFp(ackNew), "incoming key parked in the prev slot")
  assert.deepEqual(core.snapshot().keyMismatch, [shaFp(ackOld), shaFp(ackNew)], "divergence is presented, not hidden")
})

test("rotation grant to a viewer holding nothing installs into the current slot", async () => {
  const core = await registeredCore()
  const ackNew = crypto.randomBytes(32)
  const device = nodeBoxKeyPair()
  assert.equal(await deliverGrant(core, device, ackNew, { purpose: "rotation", supersedes: shaFp(crypto.randomBytes(32)) }), true)
  assert.equal(core.ackFpFor(ACCOUNT), shaFp(ackNew))
  assert.equal(core.prevAckFpFor(ACCOUNT), null)
})

/* ---------- 4) by-fingerprint selection opens prev-sealed wraps ---------- */

test("by-fingerprint selection: a room wrap sealed under the previous ACK opens via the prev slot", async () => {
  const core = await registeredCore()
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  await core.storeAck(ACCOUNT, new Uint8Array(ackOld))
  const device = nodeBoxKeyPair()
  assert.equal(await deliverGrant(core, device, ackNew), true)

  const wrap = await sealRoomKey(await webAckKey(ackOld), new Uint8Array(rck))
  assert.ok(wrap)
  // The current key alone cannot open it...
  assert.equal(await unwrapRoomKey(core.ackCryptoKey(ACCOUNT), wrap), null)
  // ...the by-fingerprint key for the old fp can...
  const prevKey = await core.ackCryptoKeyForFp(ACCOUNT, shaFp(ackOld))
  assert.ok(prevKey)
  const roomKey = await unwrapRoomKey(prevKey, wrap)
  assert.ok(roomKey)
  // ...and the recovered room key really is the RCK: it decrypts a text
  // envelope sealed under the raw RCK bytes (Node-side seal).
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", rck, nonce)
  const sealedBody = Buffer.concat([nonce, cipher.update(Buffer.from("prev-opens", "utf8")), cipher.final(), cipher.getAuthTag()])
  assert.equal(await decryptCtText(roomKey, sealedBody.toString("base64")), "prev-opens")
})

test("ackKeyCandidates ordering: hint match first, else current then previous", async () => {
  const core = await registeredCore()
  const ackOld = crypto.randomBytes(32)
  const ackNew = crypto.randomBytes(32)
  const rck = crypto.randomBytes(32)
  await core.storeAck(ACCOUNT, new Uint8Array(ackOld))
  const device = nodeBoxKeyPair()
  assert.equal(await deliverGrant(core, device, ackNew), true)
  const wrap = await sealRoomKey(await webAckKey(ackOld), new Uint8Array(rck))

  const hinted = await core.ackKeyCandidates(ACCOUNT, shaFp(ackOld))
  assert.equal(hinted.length, 2)
  assert.ok(await unwrapRoomKey(hinted[0], wrap), "hint puts the prev key first and it opens")

  const unhinted = await core.ackKeyCandidates(ACCOUNT)
  assert.equal(unhinted.length, 2)
  assert.equal(await unwrapRoomKey(unhinted[0], wrap), null, "current leads without a hint and cannot open the old wrap")
  assert.ok(await unwrapRoomKey(unhinted[1], wrap), "previous follows and opens it")

  assert.equal(await core.ackCryptoKeyForFp(ACCOUNT, shaFp(crypto.randomBytes(32))), null, "unknown fp holds no key")
})

/* ---------- 5) grant generation carries the rotation fields ---------- */

test("wrapAckGrant attaches purpose/supersedes only when asked; plain answers stay byte-identical in shape", async () => {
  const core = await registeredCore()
  const ack = crypto.randomBytes(32)
  await core.importAck(ACCOUNT, new Uint8Array(ack))
  const device = nodeBoxKeyPair()
  const deviceFp = shaFp(device.pubSpki)
  const plain = await core.wrapAckGrant(ACCOUNT, deviceFp, bytesToBase64(new Uint8Array(device.pubSpki)))
  assert.deepEqual(Object.keys(plain).sort(), ["ct", "nonce", "to"])
  const rotation = await core.wrapAckGrant(ACCOUNT, deviceFp, bytesToBase64(new Uint8Array(device.pubSpki)), {
    purpose: "rotation",
    supersedes: shaFp(ack),
  })
  assert.equal(rotation.purpose, "rotation")
  assert.equal(rotation.supersedes, shaFp(ack))
})
