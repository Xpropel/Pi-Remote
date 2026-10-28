import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react"
import { Checkbox } from "@/components/kit/controls/Checkbox"
import { DiffStat } from "@/components/kit/controls/DiffStat"
import { GhostIconButton } from "@/components/kit/controls/GhostIconButton"
import { ArrowUpRight, Copy, Undo2 } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { FileTypeIcon } from "./FileTypeIcon"
import { fileKindOf, PANE_TEXT, subId } from "./shared"
import type { FileKind, Forced } from "./types"

export type DiffFileRowVariant = "list" | "card"

export interface DiffFileRowProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** 完整路径，铺开不截断（放不下时才省略号） */
  path: string
  /** 不填时按扩展名推：.txt → 横线、.ts → "TS"、.tsx → atom、.json → braces、.html → code-xml */
  fileKind?: FileKind
  fileIcon?: ReactNode
  added?: number
  removed?: number
  /** 绿字 "New"（新文件，list 变体） */
  isNew?: boolean
  /**
   * list = diffs view 的文件行（#5 #12 #13：右端 New / 撤销 / 勾选）；
   * card = 云端 PR 卡头（#14 #15：没有 New / 撤销 / 勾选）
   */
  variant?: DiffFileRowVariant
  /** 路径后的小图标：external = arrow-up-right（默认）；copy = #14；none */
  trailingIcon?: "external" | "copy" | "none"
  /** DiffStat 位置：inline = 紧跟图标（默认，#12 #13 #14）；end = 右对齐（#15） */
  statPlacement?: "inline" | "end"
  /** 撤销钮 undo-2（list 默认显示） */
  revert?: boolean
  /** 勾选框（list 默认显示；图上只出现未勾态） */
  checkbox?: boolean
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  /** 作为 DiffFileSection 的卡头：不画自己的外框（外框由 section 画） */
  bare?: boolean
  /** 静态 hover：图标钮的 hover 底（文件行本身没有 hover 证据） */
  forced?: Forced
  /** 图标钮的无障碍名；不传 = 现在的英文（Open file / Copy path / Revert file / Include file；kit-requests pi b） */
  labels?: Partial<Record<"open" | "copy" | "revert" | "include", string>>
}

const stop = (e: MouseEvent) => e.stopPropagation()

/**
 * diffs view 的文件行 / PR 文件卡头（specs/ch3 §1.8）。折叠行和展开卡头内容完全相同，区别只是下面接不接 diff。
 * list：白卡 --cw-surface-pane、1px --cw-border、圆角 8；图标 glyph 左 13.7 → 路径 34.5（13px --cw-text）→ 9 后 ↗（16px、--cw-text-4）→ 10 后 DiffStat；
 * 右簇 "New"（12px 绿）→ undo-2 → Checkbox，右内距约 12。
 * ↗ / copy / undo-2 是 GhostIconButton，只有 hover，没有动作（不编对话框）。
 */
export function DiffFileRow({
  path,
  fileKind,
  fileIcon,
  added,
  removed,
  isNew,
  variant = "list",
  trailingIcon = "external",
  statPlacement = "inline",
  revert,
  checkbox,
  checked,
  defaultChecked,
  onCheckedChange,
  bare,
  forced,
  labels,
  className,
  ...rest
}: DiffFileRowProps) {
  const showRevert = revert ?? variant === "list"
  const showCheckbox = checkbox ?? variant === "list"
  const hasStat = added != null || removed != null
  const stat = hasStat ? <DiffStat added={added} removed={removed} /> : null
  const hasRight = isNew || showRevert || showCheckbox
  return (
    <div
      data-slot="diff-file-row"
      data-variant={variant}
      className={cn(
        PANE_TEXT,
        "flex items-center pr-3 pl-2.5 whitespace-nowrap",
        // 行高 35.5（含上下描边）；作卡头时外框归 section，内容高同为 33.5
        bare ? "h-[33.5px]" : "h-[35.5px] rounded-[8px] border border-solid border-(--cw-border) bg-(--cw-surface-pane)",
        className,
      )}
      {...rest}
    >
      {fileIcon ?? <FileTypeIcon kind={fileKind ?? fileKindOf(path)} />}
      <span data-slot="diff-file-path" className="ml-2.5 min-w-0 truncate text-(--cw-text)">
        {path}
      </span>
      {trailingIcon !== "none" && (
        <GhostIconButton
          size="sm"
          forced={forced}
          label={trailingIcon === "copy" ? (labels?.copy ?? "Copy path") : (labels?.open ?? "Open file")}
          icon={trailingIcon === "copy" ? <Copy /> : <ArrowUpRight />}
          data-cw-id={subId(rest, trailingIcon === "copy" ? "copy" : "open")}
          onClick={stop}
          className={cn(
            "ml-1 size-4 text-(--cw-text-4)",
            trailingIcon === "copy" ? "[&>svg]:size-3.5" : "[&>svg]:size-4",
          )}
        />
      )}
      {statPlacement === "inline" && stat && <span className="ml-2 inline-flex">{stat}</span>}
      {(hasRight || (statPlacement === "end" && stat)) && <span className="min-w-2 flex-1" />}
      {statPlacement === "end" && stat}
      {isNew && <span className="text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-green)">New</span>}
      {showRevert && (
        <GhostIconButton
          size="sm"
          forced={forced}
          label={labels?.revert ?? "Revert file"}
          icon={<Undo2 />}
          data-cw-id={subId(rest, "revert")}
          onClick={stop}
          className={cn("text-(--cw-text-2)", isNew && "ml-1")}
        />
      )}
      {showCheckbox && (
        <Checkbox
          aria-label={labels?.include ?? "Include file"}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange ? (v) => onCheckedChange(v === true) : undefined}
          data-cw-id={subId(rest, "check")}
          onClick={stop}
          className="ml-2"
        />
      )}
    </div>
  )
}
