/**
 * 呈现适配（P3.3：原 shared/mock.ts 里的纯函数，搬出来后参数一律必填，不读任何画廊数据）。
 * 把 relay 形状的数据（PiDeviceSession、PiAttentionItem、PiDevice、PiLinkView）算成侧栏 / 账户区要的呈现数据。
 * 画廊屏经开发画廊 fixtures/gallery/shared.ts 的同名包装补上画廊默认值。
 * 产品的分组逻辑在 ui/src/pi/model/sidebarGroups.ts：P5（a 线）起 piSessionGroups 委托过去，保持一份实现。
 */
import { sidebarGroups, type PiSidebarGroup, type PiSidebarRow } from "@/pi/model/sidebarGroups"
import { piAgo, piRelativeTime } from "./format"
import type {
  PiAttentionItem,
  PiDevice,
  PiDeviceSession,
  PiGrouping,
  PiLinkSummary,
  PiLinkView,
  PiListedSession,
  PiRowMarkerKind,
  PiSessionGroup,
  PiSessionRowData,
} from "./types"

/**
 * 行首标记（产品里是 rowMarkerOf(attention, busy, online, loaded)，design §10）：
 * 等你回答 > 出错未读 > 运行中 > 完成未读 > 未载入 > 空闲。
 */
export function piRowMarkerOf(row: Pick<PiListedSession, "id" | "busy" | "openable">, attention: PiAttentionItem[]): PiRowMarkerKind {
  const mine = attention.filter((a) => a.roomId === row.id)
  if (mine.some((a) => a.kind === "waiting")) return "waiting"
  if (mine.some((a) => a.kind === "error")) return "error"
  if (row.busy) return "running"
  if (mine.some((a) => a.kind === "done")) return "unread"
  if (!row.openable) return "unloaded"
  return "idle"
}

/** 会话行：标记、行尾相对时间（另带读屏用的全称 timeLabel）；所在设备离线时淡化（devices 里找不到设备时不淡化） */
export function piSessionRow(x: PiDeviceSession, now: number, attention: PiAttentionItem[], devices: PiDevice[]): PiSessionRowData {
  const device = devices.find((d) => d.id === x.deviceId)
  return {
    id: x.id,
    title: x.title,
    marker: piRowMarkerOf(x, attention),
    time: piRelativeTime(x.updatedAt, now),
    timeLabel: piAgo(x.updatedAt, now) || undefined,
    deviceId: x.deviceId,
    dimmed: device ? !device.online : false,
  }
}

/** 需要处理组的行（每条注意力一行；设备掉线条目行首换成设备图标，行尾灰字"未连接"） */
export function piAttentionRows(attention: PiAttentionItem[], now: number, devices: PiDevice[]): PiSessionRowData[] {
  return attention.map((a) => {
    if (a.kind === "device-offline") {
      const device = devices.find((x) => x.id === a.deviceId)
      return { id: a.key, title: a.title, marker: "idle", platform: device?.platform ?? "", trailingText: "未连接", deviceId: a.deviceId ?? undefined }
    }
    const marker: PiRowMarkerKind = a.kind === "waiting" ? "waiting" : a.kind === "error" ? "error" : "unread"
    return {
      id: a.roomId,
      title: a.title,
      marker,
      time: a.at ? piRelativeTime(a.at, now) : undefined,
      timeLabel: a.at ? piAgo(a.at, now) : undefined,
      deviceId: a.deviceId ?? undefined,
      // 设计 D §2.4 第二层：error 行的行尾时间位让位给状态词（行组件优先 trailingText）；完整时间在 time/timeLabel 里保留
      ...(a.kind === "error" ? { trailingText: "出错了" } : {}),
    }
  })
}

export interface PiGroupOptions {
  sessions: PiDeviceSession[]
  devices: PiDevice[]
  attention: PiAttentionItem[]
  now: number
  /** 只看这台设备（筛选生效）：组头只写目录名 */
  deviceId?: string | null
  /** 每组最多几行，其余折成"更多 N"（默认 5） */
  maxRows?: number
  /** v1.2（D-07）：分组方式，默认 "device"；"flat" = 只出一个按 updatedAt 倒序的平铺组 */
  grouping?: PiGrouping
  /** v1.2（M-08）：已展开"更多 N"的组 key（`${deviceId}:${cwd}`），这些组出全部行、末行"收起"；flat 模式忽略 */
  expanded?: string[]
  /** flat 模式的上限（默认 200，design §3.3） */
  limit?: number
}
/** flat 模式那一组的 key */
export const PI_FLAT_GROUP_KEY = "flat"
/** 模型的一行（行尾时间是时间戳）→ 部件的一行（piRelativeTime 的短写 + piAgo 的全称给读屏） */
export function piSidebarRowData(row: PiSidebarRow, now: number): PiSessionRowData {
  const { at, ...rest } = row
  return at ? { ...rest, time: piRelativeTime(at, now), timeLabel: piAgo(at, now) || undefined } : rest
}

/** 模型的组 → 部件的组（只换行；组的字段同名） */
export function piSidebarGroupData(group: PiSidebarGroup, now: number): PiSessionGroup {
  return { ...group, rows: group.rows.map((row) => piSidebarRowData(row, now)) }
}

/**
 * 按（设备, cwd）分组：P5 起委托给产品的分组逻辑 pi/model/sidebarGroups.ts（一套实现，画廊和产品同一口径），这里只把行尾时间戳
 * 换成部件要的短写 / 全称。规则：设备按 devices 的顺序（在线在前），组按设备 projects 的顺序；组内在线在前、再按 updatedAt 新到旧；
 * 只有一台设备、或筛选到一台时组头只写目录名（design §1.2）；flat（D-07）是一个按 updatedAt 倒序的列表，行带"设备/目录"副标题。
 */
export function piSessionGroups(opts: PiGroupOptions): PiSessionGroup[] {
  const { sessions, devices, attention, now, deviceId = null, maxRows = 5, grouping = "device", expanded = [], limit = 200 } = opts
  const model = sidebarGroups(sessions, devices, attention, { filter: deviceId, grouping, expanded, maxRows, limit })
  return model.groups.map((group) => piSidebarGroupData(group, now))
}

/** 账户区 / 列表状态的连接摘要 */
export function piLinkSummary(link: PiLinkView, devices: PiDevice[]): PiLinkSummary {
  switch (link.kind) {
    case "ok": {
      if (devices.length === 0) return { kind: "ok", text: "已连接 · 还没有设备" }
      const online = devices.filter((x) => x.online).length
      return { kind: "ok", text: online ? `已连接 · ${online} 台设备在线` : `已连接 · ${devices.length} 台设备都未连接` }
    }
    case "first":
      return { kind: "first", text: "正在连接…" }
    case "waiting":
      return { kind: "waiting", text: "与服务器断开" }
    case "reconnecting":
      return { kind: "reconnecting", text: "正在重连…" }
  }
}

/**
 * 打开 roomId 之后的注意力清单（design §5）：进入会话就清掉它的「完成 / 出错」条目；「等你回答」要等回答了才清，所以保留。
 * 屏幕里有当前会话时，PiSidebar 的 attention 和 piSessionGroups({ attention }) 都传它。
 */
export function piAttentionOnOpen(roomId: string | null | undefined, attention: PiAttentionItem[]): PiAttentionItem[] {
  if (!roomId) return attention
  return attention.filter((a) => !(a.roomId === roomId && a.kind !== "waiting"))
}

/**
 * 其他会话的注意力条数（手机对话页返回键的计数）：不含当前会话的条目；
 * 传了 currentDeviceId 时，也不含当前会话所在设备的「设备未连接」条目（页面里已经写着它离线）
 */
export function piOtherAttentionCount(currentRoomId: string, attention: PiAttentionItem[], currentDeviceId?: string | null): number {
  return attention.filter(
    (a) => a.roomId !== currentRoomId && !(a.kind === "device-offline" && currentDeviceId != null && a.deviceId === currentDeviceId),
  ).length
}
