import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import { ArrowLeft, ArrowRight, PanelLeft, Search } from "@/components/kit/icons"
import { GhostIconButton } from "@/components/kit/controls/GhostIconButton"

export interface SidebarHeaderProps extends ComponentProps<"div"> {
  /**
   * agents：红黄绿 + 侧栏开关 + 搜索（#1 #3 #5 #6 #7 #9 …）；
   * empty：红黄绿 + 侧栏开关 + 右端不可用的 ← →（#2 空状态）。
   */
  variant?: "agents" | "empty"
}

/**
 * 侧栏顶行，与 TitleBar 同高（--cw-titlebar-h），内容中线距顶 18px（#1：钮心 y 51 − 窗口顶 33）。
 * 横向几何（距窗口左缘，#1 poster s=1.02）：首颗钮心 18、侧栏开关中心 96、搜索中心 123。
 */
export function SidebarHeader({ variant = "agents", className, ...rest }: SidebarHeaderProps) {
  return (
    <div
      data-slot="sidebar-header"
      data-variant={variant}
      className={cn(
        "flex h-(--cw-titlebar-h) shrink-0 items-center pb-0.5 pl-[11px]",
        variant === "empty" ? "pr-2.5" : "pr-2",
        className,
      )}
      {...rest}
    >
      <GhostIconButton label="Toggle sidebar" icon={<PanelLeft />} className="ml-0" />
      {variant === "agents" ? (
        <GhostIconButton label="Search" icon={<Search />} className="ml-[3px]" />
      ) : (
        <>
          <GhostIconButton
            label="Back"
            tone="muted"
            aria-disabled
            icon={<ArrowLeft />}
            className="ml-auto hover:bg-transparent hover:text-(--cw-text-4) [&>svg]:size-(--cw-icon-size-sm)"
          />
          <GhostIconButton
            label="Forward"
            tone="muted"
            aria-disabled
            icon={<ArrowRight />}
            className="ml-0.5 hover:bg-transparent hover:text-(--cw-text-4) [&>svg]:size-(--cw-icon-size-sm)"
          />
        </>
      )}
    </div>
  )
}
