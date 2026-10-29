// Viewer identity core (crypto Phase 2, web side): VIK/VBK generation and
// IndexedDB persistence, challenge-response auth byte parity with the relay
// contract, the Phase 1 ACK wrap contract in both directions against a
// Node-crypto counterpart (the device-side algorithm), adminSig payload
// canonicalization, and the no-identity no-change guarantees.
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import {
  ackFingerprintOf,
  adminSignPayload,
  authSignPayload,
  base64ToBytes,
  bytesToBase64,
  createViewerIdentityCore,
  indexedDbIdentityStore,
  keyFingerprintOfSpki,
  memoryIdentityStore,
  viewerIdentity,
} from "../ui/src/relay/viewerIdentity.ts"
import { authFrame, contentKeyGrantFrame, pairApproveFrame, viewerAuthFrame } from "../ui/src/relay/protocol.ts"
import { parsePairLookup } from "../ui/src/relay/pairLink.ts"

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

/* Node-side counterpart of the Phase 1 wrap contract (mirrors the device
 * implementation in extension/pi-remote-sync.ts unwrapAckGrant/wrapAckGrantTo
 * and the test-side builder in extension-crypto-auth.test.mjs). */
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

function nodeUnwrapAck({ myPriv, granterPubSpki, accountId, granterFp, myFp, blob }) {
  const pub = crypto.createPublicKey({ key: Buffer.from(granterPubSpki), format: "der", type: "spki" })
  const shared = crypto.diffieHellman({ privateKey: myPriv, publicKey: pub })
  const salt = Buffer.from(`${accountId}:${granterFp}:${myFp}`, "utf8")
  const wrapKey = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("pi-remote-ack-wrap-v1", "utf8"), 32))
  const nonce = Buffer.from(blob.nonce, "base64")
  const ct = Buffer.from(blob.ct, "base64")
  const decipher = crypto.createDecipheriv("aes-256-gcm", wrapKey, nonce)
  decipher.setAuthTag(ct.subarray(ct.length - 16))
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
}

/* ---------------- fingerprints and payload builders ---------------- */

test("fingerprint parity: keyFingerprintOfSpki and ackFingerprintOf match the relay digests", async () => {
  const box = nodeBoxKeyPair()
  assert.equal(await keyFingerprintOfSpki(new Uint8Array(box.pubSpki), subtle), shaFp(box.pubSpki))
  const ack = crypto.randomBytes(32)
  assert.equal(await ackFingerprintOf(new Uint8Array(ack), subtle), shaFp(ack))
  assert.match(await ackFingerprintOf(new Uint8Array(ack), subtle), /^[0-9a-f]{16}$/)
})

test("auth payload assembly is byte-identical to the documented concatenation", () => {
  const relayNonce = crypto.randomBytes(32)
  const clientNonce = crypto.randomBytes(32)
  const expected = Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from("vw-test", "utf8"),
    relayNonce,
    clientNonce,
  ])
  assert.deepEqual(Buffer.from(authSignPayload("vw-test", new Uint8Array(relayNonce), new Uint8Array(clientNonce))), expected)
})

test("adminSig payload: canonical JSON (recursive key sort, no whitespace) under the pinned domain", () => {
  // The id field rides along in the frame but is NOT part of the payload: it
  // is a transport correlation handle the transports stamp on after signing.
  const frame = { type: "viewer_revoke", id: "r-123", viewerId: "vw-b", adminSig: "x", adminToken: "y", extra: { z: 1, a: [3, { b: 2, a: 1 }] } }
  const expectedJson = '{"extra":{"a":[3,{"a":1,"b":2}],"z":1},"viewerId":"vw-b"}'
  const expected = Buffer.concat([
    Buffer.from("pi-remote-admin-v1", "utf8"),
    Buffer.from("viewer_revoke", "utf8"),
    Buffer.from(expectedJson, "utf8"),
  ])
  assert.deepEqual(Buffer.from(adminSignPayload(frame)), expected)
  // The relay reference implementation must keep the same pinned domain.
  const relaySource = readFileSync(new URL("../relay/pairing.js", import.meta.url), "utf8")
  assert.ok(relaySource.includes('"pi-remote-admin-v1"'), "relay adminPayload domain drifted")
  assert.ok(relaySource.includes('"pi-remote-ack-wrap-v1"') || readFileSync(new URL("../extension/pi-remote-sync.ts", import.meta.url), "utf8").includes("pi-remote-ack-wrap-v1"))
})

/* ---------------- identity lifecycle ---------------- */

test("fresh core: no identity, no key auth, no ACK operations", async () => {
  const core = await createViewerIdentityCore(testPlatform())
  const state = core.snapshot()
  assert.equal(state.hasIdentity, false)
  assert.equal(state.registered, false)
  assert.equal(state.hasAck, false)
  assert.equal(core.beginKeyAuth(), null)
  assert.equal(await core.exportAckForBackup(ACCOUNT), null)
  assert.equal(await core.wrapAckGrant(ACCOUNT, "aaaaaaaaaaaaaaaa", bytesToBase64(new Uint8Array(nodeBoxKeyPair().pubSpki))), null)
  assert.equal(await core.acceptAckGrant({ from: "bbbbbbbbbbbbbbbb", fromBoxPub: "x", blob: { nonce: "x", ct: "x" } }), false)
})

test("enable: keys are generated once, non-extractable, and registered via the transport", async () => {
  const store = memoryIdentityStore()
  const core = await createViewerIdentityCore(testPlatform(store))
  let seenFrame = null
  await core.enable({
    sendAdminCommand: async (frame) => {
      seenFrame = frame
      return { viewerId: frame.viewerId, keyFp: "fp", admin: true }
    },
    requestViewerList: async () => [],
  })
  const state = core.snapshot()
  assert.equal(state.hasIdentity, true)
  assert.equal(state.registered, true)
  assert.equal(state.admin, true)
  assert.equal(seenFrame.type, "viewer_register")
  assert.equal(seenFrame.viewerId, state.viewerId)
  // Public keys on the wire are P-256 spki (91 bytes), fingerprint matches.
  const signPub = base64ToBytes(seenFrame.signPub)
  const boxPub = base64ToBytes(seenFrame.boxPub)
  assert.equal(signPub.length, 91)
  assert.equal(boxPub.length, 91)
  assert.equal(state.keyFp, shaFp(signPub))
  // The stored private keys are non-extractable CryptoKey objects.
  const record = await store.get("identity.v1")
  assert.equal(record.signKey.extractable, false)
  assert.equal(record.boxKey.extractable, false)
  assert.deepEqual(record.signKey.usages, ["sign"])
  assert.deepEqual(record.boxKey.usages, ["deriveBits"])
})

test("persistence roundtrip: a fresh core on the same store reloads identity and ACK (unseal path)", async () => {
  const store = memoryIdentityStore()
  const ack = crypto.randomBytes(32)
  const first = await registeredCore(store)
  await first.importAck(ACCOUNT, new Uint8Array(ack))
  const fpBefore = first.snapshot()

  const second = await createViewerIdentityCore(testPlatform(store))
  const state = second.snapshot()
  assert.equal(state.viewerId, fpBefore.viewerId)
  assert.equal(state.keyFp, fpBefore.keyFp)
  assert.equal(state.registered, true)
  assert.equal(state.hasAck, true)
  assert.equal(state.ackFp, shaFp(ack))
  // The fresh core has no in-memory raw copy: export must unseal from storage.
  assert.deepEqual(Buffer.from(await second.exportAckForBackup(ACCOUNT)), ack)
  // And the reloaded signing key still answers challenges verifiably.
  const attempt = second.beginKeyAuth()
  assert.ok(attempt)
  const relayNonce = crypto.randomBytes(32)
  const sig = await second.answerChallenge(bytesToBase64(new Uint8Array(relayNonce)))
  const payload = Buffer.concat([Buffer.from("pi-remote-auth-v1", "utf8"), Buffer.from(state.viewerId, "utf8"), relayNonce, Buffer.from(attempt.clientNonce, "base64")])
  const verifyKey = crypto.createPublicKey({ key: Buffer.from(base64ToBytes(second.registrationInfo().signPub)), format: "der", type: "spki" })
  assert.equal(crypto.verify("sha256", payload, { key: verifyKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64")), true)
})

test("forget wipes identity and ACK from memory and storage", async () => {
  const store = memoryIdentityStore()
  const core = await registeredCore(store)
  await core.importAck(ACCOUNT, new Uint8Array(crypto.randomBytes(32)))
  await core.forget()
  assert.equal(core.snapshot().hasIdentity, false)
  const reloaded = await createViewerIdentityCore(testPlatform(store))
  assert.equal(reloaded.snapshot().hasIdentity, false)
  assert.equal(reloaded.snapshot().hasAck, false)
})

test("enable refused: a rejected registration stays unregistered and keeps the failure code", async () => {
  const store = memoryIdentityStore()
  const core = await createViewerIdentityCore(testPlatform(store))
  const refused = Object.assign(new Error("需要管理员验证"), { code: "admin_required" })
  const refusingTransport = {
    sendAdminCommand: async () => {
      throw refused
    },
    requestViewerList: async () => [],
  }
  await assert.rejects(core.enable(refusingTransport), (error) => error === refused)
  const stuck = core.snapshot()
  assert.equal(stuck.hasIdentity, true, "keys exist locally after the refused attempt")
  assert.equal(stuck.registered, false, "a refused registration must never read as registered")
  assert.equal(stuck.lastError, "admin_required", "the refusal code stays on the snapshot for the settings surface")
  assert.equal(core.beginKeyAuth(), null, "an unregistered identity cannot key-auth")
  // The persisted record must not claim registration either (reload path).
  const reloaded = await createViewerIdentityCore(testPlatform(store))
  assert.equal(reloaded.snapshot().registered, false)
  // Re-registering once the admin gate passes succeeds on the SAME keys.
  const state = await core.enable(adminTransport)
  assert.equal(state.registered, true)
  assert.equal(state.lastError, null)
  assert.equal(state.viewerId, stuck.viewerId, "re-register reuses the same identity instead of minting a new one")
})

test("settings facade exposes forget (the recovery action the identity section wires)", () => {
  assert.equal(typeof viewerIdentity.forget, "function")
})

/* ---------------- challenge-response auth ---------------- */

test("key auth: begin/answer roundtrip verifies against the roster public key; nonce is single-use", async () => {
  const core = await registeredCore()
  const attempt = core.beginKeyAuth()
  assert.ok(attempt)
  assert.equal(Buffer.from(attempt.clientNonce, "base64").length, 32)
  assert.equal(attempt.keyFp, core.snapshot().keyFp)
  const relayNonce = crypto.randomBytes(32)
  const sig = await core.answerChallenge(bytesToBase64(new Uint8Array(relayNonce)))
  assert.ok(sig)
  assert.equal(Buffer.from(sig, "base64").length, 64, "ECDSA P-256 signature must be r||s (64 bytes)")
  const payload = Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from(attempt.viewerId, "utf8"),
    relayNonce,
    Buffer.from(attempt.clientNonce, "base64"),
  ])
  const verifyKey = crypto.createPublicKey({ key: Buffer.from(base64ToBytes(core.registrationInfo().signPub)), format: "der", type: "spki" })
  assert.equal(crypto.verify("sha256", payload, { key: verifyKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64")), true)
  // A tampered payload must not verify, and the spent attempt cannot answer twice.
  const tampered = Buffer.concat([Buffer.from("pi-remote-auth-v1", "utf8"), Buffer.from("vw-other", "utf8"), relayNonce, Buffer.from(attempt.clientNonce, "base64")])
  assert.equal(crypto.verify("sha256", tampered, { key: verifyKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64")), false)
  assert.equal(await core.answerChallenge(bytesToBase64(new Uint8Array(relayNonce))), null)
})

test("key auth requires registration: generated-but-unregistered keys do not auth", async () => {
  const core = await createViewerIdentityCore(testPlatform())
  await core.ensureKeys()
  assert.equal(core.snapshot().hasIdentity, true)
  assert.equal(core.beginKeyAuth(), null)
})

/* ---------------- ACK wrap contract, both directions ---------------- */

test("wrap direction: the viewer's grant unwraps on the Node (device) side", async () => {
  const core = await registeredCore()
  const ack = crypto.randomBytes(32)
  await core.importAck(ACCOUNT, new Uint8Array(ack))
  const device = nodeBoxKeyPair()
  const deviceFp = shaFp(device.pubSpki)
  const blob = await core.wrapAckGrant(ACCOUNT, deviceFp, bytesToBase64(new Uint8Array(device.pubSpki)))
  assert.ok(blob)
  assert.equal(blob.to, deviceFp)
  const out = nodeUnwrapAck({
    myPriv: device.priv,
    granterPubSpki: base64ToBytes(core.registrationInfo().boxPub),
    accountId: ACCOUNT,
    granterFp: core.snapshot().keyFp,
    myFp: deviceFp,
    blob,
  })
  assert.deepEqual(out, ack)
})

test("unwrap direction: a Node-side (device) grant is accepted and stored by the viewer", async () => {
  const core = await registeredCore()
  const device = nodeBoxKeyPair()
  const deviceFp = shaFp(device.pubSpki)
  const ack = crypto.randomBytes(32)
  const blob = nodeWrapAck({
    granterPriv: device.priv,
    recipientPubSpki: base64ToBytes(core.registrationInfo().boxPub),
    accountId: ACCOUNT,
    granterFp: deviceFp,
    recipientFp: core.snapshot().keyFp,
    ack,
  })
  const accepted = await core.acceptAckGrant({ to: core.snapshot().keyFp, from: deviceFp, fromBoxPub: bytesToBase64(new Uint8Array(device.pubSpki)), accountId: ACCOUNT, blob })
  assert.equal(accepted, true)
  assert.equal(core.ackFpFor(ACCOUNT), shaFp(ack))
  assert.deepEqual(Buffer.from(await core.exportAckForBackup(ACCOUNT)), ack)
})

test("grant rejection: tampered ciphertext, wrong recipient, and swapped salt fingerprints all fail closed", async () => {
  const core = await registeredCore()
  const device = nodeBoxKeyPair()
  const deviceFp = shaFp(device.pubSpki)
  const ack = crypto.randomBytes(32)
  const good = nodeWrapAck({
    granterPriv: device.priv,
    recipientPubSpki: base64ToBytes(core.registrationInfo().boxPub),
    accountId: ACCOUNT,
    granterFp: deviceFp,
    recipientFp: core.snapshot().keyFp,
    ack,
  })
  // Tampered ct.
  const tamperedCt = Buffer.from(good.ct, "base64")
  tamperedCt[0] ^= 1
  assert.equal(
    await core.acceptAckGrant({ to: core.snapshot().keyFp, from: deviceFp, fromBoxPub: bytesToBase64(new Uint8Array(device.pubSpki)), blob: { nonce: good.nonce, ct: tamperedCt.toString("base64") } }),
    false,
  )
  // Addressed to someone else.
  assert.equal(
    await core.acceptAckGrant({ to: "ffffffffffffffff", from: deviceFp, fromBoxPub: bytesToBase64(new Uint8Array(device.pubSpki)), blob: good }),
    false,
  )
  // Salt context swapped (deliverer/recipient reversed) derives a wrong key.
  const swapped = nodeWrapAck({
    granterPriv: device.priv,
    recipientPubSpki: base64ToBytes(core.registrationInfo().boxPub),
    accountId: ACCOUNT,
    granterFp: core.snapshot().keyFp,
    recipientFp: deviceFp,
    ack,
  })
  assert.equal(
    await core.acceptAckGrant({ to: core.snapshot().keyFp, from: deviceFp, fromBoxPub: bytesToBase64(new Uint8Array(device.pubSpki)), blob: swapped }),
    false,
  )
  assert.equal(core.hasAckFor(ACCOUNT), false, "no rejected grant may leave an ACK behind")
})

test("backup bookkeeping: markBackedUp survives reload and resets when the ACK changes", async () => {
  const store = memoryIdentityStore()
  const core = await registeredCore(store)
  await core.importAck(ACCOUNT, new Uint8Array(crypto.randomBytes(32)))
  await core.markBackedUp(ACCOUNT, 1761715200000)
  assert.equal(core.snapshot().backedUpAt, 1761715200000)
  const reloaded = await createViewerIdentityCore(testPlatform(store))
  assert.equal(reloaded.snapshot().backedUp, true)
  assert.equal(reloaded.snapshot().backedUpAt, 1761715200000)
  await reloaded.importAck(ACCOUNT, new Uint8Array(crypto.randomBytes(32)))
  assert.equal(reloaded.snapshot().backedUpAt, null, "a different ACK is not covered by the old backup")
})

/* ---------------- adminSig ---------------- */

test("signAdminFrame signs only for a registered admin identity and the signature verifies", async () => {
  const core = await registeredCore()
  const frame = await core.signAdminFrame({ type: "list_viewers" })
  // The signer is named by adminBy (stamped before signing, so it is part
  // of the signed payload); viewerId is never stamped by the signer.
  assert.equal(frame.adminBy, core.snapshot().viewerId)
  assert.equal(frame.viewerId, undefined)
  assert.ok(frame.adminSig)
  const verifyKey = crypto.createPublicKey({ key: Buffer.from(base64ToBytes(core.registrationInfo().signPub)), format: "der", type: "spki" })
  assert.equal(
    crypto.verify("sha256", Buffer.from(adminSignPayload({ type: "list_viewers", adminBy: core.snapshot().viewerId })), { key: verifyKey, dsaEncoding: "ieee-p1363" }, Buffer.from(frame.adminSig, "base64")),
    true,
  )
  // Non-admin identity: frame passes through unsigned (adminToken track).
  const plain = await createViewerIdentityCore(testPlatform())
  await plain.enable({
    sendAdminCommand: async (f) => ({ viewerId: f.viewerId, keyFp: "fp", admin: false }),
    requestViewerList: async () => [],
  })
  const unsigned = await plain.signAdminFrame({ type: "list_viewers" })
  assert.equal(unsigned.adminSig, undefined)
})

test("signAdminFrame: signature still verifies after the transport stamps an id (regression)", async () => {
  const core = await registeredCore()
  const signed = await core.signAdminFrame({ type: "list_viewers" })
  assert.ok(signed.adminSig)
  assert.equal(signed.id, undefined, "the core signs before any transport id exists")
  // Simulate the transports: channel.raw / requestViewerList add the request
  // id to the frame AFTER signing. The relay recomputes the payload over the
  // frame as received, so verification must survive the added id.
  const onTheWire = { ...signed, id: "vl_simulated-transport" }
  // Test-side canonical payload, built independently of the module under
  // test: frame minus adminSig/adminToken/type/id, keys sorted recursively.
  const canon = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v)
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]"
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
  }
  const rest = {}
  for (const k of Object.keys(onTheWire)) {
    if (k === "adminSig" || k === "adminToken" || k === "type" || k === "id") continue
    rest[k] = onTheWire[k]
  }
  const payload = Buffer.concat([
    Buffer.from("pi-remote-admin-v1", "utf8"),
    Buffer.from("list_viewers", "utf8"),
    Buffer.from(canon(rest), "utf8"),
  ])
  const verifyKey = crypto.createPublicKey({ key: Buffer.from(base64ToBytes(core.registrationInfo().signPub)), format: "der", type: "spki" })
  assert.equal(
    crypto.verify("sha256", payload, { key: verifyKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signed.adminSig, "base64")),
    true,
    "the relay-side recomputation over the id-stamped frame must verify",
  )
  // Only the id is outside the signature: changing a signed field breaks it.
  const tampered = Buffer.concat([
    Buffer.from("pi-remote-admin-v1", "utf8"),
    Buffer.from("list_viewers", "utf8"),
    Buffer.from(canon({ ...rest, adminBy: "vw-attacker" }), "utf8"),
  ])
  assert.equal(
    crypto.verify("sha256", tampered, { key: verifyKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signed.adminSig, "base64")),
    false,
  )
})

test("revokeViewer: adminSig track names the signer in adminBy and keeps viewerId as the target", async () => {
  const core = await registeredCore()
  const ownId = core.snapshot().viewerId
  let sent = null
  const transport = {
    sendAdminCommand: async (frame) => {
      sent = frame
      return { closed: 1, ackRotationRequired: true, hint: "rotate" }
    },
    requestViewerList: async () => [],
  }
  await core.revokeViewer(transport, "vw-other")
  assert.equal(sent.type, "viewer_revoke")
  assert.equal(sent.viewerId, "vw-other", "viewerId stays the revocation target")
  assert.equal(sent.adminBy, ownId, "adminBy names the signer")
  assert.ok(sent.adminSig)
  // Test-side canonical payload, built independently of the module under
  // test: adminBy is part of the signed canonical JSON (keys sorted).
  const payload = Buffer.concat([
    Buffer.from("pi-remote-admin-v1", "utf8"),
    Buffer.from("viewer_revoke", "utf8"),
    Buffer.from(`{"adminBy":"${ownId}","viewerId":"vw-other"}`, "utf8"),
  ])
  const verifyKey = crypto.createPublicKey({ key: Buffer.from(base64ToBytes(core.registrationInfo().signPub)), format: "der", type: "spki" })
  assert.equal(
    crypto.verify("sha256", payload, { key: verifyKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sent.adminSig, "base64")),
    true,
  )
  // The module's payload builder (the relay-mirrored one) agrees byte-wise.
  assert.deepEqual(Buffer.from(adminSignPayload(sent)), payload)
})

test("revokeViewer: a non-admin identity sends the frame unsigned (adminToken track)", async () => {
  const plain = await createViewerIdentityCore(testPlatform())
  await plain.enable({
    sendAdminCommand: async (f) => ({ viewerId: f.viewerId, keyFp: "fp", admin: false }),
    requestViewerList: async () => [],
  })
  let sent = null
  await plain.revokeViewer(
    {
      sendAdminCommand: async (frame) => {
        sent = frame
        return {}
      },
      requestViewerList: async () => [],
    },
    "vw-other",
  )
  assert.equal(sent.viewerId, "vw-other")
  assert.equal(sent.adminSig, undefined)
  assert.equal(sent.adminBy, undefined)
})

test("identityApi loads the real viewerIdentity module (literal import, no shim)", () => {
  // Node cannot resolve the "@" alias, so this pins the source contract;
  // the vite production build is the live proof that the literal import
  // resolves and bundles the real core.
  const apiSource = readFileSync(new URL("../ui/src/pi/settings/pages/identityApi.ts", import.meta.url), "utf8")
  assert.ok(apiSource.includes('import("@/relay/viewerIdentity")'), "identityApi must use the literal dynamic import")
  assert.ok(!apiSource.includes("@vite-ignore"), "the @vite-ignore variable-specifier workaround must be gone")
  assert.ok(!apiSource.includes("IDENTITY_MODULE_SPECIFIER"), "the variable specifier must be gone")
  assert.equal(existsSync(new URL("../ui/src/relay/viewerIdentity.ts", import.meta.url)), true, "the real module must exist")
  assert.equal(existsSync(new URL("../ui/src/relay/viewerIdentity.d.ts", import.meta.url)), false, "no .d.ts shim may shadow the real module")
})

/* ---------------- IndexedDB code path (fake IDB factory) ---------------- */

class FakeRequest {
  constructor() {
    this.result = undefined
    this.error = null
    this.onsuccess = null
    this.onerror = null
  }
  succeed(value) {
    this.result = value
    queueMicrotask(() => this.onsuccess && this.onsuccess())
  }
}
class FakeObjectStore {
  constructor(db) {
    this.db = db
  }
  get(key) {
    const request = new FakeRequest()
    request.succeed(this.db.data.has(key) ? structuredClone(this.db.data.get(key)) : undefined)
    return request
  }
  put(value, key) {
    this.db.data.set(key, structuredClone(value))
    const request = new FakeRequest()
    request.succeed(key)
    return request
  }
  delete(key) {
    this.db.data.delete(key)
    const request = new FakeRequest()
    request.succeed(undefined)
    return request
  }
}
class FakeDatabase {
  constructor() {
    this.data = new Map()
    this.stores = new Set()
    this.objectStoreNames = { contains: (name) => this.stores.has(name) }
  }
  createObjectStore(name) {
    this.stores.add(name)
    return {}
  }
  transaction() {
    return { error: null, onerror: null, objectStore: () => new FakeObjectStore(this) }
  }
}
class FakeIDBFactory {
  constructor() {
    this.db = new FakeDatabase()
  }
  open() {
    const request = new FakeRequest()
    request.result = this.db
    queueMicrotask(() => {
      if (request.onupgradeneeded) request.onupgradeneeded()
      if (request.onsuccess) request.onsuccess()
    })
    return request
  }
}

test("IndexedDB store: identity + ACK survive a reload through the real IDB code path", async () => {
  const factory = new FakeIDBFactory()
  const platform = () => ({ subtle, randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), store: indexedDbIdentityStore(factory) })
  const ack = crypto.randomBytes(32)
  const first = await createViewerIdentityCore(platform())
  await first.enable(adminTransport)
  await first.importAck(ACCOUNT, new Uint8Array(ack))

  const second = await createViewerIdentityCore(platform())
  assert.equal(second.snapshot().viewerId, first.snapshot().viewerId)
  assert.equal(second.snapshot().registered, true)
  assert.equal(second.snapshot().ackFp, shaFp(ack))
  assert.deepEqual(Buffer.from(await second.exportAckForBackup(ACCOUNT)), ack)
})

/* ---------------- frames and no-identity guarantees ---------------- */

test("frames: key auth frame carries crypto.auth and no token; token frame is unchanged", () => {
  const key = viewerAuthFrame({ viewerId: "vw-1", keyFp: "aaaaaaaaaaaaaaaa", clientNonce: "bm9uY2U=" })
  assert.equal(key.type, "auth")
  assert.equal(key.role, "viewer")
  assert.equal(key.viewerId, "vw-1")
  assert.equal(key.keyFp, "aaaaaaaaaaaaaaaa")
  assert.ok(key.caps.includes("crypto.auth"))
  assert.ok(!("token" in key), "key auth frame must not carry the viewer token")
  const token = authFrame("secret-token")
  assert.equal(token.token, "secret-token")
  assert.ok(!token.caps.includes("crypto.auth"), "token auth must stay byte-identical: no crypto.auth cap")
})

test("contentKeyGrantFrame: flat canonical shape the relay cleaner accepts", () => {
  // Regression (Wave 3 follow-up #7): the builder used to nest the wrap under
  // `blob` and add an accountId field; the relay's shared grant cleaner only
  // accepts top-level { to, nonce, ct } and rejected every viewer grant with
  // bad_args. The frame must stay flat and minimal.
  const frame = contentKeyGrantFrame({ to: "aaaaaaaaaaaaaaaa", blob: { nonce: "bm9uY2U=", ct: "Y2lwaGVy" } })
  assert.deepEqual(frame, { type: "content_key_grant", to: "aaaaaaaaaaaaaaaa", nonce: "bm9uY2U=", ct: "Y2lwaGVy" })
})

test("pairApproveFrame: grant is attached only when provided", () => {
  const plain = pairApproveFrame("CODE1234", "admin-secret")
  assert.deepEqual(plain, { type: "pair_approve", code: "CODE1234", adminToken: "admin-secret" })
  const grant = { to: "aaaaaaaaaaaaaaaa", nonce: "bm9uY2U=", ct: "Y2lwaGVy" }
  const withGrant = pairApproveFrame("CODE1234", "admin-secret", grant)
  assert.deepEqual(withGrant.contentKeyGrant, grant)
})

test("parsePairLookup: keyed pairing fields surface only when present", () => {
  const base = { name: "mac", platform: "darwin", expiresAt: 123, checkDigits: "42" }
  assert.deepEqual(parsePairLookup(base), { name: "mac", platform: "darwin", expiresAt: 123, checkDigits: "42" })
  const keyed = parsePairLookup({ ...base, keyFp: "aaaaaaaaaaaaaaaa", boxPub: "cHVi" })
  assert.equal(keyed.keyFp, "aaaaaaaaaaaaaaaa")
  assert.equal(keyed.boxPub, "cHVi")
})

test("useRelay wiring: key auth is chosen in onopen and its failure never reaches the token wipe", () => {
  const source = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.ok(source.includes("viewerAuthFrame(attempt)"), "onopen must send the key auth frame for a registered identity")
  assert.ok(source.includes('type === "auth_challenge"'), "auth_challenge handler missing")
  assert.ok(source.includes('type === "content_key_grant"'), "content_key_grant handler missing")
  assert.ok(source.includes('type === "content_key_request"'), "content_key_request handler missing")
  assert.ok(source.includes('code === "key_mismatch"'), "key_mismatch interception missing")
  assert.ok(source.includes("ackReportFrame(mine)"), "post-auth ack_report missing")
  const keyBranchStart = source.indexOf("Key-auth rejection (crypto Phase 2)")
  assert.ok(keyBranchStart > 0)
  const keyBranch = source.slice(keyBranchStart, source.indexOf('tokenRef.current = ""', keyBranchStart))
  assert.ok(keyBranch.includes("keyAuthBlockedFpRef"), "key failure must block retries with the rejected key")
  assert.ok(!keyBranch.includes("safeStore.remove"), "key failure must not wipe the stored viewer token")
  // The token wipe exists exactly twice: token-auth failure and logout.
  assert.equal(source.split('safeStore.remove("pi_remote_viewer_token")').length - 1, 2)
})
