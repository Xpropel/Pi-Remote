import { marked } from "marked"

/**
 * 流式正文的“稳定前缀”再切成若干可独立 memo 的块（UI·perf 中-5）。
 *
 * 背景：`streaming-markdown-core.splitStreamingMarkdown` 给出一段稳定前缀（到最后一个不在围栏里的空行），
 * 流式推进时这段前缀每跨过一个空行边界就会变长。整段前缀交给一个 `MarkdownBlock` 的话，每次变长
 * 都要把前面已经稳定的段落重新走一遍 react-markdown（remark parse → hast → React 元素），越到尾越贵。
 *
 * 切块口径 = marked 的**顶层 token** 边界：列表、引用、围栏代码、表格在 token 里本来就是整块，
 * 所以不会把列表切成两半（编号从 1 重来）、也不会切进围栏。前缀增长只会**追加新 token**，
 * 已有 token 的 raw 一字不变 → 每块内容的字符串引用稳定 → `MarkdownBlock` 的 memo 命中，只解析新增段。
 *
 * 纯函数（不碰 React），node --test 直接加载。
 */
export function stableChunksOf(prefix: string): string[] {
  if (!prefix) return []
  const chunks: string[] = []
  for (const token of marked.lexer(prefix)) {
    // space token 只是块与块之间的空行：块内容离开它照样渲染，丢掉可以少一层组件
    if (token.type === "space") continue
    if (token.raw) chunks.push(token.raw)
  }
  return chunks
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
/** 行内标记不跨这些行：列表项、标题、表格行各自另起一块（引用的续行仍是同一段，不算） */
const BLOCK_START = /^ {0,3}(?:[-+*][ \t]|\d{1,9}[.)][ \t]|#{1,6}(?:[ \t]|$)|\|)/

/**
 * 最后一段的起点；结尾停在没闭合的围栏里、或最后一段是缩进代码时返回 -1（那里的反引号是代码，不补）。
 */
function lastParagraphStart(text: string): number {
  let fence: { char: string; length: number } | null = null
  let start = 0
  let afterBlank = true
  let offset = 0
  const lines = text.split("\n")
  // 结尾的单个换行只是最后一行收了尾，不是空行
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    const lineStart = offset
    offset += raw.length + 1
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null
        start = offset
        afterBlank = true
      }
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      fence = { char: open[1][0], length: open[1].length }
      continue
    }
    if (!line.trim()) {
      start = offset
      afterBlank = true
      continue
    }
    if (afterBlank || BLOCK_START.test(line)) {
      if (afterBlank && /^(?: {4}|\t)/.test(line)) return -1
      start = lineStart
    }
    afterBlank = false
  }
  return fence ? -1 : Math.min(start, text.length)
}

/** 最后一段里开着的行内标记（由外到内）。code / url 里面的字都按字面，不再认别的标记 */
type OpenMark =
  | { kind: "code"; at: number; len: number }
  | { kind: "strong" | "strike"; at: number; len: number }
  /** [ 之后、] 之前：链接文字写到一半 */
  | { kind: "bracket"; at: number }
  /** 正好停在 ]：( 还没到 */
  | { kind: "label"; at: number }
  /** ]( 之后、) 之前：网址写到一半；quote = 写到一半的标题的引号 */
  | { kind: "url"; depth: number; quote: string }

/** 列表项只写到任务清单的 [、[ ]、[x]（勾选框，不是链接），后面还没有字 */
const TASK_ONLY = /^( {0,3}(?:[-+*]|\d{1,9}[.)]))[ \t]+\[[ xX]?\]?$/

/** 开了还没有字的标记去掉（连同它前面的空白）；有字的补上闭合 */
function closeMark(body: string, mark: OpenMark): string {
  const drop = (at: number) => body.slice(0, at).replace(/\s+$/, "")
  switch (mark.kind) {
    case "url":
      return body + mark.quote + ")".repeat(mark.depth)
    case "label":
      return body + "()"
    case "bracket":
      return body.length > mark.at + 1 ? body + "]()" : drop(mark.at)
    case "code":
      return body.length > mark.at + mark.len ? body + "`".repeat(mark.len) : drop(mark.at)
    default:
      return body.length > mark.at + mark.len ? body + (mark.kind === "strong" ? "*" : "~").repeat(mark.len) : drop(mark.at)
  }
}

/**
 * 被截断的 Markdown 结尾（流式中的活动尾部；停止生成 / 出错 / 达到长度上限的回复）：最后一段里没闭合的行内标记补上闭合，
 * 不露出孤立的标记字符；后面的字到了、闭合了，就按原文。标记开了、后面还没有字的，去掉标记。
 *  - 行内代码 `、加粗 **、删除线 ~~：补同样多的闭合字符；
 *  - 链接：网址写到一半（[文字](http…）补 )（标题写到一半先补引号）；链接文字写到一半（[文字）或正好停在 ]，按链接补成 [文字]()，
 *    文字先按链接画、不露出 [ ]（网址不完整时 MdLink 只画字）；列表项开头只写到 [ ] / [x] 的是任务清单，先不画、不当链接；
 *  - 结尾停在一串还看不出开还是关的标记字符上（** 的第一个 *、`` 的第一个 `、行尾的 \）：先不画这串，字到了再说。
 * 只看最后一段（行内标记不跨段）；结尾停在没闭合的围栏里交给围栏处理，原样返回。
 */
export function closeOpenInline(text: string): string {
  const start = lastParagraphStart(text)
  if (start < 0 || start >= text.length) return text
  const seg = text.slice(start)
  const trailing = /\s*$/.exec(seg)?.[0] ?? ""
  const body = seg.slice(0, seg.length - trailing.length).replace(/(?:[*~`]+|\\)$/, "")
  // 先不画勾选框的标记（不然先露出 "[x]" 再变成勾选框），只留列表标记（剩下的 "-" 由 holdBackMarkerLine 先不画）
  const task = TASK_ONLY.exec(body)
  if (task) return text.slice(0, start) + task[1] + trailing
  // 什么都没截掉：结尾的 ] 后面确实还没有字，可能是链接文字收口、等 (
  const atEnd = body.length === seg.length
  const stack: OpenMark[] = []
  const lastIndexOf = (kind: OpenMark["kind"]) => stack.findLastIndex((m) => m.kind === kind)
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    const top = stack[stack.length - 1]
    if (top?.kind === "code") {
      if (ch === "`") {
        let j = i
        while (body[j] === "`") j++
        if (j - i === top.len) stack.pop()
        i = j
      } else i++
      continue
    }
    if (top?.kind === "url") {
      if (ch === "\\") i++
      else if (top.quote) {
        if (ch === top.quote) top.quote = ""
      } else if ((ch === '"' || ch === "'") && /\s/.test(body[i - 1])) top.quote = ch
      else if (ch === "(") top.depth++
      else if (ch === ")" && --top.depth === 0) stack.pop()
      i++
      continue
    }
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "`") {
      let j = i
      while (body[j] === "`") j++
      stack.push({ kind: "code", at: i, len: j - i })
      i = j
      continue
    }
    if (ch === "[") {
      stack.push({ kind: "bracket", at: i })
      i++
      continue
    }
    if (ch === "]") {
      const b = lastIndexOf("bracket")
      if (b >= 0) {
        const at = (stack[b] as { at: number }).at
        // 链接文字里开着没配上的强调不跨出去（CommonMark），一起收掉
        stack.length = b
        if (body[i + 1] === "(") {
          stack.push({ kind: "url", depth: 1, quote: "" })
          i += 2
          continue
        }
        if (i === body.length - 1 && atEnd) stack.push({ kind: "label", at })
      }
      i++
      continue
    }
    if (ch === "*" || ch === "~") {
      let j = i
      while (body[j] === ch) j++
      const len = j - i
      const kind = ch === "*" ? "strong" : "strike"
      if (ch === "*" ? len >= 2 : len === 2) {
        const k = lastIndexOf(kind)
        // CommonMark 的 left / right-flanking 简化：开 = 后面紧跟非空白（或正好停在结尾），关 = 前面紧跟非空白；关的时候它里面没配上的一起收
        if (k >= 0) {
          if (!/\s/.test(body[i - 1])) stack.length = k
        } else if (j >= body.length || !/\s/.test(body[j])) stack.push({ kind, at: i, len: Math.min(len, 3) })
      }
      i = j
      continue
    }
    i++
  }
  if (!stack.length && body.length + trailing.length === seg.length) return text
  // 闭合字符紧贴着字（前面是空白的 ** 不算闭合）
  let out = body.replace(/\s+$/, "")
  for (let k = stack.length - 1; k >= 0; k--) out = closeMark(out, stack[k])
  return text.slice(0, start) + out + trailing
}

const TABLE_LINE = /^ {0,3}\|/
const DELIM_CELL = /^:?-+:?$/

/** 表格行切成格：去掉首尾的 |，\| 是格里的字 */
function tableCells(line: string): string[] {
  let s = line.trim()
  if (s.startsWith("|")) s = s.slice(1)
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim())
}

/** 完整的分隔行：格数随表头，已经写了的对齐（:--- / ---: / :---:）照留 */
function delimiterRow(count: number, typed: readonly string[]): string {
  const cells = Array.from({ length: count }, (_, k) => {
    const c = typed[k] ?? ""
    return DELIM_CELL.test(c) ? c : c.startsWith(":") ? ":---" : "---"
  })
  return `| ${cells.join(" | ")} |`
}

/** 这几行读完时是否停在没闭合的围栏里 */
function endsInFence(lines: readonly string[]): boolean {
  let fence: { char: string; length: number } | null = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "")
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null
      continue
    }
    const open = FENCE_OPEN.exec(line)
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) fence = { char: open[1][0], length: open[1].length }
  }
  return fence != null
}

/**
 * 写到一半的表格（结尾那一块是表格行）补成能画成表格的样子：表头一出来就按表格画，不先露出一行「| a | b |」再跳成表格。
 *  - 分隔行还没到 / 只到一半：补成完整的分隔行（格数随表头，已写的对齐冒号照留）；第二行不像分隔行就不是表格，不动；
 *  - 最后一行还没有字（只敲了 |）：先不画这一行（空行比有字的行矮，字到了再长出来）。
 * 表头前得是空行、标题行或开头（段落续行里的 | 不动）；围栏里的不算。
 */
export function closeOpenTable(text: string): string {
  const end = text.replace(/\s+$/, "").length
  const lines = text.slice(0, end).split("\n")
  let first = lines.length
  while (first > 0 && TABLE_LINE.test(lines[first - 1])) first--
  if (first === lines.length) return text
  const before = first > 0 ? lines[first - 1] : ""
  if (before.trim() && !/^ {0,3}#{1,6}(?:[ \t]|$)/.test(before)) return text
  if (endsInFence(lines.slice(0, first))) return text
  const rows = lines.slice(first)
  const header = tableCells(rows[0])
  const filled = (row: string) => tableCells(row).some(Boolean)
  if (rows.length > 2 && !filled(rows[rows.length - 1])) rows.pop()
  if (rows.length === 1) {
    if (!filled(rows[0])) return lines.slice(0, first).join("\n") + (first > 0 ? "\n" : "")
    rows.push(delimiterRow(header.length, []))
  } else {
    const typed = tableCells(rows[1])
    if (typed.length !== header.length || !typed.every((c) => DELIM_CELL.test(c))) {
      if (!/^[\s|:-]*$/.test(rows[1]) || typed.length > header.length) return text
      rows[1] = delimiterRow(header.length, typed)
    }
  }
  const out = [...lines.slice(0, first), ...rows].join("\n")
  return out === text.slice(0, end) ? text : out + text.slice(end)
}

/** 结尾那行只有块标记、还没有字（"-"、"1."、"#"、">"、"|"、"---"…） */
const MARKER_ONLY_LINE = /^ {0,3}(?:[-+*=_#>|]+|\d{1,9}[.)]?)[ \t]*$/

/**
 * 结尾那行只敲了块标记：先不画这一行。不然 "-" 会先把上一行变成 setext 标题、"1." 先当段落里的字、"#" 先画成空标题，
 * 等后面的字到了再跳成列表 / 标题。只看还没收尾的最后一行（行尾有换行的照画）。
 */
function holdBackMarkerLine(text: string): string {
  const nl = text.lastIndexOf("\n")
  const last = text.slice(nl + 1)
  return last && MARKER_ONLY_LINE.test(last) ? text.slice(0, nl + 1) : text
}

/**
 * 被截断的 Markdown 结尾补成稳定的样子（流式中的活动尾部；停在半路的回复 / 思考）：
 * 最后一段的行内标记补闭合（closeOpenInline）→ 只剩块标记的最后一行先不画（补闭合时去掉 [ ] 也可能剩下一个 "-"）
 * → 写到一半的表格补分隔行（closeOpenTable）。
 */
export function closeOpenMarkdown(text: string): string {
  return closeOpenTable(holdBackMarkerLine(closeOpenInline(text)))
}
