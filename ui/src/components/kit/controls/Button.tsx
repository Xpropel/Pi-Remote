import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { focusRing, type Forced } from "./shared"

/** solid-black = 日常主动作（Mark as Ready，#14 #15）；solid-blue = 确认（RepoPicker 的 Done，#18） */
export type ButtonVariant = "solid-black" | "solid-blue" | "outline"

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant
  /** md = --cw-button-h（24，pane 头按钮，默认）；sm = 19px 高的小按钮（#18 Done：40×19，圆角约 5） */
  size?: "sm" | "md" | "lg"
  icon?: ReactNode
  forced?: Forced
}

const VARIANT: Record<ButtonVariant, string> = {
  "solid-black":
    "bg-(--cw-primary) font-medium hover:bg-(--cw-primary)/85 data-[forced=hover]:bg-(--cw-primary)/85 active:bg-(--cw-primary)/70 data-[forced=pressed]:bg-(--cw-primary)/70",
  "solid-blue":
    "bg-(--cw-blue) font-normal hover:bg-(--cw-blue)/90 data-[forced=hover]:bg-(--cw-blue)/90 active:bg-(--cw-blue)/80 data-[forced=pressed]:bg-(--cw-blue)/80",
  // 描边次按钮（pi c 弹窗底部「取消 / 刷新」）：--cw-surface 底、1px --cw-border、--cw-text 字
  outline:
    "border border-solid border-(--cw-border) bg-(--cw-surface) font-medium text-(--cw-text) hover:bg-(--cw-row-hover) data-[forced=hover]:bg-(--cw-row-hover) active:bg-(--cw-row-selected) data-[forced=pressed]:bg-(--cw-row-selected) disabled:text-(--cw-text-on-primary)",
}

const SIZE = {
  md: "h-(--cw-button-h) rounded-(--cw-radius-button) px-2.5",
  sm: "h-[19px] rounded-[5px] px-1.5",
  // lg：高 32、左右内距 14（pi c 弹窗按钮，桌面）
  lg: "h-8 rounded-(--cw-radius-button) px-3.5",
} as const

/** 实心矩形按钮。禁用态（推断）用 --cw-primary-pending 灰底白字。 */
export function Button({
  variant = "solid-black",
  size = "md",
  icon,
  forced,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      data-slot="button"
      data-variant={variant}
      data-forced={forced}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap select-none text-(length:--cw-text-md) leading-(--cw-leading-tight) text-(--cw-text-on-primary)",
        VARIANT[variant],
        SIZE[size],
        "disabled:cursor-default disabled:bg-(--cw-primary-pending)",
        focusRing,
        className,
      )}
      {...rest}
    >
      {icon != null && <span className="inline-flex shrink-0 items-center [&>svg]:size-3.5">{icon}</span>}
      {children}
    </button>
  )
}
