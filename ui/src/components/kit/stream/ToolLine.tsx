import type { ComponentPropsWithoutRef, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { STREAM_INSET, STREAM_LINE_GAP, STREAM_TEXT } from "./styles"

export interface ToolLineProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** 动词："Read"、"Explored"、"Grep"、"Processed"、进行中的 "Exploring" */
  verb: ReactNode
  /** 宾语："app.js L1-92"、"1 file, 1 search"、"screen recording" */
  detail?: ReactNode
  /**
   * default：动词深（--cw-text-2）+ 宾语浅（--cw-text-3）（#8 #10 #28）；
   * reverse：动词浅 + 宾语深（只在 #6 渲染样机的 "Grep streaming + tool-call interleave"）。
   */
  tone?: "default" | "reverse"
  /** 进行中（#28 "Exploring"）。帧里没有动效证据，只加 data-state/aria-busy，不画动画。 */
  running?: boolean
}

/** 轻工具行：一行两档灰，无图标无框（run-brief ⑥：light = one gray line）。 */
export function ToolLine({ verb, detail, tone = "default", running, className, ...rest }: ToolLineProps) {
  const strong = "text-(--cw-text-2)"
  const muted = "text-(--cw-text-3)"
  return (
    <div
      data-state={running ? "running" : "done"}
      aria-busy={running || undefined}
      className={cn(STREAM_TEXT, STREAM_INSET, STREAM_LINE_GAP, "truncate", className)}
      {...rest}
    >
      <span className={tone === "default" ? strong : muted}>{verb}</span>
      {detail != null && (
        <>
          {" "}
          <span className={tone === "default" ? muted : strong}>{detail}</span>
        </>
      )}
    </div>
  )
}
