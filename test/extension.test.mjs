// 扩展里不依赖 pi 运行时的纯函数：指纹、镜像映射、事件投影、图片/大帧降级。
// 扩展是 TS + CommonJS require 混写，用 jiti 加载（pi 自己也是这么加载扩展的）。
import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createJiti } from "jiti"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const store = require("../relay/store.js")
// 日志进系统临时目录（Windows 上 "/tmp" 会落到当前盘根目录 D:\tmp），跑完删掉
const LOG_PATH = path.join(os.tmpdir(), `pi-remote-extension-test-${process.pid}.log`)
process.env.PI_REMOTE_LOG = LOG_PATH
// 窗口状态文件指向一个不存在的临时路径：不读用户真实的 ~/.pi/agent/remote-attach.json
process.env.PI_REMOTE_ATTACH_FILE = path.join(os.tmpdir(), `pi-remote-attach-test-${process.pid}-missing.json`)
after(() => {
  for (const f of [LOG_PATH, LOG_PATH + ".old"]) fs.rmSync(f, { force: true })
})
process.env.PI_REMOTE_TOKEN = ""
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

const bigPng = "A".repeat(300 * 1024)

test("hashOf 与 relay/store 逐字一致（append 对齐的前提）", () => {
  const samples = [
    { role: "user", content: [{ type: "text", text: "你好" }], timestamp: 1700000000000 },
    { role: "user", content: "纯字符串内容", timestamp: 5 },
    { role: "assistant", content: [{ type: "text", text: "a" }, { type: "toolCall", id: "t", name: "bash", arguments: {} }], timestamp: 7 },
    { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "out" }], timestamp: 8 },
    { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0, timestamp: 9 },
    { role: "custom", customType: "remote-bash", content: [{ type: "text", text: "x" }], timestamp: 10 },
    { role: "compactionSummary", summary: "摘要", timestamp: 11 },
    { role: "branchSummary", summary: "分支", timestamp: 12 },
    { role: "user", content: [{ type: "text", text: "长".repeat(5000) }], timestamp: 13 },
  ]
  for (const m of samples) assert.equal(ext.hashOf(m), store.hashOf(m), JSON.stringify(m).slice(0, 80))
})

test("mirrorMessages：完整分支路径（含 custom/摘要/压缩），排除 system", () => {
  const out = ext.mirrorMessages([
    { type: "message", message: { role: "user", content: "q" } },
    { type: "message", message: { role: "system", content: "s" } },
    { type: "custom_message", customType: "remote-bash", content: [{ type: "text", text: "o" }], display: true, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "branch_summary", summary: "b", fromId: "x", timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "compaction", summary: "c", tokensBefore: 100, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "model_change", provider: "p" },
  ])
  assert.deepEqual(out.map((m) => m.role), ["user", "custom", "branchSummary", "compactionSummary"])
})

test("projectEvent：turn_end 不带 O(会话) 的上下文，消息里的大图换成结构化占位且不改原对象", () => {
  const image = { type: "image", mimeType: "image/png", data: bigPng }
  const message = { role: "assistant", content: [{ type: "text", text: "hi" }] }
  const event = {
    type: "turn_end",
    message,
    toolResults: [{ role: "toolResult", content: [image] }],
    context: { contextEntries: new Array(2000).fill({ a: "x".repeat(50) }), contextMessages: [] },
  }
  const projected = ext.projectEvent(event)
  const size = JSON.stringify(projected).length
  assert.ok(size < 4096, `投影后 ${size} 字节`)
  const shrunk = projected.toolResults[0].content[0]
  assert.equal(shrunk.omitted, true)
  assert.equal(shrunk.data, "")
  assert.equal(shrunk.omittedBytes, Math.floor((bigPng.length * 3) / 4))
  assert.equal(image.data, bigPng, "原对象（会话条目的活引用）不能被改写")
})

test("projectEvent：tool_execution_end 从 result.structuredContent 抄 exit_code/wall_time_seconds，不改原事件", () => {
  const event = {
    type: "tool_execution_end",
    toolCallId: "t-1",
    toolName: "bash",
    isError: true,
    result: {
      content: [{ type: "text", text: "oops\n\nCommand exited with code 2" }],
      details: {},
      structuredContent: { output: "oops", truncated: false, exit_code: 2, wall_time_seconds: 1.5 },
    },
  }
  const out = ext.projectEvent(event)
  assert.equal(out.exit_code, 2)
  assert.equal(out.wall_time_seconds, 1.5)
  assert.equal(out.termStatus, undefined, "普通失败不写 termStatus")
  assert.equal(event.exit_code, undefined, "原事件（会话条目活引用）不能被加字段")
  assert.equal(event.wall_time_seconds, undefined)
  // 事件顶层也带 structuredContent 的形态同样认（不依赖具体载荷层数）
  const top = ext.projectEvent({
    type: "tool_execution_end",
    toolCallId: "t-2",
    toolName: "bash",
    isError: false,
    structuredContent: { exit_code: 0, wall_time_seconds: 0.2 },
  })
  assert.equal(top.exit_code, 0)
  assert.equal(top.wall_time_seconds, 0.2)
  assert.equal(top.termStatus, undefined)
})

test("projectEvent：end 文本末尾命中超时/abort 后缀才写 termStatus，非结尾与普通输出不写", () => {
  const end = (text, extra = {}) =>
    ext.projectEvent({
      type: "tool_execution_end",
      toolCallId: "t-1",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text }], details: {} },
      ...extra,
    })
  assert.equal(end("out\n\nCommand timed out after 30 seconds").termStatus, "timeout")
  assert.equal(end("out\n\nCommand timed out after 1.5 seconds\n").termStatus, "timeout")
  assert.equal(end("out\n\nCommand aborted").termStatus, "aborted")
  assert.equal(end("out\n\nCommand aborted\n").termStatus, "aborted")
  assert.equal(end("Command aborted\nmore output").termStatus, undefined, "只认文本末尾")
  assert.equal(end("done").termStatus, undefined)
  assert.equal(end("", { isError: false }).termStatus, undefined, "没有后缀就不伪造")
  assert.equal(end("Command aborted", { isError: false }).termStatus, undefined, "成功输出带同样文本也不能误判成取消")
  // 非有限的结构化字段不抄
  const bad = ext.projectEvent({
    type: "tool_execution_end",
    toolCallId: "t-3",
    toolName: "bash",
    isError: true,
    result: { structuredContent: { exit_code: "2", wall_time_seconds: NaN } },
  })
  assert.equal("exit_code" in bad, false)
  assert.equal("wall_time_seconds" in bad, false)
})

test("Bridge：实时 message_end 的 omit 图片在持久化后补真实 entryId/blockIndex，后续事件仍排在其后", async () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  const branch = []
  b.ctx = { sessionManager: { getBranch: () => branch } }
  const original = "A".repeat(300 * 1024)
  const message = {
    role: "user",
    content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: original }],
    timestamp: 1,
  }
  b.forward({ type: "message_end", message })
  b.forward({ type: "turn_end", message: { role: "assistant", content: [] } })
  assert.equal(sent.filter((f) => f.type === "event").length, 0, "持久化前不抢发带不上地址的帧，后续事件一起排队")

  // pi 的 appendMessage 存的是同一个 message 对象；回读 branch 才能拿到真实条目 id。
  branch.push({ id: "e9", type: "message", parentId: null, message })
  await new Promise((resolve) => setImmediate(resolve))
  const events = sent.filter((f) => f.type === "event").map((f) => f.event)
  assert.deepEqual(events.map((e) => e.type), ["message_end", "turn_end"], "顺序不变")
  const block = events[0].message.content[1]
  assert.equal(block.entryId, "e9")
  assert.equal(block.blockIndex, 1, "blockIndex 是条目原始 content 下标，不是投影后数组里数出来的")
  assert.equal(block.data, "", "投影占位仍不携带原图数据")
  assert.equal(block.omitted, true)
  assert.equal(message.content[1].entryId, undefined, "不能改写 pi 的活消息对象")
  assert.equal(message.content[1].data, original)
})

test("Bridge：实时 message_end 找不到持久化条目时不猜地址，仍按原顺序原样发出", async () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  b.ctx = {
    sessionManager: {
      getBranch: () => [{ id: "other", type: "message", message: { role: "user", content: "别的", timestamp: 2 } }],
    },
  }
  const message = { role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(300 * 1024) }], timestamp: 1 }
  b.forward({ type: "message_end", message })
  b.forward({ type: "turn_end", message: { role: "assistant", content: [] } })
  await new Promise((resolve) => setTimeout(resolve, 150))
  const events = sent.filter((f) => f.type === "event").map((f) => f.event)
  assert.deepEqual(events.map((e) => e.type), ["message_end", "turn_end"])
  assert.equal(events[0].message.content[0].entryId, undefined, "定位不到就绝不猜")
  assert.equal(events[0].message.content[0].blockIndex, undefined)
  assert.equal(events[0].message.content[0].data, "", "省略的数据仍保持占位")
})

test("Bridge：没有 sessionManager 时 message_end 同步转发，不引入等待窗", () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  const message = { role: "user", content: [{ type: "image", mimeType: "image/png", data: "A".repeat(300 * 1024) }], timestamp: 1 }
  b.forward({ type: "message_end", message })
  const events = sent.filter((f) => f.type === "event").map((f) => f.event)
  assert.deepEqual(events.map((e) => e.type), ["message_end"])
  assert.equal(events[0].message.content[0].entryId, undefined)
})

test("oversizeFallback：end 帧降级仍保留 exit_code/wall_time_seconds/termStatus", () => {
  const out = ext.oversizeFallback(
    { type: "event", room: "r", event: { type: "tool_execution_end", toolCallId: "t-1", toolName: "bash", isError: true, exit_code: 124, wall_time_seconds: 30, termStatus: "timeout" } },
    20 * 1048576,
  )
  assert.equal(out.event.omitted, true)
  assert.equal(out.event.exit_code, 124)
  assert.equal(out.event.wall_time_seconds, 30)
  assert.equal(out.event.termStatus, "timeout")
})

test("Bridge：tool_execution_end 转发帧带终端胶囊字段，且随事件发出", () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  b.forward({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    isError: true,
    result: {
      content: [{ type: "text", text: "partial\n\nCommand timed out after 30 seconds" }],
      details: {},
      structuredContent: { exit_code: 124, wall_time_seconds: 30 },
    },
  })
  const end = sent.find((m) => m.type === "event" && m.event.type === "tool_execution_end")
  assert.ok(end)
  assert.equal(end.event.isError, true)
  assert.equal(end.event.exit_code, 124)
  assert.equal(end.event.wall_time_seconds, 30)
  assert.equal(end.event.termStatus, "timeout")
  assert.equal(typeof end.event.result, "object", "原有 result 字段不动")
})

test("shrinkDeep：小图原样保留并返回原引用", () => {
  const small = { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] }
  assert.equal(ext.shrinkDeep(small), small)
})

test("mergeableDelta：只合并纯 delta 帧", () => {
  assert.equal(ext.mergeableDelta({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a" } }), true)
  assert.equal(ext.mergeableDelta({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "a", partial: {} } }), false)
  assert.equal(ext.mergeableDelta({ type: "message_update", assistantMessageEvent: { type: "toolcall_end" } }), false)
})

test("oversizeFallback：命令结果改报错、消息截断长字符串（头部保留 ⇒ 指纹不变）、其余事件只留类型", () => {
  const cmd = ext.oversizeFallback({ type: "command_result", room: "r", id: "w1", ok: true, data: {} }, 20 * 1048576)
  assert.equal(cmd.ok, false)
  assert.match(cmd.error, /结果过大/)

  const longText = "x".repeat(600 * 1024)
  const message = { role: "toolResult", content: [{ type: "text", text: longText }], timestamp: 1 }
  const ev = ext.oversizeFallback({ type: "event", room: "r", event: { type: "message_end", message } }, 20 * 1048576)
  assert.equal(ev.event.message.truncated, true)
  assert.ok(ev.event.message.content[0].text.length < 300 * 1024)
  assert.equal(ext.hashOf(ev.event.message), ext.hashOf(message))

  const other = ext.oversizeFallback({ type: "event", room: "r", event: { type: "tool_execution_update", partialResult: longText } }, 20 * 1048576)
  assert.deepEqual(other.event, { type: "tool_execution_update", omitted: true, bytes: 20 * 1048576 })
})

test("deliveryKey：空白归一、截前 500 字", () => {
  assert.equal(ext.deliveryKey("  a \n\t b  "), "a b")
  assert.equal(ext.deliveryKey("y".repeat(800)).length, 500)
})

test("deliveryMatches：相等或 pi 追加的 [Image 提示才算同一条，短消息不能当更长消息的前缀", () => {
  const hint = ext.deliveryKey("ok\n\n[Image: original 100x100, displayed at 50x50. Multiply coordinates by 2.00 to map to original image.]")
  assert.equal(ext.deliveryMatches("ok", hint), true)
  assert.equal(ext.deliveryMatches("ok", ext.deliveryKey("ok")), true)
  assert.equal(ext.deliveryMatches("ok", ext.deliveryKey("ok, 我来处理")), false)
  assert.equal(ext.deliveryMatches("ok", ext.deliveryKey("ok sure")), false)
})

test("alignTail：同首尾的另一段不能当成已同步，tailHashes 对上才认", () => {
  const b = new ext.Bridge()
  const custom = (text) => ({ role: "custom", customType: "remote-bash", content: text, timestamp: 1 })
  const user = (text, ts) => ({ role: "user", content: text, timestamp: ts })
  const L = [custom("Ran `ls`"), user("middle-A", 2), custom("Ran `ls`"), user("middle-B", 4), custom("Ran `ls`")]
  const info = {
    msgCount: 3,
    firstHash: ext.hashOf(L[2]),
    lastHash: ext.hashOf(L[4]),
    tailHashes: [ext.hashOf(L[2]), ext.hashOf(L[3]), ext.hashOf(L[4])],
  }
  assert.equal(b.alignTail(L, { ...info, tailHashes: undefined }), 2, "只看首尾会命中前面那段同内容 custom")
  assert.equal(b.alignTail(L, info), 4)
})

test("超过 50 条未确认送达时最早一条记失败；会话关闭也记失败", () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  for (let i = 0; i < 51; i++) b.watchDelivery("m" + i)
  assert.equal(b.pendingDeliveries.length, 50)
  assert.equal(b.pendingDeliveries[0].text, "m1")
  const failed = sent.filter((m) => m.type === "event" && m.event && m.event.type === "remote_message_failed")
  assert.ok(failed.some((m) => m.event.text === "m0"))
  b.watchDelivery("bye")
  b.stop()
  const closed = sent.filter((m) => m.type === "event" && m.event && m.event.type === "remote_message_failed" && m.event.text === "bye")
  assert.equal(closed.length, 1)
  assert.equal(b.pendingDeliveries.length, 0)
})

test("送达确认不误伤；换会话时未送达的记失败；排队命令在切走后不再执行", async () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) } }
  b.ctx = { sessionManager: { getEntries() { return [] }, getBranch() { return [] } } }

  b.watchDelivery("ok")
  b.trackDelivery({ type: "message_end", message: { role: "user", content: "ok, 我来处理" } })
  assert.equal(b.pendingDeliveries.length, 1)
  b.trackDelivery({ type: "message_end", message: { role: "user", content: "ok\n\n[Image: original 100x100, displayed at 50x50.]" } })
  assert.equal(b.pendingDeliveries.length, 0)

  b.watchDelivery("still pending")
  b.bindSession({ sessionManager: { sessionId: "B", getSessionName() { return null }, getBranch() { return [] }, getEntries() { return [] } }, cwd: "/tmp" })
  if (b.syncTimer) { clearTimeout(b.syncTimer); b.syncTimer = null }
  const failed = sent.filter((m) => m.type === "event" && m.event && m.event.type === "remote_message_failed")
  assert.ok(failed.some((m) => m.event.text === "still pending"))
  assert.equal(b.pendingDeliveries.length, 0)

  b.roomId = "A"
  let release
  const gate = new Promise((r) => { release = r })
  const calls = []
  b.executeCommand = async (command) => {
    calls.push({ command, room: b.roomId })
    if (command === "slow") await gate
    return { ok: true }
  }
  b.runCommand({ id: "1", room: "A", command: "slow", args: {}, timeoutMs: 30000 })
  await new Promise((r) => setImmediate(r))
  b.runCommand({ id: "2", room: "A", command: "set_session_name", args: { name: "x" }, timeoutMs: 30000 })
  b.roomId = "B"
  release()
  const deadline = Date.now() + 1000
  while (!sent.some((m) => m.type === "command_result" && m.id === "2") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.deepEqual(calls.map((c) => c.command), ["slow"])
  const r2 = sent.find((m) => m.type === "command_result" && m.id === "2")
  assert.equal(r2.ok, false)
  assert.match(r2.error, /已切换/)
})

/* ---- 第二轮审查修复的回归用例 ---- */

test("redactDeep：privateKey / jwt / sessionKey / authToken 一样打码，计数类不受影响", () => {
  const out = ext.redactDeep({
    privateKey: "-----BEGIN",
    jwt: "eyJhbGci",
    sessionKey: "sk-1",
    authToken: "at-1",
    refreshToken: "rt-1",
    author: "张三",
    maxTokens: 100,
  })
  assert.equal(out.privateKey, "***")
  assert.equal(out.jwt, "***")
  assert.equal(out.sessionKey, "***")
  assert.equal(out.authToken, "***")
  assert.equal(out.refreshToken, "***")
  assert.equal(out.author, "张三", "author 不该被 auth 误伤")
  assert.equal(out.maxTokens, 100)
})

test("oversizeFallback：超大事件降级时保留 toolCallId，UI 工具卡不会永远转圈", () => {
  const ev = { type: "event", room: "r", event: { type: "tool_execution_end", toolCallId: "t-1", toolName: "bash", isError: false, args: { x: "y".repeat(100) } } }
  const out = ext.oversizeFallback(ev, 20 * 1024 * 1024)
  assert.equal(out.event.omitted, true)
  assert.equal(out.event.toolCallId, "t-1")
  assert.equal(out.event.toolName, "bash")
  assert.equal(out.event.isError, false)
})

test("oversizeFallback：超大命令结果仍然明确报错，不静默丢", () => {
  const out = ext.oversizeFallback({ type: "command_result", room: "r", id: "c1", ok: true, data: { big: 1 } }, 20 * 1024 * 1024)
  assert.equal(out.ok, false)
  assert.equal(out.id, "c1")
  assert.equal(out.code, "payload_too_large", "err.v4：降级失败回包必须带协议码")
  assert.ok(out.code in ext.PROTOCOL.errors)
  assert.match(out.error, /结果过大/)
})

test("命令结果序列化失败（循环引用）也带 code=internal", () => {
  const b = new ext.Bridge()
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  const loop = { type: "command_result", room: "r", id: "c-loop", ok: true }
  loop.self = loop
  assert.equal(b.send(loop), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].ok, false)
  assert.equal(sent[0].id, "c-loop")
  assert.equal(sent[0].code, "internal")
})

test("背压：关键帧超过硬上限不再硬塞，断开并按退避重连；软上限内关键帧照发", () => {
  const b = new ext.Bridge()
  b.roomId = "r"
  b.connected = true
  b.gateOpen = () => true
  const sent = []
  let closed = 0
  b.ws = { bufferedAmount: 5 * 1024 * 1024, send(s) { sent.push(JSON.parse(s)) }, close() { closed += 1 } }
  try {
    assert.equal(b.send({ type: "state", room: "r", busy: false }, { essential: true }), true, "5MB 积压仍在硬上限内")
    assert.equal(sent.length, 1, "关键帧不能因为软上限被丢")
    assert.equal(b.send({ type: "event", room: "r", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } } }), false, "可丢帧仍按 4MB 软上限丢")
    assert.equal(sent.length, 1)

    b.ws.bufferedAmount = ext.Bridge.SEND_BACKLOG_MAX_BYTES + 1
    assert.equal(b.send({ type: "state", room: "r", busy: true }, { essential: true }), false, "超过硬上限不再硬发")
    assert.equal(sent.length, 1)
    assert.equal(closed, 1, "旧连接关掉")
    assert.equal(b.ws, null)
    assert.ok(b.reconnectTimer, "按退避重连；重新认证后再从 1s 开始")
  } finally {
    if (b.reconnectTimer) { clearTimeout(b.reconnectTimer); b.reconnectTimer = null }
    b.closing = true
  }
})

test("流式草稿：text/thinking delta 单条与合并都按字符上限截断并计数", () => {
  const b = new ext.Bridge()
  b.roomId = "r"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  const cap = ext.STREAM_DELTA_MAX_CHARS
  assert.ok(cap > 0 && cap <= 1024 * 1024, "上限要有界且不过分小")

  // 单条超大 text delta
  b.emitEvent({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(cap + 100) } })
  b.flushPending()
  assert.equal(sent.at(-1).event.assistantMessageEvent.delta.length, cap)
  assert.equal(b.streamTruncatedChars, 100)

  // 多条合并：只保留剩余额度，超出部分丢弃并计数
  sent.length = 0
  b.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(cap - 5) } })
  b.emitEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "z".repeat(50) } })
  b.flushPending()
  assert.equal(sent.at(-1).event.assistantMessageEvent.delta.length, cap)
  assert.equal(b.streamTruncatedChars, 145)

  // thinking delta 同样受限
  sent.length = 0
  b.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "t".repeat(cap + 7) } })
  b.flushPending()
  assert.equal(sent.at(-1).event.assistantMessageEvent.delta.length, cap)
  assert.equal(b.streamTruncatedChars, 152)
})

test("连接窗口提示：缺 attach 文件 / 缺 deviceId / 设备不符都有醒目文案，过期不刷屏", () => {
  const file = path.join(os.tmpdir(), "pi-remote-attach-hint.json")
  const missing = ext.attachGateHint({ reason: "missing" }, {}, file)
  assert.match(missing, /警告/)
  assert.match(missing, /连接窗口文件不存在/)
  assert.match(missing, /PI_REMOTE_DEVICE_ID/)
  assert.match(missing, /PI_REMOTE_ALWAYS_ONLINE/)
  const noDevice = ext.attachGateHint({ reason: "device" }, {}, file)
  assert.match(noDevice, /缺少 PI_REMOTE_DEVICE_ID/)
  const mismatch = ext.attachGateHint({ reason: "device" }, { PI_REMOTE_DEVICE_ID: "dev-1" }, file)
  assert.match(mismatch, /dev-1/)
  assert.match(mismatch, /不一致/)
  assert.equal(ext.attachGateHint({ reason: "expired" }, {}, file), null)

  // 真实入口要把提示写进日志（窗口文件的路径由测试环境固定为不存在）
  const b = new ext.Bridge()
  b.gateOpen = () => false
  b.evaluateGate("test")
  assert.match(fs.readFileSync(LOG_PATH, "utf8"), /警告：连接窗口文件不存在/)
})

test("公网 ws:// 警告：回环/加密地址不警告，非回环明文地址警告但不拒绝连接", () => {
  for (const url of ["ws://127.0.0.1:7001", "ws://127.8.9.10:7001", "ws://localhost:7001", "ws://[::1]:7001", "wss://relay.example.com"]) {
    assert.equal(ext.insecureRelayWarning(url), null, url)
  }
  for (const url of ["ws://relay.example.com:7001", "ws://192.168.1.10:7001"]) {
    const warn = ext.insecureRelayWarning(url)
    assert.match(warn, /警告/)
    assert.match(warn, /wss:\/\//)
    assert.match(warn, /明文/)
  }
  assert.equal(ext.insecureRelayWarning("not a url"), null)
})

test("list_sessions 的 only 走路径监狱：../ 越界返回空，不读会话目录以外的文件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-only-"))
  const inside = path.join(dir, "2026-01-01T00-00-00-000Z_s1.jsonl")
  fs.writeFileSync(inside, '{"type":"session","id":"s1"}\n', "utf8")
  const outside = path.join(os.tmpdir(), "pi-only-secret.jsonl")
  fs.writeFileSync(outside, "SECRET-SHOULD-NOT-BE-READ", "utf8")
  const b = new ext.Bridge()
  b.ctx = { sessionManager: { getSessionDir: () => dir, sessionFile: inside, getBranch: () => [], getEntries: () => [] } }
  b.ws = { bufferedAmount: 0, send() {} }
  // 只认 fs 回退路径：把官方 SessionManager 之路关掉（测试里没有真 pi 包）
  const ok = await b.executeCommand("list_sessions", { only: "2026-01-01T00-00-00-000Z_s1.jsonl" })
  assert.equal(ok.sessions.length, 1)
  const escaped = await b.executeCommand("list_sessions", { only: "../pi-only-secret.jsonl" })
  assert.deepEqual(escaped.sessions, [], "越界必须返回空，而不是把文件内容读回来")
  const abs = await b.executeCommand("list_sessions", { only: outside })
  assert.deepEqual(abs.sessions, [], "绝对路径越界同样返回空")
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(outside, { force: true })
})

test("认证失败：任何重连入口（onclose / 5 秒窗口轮询 / scheduleReconnect / connect）都不再建连", () => {
  // 用假 WebSocket 计数：原来的用例只调 scheduleReconnect，且 gateOpen 在测试里本来就是 false，
  // 所以 bug（evaluateGate 每 5 秒直接 connect）照样通过。这里让窗口"开着"，逐个入口验证。
  const RealWS = globalThis.WebSocket
  let opened = 0
  globalThis.WebSocket = class {
    constructor() { opened += 1 }
    send() {}
    close() {}
  }
  try {
    const b = new ext.Bridge()
    b.gateOpen = () => true
    b.started = true
    b.ws = { bufferedAmount: 0, send() {}, close() {} }
    b.connected = true
    b.authed = true
    b.handle({ type: "auth_result", ok: false, error: "token 不正确" })
    assert.equal(b.authed, false)
    assert.equal(b.authFailed, true)
    // relay 随后关掉连接：模拟 onclose 之后的状态
    b.ws = null
    b.connected = false
    b.evaluateGate("expiry")
    b.evaluateGate("watch")
    b.scheduleReconnect()
    b.connect()
    assert.equal(opened, 0, "鉴权失败后不能再建连")
    assert.equal(b.reconnectTimer, null, "鉴权失败后不能排重连")
    // 对照：没有鉴权失败时，同一个 evaluateGate 入口会建连（证明上面的断言能抓住 bug）
    const c = new ext.Bridge()
    c.gateOpen = () => true
    c.started = true
    c.evaluateGate("expiry")
    assert.equal(opened, 1, "正常情况下窗口开着就要连")
    c.closing = true
    c.ws = null
    c.clearTimers()
  } finally {
    globalThis.WebSocket = RealWS
  }
})

test("日志轮转：超过 5MB 时转成 .old，且同一进程内可以多次轮转", () => {
  for (let round = 0; round < 2; round++) {
    fs.writeFileSync(ext.LOG_FILE, Buffer.alloc(ext.LOG_ROTATE_BYTES + 1, 0x61))
    fs.rmSync(ext.LOG_FILE + ".old", { force: true })
    for (let i = 0; i < ext.LOG_CHECK_EVERY; i++) ext.log("rotation-test", i)
    assert.ok(fs.existsSync(ext.LOG_FILE + ".old"), `第 ${round + 1} 次超限应轮转出 .old`)
    assert.ok(fs.statSync(ext.LOG_FILE).size < ext.LOG_ROTATE_BYTES, "轮转后当前日志从小文件重新开始")
  }
})

test("attach 状态文件：窗口进程已不存在（被强杀）时按关闭处理；没有 pid 的旧文件保持原行为", () => {
  const env = { PI_REMOTE_DEVICE_ID: "dev-1" }
  const now = Date.now()
  const state = (pid) => JSON.stringify({ deviceId: "dev-1", expiresAt: now + 60000, ...(pid == null ? {} : { pid }) })
  assert.equal(ext.evaluateAttachWindow(state(process.pid), env, now).ok, true, "活着的窗口进程放行")
  assert.equal(ext.evaluateAttachWindow(state(4242), env, now, () => false).reason, "dead", "进程不在了要关闭")
  assert.equal(ext.evaluateAttachWindow(state(null), env, now).ok, true, "旧文件没有 pid 不受影响")
  assert.equal(ext.pidAlive(process.pid), true)
  assert.equal(ext.pidAlive(0), false)
})

test("送达观察：同步注入失败只移除本次登记的那一条，同文本的另一条照常等待", () => {
  const b = new ext.Bridge()
  b.ws = { bufferedAmount: 0, send() {}, close() {} }
  b.cannotPrompt = () => null
  b.notifyRemote = () => {}
  b.echoRemote = () => {}
  let calls = 0
  b.pi = { sendUserMessage() { calls += 1; if (calls === 2) throw new Error("boom") } }
  b.deliverText("同一句话", "steer")
  const first = b.pendingDeliveries[0]
  assert.throws(() => b.deliverText("同一句话", "steer"), /boom/)
  assert.equal(b.pendingDeliveries.length, 1, "失败的那条被移除")
  assert.equal(b.pendingDeliveries[0], first, "留下的必须是第一次登记的那条")
  for (const p of b.pendingDeliveries.splice(0)) clearTimeout(p.timer)
})

test("旧 relay 不认 room_label：退回 room_register，之后改名直接走 room_register", () => {
  const b = new ext.Bridge()
  const sent = []
  b.send = (frame) => sent.push(frame)
  b.roomId = "r1"
  b.roomPayload = () => ({ id: "r1", label: "新名字" })
  b.handle({ type: "error", code: "unknown_type", message: "未知消息类型：room_label" })
  assert.equal(b.noRoomLabel, true)
  assert.equal(sent.at(-1).type, "room_register")
})

test("taskListFromDetails：todo 工具 details 归一化（text/done → content/status，空数组=清空）", () => {
  assert.deepEqual(
    ext.taskListFromDetails({
      action: "list",
      todos: [
        { id: 1, text: "改后端", done: false },
        { id: 2, text: "跑测试", done: true, activeForm: "跑测试中" },
      ],
      nextId: 3,
    }),
    [
      { id: "1", content: "改后端", status: "pending" },
      { id: "2", content: "跑测试", status: "completed", activeForm: "跑测试中" },
    ],
  )
  // Claude 风格 tasks：content/status/activeForm 原样保留，未知状态按 pending，缺 id 用序号
  assert.deepEqual(
    ext.taskListFromDetails({
      tasks: [
        { id: "t1", content: "A", status: "in_progress", activeForm: "Doing A" },
        { id: "t2", content: "B", status: "completed" },
        { content: "C" },
      ],
    }),
    [
      { id: "t1", content: "A", status: "in_progress", activeForm: "Doing A" },
      { id: "t2", content: "B", status: "completed" },
      { id: "3", content: "C", status: "pending" },
    ],
  )
  assert.deepEqual(ext.taskListFromDetails({ todos: [] }), [])
  assert.equal(ext.taskListFromDetails({ todos: "bad" }), null)
  assert.equal(ext.taskListFromDetails({ todos: [{}] }), null, "非空但一条都认不出时不发半截/清空")
  assert.equal(ext.taskListFromDetails(null), null)
})

test("taskListFromPlanEntry：plan-mode custom entry（step/text/completed）归一化成同一契约", () => {
  const got = ext.taskListFromPlanEntry({
    type: "custom",
    customType: "plan-mode",
    timestamp: "2026-10-22T00:00:00.000Z",
    data: {
      enabled: true,
      executing: true,
      todos: [
        { step: 1, text: "改后端", completed: true },
        { step: 2, text: "补测试", completed: false },
      ],
    },
  })
  assert.deepEqual(got.tasks, [
    { id: "1", content: "改后端", status: "completed" },
    { id: "2", content: "补测试", status: "pending" },
  ])
  assert.equal(got.at, Date.parse("2026-10-22T00:00:00.000Z"))
  assert.deepEqual(ext.taskListFromPlanEntry({ type: "custom", customType: "plan-mode", data: { todos: [] } }).tasks, [])
  assert.equal(ext.taskListFromPlanEntry({ type: "custom", customType: "other", data: { todos: [{ step: 1, text: "x" }] } }), null)
})

test("taskListFromBranch：取当前分支最后一份 todo 结果 / plan entry，后出现者覆盖", () => {
  const todo = (ts, details) => ({
    type: "message",
    message: { role: "toolResult", toolName: "todo", toolCallId: "t" + ts, details, timestamp: ts },
  })
  const plan = (ts, todos) => ({ type: "custom", customType: "plan-mode", timestamp: ts, data: { todos } })
  assert.deepEqual(
    ext.taskListFromBranch([
      todo(10, { todos: [{ id: 1, text: "旧", done: false }] }),
      plan(20, [{ step: 1, text: "新计划", completed: true }]),
    ]),
    { type: "task_list_state", tasks: [{ id: "1", content: "新计划", status: "completed" }], source: "plan", at: 20 },
  )
  assert.deepEqual(
    ext.taskListFromBranch([
      plan(20, [{ step: 1, text: "旧计划", completed: true }]),
      todo(30, { todos: [] }),
    ]),
    { type: "task_list_state", tasks: [], source: "todo", at: 30 },
  )
  assert.equal(ext.taskListFromBranch([{ type: "message", message: { role: "assistant", content: [] } }]), null)
  assert.equal(ext.taskListFromBranch(null), null)
})

test("Bridge：todo 工具结束/plan entry 落盘时发 task_list_state，非 todo 与嵌套调用不发", () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  b.forward({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "todo",
    result: { content: [], details: { todos: [{ id: 1, text: "改后端", done: false }] } },
  })
  const live = sent.filter((m) => m.type === "event" && m.event.type === "task_list_state")
  assert.equal(live.length, 1)
  assert.deepEqual(live[0].event.tasks, [{ id: "1", content: "改后端", status: "pending" }])
  assert.equal(live[0].event.source, "todo")
  assert.equal(typeof live[0].event.at, "number")

  // 非 todo 工具 / 嵌套调用不改主分支清单
  const mark = sent.length
  b.forward({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash", result: { content: [], details: {} } })
  b.forward({ type: "tool_execution_end", toolCallId: "p/1", parentToolCallId: "p", toolName: "todo", result: { content: [], details: { todos: [] } } })
  assert.equal(sent.slice(mark).some((m) => m.type === "event" && m.event.type === "task_list_state"), false)

  // plan-mode entry 落盘：即时发，timeline 用 entry 时间
  b.forward({
    type: "entry_appended",
    entry: { type: "custom", customType: "plan-mode", timestamp: 7, data: { todos: [{ step: 1, text: "补测试", completed: false }] } },
  })
  const plan = sent.filter((m) => m.type === "event" && m.event.type === "task_list_state").at(-1)
  assert.deepEqual(plan.event.tasks, [{ id: "1", content: "补测试", status: "pending" }])
  assert.equal(plan.event.source, "plan")
  assert.equal(plan.event.at, 7)
})

test("Bridge：快照/对齐后补发分支清单（空清单也发），快照帧在先且清单不带 seq/rev", () => {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  b.ctx = {
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "toolResult", toolName: "todo", toolCallId: "t1", details: { todos: [] }, timestamp: 5 },
        },
      ],
    },
  }
  b.syncSnapshot({ msgCount: 0 })
  assert.equal(sent[0].type, "snapshot")
  const state = sent.find((m) => m.type === "event" && m.event.type === "task_list_state")
  assert.ok(state, "快照后要补清单")
  assert.deepEqual(state.event, { type: "task_list_state", tasks: [], source: "todo", at: 5 })
  assert.equal(state.seq, undefined)
  assert.equal(state.rev, undefined)
})


/* ---- get_file：当前会话 cwd 路径监狱、mime/编码、大小与二进制 ---- */

function tempDir(t, prefix = "pi-file-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function bridgeAt(cwd) {
  const b = new ext.Bridge()
  b.cwd = cwd
  return b
}

test("get_file：相对/绝对路径都按会话 cwd 解析，文本 utf8、JSON/图片 MIME 正确", async (t) => {
  const dir = tempDir(t)
  fs.mkdirSync(path.join(dir, "docs"))
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello 世界\n", "utf8")
  fs.writeFileSync(path.join(dir, "docs", "a.json"), '{"a":1}', "utf8")
  fs.writeFileSync(path.join(dir, "empty.txt"), "", "utf8")
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
  fs.writeFileSync(path.join(dir, "pixel.png"), png)
  const b = bridgeAt(dir)

  const text = await b.executeCommand("get_file", { path: "hello.txt" })
  assert.deepEqual(text, {
    name: "hello.txt",
    mimeType: "text/plain",
    size: Buffer.byteLength("hello 世界\n"),
    encoding: "utf8",
    data: "hello 世界\n",
    truncated: false,
  })

  const json = await b.executeCommand("get_file", { path: path.join(dir, "docs", "a.json") })
  assert.equal(json.name, "a.json")
  assert.equal(json.mimeType, "application/json")
  assert.equal(json.data, '{"a":1}')
  assert.equal(json.encoding, "utf8")

  const empty = await b.executeCommand("get_file", { path: "empty.txt" })
  assert.equal(empty.size, 0)
  assert.equal(empty.data, "")
  assert.equal(empty.truncated, false)

  const image = await b.executeCommand("get_file", { path: "pixel.png" })
  assert.deepEqual(image, {
    name: "pixel.png",
    mimeType: "image/png",
    size: png.length,
    encoding: "base64",
    data: png.toString("base64"),
    truncated: false,
  })
})

test("get_file：..、绝对路径、符号链接逃逸都被路径监狱挡住；目录/二进制/非 UTF-8 明确报码", async (t) => {
  const dir = tempDir(t)
  const outside = path.join(os.tmpdir(), `pi-file-secret-${process.pid}-${Date.now()}.txt`)
  fs.writeFileSync(outside, "SECRET-SHOULD-NOT-LEAK", "utf8")
  t.after(() => fs.rmSync(outside, { force: true }))
  fs.mkdirSync(path.join(dir, "sub"))
  fs.writeFileSync(path.join(dir, "sub", "ok.txt"), "ok", "utf8")
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 3]))
  fs.writeFileSync(path.join(dir, "bad.txt"), Buffer.from([0xff, 0xfe, 0xfd]))
  fs.writeFileSync(path.join(dir, "nul.txt"), Buffer.from("a\0b", "utf8"))
  const b = bridgeAt(dir)

  await assert.rejects(b.executeCommand("get_file", { path: "../" + path.basename(outside) }), (e) => e.code === "cwd_not_allowed")
  await assert.rejects(b.executeCommand("get_file", { path: outside }), (e) => e.code === "cwd_not_allowed")
  await assert.rejects(b.executeCommand("get_file", { path: "sub/../../" + path.basename(outside) }), (e) => e.code === "cwd_not_allowed")

  if (process.platform !== "win32") {
    const link = path.join(dir, "escape.txt")
    fs.symlinkSync(outside, link)
    await assert.rejects(b.executeCommand("get_file", { path: "escape.txt" }), (e) => e.code === "cwd_not_allowed")
    // 指向 cwd 内部的符号链接不算逃逸
    const insideLink = path.join(dir, "inside-link.txt")
    fs.symlinkSync(path.join(dir, "sub", "ok.txt"), insideLink)
    const inside = await b.executeCommand("get_file", { path: "inside-link.txt" })
    assert.equal(inside.data, "ok")
  }

  await assert.rejects(b.executeCommand("get_file", { path: "sub" }), (e) => e.code === "unsupported")
  await assert.rejects(b.executeCommand("get_file", { path: "blob.bin" }), (e) => e.code === "unsupported")
  await assert.rejects(b.executeCommand("get_file", { path: "bad.txt" }), (e) => e.code === "unsupported")
  await assert.rejects(b.executeCommand("get_file", { path: "nul.txt" }), (e) => e.code === "unsupported")
  await assert.rejects(b.executeCommand("get_file", { path: "missing.txt" }), (e) => e.code === "not_found")
  await assert.rejects(b.executeCommand("get_file", {}), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_file", { path: 42 }), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_file", { path: "a\0b" }), (e) => e.code === "bad_args")
})

test("get_file：超过 5MB 的文本截断并标 truncated，图片明确报 payload_too_large；UTF-8 边界不返回半个字符", async (t) => {
  const dir = tempDir(t)
  const b = bridgeAt(dir)
  const max = ext.FILE_MAX_BYTES

  fs.writeFileSync(path.join(dir, "big.txt"), Buffer.alloc(max + 1, 0x61))
  const big = await b.executeCommand("get_file", { path: "big.txt" })
  assert.equal(big.size, max + 1, "size 是文件真实大小")
  assert.equal(big.truncated, true)
  assert.equal(big.encoding, "utf8")
  assert.equal(big.data.length, max, "文本只回前 5MB")
  assert.equal(big.data, "a".repeat(max))

  const boundary = Buffer.concat([Buffer.alloc(max - 1, 0x61), Buffer.from("你", "utf8")])
  fs.writeFileSync(path.join(dir, "boundary.txt"), boundary)
  const cut = await b.executeCommand("get_file", { path: "boundary.txt" })
  assert.equal(cut.truncated, true)
  assert.equal(cut.data, "a".repeat(max - 1), "截断处半个汉字要裁掉，不能出现替换字符")

  fs.writeFileSync(path.join(dir, "big.png"), Buffer.alloc(max + 1, 0x00))
  await assert.rejects(b.executeCommand("get_file", { path: "big.png" }), (e) => e.code === "payload_too_large")
})

/* ---- get_host_diag：形状、attach 判定、错误环、日志脱敏 ---- */

test("get_host_diag：字段齐全、attach 沿用窗口判定、错误环带 code、logTail 脱敏且只留 100 行", async (t) => {
  const dir = tempDir(t, "pi-diag-")
  const attachFile = path.join(dir, "remote-attach.json")
  const previous = {
    attach: process.env.PI_REMOTE_ATTACH_FILE,
    device: process.env.PI_REMOTE_DEVICE_ID,
    token: process.env.PI_REMOTE_TOKEN,
    always: process.env.PI_REMOTE_ALWAYS_ONLINE,
  }
  t.after(() => {
    for (const [key, value] of [["PI_REMOTE_ATTACH_FILE", previous.attach], ["PI_REMOTE_DEVICE_ID", previous.device], ["PI_REMOTE_TOKEN", previous.token], ["PI_REMOTE_ALWAYS_ONLINE", previous.always]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const expiresAt = Date.now() + 3600 * 1000
  fs.writeFileSync(attachFile, JSON.stringify({ pid: process.pid, deviceId: "diag-dev", expiresAt }))
  process.env.PI_REMOTE_ATTACH_FILE = attachFile
  process.env.PI_REMOTE_DEVICE_ID = "diag-dev"
  delete process.env.PI_REMOTE_ALWAYS_ONLINE

  const secret = "diag-secret-token-9876"
  process.env.PI_REMOTE_TOKEN = secret
  const b = new ext.Bridge()
  b.connected = true
  b.roomId = "diag-room"
  const sent = []
  b.ws = { bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} }

  b.runCommand({ id: "e1", command: "no_such_diag_command", args: {} })
  await new Promise((resolve) => setTimeout(resolve, 20))
  for (let i = 0; i < 120; i++) ext.log("tail-marker-" + i)
  ext.log("raw " + secret + " failed")
  ext.log("deviceToken=another-secret-value failed")

  const diag = await b.executeCommand("get_host_diag", {})
  assert.equal(typeof diag.nodeVersion, "string")
  assert.equal(diag.nodeVersion, process.version)
  assert.equal(diag.platform, ext.platformId(process.platform))
  assert.equal(diag.arch, process.arch)
  assert.equal(diag.extensionVersion, "4.0.0")
  assert.ok(diag.piVersion === null || typeof diag.piVersion === "string")
  assert.deepEqual(Object.keys(diag).sort(), ["arch", "attach", "extensionVersion", "logTail", "nodeVersion", "piVersion", "platform", "recentErrors", "tap"].sort())
  assert.equal(diag.tap.state, "off", "未装 tap 的桥如实报 off")
  assert.equal(diag.tap.captures, 0)
  assert.equal(diag.tap.open, 0)
  assert.equal(diag.attach.active, true)
  assert.equal(diag.attach.deviceId, "diag-dev")
  assert.equal(diag.attach.expiresAt, expiresAt)
  assert.ok(Array.isArray(diag.recentErrors))
  assert.ok(diag.recentErrors.length <= ext.DIAG_ERROR_MAX)
  assert.ok(diag.recentErrors.some((e) => e.code === "unknown_command" && /未知命令/.test(e.message)))
  for (const e of diag.recentErrors) {
    assert.equal(typeof e.at, "number")
    assert.equal(typeof e.message, "string")
  }
  assert.ok(diag.logTail.length <= ext.LOG_TAIL_LINES)
  assert.ok(diag.logTail.some((line) => /tail-marker-119/.test(line)), "尾部 100 行要包含最后写的那条")
  const all = JSON.stringify(diag)
  assert.equal(all.includes(secret), false, "日志/错误环里绝不能出现真实 token")
  assert.equal(all.includes("another-secret-value"), false, "key=value 形态的密钥要打码")
  assert.match(diag.logTail.find((line) => /deviceToken=/.test(line)) || "", /deviceToken=\*\*\*/)

  // 环形缓冲上限 20：超出后丢最旧的，保留最新的
  for (let i = 0; i < 25; i++) ext.recordDiagError("ring-" + i)
  const ring = await b.executeCommand("get_host_diag", {})
  assert.equal(ring.recentErrors.length, ext.DIAG_ERROR_MAX)
  assert.equal(ring.recentErrors.at(-1).message, "ring-24")
  assert.equal(ring.recentErrors.some((e) => e.message === "ring-0"), false)

  // 窗口文件不存在时 active=false，但仍返回固定形状
  process.env.PI_REMOTE_ATTACH_FILE = path.join(dir, "missing-attach.json")
  const absent = await b.executeCommand("get_host_diag", {})
  assert.equal(absent.attach.active, false)
  assert.equal("expiresAt" in absent.attach, false)
})

test("readPiVersion：从 pi 包 package.json 只读版本，不执行外部命令", (t) => {
  const root = tempDir(t, "pi-pkg-")
  fs.mkdirSync(path.join(root, "dist", "bundle"), { recursive: true })
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }))
  const cli = path.join(root, "dist", "bundle", "cli.js")
  fs.writeFileSync(cli, "")
  assert.equal(ext.readPiVersion(cli), "9.9.9")
  // 同名包之外的 package.json 不认（真实环境里也可能另外找到 pi，断言不是伪造的 9.9.9）
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "not-pi", version: "1.0.0" }))
  assert.notEqual(ext.readPiVersion(cli), "9.9.9")
})

/* ---- get_image：按 entryId + blockIndex 从会话条目读原图（绕过投影 shrink） ---- */

function imageBridge(entries) {
  const b = new ext.Bridge()
  b.ctx = { sessionManager: { getEntry: (id) => entries[id] || null } }
  return b
}

test("get_image：读原图绕过投影 shrink；文本块/越界/缺条目/坏参数明确报码", async () => {
  const original = "A".repeat(200 * 1024)
  const entries = {
    e1: { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: original }] } },
    e2: { id: "e2", type: "custom_message", content: [{ type: "image", mimeType: "image/webp", data: "BBBB" }] },
    e3: { id: "e3", type: "message", message: { role: "user", content: [{ type: "text", text: "没有图" }] } },
    e4: { id: "e4", type: "message", message: { role: "user", content: [{ type: "image", mimeType: "image/png", data: "" }] } },
    e5: { id: "e5", type: "custom", content: "不是内容块数组" },
  }
  const b = imageBridge(entries)

  // get_entry 走投影：大图被换成占位；get_image 读同一活条目必须拿到完整原图
  const projected = await b.executeCommand("get_entry", { entryId: "e1" })
  assert.equal(projected.entry.message.content[1].data.length, 0)
  assert.equal(projected.entry.message.content[1].omitted, true)
  const image = await b.executeCommand("get_image", { entryId: "e1", blockIndex: 1 })
  assert.deepEqual(image, {
    entryId: "e1",
    blockIndex: 1,
    mimeType: "image/png",
    bytes: Math.floor((original.length * 3) / 4),
    data: original,
    compressed: false,
  })

  // 字符串下标同样接受；custom_message 的 entry.content 也可寻址
  assert.equal((await b.executeCommand("get_image", { entryId: "e1", blockIndex: "1" })).data, original)
  assert.equal((await b.executeCommand("get_image", { entryId: "e2", blockIndex: 0 })).data, "BBBB")

  await assert.rejects(b.executeCommand("get_image", {}), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e1" }), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e1", blockIndex: -1 }), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e1", blockIndex: 1.5 }), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e1", blockIndex: "x" }), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_image", { entryId: "missing", blockIndex: 0 }), (e) => e.code === "not_found")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e1", blockIndex: 9 }), (e) => e.code === "not_found")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e3", blockIndex: 0 }), (e) => e.code === "bad_args")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e4", blockIndex: 0 }), (e) => e.code === "not_found")
  await assert.rejects(b.executeCommand("get_image", { entryId: "e5", blockIndex: 0 }), (e) => e.code === "not_found")
})

test("get_image：超过单帧回图上限退化为 compressed 占位，不伪造原图数据", async () => {
  const huge = "A".repeat(ext.IMAGE_RETURN_MAX_CHARS + 1)
  const entries = {
    big: { id: "big", type: "message", message: { role: "toolResult", content: [{ type: "image", mimeType: "image/jpeg", data: huge }] } },
  }
  const b = imageBridge(entries)
  const out = await b.executeCommand("get_image", { entryId: "big", blockIndex: 0 })
  assert.deepEqual(out, {
    entryId: "big",
    blockIndex: 0,
    mimeType: "image/jpeg",
    bytes: Math.floor((huge.length * 3) / 4),
    data: "",
    omitted: true,
    omittedBytes: Math.floor((huge.length * 3) / 4),
    compressed: true,
  })
})

test("get_image：getEntry 缺失时回退 byId，仍读不到就 not_found", async () => {
  const b = new ext.Bridge()
  b.ctx = { sessionManager: { byId: { get: (id) => (id === "only-by-id" ? { id, type: "message", message: { content: [{ type: "image", mimeType: "image/gif", data: "R0lG" }] } } : null) } } }
  const out = await b.executeCommand("get_image", { entryId: "only-by-id", blockIndex: 0 })
  assert.equal(out.data, "R0lG")
  assert.equal(out.mimeType, "image/gif")
  await assert.rejects(b.executeCommand("get_image", { entryId: "nope", blockIndex: 0 }), (e) => e.code === "not_found")
})

/* ---------------- 对话框观察 tap（O1） ---------------- */

function tapBridge() {
  const b = new ext.Bridge()
  b.roomId = "r"
  const frames = []
  b.emitEvent = (ev) => frames.push(ev)
  const calls = []
  const ui = {
    select: async (title, options) => { calls.push(["select", title, options]); return options[0] },
    confirm: async (title, message) => { calls.push(["confirm", title, message]); return true },
    input: async (title, placeholder) => { calls.push(["input", title, placeholder]); return "text" },
    editor: async (title, prefill) => { calls.push(["editor", title, prefill]); return prefill },
    notify: (message, level) => { calls.push(["notify", message, level]) },
    setStatus: (key, text) => { calls.push(["setStatus", key, text]) },
    setWidget: (key, content, opts) => { calls.push(["setWidget", key, content, opts]) },
    setTitle: (title) => { calls.push(["setTitle", title]) },
    setWorkingMessage: (message) => { calls.push(["setWorkingMessage", message]) },
    setWorkingVisible: (visible) => { calls.push(["setWorkingVisible", visible]) },
    setWorkingIndicator: (opts) => { calls.push(["setWorkingIndicator", opts]) },
    setHiddenThinkingLabel: (label) => { calls.push(["setHiddenThinkingLabel", label]) },
  }
  b.ctx = { hasUI: true, ui }
  return { b, ui, frames, calls }
}

test("dialog tap：四种 dialog 原样透传 + dialog_open/close 成对发出", async () => {
  const { b, ui, frames, calls } = tapBridge()
  const originalSelect = ui.select
  b.installDialogTap()
  assert.equal(b.tapState, "ok")
  assert.notEqual(ui.select, originalSelect, "方法已被 wrap")

  const picked = await ui.select("选一个", ["甲", "乙"])
  assert.equal(picked, "甲", "返回值与原方法一致（本机零感知）")
  assert.deepEqual(calls[0], ["select", "选一个", ["甲", "乙"]], "原方法入参原样")

  const open = frames.find((f) => f.type === "dialog_open")
  assert.ok(open, "dialog_open 已发")
  assert.equal(open.kind, "select")
  assert.equal(open.title, "选一个")
  assert.deepEqual(open.options, ["甲", "乙"])
  assert.equal(typeof open.dialogId, "string")
  assert.equal(typeof open.startedAt, "number")
  const close = frames.find((f) => f.type === "dialog_close")
  assert.ok(close, "落定后 dialog_close 已发")
  assert.equal(close.dialogId, open.dialogId)
  assert.equal(close.outcome, "resolved")
  assert.equal(b.tapOpenDialogs.size, 0)

  await ui.confirm("标题", "正文")
  const confirmOpen = frames.filter((f) => f.type === "dialog_open").at(-1)
  assert.equal(confirmOpen.kind, "confirm")
  assert.equal(confirmOpen.message, "正文")
  await ui.input("标题", "提示语")
  const inputOpen = frames.filter((f) => f.type === "dialog_open").at(-1)
  assert.equal(inputOpen.kind, "input")
  assert.equal(inputOpen.placeholder, "提示语")
  await ui.editor("标题", "预填")
  const editorOpen = frames.filter((f) => f.type === "dialog_open").at(-1)
  assert.equal(editorOpen.kind, "editor")
  assert.equal(editorOpen.prefill, "预填")
  b.uninstallDialogTap()
  assert.equal(ui.select, originalSelect, "会话关闭还原原方法")
})

test("dialog tap：截断口径走协议 limits（选项数/字数、标题）", async () => {
  const { b, ui, frames } = tapBridge()
  b.installDialogTap()
  const options = Array.from({ length: 25 }, (_, i) => `选项${i}-` + "长".repeat(100))
  await ui.select("标".repeat(200), options, { timeout: 30000 })
  const open = frames.find((f) => f.type === "dialog_open")
  assert.equal(open.options.length, ext.PROTOCOL.limits.dialogOptionsMax)
  assert.ok(open.options.every((o) => o.length <= ext.PROTOCOL.limits.dialogOptionChars))
  assert.equal(open.optionsTotal, 25)
  assert.equal(open.title.length, ext.PROTOCOL.limits.dialogTitleMax)
  assert.equal(open.timeout, 30000, "timeout 有限正数才带")
  b.uninstallDialogTap()
})

test("dialog tap：notify 立帧、setStatus/setWidget 维护快照表", () => {
  const { b, ui, frames, calls } = tapBridge()
  b.installDialogTap()
  ui.notify("部署完成", "warning")
  const notify = frames.find((f) => f.type === "ext_notify")
  assert.ok(notify)
  assert.equal(notify.message, "部署完成")
  assert.equal(notify.level, "warning")

  frames.length = 0
  b.notifyRemote("正文内容")
  assert.equal(frames.some((f) => f.type === "ext_notify"), false, "远程消息 TUI 提示不镜像成网页 toast")
  assert.ok(calls.some((call) => call[0] === "notify" && String(call[1]).startsWith("📱 远程消息")), "本机 TUI 仍提示")

  frames.length = 0
  ui.setStatus("branch", "main")
  let status = frames.find((f) => f.type === "ext_status")
  assert.deepEqual(status.statuses, { branch: "main" })
  assert.deepEqual(status.tap, { state: "ok" })
  ui.setStatus("branch", undefined)
  status = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.deepEqual(status.statuses, {}, "空文本删 key")

  ui.setWidget("w1", ["第一行", "第二行"], { placement: "belowEditor" })
  status = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.deepEqual(status.widgets, [{ key: "w1", lines: ["第一行", "第二行"], placement: "belowEditor" }])
  ui.setWidget("w2", () => ({}))
  status = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.deepEqual(status.widgets.find((w) => w.key === "w2"), { key: "w2", factory: true }, "工厂形态只记事实")
  ui.setWidget("w1", undefined)
  status = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.equal(status.widgets.some((w) => w.key === "w1"), false, "undefined 删 widget")
  b.uninstallDialogTap()
})

test("dialog tap：自检——dialog 类 ui_prompt_start 连续两次未命中判失效，custom 不计", () => {
  const { b } = tapBridge()
  b.installDialogTap()
  assert.equal(b.tapState, "ok")
  b.noteUiPromptSignal({ type: "ui_prompt_start", kind: "custom" })
  assert.equal(b.tapMissed, 0, "custom 不捕获是设计内，不计未命中")
  b.noteUiPromptSignal({ type: "ui_prompt_start", kind: "select" })
  assert.equal(b.tapState, "ok", "一次未命中还不判死")
  b.noteUiPromptSignal({ type: "ui_prompt_start", kind: "select" })
  assert.equal(b.tapState, "failed", "连续两次未命中 → 回退信号模式")
  b.uninstallDialogTap()
})

test("dialog tap：fail-open——捕获侧异常不影响原方法；无 UI 不装", async () => {
  const { b, ui } = tapBridge()
  b.installDialogTap()
  b.emitEvent = () => { throw new Error("发送通道炸了") }
  const picked = await ui.select("选一个", ["甲"])
  assert.equal(picked, "甲", "emitEvent 抛错也被吞，原方法照常")
  b.uninstallDialogTap()

  const headless = new ext.Bridge()
  headless.roomId = "r"
  headless.ctx = { hasUI: false, ui: { select: async () => "x" } }
  headless.installDialogTap()
  assert.equal(headless.tapState, "off", "无 UI 环境不装 tap")
})

test("dialog tap：纯函数 buildDialogOpen / capDialogOptions", () => {
  const ev = ext.buildDialogOpen("select", ["题", ["a", "b"], { timeout: 5000 }], "dlg-1", 123)
  assert.deepEqual(ev, { type: "dialog_open", dialogId: "dlg-1", kind: "select", startedAt: 123, title: "题", timeout: 5000, options: ["a", "b"] })
  const bad = ext.buildDialogOpen("confirm", ["题", "文", { timeout: -1 }], "dlg-2", 5)
  assert.equal("timeout" in bad, false, "非正 timeout 不带")
  const capped = ext.capDialogOptions("不是数组")
  assert.deepEqual(capped, { options: [] })
})

/* ---------------- 对话框应答接管（O2） ---------------- */

/** O2 脚手架：tapBridge + 收集桥→relay 的 send 帧（应答回执走这条路）。 */
function o2Bridge() {
  const ctx = tapBridge()
  const sent = []
  ctx.b.send = (frame) => { sent.push(frame); return true }
  return { ...ctx, sent }
}

async function armTakeover(b) {
  b.installDialogTap()
  await b.handle({ type: "dialog_answer_switch", enabled: true })
  await b.handle({ type: "dialog_gate", hasViewers: true })
}

function lastOpen(frames) {
  return frames.filter((f) => f.type === "dialog_open").at(-1)
}
function lastClose(frames) {
  return frames.filter((f) => f.type === "dialog_close").at(-1)
}
function lastResult(sent) {
  return sent.filter((f) => f.type === "dialog_answer_result").at(-1)
}

test("O2 接管：门控任一不满足 → 原样透传本机弹窗（开关关 / 无 viewer / tap 失效）", async () => {
  // 开关关（默认）
  {
    const { b, ui, calls } = o2Bridge()
    b.installDialogTap()
    await b.handle({ type: "dialog_gate", hasViewers: true })
    assert.equal(await ui.confirm("题", "文"), true)
    assert.equal(calls.length, 1, "开关关：原方法被调用（本机弹窗）")
    b.uninstallDialogTap()
  }
  // 开关开但无 viewer 在线
  {
    const { b, ui, calls } = o2Bridge()
    b.installDialogTap()
    await b.handle({ type: "dialog_answer_switch", enabled: true })
    assert.equal(await ui.confirm("题", "文"), true)
    assert.equal(calls.length, 1, "无 viewer：自动透传")
    b.uninstallDialogTap()
  }
  // 门控全开但 tap 自检已判失效
  {
    const { b, ui, calls } = o2Bridge()
    await armTakeover(b)
    b.tapState = "failed"
    assert.equal(await ui.confirm("题", "文"), true)
    assert.equal(calls.length, 1, "tap 失效：整体退回透传")
    b.uninstallDialogTap()
  }
})

test("O2 接管：confirm 远程 Allow → true；open 带 answerable，本机原方法零调用", async () => {
  const { b, ui, frames, calls, sent } = o2Bridge()
  await armTakeover(b)
  const p = ui.confirm("继续吗", "正文")
  assert.equal(calls.length, 0, "接管时本机不弹窗")
  const open = lastOpen(frames)
  assert.equal(open.answerable, true, "dialog_open 带 answerable:true（通知文案分段靠它）")
  await b.handle({ type: "dialog_answer", room: "r", dialogId: open.dialogId, action: "allow", aid: "a1" })
  assert.equal(await p, true)
  assert.deepEqual(lastResult(sent), { type: "dialog_answer_result", aid: "a1", dialogId: open.dialogId, ok: true })
  const close = lastClose(frames)
  assert.equal(close.reason, "answered")
  assert.equal(close.dialogId, open.dialogId)
  b.uninstallDialogTap()
})

test("O2 接管：Deny 带理由 → resolve 取消值，理由只进 close 广播、绝不进 resolve 值", async () => {
  const { b, ui, frames } = o2Bridge()
  await armTakeover(b)
  const p = ui.confirm("删库吗", "不可恢复")
  const open = lastOpen(frames)
  await b.handle({ type: "dialog_answer", room: "r", dialogId: open.dialogId, action: "deny", note: "先备份再说", aid: "a1" })
  const value = await p
  assert.equal(value, false, "confirm 取消语义 = false")
  assert.equal(typeof value, "boolean", "resolve 值里没有理由的容身处")
  const close = lastClose(frames)
  assert.equal(close.reason, "denied")
  assert.equal(close.note, "先备份再说", "理由随 close 广播给各端呈现")
  b.uninstallDialogTap()
})

test("O2 接管：select/input/editor 提交按原语义 resolve；非法选项回 bad_args 且 dialog 仍可答", async () => {
  const { b, ui, frames, sent } = o2Bridge()
  await armTakeover(b)

  const pSel = ui.select("选一个", ["甲", "乙"])
  const selOpen = lastOpen(frames)
  await b.handle({ type: "dialog_answer", room: "r", dialogId: selOpen.dialogId, action: "submit", value: "丙", aid: "a1" })
  assert.deepEqual(lastResult(sent), { type: "dialog_answer_result", aid: "a1", dialogId: selOpen.dialogId, ok: false, code: "bad_args" }, "不在原选项内的值不合法")
  await b.handle({ type: "dialog_answer", room: "r", dialogId: selOpen.dialogId, action: "submit", value: "乙", aid: "a2" })
  assert.equal(await pSel, "乙", "select 提交 resolve 为选项原文")

  const pIn = ui.input("名字", "提示")
  const inOpen = lastOpen(frames)
  await b.handle({ type: "dialog_answer", room: "r", dialogId: inOpen.dialogId, action: "submit", value: "小明", aid: "a3" })
  assert.equal(await pIn, "小明")

  const pEd = ui.editor("改文案", "原文")
  const edOpen = lastOpen(frames)
  await b.handle({ type: "dialog_answer", room: "r", dialogId: edOpen.dialogId, action: "deny", aid: "a4" })
  assert.equal(await pEd, undefined, "editor 取消语义 = undefined")
  b.uninstallDialogTap()
})

test("O2 接管：双端同答先到为准，第二答回 dialog_gone；未知 id 同样 gone", async () => {
  const { b, ui, frames, sent } = o2Bridge()
  await armTakeover(b)
  const p = ui.confirm("题", "文")
  const open = lastOpen(frames)
  await b.handle({ type: "dialog_answer", room: "r", dialogId: open.dialogId, action: "allow", aid: "first" })
  assert.equal(await p, true)
  await b.handle({ type: "dialog_answer", room: "r", dialogId: open.dialogId, action: "deny", aid: "second" })
  assert.deepEqual(lastResult(sent), { type: "dialog_answer_result", aid: "second", dialogId: open.dialogId, ok: false, code: "dialog_gone" }, "迟到答案回 gone")
  await b.handle({ type: "dialog_answer", room: "r", dialogId: "dlg-nope", action: "allow", aid: "third" })
  assert.equal(lastResult(sent).code, "dialog_gone")
  b.uninstallDialogTap()
})

test("O2 接管：无自带 timeout → 桥侧兜底超时按取消 resolve + close reason timeout（短值注入）", async () => {
  const { b, ui, frames } = o2Bridge()
  await armTakeover(b)
  const saved = ext.PROTOCOL.limits.dialogAnswerTimeoutMs
  ext.PROTOCOL.limits.dialogAnswerTimeoutMs = 30
  try {
    const p = ui.confirm("题", "文")
    const open = lastOpen(frames)
    assert.equal(open.timeout, 30, "open 帧 timeout 取桥侧有效时限，前端倒计时同源")
    assert.equal(await p, false, "超时按取消 resolve")
    assert.equal(lastClose(frames).reason, "timeout")
  } finally {
    ext.PROTOCOL.limits.dialogAnswerTimeoutMs = saved
  }
  b.uninstallDialogTap()
})

test("O2 接管：opts.timeout 优先于桥侧兜底；abort 立即按取消落定、其后答案作废", async () => {
  const { b, ui, frames, sent } = o2Bridge()
  await armTakeover(b)
  const ac = new AbortController()
  const p = ui.confirm("题", "文", { timeout: 60000, signal: ac.signal })
  const open = lastOpen(frames)
  assert.equal(open.timeout, 60000, "宿主 timeout 原样透出")
  ac.abort()
  assert.equal(await p, false)
  assert.equal(lastClose(frames).reason, "aborted")
  await b.handle({ type: "dialog_answer", room: "r", dialogId: open.dialogId, action: "allow", aid: "late" })
  assert.equal(lastResult(sent).code, "dialog_gone", "abort 后答案作废")
  b.uninstallDialogTap()
})

test("O2 接管：嵌套 dialog 按调用顺序排队，前一个落定后才点亮下一个", async () => {
  const { b, ui, frames, sent } = o2Bridge()
  await armTakeover(b)
  const p1 = ui.confirm("第一", "文")
  const p2 = ui.confirm("第二", "文")
  const opens = frames.filter((f) => f.type === "dialog_open")
  assert.equal(opens.length, 1, "同一时刻只点亮一个可答 dialog")
  // 排队中的 dialog 还答不了（未点亮）：回 gone
  await b.handle({ type: "dialog_answer", room: "r", dialogId: "whatever", action: "allow", aid: "q0" })
  assert.equal(lastResult(sent).code, "dialog_gone")
  await b.handle({ type: "dialog_answer", room: "r", dialogId: opens[0].dialogId, action: "allow", aid: "q1" })
  assert.equal(await p1, true)
  const opens2 = frames.filter((f) => f.type === "dialog_open")
  assert.equal(opens2.length, 2, "前一个落定后第二个按序点亮")
  await b.handle({ type: "dialog_answer", room: "r", dialogId: opens2[1].dialogId, action: "deny", aid: "q2" })
  assert.equal(await p2, false)
  b.uninstallDialogTap()
})

test("O2 接管：连接断开（socketGone）→ 持留 dialog 交回本机弹窗，不卡死", async () => {
  const { b, ui, frames, calls } = o2Bridge()
  await armTakeover(b)
  const p = ui.confirm("题", "文")
  assert.equal(calls.length, 0, "断开前仍在接管")
  assert.equal(lastOpen(frames).answerable, true)
  b.socketGone()
  assert.equal(await p, true, "落回本机弹窗、由原方法 resolve（假 ui 返回 true）")
  assert.equal(calls.length, 1, "原方法被调用")
  const observeOpen = frames.filter((f) => f.type === "dialog_open").at(-1)
  assert.equal(observeOpen.answerable, undefined, "交回本机走观察形态 open（无 answerable）")
  assert.equal(lastClose(frames).outcome, "resolved")
  b.uninstallDialogTap()
})

test("O2 接管：会话关闭（uninstall）→ 持留 dialog 按取消落定，不留挂起 promise", async () => {
  const { b, ui } = o2Bridge()
  await armTakeover(b)
  const p = ui.confirm("题", "文")
  b.uninstallDialogTap()
  assert.equal(await p, false, "拆卸时按取消 resolve")
})

test("O2 接管：viewer 全离场（dialog_gate 翻假）→ 持留 dialog 立即交回本机，不等超时（发现 A-1）", async () => {
  const { b, ui, frames, calls } = o2Bridge()
  await armTakeover(b)
  const p = ui.confirm("题", "文")
  assert.equal(calls.length, 0, "接管中：本机未弹窗")
  await b.handle({ type: "dialog_gate", hasViewers: false })
  assert.equal(calls.length, 1, "门控翻假当场调起原方法交回本机")
  assert.equal(await p, true, "由本机原方法 resolve，不等桥侧超时")
  assert.equal(lastOpen(frames).answerable, undefined, "交回走观察形态 open（无 answerable）")
  assert.equal(lastClose(frames).outcome, "resolved")
  // 门控已假：后续 dialog 直接透传本机
  assert.equal(await ui.confirm("题二", "文"), true)
  assert.equal(calls.length, 2, "门控假后新 dialog 原样透传")
  b.uninstallDialogTap()
})

test("O2 接管：开关关闭（dialog_answer_switch）→ 持留 dialog 立即交回本机，不等超时（发现 A-1）", async () => {
  const { b, ui, calls } = o2Bridge()
  await armTakeover(b)
  const p = ui.confirm("题", "文")
  assert.equal(calls.length, 0, "接管中：本机未弹窗")
  await b.handle({ type: "dialog_answer_switch", enabled: false })
  assert.equal(calls.length, 1, "关开关当场调起原方法交回本机")
  assert.equal(await p, true, "由本机原方法 resolve，不等桥侧超时")
  b.uninstallDialogTap()
})

/** 本机 dialog 可控落定的脚手架：confirm 原方法返回手动 resolve 的 promise（装 tap 前替换）。 */
function deferredConfirmBridge() {
  const ctx = o2Bridge()
  const resolvers = []
  ctx.ui.confirm = (title, message) => {
    ctx.calls.push(["confirm", title, message])
    return new Promise((res) => resolvers.push(res))
  }
  return { ...ctx, resolvers }
}

test("O2 交回本机：多个持留 dialog 串行调起，前一个落定才起下一个（发现 A-4）", async () => {
  const { b, ui, calls, resolvers } = deferredConfirmBridge()
  await armTakeover(b)
  const p1 = ui.confirm("第一", "文")
  const p2 = ui.confirm("第二", "文")
  assert.equal(calls.length, 0, "接管中两个都未调原方法")
  b.socketGone()
  assert.equal(calls.length, 1, "交回串行：同 tick 只调起第一个原方法，不并发弹窗")
  resolvers[0](true)
  assert.equal(await p1, true)
  await new Promise((r) => setImmediate(r))
  assert.equal(calls.length, 2, "第一个在本机落定后才调起第二个")
  resolvers[1](false)
  assert.equal(await p2, false)
  b.uninstallDialogTap()
})

test("O2 断线交回：重连 sync 后重发观察形态 open（startedAt 沿用原值），本机落定后不再重发（发现 A-5）", async () => {
  const { b, ui, frames, calls, resolvers } = deferredConfirmBridge()
  await armTakeover(b)
  const p = ui.confirm("题", "文")
  const held = lastOpen(frames)
  assert.equal(held.answerable, true)
  b.socketGone()
  assert.equal(calls.length, 1, "断线已交回本机、原方法挂起待本机处理")
  // 桥重连：room_registered → sync 完成后应重发该 dialog 的观察形态 open
  frames.length = 0
  await b.handle({ type: "room_registered", room: "r", msgCount: 0 })
  const resent = frames.filter((f) => f.type === "dialog_open")
  assert.equal(resent.length, 1, "重连后恰重发一条 open")
  assert.equal(resent[0].dialogId, held.dialogId, "同一 dialogId（relay 按 id 回槽）")
  assert.equal(resent[0].startedAt, held.startedAt, "startedAt 沿用原值，时限不重算")
  assert.equal(resent[0].answerable, undefined, "观察形态：无 answerable")
  // 本机落定 → close 成对发出、登记销账；再重连不重发幽灵卡
  resolvers[0](true)
  assert.equal(await p, true)
  assert.equal(lastClose(frames).dialogId, held.dialogId)
  frames.length = 0
  await b.handle({ type: "room_registered", room: "r", msgCount: 0 })
  assert.equal(frames.filter((f) => f.type === "dialog_open").length, 0, "已落定的 dialog 不再重发")
  b.uninstallDialogTap()
})
