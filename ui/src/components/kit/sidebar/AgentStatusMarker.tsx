import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"
import { Cloud, GitMerge, GitPullRequest, GitPullRequestDraft, KitIcon, Pin } from "@/components/kit/icons"
import { Spinner } from "@/components/kit/controls/Spinner"

/**
 * 行首 / 行尾状态标记（plan §5.1 + specs/ch1 §1.8）：
 * - fork-cyan：git-pull-request 青绿 = 本地 / worktree
 * - fork-gray：git-pull-request-draft 浅灰（ch1 新增；#1 #3 #5 #28 #29 的「浅灰 fork」）
 * - fork-purple：git-merge 紫 = subagent
 * - spinner：浅灰环 + 深一级的弧 = 运行中
 * - hollow-circle：空心圆 = 待处理（#28 #29）
 * - dot-gray：6px 灰点 = 待处理；dot-blue：7px 蓝点 = 未读
 * - pin：hover 行首的图钉（旋转 45°）
 * - cloud：行尾淡灰云朵 = 云端
 * - time：行尾相对时间文字（"10h"、"5h"、"1d"）
 */
export const AGENT_STATUS_MARKERS = [
  "fork-cyan",
  "fork-gray",
  "fork-purple",
  "spinner",
  "hollow-circle",
  "dot-gray",
  "dot-blue",
  "pin",
  "cloud",
  "time",
] as const

export type AgentStatusMarkerVariant = (typeof AGENT_STATUS_MARKERS)[number]

export interface AgentStatusMarkerProps extends ComponentProps<"span"> {
  variant: AgentStatusMarkerVariant
  /** time 变体的文字；其他变体忽略 */
  time?: string
  /** time 变体用等宽数字（默认 true，现状）；false = 比例数字（#6，kit-requests ch2 #12） */
  tabularTime?: boolean
}

/** 图形标记都放在 14px 盒里居中（行首列 16px，中心对齐行图标列） */
export function AgentStatusMarker({ variant, time, tabularTime = true, className, ...rest }: AgentStatusMarkerProps) {
  if (variant === "time") {
    return (
      <span
        data-slot="agent-status-marker"
        data-marker="time"
        className={cn(
          "shrink-0 text-(length:--cw-text-sm) leading-(--cw-leading-sm) whitespace-nowrap text-(--cw-text-4)",
          tabularTime && "tabular-nums",
          className,
        )}
        {...rest}
      >
        {time}
      </span>
    )
  }
  return (
    <span
      data-slot="agent-status-marker"
      data-marker={variant}
      aria-hidden
      className={cn("relative inline-flex size-3.5 shrink-0 items-center justify-center", className)}
      {...rest}
    >
      <Glyph variant={variant} />
    </span>
  )
}

function Glyph({ variant }: { variant: Exclude<AgentStatusMarkerVariant, "time"> }) {
  switch (variant) {
    case "fork-cyan":
      return <KitIcon icon={GitPullRequest} size={14} className="text-(--cw-status-local)" />
    case "fork-gray":
      return <KitIcon icon={GitPullRequestDraft} size={14} className="text-(--cw-status-pending)" />
    case "fork-purple":
      return <KitIcon icon={GitMerge} size={14} className="text-(--cw-status-subagent)" />
    case "spinner":
      // 浅灰轨道环 + kit Spinner 的短弧；rotate 180° 让冻结动画时弧停在左下（#1 #21 放大图）
      return (
        <>
          <span className="absolute size-[13px] rounded-full border-[1.5px] border-(--cw-icon-muted)" />
          <Spinner size={13} tone="muted" arc={0.3} label="Running" className="relative" style={{ rotate: "180deg" }} />
        </>
      )
    case "hollow-circle":
      return <span className="size-3 rounded-full border-[1.5px] border-(--cw-status-idle-ring)" />
    case "dot-gray":
      return <span className="size-1.5 rounded-full bg-(--cw-status-pending)" />
    case "dot-blue":
      return <span className="size-[7px] rounded-full bg-(--cw-status-unread)" />
    case "pin":
      return <KitIcon icon={Pin} size={14} className="rotate-45 text-(--cw-icon-fg)" />
    case "cloud":
      return <KitIcon icon={Cloud} size={14} strokeWidth={1.25} className="text-(--cw-icon-muted)" />
  }
}
