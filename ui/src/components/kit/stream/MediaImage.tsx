import type { ComponentPropsWithoutRef } from "react"
import { cn } from "@/lib/utils"
import { STREAM_CARD_GAP, STREAM_INSET } from "./styles"

export interface MediaImageProps extends ComponentPropsWithoutRef<"div"> {
  /**
   * 占位内容。screenshot = 浅色网页界面 + 底部深色 dock 条（#14 #25 #26 #27 的 demo 截图，specs/ch5 §3.3 C）；
   * plain = 纯浅灰块。传 children 时不画占位。
   */
  placeholder?: "screenshot" | "plain"
}

/**
 * 回复里内嵌的截图：圆角 + 1px 深色描边。默认宽高比 16:10，屏幕可用 className（aspect-auto + 高度）或 style 覆盖。
 * 内容一律中性占位（plan 决策 9），不贴位图。
 */
export function MediaImage({ placeholder = "screenshot", className, children, ...rest }: MediaImageProps) {
  return (
    <div
      className={cn(
        STREAM_INSET,
        STREAM_CARD_GAP,
        "relative aspect-[16/10] overflow-hidden rounded-(--cw-radius-card) border border-(--cw-text-2) bg-(--cw-bg)",
        className,
      )}
      {...rest}
    >
      {children ?? (placeholder === "screenshot" ? <ScreenshotPlaceholder /> : <div data-cw-placeholder="media" className="absolute inset-0 bg-(--cw-sidebar-bg)" />)}
    </div>
  )
}

function ScreenshotPlaceholder() {
  return (
    <div data-cw-placeholder="media" className="absolute inset-0 flex flex-col">
      {/* 浅色网页：左侧浅灰导航 + 中间几块白卡 */}
      <div className="flex min-h-0 flex-1">
        <div className="w-[18%] space-y-[5%] border-r border-(--cw-divider) bg-(--cw-sidebar-bg) p-[2.5%]">
          <div className="h-[3%] min-h-1 w-4/5 rounded-full bg-(--cw-border)" />
          <div className="h-[3%] min-h-1 w-3/5 rounded-full bg-(--cw-border)" />
          <div className="h-[3%] min-h-1 w-2/3 rounded-full bg-(--cw-border)" />
          <div className="h-[3%] min-h-1 w-1/2 rounded-full bg-(--cw-border)" />
        </div>
        <div className="flex flex-1 flex-col gap-[4%] p-[4%]">
          <div className="h-[6%] min-h-1 w-2/5 rounded-full bg-(--cw-divider)" />
          <div className="flex-1 rounded-(--cw-radius-xs) border border-(--cw-divider) bg-(--cw-surface)" />
          <div className="flex-1 rounded-(--cw-radius-xs) border border-(--cw-divider) bg-(--cw-surface)" />
          <div className="flex-[0.6] rounded-(--cw-radius-xs) border border-(--cw-divider) bg-(--cw-surface)" />
        </div>
      </div>
      {/* 底部深色桌面条 + 居中 3 个 dock 小方块 */}
      <div className="flex h-[7%] min-h-2 items-center justify-center gap-[0.8%] bg-linear-to-r from-(--cw-primary) to-(--cw-text-2)">
        <span className="aspect-square h-[55%] rounded-[2px] bg-(--cw-text-3)" />
        <span className="aspect-square h-[55%] rounded-[2px] bg-(--cw-text-4)" />
        <span className="aspect-square h-[55%] rounded-[2px] bg-(--cw-text-3)" />
      </div>
    </div>
  )
}
