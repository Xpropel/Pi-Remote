import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { ChevronDown, ChevronsDownUp, ChevronUp } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import type { Forced, UnmodifiedLinesBarVariant, UnmodifiedLinesHandle } from "./types"

export interface UnmodifiedLinesBarProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** 被折叠的行数 */
  count: number
  /** 默认 "N unmodified lines" */
  label?: ReactNode
  /** handles = #14（默认）；plain = #15 */
  variant?: UnmodifiedLinesBarVariant
  /** handles 变体把手区里的图标：down-up（#14，默认）、up / fold（#5） */
  handle?: UnmodifiedLinesHandle
  /** 静态 hover（底色深一档，估计） */
  forced?: Forced
}

const HOVER =
  "hover:bg-[color:var(--cw-diff-unmodified-hover-bg,var(--cw-chip-bg))] data-[forced=hover]:bg-[color:var(--cw-diff-unmodified-hover-bg,var(--cw-chip-bg))]"

/**
 * diff 里的未改行折叠条（specs/ch3 §1.4）。
 * - handles：距卡左 10、右 9，高 36，圆角 6，底 --cw-diff-unmodified-bg；左端 31 宽浅色把手区（∨ 上、∧ 下，14px，--cw-text-4）；
 *   文字 13px --cw-text-3，左缘距条左 43；上下离代码行约 8。
 * - plain：距卡左右约 2，高 26，无把手；文字 12px，左缘距条左 17；上下离代码行约 5–6。
 * 按 plan 只做 hover，不展开隐藏行（图上没有展开后的样子）。
 */
export function UnmodifiedLinesBar({
  count,
  label,
  variant = "handles",
  handle = "down-up",
  forced,
  className,
  ...rest
}: UnmodifiedLinesBarProps) {
  const text = label ?? `${count} unmodified lines`
  if (variant === "plain") {
    return (
      <div
        data-slot="unmodified-lines-bar"
        data-variant="plain"
        data-forced={forced}
        className={cn(
          "mx-[2px] my-[5px] flex h-[26px] items-center rounded-(--cw-radius-xs) bg-(--cw-diff-unmodified-bg) pl-[17px] whitespace-nowrap select-none",
          "font-(family-name:--cw-font-sans) text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-text-3)",
          HOVER,
          className,
        )}
        {...rest}
      >
        {text}
      </div>
    )
  }
  return (
    <div
      data-slot="unmodified-lines-bar"
      data-variant="handles"
      data-forced={forced}
      className={cn(
        "my-2 mr-[9px] ml-[10px] flex h-9 items-stretch overflow-hidden rounded-(--cw-radius-button) bg-(--cw-diff-unmodified-bg) whitespace-nowrap select-none",
        "font-(family-name:--cw-font-sans) text-(length:--cw-text-md) leading-(--cw-leading-tight) text-(--cw-text-3)",
        HOVER,
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        data-slot="unmodified-lines-handle"
        className="flex w-[31px] shrink-0 flex-col items-center justify-center gap-1 bg-[color:var(--cw-diff-unmodified-handle-bg,var(--cw-row-hover))] text-(--cw-text-4)"
      >
        <HandleIcon handle={handle} />
      </span>
      <span className="ml-3 self-center">{text}</span>
    </div>
  )
}

function HandleIcon({ handle }: { handle: UnmodifiedLinesHandle }) {
  const props = { size: 14, strokeWidth: 1.5, "aria-hidden": true } as const
  switch (handle) {
    case "down-up":
      return (
        <>
          <ChevronDown {...props} />
          <ChevronUp {...props} />
        </>
      )
    case "up":
      return <ChevronUp {...props} />
    case "down":
      return <ChevronDown {...props} />
    case "fold":
      return <ChevronsDownUp {...props} />
  }
}
