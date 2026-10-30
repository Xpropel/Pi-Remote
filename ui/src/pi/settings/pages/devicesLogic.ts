/**
 * 设置 › 设备 · 纯展示逻辑（无 React / 无 DOM，node --test 直载）。
 *
 * 只做名册字段的文案化：在线 / 离线、上次在线时间、平台、心跳延迟。
 * 延迟来自 relay 的 keepalive ping/pong（devices[].latencyMs）；没有样本 / 离线 / 旧 relay
 * 一律显示「延迟 —」，本文件不生成假延迟，也不拿当前会话或上次连接的值外推。
 */

export type DevicePlatformKind = "mac" | "windows" | "linux" | "other"

export interface DeviceLike {
  name?: string | null
  platform?: string | null
  online?: boolean
  bridgeOnline?: boolean
  lastAttachAt?: number | null
  latencyMs?: number | null
}

/** 「测试连接」的往返口径：浏览器发设备命令，经 relay 到设备再回来，不是单纯的 relay HTTP 延迟。 */
export const DEVICE_RTT_SCOPE = "设备 ↔ 服务器"

/** 设备心跳延迟：在线且 relay 给过样本才显示整数毫秒，否则「延迟 —」。 */
export function deviceLatencyTextOf(latencyMs: number | null | undefined): string {
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) return "延迟 —"
  return `延迟 ${Math.round(latencyMs)}ms`
}

/** 一次「测试连接」往返的显示值；负数 / 非有限值按 0 处理（performance 时钟异常时也不写负延迟）。 */
export function deviceRoundTripTextOf(ms: number | null | undefined): string {
  const value = typeof ms === "number" && Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0
  return `${value} ms`
}

/** relay 已把 darwin / win32 归一成 macos / windows；这里兼容老数据与大小写。 */
export function devicePlatformKindOf(platform: string | null | undefined): DevicePlatformKind {
  const value = (platform ?? "").trim().toLowerCase()
  if (value === "macos" || value === "darwin" || value === "mac") return "mac"
  if (value === "windows" || value === "win32") return "windows"
  if (value === "linux") return "linux"
  return "other"
}

/** 平台显示名；未知平台不硬猜，显示 relay 原值（空则「设备」）。 */
export function platformLabelOf(platform: string | null | undefined): string {
  const kind = devicePlatformKindOf(platform)
  if (kind === "mac") return "macOS"
  if (kind === "windows") return "Windows"
  if (kind === "linux") return "Linux"
  return (platform ?? "").trim() || "设备"
}

export function deviceNameOf(device: DeviceLike): string {
  const name = (device.name ?? "").trim()
  return name || platformLabelOf(device.platform)
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function startOfDay(value: number): number {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * 上次在线：今天 / 昨天 / 月日 / 年月日 + HH:mm。
 * 无效时间返回空串，页面据此只写「离线」，不编时间。
 */
export function lastOnlineTextOf(at: number | null | undefined, now: number): string {
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) return ""
  const date = new Date(at)
  const current = new Date(now)
  if (Number.isNaN(date.getTime())) return ""
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days === 0) return `今天 ${time}`
  if (days === 1) return `昨天 ${time}`
  if (date.getFullYear() === current.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

/** 设备行状态：`在线 · 当前设备` / `离线 · 上次在线 昨天 21:40`。 */
export function deviceStatusTextOf(device: DeviceLike, current: boolean, now: number): string {
  if (device.online === true) {
    // Attach window connected but no pi bridge (extension) authenticated:
    // the device cannot mirror or deliver anything, so it must not read as
    // plainly online (A3-F1). Old relays omit bridgeOnline; only an explicit
    // false is the degraded state.
    if (device.bridgeOnline === false) return current ? "仅远程窗口在线 · 当前设备" : "仅远程窗口在线"
    return current ? "在线 · 当前设备" : "在线"
  }
  const last = lastOnlineTextOf(device.lastAttachAt, now)
  return last ? `离线 · 上次在线 ${last}` : "离线"
}
