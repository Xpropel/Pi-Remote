/**
 * P11 统一左侧边栏（桌面）共享契约 —— **三套 UI 唯一侧栏组件 × 六套 token**。
 *
 * 边界：本文件只含类型/常量/逐字文案（无 React 组件、无 DOM/localStorage 副作用），node --test 可直载。
 * 组件与样式：UnifiedSidebar.tsx + SidebarSections/…（claude-dev，P11.3）；本文件由 arch 冻结，API 只增不改。
 * 数据流：宿主（三种变体）→ useSidebarModel（dev 数据适配）→ UnifiedSidebar(data/actions/slots)；
 *       视觉只由 `data.style × theme` 选 `--sb-*` 六套 token（tokens.css），组件不写变体私有样式。
 * 设计源：统一左侧边栏设计规格（数值唯一出处）。
 *
 * Surface：P11-SIDE-01..14（实现挂 data-p11-surface）；验证/截图按 data-p11-surface + data-pi-sidebar-style。
 */
import type { ReactNode } from "react"
import type { RoomEncReason } from "../../relay/devices.ts"

/** 三套视觉风格；与 PiUiVariant 一一对应（drift 由 test/pi-p11-framework 断言）。 */
export const PI_SIDEBAR_STYLES = ["cursor", "claude", "codex"] as const
export type PiSidebarStyle = (typeof PI_SIDEBAR_STYLES)[number]

/** 明暗；六套 = 3 风格 × dark/light。 */
export const PI_SIDEBAR_THEMES = ["dark", "light"] as const
export type PiSidebarTheme = (typeof PI_SIDEBAR_THEMES)[number]

/** 侧栏几何（P11-SIDE-12）：拖宽 220–360，默认 272，折叠 56。 */
export const SIDEBAR_WIDTH_MIN = 220
export const SIDEBAR_WIDTH_DEFAULT = 272
export const SIDEBAR_WIDTH_MAX = 360
export const SIDEBAR_WIDTH_COLLAPSED = 56

/** 桌面设计几何常量（施工/断言用；与 tokens.css 的 --sb-* 几何变量同值）。 */
export const PI_SIDEBAR_METRICS = {
  widthDefault: SIDEBAR_WIDTH_DEFAULT,
  widthMin: SIDEBAR_WIDTH_MIN,
  widthMax: SIDEBAR_WIDTH_MAX,
  widthCollapsed: SIDEBAR_WIDTH_COLLAPSED,
  padX: 12,
  toolbarH: 34,
  deviceH: 34,
  newSessionH: 34,
  plainRowH: 30,
  sectionH: 22,
  workspaceH: 28,
  sessionH: 28,
  identityContainerH: 50,
  identityH: 36,
  bubbleW: 230,
  alignX: 29.5,
  titleGap: 9,
  pinBox: 19,
  archiveBox: 14,
  pinArchiveGap: 3,
  archiveTimeGap: 4,
} as const

/** P11-SIDE-01..14（与 p11-spec §0.3 对齐）。 */
export const PI_SIDEBAR_SURFACES = [
  { id: "P11-SIDE-01", name: "工具行（折叠/搜索/后退前进；无红绿灯）" },
  { id: "P11-SIDE-02", name: "设备选择器收起行" },
  { id: "P11-SIDE-03", name: "设备选择器展开菜单" },
  { id: "P11-SIDE-04", name: "新会话 pill" },
  { id: "P11-SIDE-05", name: "朴素行（工作区/归档）" },
  { id: "P11-SIDE-06", name: "分区标题行（工作区）" },
  { id: "P11-SIDE-07", name: "工作区行 + 文件夹两态" },
  { id: "P11-SIDE-08", name: "会话行 + 状态字形 + 对齐线" },
  { id: "P11-SIDE-09", name: "悬停操作（置顶/归档）" },
  { id: "P11-SIDE-10", name: "信息气泡" },
  { id: "P11-SIDE-11", name: "底部身份行（中转服务器名 + 设置）" },
  { id: "P11-SIDE-12", name: "调宽 220–360 / 折叠 56 / 右锚定" },
  { id: "P11-SIDE-13", name: "置顶分区" },
  { id: "P11-SIDE-14", name: "搜索入口/浮层" },
] as const
export type PiSidebarSurfaceId = (typeof PI_SIDEBAR_SURFACES)[number]["id"]

/** P11-MOB-01..12（与 p11-spec §0.3 对齐；移动端共享壳）。 */
export const PI_MOBILE_SURFACES = [
  { id: "P11-MOB-01", name: "会话页顶栏 54" },
  { id: "P11-MOB-02", name: "抽屉壳（宽=屏宽−68，288–340；遮罩/手势/层级）" },
  { id: "P11-MOB-03", name: "抽屉内部各段" },
  { id: "P11-MOB-04", name: "列表式首页" },
  { id: "P11-MOB-05", name: "设备切换条" },
  { id: "P11-MOB-06", name: "新会话主按钮" },
  { id: "P11-MOB-07", name: "分组头 / 会话行 60 两行 / 摘要 / 时间" },
  { id: "P11-MOB-08", name: "左滑操作（148=74+74）" },
  { id: "P11-MOB-09", name: "长按预览卡" },
  { id: "P11-MOB-10", name: "设置项「移动端交互 UI」两卡" },
  { id: "P11-MOB-11", name: "移动全屏搜索页" },
  { id: "P11-MOB-12", name: "断点 767 / 安全区 30 / 触控 ≥44" },
] as const
export type PiMobileSurfaceId = (typeof PI_MOBILE_SURFACES)[number]["id"]

/** 状态语义（设计 D §10）：运行=强调、等待琥珀、出错红、空闲灰；**无法判定时一律空闲**（不发假 chip）。 */
export type PiSessionTone = "running" | "waiting" | "error" | "idle"

export interface PiSidebarStatus {
  tone: PiSessionTone
  /** 主区标题行「运行中」chip 只在该值 true 时显示（移动顶栏/桌面主区共用） */
  showChip: boolean
  /** 可访问名称（aria-label） */
  label: string
}

export interface PiSidebarDevice {
  id: string
  name: string
  online: boolean
  platform?: string
  /** 当前侧栏绑定的设备 */
  current: boolean
  /** 设备菜单右端状态字（在线/离线/当前），缺省由组件按 online/current 生成 */
  statusLabel?: string
}

export interface PiSidebarSession {
  /** 稳定本地 key = deviceId::roomId/sessionId（pin/archive 持久化用） */
  key: string
  id: string
  title: string
  status: PiSidebarStatus
  /** 绝对时间；时间标签由 model 的 relativeTimeLabel 生成（见 timeLabel） */
  eventAt?: number
  timeLabel: string
  /** 会话事件流一句人话（移动列表第二行/气泡副行用）；无事件时必须为空，不编造 */
  summary?: string
  /** 一行实时状态全句（设计 D §2.2 的 roomStatusLine 输出；悬停气泡加行用）。缺省 = 宿主没接状态面，气泡不加行 */
  statusLine?: string
  cwd: string
  /** 仓库全名（如 your-org/Pi-Remote）；未知留空 */
  repo?: string
  deviceName?: string
  /** 当前选中会话（空心圆/中性行底） */
  selected: boolean
  pinned: boolean
  archived: boolean
  /** 分组 id（工作区/未分组）；置顶组由 model 重排 */
  groupId: string
  /** Content encryption state from the relay roster (crypto Phase 3): true = end-to-end encrypted room,
   *  false = legacy plaintext room (old device, bodies readable by the relay), undefined = relay did not say. */
  enc?: boolean
  /** Plaintext reason from the relay roster (crypto Phase 4 T-1): why a plaintext room is
   *  plaintext (keyless host / migration backlog / orphan); undefined = relay did not say. */
  encReason?: RoomEncReason
}

export type PiSidebarGroupKind = "pinned" | "workspace" | "archive" | "custom"

export interface PiSidebarGroup {
  id: string
  kind: PiSidebarGroupKind
  label: string
  /** 工作区组 = 项目文件夹；无 cwd 组用 "未分组" */
  cwd?: string
  collapsed: boolean
  sessions: PiSidebarSession[]
  /** 组计数（组内会话数；置顶组=置顶数；归档组=归档数） */
  count: number
}

/** Codex 扩展位：RunLocation/本地页入口（扩展/代码审查/计划任务/技能）以行数据注入，不复制共享核。 */
export interface PiSidebarLocalPage {
  id: string
  label: string
  icon?: ReactNode
  active?: boolean
}

export interface PiSidebarSearchResult {
  kind: "session" | "command" | "workspace"
  id: string
  label: string
  detail?: string
}

export interface PiSidebarSearchState {
  open: boolean
  query: string
  results?: PiSidebarSearchResult[]
}

/** 侧栏全部输入（宿主只传数据/动作/slots；视觉由 style×theme 决定）。 */
export interface PiSidebarData {
  /** 视觉风格 = 宿主 UI（cursor|claude|codex） */
  style: PiSidebarStyle
  /** 明暗跟随宿主主题（PiRoot 的 data-pi-theme） */
  theme: PiSidebarTheme
  /** 底部身份行 = 中转服务器名（不是用户名）；空串时组件用 hostname 兜底由宿主/model 处理 */
  serverName: string
  /** tooltip 全 URL（可选；不展示在行内） */
  serverUrl?: string
  /** relay 在线状态（身份行/设备在线点用真实数据，不虚构） */
  online: boolean
  devices: PiSidebarDevice[]
  selectedDeviceId: string | null
  /** 设备菜单是否展开（受控，宿主/组件状态） */
  deviceMenuOpen?: boolean
  groups: PiSidebarGroup[]
  /** 收件箱入口（设计 D §1）：待答行角标数 = attention 清单的 waiting+error+done 之和
   *  （与账本 pending 数恒等，计数只出 attention 单一出口）；缺省 = 不渲染待答行。 */
  inboxCount?: number
  /** Codex 扩展位：本地页入口（可为空） */
  localPages?: PiSidebarLocalPage[]
  newSessionLabel?: string
  /** 侧栏当前宽度（px，已 clamp）与折叠态 */
  width: number
  collapsed: boolean
  search: PiSidebarSearchState
  /** 周期刷新时间标签用（useNow）；缺省 Date.now() */
  now?: number
}

export type PiSidebarPlainRow = "workspace" | "archive"

/** 侧栏动作（宿主实现数据/路由；组件不直接碰 relay/localStorage）。 */
export interface PiSidebarActions {
  selectSession: (sessionKey: string) => void
  newSession: () => void
  selectDevice: (deviceId: string) => void
  toggleDeviceMenu?: (open?: boolean) => void
  addDevice?: () => void
  back?: () => void
  forward?: () => void
  /** 置顶/归档（本机状态；诚实提示见 PI_SIDEBAR_COPY） */
  togglePin: (sessionKey: string) => void
  toggleArchive: (sessionKey: string) => void
  /** 分组折叠；plain 行「工作区」=全部展开/收起 */
  toggleGroup: (groupId: string) => void
  togglePlainRow?: (row: PiSidebarPlainRow) => void
  /** 搜索 = 既有命令面板/搜索（spec §6.7）；默认无常驻输入框 */
  openSearch: () => void
  closeSearch: () => void
  setSearchQuery?: (query: string) => void
  openSettings: () => void
  /** 调宽（拖拽结束/键盘微调）；组件先 clamp 再回调 */
  resize: (width: number) => void
  toggleCollapse: () => void
  /** Codex 扩展位：选中本地页（可选） */
  selectLocalPage?: (pageId: string) => void
  /** 归档视图（本地归档列表；可选） */
  openArchiveView?: () => void
  /** 收件箱视图（设计 D §1：全局待答清单；可选） */
  openInbox?: () => void
}

/** 扩展位（Codex 标题栏 tab / RunLocation / 变体自定义入口）；共享核只给挂载点。 */
export interface PiSidebarSlots {
  beforePlainRows?: ReactNode
  beforeGroups?: ReactNode
  afterGroups?: ReactNode
  toolbarEnd?: ReactNode
  identityExtra?: ReactNode
}

/** UnifiedSidebar 组件 props（claude-dev 实现；宿主三套只传 style=自身）。 */
export interface PiSidebarProps {
  data: PiSidebarData
  actions: PiSidebarActions
  slots?: PiSidebarSlots
  className?: string
  /** 悬停行变化（气泡/预览卡由组件内部处理；宿主可做预取） */
  onHoverSession?: (sessionKey: string | null) => void
}

/** 别名：spec 中组件名 UnifiedSidebar。 */
export type UnifiedSidebarProps = PiSidebarProps

/** 逐字诚实提示（spec §6.4/§6.5；设置脚注/行 title/归档空态共用）。 */
export const PI_SIDEBAR_COPY = {
  pinHint: "仅本机记忆，尚未写入 pi",
  pinTitle: "置顶仅保存在本机浏览器，不同步到其他设备",
  archiveHint: "归档仅保存在本机浏览器，不会删除会话文件",
  archiveTitle: "归档仅在本机隐藏，不会修改或同步到其他设备",
  archiveEmpty: "本机暂无归档",
  archiveViewTitle: "归档的会话会显示在这里（仅本机）",
  settingsFootnote: "置顶与归档目前只保存在本机浏览器，不会修改或同步到其他设备；后续 pi 支持后再接真实能力。",
} as const
