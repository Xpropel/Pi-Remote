import type { ComponentPropsWithoutRef } from "react"
import { cn } from "@/lib/utils"
import { STREAM_INSET, STREAM_LINE_GAP, STREAM_TEXT } from "./styles"

export interface ReceiptLineProps extends ComponentPropsWithoutRef<"div"> {
  /**
   * muted：--cw-text-3（tokens.md 记 "Worked for…" 为三级灰；#7 #9 #23 #24）；
   * strong：--cw-text-2（specs/ch1 #1 "Worked for 39s" 实测偏深）。
   */
  tone?: "muted" | "strong"
}

/** 灰字收据行："Worked for 5m 38s"、"Worked 20s"、"Worked"。整行单色、14/21、无图标。 */
export function ReceiptLine({ tone = "muted", className, ...rest }: ReceiptLineProps) {
  return (
    <div
      className={cn(
        STREAM_TEXT,
        STREAM_INSET,
        STREAM_LINE_GAP,
        tone === "muted" ? "text-(--cw-text-3)" : "text-(--cw-text-2)",
        className,
      )}
      {...rest}
    />
  )
}
