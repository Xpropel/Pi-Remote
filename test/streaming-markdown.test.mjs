// 流式 Markdown 纯函数：稳定前缀切分、GFM 表格识别、未闭合围栏保护。
// Node ≥ 22.18 原生剥离 TS 类型，直接 import .ts 源文件（与 ui-sync.test.mjs 同一套做法）。
import test from "node:test"
import assert from "node:assert/strict"
import {
  isFenceClosed,
  parseStreamingTable,
  parseStreamingTail,
  splitStreamingMarkdown,
} from "../ui/src/components/ui/streaming-markdown-core.ts"

const tableNode = (tail) => parseStreamingTail(tail).find((node) => node.kind === "table")?.table ?? null

test("流式表格：只有表头/分隔线不完整时保持纯文本，分隔线完整后立即成为 table", () => {
  const header = "| 名称 | 状态 |\n"
  assert.equal(parseStreamingTable(header), null)
  assert.equal(parseStreamingTable(header + "| --- |"), null, "分隔线不完整不能猜成表格")

  const empty = parseStreamingTable(header + "| --- | --- |")
  assert.ok(empty, "分隔线一完整就应识别为表格")
  assert.equal(empty.rows.length, 0)
  assert.deepEqual(
    empty.header.map((cell) => cell.text),
    ["名称", "状态"],
  )

  const one = parseStreamingTable(header + "| --- | --- |\n| a | ok |")
  assert.equal(one.rows.length, 1)
  const two = parseStreamingTable(header + "| --- | --- |\n| a | ok |\n| b | wait |")
  assert.equal(two.rows.length, 2, "后续行要逐步长出来")
  assert.deepEqual(
    two.rows.map((row) => row.map((cell) => cell.text)),
    [
      ["a", "ok"],
      ["b", "wait"],
    ],
  )
})

test("CRLF 文本同样能切稳定前缀、识别表格和闭合围栏", () => {
  assert.deepEqual(splitStreamingMarkdown("a\r\n\r\nb"), { prefix: "a\r\n\r\n", tail: "b" })
  assert.equal(parseStreamingTable("| a | b |\r\n| --- | --- |\r\n| 1 | 2 |")?.rows.length, 1)
  assert.equal(isFenceClosed("```ts\r\nconst x = 1\r\n```\r\n"), true)
})

test("非 GFM 竖线文本 / setext 标题 / 缺分隔线的行都不会误判成表格", () => {
  assert.equal(parseStreamingTable("foo | bar\nbaz | qux"), null)
  assert.equal(parseStreamingTable("标题\n---"), null, "两行文本加 --- 是 setext 标题，不是单列表格")
  assert.equal(parseStreamingTable("| a | b |\n| 1 | 2 |"), null)
  assert.equal(parseStreamingTable("说明里写 a | b，但没有表格结构"), null)
})

test("表格单元格支持行内格式和转义竖线，且不会把 \\| 拆成两列", () => {
  const table = parseStreamingTable("| **名字** | 备注 | 链接 |\n| --- | --- | --- |\n| x \\| y | `code` | [docs](https://example.com) |")
  assert.ok(table)
  assert.equal(table.rows.length, 1)
  assert.deepEqual(
    table.rows[0].map((cell) => cell.text),
    ["x | y", "`code`", "[docs](https://example.com)"],
  )
  assert.deepEqual(
    table.header.map((cell) => cell.text),
    ["**名字**", "备注", "链接"],
  )
})

test("未闭合围栏保留为纯文本节点，闭合后才交给正常代码卡；更长的围栏不会被短闭合线关掉", () => {
  const open = "```ts\nconst x = 1\n\nconst y = 2"
  assert.equal(isFenceClosed(open), false)
  const nodes = parseStreamingTail(open)
  assert.deepEqual(nodes.map((node) => node.kind), ["open-code"])
  assert.equal(nodes[0].text, "const x = 1\n\nconst y = 2")

  const closed = "```ts\nconst x = 1\n```"
  assert.equal(isFenceClosed(closed), true)
  assert.deepEqual(parseStreamingTail(closed).map((node) => node.kind), ["code"])

  assert.equal(isFenceClosed("````\ncode\n```"), false, "短于开启线的围栏不能闭合")
  assert.equal(isFenceClosed("~~~\ncode\n~~~"), true)
  assert.equal(isFenceClosed("```"), false, "只有开启线不能算闭合")
})

test("稳定前缀：普通段落按空行切；单个行尾换行不是空行；表格不会在行之间被切开", () => {
  assert.deepEqual(splitStreamingMarkdown("第一段\n\n第二段"), { prefix: "第一段\n\n", tail: "第二段" })
  assert.deepEqual(splitStreamingMarkdown("第一段\n"), { prefix: "", tail: "第一段\n" }, "行尾单个换行不是空行")
  assert.deepEqual(splitStreamingMarkdown("第一段\n\n"), { prefix: "第一段\n\n", tail: "" })

  const streamingTable = "前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n"
  const splitTable = splitStreamingMarkdown(streamingTable)
  assert.equal(splitTable.prefix, "前文\n\n")
  assert.match(splitTable.tail, /^\| a \| b \|/)
  assert.ok(tableNode(splitTable.tail), "表格整个留在活动尾部")

  const finishedTable = "前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n后文"
  const splitFinished = splitStreamingMarkdown(finishedTable)
  assert.equal(splitFinished.prefix, "前文\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n")
  assert.equal(splitFinished.tail, "后文", "表格结束后可以把整张表移到稳定前缀")
})

test("稳定前缀：围栏内空行不切；列表/引用/缩进代码内部的空行也不切", () => {
  const fence = "前言\n\n```ts\nconst a = 1\n\nconst b = 2"
  const splitFence = splitStreamingMarkdown(fence)
  assert.equal(splitFence.prefix, "前言\n\n")
  assert.equal(splitFence.tail, "```ts\nconst a = 1\n\nconst b = 2")

  const closedFence = "前言\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n后文"
  assert.equal(splitStreamingMarkdown(closedFence).prefix, "前言\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n")

  assert.deepEqual(splitStreamingMarkdown("- 一\n\n- 二"), { prefix: "", tail: "- 一\n\n- 二" })
  assert.deepEqual(splitStreamingMarkdown("> 一\n\n> 二"), { prefix: "", tail: "> 一\n\n> 二" })
  assert.deepEqual(splitStreamingMarkdown("    a\n\n    b"), { prefix: "", tail: "    a\n\n    b" })

  const listThenParagraph = splitStreamingMarkdown("- 一\n\n普通段落")
  assert.equal(listThenParagraph.prefix, "- 一\n\n", "列表结束后可以切")

  const nestedFence = splitStreamingMarkdown("前言\n\n- 项\n\n  ```ts\n  a\n\n  b\n  ```")
  assert.equal(nestedFence.prefix, "前言\n\n", "列表项里 2 空格缩进的围栏不能在空行处切开")
  assert.match(nestedFence.tail, /^- 项/)
})

test("100 行表格 + 10k 字前置文本：每个 delta 只切/解析活动尾部，前缀保持稳定且耗时可接受", (t) => {
  const prefix = Array.from(
    { length: 140 },
    (_, index) =>
      `第 ${index + 1} 段：这是一段用于压测的普通回答文本，包含中文和 English words，用来把前面的 Markdown 稳定前缀拉长到一万字符左右。`,
  ).join("\n\n")
  assert.ok(prefix.length > 10_000, `前置文本只有 ${prefix.length} 字`)

  let text = `${prefix}\n\n| 行号 | 模块 | 状态 | 备注 |\n| --- | --- | --- | --- |\n`
  const rows = Array.from(
    { length: 100 },
    (_, index) => `| ${index + 1} | module-${index + 1} | 通过 | 这是第 ${index + 1} 行的说明文本 |`,
  )
  let stablePrefix = null
  const times = []
  for (let index = 0; index < rows.length; index += 1) {
    text += rows[index] + "\n"
    const started = performance.now()
    const split = splitStreamingMarkdown(text)
    const nodes = parseStreamingTail(split.tail)
    times.push(performance.now() - started)

    if (stablePrefix === null) stablePrefix = split.prefix
    else assert.equal(split.prefix, stablePrefix, `第 ${index + 1} 行时前缀变了，memoize 会失效`)
    const table = nodes.find((node) => node.kind === "table")
    assert.ok(table, `第 ${index + 1} 行时表格节点丢失`)
    assert.equal(table.table.rows.length, index + 1)
  }

  times.sort((left, right) => left - right)
  const average = times.reduce((sum, value) => sum + value, 0) / times.length
  const p95 = times[Math.floor(times.length * 0.95)]
  const max = times[times.length - 1]
  t.diagnostic(
    `split+parse 每 delta：avg=${average.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms（前缀 ${stablePrefix.length} 字）`,
  )
  assert.ok(average < 5, `每 delta 平均 ${average.toFixed(2)}ms，解析层已经明显卡顿`)
  assert.ok(p95 < 20, `每 delta p95 ${p95.toFixed(2)}ms 过高`)
})
