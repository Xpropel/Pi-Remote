import { useMemo, type ComponentPropsWithoutRef } from "react"
import { Plus } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { DIFF_CODE_TEXT, subId } from "./shared"
import { tokenizeLines, type SyntaxLang, type SyntaxLine } from "./syntax"
import { SyntaxTokens } from "./SyntaxHighlight"
import type { DiffLine, DiffLineKind, DiffRow } from "./types"
import { UnmodifiedLinesBar } from "./UnmodifiedLinesBar"

export interface UnifiedDiffProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** 行与折叠条，自上而下 */
  rows: readonly DiffRow[]
  lang?: SyntaxLang
  /** 行号栏（diffs view / PR 卡）；流内卡 InlineDiffCard 关掉 */
  lineNumbers?: boolean
  /**
   * 真实 hover 时在行号栏右端出现蓝色 "+"（#15，推断：hover 任一行都出现）。
   * 静态帧里某一行用 DiffLine.forced = "hover" 固定显示，与本开关无关。
   */
  hoverMarker?: boolean
  /** 软换行：长行在代码列内折行，续行留在代码列（默认 false = 不折行、超出截掉，现状；kit-requests pi b） */
  wrap?: boolean
}

/** 增 / 删行底色铺满整行 */
const ROW_BG: Record<DiffLineKind, string | undefined> = {
  context: undefined,
  add: "bg-(--cw-diff-add-bg)",
  del: "bg-(--cw-diff-del-bg)",
}
/** 行首 2px 竖条 */
const BAR_BG: Record<DiffLineKind, string | undefined> = {
  context: undefined,
  add: "bg-(--cw-diff-add-bar)",
  del: "bg-(--cw-diff-del-bar)",
}
/** 行号栏：add 行比代码区浅一档；del 行按 del 底色；context 与卡底同色 */
const GUTTER: Record<DiffLineKind, string> = {
  context: "text-(--cw-diff-lineno)",
  add: "bg-(--cw-diff-add-gutter-bg) text-[color:var(--cw-diff-lineno-add,var(--cw-green))]",
  del: "text-[color:var(--cw-diff-lineno-del,var(--cw-red))]",
}
const WORD_BG: Record<DiffLineKind, string | undefined> = {
  context: undefined,
  add: "bg-(--cw-diff-add-word)",
  del: "bg-(--cw-diff-del-word)",
}

/**
 * unified 单列 diff（specs/ch3 §1.3）。列结构（距 diff 左缘）：行首竖条 0–2（只在 add/del 行）、
 * 行号栏 0–45（行号右对齐于 35）、代码第 0 列 58.5。行高 21，等宽 13px，不折行（超出右缘截掉）。
 * 行号只有一列：context / add 行是新文件号，del 行是旧文件号。
 * 不做 split 并排与 hunk 级接受 / 拒绝（run-brief ⑦ 未核实）。
 */
export function UnifiedDiff({
  rows,
  lang = "tsx",
  lineNumbers = true,
  hoverMarker = false,
  wrap = false,
  className,
  ...rest
}: UnifiedDiffProps) {
  const tokens = useMemo(() => tokenizeRows(rows, lang), [rows, lang])
  return (
    <div
      data-slot="unified-diff"
      data-line-numbers={lineNumbers ? "" : undefined}
      data-wrap={wrap ? "" : undefined}
      className={cn(DIFF_CODE_TEXT, "text-(--cw-text)", className)}
      {...rest}
    >
      {rows.map((row, i) =>
        row.kind === "fold" ? (
          <UnmodifiedLinesBar
            key={i}
            count={row.count}
            label={row.label}
            variant={row.variant}
            handle={row.handle}
            forced={row.forced}
            className={row.className}
            data-cw-id={subId(rest, `fold-${i}`)}
          />
        ) : (
          <DiffLineRow
            key={i}
            line={row}
            tokens={tokens[i] ?? []}
            lineNumbers={lineNumbers}
            hoverMarker={hoverMarker}
            wrap={wrap}
            id={subId(rest, `line-${i}`)}
          />
        ),
      )}
    </div>
  )
}

/** 每段（两条折叠条之间）单独分词：折叠区里的代码看不到，状态不跨段 */
function tokenizeRows(rows: readonly DiffRow[], lang: SyntaxLang): (SyntaxLine | undefined)[] {
  const out: (SyntaxLine | undefined)[] = new Array(rows.length)
  let start = 0
  const flush = (end: number) => {
    if (end <= start) return
    const lines = rows.slice(start, end).map((r) => (r.kind === "fold" ? "" : r.text))
    tokenizeLines(lines, lang).forEach((l, k) => {
      out[start + k] = l
    })
  }
  rows.forEach((r, i) => {
    if (r.kind === "fold") {
      flush(i)
      start = i + 1
    }
  })
  flush(rows.length)
  return out
}

interface DiffLineRowProps {
  line: DiffLine
  tokens: SyntaxLine
  lineNumbers: boolean
  hoverMarker: boolean
  wrap?: boolean
  id?: string
}

function DiffLineRow({ line, tokens, lineNumbers, hoverMarker, wrap, id }: DiffLineRowProps) {
  const forcedHover = line.forced === "hover"
  const showMarker = lineNumbers && (hoverMarker || forcedHover)
  return (
    <div
      data-slot="diff-line"
      data-kind={line.kind}
      data-forced={line.forced}
      data-cw-id={id}
      className={cn("group/line relative flex min-h-[1lh] whitespace-pre", ROW_BG[line.kind])}
    >
      {line.kind !== "context" && (
        <span aria-hidden className={cn("absolute inset-y-0 left-0 z-[1] w-(--cw-diff-bar-w)", BAR_BG[line.kind])} />
      )}
      {lineNumbers && (
        <span
          data-slot="diff-lineno"
          className={cn(
            "w-[var(--cw-diff-gutter-w,45px)] shrink-0 pr-[var(--cw-diff-lineno-pad,10px)] text-right select-none",
            GUTTER[line.kind],
          )}
        >
          {line.n}
        </span>
      )}
      <span
        data-slot="diff-code"
        className={cn(
          "min-w-0 flex-1 overflow-hidden",
          wrap && "whitespace-pre-wrap [overflow-wrap:anywhere]",
          lineNumbers ? "pl-[var(--cw-diff-code-pad,13.5px)]" : "pl-[var(--cw-diff-code-pad,12px)]",
        )}
      >
        <SyntaxTokens tokens={tokens} marks={line.marks} markClassName={WORD_BG[line.kind]} />
      </span>
      {showMarker && (
        <span
          aria-hidden
          data-slot="diff-hover-marker"
          className={cn(
            // 方块左缘 = 行号右缘再左移 2（压住行号最后一位），约 18×18、圆角 3、白色 plus 12px（specs/ch3 §1.3）
            "pointer-events-none absolute top-1/2 left-[calc(var(--cw-diff-gutter-w,45px)_-_var(--cw-diff-lineno-pad,10px)_-_2px)] z-[2] size-[18px] -translate-y-1/2 place-items-center rounded-[3px]",
            "bg-[color:var(--cw-diff-hover-marker,var(--cw-blue))] text-(--cw-primary-fg)",
            forcedHover ? "grid" : "hidden group-hover/line:grid",
          )}
        >
          <Plus size={12} strokeWidth={2} aria-hidden />
        </span>
      )}
    </div>
  )
}
