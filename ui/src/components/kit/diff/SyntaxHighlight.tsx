import { Fragment, useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react"
import { cn } from "@/lib/utils"
import { resolveMarks, SYNTAX_COLOR, tokenize, type SyntaxLang, type SyntaxLine, type TokenizeOptions } from "./syntax"
import type { DiffMark } from "./types"

export { resolveMarks, SYNTAX_COLOR, tokenize, tokenizeLines } from "./syntax"
export type { SyntaxKind, SyntaxLang, SyntaxLine, SyntaxToken, TokenizeOptions } from "./syntax"

export interface SyntaxTokensProps {
  /** 一行的记号（tokenize / tokenizeLines 的一项） */
  tokens: SyntaxLine
  /** 词级高亮范围（下标或子串，见 DiffMark） */
  marks?: readonly DiffMark[]
  /** 高亮 span 的底色等样式，例如 "bg-(--cw-diff-add-word)" */
  markClassName?: string
}

interface Segment {
  kind: SyntaxLine[number]["kind"]
  text: string
  mark: number
}

/**
 * 渲染一行记号；有词级高亮时把落在范围里的记号包进一个行内 span（高约一个字高、圆角 2，specs/ch3 §1.2）。
 * 给 UnifiedDiff 用，也给 ch5 的 CodeViewer 逐行渲染用。
 */
export function SyntaxTokens({ tokens, marks, markClassName }: SyntaxTokensProps) {
  const text = tokens.map((t) => t.text).join("")
  const ranges = marks && marks.length > 0 ? resolveMarks(text, marks) : []

  const segments: Segment[] = []
  let pos = 0
  for (const t of tokens) {
    const end = pos + t.text.length
    let s = pos
    while (s < end) {
      const inside = ranges.findIndex((r) => r[0] <= s && s < r[1])
      let e: number
      if (inside >= 0) e = Math.min(end, ranges[inside][1])
      else {
        const next = ranges.find((r) => r[0] > s)
        e = Math.min(end, next ? next[0] : end)
      }
      segments.push({ kind: t.kind, text: text.slice(s, e), mark: inside })
      s = e
    }
    pos = end
  }

  const out: ReactNode[] = []
  let i = 0
  while (i < segments.length) {
    const mark = segments[i].mark
    let j = i
    while (j < segments.length && segments[j].mark === mark) j++
    const group = segments.slice(i, j).map((seg, k) => renderSegment(seg, `${i}-${k}`))
    if (mark >= 0) {
      out.push(
        <span key={`m${i}`} data-slot="diff-word" className={cn("rounded-[2px]", markClassName)}>
          {group}
        </span>,
      )
    } else {
      out.push(<Fragment key={`p${i}`}>{group}</Fragment>)
    }
    i = j
  }
  return <>{out}</>
}

function renderSegment(seg: Segment, key: string): ReactNode {
  const color = SYNTAX_COLOR[seg.kind]
  if (!color) return <Fragment key={key}>{seg.text}</Fragment>
  return (
    <span key={key} style={{ color, fontStyle: seg.kind === "comment" ? "italic" : undefined }}>
      {seg.text}
    </span>
  )
}

export interface SyntaxHighlightProps extends Omit<ComponentPropsWithoutRef<"code">, "children"> {
  /** 代码原文，可含换行 */
  code: string
  lang?: SyntaxLang
  /** 块级显示（每行一行、保留空白，字号 13 / 行高 21）；默认行内、继承字号 */
  block?: boolean
  tokenizeOptions?: TokenizeOptions
}

/**
 * 只读语法高亮（ts / tsx / json / html；注释斜体；配色见 syntax.ts 与 specs/ch3 §0.4）。
 * 也以 Code 的名字导出（plan §5.3 "工具函数 + <Code>"）。
 */
export function SyntaxHighlight({ code, lang = "tsx", block, tokenizeOptions, className, ...rest }: SyntaxHighlightProps) {
  const lines = useMemo(() => tokenize(code, lang, tokenizeOptions), [code, lang, tokenizeOptions])
  return (
    <code
      data-slot="syntax-highlight"
      data-lang={lang}
      className={cn(
        "font-(family-name:--cw-font-mono) whitespace-pre text-(--cw-text)",
        block &&
          "block text-[length:var(--cw-diff-code-size,var(--cw-text-code-block))] leading-[var(--cw-diff-row-h,var(--cw-leading-code))]",
        className,
      )}
      {...rest}
    >
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <SyntaxTokens tokens={line} />
        </Fragment>
      ))}
    </code>
  )
}

export { SyntaxHighlight as Code }
