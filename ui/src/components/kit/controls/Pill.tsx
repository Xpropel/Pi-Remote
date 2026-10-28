import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { DiffStat } from "./DiffStat"
import { KbdHint } from "./KbdHint"
import { focusRing, type Forced } from "./shared"

/**
 * outline     白底 / 透明底 + 1px 细描边的胶囊（Review、Move to Local、Commit & Push、Plan New Idea、Multitask）
 * solid-black 黑底白字胶囊（Set up Agent Demos，#16）
 * soft-gray   浅灰实底、无边胶囊（视频卡的 Play，#7）
 * badge       小号浅灰圆角徽标、不可点（Local、Draft、Anysphere）
 */
export type PillVariant = "outline" | "solid-black" | "soft-gray" | "badge"

export interface PillProps extends ComponentProps<"button"> {
  variant?: PillVariant
  /**
   * outline 的底：surface = 白底（云端动作 pill，#3 #7 #21，默认）；
   * transparent = 透明底（空状态建议 pill，#16 #17：实测与页面同色）。
   */
  fill?: "surface" | "transparent"
  /** 前置图标（lucide 元素，统一成 14px） */
  icon?: ReactNode
  /** 行尾快捷键，例如 '⇧Tab' */
  kbd?: string
  /** 文字后的 DiffStat：+N */
  added?: number | string
  /** 文字后的 DiffStat：-M */
  removed?: number | string
  minusSign?: "-" | "−"
  /** 文字单行截断（屏幕给定宽度或 max-width 时生效）。#4 的中间截断请直接传截好的原文。 */
  truncate?: boolean
  /** 浮在正文上的动作 pill：加 --cw-shadow-float */
  elevated?: boolean
  /** 静态帧里的悬停 / 按下 / 聚焦态 */
  forced?: Forced
}

const BASE =
  "relative inline-flex items-center gap-1.5 whitespace-nowrap select-none text-(length:--cw-text-md) leading-(--cw-leading-tight)"

const VARIANT: Record<PillVariant, string> = {
  outline:
    "h-(--cw-pill-h) rounded-(--cw-radius-pill) border border-solid border-(--cw-border) px-3 font-normal text-(--cw-text-2) hover:bg-(--cw-row-hover) data-[forced=hover]:bg-(--cw-row-hover) active:bg-(--cw-row-selected) data-[forced=pressed]:bg-(--cw-row-selected)",
  "solid-black":
    "h-(--cw-pill-h) rounded-(--cw-radius-pill) bg-(--cw-primary) px-3 font-medium text-(--cw-text-on-primary) hover:bg-(--cw-primary)/90 data-[forced=hover]:bg-(--cw-primary)/90 active:bg-(--cw-primary)/80 data-[forced=pressed]:bg-(--cw-primary)/80",
  "soft-gray":
    "h-(--cw-pill-h) rounded-(--cw-radius-pill) bg-(--cw-chip-bg) px-3 font-semibold text-(--cw-text) hover:bg-(--cw-row-selected) data-[forced=hover]:bg-(--cw-row-selected) active:bg-(--cw-border) data-[forced=pressed]:bg-(--cw-border)",
  // Anysphere 胶囊：圆角 6、左右内距约 6、500（#29）；Local：圆角 6（#5 #12 #13）
  badge:
    "rounded-[6px] bg-(--cw-chip-bg) px-1.5 py-px text-(length:--cw-text-sm) leading-(--cw-leading-sm) font-medium text-(--cw-text-2)",
}

export function Pill({
  variant = "outline",
  fill = "surface",
  icon,
  kbd,
  added,
  removed,
  minusSign,
  truncate,
  elevated,
  forced,
  className,
  children,
  type = "button",
  ...rest
}: PillProps) {
  const cls = cn(
    BASE,
    VARIANT[variant],
    variant === "outline" && (fill === "surface" ? "bg-(--cw-surface)" : "bg-transparent"),
    variant !== "badge" && focusRing,
    // 有前置图标时左内距收窄：#16 黑 pill 图标墨迹距左缘约 10px
    icon != null && variant !== "badge" && "pl-2",
    icon != null && variant === "badge" && "pl-1",
    elevated && "shadow-(--cw-shadow-float)",
    truncate ? "min-w-0 max-w-full shrink" : "shrink-0",
    className,
  )
  const content = (
    <>
      {icon != null && (
        <span data-slot="pill-icon" className="inline-flex shrink-0 items-center [&>svg]:size-(--cw-icon-size-sm)">
          {icon}
        </span>
      )}
      {children != null && <span className={cn(truncate && "min-w-0 truncate")}>{children}</span>}
      {(added != null || removed != null) && <DiffStat added={added} removed={removed} minusSign={minusSign} />}
      {kbd && <KbdHint keys={kbd} className="ml-0.5" />}
    </>
  )

  if (variant === "badge") {
    // 徽标不可点：渲染成 span（data-cw-id 等属性照常透传）
    return (
      <span data-slot="pill" data-variant={variant} className={cls} {...(rest as ComponentProps<"span">)}>
        {content}
      </span>
    )
  }

  return (
    <button data-slot="pill" data-variant={variant} data-forced={forced} type={type} className={cls} {...rest}>
      {content}
    </button>
  )
}
