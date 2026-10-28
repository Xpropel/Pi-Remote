/**
 * 桌面壳的纯展示逻辑（不依赖 React / DOM），供 Sidebar / TopBar / 单测共用。
 *
 * 数据原则：只读 relay 真实字段。ListedSession 没有“最后一条消息预览”，
 * 所以副标题只显示 cwd；没有 updatedAt 时再回落到房间的 lastActivity，
 * 两者都没有就留空，绝不编造时间或预览。
 */
import type { DesktopBreakpoint } from "./breakpoints.ts"

export type SidebarMode = "expanded" | "rail"

export type SessionRowLike = {
  id: string
  title: string
  cwd: string
  openable: boolean
  busy: boolean
  updatedAt: number
}

export type RoomLike = {
  id: string
  lastActivity: number
}

/** md（1024–1279）默认 rail；lg 以上默认展开。 */
export function sidebarDefault(bp: DesktopBreakpoint): SidebarMode {
  return bp === "md" ? "rail" : "expanded"
}

/** 与壳内布局变量一致的侧栏宽度（仅用于测试 / 可访问性文案，不参与布局计算）。 */
export function sidebarWidth(bp: DesktopBreakpoint, mode: SidebarMode): number {
  if (mode === "rail") return 48
  return bp === "md" ? 240 : 256
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function hhmm(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 会话时间的四档格式（§2.5.3）：
 * 今天 → HH:mm；昨天 → 昨天 HH:mm；今年 → M月d日；跨年 → yyyy/M/d。
 * 没有真实时间（0 / NaN / 负数）时返回空串。
 */
export function sessionTimeLabel(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return ""
  const then = new Date(updatedAt)
  const current = new Date(now)
  if (!Number.isFinite(then.getTime()) || !Number.isFinite(current.getTime())) return ""
  const dayDelta = Math.round((startOfDay(current) - startOfDay(then)) / 86_400_000)
  if (dayDelta <= 0) return hhmm(then)
  if (dayDelta === 1) return `昨天 ${hhmm(then)}`
  if (then.getFullYear() === current.getFullYear()) return `${then.getMonth() + 1}月${then.getDate()}日`
  return `${then.getFullYear()}/${then.getMonth() + 1}/${then.getDate()}`
}

/** 副标题降级：只显示会话工作目录；没有就留空（不用 firstMessage 冒充最后一条）。 */
export function sessionPreview(row: Pick<SessionRowLike, "cwd">): string {
  return row.cwd || ""
}

/** 活动房间的 row.updatedAt 由 mergeDeviceSessions 置 0，用 relay 真实 lastActivity 补时间。 */
export function sessionActivityAt(row: Pick<SessionRowLike, "id" | "updatedAt">, rooms: readonly RoomLike[]): number {
  if (Number.isFinite(row.updatedAt) && row.updatedAt > 0) return row.updatedAt
  const room = rooms.find((item) => item.id === row.id)
  return room && Number.isFinite(room.lastActivity) && room.lastActivity > 0 ? room.lastActivity : 0
}

export type LinkState = "connected" | "reconnecting" | "offline"

/** §2.7.2：断线 30s 仍未恢复，胶囊/状态点从“重连中”转“离线”。 */
export const LINK_DEGRADE_MS = 30_000
/** §2.7.2：恢复瞬间整条转绿，1.6s 后以 200ms 收起。 */
export const LINK_RECOVERED_MS = 1_600
export const LINK_RECOVERED_FADE_MS = 200

/**
 * 链路终态映射：不直接渲染 relay.status 的过程文案。
 * 30s 降级与恢复态由 useLinkState 叠加；这里只做即时三态。
 */
export function linkStateOf(input: { authed: boolean; everConnected: boolean; retryAt: number | null }): LinkState {
  if (input.authed) return "connected"
  if (input.everConnected || input.retryAt != null) return "reconnecting"
  return "offline"
}

/** 叠加“断线已持续多久”后的展示态；只把重连中降级为离线，不把首次连接误判为离线。 */
export function degradedLinkState(state: LinkState, downForMs: number): LinkState {
  if (state !== "reconnecting") return state
  return Number.isFinite(downForMs) && downForMs >= LINK_DEGRADE_MS ? "offline" : "reconnecting"
}

export function linkLabel(state: LinkState): string {
  if (state === "connected") return "已连接"
  if (state === "reconnecting") return "重连中"
  return "离线"
}

/** 连接状态点的颜色由 CSS 令牌决定，这里只给稳定语义。 */
export function linkTone(state: LinkState): "ok" | "warn" | "muted" {
  return state === "connected" ? "ok" : state === "reconnecting" ? "warn" : "muted"
}
