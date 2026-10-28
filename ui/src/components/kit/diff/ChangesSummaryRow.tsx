import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { Checkbox } from "@/components/kit/controls/Checkbox"
import { DiffStat } from "@/components/kit/controls/DiffStat"
import { GhostIconButton } from "@/components/kit/controls/GhostIconButton"
import { ChevronDown, List, Undo2 } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { PANE_TEXT, subId } from "./shared"
import type { Forced } from "./types"

export interface ChangesSummaryRowProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * uncommitted = diffs view 的组头 "N Uncommitted Changes ∨ +a -b" + 撤销 + 勾选（#5 #12 #13）；
   * pr = PR 的 "N Files Changed +a -b"，没有 ∨、撤销、勾选（#4 #14 #15）
   */
  variant?: "uncommitted" | "pr"
  /** 文件数；label 不填时拼成 "N Uncommitted Changes" / "N Files Changed" */
  count?: number
  label?: ReactNode
  added?: number
  removed?: number
  /** 组头 ∨（uncommitted 默认显示）。点它收起整组属于推断，组件只给 onToggle 回调 */
  chevron?: boolean
  onToggle?: () => void
  /** 整组是否展开：写到 ∨ 按钮的 aria-expanded（kit-requests ch3 #13）；不传 = 不写（现状） */
  open?: boolean
  /** ∨ 按钮的 aria-controls（被收起 / 展开的列表 id） */
  controlsId?: string
  /** 撤销钮（uncommitted 默认显示） */
  revert?: boolean
  /** 整组勾选框（uncommitted 默认显示） */
  checkbox?: boolean
  checked?: boolean | "indeterminate"
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  forced?: Forced
  /** 图标钮的无障碍名；不传 = "Toggle changes" / "Revert all" / "Include all"（kit-requests pi b6） */
  labels?: Partial<Record<"toggle" | "revert" | "include", string>>
}

/**
 * pane 里的分组汇总行（specs/ch3 §1.7）：行高 37，下边 1px --cw-divider。
 * list 14px（--cw-icon-fg）→ 文字 13px --cw-text-2 → ∨ 12px（--cw-text-4）→ DiffStat 13px；右端 undo-2（--cw-text-2）+ Checkbox。
 */
export function ChangesSummaryRow({
  variant = "uncommitted",
  count,
  label,
  added,
  removed,
  chevron,
  onToggle,
  open,
  controlsId,
  revert,
  checkbox,
  checked,
  defaultChecked,
  onCheckedChange,
  forced,
  labels,
  className,
  ...rest
}: ChangesSummaryRowProps) {
  const local = variant === "uncommitted"
  const text = label ?? (count != null ? `${count} ${local ? "Uncommitted Changes" : "Files Changed"}` : null)
  const showChevron = chevron ?? local
  const showRevert = revert ?? local
  const showCheckbox = checkbox ?? local
  return (
    <div
      data-slot="changes-summary-row"
      data-variant={variant}
      className={cn(
        PANE_TEXT,
        "flex h-[37px] items-center border-b border-solid border-(--cw-divider) pr-6 pl-3.5 whitespace-nowrap",
        className,
      )}
      {...rest}
    >
      <List aria-hidden size={14} strokeWidth={1.5} className="shrink-0 text-(--cw-icon-fg)" />
      <span className="ml-3 min-w-0 truncate text-(--cw-text-2)">{text}</span>
      {showChevron && (
        <button
          type="button"
          aria-label={labels?.toggle ?? "Toggle changes"}
          aria-expanded={open}
          aria-controls={controlsId}
          data-cw-id={subId(rest, "toggle")}
          onClick={onToggle}
          className="ml-1 inline-flex size-3 shrink-0 items-center justify-center text-(--cw-text-4) outline-none hover:text-(--cw-text-2)"
        >
          <ChevronDown aria-hidden size={12} strokeWidth={1.5} />
        </button>
      )}
      {(added != null || removed != null) && (
        <DiffStat added={added} removed={removed} className={showChevron ? "ml-1.5" : "ml-2"} />
      )}
      {(showRevert || showCheckbox) && <span className="min-w-2 flex-1" />}
      {showRevert && (
        <GhostIconButton
          size="sm"
          forced={forced}
          label={labels?.revert ?? "Revert all"}
          icon={<Undo2 />}
          data-cw-id={subId(rest, "revert")}
          className="text-(--cw-text-2)"
        />
      )}
      {showCheckbox && (
        <Checkbox
          aria-label={labels?.include ?? "Include all"}
          checked={checked}
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange ? (v) => onCheckedChange(v === true) : undefined}
          data-cw-id={subId(rest, "check")}
          className="ml-2"
        />
      )}
    </div>
  )
}
