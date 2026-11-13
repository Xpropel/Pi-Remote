// S3 第二轮：流里的卡（代码块、diff 卡、终端卡）共用一套几何；没写语言的代码块、终端卡跑完收起、
// 运行中 → 完成的过渡（工具行不跳、思考计时、想完就收）的结构约束；markdown 丰富的画廊 fixture（s3-markdown）
// S3 第三轮：失败终端卡的展开口径（liveExpandedOf）；出错行写人话（状态码 → 原因，原文进详情）；重试过的出错回合折成一行
// S3 第四轮：正式令牌（--cw-pi-stream-fg / --cw-pi-menu-hl）；思考原文按 Markdown 画；终端视图的空态与保留期；停在半路的行内标记
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { stripTypeScriptTypes } from "node:module"
import { liveExpandedOf, turnStartOf } from "../ui/src/pi/model/transcriptView.ts"
import { httpStatusOf, turnErrorOf } from "../ui/src/pi/model/turnError.ts"
import { retryTurnOf, runningTurnOf, splitTurns, turnDurationOf, turnViewsOf } from "../ui/src/components/pi/conversation/turns.ts"
import { closeOpenInline, closeOpenMarkdown, closeOpenTable } from "../ui/src/components/pi/conversation/streamChunks.ts"
import { abortedToolResult, terminalSessionItems, terminalToolBlocks, visibleTerminalItems } from "../ui/src/chat/capsules/terminalModel.ts"
import { APPROVAL_ANNOUNCE_IDLE, approvalAnnounceStep } from "../ui/src/pi/model/approvalAnnounce.ts"
import { APPROVAL_REASON_WAIT_MS, approvalEndedOf, endedReceiptView } from "../ui/src/pi/model/approvalReceipt.ts"
import { dialogCardState } from "../ui/src/pi/model/dialogCard.ts"
import { devicePlatformOf, findStartedRoom } from "../ui/src/relay/devices.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
// 去掉注释（块注释、行注释；不碰 "://"）
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

const CONV = "ui/src/components/pi/conversation"
const card = code(read(`${CONV}/PiCard.tsx`))
const codeBlock = code(read(`${CONV}/PiCodeBlock.tsx`))
const diffCard = code(read(`${CONV}/PiDiffCard.tsx`))
const terminal = code(read(`${CONV}/PiTerminalCard.tsx`))
const lines = code(read(`${CONV}/PiStreamLines.tsx`))
const transcript = code(read(`${CONV}/PiTranscript.tsx`))
const tools = code(read(`${CONV}/tools.ts`))
const streamCss = read(`${CONV}/stream.css`)
const thinkingKit = code(read("ui/src/components/kit/stream/ThinkingBlock.tsx"))

describe("卡片几何：PiCard 一处定义，三种卡共用", () => {
  test("外框、卡头、分隔线、图标、收起露出的几何常量", () => {
    assert.match(card, /export const CARD = "relative w-full min-w-0 overflow-hidden rounded-\(--cw-radius-card\) border border-\(--cw-border\) bg-\(--cw-surface\)"/)
    assert.match(card, /export const CARD_GAP = "my-\(--cw-space-2-5\)"/)
    // 卡头左 10、图标与标题之间 8：所有卡的标题左缘对齐
    assert.match(card, /export const CARD_HEAD =\s*"flex min-w-0 items-center gap-2 pr-2 pl-2\.5 /)
    assert.match(card, /export const CARD_HEAD_H = "h-\[31px\]"/)
    assert.match(card, /export const CARD_HEAD_H_PHONE = "h-9"/)
    assert.match(card, /export const CARD_DIVIDER = "border-b border-\(--cw-divider\)"/)
    assert.match(card, /export const CARD_ICON = 14\b/)
    assert.match(card, /export const CARD_PEEK = 10\b/)
  })

  test("代码块 / diff 卡 / 终端卡的外框和上下间距都取 PiCard，不各写一套圆角和卡头高度", () => {
    for (const [name, src] of [
      ["PiCodeBlock", codeBlock],
      ["PiDiffCard", diffCard],
      ["PiTerminalCard", terminal],
    ]) {
      assert.match(src, /className=\{cn\([^)]*\bCARD, CARD_GAP\b/, `${name} 外框 = CARD + CARD_GAP`)
      assert.doesNotMatch(src, /rounded-/, `${name} 不自己写圆角`)
      assert.doesNotMatch(src, /\bh-\[3\dpx\]/, `${name} 卡头高度只用 CARD_HEAD_H`)
    }
    assert.match(codeBlock, /cn\(CARD_HEAD, CARD_DIVIDER, CARD_HEAD_H,/)
    assert.match(diffCard, /cn\(CARD_HEAD, CARD_DIVIDER, phone \? CARD_HEAD_H_PHONE : CARD_HEAD_H\)/)
    // 终端卡头是开关：手机至少 44 高，桌面同其他卡 31
    assert.match(terminal, /wrap \? "min-h-11 py-\[3px\]" : CARD_HEAD_H/)
  })

  test("收起时的渐隐和卡底展开条共用（代码块、diff 卡）", () => {
    for (const src of [codeBlock, diffCard]) {
      assert.match(src, /<PiCardPeekFade \/>/)
      assert.match(src, /<PiCardFoot /)
      assert.match(src, /\$\{CARD_PEEK\}px/)
    }
  })
})

describe("没写语言的代码块", () => {
  test("卡头写「纯文本」（highlightLabelOf 的 plain 名，同文件视图），不再空着只剩复制钮", () => {
    assert.match(codeBlock, /const label = highlightLabelOf\(lang\) \?\? lang/)
    assert.doesNotMatch(codeBlock, /route\.via === "plain" \? null/)
    assert.match(codeBlock, /data-pi-part="code-head"/)
  })
})

describe("终端卡：跑完自动收起，失败的留着", () => {
  test("默认开合跟着容器给的 open 变（运行中展开 → 跑完收起；失败卡何时展开由 liveExpandedOf 定）；用户点过以后听用户的", () => {
    assert.doesNotMatch(terminal, /const \[open, setOpen\] = useState/, "不能只在挂载时取一次 open")
    assert.match(terminal, /const \[userOpen, setUserOpen\] = useState<boolean \| null>\(null\)/)
    assert.match(terminal, /const open = userOpen \?\? !!openProp/)
    assert.doesNotMatch(terminal, /status !== "failed"/, "失败卡不在部件里另开例外")
    assert.match(terminal, /setUserOpen\(!open\)/)
  })

  test("pi 的退出码尾行（Command exited with code N）：卡头写「失败 · 退出 N」，输出里去掉这行", () => {
    assert.match(tools, /export function splitExitTrailer\(/)
    assert.match(tools, /Command exited with code \(\\d\+\)/)
    assert.match(transcript, /const result = splitExitTrailer\(b\.outputText, b\.exitCode\)/)
    assert.match(transcript, /exitCode=\{result\.exitCode\}/)
    assert.match(transcript, /output=\{result\.output\}/)
  })

  test("短语按真正干活的命令查：先去掉开头的 cd <目录> && / ;", () => {
    assert.match(tools, /\.replace\(\/\^\(cd\\s\+/)
  })

  test("参数还在流时不露半截 JSON：命令 / 路径从已到的字段里取，取不到就空着；模型没报名字时写「工具」", () => {
    assert.match(tools, /function argsFallback\(b: PiToolBlock\): string \{\s*return b\.input == null && b\.argsText\.trimStart\(\)\.startsWith\("\{"\) \? "" : b\.argsText/)
    assert.match(tools, /return str\(b\.input\?\.command\) \?\? partialArg\(b, "command"\) \?\? argsFallback\(b\)/)
    assert.match(transcript, /name == null \? "正在调用工具"/)
  })
})

describe("liveExpandedOf：失败的终端卡什么时候展开（主控第三轮的口径）", () => {
  const user = (key) => ({ kind: "user", key, text: "跑测试", images: [] })
  const bash = (id, state, extra = {}) => ({ kind: "tool", id, name: "bash", argsText: "", input: { command: id }, outputText: "", state, ...extra })
  const edit = (id) => ({ kind: "tool", id, name: "edit", argsText: "", input: { path: "cart.js" }, outputText: "", state: "output-available" })
  const reply = (key, blocks, stopReason = "toolUse", extra = {}) => ({ kind: "assistant", key, blocks, stopReason, ...extra })
  const done = (key, stopReason = "stop", extra = {}) => reply(key, [{ kind: "text", text: "好了" }], stopReason, extra)
  const ENDED = { running: false, waiting: false, paneOpen: false }
  const RUNNING = { running: true, waiting: false, paneOpen: false }
  const failed = (id) => bash(id, "output-error", { exitCode: 2 })
  const ok = (id) => bash(id, "output-available", { exitCode: 0 })

  test("回合成功结束：中途失败、智能体后面又跑了别的命令（绕过去了）的收起", () => {
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe")]), reply("a2", [ok("test")]), done("a3")], ENDED), [])
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe"), failed("test")]), done("a2")], ENDED), ["test"], "只留最后一条")
  })
  test("回合成功结束但最后一条命令失败：它保持展开（后面只改了文件、没再跑命令也算最后一条）", () => {
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [ok("probe"), failed("test")]), done("a2")], ENDED), ["test"])
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("test")]), reply("a2", [edit("e1")]), done("a3")], ENDED), ["test"])
  })
  test("回合以出错结束：所有失败卡保持展开；停止 / 截断不算出错，按成功结束的口径", () => {
    const items = [user("u1"), reply("a1", [failed("probe")]), reply("a2", [ok("test")])]
    assert.deepEqual(liveExpandedOf([...items, reply("a3", [], "error", { errorMessage: "overloaded_error" })], ENDED), ["probe"])
    assert.deepEqual(liveExpandedOf([...items, reply("a3", [], "aborted")], ENDED), [])
    assert.deepEqual(liveExpandedOf([...items, reply("a3", [], "error", { errorMessage: "This operation was aborted" })], ENDED), [], "AbortSignal 原文是停止")
    assert.deepEqual(liveExpandedOf([...items, reply("a3", [], "length")], ENDED), [])
  })
  test("拒绝 / 超时只是灰字行，不算失败卡；它们排在后面时，前面的失败命令也算被绕过", () => {
    const denied = bash("rm", "output-error", { outcome: "denied" })
    const timeout = bash("psql", "output-error", { outcome: "timeout" })
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe"), denied]), done("a2")], ENDED), [])
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe"), timeout]), done("a2")], ENDED), [])
  })
  test("停止回合时被打断的命令（结果是 pi 的停止样板）也只是灰字行「已取消」，不算失败卡", () => {
    const stopped = bash("sleep", "output-error", { outputText: "partial\n\nCommand aborted" })
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [stopped]), reply("a2", [], "error", { errorMessage: "The operation was aborted." })], ENDED), [])
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe"), stopped]), done("a2")], ENDED), [])
  })
  test("回合在跑：失败卡还是最后一条命令时展开，智能体接着跑下一条就收起；在跑的卡照旧展开", () => {
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe")], undefined, { live: true })], RUNNING), ["probe"])
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe"), bash("test", "input-available")], undefined, { live: true })], RUNNING), ["test"])
    assert.deepEqual(liveExpandedOf([user("u1"), reply("a1", [failed("probe")], undefined, { live: true })], { ...RUNNING, paneOpen: true }), [])
  })
  test("只看最近一个有回复的回合：更早回合的失败卡不展开", () => {
    const earlier = [user("u0"), reply("a0", [failed("old")]), done("a0b")]
    assert.deepEqual(liveExpandedOf([...earlier, user("u1"), reply("a1", [ok("test")]), done("a2")], ENDED), [])
  })
})

describe("出错行写人话：状态码 → 简短原因，服务返回的原文进详情（S4 报告：错误行露出原始 JSON）", () => {
  const err = (raw) => turnErrorOf("error", raw)
  test("真实会话里的 401（pi formatProviderError 的「状态码: 错误体」）：行里是原因 + 状态码，详情是排好版的错误体", () => {
    const e = err('401: {"message":"Incorrect API key provided","type":"invalid_api_key"}')
    assert.equal(e.text, "这一轮出错了：API 密钥无效或已过期（401）")
    assert.equal(e.error, true)
    assert.equal(e.detail, '401:\n{\n  "message": "Incorrect API key provided",\n  "type": "invalid_api_key"\n}')
  })
  test("429：限流和额度用完分开说；5xx：出错 / 暂时不可用 / 繁忙 / 超时", () => {
    assert.equal(err("429 You exceeded your current quota, please check your plan and billing details.").text, "这一轮出错了：账户额度不足（429）")
    assert.equal(err('OpenAI API error (429): {"error":{"message":"Rate limit reached for requests"}}').text, "这一轮出错了：请求太频繁（429）")
    assert.equal(err("429 status code (no body)").text, "这一轮出错了：请求太频繁（429）")
    assert.equal(err('500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}').text, "这一轮出错了：模型服务出错（500）")
    assert.equal(err("503 upstream connect error or disconnect/reset before headers. reset reason: connection timeout").text, "这一轮出错了：模型服务暂时不可用（503）")
    assert.equal(err("502 Bad Gateway").text, "这一轮出错了：模型服务暂时不可用（502）")
    assert.equal(err('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}').text, "这一轮出错了：模型服务繁忙（529）")
    assert.equal(err("504 Gateway Timeout").text, "这一轮出错了：请求超时（504）")
    assert.equal(err('{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}').text, "这一轮出错了：模型服务繁忙（503）")
  })
  test("网络断开 / 连不上 / 超时（各家 SDK 和 Bun fetch 的原话）：没有状态码就不写括号，原话进详情", () => {
    for (const raw of ["Connection error.", "terminated", "socket hang up", "fetch failed", "read ECONNRESET", "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()", "Connection closed by proxy server before the response completed"])
      assert.deepEqual(err(raw), { text: "这一轮出错了：网络连接中断", error: true, detail: raw }, raw)
    for (const raw of ["getaddrinfo ENOTFOUND api.example.com", "connect ECONNREFUSED 127.0.0.1:443", "Unable to connect. Is the computer able to access the url?"])
      assert.equal(err(raw).text, "这一轮出错了：连不上模型服务", raw)
    for (const raw of ["Request timed out.", "connect ETIMEDOUT 10.0.0.1:443", "The operation timed out."]) assert.equal(err(raw).text, "这一轮出错了：请求超时", raw)
  })
  test("认不出原因：JSON 写服务给的那句话（没有就写「模型服务报错」），行里永远不露花括号和引号", () => {
    const said = err('{"error":{"message":"This model has been retired, please switch"}}')
    assert.equal(said.text, "这一轮出错了：This model has been retired, please switch")
    assert.match(said.detail, /^\{\n {2}"error": \{/)
    const cut = err(`{"foo":"${"z".repeat(40)}... [truncated 812 chars]`)
    assert.equal(cut.text, "这一轮出错了：模型服务报错")
    assert.ok(cut.detail.startsWith('{"foo"'))
    const samples = ['401: {"message":"x"}', '400 {"error":{"type":"invalid_request_error"}}', '{"a":1}', '[{"error":{"code":429}}]', `{"x":"${"q".repeat(90)}"}`]
    for (const raw of samples) assert.doesNotMatch(err(raw).text, /[{}"[\]]/, raw)
  })
  test("停止的几种原话都是灰字「已停止生成」；pi 的占位原文写「未知原因」", () => {
    for (const raw of ["Operation aborted", "Aborted", "This operation was aborted", "The operation was aborted."])
      assert.deepEqual(err(raw), { text: "已停止生成", error: false }, raw)
    assert.deepEqual(err("An unknown error occurred"), { text: "这一轮出错了：未知原因", error: true })
  })
  test("httpStatusOf 只认 4xx / 5xx，不把 token 数当状态码", () => {
    assert.equal(httpStatusOf("OpenAI API error (429): slow down"), 429)
    assert.equal(httpStatusOf('{"error":{"code":503}}'), 503)
    assert.equal(httpStatusOf("got status: 502 Bad Gateway"), 502)
    assert.equal(httpStatusOf("HTTP/1.1 504 Gateway Timeout"), 504)
    assert.equal(httpStatusOf("This model's maximum context length is 128000 tokens"), null)
    assert.equal(httpStatusOf("200 OK"), null)
  })
  test("PiTurnError：原因后面一个灰字「详情」开关（aria-expanded / aria-controls），原文默认收起、等宽、能滚；「重新回答」可以不给", () => {
    assert.match(lines, /detail\?: string/)
    assert.match(lines, /aria-expanded=\{open\}\s+aria-controls=\{detailId\}/)
    assert.match(lines, /id=\{detailId\} hidden=\{!open\} data-pi-part="turn-error-detail"/)
    assert.match(lines, /<pre\s+tabIndex=\{0\}\s+className="[^"]*max-h-60 overflow-y-auto[^"]*font-\(family-name:--cw-font-mono\)[^"]*whitespace-pre-wrap/)
    assert.match(lines, /action\?: string \| null/)
    assert.match(transcript, /<PiTurnError key="stop" detail=\{end\.detail\} action=\{retry \? "重新回答" : null\} onAction=\{retry \? actions\?\.regenerate : undefined\}>/)
  })
})

describe("出错回合的重试：pi 的 regenerate 是把上一条用户消息再发一遍（追加），呈现层把出错那轮折进重试那轮", () => {
  const user = (key, text, extra = {}) => ({ kind: "user", key, text, images: [], ...extra })
  const said = (key) => ({ kind: "assistant", key, blocks: [{ kind: "text", text: "好了" }], stopReason: "stop" })
  const failed = (key, errorMessage = "overloaded_error") => ({ kind: "assistant", key, blocks: [], stopReason: "error", errorMessage })
  const views = (items) => turnViewsOf(splitTurns(items)).map((v) => ({ user: v.turn.user?.key, attempts: v.attempts.map((a) => a.user?.key) }))

  test("出错的那轮被一字不差地重发过：折进重发那轮；连着出错几次都折进最后成功的那轮", () => {
    assert.deepEqual(views([user("u1", "跑测试"), failed("a1"), user("u2", "跑测试 "), said("a2")]), [{ user: "u2", attempts: ["u1"] }])
    assert.deepEqual(views([user("u1", "跑测试"), failed("a1"), user("u2", "跑测试"), failed("a2", "Connection error."), user("u3", "跑测试"), said("a3")]), [
      { user: "u3", attempts: ["u1", "u2"] },
    ])
  })
  test("不折：没出错的、停止的、下一句不一样的、重发还没交给 pi 的（发送失败 / 排队 / 等重连）", () => {
    const plain = [{ user: "u1", attempts: [] }, { user: "u2", attempts: [] }]
    assert.deepEqual(views([user("u1", "跑测试"), said("a1"), user("u2", "跑测试"), said("a2")]), plain)
    assert.deepEqual(views([user("u1", "跑测试"), failed("a1", "Operation aborted"), user("u2", "跑测试"), said("a2")]), plain)
    assert.deepEqual(views([user("u1", "跑测试"), failed("a1"), user("u2", "换个思路"), said("a2")]), plain)
    for (const mark of [{ failed: "ack timeout" }, { queued: true, queueId: "q1" }, { outbox: true }])
      assert.deepEqual(views([user("u1", "跑测试"), failed("a1"), user("u2", "跑测试", mark)]), plain, JSON.stringify(mark))
  })
  test("「重新回答」只挂在最近一个有回复的回合（重发的就是它）；后面跟着没回复的用户卡也是它；pi 在跑时哪都不挂", () => {
    const turns = splitTurns([user("u1", "a"), failed("a1"), user("u2", "b"), failed("a2"), user("u3", "c", { failed: "ack timeout" })])
    assert.equal(retryTurnOf(turns, false), 1)
    assert.equal(retryTurnOf(turns, true), -1)
    assert.equal(retryTurnOf(splitTurns([user("u1", "a")]), false), -1)
  })
  test("PiTranscript：按 turnViewsOf 渲染，折叠行在重试那轮的用户卡下；行里出错不再处处挂「重新回答」", () => {
    assert.match(transcript, /turnViewsOf\(turns\)\.map\(\(\{ turn, index: ti, attempts \}, vi\) =>/)
    assert.match(transcript, /vi > 0 && "mt-\(--cw-space-6\)"/, "回合间距按渲染出来的位置算，第一轮被折掉时流顶不多空")
    assert.match(transcript, /attempts\.length > 0 && <RetriedAttempts attempts=\{attempts\} retrying=\{isRunningTurn\} renderItem=\{renderAttemptItem\} \/>/)
    assert.match(transcript, /`\$\{attempts\.length > 1 \? `出错 \$\{attempts\.length\} 次` : "上次出错"\}，\$\{retrying \? "正在重试" : "已重试"\}`/)
    assert.match(transcript, /showRetry=\{ti === retryTurn\}/)
    assert.match(transcript, /const retry = showRetry && replyMeta != null/, "回合中途出错、pi 自动重试接着跑的那条不挂")
    assert.match(transcript, /replyMeta=\{null\}\s+showRetry=\{false\}/, "折叠里的过程不带操作行和「重新回答」")
  })
})

describe("运行中 → 完成：行不跳、思考有计时、想完就收", () => {
  const toolLine = lines.slice(lines.indexOf("export function PiToolLine"), lines.indexOf("export function PiExploreRows"))
  const exploreRows = lines.slice(lines.indexOf("export function PiExploreRows"))

  test("轻工具行、探索明细不再有行首 spinner（跑完时整行左移 18px）；运行中的动词扫亮带，静态态不挂", () => {
    assert.ok(toolLine.length > 0 && exploreRows.length > 0)
    for (const src of [toolLine, exploreRows]) assert.doesNotMatch(src, /<PiSpinner/)
    assert.match(lines, /data-pi-shimmer=\{on \? "" : undefined\}/)
    assert.match(toolLine, /const shimmer = !!running && !isStatic/)
    assert.match(exploreRows, /<Shimmer on=\{r\.running && !isStatic\}>/)
    // 探索明细的动词不写"正在"：运行中另外念出来
    assert.match(exploreRows, /className="sr-only">（运行中）/)
  })

  test("亮带只在没要求减少动效、也不是强制配色时画；颜色只取 currentColor 和令牌", () => {
    assert.match(streamCss, /@media \(prefers-reduced-motion: no-preference\) and \(forced-colors: none\)/)
    assert.doesNotMatch(streamCss, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    assert.match(streamCss, /var\(--cw-text\)/)
    assert.match(lines, /import "\.\/stream\.css"/)
  })

  test("思考中写已想了几秒（从容器观测到的开始时刻起）；想完的块默认收起，不等整个回合结束（打开页面时已想完的也一样），静态态照容器默认", () => {
    assert.match(lines, /function ThinkingElapsed\(\{ since \}: \{ since: number \}\)/)
    assert.match(lines, /const effective = userOpen \?\? \(live \|\| isStatic \? open : false\)/)
    assert.doesNotMatch(lines, /endedHere/)
    assert.match(transcript, /since=\{live \? thinkingSince\?\.get\(key\) : undefined\}/)
    assert.match(read("ui/src/pi/containers/TranscriptContainer.tsx"), /thinkingSince=\{thinkingSince\}/)
    // kit：live 态的标题也画时长
    const liveHead = thinkingKit.slice(thinkingKit.indexOf("const header = live ? ("), thinkingKit.indexOf(") : ("))
    assert.match(liveHead, /duration != null/)
  })

  test("思考原文按 Markdown 画（PiThinkingText：换行照留，长词可断不撑宽），流式中同回复正文的稳定前缀 + 活动尾部", () => {
    assert.match(lines, /typeof body === "string" \? <PiThinkingText text=\{body\} streaming=\{live\} cut=\{cut\} fold=\{!live\} \/> : body/)
    assert.match(code(read(`${CONV}/PiProse.tsx`)), /<div data-pi-part="thinking-text" className="min-w-0 \[overflow-wrap:anywhere\]">/)
  })
})

describe("真实会话收尾", () => {
  test("停止生成的回复 pi 记 0 用量：回复下的灰字不写「0 tok」", () => {
    assert.match(transcript, /if \(item\.usage\?\.totalTokens\) parts\.push\(`\$\{piTokens\(item\.usage\.totalTokens\)\} tok`\)/)
  })

  test(".js / .mjs / .cjs 的卡头是 JS 徽（不再冒充 TS），ts / jsx 照旧", async () => {
    const { fileKindOf } = await import("../ui/src/components/kit/diff/shared.ts")
    assert.deepEqual(["format.js", "a.mjs", "b.cjs", "c.ts", "d.mts", "e.tsx", "f.jsx"].map(fileKindOf), ["js", "js", "js", "ts", "ts", "tsx", "tsx"])
    for (const src of [diffCard, code(read("ui/src/pi/containers/PaneContainer.tsx"))]) {
      assert.match(src, /if \(\/\\\.\(js\|mjs\|cjs\)\$\/\.test\(p\)\) return "js"/)
      assert.match(src, /if \(\/\\\.\(ts\|mts\|cts\)\$\/\.test\(p\)\) return "ts"/)
    }
    const icon = code(read("ui/src/components/kit/diff/FileTypeIcon.tsx"))
    assert.match(icon, /\{kind === "ts" \? "TS" : "JS"\}/)
    assert.match(icon, /js: "text-\[color:var\(--cw-file-icon-js,/)
  })
})

describe("正文表格", () => {
  test("格里的行内代码 / 文件 chip 只在词边界断（列至少容下整个 chip，文件名不断成两截）；正文里的 chip 仍任意处断", () => {
    const prose = code(read(`${CONV}/PiProse.tsx`))
    assert.match(prose, /const CELL_CHIP = "\[&_\[data-stream-chip\]\]:\[word-break:normal\] \[&_\[data-stream-chip\]\]:\[overflow-wrap:break-word\]"/)
    assert.match(prose, /const TH = cn\([^\n]*TABLE_CELL_MIN, CELL_CHIP\)/)
    assert.match(prose, /const TD = cn\([^\n]*TABLE_CELL_MIN, CELL_CHIP\)/)
    assert.match(read("ui/src/components/kit/stream/styles.ts"), /box-decoration-clone break-all"/)
  })
})

describe("画廊：s3-markdown（markdown 丰富的 live fixture）", () => {
  test("标题、三层嵌套列表、8 行长表格、带语言 / 不带语言的代码块、引用、链接；失败的 bash 输出带 pi 的退出码尾行", async () => {
    const { default: fx } = await import("../ui/src/pi/dev/fixtures/live/s3-markdown.ts")
    assert.equal(fx.id, "s3-markdown")
    const blocks = fx.relay.transcript.items.flatMap((it) => (it.kind === "assistant" ? it.blocks : []))
    const text = blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text)
      .join("\n")
    assert.match(text, /^## /m)
    assert.match(text, /^### /m)
    assert.match(text, /^ {5}- /m, "第三层列表")
    assert.ok((text.match(/^\| .* \|$/gm) ?? []).length >= 10, "表头 + 分隔线 + 8 行")
    assert.match(text, /^```ts$/m)
    assert.match(text, /^```\n✔/m, "没写语言的围栏")
    assert.match(text, /^> /m)
    assert.match(text, /\]\(https:\/\//)
    const bash = blocks.filter((b) => b.kind === "tool" && b.name === "bash")
    assert.ok(bash.some((b) => b.state === "output-error" && /\n\nCommand exited with code 1$/.test(b.outputText)))
    assert.ok(bash.some((b) => b.state === "output-available"))
  })
})

describe("第四轮：正式令牌", () => {
  const walk = (dir) =>
    fs
      .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .flatMap((d) => (d.isDirectory() ? walk(`${dir}/${d.name}`) : /\.(tsx?|css)$/.test(d.name) ? [`${dir}/${d.name}`] : []))
  const mine = [CONV, "ui/src/components/kit/stream", "ui/src/components/kit/diff"].flatMap(walk)

  test("临时变量 --stream-fg / STREAM_FG_SCOPE 不再出现；正文字色读 S2 的 --cw-pi-stream-fg（没有 Pi 主题时 = --cw-text）", () => {
    assert.match(read("ui/src/components/pi/shared/pi-theme.css"), /--cw-pi-stream-fg:/)
    for (const file of mine) {
      const src = read(file)
      assert.doesNotMatch(src, /--stream-fg\b/, file)
      assert.doesNotMatch(src, /STREAM_FG_SCOPE/, file)
    }
    assert.match(read("ui/src/components/kit/stream/styles.ts"), /export const STREAM_FG = "text-\[color:var\(--cw-pi-stream-fg,var\(--cw-text\)\)\]"/)
    for (const file of [
      "ui/src/components/kit/diff/SyntaxHighlight.tsx",
      "ui/src/components/kit/diff/UnifiedDiff.tsx",
      `${CONV}/PiTerminalCard.tsx`,
      `${CONV}/PiCodeBlock.tsx`,
      `${CONV}/PiFilePane.tsx`,
      `${CONV}/PiApprovalCard.tsx`,
    ]) {
      assert.match(code(read(file)), /text-\[color:var\(--cw-pi-stream-fg,var\(--cw-text\)\)\]/, file)
    }
  })

  test("卡里可点的行（终端卡头、卡脚展开条、审批选项、diff 文件头聚焦）的底读 --cw-pi-menu-hl（深色卡面上 --cw-row-hover 几乎看不出）", () => {
    const styles = code(read(`${CONV}/styles.ts`))
    assert.match(styles, /export const ROW_HL_HOVER = "hover:bg-\[color:var\(--cw-pi-menu-hl,var\(--cw-row-hover\)\)\]"/)
    assert.match(styles, /export const ROW_HL_FOCUS = "focus-visible:bg-\[color:var\(--cw-pi-menu-hl,var\(--cw-row-hover\)\)\]"/)
    assert.match(terminal, /hasOutput \? cn\(ROW_HL_HOVER, ROW_HL_FOCUS\) : "cursor-default"/)
    assert.match(card, /"group\/foot relative flex h-6 w-full items-center justify-center", ROW_HL_HOVER, INSET_FOCUS, FOOT_PHONE\)/)
    for (const src of [terminal, card]) assert.doesNotMatch(src, /hover:bg-\(--cw-row-hover\)/)
    assert.match(
      code(read(`${CONV}/PiApprovalCard.tsx`)),
      /enabled:hover:bg-\[color:var\(--cw-pi-menu-hl,var\(--cw-row-hover\)\)\] enabled:active:bg-\(--cw-row-selected\)/,
    )
    assert.match(code(read("ui/src/components/kit/diff/DiffFileSection.tsx")), /focus-visible:bg-\[color:var\(--cw-pi-menu-hl,var\(--cw-row-hover\)\)\]/)
  })
})

describe("第四轮：思考原文按 Markdown 画", () => {
  const prose = code(read(`${CONV}/PiProse.tsx`))
  const thinking = prose.slice(prose.indexOf("const THINKING_COMPONENTS"), prose.indexOf("const REMARK_PLUGINS"))
  const entry = prose.slice(prose.indexOf("export function PiThinkingText"), prose.indexOf("export interface PiProseProps"))

  test("和回复同一条管线（MarkdownBlock / StreamingMarkdown），元素映射从 LookContext 取（默认回复）；流式中没闭合的围栏按各自外观画", () => {
    assert.match(prose, /const LookContext = createContext<MarkdownLook>\(REPLY_LOOK\)/)
    assert.match(prose, /const \{ components \} = useContext\(LookContext\)/)
    assert.match(prose, /const THINKING_LOOK: MarkdownLook = \{ components: THINKING_COMPONENTS, openCode: \(text\) => <ThinkingCode text=\{text\} \/> \}/)
    assert.match(prose, /\{tail\.open != null && look\.openCode\(tail\.open, tail\.lang\)\}/)
    assert.match(entry, /<LookContext\.Provider value=\{THINKING_LOOK\}>/)
    assert.match(entry, /const body = streaming \? <StreamingMarkdown text=\{text\} \/> : <MarkdownBlock content=\{cut \? closeOpenMarkdown\(text\) : text\} \/>/)
    // 字号 / 字色随 kit 思考块（--cw-thinking-body），不套回复正文的排版
    assert.doesNotMatch(entry, /AgentProse/)
  })

  test("弱化、紧凑：块间距 6、首尾不外撑；加粗 / 标题同阶段小标题；代码等宽、底色减淡、字色随思考正文；不放文件 chip、代码框头和真标题", () => {
    assert.match(prose, /const THINKING_BLOCK = "my-\(--cw-space-1-5\) first:mt-0 last:mb-0"/)
    assert.match(prose, /const THINKING_STRONG = "font-\(--cw-weight-semibold\) text-\(--cw-thinking-phase\)"/)
    assert.match(prose, /const THINKING_CODE_BG = "bg-\(--cw-code-chip-bg\)\/60"/)
    assert.match(thinking, /code: \(\{ children \}\) => <CodeChip className=\{cn\(THINKING_CODE_BG, "text-inherit"\)\}>/)
    assert.match(thinking, /"list-disc pl-4"/)
    assert.match(thinking, /"list-decimal pl-5"/)
    assert.doesNotMatch(thinking, /PiFileChip|MdInlineCode|PiCodeBlock|<h[1-6]/)
    const pre = prose.slice(prose.indexOf("function ThinkingCode"), prose.indexOf("const ThinkingHeading"))
    assert.match(pre, /font-\(family-name:--cw-font-mono\) text-\(length:--cw-text-code\) leading-\[1\.5\] whitespace-pre-wrap \[overflow-wrap:anywhere\]/)
  })

  test("画廊：s3-stopped 的思考有阶段标题、行内代码、代码段、要点；现在这一轮的思考流式到一半", async () => {
    const { default: fx } = await import("../ui/src/pi/dev/fixtures/live/s3-stopped.ts")
    const items = fx.relay.transcript.items
    const thoughts = items.flatMap((it) => (it.kind === "assistant" ? it.blocks : [])).filter((b) => b.kind === "thinking")
    assert.match(thoughts[0].text, /^\*\*.+\*\*\n/)
    assert.match(thoughts[0].text, /^```js$/m)
    assert.match(thoughts[0].text, /^- .*`/m)
    assert.equal(fx.relay.transcript.liveKey, items.at(-1).key)
    assert.equal(items.at(-1).live, true)
  })
})

describe("第四轮：停在半路的行内标记（closeOpenInline）", () => {
  test("停在行内代码中间：补上闭合，不露孤立的反引号；开了还没有字的去掉", () => {
    assert.equal(closeOpenInline("关键是这一行：`total(items"), "关键是这一行：`total(items`")
    assert.equal(closeOpenInline("用 `"), "用")
    assert.equal(closeOpenInline("``a ` b"), "``a ` b``", "几个反引号开就几个闭")
    assert.equal(closeOpenInline("`abc\n"), "`abc`\n", "结尾的换行照留")
  })

  test("加粗同理（加粗里套着没闭合的行内代码时两层都补）；不像开头的 ** 不动", () => {
    assert.equal(closeOpenInline("**注意"), "**注意**")
    assert.equal(closeOpenInline("看 **"), "看")
    assert.equal(closeOpenInline("**加粗 `code"), "**加粗 `code`**")
    assert.equal(closeOpenInline("***很重要"), "***很重要***")
    assert.equal(closeOpenInline("a ** b"), "a ** b")
    assert.equal(closeOpenInline("2 * 3 = 6"), "2 * 3 = 6")
  })

  test("只看最后一段：闭合了的、转义的、已收尾段落里的、围栏 / 缩进代码里的反引号都不动", () => {
    for (const t of ["传 `null`、`0` 都不会触发", "a \\` b", "`abc\n\n", "```js\nconst a = `x", "    缩进代码 `x", "> 引用 `a\n> 续行` 完"]) {
      assert.equal(closeOpenInline(t), t, JSON.stringify(t))
    }
    assert.equal(closeOpenInline("a ` b\n\nc `d"), "a ` b\n\nc `d`")
    assert.equal(closeOpenInline("前言\n\n```js\nconst a = 1\n```\n\n后面 `x"), "前言\n\n```js\nconst a = 1\n```\n\n后面 `x`")
    assert.equal(closeOpenInline("- 一 `a\n- 二 `b"), "- 一 `a\n- 二 `b`", "列表项各自一块")
  })

  test("只补截断的文字：流式的活动尾部、停止 / 出错 / 长度上限那轮的最后一块（最后是工具就不补）；正常结束的回复原样", () => {
    const prose = code(read(`${CONV}/PiProse.tsx`))
    assert.match(prose, /return \{ head: closeOpenMarkdown\(split\.tail\), open: null, lang: "plain" \}/)
    assert.match(prose, /<MarkdownBlock content=\{cut \? closeOpenMarkdown\(markdown\) : markdown\} \/>/)
    assert.match(transcript, /const CUT_STOPS = new Set\(\["aborted", "error", "length"\]\)/)
    assert.match(transcript, /if \(item\.live \|\| !CUT_STOPS\.has\(item\.stopReason \?\? ""\)\) return -1/)
    assert.match(transcript, /if \(b\.kind !== "text" && b\.kind !== "thinking"\) return -1/)
    assert.equal((transcript.match(/cut=\{i === cutAt\}/g) ?? []).length, 2, "思考块和正文都接")
  })
})

describe("第四轮：终端视图", () => {
  const pane = code(read(`${CONV}/PiTerminalPane.tsx`))
  const container = code(read("ui/src/pi/containers/PaneContainer.tsx"))

  test("终端视图列本会话跑过的命令（第五轮：terminalSessionItems，不按保留期移出；tray 的「终端 N」才看保留期）", () => {
    assert.match(container, /terminalSessionItems\(items, relay\.terminalItems, busy\)\.map\(withExitTrailer\)/)
    assert.doesNotMatch(container, /visibleTerminalItems|terminalOpen/)
  })

  test("空态只留给真没跑过命令的会话（第五轮去掉「都已结束」那一种）", () => {
    assert.match(container, /<PiTerminalPane items=\{terminals\} now=\{now\}/)
    assert.doesNotMatch(container, /ranCount/)
    assert.match(pane, /\{unloaded \? "会话还没载入" : "这个会话还没有运行命令"\}/)
    assert.doesNotMatch(pane, /都已结束|ranCount/)
    assert.doesNotMatch(pane, /结束的命令保留 30 秒/)
  })

  test("没载入的会话（只点选了本机记录，正文里的工具调用只剩「调用 bash」字样）：终端 / 改动的空态写「会话还没载入」，不说没跑过 / 没改过", () => {
    assert.match(container, /const unloaded = !sessionLoaded\(relay\)/)
    assert.match(container, /<PiChangesPane files=\{files\} total=\{total\} variant=\{variant\} unloaded=\{unloaded\} \/>/)
    assert.match(container, /actions=\{terminalActions\} unloaded=\{unloaded\} \/>/)
    assert.match(code(read(`${CONV}/PiChangesPane.tsx`)), /\{unloaded \? "会话还没载入" : "这个会话还没有编辑文件"\}/)
  })

  test("画廊：s3-terminal-held 两条命令都过了保留期、照列实时条目；s3-terminal-ended 实时条目为空、从对话里重建 3 条", async () => {
    const { default: held } = await import("../ui/src/pi/dev/fixtures/live/s3-terminal-held.ts")
    assert.equal(visibleTerminalItems(held.relay.terminalItems, held.now).length, 0, "胶囊口径：早已移出")
    assert.deepEqual(terminalSessionItems(held.relay.transcript.items, held.relay.terminalItems), held.relay.terminalItems, "有实时条目就用实时条目")
    const { default: ended } = await import("../ui/src/pi/dev/fixtures/live/s3-terminal-ended.ts")
    assert.equal(ended.relay.terminalItems.length, 0)
    assert.equal(terminalToolBlocks(ended.relay.transcript.items).length, 3)
    assert.deepEqual(terminalSessionItems(ended.relay.transcript.items, []).map((t) => t.state), ["failed", "succeeded", "succeeded"])
    const seeds = code(read("ui/src/pi/dev/live/seeds-b.ts"))
    assert.match(seeds, /"s3-terminal-ended": \{ ui: \{ pane: "terminal" \} \}/)
    assert.match(seeds, /"s3-terminal-held": \{ ui: \{ pane: "terminal" \} \}/)
  })
})

describe("第五轮：停止回合时被打断的命令（真实会话：流里写「失败 · Command aborted」，终端视图写「已取消」）", () => {
  const bash = (id, outputText) => ({ kind: "tool", id, name: "bash", argsText: "", input: { command: id }, outputText, state: "output-error" })
  const items = (blocks) => [{ kind: "user", key: "u1", text: "跑", images: [] }, { kind: "assistant", key: "a1", stopReason: "toolUse", blocks }]

  test("结果是 pi 的停止样板（bash 接在已有输出后面，其余工具整段）：终端视图重建写「已取消」，命令自己失败的照旧", () => {
    const rebuilt = terminalSessionItems(items([bash("sleep 20", "Command aborted"), bash("tail -f log", "line 1\n\nCommand aborted"), bash("node --test", "not ok 1\n\nCommand exited with code 1")]), [])
    assert.deepEqual(rebuilt.map((t) => t.state), ["aborted", "aborted", "failed"])
    assert.equal(abortedToolResult("Operation aborted"), true)
    assert.equal(abortedToolResult("echo Command aborted\nexit 1"), false, "只认结尾的样板")
  })

  test("流里同一口径：工具的状态都走 streamToolStatus（停止打断的是灰字「已取消」；第六轮起写入 / 编辑 / 读取 / 其他工具也一样）", () => {
    assert.match(tools, /if \(status === "failed" && abortedToolResult\(b\.outputText\)\) return "aborted"/)
    assert.match(transcript, /const status = streamToolStatus\(b, stopped\)/)
    assert.doesNotMatch(transcript, /\btoolStatus\(/)
  })
})

describe("第五轮：回合用时（S4 报告：排队消息插进正在跑的回合后，前一回合只算了 6 秒）", () => {
  const T0 = 1_792_800_000_000
  const user = (key, at, extra = {}) => ({ kind: "user", key, text: key, images: [], ...(at != null ? { timestamp: at } : {}), ...extra })
  const bash = (id, state = "output-available") => ({ kind: "tool", id, name: "bash", argsText: "", input: { command: "sleep 90" }, outputText: "", state })
  const reply = (key, startedAt, durationMs, stopReason, blocks = [{ kind: "text", text: "好了" }], extra = {}) => ({
    kind: "assistant",
    key,
    blocks,
    stopReason,
    startedAt,
    durationMs,
    endedAt: startedAt + durationMs,
    timestamp: startedAt,
    ...extra,
  })
  // 现场：sleep 90 那轮 6 秒时发出调用；工具跑完（第 96 秒）时排队的 steer 注入（时间戳比最后一个工具结果晚 2 ms），接着回下一轮
  const sleepCall = (state) => reply("a1", T0 + 200, 5_800, "toolUse", [{ kind: "thinking", text: "先睡一会" }, bash("t1", state)])
  const steered = ({ toolState = "output-available", next = {} } = {}) =>
    splitTurns([user("u1", T0), sleepCall(toolState), user("u2", T0 + 96_002, next), reply("a2", T0 + 96_300, 3_000, "stop")])

  test("前一回合算到插进来的消息注入为止（工具执行的 90 秒算进去）；接手的回合从它自己的时间戳算", () => {
    const turns = steered()
    assert.equal(turnDurationOf(turns, 0), 96_002)
    assert.equal(turnDurationOf(turns, 1), 99_300 - 96_002)
  })

  test("平常的回合以一条助手消息收尾：终点就是它，后面隔多久才发的下一条不算", () => {
    const turns = splitTurns([user("u1", T0), sleepCall(), reply("a2", T0 + 96_100, 4_000, "stop"), user("u2", T0 + 3_600_000), reply("a3", T0 + 3_600_200, 1_000, "stop")])
    assert.equal(turnDurationOf(turns, 0), 100_100)
  })

  test("工具跑到一半停止：回合以 aborted 消息收尾，按它算；工具还没出结果（pi 中途退出过）推不出终点，不出用时（不写只算到调用的 6 秒）", () => {
    const stopped = splitTurns([user("u1", T0), sleepCall("output-error"), reply("a9", T0 + 40_000, 0, "aborted", []), user("u2", T0 + 7_200_000), reply("a2", T0 + 7_200_300, 1_000, "stop")])
    assert.equal(turnDurationOf(stopped, 0), 40_000)
    assert.equal(turnDurationOf(steered({ toolState: "input-available" }), 0), null)
  })

  test("停止的那一端：按下停止就不算在跑，工具结果和停止收尾随后才到；之间不出用时（不先写「用时 3s」再改成 8s），收尾到了按它算", () => {
    assert.equal(turnDurationOf(splitTurns([user("u1", T0), sleepCall("input-available")]), 0), null)
    assert.equal(turnDurationOf(splitTurns([user("u1", T0), sleepCall("output-error")]), 0), null, "工具结果先到、停止收尾还没到")
    const tail = reply("a9", T0 + 8_000, 0, "error", [], { errorMessage: "The operation was aborted." })
    assert.equal(turnDurationOf(splitTurns([user("u1", T0), sleepCall("output-error"), tail]), 0), 8_000)
  })

  test("下一条还没交到 pi（排队等注入、等重连、发送失败）：不当作前一回合收尾", () => {
    for (const next of [{ queued: true, queueId: "q1" }, { status: "awaiting" }, { outbox: true }, { failed: "网络断开" }]) {
      assert.equal(turnDurationOf(steered({ next }), 0), null, JSON.stringify(next))
    }
  })

  test("排队期间 pi 还在前一回合：流尾还没交到 pi、也还没有回复的用户卡不算正在跑的回合（前一回合不出用时，计时照旧挂在它上面）", () => {
    const queued = splitTurns([user("u1", T0), sleepCall("input-available"), user("u2", undefined, { queued: true, queueId: "q1", status: "awaiting" })])
    assert.equal(runningTurnOf(queued, true), 0)
    assert.equal(runningTurnOf(queued, false), -1)
    const more = splitTurns([user("u1", T0), sleepCall("input-available"), user("u2", undefined, { outbox: true }), user("u3", undefined, { failed: "x" })])
    assert.equal(runningTurnOf(more, true), 0)
    assert.equal(runningTurnOf(splitTurns([user("u1", T0), sleepCall(), user("u2", T0 + 96_002)]), true), 1, "pi 收下了就是它在跑")
    assert.equal(runningTurnOf(splitTurns([user("u1", T0), sleepCall(), user("u2", undefined, { status: "awaiting" }), reply("a2", T0 + 96_300, 0, undefined, [], { live: true })]), true), 1, "后面已经有回复的照常")
    assert.match(transcript, /const runningTurn = runningTurnOf\(turns, running != null\)/)
    assert.match(transcript, /const isRunningTurn = ti === runningTurn/)
    assert.match(transcript, /const duration = isRunningTurn \? null : turnDurationOf\(turns, ti\)/)
  })

  test("容器同一口径：排队的消息在流尾时，运行行的起点和默认展开仍是 pi 在跑的那一回合", () => {
    const relayItems = [
      { kind: "user", key: "u1", text: "睡 90 秒", images: [], timestamp: T0 },
      { kind: "assistant", key: "a1", live: true, startedAt: T0 + 200, blocks: [{ kind: "thinking", text: "先睡一会" }, bash("t1", "input-available")] },
      { kind: "user", key: "e1", text: "看到后回复收到", images: [], echo: "看到后回复收到", cid: "c1", status: "awaiting" },
    ]
    assert.equal(turnStartOf(relayItems), T0)
    assert.deepEqual(liveExpandedOf(relayItems, { running: true, waiting: false, paneOpen: false }), ["a1:0", "t1"])
    const failedTail = [...relayItems.slice(0, 2), { kind: "user", key: "e2", text: "x", images: [], echo: "x", failed: "网络断开" }]
    assert.equal(turnStartOf(failedTail), T0)
  })
})

const approvalCard = code(read(`${CONV}/PiApprovalCard.tsx`))

describe("第五轮：说法统一（工具审批「等你批准」，提问 / 弹窗「等你回答」）", () => {
  test("终端卡卡在审批前写「等你批准」；对话流目录里不再有「等你确认」", () => {
    assert.match(terminal, /case "waiting":\s*return \{ text: "等你批准", attention: true \}/)
    for (const f of fs.readdirSync(path.join(ROOT, CONV))) {
      if (/\.tsx?$/.test(f)) assert.doesNotMatch(read(`${CONV}/${f}`), /等你确认/, f)
    }
  })

  test("审批卡卡头：工具审批「pi 在等你批准」、提问「pi 在等你回答」，读屏播报同口径；电脑上的旧式弹窗写「等你回答」", () => {
    assert.match(approvalCard, /\{approval \? "pi 在等你批准" : "pi 在等你回答"\}/)
    assert.match(approvalCard, /approval: dialogIsApproval\(dialog\),/)
    assert.match(approvalCard, /电脑上有一个弹窗在等你回答 · 已等/)
    const gate = approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, { dialogId: "d1", active: true, question: "允许执行 bash？", remainingMs: null, approval: true })
    assert.equal(gate.text, "pi 在等你批准：允许执行 bash？")
    const ask = approvalAnnounceStep(APPROVAL_ANNOUNCE_IDLE, { dialogId: "d2", active: true, question: "选一个", remainingMs: null })
    assert.equal(ask.text, "pi 在等你回答：选一个")
  })
})

describe("第五轮：停止回合后没答的卡（S2 报告：回执写成「已在其他设备回答」）", () => {
  const T0 = 1_792_800_000_000
  const dialog = { dialogId: "d1", startedAt: T0, timeout: 120_000, answerable: true }
  const asking = [
    { kind: "user", key: "u1", text: "问我一个问题", images: [], timestamp: T0 - 5_000 },
    { kind: "assistant", key: "a1", stopReason: "toolUse", startedAt: T0 - 4_000, blocks: [] },
  ]
  const stoppedTail = [...asking, { kind: "assistant", key: "a2", stopReason: "aborted", startedAt: T0 + 30_050, blocks: [] }]
  const closedAt = T0 + 30_000
  const closed = approvalEndedOf(dialog, null, [], closedAt).receipt

  test("卡先消失、aborted 收尾随后到：写「回合已停止」；先到也一样", () => {
    assert.equal(closed.status, "answered-elsewhere", "关闭那一刻只知道不是本页答的")
    assert.equal(endedReceiptView(closed, dialog, stoppedTail, closedAt)?.status, "stopped")
    assert.equal(endedReceiptView(closed, dialog, stoppedTail, closedAt + 5_000)?.status, "stopped")
  })

  test("看不出停止：关掉不到 1 秒先不写（不先说「别处回答」再改口），过了才写「已在其他设备回答」", () => {
    assert.equal(endedReceiptView(closed, dialog, asking, closedAt), null)
    assert.equal(endedReceiptView(closed, dialog, asking, closedAt + APPROVAL_REASON_WAIT_MS)?.status, "answered-elsewhere")
  })

  test("停在卡上（工具执行里）：pi 把紧接着的模型调用记成 error + AbortSignal 原文，也是停止；真出错不算", () => {
    const abortedCall = { kind: "assistant", key: "a2", stopReason: "error", errorMessage: "The operation was aborted.", startedAt: T0 + 30_006, blocks: [] }
    assert.equal(endedReceiptView(closed, dialog, [...asking, abortedCall], closedAt)?.status, "stopped")
    const failed = { ...abortedCall, errorMessage: "529 Overloaded" }
    assert.equal(endedReceiptView(closed, dialog, [...asking, failed], closedAt), null)
    assert.equal(endedReceiptView(closed, dialog, [...asking, failed], closedAt + APPROVAL_REASON_WAIT_MS)?.status, "answered-elsewhere")
  })

  test("开卡以前的 aborted（上一回合停止的）不算；拒绝 / 超时照旧", () => {
    const older = [{ kind: "assistant", key: "a0", stopReason: "aborted", startedAt: T0 - 60_000, blocks: [] }]
    assert.equal(endedReceiptView(closed, dialog, older, closedAt + APPROVAL_REASON_WAIT_MS)?.status, "answered-elsewhere")
    const denied = approvalEndedOf(dialog, null, [{ dialogId: "d1", note: "不用了" }], closedAt).receipt
    assert.equal(endedReceiptView(denied, dialog, stoppedTail, closedAt)?.status, "denied")
    const expired = approvalEndedOf(dialog, null, [], T0 + 120_000).receipt
    assert.equal(endedReceiptView(expired, dialog, stoppedTail, T0 + 120_000)?.status, "expired")
  })

  test("卡上：提问写「回合已停止，未作答」、工具审批写「未批准」，是结束态（不挡输入框、8 秒后消失）；容器每次渲染重算", () => {
    assert.match(approvalCard, /if \(state === "stopped"\) \{/)
    assert.match(approvalCard, /\{dialogIsApproval\(dialog\) \? "回合已停止，未批准" : "回合已停止，未作答"\}/)
    const view = dialogCardState(dialog, { dialogId: "d1", status: "stopped", at: closedAt }, closedAt)
    assert.equal(view.blocksComposer, false)
    assert.equal(view.hideAt, closedAt + 8_000)
    const container = code(read("ui/src/pi/containers/ApprovalContainer.tsx"))
    assert.match(container, /endedReceiptView\(ended\.receipt, ended\.dialog, relay\.transcript\.items, now\)/)
  })
})

describe("第五轮：终端历史从对话里的命令卡重建（页面重开后保留期外的命令也在，空态只给真没跑过命令的会话）", () => {
  const T0 = 1_792_800_000_000
  const cmd = (id, command, outputText, extra = {}) => ({ kind: "tool", id, name: "bash", argsText: "", input: { command }, outputText, state: "output-available", ...extra })
  const turn = (key, blocks) => ({ kind: "assistant", key, blocks, stopReason: "toolUse", startedAt: T0, timestamp: T0 })
  const liveOf = (id, command, extra = {}) => ({
    id,
    toolName: "bash",
    command,
    startedAt: T0 + 1_000,
    endedAt: T0 + 1_900,
    durationMs: 900,
    state: "succeeded",
    exitCode: 0,
    output: "live",
    outputTruncated: false,
    inferredEnd: false,
    ...extra,
  })

  test("按对话里的先后列；结果只读工具块（成功 / 失败 / 超时 / 已取消），没有起止时刻就不编", () => {
    const items = [
      { kind: "user", key: "u1", text: "跑", images: [], timestamp: T0 },
      turn("a1", [
        { kind: "text", text: "先跑：" },
        cmd("ok", "npm test", "\u001b[32mpass\u001b[0m\n", { stderr: "warn" }),
        { kind: "tool", id: "rd", name: "read", input: { path: "a.ts" }, outputText: "x", state: "output-available" },
      ]),
      turn("a2", [
        cmd("bad", "npm run build", "boom\n\nCommand exited with code 2", { state: "output-error" }),
        cmd("slow", "sleep 999", "", { state: "output-error", outcome: "timeout" }),
        cmd("stop", "npm run dev", "", { state: "cancelled" }),
        cmd("ok2", "git status", "clean", { exitCode: 0 }),
        cmd("ok3", "false", "", { exitCode: 1 }),
      ]),
    ]
    const list = terminalSessionItems(items, [])
    assert.deepEqual(list.map((t) => [t.id, t.state]), [["ok", "succeeded"], ["bad", "failed"], ["slow", "timed_out"], ["stop", "aborted"], ["ok2", "succeeded"], ["ok3", "failed"]])
    assert.equal(list[0].command, "npm test")
    assert.equal(list[0].output, "pass", "输出照胶囊的窗口规整（去 ANSI、去尾换行）")
    assert.equal(list[0].stderr, "warn")
    assert.deepEqual([list[0].startedAt, list[0].endedAt, list[0].durationMs], [null, null, null], "页面重开后没有起止时刻：不写耗时")
    assert.equal(list[0].inferredEnd, false)
    assert.equal(list[1].exitCode, undefined, "退出码只认工具块字段；结尾行由容器按流里的卡取（splitExitTrailer）")
    assert.equal(list[4].exitCode, 0)
    assert.equal(list[5].exitCode, 1)
  })

  test("被拒绝 / 在等审批 / 排队的没跑过，不列；还没出结果的只在回合在跑时按运行中列", () => {
    const items = [
      turn("a1", [
        cmd("deny", "rm -rf /", "", { state: "denied" }),
        cmd("deny2", "rm -rf ~", "", { state: "output-error", outcome: "denied" }),
        cmd("wait", "git push", "", { state: "waiting_approval" }),
        cmd("q", "npm i", "", { state: "queued" }),
        cmd("typing", "npm ru", "", { state: "input-streaming" }),
        cmd("run", "npm run e2e", "partial", { state: "input-available" }),
      ]),
    ]
    assert.deepEqual(terminalSessionItems(items, []), [], "回合不在跑：断在半路的不冒充运行中")
    const busy = terminalSessionItems(items, [], true)
    assert.deepEqual(busy.map((t) => [t.id, t.state]), [["run", "running"]], "页面重开后实时帧还没来，先按运行中列（参数还在流的不列）")
    assert.equal(busy[0].startedAt, null, "不拿当前时刻冒充开始时间")
  })

  test("有实时条目的用实时条目（同一个对象）；实时条目里对话还没有卡的接在最后，按开始时间", () => {
    const items = [turn("a1", [cmd("h1", "npm test", "old"), cmd("h2", "npm run lint", "old")])]
    const h2 = liveOf("h2", "npm run lint")
    const fresh2 = liveOf("n2", "b", { startedAt: T0 + 9_000, state: "running", endedAt: null, durationMs: null })
    const fresh1 = liveOf("n1", "a", { startedAt: T0 + 5_000 })
    const list = terminalSessionItems(items, [fresh2, h2, fresh1])
    assert.deepEqual(list.map((t) => t.id), ["h1", "h2", "n1", "n2"])
    assert.equal(list[1], h2)
    assert.equal(list[0].output, "old")
  })

  test("工具块对象不变就复用重建结果（流式每一批不重算整段输出）；同 id 的块只列一次", () => {
    const block = cmd("h1", "npm test", "x".repeat(10))
    const a = terminalSessionItems([turn("a1", [block])], [])
    const b = terminalSessionItems([turn("a1", [block]), turn("a2", [{ ...block }])], [])
    assert.equal(b.length, 1)
    assert.equal(a[0], b[0])
    const patched = terminalSessionItems([turn("a1", [{ ...block, outputText: "y" }])], [])
    assert.equal(patched[0].output, "y", "块换了（relay 不可变更新）就重建")
  })

  test("容器：退出码同流里的卡（结尾行 Command exited with code N 取出、从输出里去掉）；s3-terminal-ended 第一条写「失败 · 退出 1」", async () => {
    const container = code(read("ui/src/pi/containers/PaneContainer.tsx"))
    assert.match(container, /const split = splitExitTrailer\(item\.output, item\.exitCode\)/)
    assert.match(container, /if \(item\.state === "running"\) return item/)
    const tools = code(read(`${CONV}/tools.ts`))
    assert.match(tools, /const m = output \? \/\\n\*Command exited with code \(\\d\+\)\\s\*\$\/\.exec\(output\) : null/)
    const { default: ended } = await import("../ui/src/pi/dev/fixtures/live/s3-terminal-ended.ts")
    const [first] = terminalSessionItems(ended.relay.transcript.items, [])
    const m = /\n*Command exited with code (\d+)\s*$/.exec(first.output)
    assert.equal(m?.[1], "1", "重建条目把结尾行原样带着，容器从这行取退出码")
    assert.match(first.output.slice(0, m.index), /ℹ fail 1$/)
  })
})

describe("第五轮：长思考（想完以后展开：限高 +「展开全文」，长代码段收起）", () => {
  const prose = code(read(`${CONV}/PiProse.tsx`))
  const entry = prose.slice(prose.indexOf("export function PiThinkingText"), prose.indexOf("export interface PiProseProps"))

  test("想完的思考（PiThinking 只在 !live 时给 fold）超过约 12 行收起：底部渐隐，下面一行灰字「展开全文 / 收起」", () => {
    assert.match(prose, /const THINKING_FOLD_PX = 240/)
    assert.match(entry, /<PiFold maxHeight=\{THINKING_FOLD_PX\} auto toggle=\{\(open, onToggle\) => <ThinkingFoldToggle open=\{open\} onToggle=\{onToggle\} label=\{open \? "收起" : "展开全文"\} \/>\}>/)
    assert.match(entry, /<ThinkingFoldContext\.Provider value>/)
    const toggle = prose.slice(prose.indexOf("function ThinkingFoldToggle"), prose.indexOf("function ThinkingCode"))
    assert.match(toggle, /aria-expanded=\{open\}/)
    assert.match(toggle, /T_SECONDARY,\s+TOUCH_44_TEXT/, "灰字、点击区 ≥ 44")
  })

  test("回复正文和思考共用一个折叠框（PiFold：auto 先量、首帧前收好，ResizeObserver 再量）；回复的开合钮照旧居中 chevron", () => {
    const fold = prose.slice(prose.indexOf("function PiFold("), prose.indexOf("export function PiProse("))
    assert.match(fold, /const measure = \(\) => setTall\(el\.scrollHeight > maxHeight \+ FOLD_SLACK\)/)
    assert.match(fold, /useLayoutEffect\(/)
    assert.match(fold, /new ResizeObserver\(measure\)/)
    assert.match(prose, /<PiFold maxHeight=\{fold\.maxHeight\} auto=\{fold\.auto === true\} toggle=\{proseFoldToggle\}>/)
    assert.match(prose, /aria-label=\{open \? "收起" : "展开全文"\}/)
  })

  test("思考里的代码段：只在想完以后（ThinkingFoldContext）超过 12 行收起，流式中不收（新行要看得见，围栏闭合前后不跳）", () => {
    const thinkingCode = prose.slice(prose.indexOf("function ThinkingCode"), prose.indexOf("const ThinkingHeading"))
    assert.match(prose, /const THINKING_CODE_FOLD = 12/)
    assert.match(thinkingCode, /const lines = fold \? text\.split\("\\n"\)\.length : 0/)
    assert.match(thinkingCode, /maxHeight: `calc\(\$\{THINKING_CODE_FOLD\}lh \+ 12px\)`/)
    assert.match(thinkingCode, /label=\{open \? "收起代码" : `展开代码（\$\{lines\} 行）`\}/)
  })
})

describe("第五轮：流式补全扩到链接、删除线、表格行（closeOpenMarkdown）", () => {
  test("删除线同加粗：补 ~~，开了没字的去掉；单个 ~ 不当标记", () => {
    assert.equal(closeOpenInline("~~旧的写法"), "~~旧的写法~~")
    assert.equal(closeOpenInline("看 ~~"), "看")
    assert.equal(closeOpenInline("**粗 ~~删"), "**粗 ~~删~~**", "由内到外补")
    assert.equal(closeOpenInline("约 ~5 分钟"), "约 ~5 分钟")
  })

  test("结尾停在还看不出开关的标记字符上（闭合 ** 的第一个 *、`` 的第一个 `、行尾 \\）：先不画这串", () => {
    assert.equal(closeOpenInline("**重要*"), "**重要**")
    assert.equal(closeOpenInline("**重要 *"), "**重要**", "闭合字符紧贴着字")
    assert.equal(closeOpenInline("~~旧~"), "~~旧~~")
    assert.equal(closeOpenInline("``a`"), "``a``")
    assert.equal(closeOpenInline("``"), "")
    assert.equal(closeOpenInline("C:\\"), "C:")
    assert.equal(closeOpenInline("**重要** 说完"), "**重要** 说完")
  })

  test("链接：网址写到一半补 )（括号配对、标题引号先补）；链接文字写到一半 / 停在 ] 补成 [文字]()；] 后不是 ( 按字面", () => {
    assert.equal(closeOpenInline("详见 [文档](https://exa"), "详见 [文档](https://exa)")
    assert.equal(closeOpenInline("详见 [文档]("), "详见 [文档]()")
    assert.equal(closeOpenInline("详见 [文档](https://x.com/a_(b"), "详见 [文档](https://x.com/a_(b))")
    assert.equal(closeOpenInline('详见 [文档](https://x.com "标'), '详见 [文档](https://x.com "标")')
    assert.equal(closeOpenInline("详见 [文"), "详见 [文]()")
    assert.equal(closeOpenInline("详见 [文档]"), "详见 [文档]()")
    assert.equal(closeOpenInline("详见 ["), "详见")
    assert.equal(closeOpenInline("详见 [文档] 了"), "详见 [文档] 了")
    assert.equal(closeOpenInline("**看 [文档](https://x"), "**看 [文档](https://x)**")
    assert.equal(closeOpenInline("[**粗"), "[**粗**]()")
    assert.equal(closeOpenInline("[a](b) 和 `c"), "[a](b) 和 `c`")
    assert.equal(closeOpenInline("\\[不是链接"), "\\[不是链接")
  })

  test("任务清单：列表项只写到 [ ] / [x] 时先不画（不当链接、不露出 [x]），后面有字了照原文", () => {
    for (const t of ["- [", "- [ ", "- [x", "- [ ]", "- [x] "]) assert.equal(closeOpenMarkdown(t), "", JSON.stringify(t))
    assert.equal(closeOpenMarkdown("- [x] 买菜"), "- [x] 买菜")
    assert.equal(closeOpenMarkdown("步骤：\n- [ ]"), "步骤：\n")
  })

  test("只敲了块标记的最后一行先不画（不先把上一行变成 setext 标题、不先当段落里的 1.）；行尾有换行的照画", () => {
    for (const [t, want] of [
      ["步骤：\n-", "步骤：\n"],
      ["步骤：\n- ", "步骤：\n"],
      ["1. 一\n2.", "1. 一\n"],
      ["## ", ""],
      ["> ", ""],
      ["前言\n\n|", "前言\n\n"],
    ]) {
      assert.equal(closeOpenMarkdown(t), want, JSON.stringify(t))
    }
    assert.equal(closeOpenMarkdown("段落\n---\n"), "段落\n---\n")
  })

  test("表格：分隔行没到 / 写到一半补成完整的（格数随表头、对齐照留）；最后一行只有 | 先不画；表头前得是空行 / 标题 / 开头", () => {
    assert.equal(closeOpenTable("| 名称 | 说"), "| 名称 | 说\n| --- | --- |")
    assert.equal(closeOpenTable("| 名称 | 说明 |\n"), "| 名称 | 说明 |\n| --- | --- |\n")
    assert.equal(closeOpenTable("| 名称 | 说明 |\n| :-"), "| 名称 | 说明 |\n| :- | --- |")
    assert.equal(closeOpenTable("| 名称 | 说明 |\n| :"), "| 名称 | 说明 |\n| :--- | --- |")
    assert.equal(closeOpenTable("| 名称 | 说明 |\n| --- | --- |\n| a | b |\n|"), "| 名称 | 说明 |\n| --- | --- |\n| a | b |")
    assert.equal(closeOpenTable("| 名称 | 说明 |\n| --- | --- |\n| a"), "| 名称 | 说明 |\n| --- | --- |\n| a", "半行照画（GFM 补空格）")
    assert.equal(closeOpenTable("## 对比\n| a | b"), "## 对比\n| a | b\n| --- | --- |")
    assert.equal(closeOpenTable("段落\n| a | b"), "段落\n| a | b", "段落续行里的 | 不动")
    assert.equal(closeOpenTable("| a | b |\n| 不是分隔行"), "| a | b |\n| 不是分隔行")
    assert.equal(closeOpenTable("```\n| a | b"), "```\n| a | b", "围栏里的不算")
    assert.equal(closeOpenMarkdown("| **名"), "| **名**\n| --- |", "格里的行内标记先补，再补分隔行")
  })

  test("流式的活动尾部：围栏头那行没写完先不出代码框；一出来就按围栏的语言（卡头不改口），收尾的 ` / `` 不当代码；流式中不走 shiki", () => {
    const prose = code(read(`${CONV}/PiProse.tsx`))
    assert.match(prose, /if \(!last\.raw\.includes\("\\n"\)\) return \{ head, open: null, lang: "plain" \}/)
    assert.match(prose, /const lang = last\.lang\?\.trim\(\)\.split\(\/\\s\+\/\)\[0\] \|\| "plain"/)
    assert.match(prose, /openCode: \(text, lang\) => <PiCodeBlock code=\{text\} lang=\{lang\} streaming \/>/)
    assert.match(codeBlock, /const viaShiki = route\.via === "shiki" && !streaming/)
    assert.match(codeBlock, /useCachedHighlightLines\(viaShiki \? text : null, viaShiki \? route\.lang : null\)/)
  })
})

describe("第六轮：被停止的写入 / 编辑卡标「已取消」", () => {
  test("接线：消息停在半路（用户停止）时没跑完的工具算已取消；diff 卡收 cancelled，读取 / 其他工具行尾灰字「已取消」，探查行不再转圈", () => {
    assert.match(transcript, /const stopped = !item\.live && stoppedEnd\(item\.stopReason, item\.errorMessage\)/)
    assert.match(transcript, /cancelled=\{status === "aborted"\}/)
    assert.match(transcript, /trailing=\{status === "failed" \? "失败" : status === "aborted" \? "已取消" : undefined\}/)
    assert.match(transcript, /status === "denied" \? "已拒绝" : status === "aborted" \? "已取消" : undefined/)
    assert.match(transcript, /group\.some\(\(g\) => streamToolStatus\(g, stopped\) === "running"\)/)
    assert.match(transcript, /group\.map\(\(g\) => exploreRowOf\(g, stopped\)\)/)
    assert.match(tools, /return stopReason === "aborted" \|\| \(stopReason === "error" && turnErrorOf\("error", errorMessage\)\?\.error === false\)/)
    assert.match(diffCard, /\{failed \? "未生效" : "已取消"\}/)
  })

  test("没有 patch 的 edit（失败 / 被停止 / 参数还在写）按参数画出要改的行；什么都画不出来时（停止时 pi 丢掉了半截参数）出一行字，不出空卡", () => {
    assert.match(transcript, /const edits = patch \|\| content != null \? undefined : editsOf\(b\)/)
    assert.match(transcript, /if \(patch \|\| content != null \|\| edits\) \{\s*out\.push\(\s*<PiDiffCard/)
    assert.match(transcript, /const line = diffLineOf\(b, status === "running"\)/)
    assert.match(diffCard, /: edits\s*\? editsToLines\(edits\)/)
  })
})

describe("第六轮：未载入会话的第一条消息（名册先于 harness_start 回执到达时被判「启动已取消」，消息丢失）", () => {
  const relay = read("ui/src/relay/useRelay.ts")
  const cut = (from, end) => {
    const at = relay.indexOf(from)
    assert.ok(at >= 0, from)
    const tail = relay.slice(at).match(end)
    assert.ok(tail, String(end))
    return relay.slice(at, at + tail.index + tail[0].length)
  }
  // 跑 useRelay 里真正的 takePendingRooms / clearPending（切出源码、去掉类型、配假的 ref），不在测试里另抄一份
  const takeSrc = cut("function takePendingRooms(", /\n\s*return found\r?\n\s*\}/)
  const clearSrc = cut("const clearPending = useCallback(", /\}, \[\]\)/)
  const starts = () => {
    const refs = { pendingWatchRef: { current: {} }, armingRef: { current: {} }, resolvedArmingAt: { current: new Set() } }
    const deps = { ...refs, devicesRef: { current: [] }, devicePlatformOf, findStartedRoom, useCallback: (fn) => fn, setCommandInFlight: () => {}, setPendingStarts: () => {} }
    const make = new Function(...Object.keys(deps), `${stripTypeScriptTypes(`${takeSrc}\n${clearSrc}`)}\nreturn { takePendingRooms, clearPending }`)
    return { ...refs, ...make(...Object.values(deps)) }
  }
  const watch = (at) => ({ kind: "session", key: "s1", at, seen: new Set() })
  const roster = [{ id: "s1", deviceId: "d1", online: true }]

  test("名册先到、回执还没回：成功结案的标记留给回执（回执凭它走「已结案」，不再判「启动已取消」）", () => {
    const s = starts()
    s.armingRef.current.d1 = watch(100)
    const started = s.takePendingRooms(roster)
    assert.deepEqual(started.map((item) => item.room.id), ["s1"])
    for (const item of started) s.clearPending(item.deviceId, true)
    assert.equal(s.armingRef.current.d1, undefined)
    assert.equal(s.resolvedArmingAt.current.has(100), true)
  })

  test("真正的取消 / 超时 / 掉线照旧清标记；回执先回、名册后到的标记没人认领，也不留", () => {
    const cancelled = starts()
    cancelled.armingRef.current.d1 = watch(200)
    cancelled.resolvedArmingAt.current.add(200)
    cancelled.clearPending("d1")
    assert.equal(cancelled.resolvedArmingAt.current.has(200), false)
    const acked = starts()
    acked.pendingWatchRef.current.d1 = watch(300)
    for (const item of acked.takePendingRooms(roster)) acked.clearPending(item.deviceId, true)
    assert.equal(acked.pendingWatchRef.current.d1, undefined)
    assert.equal(acked.resolvedArmingAt.current.size, 0)
  })

  test("接线：只有名册路径传 keepResolved；回执先认结案标记、再判「启动已取消」", () => {
    assert.match(relay, /const clearPendingRef = useRef<\(deviceId: string, keepResolved\?: boolean\) => void>/)
    assert.match(relay, /const started = takePendingRooms\(list\)[\s\S]{0,400}for \(const item of started\) clearPendingRef\.current\(item\.deviceId, true\)/)
    const kept = relay.match(/clearPendingRef\.current\([^)]*\)/g).filter((call) => call.includes(", true"))
    assert.deepEqual(kept, ["clearPendingRef.current(item.deviceId, true)"])
    const begin = cut("const beginHarness = useCallback", /const flushLazySend = useCallback/)
    const resolved = begin.indexOf("if (resolvedArmingAt.current.has(at))")
    assert.ok(resolved > 0 && resolved < begin.indexOf('error: "启动已取消"'))
  })
})
