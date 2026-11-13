/**
 * PiProse / PiThinkingText 的真渲染测试（react-dom/server 渲染后断言 HTML）：把流式正文的「不闪不跳」落到渲染结果上。
 *  - 不闪：逐字推进的每一个时刻，看得见的字里都没有孤立的标记字符（` ** ~~ [ ] | #）和半截网址；
 *  - 不跳：字只在末尾长（前一刻看得见的字是下一刻的前缀），已经画好的块（除了最后一块）HTML 一字不变，代码框的卡头语言名不改口。
 *
 * 部件是 .tsx、import 走 @/ 别名，node 直接加载不了：用 ui 自带的 rolldown 把入口连同本仓源码打成一个 ESM
 * （npm 包都留作外部，从 ui/node_modules 解析，和这里的 react-dom/server 共用一份 React），写进 ui/node_modules/.cache 再 import。
 */
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const UI = path.join(ROOT, "ui")
const OUT_DIR = path.join(UI, "node_modules", ".cache", "pi-s3-render")
const uiRequire = createRequire(path.join(UI, "package.json"))
const React = uiRequire("react")
const { renderToStaticMarkup } = uiRequire("react-dom/server")

async function bundleEntry(rel) {
  const pkgDir = path.join(UI, "node_modules", "rolldown")
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"))
  const main = typeof pkg.exports["."] === "string" ? pkg.exports["."] : pkg.exports["."].import
  const { rolldown } = await import(pathToFileURL(path.join(pkgDir, typeof main === "string" ? main : main.default)).href)
  const bundle = await rolldown({
    input: path.join(UI, rel),
    cwd: UI,
    platform: "node",
    resolve: { alias: { "@": path.join(UI, "src") } },
    external: (id) => !id.startsWith(".") && !id.startsWith("@/") && !path.isAbsolute(id) && !id.startsWith("\0"),
    transform: { jsx: "react-jsx" },
    plugins: [{ name: "stub-css", load: (id) => (id.endsWith(".css") ? { code: "export default {}", moduleType: "js" } : null) }],
  })
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const file = path.join(OUT_DIR, `${path.basename(rel).replace(/\W/g, "_")}-${process.pid}.mjs`)
  await bundle.write({ file, format: "esm" })
  await bundle.close()
  return file
}

/* ---------------- 极简 HTML 树（react-dom/server 的输出：属性值里的 < > 都已转义） ---------------- */

const VOID = new Set(["br", "hr", "img", "input", "wbr", "col"])
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&")

function parse(html) {
  const root = { tag: "#root", attrs: {}, children: [] }
  const stack = [root]
  for (const m of html.matchAll(/<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    const top = stack[stack.length - 1]
    if (m[1]) {
      stack.pop()
      continue
    }
    if (m[2]) {
      const attrs = {}
      for (const a of m[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? "")
      const node = { tag: m[2].toLowerCase(), attrs, children: [], html: "" }
      top.children.push(node)
      if (!m[4] && !VOID.has(node.tag)) stack.push(node)
      continue
    }
    top.children.push(decode(m[5]))
  }
  return root
}

const isEl = (n) => typeof n === "object"
function serialize(n) {
  if (!isEl(n)) return n
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("")
  return `<${n.tag}${attrs}>${n.children.map(serialize).join("")}</${n.tag}>`
}
function find(n, pred) {
  if (!isEl(n)) return null
  if (pred(n)) return n
  for (const c of n.children) {
    const hit = find(c, pred)
    if (hit) return hit
  }
  return null
}
function findAll(n, pred, out = []) {
  if (!isEl(n)) return out
  if (pred(n)) out.push(n)
  for (const c of n.children) findAll(c, pred, out)
  return out
}
/** 看得见的字；skip 命中的子树不算（代码框另查） */
function textOf(n, skip = () => false) {
  if (!isEl(n)) return n
  if (skip(n)) return ""
  return n.children.map((c) => textOf(c, skip)).join("")
}
const part = (name) => (n) => n.attrs["data-pi-part"] === name
const isCodeBlock = part("code-block")

/** PiProse 的块：<div data-pi-part="prose"><div>{AgentProse}</div></div>，AgentProse 的子元素就是一块块的正文 */
function proseBlocks(tree) {
  const prose = find(tree, part("prose"))
  return prose.children[0].children[0].children.filter(isEl)
}

/** 块开头的块标记（"- " "1." "#" ">" "|"）原样露在字里 = 结构没画出来 */
const RAW_BLOCK_START = /^\s*(?:[-+*][ \t]|\d+[.)]|#|>|\|)/
/** 孤立的行内标记字符、半截链接 / 网址 */
const RAW_INLINE = /\*\*|~~|`|\[|\]|\]\(|https?:/

let mod
let files = []

before(async () => {
  const file = await bundleEntry("src/components/pi/conversation/PiProse.tsx")
  files.push(file)
  mod = await import(pathToFileURL(file).href)
})

after(() => {
  for (const f of files) fs.rmSync(f, { force: true })
})

const proseHtml = (props) => renderToStaticMarkup(React.createElement(mod.PiProse, props))
const thinkingHtml = (props) => renderToStaticMarkup(React.createElement(mod.PiThinkingText, props))

/**
 * 逐字推进 doc，每一刻都渲染一遍：
 *  - 不闪：看得见的字（代码框除外）没有孤立的标记字符，块开头不露块标记；
 *  - 不跳：看得见的字（去掉空白后）只在末尾长；除了最后一块，前一刻画好的每一块下一刻 HTML 一字不变；块数不减；
 *  - 代码框一出来卡头就是最终的语言名，代码只在末尾长。
 */
function assertSteadyStream(doc, renderAt, blocksOf) {
  let prevText = ""
  let prevBlocks = []
  const labels = new Set()
  let prevCode = ""
  for (let n = 1; n <= doc.length; n++) {
    const shown = JSON.stringify(doc.slice(Math.max(0, n - 40), n))
    const tree = parse(renderAt(doc.slice(0, n)))
    const blocks = blocksOf(tree)
    for (const block of blocks) {
      if (isCodeBlock(block)) continue
      const text = textOf(block, (x) => isCodeBlock(x) || x.tag === "code")
      assert.doesNotMatch(text, RAW_INLINE, `第 ${n} 字时露出了标记：${shown} → ${JSON.stringify(text)}`)
      for (const cell of findAll(block, (x) => ["p", "li", "th", "td", "h3", "h4"].includes(x.tag))) {
        assert.doesNotMatch(textOf(cell, (x) => x.tag === "code"), RAW_BLOCK_START, `第 ${n} 字时块标记露成了字：${shown}`)
      }
    }
    const text = blocks
      .filter((b) => !isCodeBlock(b))
      .map((b) => textOf(b))
      .join("")
      .replace(/\s+/g, "")
    assert.ok(text.startsWith(prevText), `第 ${n} 字时字往回跳了：${shown}\n前：${prevText.slice(-30)}\n后：${text.slice(-30)}`)
    assert.ok(blocks.length >= prevBlocks.length, `第 ${n} 字时块数变少了：${shown}`)
    for (let k = 0; k < prevBlocks.length - 1; k++) {
      assert.equal(serialize(blocks[k]), serialize(prevBlocks[k]), `第 ${n} 字时第 ${k + 1} 块重画了：${shown}`)
    }
    const code = blocks.find(isCodeBlock)
    if (code) {
      labels.add(textOf(find(code, part("code-head"))))
      const body = textOf(code.children[1])
      assert.ok(body.startsWith(prevCode), `第 ${n} 字时代码往回跳了：${shown}`)
      prevCode = body
    }
    prevText = text
    prevBlocks = blocks
  }
  return labels
}

const REPLY = [
  "改好了，**关键**是 `total()` 漏算了运费，~~旧的写法~~已经删掉。详见 [说明文档](https://example.com/docs/cart) 。",
  "改动如下：",
  "- 修了 `cart.ts` 的合计",
  "- 补了 **两条** 测试",
  "",
  "## 结论",
  "",
  "| 文件 | 改动 |",
  "| --- | :---: |",
  "| `cart.ts` | 加上运费 |",
  "| `cart.test.ts` | 新增 [2 条](https://example.com/t) |",
  "",
  "1. 先跑 `npm test`",
  "2. 再跑 lint",
  "",
  "```ts",
  "export const total = (items) => sum(items) + shipping",
  "```",
  "",
  "都通过了。",
].join("\n")

describe("PiProse 流式逐字渲染（react-dom/server）", () => {
  test("不闪不跳：行内代码、加粗、删除线、链接、列表（紧跟段落）、标题、表格、编号列表、代码块逐字写出来", () => {
    const labels = assertSteadyStream(REPLY, (text) => proseHtml({ markdown: text, streaming: true }), proseBlocks)
    assert.deepEqual([...labels], ["TypeScript"], "代码框一出来卡头就是最终的语言名")
  })

  test("写完时的结构：链接、删除线、表格（对齐）、列表、代码框都在", () => {
    const tree = parse(proseHtml({ markdown: REPLY, streaming: true }))
    assert.equal(find(tree, (n) => n.tag === "a")?.attrs.href, "https://example.com/docs/cart")
    assert.equal(textOf(find(tree, (n) => n.tag === "del")), "旧的写法")
    assert.equal(findAll(tree, (n) => n.tag === "tr").length, 3)
    assert.equal(findAll(tree, (n) => n.tag === "li").length, 4)
    assert.equal(findAll(tree, isCodeBlock).length, 1)
  })

  test("链接：网址写到一半时只画链接文字（不完整的网址不出 href），写够了才是真链接；字的位置一直不动", () => {
    const at = (s) => parse(proseHtml({ markdown: s, streaming: true }))
    for (const s of ["详见 [说", "详见 [说明]", "详见 [说明](", "详见 [说明](https:/"]) {
      const tree = at(s)
      assert.equal(textOf(tree), s.startsWith("详见 [说明") ? "详见 说明" : "详见 说", s)
      assert.equal(find(tree, (n) => n.tag === "a"), null, s)
    }
    assert.equal(find(at("详见 [说明](https://e"), (n) => n.tag === "a")?.attrs.href, "https://e")
    assert.equal(textOf(at("详见 [说明] 和")), "详见 [说明] 和", "] 后面不是 ( 就不是链接，按字面")
  })

  test("表格：表头一出来就是表格（分隔行补齐、对齐照留）；只敲了 | 的下一行先不画", () => {
    const at = (s) => parse(proseHtml({ markdown: s, streaming: true }))
    for (const s of ["| 文件 | 改", "| 文件 | 改动 |", "| 文件 | 改动 |\n|", "| 文件 | 改动 |\n| --- | :-"]) {
      const tree = at(s)
      assert.ok(find(tree, (n) => n.tag === "table"), s)
      assert.equal(findAll(tree, (n) => n.tag === "th").length, 2, s)
      assert.equal(findAll(tree, (n) => n.tag === "td").length, 0, s)
    }
    const rows = at("| 文件 | 改动 |\n| --- | --- |\n| a | b |\n|")
    assert.equal(findAll(rows, (n) => n.tag === "tr").length, 2, "空行不画")
  })

  test("围栏头那行没写完不出代码框；一出来卡头就是最终语言名（不在「纯文本」和语言名之间跳）", () => {
    const at = (s) => parse(proseHtml({ markdown: s, streaming: true }))
    assert.equal(find(at("前言\n\n```pyth"), isCodeBlock), null)
    const open = find(at("前言\n\n```python\nprint(1"), isCodeBlock)
    assert.equal(textOf(find(open, part("code-head"))), "Python")
    const closed = find(at("前言\n\n```python\nprint(1)\n```\n\n后面"), isCodeBlock)
    assert.equal(textOf(find(closed, part("code-head"))), "Python")
  })

  test("停在半路（cut）的回复补闭合；正常结束的回复原样", () => {
    const cut = parse(proseHtml({ markdown: "结论：**测试都过", cut: true }))
    assert.equal(textOf(find(cut, (n) => n.tag === "strong")), "测试都过")
    const done = parse(proseHtml({ markdown: "结论：**测试都过" }))
    assert.equal(find(done, (n) => n.tag === "strong"), null)
    assert.match(textOf(done), /\*\*测试都过/)
  })

  test("点名折叠的长回复：收起时限高 + 渐隐，下面一颗「展开全文」", () => {
    const tree = parse(proseHtml({ markdown: "一段\n\n两段", fold: { maxHeight: 180 } }))
    const box = find(tree, (n) => n.attrs["data-pi-fold"] === "clipped")
    assert.match(box.attrs.style, /max-height:180px/)
    assert.match(box.attrs.style, /mask-image:linear-gradient/)
    assert.equal(find(tree, (n) => n.tag === "button")?.attrs["aria-label"], "展开全文")
  })
})

describe("PiThinkingText（思考原文）", () => {
  const THOUGHT = [
    "**先看合计**",
    "`total()` 里没有运费，~~可能是缓存~~不是缓存。参考 [购物车文档](https://example.com/cart)。",
    "要改的：",
    "- `cart.ts`",
    "- 测试",
  ].join("\n")
  const blocksOf = (tree) => find(tree, part("thinking-text")).children.filter(isEl)

  test("流式逐字渲染同样不闪不跳（弱化的一套外观、同一条管线）", () => {
    assertSteadyStream(THOUGHT, (text) => thinkingHtml({ text, streaming: true }), blocksOf)
  })

  test("想完了：超过 12 行的代码段收起（限 12 行 + 渐隐，下面「展开代码（N 行）」）；流式中不收", () => {
    const code = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n")
    const text = `看一下：\n\n\`\`\`js\n${code}\n\`\`\``
    const done = parse(thinkingHtml({ text, fold: true }))
    const fold = find(done, part("thinking-code-fold"))
    assert.ok(fold)
    assert.match(find(fold, part("thinking-code")).attrs.style, /max-height:calc\(12lh \+ 12px\)/)
    const toggle = find(fold, (n) => n.tag === "button")
    assert.equal(textOf(toggle), "展开代码（20 行）")
    assert.equal(toggle.attrs["aria-expanded"], "false")
    const live = parse(thinkingHtml({ text, streaming: true }))
    assert.equal(find(live, part("thinking-code-fold")), null)
    assert.equal(find(live, part("thinking-code")).attrs.style, undefined)
    const short = parse(thinkingHtml({ text: "```js\na\nb\n```", fold: true }))
    assert.equal(find(short, part("thinking-code-fold")), null, "短代码段不收")
  })
})

describe("终端 / 改动视图的空态", () => {
  let panes
  before(async () => {
    const terminal = await bundleEntry("src/components/pi/conversation/PiTerminalPane.tsx")
    const changes = await bundleEntry("src/components/pi/conversation/PiChangesPane.tsx")
    files.push(terminal, changes)
    panes = { ...(await import(pathToFileURL(terminal).href)), ...(await import(pathToFileURL(changes).href)) }
  })
  const render = (Comp, props) => parse(renderToStaticMarkup(React.createElement(Comp, props)))

  test("真没跑过命令 / 没改过文件照旧；会话还没载入时写「会话还没载入」，不说没跑过 / 没改过", () => {
    const terminal = (unloaded) => render(panes.PiTerminalPane, { items: [], now: 0, variant: "desktop", unloaded })
    const changes = (unloaded) => render(panes.PiChangesPane, { files: [], total: { added: 0, removed: 0 }, variant: "desktop", unloaded })
    assert.equal(textOf(terminal(false)), "这个会话还没有运行命令pi 运行命令时，输出会在这里展开")
    assert.equal(textOf(terminal(true)), "会话还没载入发第一条消息载入后，这里会列出本会话跑过的命令")
    assert.equal(find(terminal(true), part("terminal-pane")).attrs["data-empty"], "unloaded")
    assert.equal(textOf(changes(false)), "这个会话还没有编辑文件改动视图根据本会话的编辑记录，不是 git 状态")
    assert.equal(textOf(changes(true)), "会话还没载入发第一条消息载入后，这里会列出本会话的编辑记录")
  })
})

describe("第六轮：被停止的写入 / 编辑卡标「已取消」", () => {
  let m
  before(async () => {
    const tools = await bundleEntry("src/components/pi/conversation/tools.ts")
    const card = await bundleEntry("src/components/pi/conversation/PiDiffCard.tsx")
    files.push(tools, card)
    m = { ...(await import(pathToFileURL(tools).href)), ...(await import(pathToFileURL(card).href)) }
  })
  const block = (name, input, extra = {}) => ({ kind: "tool", id: name, name, argsText: "", input, outputText: "", state: "input-streaming", ...extra })
  const write = (extra) => block("write", { path: "USAGE.md", content: "# 用法\n- 第一条" }, extra)
  const edit = (outputText) => block("edit", { path: "cart.js", edits: [{ oldText: "  return sum", newText: "  return sum + shipping" }] }, { state: "output-error", outputText })

  test("回合停下的口径：aborted，或 error + AbortSignal 原文；真出错、长度截断、交给工具都不算", () => {
    assert.equal(m.stoppedEnd("aborted", undefined), true)
    assert.equal(m.stoppedEnd("error", "The operation was aborted."), true)
    assert.equal(m.stoppedEnd("error", '529 {"type":"overloaded_error"}'), false)
    assert.equal(m.stoppedEnd("length", undefined), false)
    assert.equal(m.stoppedEnd("toolUse", undefined), false)
  })

  test("参数写到一半就停了：停下的消息里算已取消，还在写的照旧运行中；执行中被打断（停止样板）算已取消，真失败照旧", () => {
    assert.equal(m.streamToolStatus(write(), true), "aborted")
    assert.equal(m.streamToolStatus(write({ state: "input-available" }), true), "aborted")
    assert.equal(m.streamToolStatus(write(), false), "running")
    assert.equal(m.streamToolStatus(write({ state: "output-available" }), true), "succeeded")
    assert.equal(m.streamToolStatus(edit("Operation aborted"), false), "aborted")
    assert.equal(m.streamToolStatus(edit("Could not find the exact text in cart.js."), false), "failed")
    const grep = block("grep", { pattern: "TODO" })
    assert.deepEqual([m.exploreRowOf(grep, true).running, m.exploreRowOf(grep).running], [false, true], "停下的消息里探查行不再转圈")
  })

  test("停在参数流里的 write（真实会话：pi 存下 arguments {}）：算已取消，出一行「写入文件」；知道文件时写文件名", () => {
    const stoppedWrite = block("write", {}, { state: "input-available" })
    assert.equal(m.streamToolStatus(stoppedWrite, true), "aborted")
    assert.equal(m.editsOf(stoppedWrite), undefined)
    assert.deepEqual(m.diffLineOf(stoppedWrite, false), { verb: "写入文件" })
    assert.deepEqual(m.diffLineOf(block("edit", { path: "src/cart.js" }), true), { verb: "正在编辑", detail: "cart.js" })
  })

  test("edit 参数里成对的替换：edits[] 与旧版顶层 oldText / newText；还没写完的那对不算", () => {
    assert.deepEqual(m.editsOf(edit("")), [{ oldText: "  return sum", newText: "  return sum + shipping" }])
    assert.deepEqual(m.editsOf(block("edit", { path: "a.js", oldText: "a", newText: "b" })), [{ oldText: "a", newText: "b" }])
    assert.equal(m.editsOf(block("edit", { path: "a.js", edits: [{ oldText: "a" }] })), undefined)
    assert.equal(m.editsOf(write()), undefined)
  })

  const card = (props) => parse(renderToStaticMarkup(React.createElement(m.PiDiffCard, { path: "cart.js", variant: "desktop", ...props })))
  const headOf = (tree) => find(tree, part("diff-card")).children.filter(isEl)[0]

  test("卡头行尾：已取消 = 灰字、未生效 = 红字，平常没有", () => {
    const trailing = (props) => headOf(card({ content: "a", ...props })).children.filter(isEl).at(-1)
    assert.equal(textOf(trailing({ cancelled: true })), "已取消")
    assert.match(trailing({ cancelled: true }).attrs.class, /--cw-pi-text-secondary/)
    assert.equal(textOf(trailing({ failed: true })), "未生效")
    assert.match(trailing({ failed: true }).attrs.class, /--cw-pi-error/)
    assert.doesNotMatch(textOf(headOf(card({ content: "a" }))), /已取消|未生效/)
  })

  test("没有 patch 的 edit 卡按 oldText → newText 画出删行 / 增行（计数对得上、不写行号），不再是一行空的「+1」", () => {
    const edits = [{ oldText: "  const sum = 0\n  return sum", newText: "  const sum = 0\n  return sum + shipping" }]
    for (const variant of ["desktop", "phone"]) {
      const tree = card({ edits, failed: true, variant })
      assert.equal(textOf(find(tree, (n) => n.attrs["data-slot"] === "diff-stat")), "+1-1")
      const lines = findAll(tree, (n) => n.attrs["data-slot"] === "diff-line").map((n) => [n.attrs["data-kind"], textOf(find(n, (x) => x.attrs["data-slot"] === "diff-code"))])
      assert.deepEqual(lines, [["context", "  const sum = 0"], ["del", "  return sum"], ["add", "  return sum + shipping"]])
      assert.ok(findAll(tree, (n) => n.attrs["data-slot"] === "diff-lineno").every((n) => textOf(n) === ""), "不知道改在第几行，行号栏留空")
    }
  })
})
