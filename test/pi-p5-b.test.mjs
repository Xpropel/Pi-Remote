// P5 b 线（PLAN 5.4，R2/p5-lanes.md §5 b）：对话流 / 审批卡 / 右 pane 容器用的纯函数，加几条源码契约检查。
// 数据用 live fixture 的原始字段（ui/src/pi/dev/fixtures/shared.ts），由真实函数算。界面本身在 #/live 上由 L2 截图和
// R2/tools/interact-cases/p5-b.mjs（灯箱、取原图、审批应答、pane）验，不在这里。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TURN_ERROR_RAW_MAX, turnErrorKindOf, turnErrorOf } from "../ui/src/pi/model/turnError.ts"
import {
  archiveTopLinesOf,
  EMPTY_THINKING_CLOCK,
  historyTopLineOf,
  liveExpandedOf,
  observeThinking,
  outboxItemsOf,
  piItemsOf,
  runningOf,
  subagentsOf,
  thinkingKey,
  turnStartOf,
  turnTextOf,
} from "../ui/src/pi/model/transcriptView.ts"
import { changesViewOf, foldRowsOf } from "../ui/src/pi/model/changesView.ts"
import { changesOfSession } from "../ui/src/pi/model/changes.ts"
import { fileErrorTextOf, fileImageSrcOf, fileKindOf, filePayloadOf } from "../ui/src/pi/model/filePayload.ts"
import { approvalEndedOf, approvalReceiptOf } from "../ui/src/pi/model/approvalReceipt.ts"
import { dialogCardState } from "../ui/src/pi/model/dialogCard.ts"
import {
  AGENTS,
  APPROVAL_DIALOG,
  CONVERSATION_PATH,
  CONVO_APPROVAL,
  CONVO_DONE,
  CONVO_ERRORS,
  KEYBOARD_TEST_PATH,
  LIVE_TEST_ID,
  R1_ITEMS,
  R1_STREAMING_ITEMS,
  VIEWPORT_PATH,
} from "../ui/src/pi/dev/fixtures/shared.ts"
import { MOCK_NOW } from "../ui/src/pi/dev/fixtures/types.ts"
import { FILE_RESULT } from "../ui/src/pi/dev/fixtures/live/file-pane.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
const S = 1000
const M = 60 * S

describe("model/turnError.ts：回合出错的原文对中文（stream-errors，D18）", () => {
  test("overloaded_error → 服务繁忙，原文放括号里（和画廊屏同一句）", () => {
    assert.deepEqual(turnErrorOf("error", "overloaded_error"), { text: "这一轮出错了：服务繁忙（overloaded_error）", error: true })
  })
  test("整段原文里认出类型：短的照写原文，长的（JSON）只写类型", () => {
    assert.equal(turnErrorKindOf('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), "overloaded_error")
    const long = `529 ${JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "x".repeat(80) } })}`
    assert.ok(long.length > TURN_ERROR_RAW_MAX)
    assert.equal(turnErrorOf("error", long).text, "这一轮出错了：请求太频繁（rate_limit_error）")
    assert.equal(turnErrorOf("error", "Overloaded").text, "这一轮出错了：服务繁忙（Overloaded）")
  })
  test("上下文溢出（lane-mock M11）：OpenAI 兼容的 context_length_exceeded 和 Anthropic 的 prompt is too long 都写「上下文超出模型上限」", () => {
    const openai = `400: ${JSON.stringify({ type: "context_length_exceeded", code: "context_length_exceeded", message: "This model's maximum context length is 128000 tokens." })}`
    assert.equal(turnErrorOf("error", openai).text, "这一轮出错了：上下文超出模型上限（context_length_exceeded）")
    const anthropic = `400 ${JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 210000 tokens > 200000 maximum" } })}`
    assert.equal(turnErrorKindOf(anthropic), "context_length_exceeded")
    assert.equal(turnErrorKindOf('400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'), "invalid_request_error")
  })
  test("lane-real F-R2：打断导致的 error + AbortSignal 原文按停止写，不报「出错了」", () => {
    assert.deepEqual(turnErrorOf("error", "This operation was aborted"), { text: "已停止生成", error: false })
    assert.deepEqual(turnErrorOf("error", "Request was aborted."), { text: "已停止生成", error: false })
    assert.equal(turnErrorOf("error", "upstream aborted the stream unexpectedly").error, true)
  })
  test("认不出的原文照写（太长截短）；没有原文写「未知原因」，不编", () => {
    assert.equal(turnErrorOf("error", "socket hang up").text, "这一轮出错了：socket hang up")
    assert.equal(turnErrorOf("error", "y".repeat(100)).text, `这一轮出错了：${"y".repeat(TURN_ERROR_RAW_MAX)}…`)
    assert.equal(turnErrorOf("error", "").text, "这一轮出错了：未知原因")
    assert.equal(turnErrorOf("error", undefined).error, true)
  })
  test("停止 / 长度是灰字，正常结束没有这一行", () => {
    assert.deepEqual(turnErrorOf("aborted"), { text: "已停止生成", error: false })
    assert.deepEqual(turnErrorOf("length"), { text: "达到长度上限，回复被截断", error: false })
    assert.equal(turnErrorOf("stop"), null)
    assert.equal(turnErrorOf("toolUse"), null)
    assert.equal(turnErrorOf(undefined), null)
  })
  test("流里的 PiTurnError 用的就是它（components/pi/conversation/tools.ts 的 stopReasonText 委托过来，一套口径）", () => {
    const src = code(read("ui/src/components/pi/conversation/tools.ts"))
    assert.match(src, /return turnErrorOf\(stopReason, errorMessage\)/)
    assert.doesNotMatch(src, /overloaded_error/)
  })
})

describe("model/transcriptView.ts：转录 → PiTranscript", () => {
  test("压缩摘要的收据行写「已压缩上下文」（D19；lane-mock M13），分支摘要不动", () => {
    const [c, b] = piItemsOf([
      { kind: "summary", key: "s1", title: "已折叠早期对话", text: "摘要" },
      { kind: "summary", key: "s2", title: "分支摘要", text: "摘要" },
    ])
    assert.equal(c.title, "已压缩上下文")
    assert.equal(b.title, "分支摘要")
  })
  test("piItemsOf：edit 的 patch 进 diff 卡（details.patch，G5）；write 没有 patch 原样；没改的条目是同一个对象", () => {
    const items = piItemsOf(R1_ITEMS)
    const blocks = items.flatMap((x) => (x.kind === "assistant" ? x.blocks : []))
    const edit = blocks.find((b) => b.kind === "tool" && b.id === "toolu_01Kp2q")
    assert.ok(edit.details.patch.startsWith(`--- ${VIEWPORT_PATH}`))
    const write = blocks.find((b) => b.kind === "tool" && b.id === "toolu_01W3n8")
    assert.equal(write.details, undefined)
    assert.equal(items[0], R1_ITEMS[0], "用户条目原样")
    const noPatch = R1_ITEMS.findIndex((x) => x.kind === "assistant" && x.blocks.every((b) => b.kind !== "tool" || !b.patch))
    assert.equal(items[noPatch], R1_ITEMS[noPatch])
  })
  test("piItemsOf：观测到的思考时长写进思考块（observedMs）；没观测到的不写", () => {
    const key = thinkingKey("a-r1-47", 0)
    const items = piItemsOf(CONVO_DONE, new Map([[key, 6 * S]]))
    assert.equal(items[1].blocks[0].observedMs, 6 * S)
    assert.equal(piItemsOf(CONVO_DONE)[1].blocks[0].observedMs, undefined)
  })
  test("运行行：从最后一条用户消息算起；回合不在跑没有；有卡在等你时不画行（line false）", () => {
    assert.equal(turnStartOf(R1_STREAMING_ITEMS), MOCK_NOW - 42 * S)
    assert.deepEqual(runningOf(R1_STREAMING_ITEMS, true, false), { since: MOCK_NOW - 42 * S, line: true })
    assert.deepEqual(runningOf(CONVO_APPROVAL, true, true), { since: MOCK_NOW - 190 * S, line: false })
    assert.equal(runningOf(R1_ITEMS, false, false), null)
    const noStamp = [{ kind: "user", key: "u", text: "hi", images: [] }]
    assert.deepEqual(runningOf(noStamp, true, false), { since: null, line: true }, "没有时间戳不编用时")
  })
  test("默认展开（推断，同 replica 各屏）：运行中 = 本回合思考块 + 在跑的终端卡；pane 开着 / 等你回答时不展开", () => {
    assert.deepEqual(liveExpandedOf(R1_STREAMING_ITEMS, { running: true, waiting: false, paneOpen: false }), ["a-r1-51:0", LIVE_TEST_ID])
    assert.deepEqual(liveExpandedOf(R1_STREAMING_ITEMS, { running: true, waiting: false, paneOpen: true }), [])
    assert.deepEqual(liveExpandedOf(CONVO_APPROVAL, { running: true, waiting: true, paneOpen: false }), [])
  })
  test("默认展开：回合结束后，最近一个有回复的回合里失败的终端卡展开（拒绝 / 超时只是灰字行，不算）", () => {
    assert.deepEqual(liveExpandedOf(CONVO_ERRORS, { running: false, waiting: false, paneOpen: false }), ["toolu_03Bs1a"])
    assert.deepEqual(liveExpandedOf(R1_ITEMS, { running: false, waiting: false, paneOpen: false }), [])
  })
  test("subagent 行：只要排队 / 在跑、有开始时间的 agent_state 条目；没有上报就是空", () => {
    assert.deepEqual(subagentsOf(AGENTS), [{ name: "explorer", task: "梳理 useMobileViewport 的调用方", startedAt: MOCK_NOW - 36 * S }])
    assert.deepEqual(subagentsOf([{ ...AGENTS[0], status: "succeeded" }]), [])
    assert.deepEqual(subagentsOf([]), [])
    assert.deepEqual(subagentsOf(undefined), [])
  })
  test("思考时长观测：第一次看到时已经在想的不计；之后从无到有开始计，不再是活动尾部时结束", () => {
    const thinking = (live, extra = []) => [
      { kind: "user", key: "u1", text: "q", images: [], timestamp: 1 },
      { kind: "assistant", key: "a1", live, blocks: [{ kind: "thinking", text: "**想**\n\n正文" }, ...extra] },
    ]
    const first = observeThinking(EMPTY_THINKING_CLOCK, thinking(true), 1000)
    assert.equal(first.started, true)
    assert.ok(first.skip.has("a1:0"), "打开页面时已经在想：不计")
    const ended = observeThinking(first, thinking(true, [{ kind: "text", text: "答" }]), 5000)
    assert.equal(ended.done.size, 0)
    // 新的一条消息里的思考：从无到有
    const base = observeThinking(EMPTY_THINKING_CLOCK, [], 0)
    const items1 = thinking(true)
    const started = observeThinking(base, items1, 10_000)
    assert.equal(started.open.get("a1:0"), 10_000)
    assert.equal(observeThinking(started, items1, 11_000), started, "没变化返回同一个对象")
    const done = observeThinking(started, thinking(true, [{ kind: "text", text: "答" }]), 16_000)
    assert.equal(done.done.get("a1:0"), 6000)
    assert.equal(done.open.size, 0)
    // lane-real F-R1：起止落在秒级时钟的同一拍（时差 0）也算观测到，记 1ms → "思考 1 秒"，不退回"已思考"
    const quick = observeThinking(observeThinking(base, items1, 20_000), thinking(true, [{ kind: "text", text: "答" }]), 20_000)
    assert.equal(quick.done.get("a1:0"), 1)
  })
  test("流顶（D02）：补拉 more / loading / error / 到顶；别的房间不显示", () => {
    const h = (status, truncated = true) => ({ room: "r-s6", status, error: "", truncated })
    assert.deepEqual(historyTopLineOf(h("error"), "r-s6"), { text: "更早的消息加载失败", action: "load-earlier", actionText: "重试" })
    assert.deepEqual(historyTopLineOf(h("more"), "r-s6"), { text: "更早的消息还没加载", action: "load-earlier", actionText: "加载" })
    assert.equal(historyTopLineOf(h("loading"), "r-s6").spinner, true)
    assert.deepEqual(historyTopLineOf(h("done"), "r-s6"), { text: "已到会话开头" })
    assert.equal(historyTopLineOf(h("done", false), "r-s6"), null)
    assert.equal(historyTopLineOf(h("error"), "r-s1"), null)
  })
  test("未载入会话（session-archived）：本机记录的流顶说明、截断条数；没有记录时说明只有首条消息", () => {
    assert.deepEqual(archiveTopLinesOf({ truncated: true, omitted: 22 }, "Mac Studio").map((x) => x.text), [
      "这是电脑上保存的记录，发第一条消息时在 Mac Studio 上载入",
      "更早的 22 条没有放进这一页",
    ])
    assert.deepEqual(archiveTopLinesOf(null, "Mac Studio").map((x) => x.text), ["这个会话还没载入，发第一条消息时在 Mac Studio 上载入"])
  })
  test("本页 outbox → 流尾用户卡（P5.6，§1.12）：只画还没送出去的，转录里已有同 cid 气泡的不重复，失败的不画", () => {
    const at = 1_000
    const outbox = [
      { cid: "w1k2c9f0", text: "顺便看看横屏的时候是不是也跳", status: "queued", at },
      { cid: "w2aa0000", text: "回放中，已 echo", status: "replaying", at },
      { cid: "w3bb0000", text: "回放失败", status: "failed", at },
      { cid: "w4cc0000", text: "回放中，还没 echo", status: "replaying", at },
    ]
    const items = [...R1_ITEMS, { kind: "user", key: "e-9", text: "回放中，已 echo", images: [], cid: "w2aa0000", status: "sending" }]
    const out = outboxItemsOf(outbox, items)
    assert.deepEqual(out.map((x) => x.cid), ["w1k2c9f0", "w4cc0000"])
    assert.deepEqual(out[0], {
      kind: "user",
      key: "outbox-w1k2c9f0",
      text: "顺便看看横屏的时候是不是也跳",
      images: [],
      timestamp: at,
      from: "remote",
      cid: "w1k2c9f0",
      outbox: true,
    })
    assert.deepEqual(outboxItemsOf([], items), [])
  })
  test("复制回复：这一回合的全部正文（Markdown 原文，空行拼接）", () => {
    const text = turnTextOf(CONVO_DONE, "a-r1-49")
    assert.ok(text.startsWith("收起判定只看了高度差"))
    assert.ok(text.endsWith("23 个用例全部通过"))
    assert.equal(turnTextOf(CONVO_DONE, "nope"), "")
  })
})

describe("model/changesView.ts：改动视图（changes-pane，G5）", () => {
  test("和 changesOfSession 同一批文件、同一合计 +32 −9；视图里最近改的文件在最上面（同 replica changes-pane）", () => {
    const view = changesViewOf(R1_ITEMS)
    const base = changesOfSession(R1_ITEMS)
    assert.deepEqual(base.files.map((f) => f.path), [KEYBOARD_TEST_PATH, VIEWPORT_PATH, CONVERSATION_PATH], "模型按第一次改到的先后")
    assert.deepEqual(view.files.map((f) => f.path), [VIEWPORT_PATH, CONVERSATION_PATH, KEYBOARD_TEST_PATH], "视图按最近一次改到的先后")
    assert.deepEqual(view.files.map((f) => f.edits), [2, 1, 1])
    assert.deepEqual([view.added, view.removed], [base.added, base.removed])
    assert.deepEqual([view.added, view.removed], [32, 9])
    assert.equal(view.truncated, false)
  })
  test("New 徽标（推断）：第一次碰到是 write 的文件；edit 过的不是", () => {
    assert.deepEqual(changesViewOf(R1_ITEMS).files.map((f) => f.isNew), [false, false, true])
  })
  test("按行号断档补「N 行未改动」；同一文件第 2 次编辑前有分隔条（plain，不能展开）", () => {
    const viewport = changesViewOf(R1_ITEMS).files[0]
    assert.deepEqual(viewport.rows[0], { kind: "fold", count: 29, label: "29 行未改动" }, "第一处改动在第 30 行")
    const sep = viewport.rows.find((r) => r.kind === "fold" && r.variant === "plain")
    assert.deepEqual(sep, { kind: "fold", count: 0, label: "第 2 次编辑", variant: "plain" })
    const folds = viewport.rows.filter((r) => r.kind === "fold" && !r.variant).map((r) => r.count)
    // 第一次编辑三段（+30,9 / +47,9 / +63,17）：38→47 断 8 行，55→63 断 7 行；第二次编辑一段（@52）前面 51 行
    assert.deepEqual(folds, [29, 8, 7, 51])
  })
  test("foldRowsOf：删行不算行号；没有行号的行（入参推算的 diff）不加折叠条", () => {
    const rows = [
      { kind: "context", n: 10, text: "a" },
      { kind: "del", n: 11, text: "b" },
      { kind: "add", n: 11, text: "c" },
      { kind: "del", n: 20, text: "d" },
      { kind: "context", n: 21, text: "e" },
    ]
    assert.deepEqual(foldRowsOf(rows).map((r) => (r.kind === "fold" ? `fold${r.count}` : r.kind)), ["fold9", "context", "del", "add", "fold9", "del", "context"])
    const noNumbers = [{ kind: "del", n: null, text: "x" }, { kind: "add", n: null, text: "y" }]
    assert.deepEqual(foldRowsOf(noNumbers), noNumbers)
  })
  test("patch 被截断（patchTruncated）：文件和整体都带 truncated；没有成功编辑的会话返回 null", () => {
    const item = {
      kind: "assistant",
      key: "a",
      blocks: [{ kind: "tool", id: "t", name: "edit", argsText: "", input: { path: "x.ts" }, outputText: "", state: "output-available", patch: "@@ -1,1 +1,1 @@\n-a\n+b\n", patchTruncated: true }],
    }
    const view = changesViewOf([item])
    assert.equal(view.files[0].truncated, true)
    assert.equal(view.truncated, true)
    assert.equal(changesViewOf([]), null)
    assert.equal(changesViewOf(CONVO_ERRORS), null)
  })
})

describe("model/filePayload.ts：get_file 回包（G10，对照扩展 readFileInRoot）", () => {
  test("扩展的真实契约 {name,mimeType,size,encoding,data,truncated}；file-pane fixture 照它写", () => {
    const p = filePayloadOf(FILE_RESULT)
    assert.equal(p.name, "useMobileViewport.ts")
    assert.equal(p.encoding, "utf8")
    assert.equal(p.size, new TextEncoder().encode(p.data).length)
    assert.equal(fileKindOf(p), "text")
    assert.equal(fileImageSrcOf(p), "")
  })
  test("坏包返回 null；size 不合法当大小未知；base64 图片能预览，别的 base64 是二进制", () => {
    assert.equal(filePayloadOf({ name: "a" }), null)
    assert.equal(filePayloadOf({ data: "x", encoding: "utf-8" }), null, "扩展写的是 utf8，不是 utf-8")
    assert.equal(filePayloadOf({ data: "x", encoding: "utf8", size: -1 }).size, null)
    const img = filePayloadOf({ name: "a.png", mimeType: "image/png", size: 3, encoding: "base64", data: "AAA", truncated: false })
    assert.equal(fileKindOf(img), "image")
    assert.equal(fileImageSrcOf(img), "data:image/png;base64,AAA")
    assert.equal(fileKindOf({ ...img, mimeType: "application/zip" }), "binary")
  })
  test("读取失败的文案：认得的码用固定文案，unsupported 等用扩展原文，都没有写「读取失败」", () => {
    assert.equal(fileErrorTextOf(Object.assign(new Error("找不到这个文件"), { code: "not_found" })), "找不到这个文件：检查路径是否在当前会话目录里")
    assert.equal(fileErrorTextOf(Object.assign(new Error("二进制文件不支持预览"), { code: "unsupported" })), "二进制文件不支持预览")
    assert.equal(fileErrorTextOf(new Error("boom")), "boom")
    assert.equal(fileErrorTextOf(null), "读取文件失败，请重试")
  })
})

describe("model/approvalReceipt.ts + dialogCardState：审批卡的回执（approval-waiting，M-06）", () => {
  const now = MOCK_NOW
  test("开着的卡：本页发出去等关闭帧（sent）仍按 sending 画、不再阻塞以外的状态照 dialogCardState", () => {
    assert.equal(approvalReceiptOf("dlg-7f3", null), null)
    const sent = approvalReceiptOf("dlg-7f3", { status: "sent", at: now })
    assert.equal(sent.status, "sending")
    assert.equal(dialogCardState(APPROVAL_DIALOG, sent, now).state, "sending")
    assert.equal(dialogCardState(APPROVAL_DIALOG, sent, now).blocksComposer, true, "答案在路上：输入仍禁用")
    const gone = approvalReceiptOf("dlg-7f3", { status: "answered-elsewhere", at: now })
    assert.equal(dialogCardState(APPROVAL_DIALOG, gone, now).blocksComposer, false)
  })
  test("卡关掉了：拒绝回执优先（带理由）；本页答的直接消失；过了时限算超时；其余算别处回答", () => {
    const denied = [{ dialogId: "dlg-7f3", note: "先别跑" }]
    assert.deepEqual(approvalEndedOf(APPROVAL_DIALOG, { status: "sent", at: now }, denied, now), {
      receipt: { dialogId: "dlg-7f3", status: "denied", at: now },
      note: "先别跑",
    })
    assert.equal(approvalEndedOf(APPROVAL_DIALOG, { status: "sent", at: now }, [], now), null)
    const deadline = APPROVAL_DIALOG.startedAt + APPROVAL_DIALOG.timeout
    assert.equal(approvalEndedOf(APPROVAL_DIALOG, null, [], deadline - 500).receipt.status, "expired", "差 1 秒以内算超时")
    assert.equal(approvalEndedOf(APPROVAL_DIALOG, null, [], now).receipt.status, "answered-elsewhere")
    assert.equal(approvalEndedOf({ ...APPROVAL_DIALOG, timeout: undefined }, null, [], now + 10 * M).receipt.status, "answered-elsewhere", "没有时限不算超时")
  })
})

describe("源码契约（b 线容器与部件）", () => {
  const containers = ["TranscriptContainer", "ApprovalContainer", "PaneContainer", "TaskPanelContainer"]
  test("b 线 4 个容器不再引用 PiStub；产品目录不出现开发画廊的路径和 mock 标记", () => {
    for (const name of containers) {
      const src = code(read(`ui/src/pi/containers/${name}.tsx`))
      assert.doesNotMatch(src, /PiStub|stub"/, name)
      assert.doesNotMatch(read(`ui/src/pi/containers/${name}.tsx`), /pi\/dev\/|MOCK_/, name)
    }
    for (const file of ["useTranscriptStick.ts"]) assert.doesNotMatch(read(`ui/src/pi/hooks/${file}`), /pi\/dev\/|MOCK_/)
    for (const file of ["turnError.ts", "transcriptView.ts", "changesView.ts", "filePayload.ts", "approvalReceipt.ts"]) {
      assert.doesNotMatch(read(`ui/src/pi/model/${file}`), /pi\/dev\/|MOCK_/, file)
    }
  })
  test("PiProse：react-markdown + remark-gfm 渲染，流式按 streaming-markdown-core 切（未闭合围栏当纯文本）", () => {
    const src = code(read("ui/src/components/pi/conversation/PiProse.tsx"))
    assert.match(src, /from "react-markdown"/)
    assert.match(src, /from "remark-gfm"/)
    assert.match(src, /splitStreamingMarkdown\(/)
    assert.match(src, /parseStreamingTail\(/)
    assert.match(src, /open-code/)
  })
  test("复制钮真的写剪贴板（P4 交接）；吸底状态经 useTranscriptStick 交给 dock", () => {
    assert.match(code(read("ui/src/components/pi/conversation/PiCodeBlock.tsx")), /piCopyText\(text\)/)
    assert.match(code(read("ui/src/pi/containers/TranscriptContainer.tsx")), /piTranscriptStick\.report/)
    assert.match(code(read("ui/src/pi/hooks/useTranscriptStick.ts")), /export function useTranscriptStick\(\): PiTranscriptStick/)
  })
  test("PiProseNode 的围栏 lang 放宽成 string（单项许可）", () => {
    assert.match(read("ui/src/components/pi/shared/types.ts"), /\| \{ code: string; lang\?: string \}/)
  })
})
