import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { focusRing, type Forced } from "./shared"

export interface GhostIconButtonProps extends ComponentProps<"button"> {
  /** 图标元素，例如 <Ellipsis />；尺寸与线宽由 size 统一。也可以写成 children。 */
  icon?: ReactNode
  /**
   * md：24 方框 + 16px 图标（标题栏 …、分屏、侧栏开关、搜索，默认）；
   * sm：20 方框 + 14px 图标（撤销 ↶、复制、外链 ↗、∧ / ∨）。
   */
  size?: "sm" | "md"
  /** default = --cw-icon-fg；muted = --cw-text-4（不可用的 ← → 等浅灰图标） */
  tone?: "default" | "muted"
  /** 无障碍名称，会写进 aria-label */
  label?: string
  forced?: Forced
}

/**
 * 无底小图标钮。hover 出现浅灰底、图标加深一级（hover 色是用主文字色的 5% 叠出来的，
 * 在主区 #F7F7F7、侧栏 #EEEEEE、白卡上都成立）。
 */
export function GhostIconButton({
  icon,
  size = "md",
  tone = "default",
  label,
  forced,
  className,
  children,
  type = "button",
  ...rest
}: GhostIconButtonProps) {
  return (
    <button
      data-slot="ghost-icon-button"
      data-forced={forced}
      type={type}
      aria-label={label ?? rest["aria-label"]}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-(--cw-radius-button) select-none [&>svg]:[stroke-width:var(--cw-ghost-icon-stroke,1.5)]",
        size === "md" ? "size-6 [&>svg]:size-(--cw-icon-size)" : "size-5 [&>svg]:size-(--cw-icon-size-sm)",
        tone === "muted" ? "text-(--cw-text-4)" : "text-(--cw-icon-fg)",
        "hover:bg-(--cw-text)/5 hover:text-(--cw-text-2) data-[forced=hover]:bg-(--cw-text)/5 data-[forced=hover]:text-(--cw-text-2)",
        "active:bg-(--cw-text)/10 data-[forced=pressed]:bg-(--cw-text)/10 data-[forced=pressed]:text-(--cw-text-2)",
        "disabled:pointer-events-none disabled:text-(--cw-text-4)",
        focusRing,
        className,
      )}
      {...rest}
    >
      {icon ?? children}
    </button>
  )
}
