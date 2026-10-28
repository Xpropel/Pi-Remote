/**
 * P11 mock/gallery 工装（task-37 M1，**dev-only**）：统一侧栏 + 移动双模式的数据字典与场景。
 *
 * - 数据字典逐字取设计稿样本（桌面册/移动册）：设备 MacBook Pro / Windows 电脑、身份「上海中转」、
 *   工作区 Pi-Remote / LLM 论文 / 杂项、会话 6 条（运行/等待/出错/空闲/选中）+ 摘要/时间/仓库/路径；
 * - 确定性：固定 `DEV_NOW`，无 Math.random/Date.now/wall clock；relative time 由 fixture 直接给 `timeLabel`；
 * - 只给 `PiSidebarData`（桌面 UnifiedSidebar 与移动 MobileNavShell 共用同一份数据契约），
 *   六套皮肤用 `PI_SIDEBAR_GALLERY_PRESETS`（arch 冻结的 gallery 注入接口）；
 * - 纯函数 reducer（pin/archive/group/device/width/collapse/search）供预览交互与单测复用；
 * - 生产代码不 import 本目录（单测扫描约束）。
 */
import {
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  type PiSidebarActions,
  type PiSidebarData,
  type PiSidebarDevice,
  type PiSidebarGroup,
  type PiSidebarSearchResult,
  type PiSidebarSession,
  type PiSidebarStatus,
  type PiSidebarStyle,
  type PiSidebarTheme,
} from "../../sidebar/types.ts"
import { PI_SIDEBAR_GALLERY_PRESETS } from "../../sidebar/gallery.ts"
import { sidebarSessionKeyOf } from "../../sidebar/model.ts"

/** mock 基准时刻（2026-10-27 21:00 Asia/Shanghai；固定值，不读系统时钟） */
export const P11_DEV_NOW = Date.UTC(2026, 9, 27, 13, 0, 0)
export const P11_DEV_DEVICE_ID = "dev-mbp"
export const P11_DEV_SERVER_NAME = "上海中转"
export const P11_DEV_SERVER_URL = "relay.example.com"

/** 设计稿逐字样本（README/单测共用，禁止随手机器人漂移） */
export const P11_DEV_SESSION_SPECS = [
  { id: "relay-reconnect", title: "修复 relay 重连掉线", tone: "running", timeLabel: "刚刚", summary: "正在跑 e2e，已过 34 步", selected: true, groupId: "pi" },
  { id: "usage-build", title: "设置页使用活动施工", tone: "waiting", timeLabel: "12m", summary: "等你确认部署方案", groupId: "pi" },
  { id: "deploy-perm", title: "部署脚本权限问题", tone: "error", timeLabel: "2h", summary: "构建失败：权限不足", groupId: "pi" },
  { id: "l194-compare", title: "L194 精读对比", tone: "running", timeLabel: "34m", summary: "正在精读第 3 节，已摘录 12 段", groupId: "papers" },
  { id: "backlog-clean", title: "待获取清单整理", tone: "idle", timeLabel: "昨天", summary: "已整理 18 条，暂无新进展", groupId: "papers" },
  { id: "server-inspect", title: "服务器巡检", tone: "error", timeLabel: "昨天", summary: "巡检脚本退出码 3", groupId: "misc" },
] as const

const WORKSPACES: Record<string, { label: string; cwd: string; repo: string; deviceName: string }> = {
  pi: { label: "Pi-Remote", cwd: "~/CLI/Pi-Remote", repo: "your-org/Pi-Remote", deviceName: "MacBook Pro" },
  papers: { label: "LLM 论文", cwd: "~/docs/llm-papers", repo: "your-org/llm-paper", deviceName: "MacBook Pro" },
  misc: { label: "杂项", cwd: "~/ops", repo: "your-org/ops", deviceName: "MacBook Pro" },
}

const STATUS_LABEL: Record<string, string> = { running: "运行中", waiting: "等待中", error: "出错", idle: "空闲" }

function statusOf(tone: string, showChip?: boolean): PiSidebarStatus {
  const key = (["running", "waiting", "error", "idle"] as const).includes(tone as never) ? (tone as PiSidebarStatus["tone"]) : "idle"
  return { tone: key, showChip: showChip ?? key === "running", label: STATUS_LABEL[key] }
}

function sessionOf(spec: { id: string; title: string; tone: string; timeLabel: string; summary?: string; selected?: boolean; groupId: string }, overrides: Partial<PiSidebarSession> = {}): PiSidebarSession {
  const workspace = WORKSPACES[spec.groupId] ?? WORKSPACES.pi
  return {
    key: sidebarSessionKeyOf(P11_DEV_DEVICE_ID, spec.id),
    id: spec.id,
    title: spec.title,
    status: statusOf(spec.tone),
    eventAt: P11_DEV_NOW,
    timeLabel: spec.timeLabel,
    summary: spec.summary,
    cwd: workspace.cwd,
    repo: workspace.repo,
    deviceName: workspace.deviceName,
    selected: spec.selected ?? false,
    pinned: false,
    archived: false,
    groupId: spec.groupId,
    ...overrides,
  }
}

/** 设备：设计稿只列真实两台；`devices-3` 场景加一台离线 Linux（gallery-only，README 注明） */
export const P11_DEV_DEVICES: readonly PiSidebarDevice[] = [
  { id: P11_DEV_DEVICE_ID, name: "MacBook Pro", online: true, current: true },
  { id: "dev-win", name: "Windows 电脑", online: true, current: false },
]
export const P11_DEV_DEVICES_THREE: readonly PiSidebarDevice[] = [
  ...P11_DEV_DEVICES,
  { id: "dev-linux", name: "Linux 工作站", online: false, current: false, statusLabel: "离线" },
]

function groupOf(id: string, sessions: PiSidebarSession[], collapsed = false, label?: string): PiSidebarGroup {
  const workspace = WORKSPACES[id]
  return { id, kind: "workspace", label: label ?? workspace?.label ?? id, cwd: workspace?.cwd, collapsed, sessions, count: sessions.length }
}

function baseGroups(collapsedDefault = true): PiSidebarGroup[] {
  const specs = P11_DEV_SESSION_SPECS.map((spec) => ({ spec, session: sessionOf(spec) }))
  return [
    groupOf("pi", specs.filter(({ spec }) => spec.groupId === "pi").map(({ session }) => session), collapsedDefault),
    groupOf("papers", specs.filter(({ spec }) => spec.groupId === "papers").map(({ session }) => session), collapsedDefault),
    groupOf("misc", specs.filter(({ spec }) => spec.groupId === "misc").map(({ session }) => session), collapsedDefault),
  ]
}

function manySessions(count: number): PiSidebarSession[] {
  const tones = ["running", "waiting", "error", "idle"] as const
  const times = ["刚刚", "3m", "12m", "26m", "48m", "1h", "2h", "3h", "5h", "昨天", "2d", "3d"]
  return Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(2, "0")
    return sessionOf({
      id: `many-${n}`,
      title: `长列表会话 ${n}：${["统一侧栏接入", "移动端抽屉手势", "六套 token 对图", "会话摘要生成"][index % 4]}`,
      tone: tones[index % tones.length],
      timeLabel: times[index % times.length],
      summary: `第 ${index + 1} 条状态事件摘要`,
      groupId: ["pi", "papers", "misc"][index % 3],
      selected: index === 0,
    })
  })
}

function pinnedGroups(base: PiSidebarGroup[]): PiSidebarGroup[] {
  const all = base.flatMap((group) => group.sessions)
  const pinnedSessions = all.slice(0, 2).map((session) => ({ ...session, pinned: true }))
  const pinnedKeys = new Set(pinnedSessions.map((session) => session.key))
  const rest = base.map((group) => ({ ...group, sessions: group.sessions.filter((session) => !pinnedKeys.has(session.key)), count: group.sessions.filter((session) => !pinnedKeys.has(session.key)).length }))
  const pinned: PiSidebarGroup = { id: "pinned", kind: "pinned", label: "置顶", collapsed: false, sessions: pinnedSessions, count: pinnedSessions.length }
  return [pinned, ...rest]
}

function longTitleGroups(): PiSidebarGroup[] {
  const longWorkspace = "一个非常长的项目工作区名称用于省略号与悬停气泡测试（Pi-Remote monorepo）"
  const longSessions = [
    sessionOf({ id: "long-1", title: "统一侧边栏六套皮肤像素级对图与移动端双模式手势阈值回归（超长标题截断测试）", tone: "running", timeLabel: "刚刚", summary: "正在对图：六套深色 + 浅色", groupId: "pi", selected: true }),
    sessionOf({ id: "long-2", title: "修复 relay 重连掉线：断线重连后 room 状态不同步与消息补发顺序（超长标题省略号）", tone: "waiting", timeLabel: "12m", summary: "等你确认重连补发策略", groupId: "pi" }),
  ]
  return [{ id: "pi-long", kind: "workspace", label: longWorkspace, cwd: "~/CLI/Pi-Remote", collapsed: false, sessions: longSessions, count: longSessions.length }]
}

/** 桌面场景（P11-SIDE-01..14 / 验证 D1–D8 覆盖） */
export const P11_DESKTOP_SCENARIOS = [
  { id: "base", label: "设计稿基准（默认全折叠）", desc: "两台在线设备、三工作区；组头无会话数量" },
  { id: "base-expanded", label: "展开态基准", desc: "同 base 但三组展开（六会话五状态，选中+悬停证据）" },
  { id: "states-all", label: "状态全览", desc: "同一工作区展示运行/等待/出错/空闲/选中" },
  { id: "devices-3", label: "三设备 + 菜单", desc: "增加 gallery-only 离线 Linux；设备菜单展开" },
  { id: "long-titles", label: "长标题", desc: "超长工作区/会话标题，验证省略号与气泡截断" },
  { id: "widths", label: "调宽 220/272/360 + 折叠 56", desc: "右锚定不变量" },
  { id: "pin-archive", label: "置顶分区", desc: "两条置顶进入「置顶」分区" },
  { id: "empty", label: "空态", desc: "无会话（诚实空列表）" },
  { id: "busy-many", label: "长列表", desc: "24 条会话跨三组" },
  { id: "menu", label: "设备菜单展开", desc: "设备选择器展开态" },
  { id: "search", label: "搜索浮层", desc: "⌘K 搜索，带结果" },
  { id: "hover", label: "悬停气泡", desc: "第 2 行悬停：图钉/归档 + 230 气泡" },
  { id: "folders", label: "文件夹两态（默认折叠 + 展开）", desc: "一组展开（打开造型）+ 一组收起（闭合造型）" },
  { id: "identity-long", label: "长身份名", desc: "超长中转服务器名截断" },
] as const
export type P11DesktopScenarioId = (typeof P11_DESKTOP_SCENARIOS)[number]["id"]

/** 移动场景（P11-MOB-01..12） */
export const P11_MOBILE_SCENARIOS = [
  { id: "drawer-base", label: "抽屉式：会话页 + 抽屉打开", desc: "设备/新会话/朴素行/工作区/会话/身份行" },
  { id: "drawer-long", label: "抽屉式：长列表", desc: "12+ 会话滚动" },
  { id: "list-base", label: "列表式首页", desc: "顶栏/设备条/新会话/组头/两行会话行" },
  { id: "list-long", label: "列表式：长列表", desc: "多组折叠 + 长标题摘要" },
  { id: "list-folded", label: "列表式：默认全折叠", desc: "组头无会话数量（第一次展开见 e2e）" },
  { id: "drawer-folded", label: "抽屉式：默认全折叠", desc: "组头无会话数量（第一次展开见 e2e）" },
  { id: "list-swipe", label: "列表式：左滑 148", desc: "置顶/归档双钮" },
  { id: "settings-nav", label: "设置项「移动端交互 UI」", desc: "两卡 + 默认列表式" },
  { id: "search", label: "移动全屏搜索", desc: "列表式顶栏搜索" },
  { id: "empty", label: "移动空态", desc: "无会话" },
  { id: "longpress", label: "长按预览卡", desc: "两模式共用" },
] as const
export type P11MobileScenarioId = (typeof P11_MOBILE_SCENARIOS)[number]["id"]

export interface P11PreviewParams {
  view: "board" | "single"
  surface: "desktop" | "mobile"
  style: PiSidebarStyle
  theme: PiSidebarTheme
  scenario: string
  width: number
  collapsed: boolean
  deviceMenuOpen: boolean | null
  searchOpen: boolean | null
  hoverRow: number | null
  mode: "list" | "drawer"
  page: "list" | "session"
  drawerOpen: boolean
  settingValue: "list" | "drawer"
  vp: string
}

const STYLES: readonly string[] = ["cursor", "claude", "codex"]

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))
}

/** URL/hash 参数 → 预览参数（非法值回退默认；供 devPreview 与测试共用） */
export function p11PreviewParamsOf(params: URLSearchParams): P11PreviewParams {
  const styleRaw = params.get("skin") ?? params.get("style") ?? "cursor"
  const style = (STYLES.includes(styleRaw) ? styleRaw : "cursor") as PiSidebarStyle
  const theme = params.get("theme") === "light" ? "light" : "dark"
  const scenario = params.get("scenario") ?? (params.get("surface") === "mobile" ? "list-base" : "base")
  const widthRaw = Number(params.get("width") ?? SIDEBAR_WIDTH_DEFAULT)
  const view = params.get("view") === "single" ? "single" : "board"
  const surface = params.get("surface") === "mobile" ? "mobile" : "desktop"
  const hoverRaw = params.get("hoverRow")
  const vpRaw = params.get("vp") ?? (surface === "mobile" ? "390x844" : "1440x900")
  return {
    view,
    surface,
    style,
    theme,
    scenario,
    width: params.has("collapsed") && params.get("collapsed") !== "0" ? SIDEBAR_WIDTH_COLLAPSED : clampWidth(widthRaw),
    collapsed: params.has("collapsed") && params.get("collapsed") !== "0",
    deviceMenuOpen: params.has("deviceMenuOpen") ? params.get("deviceMenuOpen") !== "0" : null,
    searchOpen: params.has("searchOpen") ? params.get("searchOpen") !== "0" : null,
    hoverRow: hoverRaw != null && hoverRaw !== "" && Number.isFinite(Number(hoverRaw)) ? Math.max(0, Math.round(Number(hoverRaw))) : null,
    mode: (params.get("mobileNav") ?? params.get("mode")) === "drawer" ? "drawer" : "list",
    page: params.get("page") === "session" || params.get("page") === "list" ? (params.get("page") as "list" | "session") : (params.get("mobileNav") ?? params.get("mode")) === "drawer" ? "session" : "list",
    drawerOpen: params.get("drawerOpen") === "1",
    settingValue: (params.get("pref") ?? params.get("mobileNav")) === "drawer" ? "drawer" : "list",
    vp: /^\d{3,4}x\d{3,4}$/.test(vpRaw) ? vpRaw : "1440x900",
  }
}

function searchResultsOf(groups: readonly PiSidebarGroup[]): PiSidebarSearchResult[] {
  return groups.flatMap((group) => group.sessions.slice(0, 2).map((session) => ({ kind: "session" as const, id: session.key, label: session.title, detail: group.label })))
}

/** 桌面数据（单一事实：PiSidebarData） */
export function p11SidebarDataOf(params: P11PreviewParams, overrides: { style?: PiSidebarStyle; theme?: PiSidebarTheme } = {}): PiSidebarData {
  const style = overrides.style ?? params.style
  const theme = overrides.theme ?? params.theme
  const scenario = params.scenario
  let groups = baseGroups(true)
  let devices: PiSidebarDevice[] = [...P11_DEV_DEVICES]
  let deviceMenuOpen = params.deviceMenuOpen ?? false
  let searchOpen = params.searchOpen ?? false
  let serverName: string = P11_DEV_SERVER_NAME
  switch (scenario) {
    case "base-expanded":
      groups = baseGroups(false)
      break
    case "states-all":
      groups = [groupOf("pi", P11_DEV_SESSION_SPECS.map((spec) => sessionOf(spec)))]
      break
    case "devices-3":
    case "menu":
      devices = [...P11_DEV_DEVICES_THREE]
      deviceMenuOpen = scenario === "menu" ? true : params.deviceMenuOpen ?? true
      break
    case "long-titles":
      groups = longTitleGroups()
      break
    case "pin-archive":
      groups = pinnedGroups(baseGroups(false))
      break
    case "empty":
      groups = []
      break
    case "busy-many":
      groups = [
        groupOf("pi", manySessions(10)),
        groupOf("papers", manySessions(8)),
        groupOf("misc", manySessions(6)),
      ]
      break
    case "search":
      searchOpen = true
      break
    case "hover":
      groups = baseGroups(false)
      break
    case "folders":
      groups = [groupOf("pi", baseGroups(false)[0].sessions), groupOf("papers", baseGroups(false)[1].sessions, true)]
      break
    case "identity-long":
      serverName = `${P11_DEV_SERVER_NAME} · ${P11_DEV_SERVER_URL}（华东一区主节点）`
      break
    default:
      break
  }
  const allSessions = groups.flatMap((group) => group.sessions)
  return {
    style,
    theme,
    serverName,
    serverUrl: P11_DEV_SERVER_URL,
    online: true,
    devices,
    selectedDeviceId: P11_DEV_DEVICE_ID,
    deviceMenuOpen,
    groups,
    width: params.width,
    collapsed: params.collapsed,
    search: { open: searchOpen, query: searchOpen ? "relay" : "", results: searchOpen ? searchResultsOf(groups) : undefined },
    now: P11_DEV_NOW,
    newSessionLabel: "新会话",
    localPages: allSessions.length ? undefined : undefined,
  }
}

/** 移动数据（同一 PiSidebarData；移动壳用 data.summary 出第二行） */
export function p11MobileDataOf(params: P11PreviewParams): PiSidebarData {
  const scenario = params.scenario
  const desktopParams: P11PreviewParams = { ...params, scenario: ["list-base", "list-swipe", "settings-nav", "search", "longpress", "list-folded", "drawer-folded"].includes(scenario) ? "base-expanded" : scenario }
  const data = p11SidebarDataOf(desktopParams)
  if (scenario === "list-folded" || scenario === "drawer-folded") {
    return { ...data, groups: data.groups.map((group) => ({ ...group, collapsed: true })) }
  }
  if (scenario === "list-long") {
    const longify = (session: PiSidebarSession, index: number): PiSidebarSession => ({
      ...session,
      title: `第 ${index + 1} 组超长会话标题：统一侧边栏六套皮肤与移动端双模式手势阈值回归（长标题省略号测试）`,
      summary: `长摘要 ${index + 1}：正在对图六套深浅并校验抽屉宽度公式、左滑阈值与长按卡定位（第二行单行截断验证）`,
    })
    return {
      ...data,
      groups: [
        groupOf("pi", manySessions(10).map(longify)),
        groupOf("papers", manySessions(8).map(longify), true),
        groupOf("misc", manySessions(6).map(longify)),
      ],
    }
  }
  if (scenario === "empty") return { ...data, groups: [] }
  if (scenario === "search") return { ...data, search: { open: true, query: "relay", results: searchResultsOf(data.groups) } }
  return data
}

/* ------------------------------------------------------------------------------------------------
 * 纯 reducer（预览交互 + 单测；全部返回新 PiSidebarData，不改入参）
 * ---------------------------------------------------------------------------------------------- */

function cloneGroups(groups: readonly PiSidebarGroup[]): PiSidebarGroup[] {
  return groups.map((group) => ({ ...group, sessions: group.sessions.map((session) => ({ ...session, status: { ...session.status } })) }))
}

export function p11SelectSession(data: PiSidebarData, sessionKey: string): PiSidebarData {
  const groups = cloneGroups(data.groups)
  for (const group of groups) for (const session of group.sessions) session.selected = session.key === sessionKey
  return { ...data, groups, search: data.search.open ? { ...data.search, open: false } : data.search }
}

export function p11TogglePin(data: PiSidebarData, sessionKey: string): PiSidebarData {
  const groups = cloneGroups(data.groups)
  let target: PiSidebarSession | null = null
  let sourceGroupId: string | null = null
  for (const group of groups) {
    const index = group.sessions.findIndex((session) => session.key === sessionKey)
    if (index >= 0 && group.kind !== "pinned") {
      target = group.sessions[index]
      sourceGroupId = group.id
      group.sessions.splice(index, 1)
      group.count = group.sessions.length
      break
    }
    if (index >= 0 && group.kind === "pinned") {
      // 取消置顶：回原组
      const session = group.sessions[index]
      group.sessions.splice(index, 1)
      group.count = group.sessions.length
      const home = groups.find((candidate) => candidate.id === session.groupId)
      if (home) {
        home.sessions.push({ ...session, pinned: false })
        home.count = home.sessions.length
      }
      return { ...data, groups: groups.filter((candidate) => candidate.kind !== "pinned" || candidate.sessions.length > 0) }
    }
  }
  if (!target || !sourceGroupId) return data
  const pinned = groups.find((group) => group.kind === "pinned")
  const pinnedSession: PiSidebarSession = { ...target, pinned: true, groupId: sourceGroupId }
  if (pinned) {
    pinned.sessions.unshift(pinnedSession)
    pinned.count = pinned.sessions.length
  } else {
    groups.unshift({ id: "pinned", kind: "pinned", label: "置顶", collapsed: false, sessions: [pinnedSession], count: 1 })
  }
  return { ...data, groups }
}

export function p11ToggleArchive(data: PiSidebarData, sessionKey: string): PiSidebarData {
  const groups = cloneGroups(data.groups)
  for (const group of groups) {
    const index = group.sessions.findIndex((session) => session.key === sessionKey)
    if (index >= 0) {
      group.sessions.splice(index, 1)
      group.count = group.sessions.length
    }
  }
  return { ...data, groups: groups.filter((group) => group.kind !== "pinned" || group.sessions.length > 0) }
}

export function p11ToggleGroup(data: PiSidebarData, groupId: string): PiSidebarData {
  const groups = cloneGroups(data.groups).map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group))
  return { ...data, groups }
}

export function p11SelectDevice(data: PiSidebarData, deviceId: string): PiSidebarData {
  return { ...data, selectedDeviceId: deviceId, deviceMenuOpen: false, devices: data.devices.map((device) => ({ ...device, current: device.id === deviceId })) }
}

export function p11ToggleDeviceMenu(data: PiSidebarData, open?: boolean): PiSidebarData {
  return { ...data, deviceMenuOpen: open ?? !data.deviceMenuOpen }
}

export function p11Resize(data: PiSidebarData, width: number): PiSidebarData {
  return { ...data, width: clampWidth(width), collapsed: false }
}

export function p11ToggleCollapse(data: PiSidebarData): PiSidebarData {
  return { ...data, collapsed: !data.collapsed }
}

export function p11OpenSearch(data: PiSidebarData): PiSidebarData {
  return { ...data, search: { ...data.search, open: true } }
}

export function p11CloseSearch(data: PiSidebarData): PiSidebarData {
  return { ...data, search: { ...data.search, open: false } }
}

export function p11SetSearchQuery(data: PiSidebarData, query: string): PiSidebarData {
  const results = data.groups
    .flatMap((group) => group.sessions.map((session) => ({ kind: "session" as const, id: session.key, label: session.title, detail: group.label })))
    .filter((row) => !query.trim() || row.label.includes(query.trim()))
  return { ...data, search: { ...data.search, query, results: results.length ? results : undefined } }
}

/** 预览用 actions（绑定到 React setState；生产宿主自行实现） */
export function p11DevActions(setData: (updater: (data: PiSidebarData) => PiSidebarData) => void, hooks: { onNewSession?: () => void; onSettings?: () => void } = {}): PiSidebarActions {
  return {
    selectSession: (key) => setData((data) => p11SelectSession(data, key)),
    newSession: () => hooks.onNewSession?.(),
    selectDevice: (deviceId) => setData((data) => p11SelectDevice(data, deviceId)),
    toggleDeviceMenu: (open) => setData((data) => p11ToggleDeviceMenu(data, open)),
    addDevice: () => hooks.onNewSession?.(),
    togglePin: (key) => setData((data) => p11TogglePin(data, key)),
    toggleArchive: (key) => setData((data) => p11ToggleArchive(data, key)),
    toggleGroup: (groupId) => setData((data) => p11ToggleGroup(data, groupId)),
    togglePlainRow: () => {},
    openSearch: () => setData((data) => p11OpenSearch(data)),
    closeSearch: () => setData((data) => p11CloseSearch(data)),
    setSearchQuery: (query) => setData((data) => p11SetSearchQuery(data, query)),
    openSettings: () => hooks.onSettings?.(),
    resize: (width) => setData((data) => p11Resize(data, width)),
    toggleCollapse: () => setData((data) => p11ToggleCollapse(data)),
    openArchiveView: () => {},
    back: () => {},
    forward: () => {},
    selectLocalPage: () => {},
  }
}

/** 六套预设（arch gallery 注入接口） */
export { PI_SIDEBAR_GALLERY_PRESETS }
