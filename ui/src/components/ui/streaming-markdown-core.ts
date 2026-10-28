import { marked, type Tokens } from "marked"

/**
 * 流式 Markdown 的纯函数部分：只做“切稳定前缀 / 解析尾部”，不碰 React。
 *
 * 稳定前缀 = 最后一个**不在代码围栏内**的空行之前的内容。GFM 表格的行与行之间
 * 不能有空行（空行会结束表格），所以按空行切分天然不会切进表格；围栏代码里的
 * 空行则必须跳过，否则会把一个代码块劈成两半。
 */

export type StreamingSplit = {
  prefix: string
  tail: string
}

export type StreamingTable = {
  header: Tokens.TableCell[]
  rows: Tokens.TableCell[][]
  align: Tokens.Table["align"]
}

export type StreamingTailNode =
  | { kind: "markdown"; raw: string }
  | { kind: "table"; table: StreamingTable }
  /** 已闭合代码块：交给正常 Markdown；caret 不能塞进代码文本里。 */
  | { kind: "code"; raw: string }
  /** 已开围栏、还没等到闭合线：先按纯文本显示，闭合后再交给正常 Markdown。 */
  | { kind: "open-code"; raw: string; text: string; lang?: string }
  | { kind: "space" }

type Fence = { char: "`" | "~"; length: number }

function indentOf(line: string) {
  let width = 0
  for (const char of line) {
    if (char === " ") width += 1
    else if (char === "\t") width += 4 - (width % 4)
    else break
  }
  return width
}

function isBlank(line: string) {
  return /^\s*$/.test(line)
}

function isListLine(line: string) {
  return /^\s*(?:[-+*]|\d{1,9}[.)])(?:\s+|$)/.test(line)
}

function isQuoteLine(line: string) {
  return /^\s{0,3}>/.test(line)
}

/** CommonMark 的围栏可以缩进 0–3 格；4 格是缩进代码，不是围栏。 */
function openFence(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!match) return null
  const marker = match[1]
  // 反引号围栏的 info string 里不能再出现反引号。
  if (marker[0] === "`" && match[2].includes("`")) return null
  return { char: marker[0] as Fence["char"], length: marker.length }
}

function closesFence(line: string, fence: Fence) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
  return !!match && match[1][0] === fence.char && match[1].length >= fence.length
}

function previousNonBlank(lines: string[], index: number) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!isBlank(lines[cursor])) return lines[cursor]
  }
  return null
}

function nextNonBlank(lines: string[], index: number) {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (!isBlank(lines[cursor])) return lines[cursor]
  }
  return null
}

/**
 * 这个空行能不能当前缀边界。
 * 列表项之间、引用块之间、缩进代码内部的空行都要躲开：宁可少切一块，
 * 也不要让流式期间出现“编号从 1 重新开始”或代码块被拆开。
 */
function canSplitAtBlank(lines: string[], index: number) {
  const previous = previousNonBlank(lines, index)
  if (previous === null) return false
  const next = nextNonBlank(lines, index)
  if (next === null) return true

  const previousIndent = indentOf(previous)
  const nextIndent = indentOf(next)
  // 两边都缩进：大概率是列表项里的围栏代码 / 缩进代码。宁可把这一块留在活动尾部，
  // 也不要在空行处切开一个 2 空格缩进的嵌套 fence。
  if (previousIndent >= 2 && nextIndent >= 2) return false
  if (nextIndent >= 4) return false
  if (previousIndent >= 4) return false
  if (isQuoteLine(previous) && isQuoteLine(next)) return false
  if (isListLine(previous) && (isListLine(next) || nextIndent >= 2)) return false
  return true
}

/**
 * 把已经流出来的文本切成“稳定前缀 + 活动尾部”。
 * 只扫描行和围栏状态，不对全文跑 marked.lexer；前缀字符串不变时调用方可以整段 memoize。
 */
export function splitStreamingMarkdown(text: string): StreamingSplit {
  if (!text) return { prefix: "", tail: "" }
  const lines = text.split("\n")
  const offsets: number[] = new Array(lines.length)
  let offset = 0
  for (let index = 0; index < lines.length; index += 1) {
    offsets[index] = offset
    offset += lines[index].length + 1
  }

  let fence: Fence | null = null
  let splitAt = -1
  // "a\n" 的 split("\n") 末尾会多出一个空串，它只是行尾换行，不是空行。
  // 不跳过它的话，每个以换行结尾的 delta 都会把整段内容推进前缀，前缀会逐个 delta 重新 lexer。
  const syntheticLastLine = text.endsWith("\n") ? lines.length - 1 : -1
  for (let index = 0; index < lines.length; index += 1) {
    if (index === syntheticLastLine) break
    // Windows 文本可能是 CRLF：判定按去掉 \r 的内容，偏移仍按原始长度算。
    const line = lines[index].replace(/\r$/, "")
    if (fence) {
      if (closesFence(line, fence)) fence = null
    } else {
      const opening = openFence(line)
      if (opening) {
        fence = opening
      } else if (isBlank(line) && canSplitAtBlank(lines, index)) {
        // 前缀包含这个空行的换行：下一段从空行之后开始，避免尾部内容粘在空行上。
        splitAt = offsets[index] + lines[index].length + (index < lines.length - 1 ? 1 : 0)
      }
    }
  }

  if (splitAt <= 0) return { prefix: "", tail: text }
  return { prefix: text.slice(0, splitAt), tail: text.slice(splitAt) }
}

/** 已闭合的围栏代码块返回 true；缩进代码块也算“已闭合”。 */
export function isFenceClosed(raw: string): boolean {
  const lines = raw.split("\n").map((line) => line.replace(/\r$/, ""))
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return true
  const opening = openFence(lines[0])
  if (!opening) return true
  if (lines.length < 2) return false
  return closesFence(lines[lines.length - 1], opening)
}

/**
 * 只解析活动尾部（通常就是最后一段），表格在分隔线完整后由 marked 识别为 table。
 * 未闭合围栏保留为 open-code，交给调用方按纯文本渲染，避免半截代码块闪错结构。
 */
export function parseStreamingTail(tail: string): StreamingTailNode[] {
  if (!tail) return []
  return marked.lexer(tail).flatMap((token): StreamingTailNode[] => {
    if (token.type === "space") return [{ kind: "space" }]
    if (token.type === "table") {
      return [{ kind: "table", table: { header: token.header, rows: token.rows, align: token.align } }]
    }
    if (token.type === "code") {
      if (token.raw && !isFenceClosed(token.raw)) {
        return [{ kind: "open-code", raw: token.raw, text: token.text, lang: token.lang }]
      }
      return [{ kind: "code", raw: token.raw }]
    }
    return [{ kind: "markdown", raw: token.raw }]
  })
}

/** 给测试和调试用：在不渲染 React 的情况下确认某段文本会不会被当成 GFM 表格。 */
export function parseStreamingTable(tail: string): StreamingTable | null {
  const node = parseStreamingTail(tail).find((item) => item.kind === "table")
  return node && node.kind === "table" ? node.table : null
}
