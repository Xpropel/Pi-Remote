import type { ComponentPropsWithoutRef } from "react"
import { cn } from "@/lib/utils"
import { CHIP_BASE, CHIP_HEADING } from "./styles"

export interface CodeChipProps extends ComponentPropsWithoutRef<"code"> {
  /** 加粗变体（#5 "Code" 列表里看着偏粗的 chip）；不填时继承外层字重（<strong>、标题里自动变粗） */
  bold?: boolean
  /** "heading"：字号 0.9em 跟随外层（标题、列表标题项里用）；默认 12px（--cw-text-code） */
  size?: "code" | "heading"
  /** 跨行断口：clone = 每段都带内边距和圆角（默认，现状）；slice = 断口两侧无内边距（#12 #25 #27） */
  decoration?: "clone" | "slice"
}

/**
 * 行内代码 chip：浅灰底、深色等宽字、4px 圆角，可在字符间折行（#1 "useGlassApplicati / onProperty"、
 * #9 "## Cursor Cl / oud specific instructions"）。
 */
export function CodeChip({ bold, size = "code", decoration = "clone", className, ...rest }: CodeChipProps) {
  return (
    <code
      data-stream-chip=""
      className={cn(
        CHIP_BASE,
        "bg-(--cw-code-chip-bg) text-(--cw-code-chip-fg)",
        bold && "font-(--cw-weight-semibold)",
        size === "heading" && CHIP_HEADING,
        decoration === "slice" && "box-decoration-slice",
        className,
      )}
      {...rest}
    />
  )
}
