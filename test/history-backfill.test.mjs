// R2-5 / P3-7 长会话历史补拉：纯逻辑测试（history.ts 切窗/对齐/切片 + transcript prepend 归约）。
// 不启动浏览器、不依赖 React；Node 直接剥离 TS 类型 import .ts 源文件（与 ui-sync 同法）。
import test from "node:test"
import assert from "node:assert/strict"
import {
  chainInWindow,
  entriesToMessages,
  findAnchor,
  headFingerprints,
  isItemEntry,
  parseEntriesResult,
  slicePageBefore,
  windowStartOf,
} from "../ui/src/relay/history.ts"
import { backfillInfoOf, emptyTranscript, reduceTranscript, TRANSCRIPT_MAX_ITEMS } from "../ui/src/relay/transcript.ts"

/* ---------------- 造条目：一条带侧支的分支 ----------------
 * e1 user → e2 assistant(+tool) → e3 toolResult → e4 assistant → e5 user
 *   ├─ s1 user（侧支，parentId=e5，不在活动分支上）
 *   └─ e6 assistant → e7 user → e8 assistant（leaf）
 */
let ts = 1700000000000
const stamp = () => (ts += 1000)
const user = (id, parentId, text) => ({
  id, parentId, type: "message", timestamp: stamp(),
  message: { role: "user", content: [{ type: "text", text }], timestamp: ts },
})
const assistant = (id, parentId, text, tools = []) => ({
  id, parentId, type: "message", timestamp: stamp(),
  message: {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }] : []),
      ...tools.map((name, i) => ({ type: "toolCall", id: `${id}-tool${i}`, name, arguments: {} })),
    ],
    timestamp: ts,
  },
})
const toolResult = (id, parentId, toolCallId, text) => ({
  id, parentId, type: "message", timestamp: stamp(),
  message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], timestamp: ts },
})

const e1 = user("e1", null, "第一问：项目结构是什么？")
const e2 = assistant("e2", "e1", "我先看一下目录", ["bash"])
const e3 = toolResult("e3", "e2", "e2-tool0", "README.md src/")
const e4 = assistant("e4", "e3", "项目结构如上")
const e5 = user("e5", "e4", "第二问：怎么启动？")
const s1 = user("s1", "e5", "岔路问题（侧支）")
const e6 = assistant("e6", "e5", "启动命令是 npm run dev")
const e7 = user("e7", "e6", "第三问：怎么部署？")
const e8 = assistant("e8", "e7", "部署走脚本")
const ALL = [e1, e2, e3, e4, e5, s1, e6, e7, e8]
const fullResult = { entries: ALL, total: ALL.length, leafId: "e8" }

const itemText = (item) =>
  item.kind === "user" || item.kind === "summary" || item.kind === "custom"
    ? item.text
    : item.kind === "bash"
      ? item.command
      : item.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("")

test("回包整形：parseEntriesResult 只认 {entries,total,leafId}", () => {
  assert.deepEqual(parseEntriesResult({ entries: [], total: 0, leafId: null }), { entries: [], total: 0, leafId: null })
  assert.equal(parseEntriesResult({ entries: "x" }), null)
  assert.equal(parseEntriesResult(null), null)
  assert.equal(parseEntriesResult([1, 2]), null)
})

test("分支链：沿 parentId 回溯，侧支条目自动排除，下标与全量对齐", () => {
  const chain = chainInWindow(fullResult, "e8")
  assert.deepEqual(chain.map((c) => c.id), ["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8"])
  assert.deepEqual(chain.map((c) => c.index), [0, 1, 2, 3, 4, 6, 7, 8])
})

test("分支链：窗口只覆盖尾部时在窗口边缘停住，起点下标由 total 推得", () => {
  const tail = { entries: [e6, e7, e8], total: 100, leafId: "e8" }
  assert.equal(windowStartOf(tail), 97)
  const chain = chainInWindow(tail, "e8")
  assert.deepEqual(chain.map((c) => c.id), ["e6", "e7", "e8"])
  assert.deepEqual(chain.map((c) => c.index), [97, 98, 99])
  assert.deepEqual(chainInWindow(tail, "e5"), [])
})

test("条目→消息转换：与扩展 mirrorMessages 同口径", () => {
  const entries = [
    { id: "c1", parentId: null, type: "custom_message", customType: "remote-bash", content: [{ type: "text", text: "ls 输出" }], timestamp: 1000 },
    { id: "c2", parentId: "c1", type: "compaction", summary: "压缩摘要", tokensBefore: 1234, timestamp: 2000 },
    { id: "c3", parentId: "c2", type: "branch_summary", summary: "分支摘要", timestamp: 3000 },
    { id: "c4", parentId: "c3", type: "message", message: { role: "system", content: "hidden" } },
    toolResult("c5", "c4", "x-tool0", "结果"),
    { id: "c6", parentId: "c5", type: "thinking_level_change", thinkingLevel: "high" },
  ]
  const messages = entriesToMessages(entries)
  assert.deepEqual(messages.map((m) => m.role), ["custom", "compactionSummary", "branchSummary", "toolResult"])
  assert.equal(messages[0].customType, "remote-bash")
  assert.equal(messages[1].tokensBefore, 1234)
  assert.equal(isItemEntry(entries[0]), true)
  assert.equal(isItemEntry({ ...entries[0], display: false }), false)
  assert.equal(isItemEntry(entries[4]), false) // toolResult 不自成条目
  assert.equal(isItemEntry(entries[5]), false) // thinking_level_change 不进镜像
})

test("指纹对齐：转录头部在分支链里定位到首个游标", () => {
  const heldMessages = entriesToMessages([e5, e6, e7, e8])
  let state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: heldMessages })
  assert.equal(state.items.length, 4)
  const head = headFingerprints(state.items)
  assert.equal(head.length, 4)
  const chain = chainInWindow(fullResult, "e8")
  const hit = findAnchor(chain, head)
  assert.ok(hit)
  assert.equal(hit.id, "e5")
  assert.equal(hit.index, 4)
})

test("指纹对齐：对不齐返回 null（不硬凑游标）", () => {
  const other = entriesToMessages([user("x1", null, "完全无关的问题"), assistant("x2", "x1", "无关回答")])
  const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: other })
  const chain = chainInWindow(fullResult, "e8")
  assert.equal(findAnchor(chain, headFingerprints(state.items)), null)
})

test("分页切片：分界落在可见条目上，toolResult 跟着它的助手条目同片", () => {
  const chain = chainInWindow(fullResult, "e8")
  const page1 = slicePageBefore(chain, "e5", 2)
  assert.equal(page1.itemCount, 2)
  assert.deepEqual(page1.messages.map((m) => m.role), ["assistant", "toolResult", "assistant"])
  assert.equal(page1.oldest.id, "e2")
  assert.equal(page1.reachedRoot, false)

  const page2 = slicePageBefore(chain, "e2", 2)
  assert.deepEqual(page2.messages.map((m) => m.role), ["user"])
  assert.equal(page2.oldest.id, "e1")
  assert.equal(page2.reachedRoot, true)

  // 两页条目集合不重叠，合起来 + 已加载段 = 整条链（去重/无洞的分区实证）
  const pageIds = new Set([...page1.messages, ...page2.messages].map((m) => m))
  assert.equal(pageIds.size, 4)
})

test("分页切片：游标已在根部 → reachedRoot 且空片（到底终止）", () => {
  const chain = chainInWindow(fullResult, "e8")
  const slice = slicePageBefore(chain, "e1", 60)
  assert.equal(slice.messages.length, 0)
  assert.equal(slice.reachedRoot, true)
})

test("分页切片：窗口边缘截断时 windowBounded，提示调用方扩窗", () => {
  const tail = { entries: [e6, e7, e8], total: 9, leafId: "e8" }
  const chain = chainInWindow(tail, "e8") // 链只到 e6，其 parent e5 在窗外
  const atHead = slicePageBefore(chain, "e6", 2)
  assert.equal(atHead.messages.length, 0)
  assert.equal(atHead.windowBounded, true)
  assert.equal(atHead.reachedRoot, false)
  const before7 = slicePageBefore(chain, "e7", 2)
  assert.equal(before7.itemCount, 1)
  assert.equal(before7.windowBounded, true) // 只拿到 1 条 < 页大小 2，且链在窗外还有
})

test("prepend 归约：旧片前置并入，顺序与快照全量重建一致，工具结果补到片内卡片", () => {
  const chain = chainInWindow(fullResult, "e8")
  const heldMessages = entriesToMessages([e5, e6, e7, e8])
  let state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: heldMessages })
  const page1 = slicePageBefore(chain, "e5", 2)
  state = reduceTranscript(state, { type: "prepend", messages: page1.messages })
  const page2 = slicePageBefore(chain, "e2", 2)
  state = reduceTranscript(state, { type: "prepend", messages: page2.messages })
  assert.deepEqual(state.items.map(itemText), [
    "第一问：项目结构是什么？",
    "我先看一下目录",
    "项目结构如上",
    "第二问：怎么启动？",
    "启动命令是 npm run dev",
    "第三问：怎么部署？",
    "部署走脚本",
  ])
  const toolItem = state.items.find((item) => item.kind === "assistant" && itemText(item) === "我先看一下目录")
  const toolBlock = toolItem.blocks.find((b) => b.kind === "tool")
  assert.ok(toolBlock && toolBlock.outputText.includes("README.md"))
  // 无重复：每条可见文本恰一份
  const texts = state.items.map(itemText)
  assert.equal(new Set(texts).size, texts.length)
})

test("prepend 归约：补拉期间新消息落尾不乱序，live 气泡不被片内消息误伤", () => {
  const chain = chainInWindow(fullResult, "e8")
  const heldMessages = entriesToMessages([e5, e6, e7, e8])
  const pending = { role: "assistant", content: [{ type: "text", text: "正在生成" }], stopReason: "pending", timestamp: ts + 5000 }
  let state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [...heldMessages, pending] })
  const liveItem = state.items[state.items.length - 1]
  assert.equal(liveItem.kind === "assistant" && liveItem.live, true)

  const page1 = slicePageBefore(chain, "e5", 2)
  state = reduceTranscript(state, { type: "prepend", messages: page1.messages })
  const tail = state.items[state.items.length - 1]
  assert.equal(tail.kind === "assistant" && tail.live, true)
  assert.equal(itemText(tail), "正在生成")

  // 流式定稿：message-end 取代 live 气泡（不新增重复条）
  const before = state.items.length
  state = reduceTranscript(state, {
    type: "message-end",
    message: { role: "assistant", content: [{ type: "text", text: "第四答" }], timestamp: ts + 9000 },
  })
  assert.equal(state.items.length, before)
  assert.equal(itemText(state.items[state.items.length - 1]), "第四答")
})

test("prepend 归约：空片 / 空转录都是无操作", () => {
  const heldMessages = entriesToMessages([e5, e6, e7, e8])
  const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: heldMessages })
  assert.equal(reduceTranscript(state, { type: "prepend", messages: [] }), state)
  const empty = emptyTranscript()
  assert.equal(reduceTranscript(empty, { type: "prepend", messages: heldMessages }), empty)
})

test("trim 吃补拉页有账可查（B-6）：trimmed 增长，且被吃段可从新头部重新补回、无静默洞", () => {
  // 一条全可见的长链：条数超过转录上限，快照只能装下尾部 MAX 条，头部靠补拉
  const EXTRA = 130
  const total = TRANSCRIPT_MAX_ITEMS + EXTRA
  const base = 1700000000000
  const entries = []
  for (let i = 0; i < total; i += 1) {
    const role = i % 2 === 0 ? "user" : "assistant"
    entries.push({
      id: `m${i}`,
      parentId: i ? `m${i - 1}` : null,
      type: "message",
      timestamp: base + i * 1000,
      message: { role, content: [{ type: "text", text: `第 ${i} 条` }], timestamp: base + i * 1000 },
    })
  }
  const result = { entries, total, leafId: `m${total - 1}` }
  const chain = chainInWindow(result, result.leafId)

  // 快照 = 尾部 MAX 条（m130 起），恰好装满、自身不触发 trim
  let state = reduceTranscript(emptyTranscript(), {
    type: "snapshot",
    messages: entriesToMessages(entries.slice(EXTRA)),
  })
  assert.equal(state.items.length, TRANSCRIPT_MAX_ITEMS)
  assert.deepEqual(backfillInfoOf(state), { head: 0, trimmed: 0 })

  // 补拉两页（每页 60）：游标 m130 → m70 → m10，头部账记 120
  const anchor = findAnchor(chain, headFingerprints(state.items))
  assert.equal(anchor.id, `m${EXTRA}`)
  const page1 = slicePageBefore(chain, anchor.id, 60)
  state = reduceTranscript(state, { type: "prepend", messages: page1.messages })
  const page2 = slicePageBefore(chain, page1.oldest.id, 60)
  state = reduceTranscript(state, { type: "prepend", messages: page2.messages })
  assert.equal(state.items.length, TRANSCRIPT_MAX_ITEMS + 120)
  assert.deepEqual(backfillInfoOf(state), { head: 120, trimmed: 0 })
  assert.equal(itemText(state.items[0]), "第 10 条")

  // 一条实时消息落尾触发 trim：从头部砍 121 条 = 两页补拉（120）+ 快照首条
  state = reduceTranscript(state, {
    type: "append",
    messages: [{ role: "user", content: [{ type: "text", text: "新消息" }], timestamp: base + total * 1000 }],
  })
  assert.equal(state.items.length, TRANSCRIPT_MAX_ITEMS)
  // 被吃掉的补拉条数有账：useRelay 盯 trimmed 增长作废游标（不再静默留洞）
  assert.deepEqual(backfillInfoOf(state), { head: 0, trimmed: 120 })
  assert.equal(itemText(state.items[0]), `第 ${EXTRA + 1} 条`)

  // 游标作废后从当前头部重新对齐：锚点落在新首条 m131，它之前的一页正含被吃段——可补回
  const hit = findAnchor(chain, headFingerprints(state.items))
  assert.equal(hit.id, `m${EXTRA + 1}`)
  const refill = slicePageBefore(chain, hit.id, 60)
  const refillTexts = refill.messages.map((m) => m.content[0].text)
  assert.ok(refillTexts.includes("第 100 条"), "被 trim 吃掉的补拉条目（第 100 条）在重拉页里")
  assert.ok(refillTexts.includes(`第 ${EXTRA} 条`), "被吃掉的快照首条也在重拉页里")
  assert.equal(refill.oldest.id, `m${EXTRA + 1 - 60}`)
})
