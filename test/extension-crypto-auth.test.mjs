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
