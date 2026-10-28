// 网页连接/流式竞态的纯逻辑回归测试（不启动浏览器、不依赖 React）。
// Node ≥ 22.18 原生剥离 TS 类型，直接 import .ts 源文件（与 ui-sync.test.mjs 同一套做法）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_MAX_ITEMS,
  acceptSocketFrame,
  createDeviceRequestTickets,
  emptyTranscript,
  estimateItemBytes,
  reduceTranscript,
} from "../ui/src/relay/transcript.ts"

const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
const asst = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra })
const reduce = (state, ...actions) => actions.reduce(reduceTranscript, state)
const pairMessages = (count) => {
  const messages = []
  for (let k = 0; k < count; k += 1) messages.push(user(`q${k}`), asst(`a${k}`))
  return messages
}

test("连接代际：旧 socket 的迟到帧整帧丢弃，当前连接的文本帧才放行", () => {
  // 模拟两次 connect()：gen 每次换代，旧 socket 的 onmessage 闭包仍拿着旧 gen
  let currentGen = 0
  const connect = () => ++currentGen
  const oldSocketGen = connect()
  const liveSocketGen = connect()

  assert.equal(acceptSocketFrame(oldSocketGen, currentGen, '{"type":"room_event"}'), false, "旧帧不能进入解析/分发")
  assert.equal(acceptSocketFrame(liveSocketGen, currentGen, '{"type":"room_event"}'), true)
  assert.equal(acceptSocketFrame(liveSocketGen, currentGen, new Uint8Array([1, 2])), false, "非文本帧本来就不解析")
  assert.equal(acceptSocketFrame(liveSocketGen, currentGen, null), false)

  // 再换代一次：上一代（哪怕它曾经是 live）立刻作废
  const staleGen = liveSocketGen
  connect()
  assert.equal(acceptSocketFrame(staleGen, currentGen, '{"type":"auth_result","ok":true}'), false)
})

test("发送失败不回写草稿：产品接线只把失败留在气泡，不再退回输入框", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.equal(relay.includes("draftAfterSendFailure"), false, "不再导入/调用草稿回滚")
  assert.doesNotMatch(relay, /setDraft\([^)]*draftAfter/, "失败路径不能写 setDraft")
  assert.match(relay, /send-failed[^\n]*drop: false/, "失败气泡保留（drop:false）而不是摘掉")
  assert.match(
    relay,
    /if \(sendLock\.current\.release\(cid\)\) \{[\s\S]{0,220}setLastFailure/,
    "只有仍然持有这把锁的失败才进入 S6，晚到失败不串到下一条",
  )
})

test("发送 in-flight：同 tick 第二次提交在清草稿前被锁拒绝", async () => {
  const { createSendLock } = await import("../ui/src/chat/composerMachine.ts")
  const lock = createSendLock()
  const view = { draft: "同一句话" }
  let sends = 0
  const submit = async () => {
    if (!lock.acquire("cid-1")) return "locked"
    sends += 1
    view.draft = ""
    await Promise.resolve()
    lock.release("cid-1")
    return "sent"
  }
  const results = await Promise.all([submit(), submit()])
  assert.equal(sends, 1, "同 tick 双击只发一次")
  assert.deepEqual(results.sort(), ["locked", "sent"])
  assert.equal(view.draft, "", "草稿只被成功的那一次清掉")
})

test("双设备 loadSessions 并发：各自只认自己的最新请求，互不作废", () => {
  const tickets = createDeviceRequestTickets()
  const a1 = tickets.issue("device-a")
  const b1 = tickets.issue("device-b")
  // 两台设备的请求都还在飞：各自都是最新，不能因为对方发起而作废
  assert.equal(tickets.isCurrent("device-a", a1), true)
  assert.equal(tickets.isCurrent("device-b", b1), true)

  // A 又刷新了一次：只作废 A 的旧请求，B 不受影响
  const a2 = tickets.issue("device-a")
  assert.equal(tickets.isCurrent("device-a", a1), false)
  assert.equal(tickets.isCurrent("device-b", b1), true)
  assert.equal(tickets.isCurrent("device-a", a2), true)

  // 按响应实际到达顺序落地：B 先回、A 的旧请求后回（必须丢弃）、A 的新请求最后回
  const landed = {}
  const settle = (deviceId, ticket, rows) => {
    if (tickets.isCurrent(deviceId, ticket)) landed[deviceId] = rows
  }
  settle("device-b", b1, ["b-session"])
  settle("device-a", a1, ["stale-a-session"])
  settle("device-a", a2, ["a-session"])

  assert.deepEqual(landed, { "device-b": ["b-session"], "device-a": ["a-session"] })
  assert.equal(tickets.isCurrent("device-a", 0), false, "未签发的 0 号不是有效 token")
})

test("并行工具调用：toolcall_delta 按 contentIndex/id 定位，不再追加到最后一个工具块", () => {
  let transcript = emptyTranscript()
  transcript = reduceTranscript(transcript, {
    type: "message-start",
    message: { role: "assistant", content: [] },
  })
  transcript = reduceTranscript(transcript, {
    type: "message-update",
    event: { type: "toolcall_start", contentIndex: 0, id: "call-search", toolName: "search" },
  })
  transcript = reduceTranscript(transcript, {
    type: "message-update",
    event: { type: "toolcall_start", contentIndex: 1, id: "call-read", toolName: "read" },
  })
  // 两个工具的参数流交错到达：先 search、再 read、又回 search……
  for (const event of [
    { type: "toolcall_delta", contentIndex: 0, delta: '{"query":' },
    { type: "toolcall_delta", contentIndex: 1, delta: '{"path":' },
    { type: "toolcall_delta", contentIndex: 0, delta: '"pi"}' },
    { type: "toolcall_delta", contentIndex: 1, delta: '"a.txt"}' },
  ]) {
    transcript = reduceTranscript(transcript, { type: "message-update", event })
  }

  const blocks = transcript.items.at(-1).blocks
  assert.deepEqual(blocks.map((block) => block.kind), ["tool", "tool"])
  assert.equal(blocks[0].name, "search")
  assert.equal(blocks[0].argsText, '{"query":"pi"}', "search 的参数不能被 read 的 delta 污染")
  assert.equal(blocks[1].name, "read")
  assert.equal(blocks[1].argsText, '{"path":"a.txt"}', "read 的参数不能被 search 的 delta 污染")
})

test("toolcall_delta 无匹配时安全忽略；只带 id/toolCallId 时仍能精确定位", () => {
  let transcript = emptyTranscript()
  transcript = reduceTranscript(transcript, {
    type: "message-start",
    message: { role: "assistant", content: [] },
  })
  transcript = reduceTranscript(transcript, {
    type: "message-update",
    event: { type: "toolcall_start", contentIndex: 0, id: "call-a", toolName: "bash" },
  })
  transcript = reduceTranscript(transcript, {
    type: "message-update",
    event: { type: "toolcall_start", contentIndex: 1, id: "call-b", toolName: "read" },
  })

  // 没有 id 且 contentIndex 对不上（start 还没到）：丢弃，不能改任何已有工具卡
  const before = JSON.stringify(transcript.items)
  const ignored = reduceTranscript(transcript, {
    type: "message-update",
    event: { type: "toolcall_delta", contentIndex: 7, delta: "garbage" },
  })
  assert.equal(JSON.stringify(ignored.items), before)
  assert.equal(ignored.items.at(-1).blocks[0].argsText, "")
  assert.equal(ignored.items.at(-1).blocks[1].argsText, "")

  // 没有 contentIndex、只有 id：按 id 找，仍然只动目标卡
  transcript = reduceTranscript(transcript, {
    type: "message-update",
    event: { type: "toolcall_delta", id: "call-a", delta: '{"cmd":' },
  })
  // toolCallId 同样支持（不同事件源字段名）
  transcript = reduceTranscript(transcript, {
    type: "message-update",
    event: { type: "toolcall_delta", toolCallId: "call-b", delta: '{"path":' },
  })
  const blocks = transcript.items.at(-1).blocks
  assert.equal(blocks[0].argsText, '{"cmd":')
  assert.equal(blocks[1].argsText, '{"path":')
})

test("状态上限：超过条数上限只裁头部，尾部 live 气泡保留且能继续流式", () => {
  const messages = pairMessages((TRANSCRIPT_MAX_ITEMS + 136) / 2)
  messages[messages.length - 1] = asst("still-streaming", { stopReason: "pending" })
  const snapshot = reduceTranscript(emptyTranscript(), { type: "snapshot", messages })

  assert.equal(snapshot.items.length, TRANSCRIPT_MAX_ITEMS)
  assert.equal(snapshot.items.at(-1).kind, "assistant")
  assert.equal(snapshot.items.at(-1).live, true)
  assert.equal(snapshot.liveKey, snapshot.items.at(-1).key)
  // 保留的是消息流的最后一截，而不是最前面一截
  assert.equal(snapshot.items[0].text, messages[messages.length - TRANSCRIPT_MAX_ITEMS].content[0].text)
  assert.equal(new Set(snapshot.items.map((item) => item.key)).size, snapshot.items.length, "裁剪后 key 仍唯一")

  const next = reduceTranscript(snapshot, {
    type: "message-update-batch",
    events: [{ type: "text_delta", contentIndex: 0, delta: " done" }],
  })
  assert.equal(next.items.length, TRANSCRIPT_MAX_ITEMS)
  assert.equal(next.items.at(-1).blocks[0].text, "still-streaming done")
  assert.equal(next.liveKey, next.items.at(-1).key)
})

test("状态上限：字节超限时从头部裁剪，并至少保留最新消息", () => {
  const big = "x".repeat(1_000_000)
  const messages = []
  for (let k = 0; k < 12; k += 1) messages.push(user(`${k}:${big}`))

  const snapshot = reduceTranscript(emptyTranscript(), { type: "snapshot", messages })
  assert.ok(snapshot.items.length < messages.length, "12 条 2MB 级消息必须被裁")
  assert.ok(snapshot.items.length > 0)
  const bytes = snapshot.items.reduce((sum, item) => sum + estimateItemBytes(item), 0)
  assert.ok(bytes <= TRANSCRIPT_MAX_BYTES, `保留 ${snapshot.items.length} 条仍有 ${bytes} 估算字节`)
  assert.equal(snapshot.items.at(-1).text, `11:${big}`, "最新一条必须保留")
})

test("裁剪后尾部失败气泡仍可重试：drop 旧失败项，再发新 cid", () => {
  let s = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: pairMessages(TRANSCRIPT_MAX_ITEMS / 2) })
  s = reduceTranscript(s, { type: "echo", text: "重试我", cid: "c1" })
  s = reduceTranscript(s, { type: "send-failed", cid: "c1", error: "会话正忙", drop: false })
  const failed = s.items.find((item) => item.kind === "user" && item.cid === "c1")
  assert.equal(failed?.failed, "会话正忙")

  // 再进一条真实消息，触发一次头部裁剪；失败气泡在尾部，不能被裁掉
  s = reduceTranscript(s, { type: "message-end", message: user("下一条") })
  assert.ok(s.items.some((item) => item.kind === "user" && item.cid === "c1" && item.failed === "会话正忙"))

  s = reduce(s, { type: "drop", key: failed.key }, { type: "echo", text: "重试我", cid: "c2" })
  assert.equal(s.items.length, TRANSCRIPT_MAX_ITEMS)
  assert.equal(s.items.at(-1).cid, "c2")
  assert.equal(s.items.at(-1).status, "sending")
  assert.equal(s.items.some((item) => item.kind === "user" && item.cid === "c1"), false)
})

test("message-update-batch：并行工具的 start/delta/end 与正文增量按序应用", () => {
  let s = reduceTranscript(emptyTranscript(), { type: "message-start", message: { role: "assistant", content: [] } })
  s = reduceTranscript(s, {
    type: "message-update-batch",
    events: [
      { type: "text_start", contentIndex: 0 },
      { type: "toolcall_start", contentIndex: 1, id: "call-search", toolName: "search" },
      { type: "toolcall_start", contentIndex: 2, id: "call-read", toolName: "read" },
      { type: "text_delta", contentIndex: 0, delta: "先搜" },
      { type: "toolcall_delta", contentIndex: 1, delta: '{"query":' },
      { type: "toolcall_delta", contentIndex: 2, delta: '{"path":' },
      { type: "toolcall_delta", contentIndex: 1, delta: '"pi"}' },
      { type: "toolcall_delta", contentIndex: 2, delta: '"a.txt"}' },
      { type: "toolcall_end", toolCall: { id: "call-read", name: "read", arguments: { path: "a.txt" } } },
      { type: "text_delta", contentIndex: 0, delta: "，再读" },
    ],
  })

  const blocks = s.items.at(-1).blocks
  assert.deepEqual(blocks.map((block) => block.kind), ["text", "tool", "tool"])
  assert.equal(blocks[0].text, "先搜，再读")
  assert.equal(blocks[1].name, "search")
  assert.equal(blocks[1].argsText, '{"query":"pi"}')
  assert.equal(blocks[1].state, "input-streaming")
  assert.equal(blocks[2].name, "read")
  assert.equal(blocks[2].argsText, '{"path":"a.txt"}')
  assert.deepEqual(blocks[2].input, { path: "a.txt" })
  assert.equal(blocks[2].state, "input-available")

  // 整批都不匹配时原样返回（不制造无意义的新 state）；混入一帧不匹配时其余帧照常应用
  const ignored = reduceTranscript(s, {
    type: "message-update-batch",
    events: [{ type: "toolcall_delta", contentIndex: 9, delta: "junk" }],
  })
  assert.equal(ignored, s)
  const ended = reduceTranscript(s, {
    type: "message-update-batch",
    events: [
      { type: "toolcall_delta", contentIndex: 9, delta: "junk" },
      { type: "text_end", contentIndex: 0, content: "最终文本" },
    ],
  })
  assert.equal(ended.items.at(-1).blocks[0].text, "最终文本")
  assert.equal(ended.items.at(-1).blocks[1].argsText, '{"query":"pi"}')
})

test("批量流式提交不深拷贝历史 item：旧引用共享，旧 state 不被改写", () => {
  let s = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: pairMessages(20) })
  s = reduceTranscript(s, { type: "message-start", message: { role: "assistant", content: [] } })
  const before = s
  const beforeItems = s.items
  const liveBefore = beforeItems.at(-1)
  assert.equal(liveBefore.blocks.length, 0)

  const events = []
  for (let k = 0; k < 200; k += 1) events.push({ type: "text_delta", contentIndex: 0, delta: "x" })
  const next = reduceTranscript(before, { type: "message-update-batch", events })

  assert.notEqual(next, before)
  assert.notEqual(next.items, beforeItems)
  for (let k = 0; k < beforeItems.length - 1; k += 1) {
    assert.equal(next.items[k], beforeItems[k], `第 ${k} 条历史 item 必须是同一个对象引用`)
  }
  assert.equal(next.items.at(-1).blocks[0].text, "x".repeat(200))
  // immutable：旧 state 的 live 气泡没有被原地追加
  assert.equal(before.items.at(-1), liveBefore)
  assert.equal(liveBefore.blocks.length, 0)
  assert.equal(beforeItems.length, 41)
})

test("归约语义：usage/model、summary、custom 与工具补丁不被上限逻辑改变", () => {
  let s = reduceTranscript(emptyTranscript(), { type: "message-start", message: { role: "assistant", content: [] } })
  s = reduceTranscript(s, {
    type: "message-update-batch",
    events: [
      { type: "text_delta", contentIndex: 0, delta: "working" },
      { type: "toolcall_start", contentIndex: 1, id: "t1", toolName: "bash" },
    ],
  })
  s = reduceTranscript(s, { type: "tool", id: "t1", patch: { name: "bash", outputText: "42", state: "output-available" } })
  s = reduceTranscript(s, {
    type: "message-end",
    message: {
      role: "assistant",
      model: "m",
      usage: { totalTokens: 7, cost: { total: 0.1 } },
      stopReason: "toolUse",
      content: [
        { type: "text", text: "final" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "x" } },
      ],
    },
  })
  const answer = s.items.at(-1)
  assert.equal(answer.kind, "assistant")
  assert.equal(answer.live, false)
  assert.equal(answer.model, "m")
  assert.deepEqual(answer.usage, { totalTokens: 7, cost: { total: 0.1 } })
  assert.equal(answer.blocks[0].text, "final")
  assert.equal(answer.blocks[1].kind, "tool")
  assert.equal(answer.blocks[1].outputText, "42")
  assert.equal(answer.blocks[1].state, "output-available")
  assert.equal(s.liveKey, null)

  s = reduceTranscript(s, { type: "message-end", message: { role: "branchSummary", summary: "sum" } })
  s = reduceTranscript(s, {
    type: "message-end",
    message: { role: "custom", customType: "remote-bash", content: [{ type: "text", text: "c" }] },
  })
  assert.equal(s.items.at(-2).kind, "summary")
  assert.equal(s.items.at(-2).text, "sum")
  assert.equal(s.items.at(-1).kind, "custom")
  assert.equal(s.items.at(-1).label, "命令输出")
  assert.equal(s.items.at(-1).text, "c")

  // 用户 echo 仍会被权威 user 消息取代，不因新增上限/批量路径变成两条
  let echoed = reduceTranscript(emptyTranscript(), { type: "echo", text: "hi" })
  echoed = reduceTranscript(echoed, { type: "message-end", message: user("hi") })
  assert.equal(echoed.items.length, 1)
  assert.equal(echoed.items[0].echo, undefined)
})

test("按目录新建撞上已在运行的会话：先切房间再提示换目录，按 session 打开保持原行为", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  const beginAt = relay.indexOf("const beginHarness = useCallback")
  const beginEnd = relay.indexOf("const flushLazySend = useCallback", beginAt)
  assert.ok(beginAt > 0 && beginEnd > beginAt, "beginHarness 源码必须还在")
  const begin = relay.slice(beginAt, beginEnd)
  // P9 C（spec §5.1.4 / 远程 C3 探针回归）：新建会话的目录允许范围 = 白名单 projects ∪ 浏览根目录，
  // 只查 cwdInProjects 会把「在这台 Mac 上浏览到的新文件夹」拦下（红字「该目录不在允许列表」）。
  assert.match(begin, /if \(kind === "cwd" && !folderAllowed\(device, key\)\)/, "beginHarness 必须用 folderAllowed 预检")
  const statusAt = begin.indexOf('data?.status === "already_running"')
  assert.ok(statusAt > 0, "already_running 分支必须还在")
  const branch = begin.slice(statusAt, begin.indexOf("if (armingRef.current[deviceId]?.at !== at)", statusAt))
  const notice = "这个目录已有会话在运行，已切换到它；要新建会话请选择其他允许目录。"
  const escaped = notice.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  // 文案被 kind === "cwd" 明确保护，且仍先 openStarted 切到已有房间
  const guarded = new RegExp(`if \\(kind === "cwd"\\) \\{[^}]*?setNotice\\(\\{ text: "${escaped}", tone: "warn" \\}\\)`)
  assert.match(branch, guarded, "按目录新建撞上已有会话时必须显式提示，不能静默回旧会话")
  assert.ok(
    branch.indexOf("openStarted(String(data.roomId))") < branch.search(guarded),
    "提示之前仍要切到已有房间（selectRoom/openStarted）",
  )
  assert.doesNotMatch(
    branch,
    /if \(kind === "session"\) \{[^}]*?这个目录已有会话在运行/,
    "按 sessionId 打开保持既有行为，不显示换目录文案",
  )
})

test("设备掉线不清当前房间：名册里只有换了设备（wrongDevice）才 clearRoom，离线仍能看历史（L3 L18）", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  const at = relay.indexOf("function applyRoster(")
  const end = relay.indexOf("ws.onmessage = ", at)
  assert.ok(at > 0 && end > at, "applyRoster 源码必须还在")
  const roster = relay.slice(at, end)
  const rule = roster.match(/if \(roomRef\.current && !harnessing[^\n]*\) \{\n\s*clearRoom\(\)/)
  assert.ok(rule, "名册里清房间的条件必须还在")
  assert.match(rule[0], /&& wrongDevice\) \{/, "只在打开的房间不属于选中设备时清")
  assert.doesNotMatch(rule[0], /online/, "不再因为选中设备 !online 清房间")
  assert.equal((roster.match(/clearRoom\(\)/g) ?? []).length, 1, "名册里没有别的清房间路径")
})

test("ack 先按查询结案：dialog_answer 等 sendQuery 的帧收到 ack 不再等到超时误报（L3 L38）", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  const at = relay.indexOf('if (type === "ack") {')
  const end = relay.indexOf("channel.ack(msg)", at)
  assert.ok(at > 0 && end > at, "ack 分支必须还在")
  const branch = relay.slice(at, end)
  assert.match(branch, /if \(ackId && queriesRef\.current\.has\(ackId\)\) \{/, "ack 的 id 是在等的查询时先按查询处理")
  assert.match(branch, /settleQuery\(ackId, msg, null\)\n\s*return/, "ok 时按成功结案，不再交给命令通道")
  assert.match(branch, /msg\.ok === false\) settleQuery\(ackId, null, new RelayError\(/, "ok:false 时带原因拒绝")
  assert.ok(relay.indexOf('if (type === "ack") {') < relay.indexOf('if (type === "command_accepted") {'), "ack 仍在 room 过滤之前处理")
})

test("重连时当前房间还没上线：room_list 里它上线后补订阅（联动测试 L19）", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  // 新 socket 先清掉「这条 socket 上订阅过的房间」
  const authAt = relay.indexOf('if (type === "auth_result") {')
  assert.ok(authAt > 0)
  assert.match(relay.slice(authAt, authAt + 400), /socketRoomRef\.current = null/, "auth_result 成功时要清 socketRoomRef")
  // 真正发出 subscribe 帧的两处都要记下房间
  const sends = [...relay.matchAll(/ws\.send\(JSON\.stringify\((?:frame|resume \? \{ type: "subscribe")[^\n]*\n\s*socketRoomRef\.current = id/g)]
  assert.equal(sends.length, 2, "subscribe / sendResync 发帧后都要写 socketRoomRef")
  // room_list：当前房间在线、但这条 socket 没订阅过它 → 带 since 重订阅
  const listAt = relay.indexOf('if (type === "room_list") {')
  const list = relay.slice(listAt, relay.indexOf('if (type === "buffer_replay"', listAt))
  assert.match(list, /if \(current\?\.online && socketRoomRef\.current !== current\.id && !lazySessionRef\.current\) \{\s*(?:\/\/[^\n]*\n\s*)*subscribeRef\.current\(current\.id, true\)/)
})
