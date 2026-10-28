/**
 * P11 移动端导航共享契约（三套 UI 共用双模式壳；实现 codex-dev，P11.4）。
 * 断点：≤767 移动、≥768 桌面（PI_LAYOUT_BREAKPOINT=768）。
 * 双模式：`list`（默认，首页=会话列表）/ `drawer`（会话页为家，侧栏抽屉）。
 * 数据/动作与桌面共享（PiSidebarData/Actions），不复制数据层。
 */
import type { PiSidebarActions, PiSidebarData } from "../sidebar/types.ts"

export const PI_MOBILE_NAV_MODES = ["list", "drawer"] as const
export type PiMobileNavMode = (typeof PI_MOBILE_NAV_MODES)[number]
export const PI_MOBILE_NAV_DEFAULT: PiMobileNavMode = "list"

export const PI_MOBILE_METRICS = {
  topBarH: 54,
  deviceBarH: 48,
  newSessionH: 46,
  drawerMinWidth: 288,
  drawerMaxWidth: 340,
  drawerRightInset: 68,
  groupHeaderH: 34,
  sessionRowH: 60,
  swipeActionsW: 148,
  swipeActionW: 74,
  safeAreaBottom: 30,
  touchMin: 44,
  longPressCardMaxW: 320,
} as const

/** 移动壳 props：同一份数据/动作，mode 只换导航壳。 */
export interface PiMobileNavProps {
  mode: PiMobileNavMode
  data: PiSidebarData
  actions: PiSidebarActions
  /** 移动壳路由（列表首页/会话页）；组件不直接碰 relay */
  page: "list" | "session"
  onOpenSession: (sessionKey: string) => void
  onBackToList: () => void
  /** 模式切换（设置页/调试用；正式入口在 MobileNavSetting） */
  onModeChange?: (mode: PiMobileNavMode) => void
  /** 抽屉开合（受控时传入） */
  drawerOpen?: boolean
  onDrawerOpenChange?: (open: boolean) => void
}

/** 设置项「移动端交互 UI」两卡（三套设置页共用；文案逐字见设计 M §6）。 */
export interface PiMobileNavSettingProps {
  value: PiMobileNavMode
  onChange: (mode: PiMobileNavMode) => void
  disabled?: boolean
}

/** 逐字文案（设计 M §6；不得改写） */
export const PI_MOBILE_NAV_COPY = {
  title: "移动端交互 UI",
  drawerName: "抽屉式",
  drawerDesc: "会话页为主，侧栏自左滑出",
  listName: "列表式",
  listDesc: "首页为会话列表，先看各会话状态",
  footnote: "切换后立即生效，仅影响移动端。",
} as const

/* ---- 移动壳展示模型（Codex/Cursor 手机壳宿主映射；task-36） ---- */

/**
 * P11 共享移动框架的数据/动作契约（task-36，codex-dev 所有）。
 *
 * 只定义移动壳需要的**展示模型**，不 import relay/变体实现：宿主（Cursor/Claude/Codex 手机壳）
 * 负责把 relay 数据映射成 MobileModel，把动作绑定到 act/relay；共享模块只负责壳与交互。
 * 等 arch B0 的 sidebar model/prefs 落地后，宿主映射可复用 `@/pi/model/sidebarSource`。
 */

export type MobileRowMarker = "running" | "waiting" | "error" | "idle" | "none"

export interface MobileDevice {
  id: string
  name: string
  online: boolean
  platform?: string
}

export interface MobileSession {
  id: string
  title: string
  /** 第二行摘要：最近一条状态事件的一句人话；无事件留空（行高不变） */
  summary?: string
  /** 右侧时间文案（刚刚 / Nm / Nh / 昨天 / 日期） */
  timeLabel?: string
  marker?: MobileRowMarker
  deviceId?: string
  /** 长按卡用：仓库 / 路径 / 设备 */
  repo?: string | null
  path?: string | null
  deviceName?: string | null
  pinned?: boolean
}

export interface MobileGroup {
  key: string
  label: string
  sessions: readonly MobileSession[]
  collapsed?: boolean
  /** 组头右侧文案（N 个会话） */
  countLabel?: string
}

export interface MobileModel {
  devices: readonly MobileDevice[]
  activeDeviceId?: string | null
  groups: readonly MobileGroup[]
  pinned?: readonly MobileSession[]
  /** 底部身份行：中转服务器名（P11 口径，不显示用户名） */
  serverName?: string
  loading?: boolean
  emptyText?: string
  /** 设备菜单展开态（受控可选） */
  deviceMenuOpen?: boolean
}

export interface MobileActions {
  onNewSession: () => void
  onOpenSettings: () => void
  onOpenSearch: () => void
  onOpenSession: (session: MobileSession) => void
  onSelectDevice?: (device: MobileDevice) => void
  onToggleDeviceMenu?: (open: boolean) => void
  onToggleGroup?: (group: MobileGroup) => void
  onPin: (session: MobileSession) => void
  onArchive: (session: MobileSession) => void
  /** 长按卡/抽屉里关闭当前浮层 */
  onCloseOverlay?: () => void
}

/** 列表式左滑操作层宽度：两钮各 74，总 148（移动册 §4.5） */
export const MOBILE_SWIPE_WIDTH = 148
/** 列表页顶栏 / 抽屉顶栏让位 */
export const MOBILE_TOPBAR_HEIGHT = 54
/** 底部安全段：Home 条区 */
export const MOBILE_SAFE_BOTTOM = 30
