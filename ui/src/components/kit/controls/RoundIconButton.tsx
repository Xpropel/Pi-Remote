import type { ComponentProps, CSSProperties, ReactNode } from "react"
import { ArrowDown, ArrowUp, Mic, Plus } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { focusRing, type Forced } from "./shared"

/**
 * mic         黑圆 + 白麦克风（composer 空闲）
 * send        黑圆 + 白 ↑（已输入文字，#22）
 * stop        黑圆 + 白色圆角实心方块（运行中，#28）
 * send-muted  浅灰圆 + 灰 ↑（#6 渲染口径）
 * plus        浅灰圆 + "+"（composer 左下）
 * scroll-down 白底细描边圆 + ↓（#6 #14 #23 #25 #27）
 */
export type RoundIconVariant = "mic" | "send" | "stop" | "send-muted" | "plus" | "scroll-down"

export interface RoundIconButtonProps extends ComponentProps<"button"> {
  variant: RoundIconVariant
  /**
   * 直径：md = --cw-round-btn / --cw-plus-btn（26，默认）；sm = --cw-round-btn-sm（22，#22 发送钮）；
   * 数字 = CSS px（例如 #22 PillComposer 的 plus 20.4）。
   */
  size?: "md" | "sm" | number
  /** 替换默认图标 */
  icon?: ReactNode
  forced?: Forced
}

type Tone = "black" | "light" | "muted" | "outline"

const TONE_OF: Record<RoundIconVariant, Tone> = {
  mic: "black",
  send: "black",
  stop: "black",
  "send-muted": "muted",
  plus: "light",
  "scroll-down": "outline",
}

const TONE: Record<Tone, string> = {
  black:
    "bg-(--cw-primary) text-(--cw-primary-fg) hover:bg-(--cw-primary)/85 data-[forced=hover]:bg-(--cw-primary)/85 active:bg-(--cw-primary)/70 data-[forced=pressed]:bg-(--cw-primary)/70",
  light:
    "bg-(--cw-plus-btn-bg) text-(--cw-icon-fg) hover:bg-(--cw-row-selected) data-[forced=hover]:bg-(--cw-row-selected) active:bg-(--cw-border) data-[forced=pressed]:bg-(--cw-border)",
  muted:
    "bg-(--cw-plus-btn-bg) text-(--cw-text-4) hover:bg-(--cw-row-selected) data-[forced=hover]:bg-(--cw-row-selected) active:bg-(--cw-border) data-[forced=pressed]:bg-(--cw-border)",
  outline:
    "border border-solid border-(--cw-border) bg-(--cw-surface) text-(--cw-text-2) shadow-(--cw-shadow-float) hover:bg-(--cw-row-hover) data-[forced=hover]:bg-(--cw-row-hover) active:bg-(--cw-row-selected) data-[forced=pressed]:bg-(--cw-row-selected)",
}

const LABEL: Record<RoundIconVariant, string> = {
  mic: "Voice input",
  send: "Send",
  stop: "Stop",
  "send-muted": "Send",
  plus: "Add",
  "scroll-down": "Scroll to bottom",
}

function defaultIcon(variant: RoundIconVariant): ReactNode {
  switch (variant) {
    case "mic":
      return <Mic aria-hidden size={13} strokeWidth={2} />
    case "send":
      return <ArrowUp aria-hidden size={14} strokeWidth={2.5} />
    case "send-muted":
      return <ArrowUp aria-hidden size={14} strokeWidth={2} />
    case "stop":
      // 白色圆角实心方块 ≈ 9×9、圆角 2（specs/ch4 §0.4，证据 #28）
      return <span aria-hidden className="block size-[9px] rounded-[2px] bg-current" />
    case "plus":
      return <Plus aria-hidden size={14} strokeWidth={1.5} />
    case "scroll-down":
      return <ArrowDown aria-hidden size={14} strokeWidth={1.5} />
  }
}

/** composer 与流底部的圆形图标钮。尺寸默认取 token，屏幕可用 size 覆盖。 */
export function RoundIconButton({
  variant,
  size = "md",
  icon,
  forced,
  className,
  style,
  type = "button",
  "aria-label": ariaLabel,
  ...rest
}: RoundIconButtonProps) {
  const sizeClass =
    typeof size === "number"
      ? undefined
      : size === "sm"
        ? "size-(--cw-round-btn-sm)"
        : variant === "plus"
          ? "size-(--cw-plus-btn)"
          : "size-(--cw-round-btn)"
  const sizeStyle: CSSProperties | undefined = typeof size === "number" ? { width: size, height: size } : undefined
  return (
    <button
      data-slot="round-icon-button"
      data-variant={variant}
      data-forced={forced}
      type={type}
      aria-label={ariaLabel ?? LABEL[variant]}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-(--cw-radius-pill) select-none disabled:opacity-50",
        TONE[TONE_OF[variant]],
        sizeClass,
        focusRing,
        className,
      )}
      style={sizeStyle ? { ...sizeStyle, ...style } : style}
      {...rest}
    >
      {icon ?? defaultIcon(variant)}
    </button>
  )
}
