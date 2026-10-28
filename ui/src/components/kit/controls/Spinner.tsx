import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

export interface SpinnerProps extends ComponentProps<"span"> {
  /** 直径（CSS px），默认 12 */
  size?: number
  /** default = --cw-text（#22 框下状态行那颗近黑的）；muted = --cw-status-spinner（侧栏行首运行中，#9 #28） */
  tone?: "default" | "muted"
  /** 线宽（CSS px），默认 1.5 */
  strokeWidth?: number
  /** 弧长占整圆的比例，默认 0.75（缺口朝左上，#22）；半圆传 0.5 */
  arc?: number
  /** 无障碍名称 */
  label?: string
}

/**
 * 弧形加载指示，0.8s 一圈。截图脚本冻结动画后停在起始角度：弧从 12 点顺时针画到 9 点，缺口在左上。
 */
export function Spinner({
  size = 12,
  tone = "default",
  strokeWidth = 1.5,
  arc = 0.75,
  label = "Loading",
  className,
  style,
  ...rest
}: SpinnerProps) {
  // viewBox 固定 24，把 CSS 线宽换算成 viewBox 单位
  const sw = (strokeWidth * 24) / size
  const r = 12 - sw / 2
  const dash = Math.max(0, Math.min(1, arc)) * 100
  return (
    <span
      role="status"
      aria-label={label}
      data-slot="spinner"
      className={cn(
        "inline-block shrink-0 animate-spin",
        tone === "muted" ? "text-(--cw-status-spinner)" : "text-(--cw-text)",
        className,
      )}
      style={{ width: size, height: size, animationDuration: "0.8s", ...style }}
      {...rest}
    >
      <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" aria-hidden className="block">
        <circle
          cx="12"
          cy="12"
          r={r}
          stroke="currentColor"
          strokeWidth={sw}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={`${dash} 100`}
          transform="rotate(-90 12 12)"
        />
      </svg>
    </span>
  )
}
