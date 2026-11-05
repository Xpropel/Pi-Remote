// D-5: dialog seal-key validation + diagnostics. Before D-5, a content
// key that was not exactly 32 bytes surfaced only as one log line per
// failed message ("dialog text seal failed ... Invalid key length" --
// 438 lines over three days on one rig, unnoticed) while (b+) fail-closed
// kept sending textless frames, so the device's dialogs were cards
// without text indefinitely and nothing anywhere said why. D-5 moves the
// check to load/init time (parseDeviceKeyData records malformed entries
// as metadata), raises ONE loud persistent diagnostic (error-level log +
// diagnostics ring + a seal block in get_host_diag), and counts runtime
// seal/open failures instead of spamming per message. Fail-closed frame
// behavior is unchanged (pinned by crypto-bplus-s2).
import test from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-seal-diag-"))
const LOG_PATH = path.join(TMP, "ext.log")
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(TMP, "missing-attach.json")
process.env.PI_REMOTE_TOKEN = "seal-diag-token"
delete process.env.PI_REMOTE_ACCOUNT
delete process.env.PI_REMOTE_DEVICE_KEY_FILE
delete process.env.PI_REMOTE_RELAY

const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

function makeKeyData(deviceId = "dev-seal-diag") {
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
  const file = path.join(TMP, `sd-${++keyFileSeq}.key.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  const r = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(r.status, "ok", r.warning || "")
  return { key: r.key, file }
}

const logText = () => { try { return fs.readFileSync(LOG_PATH, "utf8") } catch { return "" } }
const countLines = (needle) => logText().split("\n").filter((l) => l.includes(needle)).length

test("D-5：加载期校验——contentKeys 非 32 字节条目记为元数据（账号/槽位/字节数），不致命、无钥值", () => {
  const data = makeKeyData()
  data.contentKeys = { admin: Buffer.alloc(16).toString("base64"), other: crypto.randomBytes(32).toString("base64") }
  data.contentKeysPrev = { admin: "!!!" }
  const { key } = loadKey(data)
  assert.equal(key.invalidContentKeys.length, 2)
  const cur = key.invalidContentKeys.find((b) => b.slot === "current")
  const prev = key.invalidContentKeys.find((b) => b.slot === "prev")
  assert.deepEqual(cur, { account: "admin", slot: "current", bytes: 16 })
  assert.equal(prev.account, "admin")
  assert.equal(prev.bytes, -1, "解不出的条目 bytes 记 -1")
  // 坏条目视同未持有（既有口径不变）；好条目照常可用。
  assert.equal(ext.heldContentKey(key, "admin"), null)
  assert.equal(ext.heldContentKey(key, "other").length, 32)
  // 诊断元数据里绝不含钥值本身。
  assert.ok(!JSON.stringify(key.invalidContentKeys).includes(data.contentKeys.admin))
})

test("D-5：合法钥文件 invalidContentKeys 为空数组", () => {
  const data = makeKeyData()
  data.contentKeys = { admin: crypto.randomBytes(32).toString("base64") }
  const { key } = loadKey(data)
  assert.deepEqual(key.invalidContentKeys, [])
})

test("D-5：start() 加载坏钥时一次性响亮报错，get_host_diag 的 seal 段持续可见", () => {
  const data = makeKeyData()
  data.contentKeys = { admin: Buffer.alloc(16).toString("base64") }
  const { file } = loadKey(data)
  const before = countLines("设备钥文件的内容钥无效")
  process.env.PI_REMOTE_DEVICE_KEY_FILE = file
  try {
    const bridge = new ext.Bridge()
    bridge.start()
    assert.match(bridge.sealKeyFault || "", /内容钥无效/, "故障状态应立在 Bridge 上")
    assert.match(bridge.sealKeyFault || "", /16 字节/)
    assert.equal(countLines("设备钥文件的内容钥无效"), before + 1, "错误级日志恰好一条")
    const diag = bridge.cmdGetHostDiag()
    assert.equal(diag.seal.dialogKey, "invalid")
    assert.deepEqual(diag.seal.invalid, [{ account: "admin", slot: "current", bytes: 16 }])
    assert.match(diag.seal.fault, /内容钥无效/)
    assert.ok(!JSON.stringify(diag.seal).includes(data.contentKeys.admin), "诊断面不带钥值")
  } finally {
    delete process.env.PI_REMOTE_DEVICE_KEY_FILE
  }
})

test("D-5：健康钥的 get_host_diag seal 段为 ok", () => {
  const data = makeKeyData()
  data.contentKeys = { admin: crypto.randomBytes(32).toString("base64") }
  const { key } = loadKey(data)
  const bridge = new ext.Bridge()
  bridge.deviceKey = key
  bridge.noteSealKeyFileFault()
  assert.equal(bridge.sealKeyFault, null)
  const diag = bridge.cmdGetHostDiag()
  assert.equal(diag.seal.dialogKey, "ok")
  assert.deepEqual(diag.seal.invalid, [])
  assert.equal(diag.seal.failures, 0)
})

/* ---------- runtime latch (scaffold mirrors crypto-bplus-s2) ---------- */

function sealBridge(roomId = "room-seal-diag") {
  const ack = crypto.randomBytes(32)
  const data = makeKeyData()
  data.contentKeys = { admin: ack.toString("base64") }
  const { key } = loadKey(data)
  const bridge = new ext.Bridge()
  const sent = []
  bridge.ws = { bufferedAmount: 0, readyState: 1, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  bridge.connected = true
  bridge.authed = true
  bridge.deviceKey = key
  bridge.relayAuth = "key"
  bridge.relayCaps = new Set(["crypto.auth", "crypto.content", "crypto.dialog"])
  bridge.roomId = roomId
  bridge.confirmedRoom = roomId
  bridge.dialogAnswerEnabled = true
  bridge.dialogGateHasViewers = true
  bridge.tapState = "ok"
  return { bridge, sent, ack, roomId }
}
const eventsOf = (sent, type) => sent.filter((f) => f.type === "event" && f.event && f.event.type === type)

test("D-5：运行时密封失败只响亮报一次、其余只计数；恢复后故障清除并留一条恢复日志", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const goodRck = entry.rck
  entry.rck = Buffer.alloc(3)
  bridge.accountAck = () => Buffer.alloc(3)
  const loudBefore = countLines("错误：对话文本密封失败")
  try {
    const p = bridge.beginDialog("select", ["Q1", ["a", "b"], {}], () => {})
    bridge.emitEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "T1" })
    bridge.noteUiObserve("notify", ["N1", "warning"])
    const ev = eventsOf(sent, "dialog_open")[0].event
    bridge.noteDialogAnswer({ aid: "d5-0", dialogId: ev.dialogId, action: "deny" })
    await p
    assert.ok(bridge.sealFailures >= 3, `多次失败应累计计数（实际 ${bridge.sealFailures}）`)
    assert.equal(bridge.sealLastError, "Invalid key length")
    assert.match(bridge.sealKeyFault || "", /密封失败/)
    assert.equal(countLines("错误：对话文本密封失败"), loudBefore + 1, "同一故障期只响亮报一次，不逐条刷屏")
    assert.equal(countLines("dialog text seal failed; sending a textless frame"), 0, "旧的逐条英文刷屏行不再产生")
    const diag = bridge.cmdGetHostDiag()
    assert.equal(diag.seal.dialogKey, "ok", "钥文件本身合法——这是运行时故障，不是文件故障")
    assert.ok(diag.seal.failures >= 3)
    assert.equal(diag.seal.lastError, "Invalid key length")
  } finally {
    entry.rck = goodRck
    delete bridge.accountAck
  }
  const recoveredBefore = countLines("对话文本密封已恢复正常")
  const p2 = bridge.beginDialog("input", ["Q2", ""], () => {})
  const ev2 = eventsOf(sent, "dialog_open").at(-1).event
  assert.ok(ev2.textEnc, "恢复后密封照常工作")
  assert.equal(bridge.sealKeyFault, null, "运行时故障在恢复后清除")
  assert.equal(countLines("对话文本密封已恢复正常"), recoveredBefore + 1, "恢复留一条日志")
  bridge.noteDialogAnswer({ aid: "d5-1", dialogId: ev2.dialogId, action: "submit", value: "ok" })
  assert.equal(await p2, "ok")
})

test("D-5：密封应答解不开时计入 seal 失败面（拒绝口径不变：bad_args、对话框仍可答）", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const p = bridge.beginDialog("input", ["Say", ""], () => {})
  const id = eventsOf(sent, "dialog_open")[0].event.dialogId
  const before = bridge.sealFailures
  // 用另一把 RCK 封的应答：本房钥解不开（等同钥不对/已轮换的现场形态）。
  const foreign = ext.encryptTextCt(crypto.randomBytes(32), "nope")
  bridge.noteDialogAnswer({ aid: "d5-2", dialogId: id, action: "submit", valueEnc: { enc: 1, ct: foreign } })
  assert.equal(bridge.sealFailures, before + 1, "解不开的密封应答应计入失败面")
  const results = sent.filter((f) => f.type === "dialog_answer_result")
  assert.equal(results.at(-1).ok, false)
  assert.equal(results.at(-1).code, "bad_args")
  // 对话框仍可答：再用本房钥正确应答应成功。
  bridge.noteDialogAnswer({ aid: "d5-3", dialogId: id, action: "submit", valueEnc: { enc: 1, ct: ext.encryptTextCt(entry.rck, "yes") } })
  assert.equal(await p, "yes")
})
