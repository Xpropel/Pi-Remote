/**
 * c 区共用的 class 片段与尺寸。Pi 变量（--cw-pi-*）由 a 区的 shared/pi-theme.css 定义；这里都带 kit token 兜底，
 * 主题 CSS 没加载时也能看。
 */
import type { PiLayout } from "@/components/pi/shared/viewport"

export type CVariant = "desktop" | "phone"

export function variantOf(viewport: PiLayout): CVariant {
  return viewport === "phone" ? "phone" : "desktop"
}

/** 需要读的灰字（design §4.6：比 --cw-text-3 深一档，推断） */
export const C_SECONDARY = "text-[color:var(--cw-pi-text-secondary,var(--cw-text-3))]"

/** 出错红字（= --cw-red，§1.4） */
export const C_ERROR = "text-[color:var(--cw-pi-error,var(--cw-red))]"

/** 手机最小点击区：视觉小、点击区 ≥ 44（§4.4）。给按钮加一圈看不见的扩展区 */
export const TOUCH_44 =
  "relative after:absolute after:top-1/2 after:left-1/2 after:h-11 after:min-w-11 after:w-[calc(100%+16px)] after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"

/*
 * P6.3（R2/device-checklist E10 / E12，design §4.4「相邻目标至少隔 8」）：composer 里挤在一起的几颗钮，点击区按邻居的间距收窄，互不重叠。
 * 都只改看不见的 ::after，视觉不变（L1 / L2 像素不变）。
 */
/** 正好 44×44、居中（composer 的 + 32、裸停止 32：左右各外扩 6，和隔 10 / 12 的邻居相接不重叠） */
export const TOUCH_44_BOX =
  "relative after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
/** composer 里的模型选择器：高 44 居中，左外扩 6（两层时左邻 + 隔 12）、右外扩 4（单行时右邻黑圆钮 / 裸停止隔 10），不够 44 宽时向右补足 */
export const TOUCH_44_SELECTOR =
  "relative after:absolute after:top-1/2 after:-right-1 after:-left-1.5 after:h-11 after:min-w-11 after:-translate-y-1/2 after:content-['']"
/**
 * 框下状态行里的钮（投递选择器，design §4.4 M-11）：44 高的点击区只向下外扩（上沿 = 钮的上沿，离 composer 胶囊 ≥ 8，不压它的点击区），
 * 左右各外扩 8；向下伸进底部安全区（键盘开着时状态行收起，不涉及）
 */
export const TOUCH_44_DOWN =
  "relative after:absolute after:top-0 after:left-1/2 after:h-11 after:min-w-11 after:w-[calc(100%+16px)] after:-translate-x-1/2 after:content-['']"

/** 手机输入框固定 16px（防 iOS 聚焦放大，§4.2 第 8 条）；桌面 14 */
export function inputText(variant: CVariant): string {
  return variant === "phone" ? "text-[16px] leading-[22px]" : "text-(length:--cw-text-base) leading-(--cw-leading-base)"
}

/** 菜单 / sheet 行高（§3.5：桌面 slash / @ 菜单行 32；手机 48） */
export function menuRowH(variant: CVariant): string {
  return variant === "phone" ? "min-h-12" : "min-h-8"
}

/** 手机行字号：主文 15、副文 13（§4.6 手机 token：md 15 / sm 13） */
export function rowText(variant: CVariant): { main: string; sub: string } {
  return variant === "phone"
    ? { main: "text-[15px] leading-[20px]", sub: "text-[13px] leading-[18px]" }
    : { main: "text-(length:--cw-text-md) leading-(--cw-leading-tight)", sub: "text-(length:--cw-text-sm) leading-(--cw-leading-sm)" }
}

/** 分段选择（思考级别、主题、工具显示）：浅灰轨道 + 白色选中块（推断：Cursor 帧里没有分段控件） */
export const SEGMENT_TRACK = "flex min-w-0 items-stretch rounded-[8px] bg-(--cw-chip-bg) p-[2px]"
export const SEGMENT_ITEM =
  "flex min-w-0 flex-1 items-center justify-center rounded-[6px] px-2 text-(--cw-text-2) select-none whitespace-nowrap"
export const SEGMENT_ON = "bg-(--cw-surface) text-(--cw-text) font-(--cw-weight-medium) shadow-(--cw-shadow-float)"
/** 分段轨道高度：桌面 28；手机 44（§4.4 sheet / 菜单里的控件 ≥ 44） */
export function segmentTrackH(variant: CVariant): string {
  return variant === "phone" ? "h-11" : "h-7"
}
/** 手机分段项：视觉 40（轨道内距 2），点击区上下外扩 2 到满轨道 44 */
export const SEGMENT_ITEM_PHONE = "relative text-[14px] after:absolute after:inset-x-0 after:-inset-y-[2px] after:content-['']"
/** 费用警告文字（全产品唯一的橙色）：Pi 的 --cw-pi-warning（a 区加），没加载时用 #8A6516（白底 5.31:1，色相同 --cw-orange；v1.2 D-03） */
export const C_WARNING = "text-[color:var(--cw-pi-warning,#8A6516)]"
/** 模型说明卡（ch4/ModelExplainerCard）的费用行改用 Pi 的警告橙：只在这张卡里重设 --cw-orange（--cw-orange 在白底只有 3.1:1，C5） */
export const C_EXPLAINER_ORANGE = "[--cw-orange:var(--cw-pi-warning,#8A6516)]"
