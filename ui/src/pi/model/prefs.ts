/**
 * 新界面的本机偏好与迁移（plan §7.3 settings / quick-settings、design §1.13、§3.5；取代 style/prefs.ts）。纯函数，node --test 直接加载。
 * 读写 localStorage 由 P5 的 hook 做；这里只负责"存的东西 → 合法的偏好"。
 * 偏好是用户设置，不是数据：缺的字段用默认值，这和 §1.9 的"缺数据不填"不冲突。
 * P1 架构线（PI-UI-REFS）：新增 `ui` 变体偏好（cursor / claude / codex，默认 cursor）。字段校验 / 回退规则在
 * pi/variants/types.ts（piUiVariantOf），这里只接线；版本号不升 —— 旧存储里没有 ui 就是默认 cursor，迁移兼容。
 */
import { piUiWorkspacePrefsOf, type PiUiPlatform, type PiUiPlatformTab } from "../extensions/platform-prefs.ts"
import type { PiUiVariant } from "../variants/types.ts"
import { DEFAULT_PI_UI_VARIANT, piUiVariantOf } from "../variants/types.ts"
import type { PiGrouping } from "./sidebarGroups.ts"
import type { PiDensity } from "./toolWeight.ts"
import { PI_MOBILE_NAV_DEFAULT, PI_MOBILE_NAV_MODES, type PiMobileNavMode } from "../mobile/types.ts"
import { clampSidebarWidth } from "../sidebar/storage.ts"

export const PI_PREFS_KEY = "pi_remote_pi_prefs"
/** 旧界面的偏好键（style/prefs.ts 的 styleKey）；只读，用来迁移 */
export const LEGACY_STYLE_KEY = "pi_remote_style"
/** 旧界面的主题键（index.html 首帧脚本："light" / "dark" = 手动，缺省 = 跟随系统）；只读，主题迁移的来源（P6.4） */
export const LEGACY_THEME_KEY = "pi-remote.theme"
export const PI_PREFS_VERSION = 1

export type PiThemePref = "system" | "light" | "dark"
export type PiDeliveryPref = "steer" | "follow_up"

export type PiPrefs = {
  v: typeof PI_PREFS_VERSION
  /** 界面变体（PI-UI-REFS 架构线）：默认"cursor"（现有 Cursor 风格界面）；claude / codex 由 P2 两条线实现 */
  ui: PiUiVariant
  /** P4.1（Q1）：设备平台标签（Claude 三标签 → 平台）：默认 "all"；只 claude / codex 两变体消费，cursor 不变 */
  uiPlatformTab: PiUiPlatformTab
  /** P4.1（Q1）：每个平台上次选中的设备 id（Q2 平台内细选用）；默认 {} */
  deviceByPlatform: Partial<Record<PiUiPlatform, string>>
  /** 主题：默认跟随系统（§1.11） */
  theme: PiThemePref
  /** 工具显示密度：默认平衡（§1.5） */
  density: PiDensity
  /** 列表分组：默认设备与目录（D-07） */
  grouping: PiGrouping
  /** 设备筛选（设备 id）；null = 全部设备 */
  deviceFilter: string | null
  /** 默认投递："插入当前回合"（决定 10） */
  delivery: PiDeliveryPref
  /** 回合结束提示音，默认关 */
  completionSound: boolean
  /** 对话框远程应答（O2），默认关 */
  dialogRemoteAnswer: boolean
  /** P11 侧栏宽度（px，220–360；设备本地，不同步；默认 272） */
  sidebarWidth: number
  /** P11 侧栏折叠态（56px 图标列；设备本地，不同步；默认展开） */
  sidebarCollapsed: boolean
  /** P11 移动端导航双模式（默认 list；**唯一走 prefs-sync 的 P11 字段**，跨设备跟随账号） */
  mobileNav: PiMobileNavMode
  /** P11 工具行常驻搜索框（默认关；设备本地） */
  sidebarPersistentSearch: boolean
}

export const DEFAULT_PI_PREFS: PiPrefs = {
  v: PI_PREFS_VERSION,
  ui: DEFAULT_PI_UI_VARIANT,
  uiPlatformTab: "all",
  deviceByPlatform: {},
  theme: "system",
  density: "balanced",
  grouping: "device",
  deviceFilter: null,
  delivery: "steer",
  completionSound: false,
  dialogRemoteAnswer: false,
  sidebarWidth: 272,
  sidebarCollapsed: false,
  mobileNav: PI_MOBILE_NAV_DEFAULT,
  sidebarPersistentSearch: false,
}

function obj(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      return obj(JSON.parse(raw))
    } catch {
      return null
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

const THEME_PREFS: readonly PiThemePref[] = ["system", "light", "dark"]

/** 新键内容里的主题（不合法 / 没有 = null） */
export function storedThemeOf(stored: unknown): PiThemePref | null {
  const theme = obj(stored)?.theme
  return typeof theme === "string" && (THEME_PREFS as readonly string[]).includes(theme) ? (theme as PiThemePref) : null
}

/**
 * 主题偏好（P6.4，R2/p6-lanes.md §2.6）：新键 PI_PREFS_KEY 里有合法的 theme 就用它；没有时取旧键 LEGACY_THEME_KEY 的
 * light / dark（旧键只有这两个值，缺省 = 跟随系统）；都没有 = "system"。ui/index.html 的首帧脚本照抄同一条规则（test/pi-p6-a 两边逐条比）。
 */
export function piThemePrefOf(stored: unknown, legacyTheme?: unknown): PiThemePref {
  return storedThemeOf(stored) ?? (legacyTheme === "light" || legacyTheme === "dark" ? legacyTheme : "system")
}

/** 主题偏好 + 系统是不是深色 → 实际主题 */
export function resolvePiTheme(pref: PiThemePref, systemDark: boolean): "light" | "dark" {
  return pref === "system" ? (systemDark ? "dark" : "light") : pref
}

/**
 * 存储内容 → 偏好。
 * - stored：新键 PI_PREFS_KEY 的内容（JSON 字符串或对象）；字段逐个校验，不合法的回落默认值，多余字段丢掉。
 * - legacy：旧键 pi_remote_style 的内容；只在新键不存在（null / undefined）时用，只搬 completionSound、dialogRemoteAnswer
 *   两个语义不变的开关。旧主题 / 皮肤 / 字体不搬（新界面只有浅色 + 深色，§1.3），旧 queueSend 是"立即发送"的打断方式，不是默认投递，也不搬。
 * - legacyTheme（P6.4）：旧主题键 pi-remote.theme 的内容；新键里没有合法 theme 时按 piThemePrefOf 搬 light / dark。不传 = 不搬（同 P5）。
 */
export function migratePiPrefs(stored: unknown, legacy?: unknown, legacyTheme?: unknown): PiPrefs {
  const cur = obj(stored)
  if (cur) {
    const filter = cur.deviceFilter
    const platform = piUiWorkspacePrefsOf(cur)
    return {
      v: PI_PREFS_VERSION,
      ui: piUiVariantOf(cur.ui),
      uiPlatformTab: platform.uiPlatformTab,
      deviceByPlatform: platform.deviceByPlatform,
      theme: piThemePrefOf(cur, legacyTheme),
      density: pick(cur.density, ["compact", "balanced", "detailed"], DEFAULT_PI_PREFS.density),
      grouping: pick(cur.grouping, ["device", "flat"], DEFAULT_PI_PREFS.grouping),
      deviceFilter: typeof filter === "string" && filter ? filter : null,
      delivery: pick(cur.delivery, ["steer", "follow_up"], DEFAULT_PI_PREFS.delivery),
      completionSound: bool(cur.completionSound, DEFAULT_PI_PREFS.completionSound),
      dialogRemoteAnswer: bool(cur.dialogRemoteAnswer, DEFAULT_PI_PREFS.dialogRemoteAnswer),
      sidebarWidth: clampSidebarWidth(cur.sidebarWidth),
      sidebarCollapsed: bool(cur.sidebarCollapsed, DEFAULT_PI_PREFS.sidebarCollapsed),
      mobileNav: pick(cur.mobileNav, PI_MOBILE_NAV_MODES, DEFAULT_PI_PREFS.mobileNav),
      sidebarPersistentSearch: bool(cur.sidebarPersistentSearch, DEFAULT_PI_PREFS.sidebarPersistentSearch),
    }
  }
  const old = obj(legacy)
  return {
    ...DEFAULT_PI_PREFS,
    uiPlatformTab: DEFAULT_PI_PREFS.uiPlatformTab,
    deviceByPlatform: { ...DEFAULT_PI_PREFS.deviceByPlatform },
    theme: piThemePrefOf(null, legacyTheme),
    completionSound: bool(old?.completionSound, DEFAULT_PI_PREFS.completionSound),
    dialogRemoteAnswer: bool(old?.dialogRemoteAnswer, DEFAULT_PI_PREFS.dialogRemoteAnswer),
  }
}

/** 改一项：分组方式变了时要清掉"更多 N"的展开状态（§3.3），由调用方据此清 usePiUiState.expanded */
export function setPiPref<K extends Exclude<keyof PiPrefs, "v">>(prefs: PiPrefs, key: K, value: PiPrefs[K]): { prefs: PiPrefs; clearExpanded: boolean } {
  const next = migratePiPrefs({ ...prefs, [key]: value })
  return { prefs: next, clearExpanded: key === "grouping" && next.grouping !== prefs.grouping }
}

/**
 * P11 prefs-sync（additive）：`mobileNav` 是唯一同步字段。
 * - 上行：只发 {mobileNav}，不复活 R4-1 外观五字段旧通道；
 * - 下行：校验 list|drawer，坏值返回 null（保留本地值），未知/缺字段=旧 relay；
 * - 宽度/折叠/常驻搜索是设备本地偏好，**不得**进入同步子集。
 */
export function mobileNavFromPrefsSubset(raw: unknown): PiMobileNavMode | null {
  const rec = obj(raw)
  const value = rec?.mobileNav
  return typeof value === "string" && (PI_MOBILE_NAV_MODES as readonly string[]).includes(value) ? (value as PiMobileNavMode) : null
}

export function prefsSyncSubsetOf(prefs: Pick<PiPrefs, "mobileNav">): { mobileNav: PiMobileNavMode } {
  return { mobileNav: prefs.mobileNav }
}
