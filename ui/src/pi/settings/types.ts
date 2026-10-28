/**
 * Pi-Remote 设置页 v2 · 共享契约（纯类型 / 常量，无 React、无 DOM、无副作用）。
 *
 * 设计源：设置页 v2 设计规格/
 * - 桌面 11 页（本文件 SETTINGS_PAGE_IDS 是唯一顺序）；
 * - 一套组件 × 六套皮肤（Cursor / Claude / Codex × 深 / 浅），只换颜色令牌；
 * - 页面状态四种：● existing / ○ local / ◐ bridge / ◌ reserved。
 *
 * 边界：页面不得自己写 storage 或拼颜色。偏好经 SettingsActions 写本机存储
 * （pi_remote_pi_settings_v2），主机能力经 PiContainerProps 的 relay / act 调；
 * 视觉只消费 tokens.css 的 --st-*。本文件被第二阶段页面直接 import，只增不改。
 */
import type { PiContainerProps } from "@/pi/containers/types"

/* ------------------------------------------------------------------ */
/* 页面 IA                                                             */
/* ------------------------------------------------------------------ */

/** 桌面设置 11 页；顺序 = 左栏顺序（设计册第 1 节）。 */
export const SETTINGS_PAGE_IDS = [
  "general",
  "model",
  "approval",
  "extensions",
  "appearance",
  "devices",
  "notifications",
  "shortcuts",
  "privacy",
  "usage",
  "about",
] as const

export type SettingsPageId = (typeof SETTINGS_PAGE_IDS)[number]

/** 页面语义分组；左栏仍按 11 行平铺（设计册未画分组标题），分组用于检索 / 埋点 / 后续扩展。 */
export type SettingsPageGroup = "session" | "experience" | "data" | "about"

export const SETTINGS_PAGE_GROUP_LABELS: Record<SettingsPageGroup, string> = {
  session: "会话与能力",
  experience: "本机体验",
  data: "设备与数据",
  about: "关于",
}

/** lucide-react 组件名（组件映射在 ui.tsx；本文件保持可被 node --test 直接加载）。 */
export type SettingsIconName =
  | "SlidersHorizontal"
  | "Cpu"
  | "ShieldCheck"
  | "Puzzle"
  | "Palette"
  | "Monitor"
  | "Bell"
  | "Keyboard"
  | "LockKeyhole"
  | "Activity"
  | "Info"

export interface SettingsPageMeta {
  id: SettingsPageId
  /** 左栏与页标题文案（设计册定稿，不许改写）。 */
  label: string
  icon: SettingsIconName
  group: SettingsPageGroup
  /** 使用活动页例外：内容列 880（其余 692）。 */
  wide?: boolean
}

export const SETTINGS_PAGE_META: Record<SettingsPageId, SettingsPageMeta> = {
  general: { id: "general", label: "通用", icon: "SlidersHorizontal", group: "session" },
  model: { id: "model", label: "模型与会话", icon: "Cpu", group: "session" },
  approval: { id: "approval", label: "审批与执行", icon: "ShieldCheck", group: "session" },
  extensions: { id: "extensions", label: "扩展", icon: "Puzzle", group: "session" },
  appearance: { id: "appearance", label: "外观", icon: "Palette", group: "experience" },
  devices: { id: "devices", label: "设备", icon: "Monitor", group: "data" },
  notifications: { id: "notifications", label: "通知", icon: "Bell", group: "experience" },
  shortcuts: { id: "shortcuts", label: "快捷键", icon: "Keyboard", group: "experience" },
  privacy: { id: "privacy", label: "数据与隐私", icon: "LockKeyhole", group: "data" },
  usage: { id: "usage", label: "使用活动", icon: "Activity", group: "data", wide: true },
  about: { id: "about", label: "关于", icon: "Info", group: "about" },
}

/** 11 页元数据（顺序同左栏）。 */
export const SETTINGS_PAGES: readonly SettingsPageMeta[] = SETTINGS_PAGE_IDS.map((id) => SETTINGS_PAGE_META[id])

export function isSettingsPageId(value: unknown): value is SettingsPageId {
  return typeof value === "string" && (SETTINGS_PAGE_IDS as readonly string[]).includes(value)
}

/** 任意值 → 合法页 id；坏值回落「通用」（从 URL / 存储进来的 id 都走这里）。 */
export function settingsPageIdOf(value: unknown): SettingsPageId {
  return isSettingsPageId(value) ? value : "general"
}

/* ------------------------------------------------------------------ */
/* 皮肤 / 主题                                                         */
/* ------------------------------------------------------------------ */

/** 与 PI_SIDEBAR_STYLES 一一对应；换肤只换 tokens.css 的颜色块。 */
export const SETTINGS_STYLES = ["cursor", "claude", "codex"] as const
export type SettingsStyle = (typeof SETTINGS_STYLES)[number]

/** 实际渲染的明暗（"跟随系统" 在 SettingsPage 外解析成其中之一）。 */
export const SETTINGS_THEMES = ["dark", "light"] as const
export type SettingsTheme = (typeof SETTINGS_THEMES)[number]

/** 外观页可选明暗；system 只是偏好值，渲染前必须解析。 */
export type SettingsThemePref = SettingsTheme | "system"

export function settingsStyleOf(value: unknown): SettingsStyle {
  return typeof value === "string" && (SETTINGS_STYLES as readonly string[]).includes(value) ? (value as SettingsStyle) : "cursor"
}

export function settingsThemeOf(value: unknown): SettingsTheme | null {
  return typeof value === "string" && (SETTINGS_THEMES as readonly string[]).includes(value) ? (value as SettingsTheme) : null
}

export function settingsThemePrefOf(value: unknown): SettingsThemePref {
  return value === "dark" || value === "light" ? value : "system"
}

/** 桌面几何（与 settings.css 的 --st-* 同值；第二阶段页面做布局断言时从这里取）。 */
export const SETTINGS_METRICS = {
  railWidth: 260,
  navRowHeight: 30,
  navIconSize: 15,
  contentWidth: 692,
  contentWidthWide: 880,
  pagePaddingTop: 24,
  pagePaddingX: 34,
} as const

/* ------------------------------------------------------------------ */
/* 落地状态图例                                                        */
/* ------------------------------------------------------------------ */

/**
 * existing = ● 现成桥 / local = ○ 纯本地 / bridge = ◐ 只读可达、写要扩展桥 / reserved = ◌ 设计预留。
 * 徽标只给 bridge 与 reserved 两类（existing/local 不打扰阅读）。
 */
export type SettingsItemStatus = "existing" | "local" | "bridge" | "reserved"

export const SETTINGS_STATUS_BADGE: Partial<Record<SettingsItemStatus, string>> = {
  bridge: "需扩展桥",
  reserved: "设计预留",
}

/** ◐ / ◌ 行都不可写：视觉与 a11y 都由原子组件统一降级。 */
export function settingsItemInert(status: SettingsItemStatus | undefined, disabled = false): boolean {
  return disabled || status === "bridge" || status === "reserved"
}

/* ------------------------------------------------------------------ */
/* 偏好枚举                                                            */
/* ------------------------------------------------------------------ */

export const SETTINGS_START_VIEWS = ["last", "list"] as const
export type SettingsStartView = (typeof SETTINGS_START_VIEWS)[number]

/** 第一期只有简体中文；字段先固定成稳定类型，后续加语言只扩数组。 */
export const SETTINGS_LANGUAGES = ["zh-CN"] as const
export type SettingsLanguage = (typeof SETTINGS_LANGUAGES)[number]

export const SETTINGS_SEND_KEYS = ["enter", "ctrl-enter"] as const
export type SettingsSendKey = (typeof SETTINGS_SEND_KEYS)[number]

export const SETTINGS_AUTO_ARCHIVE = ["never", "7d", "30d"] as const
export type SettingsAutoArchive = (typeof SETTINGS_AUTO_ARCHIVE)[number]

/** settings_set 的投递枚举（与 pi settings.json 同值）；页面写桥在 pages/settingsWrite.ts。 */
export const SETTINGS_DELIVERY_MODES = ["one-at-a-time", "all"] as const
export type SettingsDeliveryMode = (typeof SETTINGS_DELIVERY_MODES)[number]

export const SETTINGS_ACCENTS = ["violet", "blue", "clay", "green", "graphite"] as const
export type SettingsAccent = (typeof SETTINGS_ACCENTS)[number]
export const SETTINGS_ACCENT_LABELS: Record<SettingsAccent, string> = {
  violet: "紫",
  blue: "蓝",
  clay: "陶土",
  green: "绿",
  graphite: "石墨",
}

export const SETTINGS_FONT_SIZES = ["small", "standard", "large"] as const
export type SettingsFontSize = (typeof SETTINGS_FONT_SIZES)[number]

export const SETTINGS_DENSITIES = ["compact", "standard", "relaxed"] as const
export type SettingsDensity = (typeof SETTINGS_DENSITIES)[number]
export const SETTINGS_DENSITY_LABELS: Record<SettingsDensity, string> = {
  compact: "紧凑",
  standard: "标准",
  relaxed: "宽松",
}

export const SETTINGS_UI_FONTS = ["system", "inter", "geist"] as const
export type SettingsUiFont = (typeof SETTINGS_UI_FONTS)[number]

export const SETTINGS_MONO_FONTS = ["jetbrains-mono", "system"] as const
export type SettingsMonoFont = (typeof SETTINGS_MONO_FONTS)[number]

export const SETTINGS_RETENTION = ["forever", "180d", "90d", "30d"] as const
export type SettingsRetention = (typeof SETTINGS_RETENTION)[number]
export const SETTINGS_RETENTION_LABELS: Record<SettingsRetention, string> = {
  forever: "永久",
  "180d": "180 天",
  "90d": "90 天",
  "30d": "30 天",
}

export const SETTINGS_USAGE_METRICS = ["tokens", "messages", "sessions"] as const
export type SettingsUsageMetric = (typeof SETTINGS_USAGE_METRICS)[number]

export const SETTINGS_USAGE_RANGES = ["daily", "weekly", "cumulative"] as const
export type SettingsUsageRange = (typeof SETTINGS_USAGE_RANGES)[number]

export const SETTINGS_DICTATION_SHORTCUT_DEFAULT = "Caps Lock"
export const SETTINGS_CONTENT_WIDTH_MIN = 620
export const SETTINGS_CONTENT_WIDTH_MAX = 1120
export const SETTINGS_CONTENT_WIDTH_DEFAULT = 860

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */

export type SettingsShortcutGroupId = "session" | "navigation" | "send" | "model" | "queue"

export const SETTINGS_SHORTCUT_GROUP_LABELS: Record<SettingsShortcutGroupId, string> = {
  session: "会话",
  navigation: "导航",
  send: "发送",
  model: "模型与思考",
  queue: "消息队列",
}

export type SettingsShortcutId =
  | "newSession"
  | "globalSearch"
  | "archiveSession"
  | "pinSession"
  | "previousSession"
  | "nextSession"
  | "toggleSidebar"
  | "openSettings"
  | "sendMessage"
  | "insertNewline"
  | "stopGeneration"
  | "switchModel"
  | "cycleThinkingLevel"
  | "toggleThinkingBlock"
  | "queueSend"
  | "steerSend"

export interface SettingsShortcutAction {
  id: SettingsShortcutId
  group: SettingsShortcutGroupId
  label: string
  /** 显示的键帽，不是一个可解析的 accelerator；默认值逐字照设计册第 10 节。 */
  defaultKeys: readonly string[]
}

export const SETTINGS_SHORTCUT_ACTIONS: readonly SettingsShortcutAction[] = [
  { id: "newSession", group: "session", label: "新建会话", defaultKeys: ["⌘", "N"] },
  { id: "globalSearch", group: "session", label: "全局搜索", defaultKeys: ["⌘", "K"] },
  { id: "archiveSession", group: "session", label: "归档会话", defaultKeys: ["⇧", "⌘", "A"] },
  { id: "pinSession", group: "session", label: "置顶会话", defaultKeys: ["⌥", "⌘", "P"] },
  { id: "previousSession", group: "navigation", label: "上一个会话", defaultKeys: ["⌘", "["] },
  { id: "nextSession", group: "navigation", label: "下一个会话", defaultKeys: ["⌘", "]"] },
  { id: "toggleSidebar", group: "navigation", label: "切换侧边栏", defaultKeys: ["⌘", "B"] },
  { id: "openSettings", group: "navigation", label: "打开设置", defaultKeys: ["⌘", ","] },
  { id: "sendMessage", group: "send", label: "发送消息", defaultKeys: ["Enter"] },
  { id: "insertNewline", group: "send", label: "换行", defaultKeys: ["⇧", "Enter"] },
  { id: "stopGeneration", group: "send", label: "停止生成", defaultKeys: ["Esc"] },
  { id: "switchModel", group: "model", label: "切换模型", defaultKeys: ["Ctrl", "L"] },
  { id: "cycleThinkingLevel", group: "model", label: "循环思考档", defaultKeys: ["⇧", "Tab"] },
  { id: "toggleThinkingBlock", group: "model", label: "展开或折叠思考块", defaultKeys: ["Ctrl", "O"] },
  { id: "queueSend", group: "queue", label: "排队发送", defaultKeys: ["⌥", "Enter"] },
  { id: "steerSend", group: "queue", label: "插话发送", defaultKeys: ["⌥", "⇧", "Enter"] },
] as const

export type SettingsShortcutMap = Record<SettingsShortcutId, string[]>

/* ------------------------------------------------------------------ */
/* 本机偏好                                                            */
/* ------------------------------------------------------------------ */

/**
 * 全部字段都是浏览器侧偏好（○），唯一持久化位置 = pi_remote_pi_settings_v2。
 * ◐ / ◌ / ● 项的运行时值不塞进这里：读 relay / get_state，写走扩展桥。
 */
export interface SettingsPrefs {
  /* 通用 */
  startView: SettingsStartView
  sidebarPersistentSearch: boolean
  language: SettingsLanguage
  sendKey: SettingsSendKey
  autoScroll: boolean
  autoArchive: SettingsAutoArchive
  micDevice: string
  speechToText: boolean
  dictationShortcut: string

  /* 外观 */
  appearanceStyle: SettingsStyle
  appearanceTheme: SettingsThemePref
  accent: SettingsAccent
  fontSize: SettingsFontSize
  density: SettingsDensity
  reducedMotion: boolean
  contentWidth: number
  uiFont: SettingsUiFont
  monoFont: SettingsMonoFont

  /* 通知（纯本地） */
  notifyWaiting: boolean
  notifyError: boolean
  notifyComplete: boolean
  notifyOnlyWhenAway: boolean
  notifySound: boolean
  notifyBadge: boolean

  /* 快捷键（纯本地；与 pi 的 keybindings.json 无关） */
  shortcuts: SettingsShortcutMap

  /* 数据与隐私 / 设备 / 使用活动里浏览器可独立负责的部分 */
  retention: SettingsRetention
  /**
   * 隐私模式（本机偏好，宿主消费）：关闭侧栏会话标题 / 摘要 / 顶部标题的正文呈现，
   * 通知与标签页标题不出现会话正文。不改变真实数据，只影响宿主渲染层。
   */
  privacyMode: boolean
  autoConnectDevice: boolean
  /** 「设为默认」的设备 id（纯本机偏好，不懂 relay 的当前设备；空串 = 未指定）。 */
  defaultDeviceId: string
  usageMetric: SettingsUsageMetric
  usageRange: SettingsUsageRange
}

/** 持久化版本；结构变更必须升版本，低版本数据整体回落默认值。 */
export const SETTINGS_LOCAL_VERSION = 1

export interface SettingsLocal {
  v: typeof SETTINGS_LOCAL_VERSION
  prefs: SettingsPrefs
  updatedAt: number
}

/** 仅用 getItem/setItem，node 测试可注入内存存储。 */
export interface SettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/* ------------------------------------------------------------------ */
/* Context / 动作                                                      */
/* ------------------------------------------------------------------ */

/** 泛型 setter：K 与 value 类型绑定，页面不会把字符串写到 boolean 字段。 */
export type SettingsSetPref = <K extends keyof SettingsPrefs>(key: K, value: SettingsPrefs[K]) => void

/** 本地偏好写操作；由 useSettingsLocalState() 提供。 */
export interface SettingsPrefsActions {
  setPref: SettingsSetPref
  mergePrefs: (patch: Partial<SettingsPrefs>) => void
  resetPrefs: () => void
}

/** 设置页统一动作：本地偏好 + 真实 relay / 浮层的薄适配。 */
export interface SettingsActions extends SettingsPrefsActions {
  /** 返回原会话（不新建、不丢当前会话）。 */
  back: () => void
  notify: (text: string, tone?: "warn" | "bad") => void
  openPairing: () => void
  openHostDiag: (deviceId: string) => void
  reconnect: () => void
}

/** 页面通过 useSettings() 拿到的全部上下文。 */
export interface SettingsContextValue {
  p: PiContainerProps
  style: SettingsStyle
  theme: SettingsTheme
  page: SettingsPageId
  setPage: (page: SettingsPageId) => void
  prefs: SettingsPrefs
  act: SettingsActions
}
