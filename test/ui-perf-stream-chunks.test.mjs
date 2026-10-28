// UI·perf 中-5：流式 markdown 的稳定前缀按块切开（只新增/锁定已完成段）的纯逻辑 + 源码契约。
// 不启动浏览器、不依赖 React；Node ≥22.18 直接剥离 TS 类型 import .ts 源文件。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { stableChunksOf } from "../ui/src/components/pi/conversation/streamChunks.ts"
import { splitStreamingMarkdown } from "../ui/src/components/ui/streaming-markdown-core.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
/** marked 只装在 ui/ 下（仓库根没有这条依赖），测试直接从 ui 的 node_modules 取 ESM 入口 */
const { marked } = await import(pathToFileURL(path.join(ROOT, "ui/node_modules/marked/lib/marked.esm.js")).href)
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

/** 把前缀切成块后逐块渲染，再和整段渲染比较（marked 只是解析代理；块结构口径与 remark 一致） */
function renderChunked(prefix) {
  return stableChunksOf(prefix)
    .map((chunk) => marked.parse(chunk))
    .join("")
}
function renderWhole(prefix) {
  return marked.parse(prefix)
}
const norm = (html) => html.replace(/\n+$/, "")

const SAMPLES = [
  "第一段文字。\n\n第二段带 **粗体** 和 `code`。\n\n第三段收尾。\n\n",
  "- 一\n- 二\n\n- 三（松散列表的续项）\n\n后面一段。\n\n",
  "> 引用一\n>\n> 引用二\n\n正文\n\n",
  "```ts\nconst x = 1\n\nconst y = 2\n```\n\n代码块后面的段落。\n\n",
  "| 名称 | 状态 |\n| --- | --- |\n| a | ok |\n\n表格后的段落。\n\n",
  "## 小标题\n\n正文一\n\n正文二\n\n- 列表\n- 两项\n\n",
]

describe("stableChunksOf：按块切片（列表/围栏/表格整块保留）", () => {
  test("空串没有块", () => {
    assert.deepEqual(stableChunksOf(""), [])
  })

  test("普通段落逐个成块；块内容不含块间空行", () => {
    assert.deepEqual(stableChunksOf("A\n\nB\n\nC\n\n"), ["A", "B", "C"])
  })

  test("列表（含松散列表的空行）整块保留，不会被切成两个列表（编号不会从 1 重来）", () => {
    const chunks = stableChunksOf("- a\n- b\n\n- c\n\n")
    assert.equal(chunks.length, 1)
    assert.match(chunks[0], /- a[\s\S]*- c/)
  })

  test("围栏代码里的空行不切块；GFM 表格整块保留", () => {
    assert.deepEqual(stableChunksOf("```ts\nconst x = 1\n\nconst y = 2\n```\n\n"), ["```ts\nconst x = 1\n\nconst y = 2\n```"])
    assert.deepEqual(stableChunksOf("| a | b |\n| --- | --- |\n| 1 | 2 |\n\n"), ["| a | b |\n| --- | --- |\n| 1 | 2 |"])
  })

  test("逐块渲染与整段渲染等价（块边界不改变结构）", () => {
    for (const sample of SAMPLES) {
      assert.equal(norm(renderChunked(sample)), norm(renderWhole(sample)), JSON.stringify(sample.slice(0, 20)))
    }
  })

  test("流式推进：稳定前缀变长只追加新块，已有块的内容字符串一字不变（memo 才命得中）", () => {
    const text = "开头一段。\n\n第二段。\n\n- 一\n- 二\n\n最后一段。\n\n"
    let prev = []
    for (let i = 0; i < text.length; i += 1) {
      // 真实调用面是 splitStreamingMarkdown 切出来的稳定前缀（只有它进 stableChunksOf）
      const { prefix } = splitStreamingMarkdown(text.slice(0, i + 1))
      const chunks = stableChunksOf(prefix)
      // 除最后一块（还在长的那块）之外，已有块必须是新一轮的原样前缀
      for (let k = 0; k < prev.length - 1; k += 1) assert.equal(chunks[k], prev[k], `第 ${i} 个字符时第 ${k} 块变了`)
      prev = chunks
    }
    assert.deepEqual(stableChunksOf(text), ["开头一段。", "第二段。", "- 一\n- 二", "最后一段。"])
  })

  test("和 splitStreamingMarkdown 的分工：前缀交给切块器，尾部一个字符都不丢", () => {
    const text = "已稳定的段落。\n\n正在流式输出的半句"
    const { prefix, tail } = splitStreamingMarkdown(text)
    assert.equal(prefix + tail, text)
    assert.deepEqual(stableChunksOf(prefix), ["已稳定的段落。"])
    assert.equal(tail, "正在流式输出的半句")
  })
})

describe("源码契约：PiProse 的前缀按块 memo（中-5）", () => {
  const src = code(read("ui/src/components/pi/conversation/PiProse.tsx"))
  const streaming = src.slice(src.indexOf("function StreamingMarkdown("), src.indexOf("export interface PiProseProps"))

  test("稳定前缀走 stableChunksOf，按块逐个 MarkdownBlock（下标 key 稳定，只追加新块）", () => {
    assert.match(streaming, /const chunks = useMemo\(\(\) => stableChunksOf\(split\.prefix\), \[split\.prefix\]\)/)
    assert.match(streaming, /chunks\.map\(\(chunk, index\) =>/)
    assert.match(streaming, /<MarkdownBlock key=\{index\} content=\{chunk\} \/>/)
    assert.doesNotMatch(streaming, /\{split\.prefix && <MarkdownBlock content=\{split\.prefix\} \/>\}/, "不再整段前缀重解析")
  })

  test("活动尾部照旧：parseStreamingTail + 未闭合围栏当纯文本（不回归 D06）", () => {
    assert.match(streaming, /parseStreamingTail\(split\.tail\)/)
    assert.match(streaming, /open-code/)
    assert.match(src, /const MarkdownBlock = memo\(function MarkdownBlock/)
  })
})
