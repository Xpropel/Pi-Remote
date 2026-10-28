// UI·perf 中-3（bash-delta 批处理 + 单条输出上限）/ 中-4（prepend 补拉硬顶 + 字节账增量）的纯逻辑回归。
// 不启动浏览器、不依赖 React；Node ≥22.18 直接剥离 TS 类型 import .ts 源文件（与 history-backfill 同法）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  BASH_OUTPUT_MAX_CHARS,
  SNAPSHOT_CONTENT_BLOCKS_MAX,
  SNAPSHOT_IMAGES_MAX,
  SNAPSHOT_TASKS_MAX,
  backfillInfoOf,
  bashOutputTail,
  emptyTranscript,
  estimateItemBytes,
  imagesOf,
  reduceTranscript,
  textOf,
  TRANSCRIPT_BACKFILL_MAX_BYTES,
  TRANSCRIPT_BACKFILL_MAX_ITEMS,
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_MAX_ITEMS,
} from "../ui/src/relay/transcript.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

let ts = 1700000000000
const stamp = () => (ts += 1000)
const user = (text = "问题") => ({ role: "user", content: [{ type: "text", text }], timestamp: stamp() })
const bashExecution = (output, command = "ls") => ({ role: "bashExecution", command, output, exitCode: 0, timestamp: stamp() })
const totalBytes = (state) => state.items.reduce((sum, item) => sum + estimateItemBytes(item), 0)
const bashItems = (state) => state.items.filter((item) => item.kind === "bash")

describe("中-3：bash 输出单条上限（尾部保留）+ 合批 action", () => {
  test("bashOutputTail：短输出原样（同一个字符串），长输出只留尾部且长度封顶", () => {
    const short = "abc"
    assert.equal(bashOutputTail(short), short)
    const long = "x".repeat(BASH_OUTPUT_MAX_CHARS + 5000)
    const tail = bashOutputTail(long)
    assert.equal(tail.length, BASH_OUTPUT_MAX_CHARS)
    assert.equal(tail, long.slice(5000), "留的是尾部（最新输出）")
    assert.equal(long.endsWith(tail), true)
  })

  test("bash-delta：逐帧拼接照旧；单帧超长时输出被尾部截断，条数/字节账不再被单条撑爆", () => {
    let state = reduceTranscript(emptyTranscript(), { type: "bash-delta", delta: "第一行\n" })
    assert.equal(bashItems(state).length, 1)
    assert.equal(bashItems(state)[0].output, "第一行\n")
    state = reduceTranscript(state, { type: "bash-delta", delta: "第二行\n" })
    assert.equal(bashItems(state)[0].output, "第一行\n第二行\n")

    const huge = "y".repeat(BASH_OUTPUT_MAX_CHARS + 1000)
    state = reduceTranscript(state, { type: "bash-delta", delta: huge })
    assert.equal(bashItems(state)[0].output.length, BASH_OUTPUT_MAX_CHARS)
    assert.equal(bashItems(state)[0].output, huge.slice(0, BASH_OUTPUT_MAX_CHARS + 1000).slice(-BASH_OUTPUT_MAX_CHARS))
    assert.ok(totalBytes(state) < TRANSCRIPT_MAX_BYTES, "单条 bash 输出受限后整份转录的字节账在全局上限内")
  })

  test("bash-delta-batch：一批等价于逐条 bash-delta，且只产出一条“输出”气泡", () => {
    const parts = ["a\n", "", "b\n", "c"]
    let step = emptyTranscript()
    for (const delta of parts) step = reduceTranscript(step, { type: "bash-delta", delta })
    const batch = reduceTranscript(emptyTranscript(), { type: "bash-delta-batch", deltas: parts })
    assert.deepEqual(batch.items, step.items)
    assert.equal(bashItems(batch).length, 1)
    assert.equal(bashItems(batch)[0].output, "a\nb\nc")
    const empty = emptyTranscript()
    assert.equal(reduceTranscript(empty, { type: "bash-delta-batch", deltas: [] }), empty, "空批次 = 无操作")
  })

  test("bash-delta-batch：接在已有的“输出”气泡上、并同样按尾部封顶", () => {
    let state = reduceTranscript(emptyTranscript(), { type: "bash-delta", delta: "头\n" })
    const huge = "z".repeat(BASH_OUTPUT_MAX_CHARS + 10)
    state = reduceTranscript(state, { type: "bash-delta-batch", deltas: ["中\n", huge] })
    const output = bashItems(state)[0].output
    assert.equal(output.length, BASH_OUTPUT_MAX_CHARS)
    assert.equal(output.endsWith(huge.slice(-10)), true)
  })

  test("落定的 bashExecution 输出同样按尾部封顶（流式封了顶，定稿不能把整份塞回来）", () => {
    const huge = "q".repeat(BASH_OUTPUT_MAX_CHARS + 700)
    const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [bashExecution(huge)] })
    const [item] = bashItems(state)
    assert.equal(item.output.length, BASH_OUTPUT_MAX_CHARS)
    assert.equal(item.output, huge.slice(-BASH_OUTPUT_MAX_CHARS))
  })

  test("useRelay 侧的合批接线（中-3 的另一半）留在 useRelay.ts，这里锁住 reducer 已具备的 action 契约", () => {
    const src = code(read("ui/src/relay/transcript.ts"))
    assert.match(src, /type: "bash-delta-batch"; deltas: string\[\]/)
    assert.match(src, /case "bash-delta-batch"/)
    assert.match(src, /bashOutputTail\(item\.output \+ delta\)/)
    // 单条上限与尾部保留：裁剪逻辑仍把 bash 现场当保护区，所以必须有单条硬顶才能收敛
    assert.match(src, /function trimTranscript\(d: Draft, itemsMax: number = TRANSCRIPT_MAX_ITEMS, bytesMax: number = TRANSCRIPT_MAX_BYTES\)/)
  })
})

describe("中-4：prepend 补拉硬顶 + 增量字节账", () => {
  test("额度常量：补拉额度高于常规上限，且高于单页 300 条", () => {
    assert.ok(TRANSCRIPT_BACKFILL_MAX_ITEMS > TRANSCRIPT_MAX_ITEMS)
    assert.ok(TRANSCRIPT_BACKFILL_MAX_ITEMS - TRANSCRIPT_MAX_ITEMS >= 300 * 5)
    assert.ok(TRANSCRIPT_BACKFILL_MAX_BYTES > TRANSCRIPT_MAX_BYTES)
  })

  test("补拉一页（量在额度内）不裁：条目照旧前置、补拉账 head 增加、trimmed 不动", () => {
    const held = [user("第二问"), bashExecution("README.md"), user("第三问")]
    let state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: held })
    const before = state.items.length
    state = reduceTranscript(state, { type: "prepend", messages: [user("第一问")] })
    assert.equal(state.items.length, before + 1)
    assert.equal(state.items[0].kind, "user")
    assert.deepEqual(backfillInfoOf(state), { head: 1, trimmed: 0 })
  })

  test("补拉把总量推过补拉字节额度：在头部回收，补拉账 trimmed 记账（游标可重新补拉）", () => {
    const held = [user("尾部消息")]
    let state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: held })
    // 一页塞进超过补拉额度的正文（UTF-16 估算 2 字节/字符）
    const huge = "巨".repeat(Math.floor(TRANSCRIPT_BACKFILL_MAX_BYTES / 2) + 1000)
    state = reduceTranscript(state, { type: "prepend", messages: [user(huge)] })
    assert.equal(state.items.length, 1, "超额度的那一页被头部回收")
    assert.ok(backfillInfoOf(state).trimmed >= 1, "被吃掉的补拉页记进 trimmed")
    assert.ok(totalBytes(state) <= TRANSCRIPT_BACKFILL_MAX_BYTES)
  })

  test("字节账是增量的也要对得上：prepend 之后触发常规 trim，按真实字节和裁到全局上限内", () => {
    // snapshot 就有 9 条 × 1.2MB 正文：按字节账裁到全局上限内，真实字节和必须跟着落回上限
    const chunk = "甲".repeat(600_000) // ≈ 1.2MB
    const held = Array.from({ length: 9 }, () => user(chunk))
    let state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: held })
    assert.ok(state.items.length < 9, "越过 8MB 的头部条目被裁掉")
    assert.ok(totalBytes(state) <= TRANSCRIPT_MAX_BYTES)
    // 补拉额度内（8MB + 4MB）：一页页补进来不会立刻被裁；越过额度后在头部回收
    let more = state
    for (let i = 0; i < 6; i += 1) more = reduceTranscript(more, { type: "prepend", messages: [user(chunk)] })
    assert.ok(totalBytes(more) <= TRANSCRIPT_BACKFILL_MAX_BYTES)
    assert.ok(backfillInfoOf(more).trimmed > 0)
    // 真实字节和与增量账一致：再用常规上限触发一次 trim，剩余量必须落回 TRANSCRIPT_MAX_BYTES 内
    const trimmed = reduceTranscript(more, { type: "append", messages: [user("收尾")] })
    assert.ok(totalBytes(trimmed) <= TRANSCRIPT_MAX_BYTES)
  })
})

// UI 低危 18：四个快照解析器（textOf / imagesOf / blocksFromContent / toolTasksOf）原来没有条数上限，
// 异常大的快照消息会在 trimTranscript 之前整段展开；这里按同仓其它解析器的口径补上封顶。
describe("UI 低危 18：快照解析器的条数上限", () => {
  test("textOf：只取前 SNAPSHOT_CONTENT_BLOCKS_MAX 个内容块，超出的尾部不再 join", () => {
    const content = Array.from({ length: SNAPSHOT_CONTENT_BLOCKS_MAX + 5 }, (_, index) => ({ type: "text", text: `t${index}` }))
    const text = textOf(content)
    const lines = text.split("\n")
    assert.equal(lines.length, SNAPSHOT_CONTENT_BLOCKS_MAX)
    assert.equal(lines[0], "t0")
    assert.equal(lines[lines.length - 1], `t${SNAPSHOT_CONTENT_BLOCKS_MAX - 1}`)
    // 小数组行为不变（含空串过滤、字符串直通）
    assert.equal(textOf([{ type: "text", text: "a" }, { type: "text", text: "" }, { type: "text", text: "b" }]), "a\nb")
    assert.equal(textOf("纯字符串"), "纯字符串")
  })

  test("imagesOf：单条消息最多解析 SNAPSHOT_IMAGES_MAX 张图", () => {
    const content = Array.from({ length: SNAPSHOT_IMAGES_MAX + 3 }, () => ({ type: "image", mimeType: "image/png", data: "QUJD" }))
    const images = imagesOf(content)
    assert.equal(images.length, SNAPSHOT_IMAGES_MAX)
    assert.equal(images[0].mimeType, "image/png")
    // 图片块夹在海量文本块后面：最多只扫 SNAPSHOT_CONTENT_BLOCKS_MAX 个块
    const behind = Array.from({ length: SNAPSHOT_CONTENT_BLOCKS_MAX + 1 }, () => ({ type: "text", text: "x" }))
    behind.push({ type: "image", mimeType: "image/png", data: "QUJD" })
    assert.deepEqual(imagesOf(behind), [], "超出块上限的图片不再解析")
  })

  test("助手快照：content 块数封顶，尾部块被丢弃而不是整段展开", () => {
    const content = Array.from({ length: SNAPSHOT_CONTENT_BLOCKS_MAX + 3 }, (_, index) => ({ type: "text", text: `b${index}` }))
    const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [{ role: "assistant", content, timestamp: stamp(), model: "m" }] })
    const item = state.items[0]
    assert.equal(item.kind, "assistant")
    assert.equal(item.blocks.length, SNAPSHOT_CONTENT_BLOCKS_MAX)
    assert.equal(item.blocks[item.blocks.length - 1].text, `b${SNAPSHOT_CONTENT_BLOCKS_MAX - 1}`)
  })

  test("toolResult 快照：tasks 条数封顶（异常大的任务清单不整份进状态）", () => {
    const tasks = Array.from({ length: SNAPSHOT_TASKS_MAX + 10 }, (_, index) => ({ content: `任务 ${index}`, status: "pending" }))
    const message = {
      role: "toolResult",
      toolName: "todo",
      content: [{ type: "text", text: "ok" }],
      details: { tasks },
      isError: false,
      timestamp: stamp(),
    }
    const state = reduceTranscript(emptyTranscript(), { type: "snapshot", messages: [message] })
    const block = state.items[0].blocks[0]
    assert.equal(block.kind, "tool")
    assert.equal(block.tasks.length, SNAPSHOT_TASKS_MAX)
    assert.equal(block.tasks[block.tasks.length - 1].content, `任务 ${SNAPSHOT_TASKS_MAX - 1}`)
  })
})
