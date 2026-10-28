import { useState, type ComponentPropsWithoutRef, type KeyboardEvent } from "react"
import { cn } from "@/lib/utils"
import { DiffFileRow, type DiffFileRowProps, type DiffFileRowVariant } from "./DiffFileRow"
import { subId } from "./shared"
import type { SyntaxLang } from "./syntax"
import type { DiffRow } from "./types"
import { UnifiedDiff, type UnifiedDiffProps } from "./UnifiedDiff"

type RowProps = Pick<
  DiffFileRowProps,
  | "path"
  | "fileKind"
  | "fileIcon"
  | "added"
  | "removed"
  | "isNew"
  | "trailingIcon"
  | "statPlacement"
  | "revert"
  | "checkbox"
  | "checked"
  | "defaultChecked"
  | "onCheckedChange"
  | "forced"
  | "labels"
>

export interface DiffFileSectionProps extends RowProps, Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** list = diffs view（#5 #12 #13）；card = 云端 PR 卡堆（#14 #15） */
  variant?: DiffFileRowVariant
  /** diff 本体（行与折叠条） */
  rows: readonly DiffRow[]
  lang?: SyntaxLang
  /** 受控展开 */
  open?: boolean
  /** 非受控初值，默认 true（帧里的文件卡都是展开的；#12 第 1 个文件用 false） */
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** 透传给 UnifiedDiff（hoverMarker、style 覆盖列宽变量等） */
  diffProps?: Omit<UnifiedDiffProps, "rows" | "lang">
  /** 卡头的额外 class。各帧实测卡头高不同（#15 33.6、#14 36.3、#13 37.3），屏幕可写 "h-[36px]" 微调 */
  headerClassName?: string
}

/**
 * 文件行 + unified diff（specs/ch3 §1.8）。点卡头展开 / 收起；收起后只剩文件行，和 DiffFileRow 一模一样。
 * 卡头里的 ↗ / 撤销 / 勾选各管各的，点它们不触发展开。
 * 外框：白卡 --cw-surface-pane、1px --cw-border、圆角 8（估计）；展开时卡头下 1px --cw-divider 接 diff。
 */
export function DiffFileSection({
  variant = "list",
  rows,
  lang = "tsx",
  open: openProp,
  defaultOpen = true,
  onOpenChange,
  diffProps,
  headerClassName,
  path,
  fileKind,
  fileIcon,
  added,
  removed,
  isNew,
  trailingIcon,
  statPlacement,
  revert,
  checkbox,
  checked,
  defaultChecked,
  onCheckedChange,
  forced,
  labels,
  className,
  ...rest
}: DiffFileSectionProps) {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState
  const toggle = () => {
    const next = !open
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      toggle()
    }
  }
  return (
    <div
      data-slot="diff-file-section"
      data-variant={variant}
      data-state={open ? "open" : "closed"}
      className={cn(
        "shrink-0 overflow-hidden rounded-[8px] border border-solid border-(--cw-border) bg-(--cw-surface-pane)",
        className,
      )}
      {...rest}
    >
      <DiffFileRow
        bare
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={onKeyDown}
        data-cw-id={subId(rest, "header")}
        className={cn(
          "cursor-default outline-none focus-visible:bg-(--cw-row-hover)",
          open && "border-b border-solid border-(--cw-divider)",
          headerClassName,
        )}
        variant={variant}
        path={path}
        fileKind={fileKind}
        fileIcon={fileIcon}
        added={added}
        removed={removed}
        isNew={isNew}
        trailingIcon={trailingIcon}
        statPlacement={statPlacement}
        revert={revert}
        checkbox={checkbox}
        checked={checked}
        defaultChecked={defaultChecked}
        onCheckedChange={onCheckedChange}
        forced={forced}
        labels={labels}
      />
      {open && <UnifiedDiff rows={rows} lang={lang} data-cw-id={subId(rest, "diff")} {...diffProps} />}
    </div>
  )
}
