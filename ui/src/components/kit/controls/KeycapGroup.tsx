import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

export interface KeycapGroupProps extends ComponentProps<"span"> {
  /** 每颗键帽一个字符，照图顺序："⇧ ⌘ N" → ["⇧", "⌘", "N"]（#4 源图是三颗键帽，文档正文写的 ⌘N 以图为准） */
  keys: string[]
}

/**
 * 方块键帽组（ch1 自有；#4 docsA-agentswindow-1 Actions 面板行尾）。
 * 几何（specs/ch1 §1.11，s 1.15）：每颗 17×17、圆角 4、底 --cw-kbd-bg、11px 字居中、键帽间距 3。
 * 只作显示，不绑定快捷键；单键的淡灰快捷键文字是 kit 的 KbdHint，不画键帽。
 */
export function KeycapGroup({ keys, className, ...rest }: KeycapGroupProps) {
  return (
    <span
      data-slot="keycap-group"
      aria-label={keys.join(" ")}
      className={cn("inline-flex shrink-0 items-center gap-[3px]", className)}
      {...rest}
    >
      {keys.map((key, i) => (
        <kbd
          key={`${key}-${i}`}
          aria-hidden
          className="inline-flex size-[17px] items-center justify-center rounded-[4px] bg-(--cw-kbd-bg) font-(family-name:--cw-font-sans) text-[11px] leading-none font-normal text-(--cw-text-2)"
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
