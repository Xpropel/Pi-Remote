/**
 * 手机端设置 · 独立系统契约（纯类型 / 常量，无 React、无 DOM）。
 *
 * 设计源：设置页 v2 设计规格（手机端）
 * + 设计文档「变体与手机端」。
 *
 * 13 个界面 = 设置首页（列表入口）+ 十一页与桌面同名内容 + 手机专属「交互」。
 * 桌面与手机是两个系统：这里不出现桌面左栏，也不把桌面设置页挤窄。
 * 页面状态沿用桌面口径：● existing / ○ local / ◐ bridge / ◌ reserved。
 *
 * 边界：本文件只被 settings/mobile/** 与 node --test 直载；不 import React / relay。
 */
import { SETTINGS_PAGE_IDS, SETTINGS_PAGE_META, type SettingsPageId, type SettingsStyle } from "../types.ts"
import { PI_MOBILE_NAV_DEFAULT, PI_MOBILE_NAV_MODES, type PiMobileNavMode } from "../../mobile/types.ts"

/* ------------------------------------------------------------------ */
/* 13 页 IA                                                            */
/* ------------------------------------------------------------------ */

/** 首页与手机专属「交互」的页 id；其余 11 页复用桌面 id。 */
export const MOBILE_ONLY_PAGE_IDS = ["index", "interaction"] as const
export type MobileSettingsPageId = "index" | "interaction" | SettingsPageId

/** 首页列表的全部入口（12 个目标 → 12 个内容界面）。 */
export const MOBILE_SETTINGS_DESTINATIONS = [...SETTINGS_PAGE_IDS, "interaction"] as const
export type MobileSettingsDestination = (typeof MOBILE_SETTINGS_DESTINATIONS)[number]

/** 13 个界面：index + 11 内容页 + interaction。 */
export const MOBILE_SETTINGS_PAGE_IDS = ["index", ...SETTINGS_PAGE_IDS, "interaction"] as const

/** 页标题逐字照手机稿：首页 =「设置」，其余与桌面同名。 */
export const MOBILE_SETTINGS_PAGE_LABELS: Record<MobileSettingsPageId, string> = {
  index: "设置",
  interaction: "交互",
  ...(Object.fromEntries(SETTINGS_PAGE_IDS.map((id) => [id, SETTINGS_PAGE_META[id].label])) as Record<
    SettingsPageId,
    string
  >),
}

export function isMobileSettingsPageId(value: unknown): value is MobileSettingsPageId {
  return typeof value === "string" && (MOBILE_SETTINGS_PAGE_IDS as readonly string[]).includes(value)
}

/** 任意值 → 合法手机页 id；坏值回落首页（返回键 / 深链 / 测试都走这里）。 */
export function mobilePageIdOf(value: unknown): MobileSettingsPageId {
  return isMobileSettingsPageId(value) ? value : "index"
}

/** 只接受 11 个桌面同名内容页；首页 / 交互返回 null。 */
export function mobileContentPageOf(value: unknown): SettingsPageId | null {
  return value === "index" || value === "interaction" ? null : isMobileSettingsPageId(value) ? (value as SettingsPageId) : null
}

/* ------------------------------------------------------------------ */
/* 首页列表分组（照 board-mobile.png 的三张卡 + 移动端组）             */
/* ------------------------------------------------------------------ */

export interface MobileIndexGroup {
  id: "mobile" | "session" | "experience" | "data"
  /** 只有第一组画分组标题；其余卡片直接续排。 */
  label?: string
  entries: readonly MobileSettingsDestination[]
}

export const MOBILE_INDEX_GROUPS: readonly MobileIndexGroup[] = [
  { id: "mobile", label: "移动端", entries: ["interaction"] },
  { id: "session", entries: ["general", "model", "approval", "extensions"] },
  { id: "experience", entries: ["appearance", "devices", "notifications", "shortcuts", "privacy"] },
  { id: "data", entries: ["usage", "about"] },
] as const

/** 首页 12 个入口（不得重复、不得漏页）；测试用它守住入口。 */
export const MOBILE_INDEX_ENTRIES: readonly MobileSettingsDestination[] = MOBILE_INDEX_GROUPS.flatMap(
  (group) => group.entries,
)

/* ------------------------------------------------------------------ */
/* 手机几何 / 文案                                                     */
/* ------------------------------------------------------------------ */

export const MOBILE_SETTINGS_METRICS = {
  /** 单列全宽，不设内容列宽。 */
  singleColumn: true,
  /** 触控行高下限（设计口径 ≥44）。 */
  touchMin: 44,
  topBarH: 54,
  rowMinH: 48,
  cardRadius: 14,
  contentPaddingX: 16,
  /** 底部安全区：优先 env(safe-area-inset-bottom)，CSS 回退值。 */
  safeAreaBottom: 30,
  /** 使用活动热力图只显示近 26 周（桌面 52 周）。 */
  heatmapWeeks: 26,
} as const

export const MOBILE_SETTINGS_COPY = {
  back: "返回",
  exit: "退出设置",
  heatmapWeeksNote: "按屏幕宽度显示近 26 周",
  appearanceFootnote: "切换立即应用到整个界面。",
  interactionFootnote: "切换后立即生效，仅影响移动端。",
  shortcutsFootnote: "以下键位在外接键盘时可用；点按任意一行即可改键。",
  privacyFootnote: "Pi-Remote 只是把设备上的会话镜像到你的浏览器，中转服务器不保存会话内容。",
  notificationsFootnote: "暂仅支持应用内提醒；离开页面时不会推送。",
  reservedFootnote: "带「设计预留」的项只保留形态，暂不可用。",
} as const

/* ------------------------------------------------------------------ */
/* 移动端交互（复用桌面同源的 mobileNav 偏好）                         */
/* ------------------------------------------------------------------ */

export const MOBILE_NAV_DEFAULT: PiMobileNavMode = PI_MOBILE_NAV_DEFAULT
export const MOBILE_NAV_MODES = PI_MOBILE_NAV_MODES

/** 手机端六皮肤与桌面同源：只换颜色令牌，结构不动。 */
export const MOBILE_SKIN_STYLES: readonly SettingsStyle[] = ["cursor", "claude", "codex"]
