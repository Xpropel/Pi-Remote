/**
 * P11 侧栏数据适配纯函数（arch 冻结；dev 的 useSidebarModel Hook 只做 relay→本文件的接线，不重复业务规则）。
 *
 * 规则来源：p11-spec §6（适配决策）+ 设计 D 册 §3/§8/§10。**无 React / DOM / localStorage 依赖**，node --test 直载。
 * 诚实降级（spec §6.8）：运行/等待/出错只在 relay 有对应真实状态时显示；无法判定一律 idle，不显示假 chip/假进度；
 * 摘要无事件 = 空串（行高不变），不编造。
 */
import type {
  PiSessionTone,
  PiSidebarDevice,
  PiSidebarGroup,
  PiSidebarSession,
  PiSidebarStatus,
} from "./types.ts"

const STATUS_LABEL: Record<PiSessionTone, string> = {
  running: "运行中",
  waiting: "等待",
  error: "出错",
  idle: "空闲",
}

export interface PiSidebarTurnStateInput {
  /** relay room 正在处理（busy/turn 进行中） */
  running?: boolean
  /** 待审批/待回答（attention） */
  waiting?: boolean
  /** 最近 turn 出错 */
  error?: boolean
}

/**
 * 状态优先级：error > waiting > running > idle。
 * `showChip` 只对能判定的 running 为真（主区「运行中」chip / 移动顶栏），其余不显示。
 */
export function sidebarStatusOf(input: PiSidebarTurnStateInput = {}): PiSidebarStatus {
  const tone: PiSessionTone = input.error ? "error" : input.waiting ? "waiting" : input.running ? "running" : "idle"
  return { tone, showChip: tone === "running", label: STATUS_LABEL[tone] }
}

export function sidebarToneLabel(tone: PiSessionTone): string {
  return STATUS_LABEL[tone]
}

/** 稳定 session key（pin/archive 持久化）：deviceId::roomOrSessionId；空段用 "-" 占位，绝不写标题/路径。 */
export function sidebarSessionKeyOf(deviceId: string, sessionId: string): string {
  const d = String(deviceId || "").trim() || "-"
  const s = String(sessionId || "").trim() || "-"
  return `${d}::${s}`
}

/** 相对时间（与现有桌面语义一致）：刚刚 / Nm / Nh / 昨天 / M月D日。 */
export function relativeTimeLabel(now: number, at: number | undefined | null): string {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return ""
  const diff = Math.max(0, now - at)
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  const d = new Date(at)
  const n = new Date(now)
  const startOfToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  if (at >= startOfToday - 86_400_000 && at < startOfToday) return "昨天"
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 会话摘要行：只有真实事件一句人话；没有就返回空串（移动列表行高不变，不编造）。 */
export function sidebarSummaryLineOf(summary: unknown): string {
  const text = typeof summary === "string" ? summary.trim() : ""
  return text.slice(0, 160)
}

/** 工作区分组 id：按项目 cwd；无 cwd 归「未分组」。 */
export function sidebarWorkspaceGroupId(cwd: string | undefined): string {
  const path = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").trim()
  return path ? `cwd:${path}` : "ungrouped"
}

/** 工作区显示名：cwd 最后一段（根路径保留 "/"）。 */
export function sidebarWorkspaceLabel(cwd: string | undefined): string {
  const path = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "").trim()
  if (!path) return "未分组"
  if (path === "/") return "/"
  return path.split("/").filter(Boolean).pop() || path
}

export interface PiSidebarPinArchiveOverlay {
  pins?: readonly string[]
  archives?: readonly string[]
}

export interface PiSidebarGroupsInput extends PiSidebarPinArchiveOverlay {
  groups: readonly PiSidebarGroup[]
  /** 归档视图（朴素行「归档」打开时为 true：展示 archives，不展示 pins 特殊处理） */
  archiveView?: boolean
}

/**
 * 把 pin/archive 叠加到基础组：
 * - 非归档视图：archived 行隐藏；pinned 行从原组移出，按 pins 顺序进入置顶组（P11-SIDE-13），置顶组在朴素行下、工作区上；
 * - 归档视图：只保留 archived 行（组内为空则整组隐藏）。
 * 组 count 始终 = 当前可见行数。
 */
export function sidebarGroupsWithOverlay(input: PiSidebarGroupsInput): PiSidebarGroup[] {
  const pins = Array.isArray(input.pins) ? input.pins : []
  const archives = Array.isArray(input.archives) ? input.archives : []
  const archiveSet = new Set(archives)
  const pinIndex = new Map(pins.map((key, i) => [key, i]))
  const archiveView = input.archiveView === true
  const pinnedSessions: PiSidebarSession[] = []
  const groups: PiSidebarGroup[] = []
  for (const group of input.groups) {
    const sessions: PiSidebarSession[] = []
    for (const session of group.sessions) {
      const isArchived = archiveSet.has(session.key) || session.archived
      if (archiveView) {
        if (isArchived) sessions.push({ ...session, pinned: false, archived: true })
        continue
      }
      if (isArchived) continue
      if (pinIndex.has(session.key) || session.pinned) pinnedSessions.push({ ...session, pinned: true, archived: false })
      else sessions.push({ ...session, pinned: false })
    }
    if (archiveView && sessions.length === 0) continue
    groups.push({ ...group, sessions, count: sessions.length })
  }
  if (archiveView) return groups
  pinnedSessions.sort((a, b) => {
    const ia = pinIndex.has(a.key) ? (pinIndex.get(a.key) as number) : Number.MAX_SAFE_INTEGER
    const ib = pinIndex.has(b.key) ? (pinIndex.get(b.key) as number) : Number.MAX_SAFE_INTEGER
    return ia - ib || a.key.localeCompare(b.key)
  })
  if (pinnedSessions.length === 0) return groups
  const pinnedGroup: PiSidebarGroup = {
    id: "pinned",
    kind: "pinned",
    label: "置顶",
    collapsed: false,
    sessions: pinnedSessions,
    count: pinnedSessions.length,
  }
  return [pinnedGroup, ...groups]
}

/**
 * 选中设备（当前绑定；没有选中或不在名册时回退第一台），设备行 current 标记由本函数产出。
 * 只列真实设备（不虚构）；名册空 → null。
 */
export function selectedDeviceOf(devices: readonly PiSidebarDevice[], selectedDeviceId: string | null | undefined): PiSidebarDevice | null {
  if (!devices.length) return null
  const wanted = String(selectedDeviceId || "")
  return devices.find((device) => device.id === wanted) ?? devices[0]
}

/** 设备菜单行：当前设备 statusLabel="当前"；其余在线/离线。真实设备才出现。 */
export function sidebarDeviceRows(devices: readonly PiSidebarDevice[], selectedDeviceId: string | null | undefined): PiSidebarDevice[] {
  const selected = selectedDeviceOf(devices, selectedDeviceId)
  return devices.map((device) => ({
    ...device,
    current: !!selected && device.id === selected.id,
    statusLabel: !!selected && device.id === selected.id ? "当前" : device.online ? "在线" : "离线",
  }))
}

/**
 * 构建移动/桌面共用的 identity 文本：中转服务器名（不是用户名）。
 * serverName 空 → hostname（去端口）；两者都空 → 固定兜底。与 model/serverName.ts 同源规则（此处避免跨层 import）。
 */
export function sidebarIdentityNameOf(serverName: string | undefined | null, hostname: string | undefined | null): string {
  const name = String(serverName || "").trim()
  if (name) return name.slice(0, 64)
  const host = String(hostname || "").trim()
  if (host) return host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "") || host
  return "本机 relay"
}

/** 可见会话总数（不含隐藏的 archived；供 header 计数/测试）。 */
export function sidebarVisibleSessionCount(groups: readonly PiSidebarGroup[]): number {
  return groups.reduce((sum, group) => sum + group.sessions.length, 0)
}

/** 置顶/归档后的稳定排序结果（仅返回 key 列表，便于本地状态测试）。 */
export function sidebarPinOrderOf(sessions: readonly PiSidebarSession[], pins: readonly string[]): string[] {
  const indexed = new Map(pins.map((key, i) => [key, i]))
  return sessions
    .filter((session) => indexed.has(session.key))
    .sort((a, b) => (indexed.get(a.key) as number) - (indexed.get(b.key) as number) || a.key.localeCompare(b.key))
    .map((session) => session.key)
}
