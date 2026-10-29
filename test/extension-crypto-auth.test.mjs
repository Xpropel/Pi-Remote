// 加密阶段 1 · 扩展桥侧（设计 A §3.1/§3.2/§3.3）：钥加载三态、挑战-签名鉴权、
// ACK 请求/交付解包/持久化。验签与包裹在测试里用 node:crypto 原始 API 独立实现一遍，
// 与扩展实现对拍（不共用被测函数拼输入，避免同源同错）。
import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createJiti } from "jiti"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const { keyFingerprint } = require("../relay/util.js")

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-crypto-auth-"))
const LOG_PATH = path.join(TMP, "ext.log")
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(TMP, "missing-attach.json")
process.env.PI_REMOTE_TOKEN = "test-token"
delete process.env.PI_REMOTE_ACCOUNT
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {} })

const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

/* ---------- 测试材料：一台设备的钥文件（§3.1 形状） ---------- */
function makeKeyData(deviceId = "dev-crypto-1") {
  const sign = crypto.generateKeyPairSync("ed25519")
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const der = (k, type) => k.export({ format: "der", type }).toString("base64")
  const data = {
    v: 1,
    deviceId,
    createdAt: 1700000000000,
    sign: { alg: "ed25519", pub: der(sign.publicKey, "spki"), priv: der(sign.privateKey, "pkcs8") },
    box: { alg: "p256", pub: der(box.publicKey, "spki"), priv: der(box.privateKey, "pkcs8") },
  }
  return { data, sign, box }
}

function writeKeyFile(data, name = "device.key.json") {
  const file = path.join(TMP, name)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  return file
}

function loadOk(data, name) {
  const file = writeKeyFile(data, name)
  const r = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(r.status, "ok", r.warning || "")
  return { file, key: r.key }
}

/* ---------- 1) 钥加载三态 ---------- */

test("钥加载：环境变量未设 → none（普通无钥环境，不算异常）", () => {
  assert.deepEqual(ext.loadDeviceKey({}), { status: "none" })
  assert.deepEqual(ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: "  " }), { status: "none" })
})

test("钥加载：合法钥文件 → ok，指纹与 relay/util 同源同值", () => {
  const { data, sign } = makeKeyData()
  const { key } = loadOk(data)
  assert.equal(key.deviceId, "dev-crypto-1")
  const signPubDer = sign.publicKey.export({ format: "der", type: "spki" })
  assert.equal(key.keyFp, keyFingerprint(signPubDer), "keyFp 必须与 relay 侧 keyFingerprint 逐字一致")
  assert.equal(key.keyFp, ext.keyFingerprintHex(signPubDer))
  assert.equal(key.keyFp.length, 16)
})

test("钥加载：文件缺失 → fallback 且 warning 明示回退（不静默）", () => {
  const r = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: path.join(TMP, "no-such.key.json") })
  assert.equal(r.status, "fallback")
  assert.match(r.warning, /回退令牌鉴权/)
  assert.equal(r.key, undefined)
})

test("钥加载：损坏（坏 JSON / 错算法 / 公私钥不配对 / deviceId 不一致）→ 全部 fallback 明示", () => {
  const badJson = path.join(TMP, "bad.key.json")
  fs.writeFileSync(badJson, "{not json")
  assert.equal(ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: badJson }).status, "fallback")

  const { data } = makeKeyData()
  const wrongAlg = { ...data, sign: { ...data.sign, alg: "rsa" } }
  assert.equal(loadStatus(wrongAlg), "fallback")

  const other = makeKeyData("dev-other")
  const mismatched = { ...data, sign: { ...data.sign, pub: other.data.sign.pub } }
  const r1 = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: writeKeyFile(mismatched, "mismatch.key.json") })
  assert.equal(r1.status, "fallback")
  assert.match(r1.warning, /不配对/)

  const r2 = ext.loadDeviceKey({
    PI_REMOTE_DEVICE_KEY_FILE: writeKeyFile(data, "idmismatch.key.json"),
    PI_REMOTE_DEVICE_ID: "dev-someone-else",
  })
  assert.equal(r2.status, "fallback")
  assert.match(r2.warning, /不一致/)
})

function loadStatus(data) {
  return ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: writeKeyFile(data, "probe-" + Math.random().toString(36).slice(2) + ".key.json") }).status
}

/* ---------- 2) auth 帧：钥模式与旧形态 ---------- */

test("authFrame：无钥形态与旧版一致（caps 原样、无 keyFp、令牌照带）", () => {
  const env = { PI_REMOTE_DEVICE_ID: "dev-1", PI_REMOTE_DEVICE_TOKEN: "tok-1", PI_REMOTE_TOKEN: "shared-1" }
  const f = ext.authFrame(env, "linux")
  assert.deepEqual(f.caps, ext.CLIENT_CAPS)
  assert.equal(f.deviceId, "dev-1")
  assert.equal(f.deviceToken, "tok-1")
  assert.equal(f.token, "shared-1")
  assert.ok(!("keyFp" in f) && !("clientNonce" in f))
})

test("authFrame：钥模式声明 crypto.auth、带 keyFp/clientNonce、且不带 deviceToken（§7）", () => {
  const env = { PI_REMOTE_DEVICE_ID: "dev-1", PI_REMOTE_DEVICE_TOKEN: "tok-1", PI_REMOTE_TOKEN: "shared-1" }
  const clientNonce = crypto.randomBytes(16).toString("base64")
  const f = ext.authFrame(env, "linux", { deviceId: "dev-1", keyFp: "0123456789abcdef", clientNonce })
  assert.deepEqual(f.caps, [...ext.CLIENT_CAPS, "crypto.auth"])
  assert.equal(f.keyFp, "0123456789abcdef")
  assert.equal(f.clientNonce, clientNonce)
  assert.equal(f.deviceId, "dev-1")
  assert.ok(!("deviceToken" in f), "带 keyFp 的 auth 不许再带 deviceToken")
  assert.equal(f.token, "shared-1", "共享 token 字段口径不变")
})

/* ---------- 3) 挑战签名：独立验签 ---------- */

/** 按 §3.3 在测试侧独立拼签名输入（不复用扩展的拼法） */
function authMessage(deviceId, relayNonceB64, clientNonceB64) {
  return Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from(deviceId, "utf8"),
    Buffer.from(relayNonceB64, "base64"),
    Buffer.from(clientNonceB64, "base64"),
  ])
}

test("挑战签名：可被独立验签（relay 验法），篡改任一输入即失败", () => {
  const { data, sign } = makeKeyData()
  const { key } = loadOk(data, "sign.key.json")
  const relayNonce = crypto.randomBytes(32).toString("base64")
  const clientNonce = crypto.randomBytes(16).toString("base64")
  const sig = ext.signAuthChallenge(key, relayNonce, clientNonce)
  assert.ok(sig, "签名应产出")
  const pub = crypto.createPublicKey({ key: Buffer.from(data.sign.pub, "base64"), format: "der", type: "spki" })
  const msg = authMessage("dev-crypto-1", relayNonce, clientNonce)
  assert.equal(crypto.verify(null, msg, pub, Buffer.from(sig, "base64")), true)
  // 扩展自带验签（与 relay 同法）同样通过
  assert.equal(ext.verifyAuthSignature(data.sign.pub, "dev-crypto-1", relayNonce, clientNonce, sig), true)
  // 篡改：换 deviceId / 换 relayNonce / 换签名
  assert.equal(crypto.verify(null, authMessage("dev-other", relayNonce, clientNonce), pub, Buffer.from(sig, "base64")), false)
  assert.equal(ext.verifyAuthSignature(data.sign.pub, "dev-crypto-1", crypto.randomBytes(32).toString("base64"), clientNonce, sig), false)
  assert.equal(ext.verifyAuthSignature(data.sign.pub, "dev-crypto-1", relayNonce, clientNonce, crypto.randomBytes(64).toString("base64")), false)
  // nonce 长度不合口径（relay 侧 32B、client 侧 16B）→ 不签
  assert.equal(ext.signAuthChallenge(key, crypto.randomBytes(16).toString("base64"), clientNonce), null)
  assert.equal(ext.signAuthChallenge(key, relayNonce, crypto.randomBytes(32).toString("base64")), null)
})

test("Bridge 全链：auth_challenge → auth_response（签名可验）；auth_result key 后无 ACK 只发一次请求", () => {
  const { data } = makeKeyData()
  const { key } = loadOk(data, "bridge.key.json")
  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key
  const clientNonce = crypto.randomBytes(16).toString("base64")
  bridge.pendingClientNonce = clientNonce
  const relayNonce = crypto.randomBytes(32).toString("base64")
  bridge.handle({ type: "auth_challenge", nonce: relayNonce, expiresAt: Date.now() + 9000 })
  const resp = sent.find((f) => f.type === "auth_response")
  assert.ok(resp, "应回 auth_response")
  const pub = crypto.createPublicKey({ key: Buffer.from(data.sign.pub, "base64"), format: "der", type: "spki" })
  assert.equal(crypto.verify(null, authMessage("dev-crypto-1", relayNonce, clientNonce), pub, Buffer.from(resp.sig, "base64")), true)

  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  const reqs = sent.filter((f) => f.type === "content_key_request")
  assert.equal(reqs.length, 1, "同一条连接至多发一次 content_key_request")
  assert.equal(reqs[0].want, "admin")
})

test("Bridge：不在钥模式时收到 auth_challenge 不作答", () => {
  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.handle({ type: "auth_challenge", nonce: crypto.randomBytes(32).toString("base64") })
  assert.equal(sent.length, 0)
})

test("Bridge：钥连接被 device_revoked / device_mismatch 拒绝 → 走既有失败路径（authFailed、不重试）", () => {
  for (const code of ["device_revoked", "device_mismatch"]) {
    const bridge = new ext.Bridge()
    bridge.handle({ type: "auth_result", ok: false, code, retryable: false, error: "x" })
    assert.equal(bridge.authFailed, true, code)
    assert.equal(bridge.authed, false)
  }
})

/* ---------- 4) ACK 交付：测试侧自造包裹 → 桥解包 → 持久化往返 ---------- */

/** 按 §3.2 包裹口径在测试侧独立实现交付方（原始 crypto，不复用扩展解包的拼法） */
function wrapAckFor({ granterBoxPriv, recipientBoxPubB64, accountId, granterFp, recipientFp, ack }) {
  const pub = crypto.createPublicKey({ key: Buffer.from(recipientBoxPubB64, "base64"), format: "der", type: "spki" })
  const shared = crypto.diffieHellman({ privateKey: granterBoxPriv, publicKey: pub })
  const salt = Buffer.from(`${accountId}:${granterFp}:${recipientFp}`, "utf8")
  const wrapKey = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("pi-remote-ack-wrap-v1", "utf8"), 32))
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", wrapKey, nonce)
  const ct = Buffer.concat([cipher.update(ack), cipher.final(), cipher.getAuthTag()])
  return { nonce: nonce.toString("base64"), ct: ct.toString("base64") }
}

test("grant 解包往返 + ACK 持久化：存回钥文件、重载可见、持有后不再发请求", () => {
  const mine = makeKeyData()
  const { file, key } = loadOk(mine.data, "grant.key.json")
  const granter = makeKeyData("dev-granter")
  const granterFp = keyFingerprint(Buffer.from(granter.data.sign.pub, "base64"))
  const ack = crypto.randomBytes(32)
  const blob = wrapAckFor({
    granterBoxPriv: granter.box.privateKey,
    recipientBoxPubB64: mine.data.box.pub,
    accountId: "admin",
    granterFp,
    recipientFp: key.keyFp,
    ack,
  })

  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key
  bridge.handle({ type: "content_key_grant", to: key.keyFp, from: granterFp, fromBoxPub: granter.data.box.pub, ...blob })

  // 内存态 + 磁盘态都应持有这把 ACK
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack)
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(onDisk.contentKeys.admin, ack.toString("base64"))
  assert.equal(onDisk.deviceId, "dev-crypto-1", "写回不许动钥文件其他字段")
  const reloaded = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(reloaded.status, "ok")
  assert.deepEqual(ext.heldContentKey(reloaded.key, "admin"), ack)
  assert.equal(ext.contentKeyFingerprint(ack), crypto.createHash("sha256").update(ack).digest("hex").slice(0, 16))

  // 持有 ACK 后再来 auth_result(key)：不再发 content_key_request
  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  assert.equal(sent.filter((f) => f.type === "content_key_request").length, 0)
})

test("grant 解包：指名他人 / 密文篡改 / 上下文错位一律丢弃且不落盘", () => {
  const mine = makeKeyData()
  const { file, key } = loadOk(mine.data, "grant-bad.key.json")
  const granter = makeKeyData("dev-granter")
  const granterFp = keyFingerprint(Buffer.from(granter.data.sign.pub, "base64"))
  const ack = crypto.randomBytes(32)
  const blob = wrapAckFor({
    granterBoxPriv: granter.box.privateKey,
    recipientBoxPubB64: mine.data.box.pub,
    accountId: "admin",
    granterFp,
    recipientFp: key.keyFp,
    ack,
  })
  const bridge = new ext.Bridge()
  bridge.send = () => true
  bridge.deviceKey = key

  bridge.handle({ type: "content_key_grant", to: "ffffffffffffffff", from: granterFp, fromBoxPub: granter.data.box.pub, ...blob })
  assert.equal(ext.heldContentKey(key, "admin"), null, "指名他人的 grant 不许收")

  const tampered = { ...blob, ct: Buffer.from(blob.ct, "base64").map((b, i) => (i === 3 ? b ^ 1 : b)).toString("base64") }
  bridge.handle({ type: "content_key_grant", to: key.keyFp, from: granterFp, fromBoxPub: granter.data.box.pub, ...tampered })
  assert.equal(ext.heldContentKey(key, "admin"), null, "篡改密文解不开就不许留半份钥")

  bridge.handle({ type: "content_key_grant", to: key.keyFp, from: granterFp, ...blob })
  assert.equal(ext.heldContentKey(key, "admin"), null, "缺交付方 box 公钥无法解包")

  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.ok(!onDisk.contentKeys || !onDisk.contentKeys.admin, "失败路径不许落盘")
})

test("storeAckInKeyFile：读-改-写防覆盖（并发写入的其他字段与既有账号条目保留）", () => {
  const mine = makeKeyData()
  const { file, key } = loadOk(mine.data, "merge.key.json")
  key.contentKeys.other = Buffer.alloc(32, 7).toString("base64")
  // 模拟 attach 在桥加载之后改过文件（新增字段 + 另一账号的 ACK）
  const cur = JSON.parse(fs.readFileSync(file, "utf8"))
  cur.createdAt = 1700000099999
  cur.contentKeys = { other: Buffer.alloc(32, 7).toString("base64") }
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n")
  const ack = crypto.randomBytes(32)
  assert.equal(ext.storeAckInKeyFile(key, "admin", ack), true)
  const afterDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(afterDisk.createdAt, 1700000099999, "不得覆盖加载后被改写的字段")
  assert.equal(afterDisk.contentKeys.other, Buffer.alloc(32, 7).toString("base64"))
  assert.equal(afterDisk.contentKeys.admin, ack.toString("base64"))
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600, "钥文件落盘必须 0600")
})

test("钥文件自带 ACK：加载即持有，auth_result(key) 不发请求", () => {
  const mine = makeKeyData()
  const ack = crypto.randomBytes(32)
  const data = { ...mine.data, contentKeys: { admin: ack.toString("base64") } }
  const { key } = loadOk(data, "preloaded.key.json")
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack)
  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key
  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key", ackFp: ext.contentKeyFingerprint(ack) })
  assert.equal(sent.filter((f) => f.type === "content_key_request").length, 0)
})

/* ---------- 5) Phase 2: this bridge as grant deliverer + ackFp reconciliation ----------
 * The bridge now ANSWERS content_key_request when it holds the ACK (deliverer
 * side of the section 3.2 wrap contract) and reacts to key_mismatch warnings.
 * The recipient-side unwrap below is written from raw node:crypto only, so the
 * deliverer implementation is checked against an independent implementation. */

/** Test-side independent unwrap (raw node:crypto): recipient side of the wrap contract. */
function unwrapAckRaw({ recipientBoxPriv, granterBoxPubB64, accountId, granterFp, recipientFp, blob }) {
  const pub = crypto.createPublicKey({ key: Buffer.from(granterBoxPubB64, "base64"), format: "der", type: "spki" })
  const shared = crypto.diffieHellman({ privateKey: recipientBoxPriv, publicKey: pub })
  const salt = Buffer.from(`${accountId}:${granterFp}:${recipientFp}`, "utf8")
  const wrapKey = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("pi-remote-ack-wrap-v1", "utf8"), 32))
  const ct = Buffer.from(blob.ct, "base64")
  const decipher = crypto.createDecipheriv("aes-256-gcm", wrapKey, Buffer.from(blob.nonce, "base64"))
  decipher.setAuthTag(ct.subarray(ct.length - 16))
  return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()])
}

function logText() {
  try { return fs.readFileSync(LOG_PATH, "utf8") } catch { return "" }
}

test("Phase 2 wrapAckGrant: deliverer wrap unwraps on the recipient side (raw crypto); bad inputs -> null", () => {
  const holder = makeKeyData("dev-holder")
  const { key } = loadOk(holder.data, "wrap.key.json")
  const requester = makeKeyData("dev-requester")
  const requesterFp = keyFingerprint(Buffer.from(requester.data.sign.pub, "base64"))
  const ack = crypto.randomBytes(32)

  const grant = ext.wrapAckGrant(key, "admin", ack, requesterFp, requester.data.box.pub)
  assert.ok(grant, "wrap should produce a grant")
  assert.equal(grant.to, requesterFp)
  assert.equal(Buffer.from(grant.nonce, "base64").length, 12)
  assert.equal(Buffer.from(grant.ct, "base64").length, 48, "ct = 32B ACK + 16B GCM tag")
  const recovered = unwrapAckRaw({
    recipientBoxPriv: requester.box.privateKey,
    granterBoxPubB64: holder.data.box.pub,
    accountId: "admin",
    granterFp: key.keyFp,
    recipientFp: requesterFp,
    blob: grant,
  })
  assert.deepEqual(recovered, ack)

  // Bad inputs are refused, never wrapped into a broken grant.
  assert.equal(ext.wrapAckGrant(key, "admin", ack, "not-a-fingerprint", requester.data.box.pub), null)
  assert.equal(ext.wrapAckGrant(key, "admin", ack, requesterFp, holder.data.sign.pub), null, "an Ed25519 SPKI is not a box public key")
  assert.equal(ext.wrapAckGrant(key, "admin", crypto.randomBytes(16), requesterFp, requester.data.box.pub), null, "ACK must be 32 bytes")
  assert.equal(ext.wrapAckGrant(key, "admin", ack, requesterFp, "%%%not-base64%%%"), null)
})

test("Phase 2 Bridge: answers a relayed content_key_request once per requester per connection; ACK change re-arms", () => {
  const holder = makeKeyData("dev-holder")
  const ack1 = crypto.randomBytes(32)
  const data = { ...holder.data, contentKeys: { admin: ack1.toString("base64") } }
  const { key } = loadOk(data, "answer.key.json")
  const requester = makeKeyData("dev-requester")
  const requesterFp = keyFingerprint(Buffer.from(requester.data.sign.pub, "base64"))
  // The relayed request shape (relay stamps from/fromBoxPub from the roster).
  const request = { type: "content_key_request", from: requesterFp, fromBoxPub: requester.data.box.pub, accountId: "admin" }

  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key
  const grants = () => sent.filter((f) => f.type === "content_key_grant")

  bridge.handle(request)
  assert.equal(grants().length, 1, "a held ACK must be delivered on request")
  assert.equal(grants()[0].to, requesterFp)
  const recovered1 = unwrapAckRaw({
    recipientBoxPriv: requester.box.privateKey,
    granterBoxPubB64: holder.data.box.pub,
    accountId: "admin",
    granterFp: key.keyFp,
    recipientFp: requesterFp,
    blob: grants()[0],
  })
  assert.deepEqual(recovered1, ack1, "the requester can independently unwrap the bridge's grant")

  bridge.handle(request)
  assert.equal(grants().length, 1, "same requester + same ACK on one connection is answered at most once")

  // The ACK changed (e.g. rotation delivered a new one): the same requester is answered again.
  const ack2 = crypto.randomBytes(32)
  assert.equal(ext.storeAckInKeyFile(key, "admin", ack2), true)
  bridge.handle(request)
  assert.equal(grants().length, 2, "a changed ACK re-arms the answer")
  const recovered2 = unwrapAckRaw({
    recipientBoxPriv: requester.box.privateKey,
    granterBoxPubB64: holder.data.box.pub,
    accountId: "admin",
    granterFp: key.keyFp,
    recipientFp: requesterFp,
    blob: grants()[1],
  })
  assert.deepEqual(recovered2, ack2)

  // A new connection session forgets the dedupe and answers again.
  bridge.socketGone()
  bridge.handle(request)
  assert.equal(grants().length, 3, "dedupe is scoped to the connection session")
})

test("Phase 2 Bridge: no ACK held -> request unanswered; other account / malformed / self requests ignored", () => {
  const requester = makeKeyData("dev-requester")
  const requesterFp = keyFingerprint(Buffer.from(requester.data.sign.pub, "base64"))
  const request = { type: "content_key_request", from: requesterFp, fromBoxPub: requester.data.box.pub, accountId: "admin" }

  // No ACK in the key file: silence on the wire, not even an error frame.
  const empty = makeKeyData("dev-empty")
  const { key: emptyKey } = loadOk(empty.data, "answer-empty.key.json")
  const b1 = new ext.Bridge()
  const sent1 = []
  b1.send = (obj) => { sent1.push(obj); return true }
  b1.deviceKey = emptyKey
  b1.handle(request)
  assert.equal(sent1.length, 0, "without the ACK the request must stay unanswered")

  // Holding the ACK does not license answering foreign or malformed requests.
  const holder = makeKeyData("dev-holder")
  const ack = crypto.randomBytes(32)
  const { key } = loadOk({ ...holder.data, contentKeys: { admin: ack.toString("base64") } }, "answer-guard.key.json")
  const b2 = new ext.Bridge()
  const sent2 = []
  b2.send = (obj) => { sent2.push(obj); return true }
  b2.deviceKey = key
  b2.handle({ ...request, accountId: "someone-else" })
  b2.handle({ type: "content_key_request", from: requesterFp, accountId: "admin" }) // no fromBoxPub
  b2.handle({ type: "content_key_request", from: "zzzzzzzzzzzzzzzz", fromBoxPub: requester.data.box.pub, accountId: "admin" }) // bad fingerprint shape
  b2.handle({ type: "content_key_request", from: key.keyFp, fromBoxPub: holder.data.box.pub, accountId: "admin" }) // self-request
  assert.equal(sent2.filter((f) => f.type === "content_key_grant").length, 0)
  assert.equal(sent2.length, 0, "ignored requests produce no frames at all")
})

test("Phase 2: a viewer-shaped grant is accepted (browser P-256 SPKI output is byte-identical in shape)", () => {
  const mine = makeKeyData()
  const { key } = loadOk(mine.data, "viewer-grant.key.json")
  // The "viewer": VIK/VBK are P-256 key pairs generated by WebCrypto in the
  // browser; its SPKI export is the same 91-byte DER the roster carries.
  const viewerSign = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const viewerBox = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const der = (k, type) => k.export({ format: "der", type }).toString("base64")
  const viewerSignPubB64 = der(viewerSign.publicKey, "spki")
  const viewerBoxPubB64 = der(viewerBox.publicKey, "spki")
  assert.equal(Buffer.from(viewerBoxPubB64, "base64").length, 91, "P-256 SPKI is 91 bytes in browser and Node output alike")
  const viewerFp = keyFingerprint(Buffer.from(viewerSignPubB64, "base64"))

  const ack = crypto.randomBytes(32)
  const blob = wrapAckFor({
    granterBoxPriv: viewerBox.privateKey,
    recipientBoxPubB64: mine.data.box.pub,
    accountId: "admin",
    granterFp: viewerFp,
    recipientFp: key.keyFp,
    ack,
  })
  // The pure unwrap path accepts it...
  assert.deepEqual(ext.unwrapAckGrant(key, "admin", blob, viewerFp, viewerBoxPubB64), ack)
  // ...and so does the full Bridge accept path, persisting the ACK.
  const bridge = new ext.Bridge()
  bridge.send = () => true
  bridge.deviceKey = key
  bridge.handle({ type: "content_key_grant", to: key.keyFp, from: viewerFp, fromBoxPub: viewerBoxPubB64, ...blob })
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack)
})

test("Phase 2: ackFp reconciliation in auth_result + key_mismatch warning reaction (log-only, keys untouched)", () => {
  const mine = makeKeyData()
  const ack = crypto.randomBytes(32)
  const { key } = loadOk({ ...mine.data, contentKeys: { admin: ack.toString("base64") } }, "ackfp.key.json")
  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key

  // Relay reports a different account ackFp than ours: the divergence is logged.
  let mark = logText().length
  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key", ackFp: "0000000000000000" })
  assert.match(logText().slice(mark), /不一致/, "a diverging auth_result.ackFp must surface as a warning")

  // Matching ackFp: no divergence warning, no key request.
  mark = logText().length
  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key", ackFp: ext.contentKeyFingerprint(ack) })
  assert.ok(!/不一致/.test(logText().slice(mark)), "a matching ackFp stays quiet")
  assert.equal(sent.filter((f) => f.type === "content_key_request").length, 0)

  // The relay's key_mismatch warning (error-code form): logged loudly, and the
  // bridge neither drops/replaces its ACK nor emits any key-changing frame.
  mark = logText().length
  bridge.handle({ type: "error", code: "key_mismatch", message: "本账号各端内容钥指纹不一致" })
  assert.match(logText().slice(mark), /key_mismatch/)
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack, "the held ACK must survive a key_mismatch warning untouched")
  assert.equal(sent.filter((f) => f.type === "content_key_grant" || f.type === "key_update").length, 0, "no automatic rotation or re-delivery")

  // Bare-frame form (defensive): same reaction.
  mark = logText().length
  bridge.handle({ type: "key_mismatch", message: "diverged" })
  assert.match(logText().slice(mark), /key_mismatch/)
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack)
})

/* ---------- 6) Phase 2 follow-up: ack_report emission ----------
 * Relay-side ackFp reconciliation (relay/acktrack.js + the ack_report case in
 * relay/local.js) is driven by ack_report{ackFp} frames from key-authed ends.
 * The bridge must report its held ACK fingerprint after key auth, report a
 * grant that arrives mid-connection, re-report when the ACK changes, and stay
 * silent on token connections and while no ACK is held. */

/** Build a relayed grant frame delivering `ack` to the bridge owning `key`. */
function grantFrameFor(key, recipientData, ack) {
  const granter = makeKeyData("dev-granter")
  const granterFp = keyFingerprint(Buffer.from(granter.data.sign.pub, "base64"))
  const blob = wrapAckFor({
    granterBoxPriv: granter.box.privateKey,
    recipientBoxPubB64: recipientData.box.pub,
    accountId: "admin",
    granterFp,
    recipientFp: key.keyFp,
    ack,
  })
  return { type: "content_key_grant", to: key.keyFp, from: granterFp, fromBoxPub: granter.data.box.pub, ...blob }
}

test("Phase 2 ack_report: key auth with ACK held reports exactly once per connection; reconnect re-reports", () => {
  const mine = makeKeyData()
  const ack = crypto.randomBytes(32)
  const { key } = loadOk({ ...mine.data, contentKeys: { admin: ack.toString("base64") } }, "report-auth.key.json")
  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key
  const reports = () => sent.filter((f) => f.type === "ack_report")

  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  assert.equal(reports().length, 1, "key auth with a held ACK must report its fingerprint")
  assert.equal(reports()[0].ackFp, ext.contentKeyFingerprint(ack))
  assert.match(reports()[0].ackFp, /^[0-9a-f]{16}$/, "ackFp must match the relay-side isAckFp shape")

  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  assert.equal(reports().length, 1, "the same fingerprint on the same connection is reported only once")

  // The relay forgets an end's report when its connection drops, so after a
  // reconnect the same fingerprint goes out again.
  bridge.socketGone()
  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  assert.equal(reports().length, 2, "a new connection reports again")
  assert.equal(reports()[1].ackFp, ext.contentKeyFingerprint(ack))
})

test("Phase 2 ack_report: a grant delivered mid-connection (auth happened ACK-less) is reported", () => {
  const mine = makeKeyData()
  const { key } = loadOk(mine.data, "report-grant.key.json")
  const ack = crypto.randomBytes(32)

  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key
  const reports = () => sent.filter((f) => f.type === "ack_report")

  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  assert.equal(reports().length, 0, "no ACK held at auth time -> nothing to report")
  assert.equal(sent.filter((f) => f.type === "content_key_request").length, 1, "the ACK request still goes out as before")

  bridge.handle(grantFrameFor(key, mine.data, ack))
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack)
  assert.equal(reports().length, 1, "the freshly granted ACK must be reported on this connection")
  assert.equal(reports()[0].ackFp, ext.contentKeyFingerprint(ack))
})

test("Phase 2 ack_report: an ACK change mid-connection re-reports with the new fingerprint", () => {
  const mine = makeKeyData()
  const ack1 = crypto.randomBytes(32)
  const { key } = loadOk({ ...mine.data, contentKeys: { admin: ack1.toString("base64") } }, "report-rotate.key.json")
  const ack2 = crypto.randomBytes(32)

  const bridge = new ext.Bridge()
  const sent = []
  bridge.send = (obj) => { sent.push(obj); return true }
  bridge.deviceKey = key
  const reports = () => sent.filter((f) => f.type === "ack_report")

  bridge.handle({ type: "auth_result", ok: true, caps: ["crypto.auth"], auth: "key" })
  assert.deepEqual(reports().map((f) => f.ackFp), [ext.contentKeyFingerprint(ack1)])

  // Rotation: a grant replaces the held ACK -> the new fingerprint is reported.
  bridge.handle(grantFrameFor(key, mine.data, ack2))
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack2)
  assert.deepEqual(reports().map((f) => f.ackFp), [ext.contentKeyFingerprint(ack1), ext.contentKeyFingerprint(ack2)])

  // The same ACK delivered again changes nothing -> no third report.
  bridge.handle(grantFrameFor(key, mine.data, ack2))
  assert.equal(reports().length, 2, "an unchanged fingerprint is not re-reported")
})

test("Phase 2 ack_report: never emitted on token-authed connections or without a device key", () => {
  const mine = makeKeyData()
  const ack = crypto.randomBytes(32)
  const { key } = loadOk({ ...mine.data, contentKeys: { admin: ack.toString("base64") } }, "report-token.key.json")

  // Device key present and ACK held, but the relay took this connection by
  // token: the ACK logic stays off and no report may go out -- neither from
  // the auth path, nor from a grant landing on this connection, nor from a
  // direct reportAckFp call.
  const b1 = new ext.Bridge()
  const sent1 = []
  b1.send = (obj) => { sent1.push(obj); return true }
  b1.deviceKey = key
  b1.handle({ type: "auth_result", ok: true, caps: [], auth: "token" })
  const ack2 = crypto.randomBytes(32)
  b1.handle(grantFrameFor(key, mine.data, ack2))
  assert.deepEqual(ext.heldContentKey(key, "admin"), ack2, "the grant itself is still accepted and held")
  b1.reportAckFp()
  assert.equal(sent1.filter((f) => f.type === "ack_report").length, 0, "token connections never report")

  // No device key at all: a direct call is a no-op.
  const b2 = new ext.Bridge()
  const sent2 = []
  b2.send = (obj) => { sent2.push(obj); return true }
  b2.reportAckFp()
  assert.equal(sent2.length, 0)
})
