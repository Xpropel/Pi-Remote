// UI·perf 中-1（主界面消息级 memo + 容器派生缓存）/ 高-1（Claude 变体对话流的 300 条渲染窗）回归。
// memo 的运行时行为要真浏览器（见 开发工具（未随公开仓提供）），这里锁两件事：① memo 的**前提**（未变条目保持引用、集合按身份缓存）；
// ② 源码契约（ClaudeThread 的窗口接线、PiTranscript 的 memo、TranscriptContainer 的派生缓存）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { piItemsOf } from "../ui/src/pi/model/transcriptView.ts"
import { PI_TRANSCRIPT_WINDOW, showEarlierText, transcriptWindowOf } from "../ui/src/pi/model/transcriptWindow.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

const assistant = (key, text, live) => ({
  kind: "assistant",
  key,
  live,
  blocks: [{ kind: "text", text }],
  stopReason: live ? "pending" : "end",
})
const user = (key, text) => ({ kind: "user", key, text, images: [] })

describe("中-1：memo 的前提 —— 流式只改最后一条，其余条目引用不变", () => {
  test("piItemsOf：没有要改的条目原样返回同一个对象（首帧之后都是同一批引用）", () => {
    const base = [user("u1", "第一问"), assistant("a1", "答一"), user("u2", "第二问"), assistant("a2", "答二", true)]
    const first = piItemsOf(base, null)
    assert.equal(first.length, base.length)
    first.forEach((item, i) => assert.equal(item, base[i], "没有 patch / observedMs 的条目原样返回"))

    // 流式下一帧：只有最后一条换引用（文本变长），前面的条目还是同一批对象
    const streamed = [...base.slice(0, -1), assistant("a2", "答二，又多了一个字", true)]
    const next = piItemsOf(streamed, null)
    for (let i = 0; i < next.length - 1; i += 1) assert.equal(next[i], first[i], `第 ${i} 条不该换引用`)
    assert.notEqual(next[next.length - 1], first[first.length - 1], "最后一条换了（要重渲染）")
  })

  test("piItemsOf：只有 observedMs 命中的思考块才换引用，其余条目不动", () => {
    const thinking = { kind: "assistant", key: "a1", blocks: [{ kind: "thinking", text: "想一想" }, { kind: "text", text: "答" }] }
    const plain = assistant("a0", "前面的回答")
    const observed = new Map([["a1:0", 1200]])
    const items = piItemsOf([plain, thinking], observed)
    assert.equal(items[0], plain)
    assert.notEqual(items[1], thinking)
    assert.equal(items[1].blocks[0].observedMs, 1200)
    assert.equal(items[1].blocks[1], thinking.blocks[1], "没变的块保引用")
  })
})

describe("中-1：源码契约（消息级 memo + 容器派生缓存）", () => {
  const transcript = code(read("ui/src/components/pi/conversation/PiTranscript.tsx"))
  const container = code(read("ui/src/pi/containers/TranscriptContainer.tsx"))

  test("ItemView 是 memo 组件（默认浅比较 = 全 prop 按引用比较）", () => {
    assert.match(transcript, /const ItemView = memo\(function ItemView\(\{ item, variant, density, open, fold, foldLong, subagentSlot, replyMeta, showRetry, onOpenImage \}: ItemViewProps\)/)
    assert.match(transcript, /\}\)\n\nfunction isLiveTail/)
  })

  test("open / fold 两个 Set 按 expanded / folded 的身份缓存，时钟 tick 不造新 Set（否则 memo 每次被打穿）", () => {
    assert.match(transcript, /const open = useMemo\(\(\) => new Set\(expanded\), \[expanded\]\)/)
    assert.match(transcript, /const fold = useMemo\(\(\) => new Set\(folded\), \[folded\]\)/)
    assert.doesNotMatch(transcript, /const open = new Set\(expanded\)/)
  })

  test("expanded / folded 的缺省值是模块级常量（默认参数写 = [] 每次渲染都是新数组，memo 永远命不中）", () => {
    assert.match(transcript, /const NO_BLOCK_KEYS: readonly string\[\] = \[\]/)
    assert.match(transcript, /expanded = NO_BLOCK_KEYS/)
    assert.match(transcript, /folded = NO_BLOCK_KEYS/)
    assert.doesNotMatch(transcript, /expanded = \[\]/)
    assert.doesNotMatch(transcript, /folded = \[\]/)
  })

  test("容器：piItems / items 按输入身份派生，openImage 用 useCallback 稳定引用", () => {
    assert.match(container, /const piItems = useMemo\(/)
    assert.match(container, /\[liveItems, archiveItems, fallbackItems, observed\]/)
    assert.match(container, /const items = useMemo\(\(\) => \(outboxItems\.length > 0 \? \[\.\.\.piItems, \.\.\.outboxItems\] : piItems\), \[piItems, outboxItems\]\)/)
    assert.match(container, /const openImage = useCallback<PiOpenImage>\(/)
  })
})

describe("高-1：Claude 对话流的 300 条渲染窗（与主界面同口径）", () => {
  const thread = code(read("ui/src/pi/variants/claude/thread/ClaudeThread.tsx"))
  const parts = code(read("ui/src/pi/variants/claude/thread/ClaudeProseParts.tsx"))

  test("窗口常量与文案复用主界面的 transcriptWindow（不另起一套数字）", () => {
    assert.match(thread, /import \{ PI_TRANSCRIPT_WINDOW, transcriptWindowOf \} from "@\/pi\/model\/transcriptWindow"/)
    assert.match(thread, /const \[limit, setLimit\] = useState\(PI_TRANSCRIPT_WINDOW\)/)
    assert.match(thread, /const win = useMemo\(\(\) => transcriptWindowOf\(visible, limit\), \[visible, limit\]\)/)
    assert.match(parts, /import \{ showEarlierText \} from "@\/pi\/model\/transcriptWindow"/)
  })

  test("整表渲染改成窗口渲染：不再 map 全量 visible，只见 win.visible", () => {
    assert.match(thread, /\{win\.visible\.map\(\(item\) => \{/)
    assert.doesNotMatch(thread, /\{visible\.map\(\(item\) => \{/)
  })

  test("「显示更早的 N 条」：仍有更早的条目时出这一行，点一次多挂一页并还原滚动位置", () => {
    assert.match(thread, /\{win\.hidden > 0 \? <ClaudeShowEarlier hidden=\{win\.hidden\} nextPage=\{win\.nextPage\} onShow=\{showEarlier\} \/> : null\}/)
    assert.match(thread, /restoreRef\.current = el \? el\.scrollHeight - el\.scrollTop : null/)
    assert.match(thread, /setLimit\(\(l\) => l \+ PI_TRANSCRIPT_WINDOW\)/)
    assert.match(thread, /el\.scrollTop = el\.scrollHeight - restoreRef\.current/)
    assert.match(parts, /export function ClaudeShowEarlier\(\{ hidden, nextPage, onShow \}/)
    assert.match(parts, /\{showEarlierText\(nextPage\)\}/)
  })

  test("换会话把窗收回 300（渲染期间就收，不会先挂上旧会话的整段历史）", () => {
    assert.match(thread, /const \[shownRoom, setShownRoom\] = useState\(roomId\)/)
    assert.match(thread, /if \(roomId !== shownRoom\) \{\s*\n\s*setShownRoom\(roomId\)\s*\n\s*setLimit\(PI_TRANSCRIPT_WINDOW\)/)
  })

  test("窗口数学就是主界面那一套：1 万条 → 挂 300 条、窗外 9700、文案一致", () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({ key: `k${i}` }))
    const win = transcriptWindowOf(items, PI_TRANSCRIPT_WINDOW)
    assert.equal(win.visible.length, 300)
    assert.equal(win.hidden, 9700)
    assert.equal(win.nextPage, 300)
    assert.equal(showEarlierText(win.nextPage), "显示更早的 300 条")
    const page = transcriptWindowOf(items, PI_TRANSCRIPT_WINDOW * 2)
    assert.equal(page.visible.length, 600)
    assert.equal(page.hidden, 9400)
  })

  test("改动留在 thread/：不新增对 shell / sidebar / composer / 面板 / cursor 组件的依赖", () => {
    const imports = [...thread.matchAll(/from "([^"]+)"/g)].map((m) => m[1])
    const forbidden = ["../shell/", "../sidebar/", "../composer/", "../pages/", "../panels/", "../chrome/", "../overlays/", "../phone/", "@/components/"]
    for (const spec of imports) {
      assert.ok(!forbidden.some((prefix) => spec.startsWith(prefix)), `ClaudeThread 不该 import：${spec}`)
    }
    // 主界面那套窗口纯函数是白名单里的 model（与 transcriptView 同层）
    assert.ok(imports.includes("@/pi/model/transcriptWindow"))
  })
})
