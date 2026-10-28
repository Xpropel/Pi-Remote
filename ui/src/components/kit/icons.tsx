/**
 * kit 图标出口（所有 family 与章节都从这里取图标）。
 *
 * 1. 任何 lucide 图标都能按 lucide 的 PascalCase 名直接导入：
 *      import { Cloud, GitPullRequest } from "@/components/kit/icons"
 *    lucide 里没有 Cursor 的品牌图标（Github/Slack/Figma 等在 lucide v1 已删除），品牌位一律用中性占位。
 * 2. 尺寸与线宽默认值见 ICON：Cursor 的线条图标偏细，统一 strokeWidth 1.5（specs 实测 1.25–1.5）。
 *    16px = --cw-icon-size，14px = --cw-icon-size-sm。lucide 的 size 只收数字/长度，不收 var()，
 *    所以这里给数字常量；需要跟 token 走时用 className="size-(--cw-icon-size)"。
 * 3. 自绘图标（lucide 没有同形）用 createLucideIcon 生成，API 与 lucide 图标完全一样。
 */
import { createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react"
import type { ComponentType, CSSProperties } from "react"
import { cn } from "@/lib/utils"

export * from "lucide-react"

export const ICON = {
  /** --cw-icon-size */
  size: 16,
  /** --cw-icon-size-sm */
  sizeSm: 14,
  /** 小号（行尾标记、选择器 ∨） */
  sizeXs: 12,
  /** 默认线宽 */
  stroke: 1.5,
} as const

export type IconComponent = LucideIcon | ComponentType<LucideProps>

export interface KitIconProps extends LucideProps {
  icon: IconComponent
}

/** 统一默认尺寸/线宽的包装：<KitIcon icon={Cloud} size={14} className="text-(--cw-icon-muted)" /> */
export function KitIcon({ icon: C, size = ICON.size, strokeWidth = ICON.stroke, className, ...rest }: KitIconProps) {
  return <C aria-hidden size={size} strokeWidth={strokeWidth} className={cn("shrink-0", className)} {...rest} />
}

/**
 * New Agent / New Chat 行首与 "Set up Agent Demos" 黑 pill 的图标：上边水平的纸飞机三角
 * （倒三角 + 左上到中心一笔）。来源：#1 #2 #16 放大（specs/ch4/i16-pillicon.png），lucide 无同形。
 */
export const AgentPlaneIcon = createLucideIcon("AgentPlane", [
  ["path", { d: "M3 5h18l-9 15.5V11.5z", key: "agent-plane" }],
])

/**
 * Cursor logo 的中性占位（简报要求：不搬运 Cursor 的 logo）。圆角方块 + 斜切线，颜色跟随 currentColor。
 */
export function LogoPlaceholder({
  size = 16,
  className,
  style,
  title = "logo placeholder",
}: {
  size?: number
  className?: string
  style?: CSSProperties
  title?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className={cn("shrink-0", className)}
      style={style}
      role="img"
      aria-label={title}
      data-cw-placeholder="logo"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M8 16 16 8" />
    </svg>
  )
}
