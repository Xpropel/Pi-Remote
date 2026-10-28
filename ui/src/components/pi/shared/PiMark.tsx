import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { GhostIconButton, type GhostIconButtonProps } from "@/components/kit"
import { LaptopMinimal, Monitor, Server, type IconComponent } from "@/components/kit/icons"

export interface PiMarkProps {
  /** 边长（CSS px），默认 20 */
  size?: number
  className?: string
}

/**
 * 单色品牌标（design K 清单·品牌标志）：圆角方块 + π。浅色黑块白 π，深色反白（跟 --cw-primary / --cw-primary-fg 走）。推断。
 */
export function PiMark({ size = 20, className }: PiMarkProps) {
  const glyph = Math.round(size * 0.64)
  return (
    <span
      role="img"
      aria-label="Pi-Remote"
      data-pi-mark=""
      className={cn("inline-flex shrink-0 items-center justify-center bg-(--cw-primary) text-(--cw-primary-fg)", className)}
      style={{ width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.26)) }}
    >
      <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="none" aria-hidden className="block">
        <path
          d="M4.5 7.5h15M9.2 7.5c0 4.2-.6 7.6-2.4 10.5M15 7.5v8.1c0 1.6.7 2.4 2 2.4.6 0 1.1-.1 1.6-.4"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/** 设备平台 → 图标：darwin / macos → 笔记本；win32 / windows → 显示器；linux → 服务器；其他 → 显示器 */
export function piPlatformIconOf(platform: string | null | undefined): IconComponent {
  const key = (platform || "").trim().toLowerCase()
  if (key === "darwin" || key === "macos" || key === "mac") return LaptopMinimal
  if (key === "linux") return Server
  return Monitor
}

export interface PiPlatformIconProps {
  platform: string
  /** 默认 14 */
  size?: number
  className?: string
}

export function PiPlatformIcon({ platform, size = 14, className }: PiPlatformIconProps) {
  const Icon = piPlatformIconOf(platform)
  return <Icon aria-hidden size={size} strokeWidth={1.5} className={cn("shrink-0 text-(--cw-text-3)", className)} data-pi-platform={platform} />
}

export interface PiIconButtonProps extends Omit<GhostIconButtonProps, "label"> {
  /** 中文无障碍名称（必填，写进 aria-label；design §4.7 v1.2 D-04） */
  label: string
  /** 图标右上角的小角标（例如数字） */
  badge?: ReactNode
}

/** 手机上的图标钮：视觉 20px 图标，点击区 48×48（design §4.4）。基于 kit GhostIconButton */
export function PiIconButton({ badge, className, ...rest }: PiIconButtonProps) {
  return (
    <span className="relative inline-flex shrink-0">
      <GhostIconButton className={cn("size-12 rounded-full text-(--cw-text-2) [&>svg]:size-5", className)} {...rest} />
      {badge != null && (
        <span className="pointer-events-none absolute top-2 right-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--cw-pi-attention) px-1 text-[11px] leading-none font-semibold text-white">
          {badge}
        </span>
      )}
    </span>
  )
}
