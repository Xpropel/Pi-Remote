import { useState } from "react"
import { DiffStat, FileTypeIcon, InlineDiffCard, UnifiedDiff, type DiffLine, type SyntaxLang } from "@/components/kit"
import { ChevronDown } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { piBaseName } from "@/components/pi/shared/format"
import { contentToRows, patchLines } from "./patch"
import { T_ERROR } from "./styles"

export interface PiDiffCardProps {
  /** 文件路径（卡头只显示文件名，title 给完整路径） */
  path: string
  /** edit 工具的 details.patch（unified diff） */
  patch?: string
  /** write 工具的 input.content（新文件，全绿） */
  content?: string
  variant: "desktop" | "phone"
  /** 收起时露出的行数（默认 6，design §3.4 conversation："6 行 + 底部 chevron"） */
  collapsedRows?: number
  defaultOpen?: boolean
  /** 编辑失败（工具 output-error）：卡头行尾红字"未生效" */
  failed?: boolean
  className?: string
}

/** 文件扩展名 → kit 分词器的语言 */
export function langOf(path: string): SyntaxLang {
  const p = path.toLowerCase()
  if (p.endsWith(".tsx")) return "tsx"
  if (p.endsWith(".ts") || p.endsWith(".mts")) return "ts"
  if (/\.(m?js|cjs)$/.test(p)) return "js"
  if (p.endsWith(".jsx")) return "jsx"
  if (p.endsWith(".json")) return "json"
  if (p.endsWith(".html")) return "html"
  return "text"
}

/**
 * 流内 diff 卡（PiDiffCard；D12 / K10：数据取 details.patch，write 取 input.content）。
 * - desktop：kit InlineDiffCard 原样（Cursor 流内卡：卡头图标 + 文件名 + 绿 +N 红 −N、成对红绿行、词级高亮、底部 chevron）。
 *   chevron 常显（chevron="always"）：手机 / 触屏没有悬停，桌面跟着统一（推断）。列变窄时长行软换行（wrap）。
 * - phone：同一语法自组（compose from kit: FileTypeIcon, DiffStat, UnifiedDiff）：带一列行号、软换行、续行对齐代码列
 *   （design §3.4："diff 卡在手机上软换行、保留行号"）。kit InlineDiffCard 已有 lineNumbers / wrap / chevron（P3.1），
 *   但卡头 31 高、卡底 ∨ 只有 24×16 可点；手机要 36 高的卡头和 44×44 的点击区（§4.4），所以手机仍自组。
 */
export function PiDiffCard({ path, patch, content, variant, collapsedRows = 6, defaultOpen, failed, className }: PiDiffCardProps) {
  const lang = langOf(path)
  const { rows, added, removed } = patch
    ? patchLines(patch)
    : { rows: contentToRows(content ?? ""), added: (content ?? "").replace(/\n$/, "").split("\n").length, removed: 0 }
  const name = piBaseName(path)

  if (variant === "desktop") {
    return (
      <div
        data-pi-part="diff-card"
        title={path}
        className={cn("my-(--cw-space-2-5)", className)}
      >
        <InlineDiffCard
          fileName={name}
          added={added}
          removed={removed > 0 ? removed : undefined}
          rows={rows}
          lang={lang}
          collapsedRows={collapsedRows + 0.9}
          defaultOpen={defaultOpen}
          // 列变窄（右 pane 打开）时长行软换行、续行留在代码列，不被 kit 代码列硬切（同 B1）
          wrap
          chevron="always"
          labels={{ expand: "展开改动", collapse: "收起改动" }}
        />
        {failed && <div className={cn("mt-1 text-(length:--cw-text-sm)", T_ERROR)}>这次编辑未生效</div>}
      </div>
    )
  }
  return (
    <PhoneDiffCard
      path={path}
      name={name}
      rows={rows}
      lang={lang}
      added={added}
      removed={removed}
      collapsedRows={collapsedRows}
      defaultOpen={defaultOpen}
      failed={failed}
      className={className}
    />
  )
}

function PhoneDiffCard({
  path,
  name,
  rows,
  lang,
  added,
  removed,
  collapsedRows,
  defaultOpen,
  failed,
  className,
}: {
  path: string
  name: string
  rows: DiffLine[]
  lang: SyntaxLang
  added: number
  removed: number
  collapsedRows: number
  defaultOpen?: boolean
  failed?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  const overflowing = rows.length > collapsedRows
  const clipped = overflowing && !open
  // 手机软换行后能露出的行更少：收起时从第一处改动的前一行开始露（推断），展开后从头显示
  const firstChange = rows.findIndex((r) => r.kind !== "context")
  const shown = clipped && firstChange > 1 ? rows.slice(firstChange - 1) : rows
  return (
    <div
      data-pi-part="diff-card"
      title={path}
      className={cn(
        "relative my-(--cw-space-2-5) overflow-hidden rounded-(--cw-radius-card) border border-(--cw-border) bg-(--cw-surface) shadow-(--cw-shadow-card)",
        className,
      )}
    >
      <div className="flex h-9 items-center gap-2 border-b border-(--cw-divider) pr-3 pl-2.5 text-(length:--cw-text-base) whitespace-nowrap">
        <FileTypeIcon kind={kindOf(path)} />
        <span className="min-w-0 truncate text-(--cw-text)">{name}</span>
        <DiffStat added={added} removed={removed > 0 ? removed : undefined} />
        {failed && <span className={cn("ml-auto text-(length:--cw-text-sm)", T_ERROR)}>未生效</span>}
      </div>
      <div
        className="relative overflow-hidden pt-[3px]"
        style={
          clipped
            ? { maxHeight: `calc(3px + ${collapsedRows} * var(--cw-diff-row-h, var(--cw-leading-code)) + 8px)` }
            : { paddingBottom: overflowing ? 28 : 4 }
        }
      >
        <UnifiedDiff
          rows={shown}
          lang={lang}
          lineNumbers
          // 手机：行号栏收窄到 36，代码软换行（按字符断行，同 PiChangesPane 的 PHONE_DIFF），续行留在代码列里（推断）
          wrap
          className="[&_[data-slot=diff-code]]:break-all"
          style={{ ["--cw-diff-gutter-w" as string]: "36px", ["--cw-diff-lineno-pad" as string]: "8px", ["--cw-diff-code-pad" as string]: "8px" }}
        />
        {clipped && (
          <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-(--cw-surface)" />
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "收起改动" : "展开改动"}
          onClick={() => setOpen(!open)}
          // 视觉 16（图标仍在卡底 28 高的那条里居中），点击区 44×44：向上盖住渐隐区，卡的 overflow 不会裁掉（§4.4；B2）
          className="absolute bottom-0 left-1/2 z-[3] inline-flex h-11 w-11 -translate-x-1/2 items-end justify-center pb-1.5 text-(--cw-text-2)"
        >
          <ChevronDown size={16} strokeWidth={1.5} aria-hidden className={cn(open && "rotate-180")} />
        </button>
      )}
    </div>
  )
}

function kindOf(path: string) {
  const p = path.toLowerCase()
  if (p.endsWith(".json")) return "json" as const
  if (p.endsWith(".html")) return "html" as const
  if (p.endsWith(".tsx") || p.endsWith(".jsx")) return "tsx" as const
  if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(p)) return "ts" as const
  if (/\.(txt|md|log|csv)$/.test(p)) return "txt" as const
  return "file" as const
}
