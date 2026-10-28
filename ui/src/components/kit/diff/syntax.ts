/**
 * SyntaxHighlight 的分词器：小型手写扫描器（plan §1 决策 7：不用 shiki）。
 * 支持 ts / tsx / js / jsx / json / html；整段扫描后按 "\n" 切成行，块注释、模板字符串、JSX 可跨行。
 *
 * 配色（specs/ch3 §0.4；context / add / del 行字色相同，只有底色不同）：
 * - keyword：import from const type as readonly undefined true …
 * - string：字符串；JSON 的键与值；HTML 属性值
 * - ident：标识符、类型名；TS 的标点与数字也用它
 * - func：函数 / 方法名（标识符后紧跟 "("）
 * - tag / attr：HTML 标签名与尖括号 / HTML 属性名
 * - comment：注释（斜体）
 * - text：HTML 文本、JSON 的冒号逗号（--cw-text）
 * - jsx-attr / jsx-text：JSX 属性名 / JSX 文本（specs/ch5 §3.3 I：属性名同标识符色，文本橄榄棕，估计）
 * tokens.css 还没有的色名用 var(名, 已有 token) 兜底：--cw-syntax-func、--cw-syntax-comment、--cw-syntax-punct、
 * --cw-syntax-number、--cw-syntax-jsx-attr、--cw-syntax-jsx-text（建议值见 kit-parallel/diff.md）。
 */

export type SyntaxLang = "ts" | "tsx" | "js" | "jsx" | "json" | "html" | "text"

export type SyntaxKind =
  | "plain"
  | "text"
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "func"
  | "ident"
  | "punct"
  | "tag"
  | "attr"
  | "jsx-attr"
  | "jsx-text"

export interface SyntaxToken {
  kind: SyntaxKind
  text: string
}

export type SyntaxLine = SyntaxToken[]

/** 每类记号的字色（CSS 值，全部引用 --cw-* 变量）；plain = 继承 */
export const SYNTAX_COLOR: Record<SyntaxKind, string | undefined> = {
  plain: undefined,
  text: "var(--cw-text)",
  keyword: "var(--cw-syntax-keyword)",
  string: "var(--cw-syntax-string)",
  number: "var(--cw-syntax-number, var(--cw-syntax-ident))",
  comment: "var(--cw-syntax-comment, var(--cw-text-2))",
  func: "var(--cw-syntax-func, var(--cw-syntax-keyword))",
  ident: "var(--cw-syntax-ident)",
  punct: "var(--cw-syntax-punct, var(--cw-syntax-ident))",
  tag: "var(--cw-syntax-tag)",
  attr: "var(--cw-syntax-attr)",
  "jsx-attr": "var(--cw-syntax-jsx-attr, var(--cw-syntax-ident))",
  "jsx-text": "var(--cw-syntax-jsx-text, var(--cw-text))",
}

const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "declare",
  "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from",
  "function", "if", "implements", "import", "in", "instanceof", "interface", "keyof", "let", "module",
  "namespace", "new", "null", "of", "override", "private", "protected", "public", "readonly", "return",
  "satisfies", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
  "var", "void", "while", "yield",
])

/** 字面量关键字：后面跟 ":" 时仍是关键字（三元 `? true : false`） */
const LITERAL_KEYWORDS = new Set(["true", "false", "null", "undefined", "this", "default", "case"])

/** 上下文关键字：后面跟 = , ) ; ] } . 时当普通标识符（`const type = …`） */
const CONTEXTUAL_KEYWORDS = new Set([
  "abstract", "as", "async", "declare", "from", "keyof", "module", "namespace", "of", "override",
  "readonly", "satisfies", "type",
])

/** 前一个记号是这些关键字时，"<" 开始 JSX */
const JSX_AFTER_KEYWORDS = new Set(["return", "default", "yield", "await", "case", "else", "do", "in", "of"])

const ID_START = /[A-Za-z_$]/
const ID_PART = /[\w$]/
const SPACE = /[ \t\r\n]/
const OPERATOR = /[=+\-*/%&|^!~<>?:.@#]/
const NUMBER = /^(?:0[xXbBoO][\da-fA-F_]+n?|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/

// JSDoc 续行（以 "*" 开头的行，或块注释的收尾行）：diff 段落常从块注释中间开始，块注释的起点在折叠区里（#14 第 557 行）
const COMMENT_CONTINUATION = /^\s*\*(?:\s|\/|$)/

export interface TokenizeOptions {
  /** 从块注释中间开始扫描；不填时按首行是否像 JSDoc 续行自动判断（只对 ts/tsx/js/jsx） */
  startInComment?: boolean
}

/** 把多行代码分词；返回与 lines 等长的行数组 */
export function tokenizeLines(lines: readonly string[], lang: SyntaxLang, options: TokenizeOptions = {}): SyntaxLine[] {
  if (lines.length === 0) return []
  const src = lines.join("\n")
  let tokens: SyntaxToken[]
  switch (lang) {
    case "ts":
    case "js":
    case "tsx":
    case "jsx": {
      const first = lines.find((l) => l.trim() !== "") ?? ""
      const startInComment = options.startInComment ?? COMMENT_CONTINUATION.test(first)
      tokens = scanScript(src, lang === "tsx" || lang === "jsx", startInComment)
      break
    }
    case "json":
      tokens = scanJson(src)
      break
    case "html":
      tokens = scanHtml(src)
      break
    default:
      tokens = [{ kind: "plain", text: src }]
  }
  const out = splitLines(tokens)
  while (out.length < lines.length) out.push([])
  return out.slice(0, lines.length)
}

/** 一段代码（可含换行）分词 */
export function tokenize(code: string, lang: SyntaxLang, options?: TokenizeOptions): SyntaxLine[] {
  return tokenizeLines(code.split("\n"), lang, options)
}

function splitLines(tokens: SyntaxToken[]): SyntaxLine[] {
  const lines: SyntaxLine[] = [[]]
  for (const t of tokens) {
    const parts = t.text.split("\n")
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([])
      if (!part) return
      const line = lines[lines.length - 1]
      const last = line[line.length - 1]
      if (last && last.kind === t.kind) last.text += part
      else line.push({ kind: t.kind, text: part })
    })
  }
  return lines
}

/** ts / tsx / js / jsx */
function scanScript(src: string, jsx: boolean, startInComment: boolean): SyntaxToken[] {
  const out: SyntaxToken[] = []
  const n = src.length
  let i = 0
  /** 最近一个有意义的记号（不含空白与注释），用来判断 "<" 是否开始 JSX、"." 之后是否成员 */
  let prev: SyntaxToken | undefined

  const push = (kind: SyntaxKind, text: string) => {
    if (!text) return
    const t = { kind, text }
    out.push(t)
    if (kind !== "plain" && kind !== "comment") prev = t
  }

  const readSpace = () => {
    let j = i
    while (j < n && SPACE.test(src[j])) j++
    push("plain", src.slice(i, j))
    i = j
  }

  const readString = (quote: string) => {
    let j = i + 1
    while (j < n && src[j] !== quote && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1
    if (j < n && src[j] === quote) j++
    push("string", src.slice(i, Math.min(j, n)))
    i = Math.min(j, n)
  }

  const readTemplate = () => {
    let j = i + 1
    while (j < n && src[j] !== "`") j += src[j] === "\\" ? 2 : 1
    if (j < n) j++
    push("string", src.slice(i, Math.min(j, n)))
    i = Math.min(j, n)
  }

  const readBlockComment = () => {
    const end = src.indexOf("*/", i + 2)
    const stop = end < 0 ? n : end + 2
    push("comment", src.slice(i, stop))
    i = stop
  }

  const nextNonSpace = (from: number) => {
    let k = from
    while (k < n && (src[k] === " " || src[k] === "\t")) k++
    return k
  }

  const jsxAllowed = () => {
    if (!jsx) return false
    if (!prev) return true
    if (prev.kind === "tag") return true
    if (prev.kind === "keyword") return JSX_AFTER_KEYWORDS.has(prev.text)
    if (prev.kind === "punct") return "([{,=:?!&|>;}".includes(prev.text[prev.text.length - 1])
    return false
  }

  const readWord = () => {
    let j = i + 1
    while (j < n && ID_PART.test(src[j])) j++
    const word = src.slice(i, j)
    const k = nextNonSpace(j)
    const after = src[k] ?? ""
    const isKey = (after === ":" && src[k + 1] !== ":") || (after === "?" && src[k + 1] === ":")
    const isMember = prev?.kind === "punct" && prev.text.endsWith(".") && !prev.text.endsWith("...")
    let kind: SyntaxKind
    if (KEYWORDS.has(word) && !isMember && !(isKey && !LITERAL_KEYWORDS.has(word))) {
      const usedAsName =
        CONTEXTUAL_KEYWORDS.has(word) && /[=,);\]}.]/.test(after) && !(after === "=" && src[k + 1] === ">")
      kind = usedAsName ? "ident" : "keyword"
    } else if (src[j] === "(") {
      kind = "func"
    } else {
      kind = "ident"
    }
    push(kind, word)
    i = j
  }

  /** 扫普通代码；stopAtBrace = 在 JSX 的 {…} 里，遇到未配对的 "}" 就返回（不吃掉它） */
  const scanCode = (stopAtBrace: boolean) => {
    let depth = 0
    while (i < n) {
      const c = src[i]
      const d = src[i + 1] ?? ""
      if (SPACE.test(c)) readSpace()
      else if (c === "/" && d === "/") {
        let j = i
        while (j < n && src[j] !== "\n") j++
        push("comment", src.slice(i, j))
        i = j
      } else if (c === "/" && d === "*") readBlockComment()
      else if (c === '"' || c === "'") readString(c)
      else if (c === "`") readTemplate()
      else if (/\d/.test(c) || (c === "." && /\d/.test(d))) {
        const m = NUMBER.exec(src.slice(i))
        const text = m ? m[0] : c
        push("number", text)
        i += text.length
      } else if (ID_START.test(c)) readWord()
      else if (c === "<" && (ID_START.test(d) || d === ">") && jsxAllowed()) scanJsxElement()
      else if (c === "{") {
        depth++
        push("punct", c)
        i++
      } else if (c === "}") {
        if (stopAtBrace && depth === 0) return
        depth--
        push("punct", c)
        i++
      } else if (OPERATOR.test(c)) {
        let j = i + 1
        while (j < n && OPERATOR.test(src[j]) && !(src[j] === "/" && (src[j + 1] === "/" || src[j + 1] === "*"))) j++
        push("punct", src.slice(i, j))
        i = j
      } else {
        push("punct", c)
        i++
      }
    }
  }

  /** JSX 属性里的 {…} 或子节点里的 {…} */
  const scanBraceExpr = () => {
    push("punct", "{")
    i++
    scanCode(true)
    if (src[i] === "}") {
      push("punct", "}")
      i++
    }
  }

  /** 从 "<" 开始扫一个 JSX 元素，到它结束（自闭合或对应的闭合标签） */
  const scanJsxElement = () => {
    if (src[i + 1] === ">") {
      push("tag", "<>")
      i += 2
      scanJsxChildren()
      return
    }
    push("tag", "<")
    i++
    let j = i
    while (j < n && /[\w$.:-]/.test(src[j])) j++
    push("tag", src.slice(i, j))
    i = j
    while (i < n) {
      const c = src[i]
      if (SPACE.test(c)) readSpace()
      else if (c === "/" && src[i + 1] === ">") {
        push("tag", "/>")
        i += 2
        return
      } else if (c === ">") {
        push("tag", ">")
        i++
        scanJsxChildren()
        return
      } else if (c === "{") scanBraceExpr()
      else if (c === '"' || c === "'") readString(c)
      else if (c === "=") {
        push("punct", "=")
        i++
      } else if (ID_START.test(c)) {
        let k = i + 1
        while (k < n && /[\w$:-]/.test(src[k])) k++
        push("jsx-attr", src.slice(i, k))
        i = k
      } else {
        push("punct", c)
        i++
      }
    }
  }

  /** JSX 子节点：文本、{…}、嵌套元素，直到闭合标签 */
  const scanJsxChildren = () => {
    while (i < n) {
      const c = src[i]
      if (c === "<" && src[i + 1] === "/") {
        let j = i + 2
        while (j < n && /[\w$.:-]/.test(src[j])) j++
        push("tag", "</")
        push("tag", src.slice(i + 2, j))
        i = j
        while (i < n && SPACE.test(src[i])) readSpace()
        if (src[i] === ">") {
          push("tag", ">")
          i++
        }
        return
      }
      if (c === "<" && (ID_START.test(src[i + 1] ?? "") || src[i + 1] === ">")) scanJsxElement()
      else if (c === "{") scanBraceExpr()
      else {
        let j = i
        while (j < n && src[j] !== "<" && src[j] !== "{") j++
        if (j === i) j++
        pushMixed(src.slice(i, j), "jsx-text")
        i = j
      }
    }
  }

  /** 文本里的空白记成 plain，其余记成 kind */
  const pushMixed = (text: string, kind: SyntaxKind) => {
    for (const part of text.split(/(\s+)/)) {
      if (part) push(/^\s+$/.test(part) ? "plain" : kind, part)
    }
  }

  if (startInComment) {
    const end = src.indexOf("*/")
    const stop = end < 0 ? n : end + 2
    push("comment", src.slice(0, stop))
    i = stop
  }
  while (i < n) {
    scanCode(false)
    // scanCode(false) 只在扫完时返回；防御性推进，避免意外死循环
    if (i < n) {
      push("punct", src[i])
      i++
    }
  }
  return out
}

function scanJson(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = []
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    if (SPACE.test(c)) {
      let j = i
      while (j < n && SPACE.test(src[j])) j++
      out.push({ kind: "plain", text: src.slice(i, j) })
      i = j
    } else if (c === '"') {
      let j = i + 1
      while (j < n && src[j] !== '"' && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1
      if (j < n && src[j] === '"') j++
      out.push({ kind: "string", text: src.slice(i, Math.min(j, n)) })
      i = Math.min(j, n)
    } else if (/[-\d]/.test(c)) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(src.slice(i))
      const text = m ? m[0] : c
      out.push({ kind: m ? "number" : "text", text })
      i += text.length
    } else if (/[A-Za-z]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z]/.test(src[j])) j++
      const word = src.slice(i, j)
      out.push({ kind: word === "true" || word === "false" || word === "null" ? "keyword" : "text", text: word })
      i = j
    } else {
      out.push({ kind: "text", text: c })
      i++
    }
  }
  return out
}

function scanHtml(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = []
  const n = src.length
  let i = 0
  const push = (kind: SyntaxKind, text: string) => {
    if (text) out.push({ kind, text })
  }
  while (i < n) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4)
      const stop = end < 0 ? n : end + 3
      push("comment", src.slice(i, stop))
      i = stop
      continue
    }
    const c = src[i]
    const d = src[i + 1] ?? ""
    if (c === "<" && (/[A-Za-z]/.test(d) || d === "/" || d === "!")) {
      const open = d === "/" || d === "!" ? c + d : c
      push("tag", open)
      i += open.length
      let j = i
      while (j < n && /[\w:-]/.test(src[j])) j++
      push("tag", src.slice(i, j))
      i = j
      // 属性，直到 ">" 或 "/>"
      while (i < n) {
        const a = src[i]
        if (SPACE.test(a)) {
          let k = i
          while (k < n && SPACE.test(src[k])) k++
          push("plain", src.slice(i, k))
          i = k
        } else if (a === "/" && src[i + 1] === ">") {
          push("tag", "/>")
          i += 2
          break
        } else if (a === ">") {
          push("tag", ">")
          i++
          break
        } else if (a === '"' || a === "'") {
          const end = src.indexOf(a, i + 1)
          const stop = end < 0 ? n : end + 1
          push("string", src.slice(i, stop))
          i = stop
        } else if (a === "=") {
          push("text", a)
          i++
        } else {
          let k = i
          while (k < n && !SPACE.test(src[k]) && !/[=>"'/]/.test(src[k])) k++
          if (k === i) k++
          push("attr", src.slice(i, k))
          i = k
        }
      }
      continue
    }
    // 文本：到下一个 "<"
    let j = i + 1
    while (j < n && src[j] !== "<") j++
    for (const part of src.slice(i, j).split(/(\s+)/)) {
      if (part) push(/^\s+$/.test(part) ? "plain" : "text", part)
    }
    i = j
  }
  return out
}

/** 词级高亮：把 DiffMark（下标或子串）换成排好序、不重叠的 [起, 止) */
export function resolveMarks(text: string, marks: readonly (readonly [number, number] | string)[]): [number, number][] {
  const ranges: [number, number][] = []
  for (const m of marks) {
    if (typeof m === "string") {
      const at = m ? text.indexOf(m) : -1
      if (at >= 0) ranges.push([at, at + m.length])
    } else {
      const s = Math.max(0, Math.min(text.length, m[0]))
      const e = Math.max(s, Math.min(text.length, m[1]))
      if (e > s) ranges.push([s, e])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  return merged
}
