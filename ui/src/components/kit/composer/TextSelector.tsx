import type { ComponentProps, ReactNode } from "react"
import type { Forced } from "@/components/kit/types"
import { ChevronDown } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { focusRing } from "../controls/shared"

/** primary = --cw-text-2（仓库段、empty composer 里的模型名）；secondary = --cw-text-3（分支 / 环境段、followup 里的模型名） */
export type TextSelectorTone = "primary" | "secondary"

/** sm = 12px（#22 High Fast）；md = 13px（默认，--cw-text-md）；lg = 14px（#20 约 5× 放大帧） */
export type TextSelectorSize = "sm" | "md" | "lg"

export interface TextSelectorProps extends ComponentProps<"button"> {
  /** 前置图标（☁ Cloud、This Mac 的 laptop、Local）：14px、线宽 1.5，颜色跟随文字，与文字间距 4 */
  icon?: ReactNode
  /** 主文案（也可以写成 children）。都不传 = 纯图标选择器（#19 环境段只有 ☁ ∨） */
  label?: ReactNode
  /** 主文案后的小图标：模型名后的 lucide brain（#1 #19 #21），11px --cw-text-3 */
  badge?: ReactNode
  /** 双色文案的第二段，浅一级（--cw-text-3）："1M Max"（#16）、"Medium 1M"（#19）、"Fast"（#1 #21） */
  detail?: ReactNode
  /** detail 字号：md = 与主文案同号（#16，默认）；sm = --cw-text-xs 11px（#1 #19 #21） */
  detailSize?: "md" | "sm"
  tone?: TextSelectorTone
  size?: TextSelectorSize
  /**
   * 静态打开态（帧里菜单已打开、但菜单由屏幕另画时用）。作为 Radix 菜单触发器时
   * data-state=open 会自动生效，不用传。
   */
  open?: boolean
  /** 显示 ∨（默认 true；纯展示的状态文字可关掉） */
  chevron?: boolean
  forced?: Forced
}

const SIZE: Record<TextSelectorSize, { text: string; icon: string; badge: string; chevron: string }> = {
  sm: {
    text: "text-(length:--cw-text-sm)",
    icon: "[&>svg]:size-[13px]",
    badge: "[&>svg]:size-[10px]",
    chevron: "size-3",
  },
  md: {
    text: "text-(length:--cw-text-md)",
    icon: "[&>svg]:size-(--cw-icon-size-sm)",
    badge: "[&>svg]:size-[11px]",
    // spec 写 12px；#16 #17 #18 三张清晰帧量到的墨迹宽 7.5–8.4 CSS px，13px 的 chevron-down（墨迹 ≈ 7.3）更接近
    chevron: "size-[13px]",
  },
  lg: {
    text: "text-(length:--cw-text-base)",
    icon: "[&>svg]:size-[15px]",
    badge: "[&>svg]:size-3",
    chevron: "size-3.5",
  },
}

/**
 * 主文案色 + 「激活」（hover / 打开 / 强制）时深一级（ch4 spec §0.4：hover 推断为文字变深、不加底色；
 * #18 打开中的仓库段近黑 --cw-text，#17 打开中的环境段 #666668 ≈ --cw-text-2）。
 */
const TONE: Record<TextSelectorTone, string> = {
  primary:
    "text-(--cw-text-2) hover:text-(--cw-text) data-[state=open]:text-(--cw-text) data-[open]:text-(--cw-text) data-[forced=hover]:text-(--cw-text) data-[forced=pressed]:text-(--cw-text)",
  secondary:
    "text-(--cw-text-3) hover:text-(--cw-text-2) data-[state=open]:text-(--cw-text-2) data-[open]:text-(--cw-text-2) data-[forced=hover]:text-(--cw-text-2) data-[forced=pressed]:text-(--cw-text-2)",
}

/** ∨ 激活时变成 --cw-text（#17 打开中的环境段 ∨ 实测 #0A0F0F） */
const CHEVRON_ACTIVE =
  "group-hover/text-selector:text-(--cw-text) group-data-[state=open]/text-selector:text-(--cw-text) group-data-[open]/text-selector:text-(--cw-text) group-data-[forced=hover]/text-selector:text-(--cw-text) group-data-[forced=pressed]/text-selector:text-(--cw-text)"

/**
 * 文字 + ∨ 的选择器，从不画框（run-brief 第 8 条）。用于 composer 上方的仓库 / 分支 / 环境段、
 * composer 里的模型 / 档位选择器。根节点是 <button>，可直接当 Radix 菜单触发器（asChild）。
 */
export function TextSelector({
  icon,
  label,
  badge,
  detail,
  detailSize = "md",
  tone = "primary",
  size = "md",
  open,
  chevron = true,
  forced,
  className,
  type = "button",
  children,
  ...rest
}: TextSelectorProps) {
  const s = SIZE[size]
  const text = label ?? children
  const iconOnly = text == null && badge == null && detail == null
  // ∨ 的底色：有浅色第二段或本身是浅色段时取 --cw-text-3（#16 模型 ∨ #7A7A7A），否则跟随主文案（#16 仓库段 ∨ #535152）
  const chevronTone = detail != null || tone === "secondary" ? "text-(--cw-text-3)" : undefined
  return (
    <button
      type={type}
      data-slot="text-selector"
      data-tone={tone}
      data-open={open ? "" : undefined}
      data-forced={forced}
      className={cn(
        "group/text-selector inline-flex max-w-full min-w-0 shrink-0 items-center gap-1 rounded-(--cw-radius-xs) border-0 bg-transparent p-0 [font-family:inherit] leading-(--cw-leading-tight) font-normal whitespace-nowrap select-none disabled:opacity-50",
        s.text,
        TONE[tone],
        focusRing,
        className,
      )}
      {...rest}
    >
      {icon != null && (
        <span data-slot="text-selector-icon" className={cn("inline-flex shrink-0 items-center [&>svg]:stroke-[1.5]", s.icon)}>
          {icon}
        </span>
      )}
      {text != null && (
        <span data-slot="text-selector-label" className="min-w-0 truncate">
          {text}
        </span>
      )}
      {badge != null && (
        <span
          data-slot="text-selector-badge"
          className={cn("inline-flex shrink-0 items-center text-(--cw-text-3) [&>svg]:stroke-[1.5]", s.badge)}
        >
          {badge}
        </span>
      )}
      {detail != null && (
        <span
          data-slot="text-selector-detail"
          className={cn("shrink-0 text-(--cw-text-3)", detailSize === "sm" && "text-(length:--cw-text-xs)")}
        >
          {detail}
        </span>
      )}
      {chevron && (
        <ChevronDown
          aria-hidden
          strokeWidth={1.5}
          // 文字到 ∨ 的墨迹间距 ≈ 5px（chevron 盒内左缩 ≈ 3px），所以盒间距只留 2px；纯图标时再收 2px（#19 ☁∨ 几乎贴着）
          className={cn("shrink-0", iconOnly ? "-ml-1" : "-ml-0.5", s.chevron, chevronTone, CHEVRON_ACTIVE)}
        />
      )}
    </button>
  )
}
