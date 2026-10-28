import type { ComponentPropsWithoutRef, MouseEvent } from "react"
import type { Forced } from "@/components/kit/types"
import { cn } from "@/lib/utils"
import { CHIP_BASE, CHIP_HEADING } from "./styles"

export interface FileChipProps extends ComponentPropsWithoutRef<"a"> {
  /**
   * blue：浅蓝底（--cw-link-chip-bg，#10 #12 #15 的 2x / 清晰帧）；
   * gray：灰底（--cw-code-chip-bg，#3 #7 #9 视频帧里实测是灰底蓝字，specs/ch2 §0.6）。
   */
  tone?: "blue" | "gray"
  /** 加粗（#10 列表里的 package.json / index.html，#12 列表标题项） */
  bold?: boolean
  /** "heading"：字号 0.9em 跟随外层（#12 列表标题里的大号文件名）；默认 12px */
  size?: "code" | "heading"
  /** 跨行断口：clone = 每段都带内边距和圆角（默认，现状）；slice = 断口两侧无内边距（#12 #25 #27） */
  decoration?: "clone" | "slice"
  /** 静态复现悬停态（下划线，推断） */
  forced?: Forced
}

/**
 * 文件链接 chip：蓝色等宽字 + 浅底，可在字符间折行（#7 "/opt/cursor/artifacts/slash_menu_a / ctions_…"）。
 * 复刻里点击不跳转。
 */
export function FileChip({ tone = "blue", bold, size = "code", decoration = "clone", forced, href = "#", onClick, className, ...rest }: FileChipProps) {
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    onClick?.(e)
  }
  return (
    <a
      href={href}
      onClick={handleClick}
      data-stream-chip=""
      data-forced={forced}
      className={cn(
        CHIP_BASE,
        "cursor-pointer text-(--cw-link) no-underline underline-offset-2 hover:underline data-[forced=hover]:underline",
        tone === "blue" ? "bg-(--cw-link-chip-bg)" : "bg-(--cw-code-chip-bg)",
        bold && "font-(--cw-weight-semibold)",
        size === "heading" && CHIP_HEADING,
        decoration === "slice" && "box-decoration-slice",
        className,
      )}
      {...rest}
    />
  )
}
