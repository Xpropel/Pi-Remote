/**
 * 设备图标行 / 会话行的纯展示逻辑（不依赖 React）。
 *
 * 设备展示顺序：先按在线/离线分组（在线在前），同一组内按首次连接时间从早到晚。
 * 首次连接时间来自 relay 的持久 firstSeenAt；老 relay / 老行没有该字段时回退 lastAttachAt，不伪造。
 * lastSeen 仅保留类型兼容，不再参与排序；点击设备只改 selected，不改变顺序。
 */
import {
  platformLabel,
  relativeTime,
  windowRemainText,
  type Device,
  type ListedSession,
} from "../relay/devices.ts"

export const DEVICE_STRIP_LIMIT = 5
/** 桌面壳的设备行 / rail 设备栈上限（§2.3.3：最多 6 个，超出显示 +N）。 */
export const SHELL_DEVICE_LIMIT = 6

export type StripDevice = Device & {
  /** 兼容字段，不再参与排序。 */
  lastSeen?: number | null
}

export type DeviceGlyph = "laptop" | "monitor" | "terminal"

export type DeviceTooltipData = {
  name: string
  platform: string
  online: boolean
  status: string
  details: string[]
}

function stamp(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/** 最近活跃时间（tooltip / 兼容保留）：优先看可选 lastSeen，再回落到 lastAttachAt。 */
export function deviceActivityAt(device: StripDevice): number {
  return Math.max(stamp(device.lastSeen), stamp(device.lastAttachAt))
}

/** 首次连接时间：firstSeenAt 为主；老数据没有该字段时回退 lastAttachAt，不伪造。 */
export function deviceFirstSeenAt(device: StripDevice): number {
  return stamp(device.firstSeenAt) || stamp(device.lastAttachAt)
}

/** 缺失首次连接时间的设备排在有时刻的设备之后（0 不参与“最早”竞争）。 */
function firstSeenRank(device: StripDevice): number {
  return deviceFirstSeenAt(device) || Number.POSITIVE_INFINITY
}

/** 在线优先；同组内首次连接从早到晚；时间相同用名称和 id 保持稳定顺序。 */
export function sortDevicesForStrip(devices: readonly StripDevice[]): StripDevice[] {
  return [...devices].sort((a, b) => {
    const online = Number(b.online) - Number(a.online)
    if (online) return online
    const firstA = firstSeenRank(a)
    const firstB = firstSeenRank(b)
    if (firstA !== firstB) return firstA < firstB ? -1 : 1
    return a.name.localeCompare(b.name, "zh-Hans-CN") || a.id.localeCompare(b.id)
  })
}

/** 图标行默认前 5 台；桌面壳传 6。overflow 是余下设备数，用来显示 +N。 */
export function stripDeviceSelection(
  devices: readonly StripDevice[],
  limit = DEVICE_STRIP_LIMIT,
): {
  visible: StripDevice[]
  overflow: number
} {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEVICE_STRIP_LIMIT
  const sorted = sortDevicesForStrip(devices)
  return {
    visible: sorted.slice(0, max),
    overflow: Math.max(0, sorted.length - max),
  }
}

/** 平台到图标：macOS 笔记本、Windows 显示器、Linux 终端，其它平台回落显示器。 */
export function deviceGlyph(platform: string | null | undefined): DeviceGlyph {
  const key = (platform || "").trim().toLowerCase()
  if (key === "macos" || key === "darwin") return "laptop"
  if (key === "linux") return "terminal"
  return "monitor"
}

/**
 * tooltip 只读取 relay 真实字段。
 * - 在线：平台 / 已连接 / 连接于多久前 / 连接窗口剩余（有 windowExpiresAt 时）
 * - 离线：平台 / 未连接 / 上次上线（有 lastAttachAt 时）
 * 没有 RTT、速率或在线时长外推：relay 未下发这些数据。
 */
export function deviceTooltipData(device: StripDevice, now = Date.now()): DeviceTooltipData {
  const details: string[] = []
  if (device.online) {
    if (device.lastAttachAt) details.push(`连接于 ${relativeTime(device.lastAttachAt, now)}`)
    if (device.windowExpiresAt != null) {
      const remain = windowRemainText(device.windowExpiresAt - now)
      details.push(remain === "已到期" ? "连接窗口已到期" : `连接窗口剩余 ${remain}`)
    }
  } else if (device.lastAttachAt) {
    details.push(`上次上线 ${relativeTime(device.lastAttachAt, now)}`)
  }
  return {
    name: device.name,
    platform: platformLabel(device.platform),
    online: device.online,
    status: device.online ? "已连接" : "未连接",
    details,
  }
}

/** 只看这一行是否该转 spinner：当前会话听 relay.busy，其它行只有在线的 row.busy 才算。 */
export function sessionShowsSpinner(
  row: Pick<ListedSession, "id" | "openable" | "busy">,
  activeRoomId: string,
  activeBusy: boolean,
): boolean {
  if (row.id === activeRoomId) return activeBusy
  return row.openable && row.busy
}
