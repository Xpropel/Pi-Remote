import { useState } from "react"
import { DiffStat, FileTypeIcon, UnifiedDiff, type SyntaxLang } from "@/components/kit"
import { cn } from "@/lib/utils"
import { piBaseName } from "@/components/pi/shared/format"
import { CARD, CARD_DIVIDER, CARD_GAP, CARD_HEAD, CARD_HEAD_H, CARD_HEAD_H_PHONE, CARD_PEEK, PiCardFoot, PiCardPeekFade } from "./PiCard"
import { contentToRows, editsToLines, patchLines } from "./patch"
import { T_ERROR, T_SECONDARY } from "./styles"

export interface PiDiffCardProps {
  /** 文件路径（卡头只显示文件名，title 给完整路径） */
  path: string
  /** edit 工具的 details.patch（unified diff） */
  patch?: string
  /** write 工具的 input.content（新文件，全绿） */
  content?: string
  /** edit 没有 patch 时（失败、被停止、参数还在写）参数里的替换：画出它要改的行，不写行号 */
  edits?: readonly { oldText: string; newText: string }[]
  variant: "desktop" | "phone"
  /** 收起时露出的行数（默认 6，design §3.4 conversation："6 行 + 底部 chevron"） */
  collapsedRows?: number
  defaultOpen?: boolean
  /** 编辑失败（工具 output-error）：卡头行尾红字"未生效" */
  failed?: boolean
  /** 停止回合时被打断 / 参数写到一半就停了：卡头行尾灰字"已取消"（卡里是它当时要写的内容，没有写进文件） */
  cancelled?: boolean
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

/** 手机：行号栏收窄到 36，代码按字符软换行（同 PiChangesPane 的 PHONE_DIFF），续行留在代码列里 */
const PHONE_GUTTER = { ["--cw-diff-gutter-w" as string]: "36px", ["--cw-diff-lineno-pad" as string]: "8px", ["--cw-diff-code-pad" as string]: "8px" }

/**
 * 流内 diff 卡（PiDiffCard；D12 / K10：数据取 details.patch，write 取 input.content；compose from kit: FileTypeIcon, DiffStat, UnifiedDiff）。
 * 卡的几何见 PiCard：卡头图标 + 文件名 + 绿 +N 红 −N，成对红绿行、词级高亮，列变窄时长行软换行。
 * 收起时从第一处改动的前一行开始露 collapsedRows 整行，再多露一截渐隐；展开箭头在卡底单独一条（桌面 24、手机 32 + 44 点击区），
 * 渐隐和箭头都不压在最后一行代码上。手机多一列行号（design §3.4："diff 卡在手机上软换行、保留行号"）。
 */
export function PiDiffCard({ path, patch, content, edits, variant, collapsedRows = 6, defaultOpen, failed, cancelled, className }: PiDiffCardProps) {
  const lang = langOf(path)
  const { rows, added, removed } = patch
    ? patchLines(patch)
    : edits
      ? editsToLines(edits)
      : { rows: contentToRows(content ?? ""), added: (content ?? "").replace(/\n$/, "").split("\n").length, removed: 0 }
  const phone = variant === "phone"
  const [open, setOpen] = useState(!!defaultOpen)
  // 只多出一行时直接全露，不为一行出展开条
  const overflowing = rows.length > collapsedRows + 1
  const clipped = overflowing && !open
  const firstChange = rows.findIndex((r) => r.kind !== "context")
  const shown = clipped && firstChange > 1 ? rows.slice(firstChange - 1) : rows
  return (
    <div data-pi-part="diff-card" data-state={open ? "open" : "closed"} title={path} className={cn(CARD, CARD_GAP, className)}>
      <div className={cn(CARD_HEAD, CARD_DIVIDER, phone ? CARD_HEAD_H_PHONE : CARD_HEAD_H)}>
        <FileTypeIcon kind={kindOf(path)} />
        <span className="min-w-0 truncate text-(--cw-text)">{piBaseName(path)}</span>
        <DiffStat added={added} removed={removed > 0 ? removed : undefined} />
        {(failed || cancelled) && (
          <span className={cn("ml-auto shrink-0 pl-2 text-(length:--cw-text-sm)", failed ? T_ERROR : T_SECONDARY)}>{failed ? "未生效" : "已取消"}</span>
        )}
      </div>
      <div
        className={cn("relative overflow-hidden pt-[3px]", !overflowing && "pb-[3px]")}
        style={clipped ? { maxHeight: `calc(3px + ${collapsedRows} * var(--cw-diff-row-h, var(--cw-leading-code)) + ${CARD_PEEK}px)` } : undefined}
      >
        <UnifiedDiff
          rows={shown}
          lang={lang}
          lineNumbers={phone}
          wrap
          className={cn(phone && "[&_[data-slot=diff-code]]:break-all")}
          style={phone ? PHONE_GUTTER : undefined}
        />
        {clipped && <PiCardPeekFade />}
      </div>
      {overflowing && <PiCardFoot open={open} onToggle={() => setOpen(!open)} label={open ? "收起改动" : "展开改动"} />}
    </div>
  )
}

function kindOf(path: string) {
  const p = path.toLowerCase()
  if (p.endsWith(".json")) return "json" as const
  if (p.endsWith(".html")) return "html" as const
  if (p.endsWith(".tsx") || p.endsWith(".jsx")) return "tsx" as const
  if (/\.(ts|mts|cts)$/.test(p)) return "ts" as const
  if (/\.(js|mjs|cjs)$/.test(p)) return "js" as const
  if (/\.(txt|md|log|csv)$/.test(p)) return "txt" as const
  return "file" as const
}
