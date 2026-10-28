import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

export type KbdHintSize = "xs" | "sm" | "md"
export type KbdHintTone = "faint" | "muted"

export interface KbdHintProps extends ComponentProps<"span"> {
  /** 快捷键原文，字符之间不加空格：'⌘N'、'⌘D'、'⇧⌘E'、'⇧Tab'。也可以直接写 children。 */
  keys?: string
  /**
   * 字号：xs 11px（侧栏 New Agent 的 ⌘N，#1）、sm 12px（菜单行尾 ⌘D / ⇧⌘E，#5）、
   * md 13px（建议 pill 里的 ⇧Tab，#16 #17）。不填时继承所在行字号。
   */
  size?: KbdHintSize
  /** faint = --cw-text-4（侧栏、pill，默认）；muted = --cw-text-3（菜单行尾快捷键） */
  tone?: KbdHintTone
}

const SIZE: Record<KbdHintSize, string> = {
  xs: "text-(length:--cw-text-xs)",
  sm: "text-(length:--cw-text-sm)",
  md: "text-(length:--cw-text-md)",
}

/** 淡灰快捷键文字。用 SF Pro 自带的 ⌘ ⇧ 字形，不画键帽（键帽组是 ch1 的 KeycapGroup）。 */
export function KbdHint({ keys, size, tone = "faint", className, children, ...rest }: KbdHintProps) {
  return (
    <span
      data-slot="kbd-hint"
      className={cn(
        "inline-flex shrink-0 items-center font-normal whitespace-nowrap",
        tone === "faint" ? "text-(--cw-text-4)" : "text-(--cw-text-3)",
        size && SIZE[size],
        className,
      )}
      {...rest}
    >
      {children ?? keys}
    </span>
  )
}
