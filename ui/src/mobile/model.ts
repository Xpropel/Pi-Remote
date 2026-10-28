/**
 * 第 3 章移动端 P0 的纯逻辑层（不依赖 React / DOM，可在 Node 里直接单测）。
 *
 * 这里只放「会同时被路由、视口和 CSS 消费的尺寸/状态」：
 * - 断点口径：桌面壳从 1024 开始；< 1024 由移动壳接管，其中 < 768 是手机尺寸。
 * - 路由口径：/m 与普通路径共用 ?device=&session= 查询参数（服务端对无扩展名
 *   路径有 SPA 回退，query 最不挑部署方式）。
 * - 尺寸口径：52 顶栏、48 设备栏、52 会话行、页面边距四档（布局 V2 定版）。
 * - 文案口径：SessionMeta 只允许 5 种状态；时间只用真实 updatedAt/lastActivity。
 */

/** 桌面壳起点：与 design-tokens 的 --bp-md、shell/breakpoints 保持一致。 */
export const MOBILE_SHELL_MAX = 1023
/** 手机尺寸起点：第 3 章「CSS 宽度小于 768」。 */
export const PHONE_MAX = 767

/** 桌面壳和移动壳的分界（< 1024 都是移动壳，768–1023 用 tablet 内容列）。 */
export function isMobileShellWidth(width: number): boolean {
  return Number.isFinite(width) && width <= MOBILE_SHELL_MAX
}

export function isPhoneWidth(width: number): boolean {
  return Number.isFinite(width) && width <= PHONE_MAX
}

/** §3.8 页面边距四档：320–359:12 / 360–430:16 / 431–600:20 / 601+:24。 */
export function pagePadding(width: number): number {
  if (!Number.isFinite(width) || width < 360) return 12
  if (width <= 430) return 16
  if (width <= 600) return 20
  return 24
}

/** 内容列最大宽度；矮屏横屏放宽到 760（§3.2.4）。 */
export function contentMaxWidth(height: number): number {
  return height <= 480 ? 760 : 720
}

/** 该内容列是否生效（<=600 全宽，不设上限）。 */
export function usesContentMax(width: number): boolean {
  return width > 600
}

export function isCompactHeight(height: number): boolean {
  return Number.isFinite(height) && height <= 620
}

export function isShortHeight(height: number): boolean {
  return Number.isFinite(height) && height <= 480
}

/** 顶栏内容行：布局 V2 固定 52（触控命中区需要，短高度不再降档）。 */
export function topBarHeight(_height: number): number {
  return 52
}

/** 设备上下文条：布局 V2 固定 48。 */
export function deviceBarHeight(_height: number): number {
  return 48
}

/** 会话行最小高度：布局 V2 固定 52（标题 14/19 + 副文 12/17 + 7×2 内边距）。 */
export function sessionRowHeight(_height: number): number {
  return 52
}

export type MobileRoute =
  | { screen: "index"; deviceId?: string }
  | { screen: "conversation"; sessionId: string; deviceId?: string }

function clean(value: string | null): string {
  return (value || "").trim()
}

/** 从 location.search 解析；没有 session 就是列表。 */
export function parseMobileRoute(search: string): MobileRoute {
  const params = new URLSearchParams(search)
  const sessionId = clean(params.get("session"))
  const deviceId = clean(params.get("device"))
  if (sessionId) return deviceId ? { screen: "conversation", sessionId, deviceId } : { screen: "conversation", sessionId }
  return deviceId ? { screen: "index", deviceId } : { screen: "index" }
}

/**
 * 生成路由 URL：保留调用方已有的其他 query，只写/删 device、session。
 * 列表页保留 device（刷新后仍回到同一台设备），对话页同时写 session。
 */
export function mobileRouteUrl(pathname: string, search: string, hash: string, route: MobileRoute): string {
  const params = new URLSearchParams(search)
  if (route.deviceId) params.set("device", route.deviceId)
  else params.delete("device")
  if (route.screen === "conversation") params.set("session", route.sessionId)
  else params.delete("session")
  const query = params.toString()
  return `${pathname}${query ? `?${query}` : ""}${hash || ""}`
}

export function routeSession(route: MobileRoute): string {
  return route.screen === "conversation" ? route.sessionId : ""
}

/** SessionMeta 只允许这 5 种文案（§3.1.3），不把「运行中/待载入」等内部词漏到顶栏。 */
export type MobileStatus = "已连接" | "正在连接" | "已断开" | "正在输出" | "等待设备上线"

export type MobileStatusInput = {
  online: boolean
  everConnected: boolean
  busy: boolean
  roomDown?: boolean
  hasDevice?: boolean
  deviceOnline?: boolean | null
}

export function mobileStatusText(input: MobileStatusInput): MobileStatus {
  if (input.hasDevice && input.deviceOnline === false) return "等待设备上线"
  if (input.roomDown) return "已断开"
  if (!input.online) return input.everConnected ? "已断开" : "正在连接"
  if (input.busy) return "正在输出"
  return "已连接"
}

export type StatusTone = "ok" | "warn" | "bad"

export function mobileStatusTone(status: MobileStatus): StatusTone {
  if (status === "已连接" || status === "正在输出") return "ok"
  if (status === "正在连接") return "warn"
  return "bad"
}

/** SessionMeta 的「设备名 · 状态」格式；设备名缺失时用「本机」。 */
export function mobileMetaText(deviceName: string | null | undefined, status: MobileStatus): string {
  return `${clean(deviceName || "") || "本机"} · ${status}`
}

/** 设备栏第二行：状态 + 会话数（§3.7.1）。 */
export function deviceContextText(online: boolean, sessionCount: number): string {
  return `${online ? "已连接" : "未连接"} · ${sessionCount} 个会话`
}

/** 首页设备栏的会话数：设备模式用当前设备名册，本机模式用打开中的房间数。 */
export function deviceSessionCount(deviceMode: boolean, listedCount: number, roomCount: number): number {
  return deviceMode ? listedCount : roomCount
}

/**
 * 会话行右侧时间：只消费真实的 updatedAt / lastActivity，缺失时返回空串。
 * 与桌面 sidebar 的 relativeTime 同文案，但保持独立纯函数，避免移动层 import
 * parts.tsx（源码测试禁止 parts.tsx 出现 relativeTime）。
 */
export function mobileSessionTime(ts: number | null | undefined, now = Date.now()): string {
  const at = Number(ts) || 0
  if (!at) return ""
  const diff = now - at
  if (diff < 60_000) return "刚刚"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(at)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 路由层判定：应该把当前页面当成列表还是对话。 */
export function routeIsConversation(route: MobileRoute): route is Extract<MobileRoute, { screen: "conversation" }> {
  return route.screen === "conversation"
}

/** 可见高度 < 560 时，P1 的 Sheet/Peek 与 Half 合并；P0 先留出判定函数给测试。 */
export function sheetMiddleHeight(height: number): number {
  return height < 560 ? 0.64 : 0.56
}


/** 设备切换弹层排序：当前设备固定第 1 位，其余在线优先、最近上线其次。 */
export type SwitcherDevice = {
  id: string
  name: string
  online: boolean
  lastAttachAt: number | null
}

export function sortDevicesForSwitcher<T extends SwitcherDevice>(devices: readonly T[], selectedId: string | null | undefined): T[] {
  const current = selectedId ? devices.find((device) => device.id === selectedId) || null : null
  const rest = devices.filter((device) => device.id !== current?.id).sort((a, b) => {
    const online = Number(b.online) - Number(a.online)
    if (online) return online
    const recent = (Number(b.lastAttachAt) || 0) - (Number(a.lastAttachAt) || 0)
    if (recent) return recent
    return a.name.localeCompare(b.name, "zh-Hans-CN") || a.id.localeCompare(b.id)
  })
  return current ? [current, ...rest] : rest
}
