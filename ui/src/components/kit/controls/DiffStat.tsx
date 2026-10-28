import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

export interface DiffStatProps extends ComponentProps<"span"> {
  /** 增行数，渲染为绿色 "+N"；不填就不显示 */
  added?: number | string
  /** 删行数，渲染为红色 "-M"；不填就不显示（"只有 +N" 的态） */
  removed?: number | string
  /**
   * 减号字形。#3 #5 #7 的图上是短横（specs/ch1 按图写 "-"，默认）；
   * #6 #21 的规格写作 "−"（U+2212），需要时传 "−"。
   */
  minusSign?: "-" | "−"
}

/** "+N" 绿 / "-M" 红。字号、字重继承所在行。 */
export function DiffStat({ added, removed, minusSign = "-", className, ...rest }: DiffStatProps) {
  return (
    <span
      data-slot="diff-stat"
      className={cn("inline-flex shrink-0 items-baseline gap-(--cw-space-1) whitespace-nowrap", className)}
      {...rest}
    >
      {added != null && <span className="text-(--cw-green)">+{added}</span>}
      {removed != null && (
        <span className="text-(--cw-red)">
          {minusSign}
          {removed}
        </span>
      )}
    </span>
  )
}
