import { useState, type ComponentPropsWithoutRef, type ReactNode } from "react"
import { DiffStat } from "@/components/kit/controls/DiffStat"
import { ChevronDown } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { FileTypeIcon } from "./FileTypeIcon"
import { fileKindOf, subId } from "./shared"
import type { SyntaxLang } from "./syntax"
import type { DiffLine, FileKind, Forced } from "./types"
import { UnifiedDiff } from "./UnifiedDiff"

export interface InlineDiffCardProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** 卡头文件名，例如 "package.json" */
  fileName: string
  /** 不填时按扩展名推（json → braces、html → code-xml、tsx → atom、ts → "TS"） */
  fileKind?: FileKind
  /** 自定义卡头图标（替换 FileTypeIcon） */
  fileIcon?: ReactNode
  /** 卡头 "+N"（绿） */
  added?: number
  /** 卡头 "-M"（红）；纯新增卡不填（#11 "+10"） */
  removed?: number
  /** 卡身代码行（没有行号、没有折叠条） */
  rows: readonly DiffLine[]
  lang?: SyntaxLang
  /** 受控：展开（去掉高度限制和渐隐） */
  open?: boolean
  /** 非受控初值，默认 false（collapsed，#10 #11 都是这个态） */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** collapsed 时露出的行数：3 整行 + 第 4 行约 18px（卡总高 118，specs/ch3 §1.2） */
  collapsedRows?: number
  /** 生成中（#11 第 2 张）：只是语义标记（aria-busy），外观与 collapsed 相同；卡头通常只有 +N */
  generating?: boolean
  /** "hover"：静态显示卡底 chevron（#10 卡 1）。真实 hover 也会显示（推断：#10 只有被悬停的卡 1 有 chevron） */
  forced?: Forced
  /** 卡身显示行号（默认 false = 现状；透传给 UnifiedDiff，kit-requests pi b） */
  lineNumbers?: boolean
  /** 卡身软换行（默认 false = 现状；见 UnifiedDiff.wrap） */
  wrap?: boolean
  /** 卡底 ∨ 的显示：hover = 悬停才出现（默认，现状）；always = 常显（触屏没有悬停） */
  chevron?: "hover" | "always"
  /** ∨ 按钮的无障碍名；不传 = "Expand diff" / "Collapse diff" */
  labels?: Partial<Record<"expand" | "collapse", string>>
}

/**
 * 对话流里的 diff 卡（specs/ch3 §1.2）：卡头（文件类型图标 + 文件名 + DiffStat）+ 成对红绿行 + 词级高亮，
 * collapsed 时卡底渐隐、hover 出现卡底 ∨，点击在 collapsed / expanded 之间切换（expanded 的 ∨ 转 180°，推断）。
 * 撑满所在列宽（stream family 约定：InlineDiffCard 与 UserMessage 同属撑满组）。
 */
export function InlineDiffCard({
  fileName,
  fileKind,
  fileIcon,
  added,
  removed,
  rows,
  lang = "tsx",
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  collapsedRows = 3.9,
  generating,
  forced,
  lineNumbers = false,
  wrap = false,
  chevron = "hover",
  labels,
  className,
  ...rest
}: InlineDiffCardProps) {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }
  // 行数不超过露出的整行数时没有可展开的内容：不渐隐、不出 chevron
  const overflowing = rows.length > Math.floor(collapsedRows)
  const clipped = !open && overflowing

  return (
    <div
      data-slot="inline-diff-card"
      data-state={open ? "open" : "closed"}
      data-generating={generating ? "" : undefined}
      data-forced={forced}
      aria-busy={generating || undefined}
      className={cn(
        "group/card relative overflow-hidden rounded-(--cw-radius-card) border border-solid border-(--cw-border) bg-(--cw-surface) shadow-(--cw-shadow-card)",
        className,
      )}
      {...rest}
    >
      <div
        data-slot="inline-diff-card-header"
        // 卡顶描边 1 + 卡头 30 + 下分隔 1 = 32（specs/ch3 §1.2）；图标盒左缘约 11、文件名左缘 33.4
        className="flex h-[31px] items-center gap-2 border-b border-solid border-(--cw-divider) pr-3 pl-2.5 font-(family-name:--cw-font-sans) text-(length:--cw-text-base) leading-(--cw-leading-tight) whitespace-nowrap"
      >
        {fileIcon ?? <FileTypeIcon kind={fileKind ?? fileKindOf(fileName)} />}
        <span className="min-w-0 truncate text-(--cw-text)">{fileName}</span>
        {(added != null || removed != null) && <DiffStat added={added} removed={removed} />}
      </div>
      <div
        data-slot="inline-diff-card-body"
        className={cn("relative overflow-hidden pt-[3px]", open && overflowing && "pb-5")}
        style={
          clipped
            ? { maxHeight: `calc(3px + ${collapsedRows} * var(--cw-diff-row-h, var(--cw-leading-code)))` }
            : undefined
        }
      >
        <UnifiedDiff rows={rows} lang={lang} lineNumbers={lineNumbers} wrap={wrap} data-cw-id={subId(rest, "diff")} />
        {clipped && (
          <div
            aria-hidden
            data-slot="inline-diff-card-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-linear-to-b from-transparent to-(--cw-surface)"
          />
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          data-slot="inline-diff-card-toggle"
          data-cw-id={subId(rest, "toggle")}
          aria-expanded={open}
          aria-label={open ? (labels?.collapse ?? "Collapse diff") : (labels?.expand ?? "Expand diff")}
          onClick={() => setOpen(!open)}
          className={cn(
            // chevron 中心距卡底 12.6（glyph 9.8×6.7，--cw-text-2），水平居中，叠在渐隐区里
            "absolute bottom-[3.5px] left-1/2 z-[3] inline-flex h-4 w-6 -translate-x-1/2 items-center justify-center text-(--cw-text-2) outline-none",
            "opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100",
            (forced === "hover" || chevron === "always") && "opacity-100",
          )}
        >
          <ChevronDown size={16} strokeWidth={1.5} aria-hidden className={cn(open && "rotate-180")} />
        </button>
      )}
    </div>
  )
}
