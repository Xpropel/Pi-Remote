/**
 * 协议 v4 的网页侧（契约见 DOC/71，机器可读部分的唯一事实源是仓库根的 protocol/v4.json）。
 * 纯逻辑、不依赖 React，便于单测。
 */

export const PROTO = 4

/** 网页声明自己懂的能力（device.token：名册的 auth/paired 字段、配对与撤销；
 *  dialog.respond：O2 对话框应答面——relay 按此 cap 给应答卡保留 answerable，
 *  未声明的旧端只收只读观察卡；
 *  dialog.multiselect：G3 多选对话框增量——UI 能渲染多选卡并回传 values 数组，
 *  relay 只给同时声明了 dialog.respond 与本 cap 的端保留多选卡的 answerable；
 *  room.attention：R3-1 注意力恢复通道——UI 消费 room_list 条目的 lastTurnEnd
 *  摘要与 room_attention 帧，relay 按此 cap 分流，未声明的旧端不收摘要；
 *  room.dialogs：P9 A 房间等待摘要——UI 消费 room_list 条目的 waiting/waitingPrompt
 *  与 room_waiting 帧（每帧全量替换），relay 按此 cap 分流，未声明的旧端拿到的名册
 *  条目和以前一样；
 *  room.activity：设计 D §2.3 房间最近事件摘要——UI 消费 room_list 条目的
 *  lastEvent{type,toolName?,at} 生成 busy 中的状态短语，relay 按此 cap 分流，
 *  未声明的旧端拿到的名册条目和以前一样（无 lastEvent 时状态行回落"运行中"）；
 *  session.purge：P9 B 删除后清理服务器副本——设备确认删除成功后 relay 清副本并广播
 *  session_removed，网页不用刷新就摘掉那一行；
 *  prefs.sync：R4-1 主题偏好跨设备同步——UI 上行 prefs_set、消费 auth 快照的
 *  prefs 字段与 prefs_changed/prefs_saved 帧，relay 按此 cap 分流，未声明的旧端
 *  不带快照字段、不收广播；
 *  room.inbox：设计 D §1 全局待答收件箱账本——UI 消费 auth/room_list 附带的 inbox
 *  快照与 inbox_update 增量帧、上行 inbox_dismiss，relay 按此 cap 分流，未声明的
 *  旧端不带快照字段、不收增量帧；
 *  room.schedule：设计 D §3 定时/心跳排期——UI 消费 room_list 条目内的 schedules
 *  与 schedule_update 单房全量替换帧、上行 schedule_create/cancel/list（relay 本地
 *  命令），relay 按此 cap 分流，未声明的旧端名册条目无 schedules 字段、不收广播）。
 *  声明必须与落地同轮（第 2 轮审查 A-6）：UI 实际在用应答面却不声明，
 *  relay 一旦落 cap 门控就会把自己的应答面剥掉。
 *  room.label / sync.v3 / session.files / fs.browse 是 local / 设备通道的能力，网页不声明。 */
export const VIEWER_CAPS = ["err.v4", "msg.cid", "device.token", "dialog.respond", "dialog.multiselect", "room.attention", "room.dialogs", "room.activity", "session.purge", "prefs.sync", "room.inbox", "room.schedule"] as const

export const CLIENT_VERSION = "4.0.0"

export type Cap =
  | "err.v4"
  | "msg.cid"
  | "device.token"
  | "dialog.respond"
  | "dialog.multiselect"
  | "room.attention"
  | "room.dialogs"
  | "room.activity"
  | "session.purge"
  | "prefs.sync"
  | "room.inbox"
  | "room.schedule"
  | "room.label"
  | "sync.v3"
  | "health"

/** relay 在 auth_result 里声明的版本与能力。旧 relay 不带 proto：记 3、能力为空，调用方据此保留 v3 的猜测逻辑。 */
export type ServerInfo = { proto: number; caps: string[]; /** P11 身份行：relay 可选显示名（旧 relay 无） */ serverName?: string }

export const V3_SERVER: ServerInfo = { proto: 3, caps: [] }

export function authFrame(token: string) {
  return {
    type: "auth",
    role: "viewer",
    proto: PROTO,
    caps: [...VIEWER_CAPS],
    client: { kind: "viewer", version: CLIENT_VERSION },
    token,
  }
}

/** 管理命令的单独口令校验失败码；普通查看/发消息不需要 adminToken。 */
export const ADMIN_REQUIRED = "admin_required"

/** 生成配对码：adminToken 只放在这条命令帧里，不参与 viewer 握手、不进 URL。 */
export function pairCreateFrame(adminToken: string) {
  return { type: "pair_create", adminToken }
}

/** 撤销设备：adminToken 只放在这条命令帧里，不参与 viewer 握手、不进 URL。 */
export function deviceRevokeFrame(deviceId: string, adminToken: string) {
  return { type: "device_revoke", deviceId, adminToken }
}

/**
 * 二维码设备链接第一步（qr-pairing §3.2）：手机扫码落地后按码查待链接设备的非秘密元数据
 * （name / platform / expiresAt / checkDigits，checkDigits 由 relay 下发、页面只显示不计算）。
 * 只查不核销：码不存在 / 已过期 / 不是待链接条目回 pair_invalid / pair_expired。
 */
export function pairLookupFrame(code: string) {
  return { type: "pair_lookup", code }
}

/**
 * 二维码设备链接第二步：管理员在落地页确认后才核销码、签发设备令牌（沿待链接连接下发给 pi 运行端）。
 * adminToken 与 pair_create 同门，只放在这条命令帧里，不参与 viewer 握手、不进 URL。
 */
export function pairApproveFrame(code: string, adminToken: string) {
  return { type: "pair_approve", code, adminToken }
}

export function serverInfo(msg: { proto?: unknown; caps?: unknown; serverName?: unknown }): ServerInfo {
  const proto = typeof msg.proto === "number" && Number.isInteger(msg.proto) && msg.proto > 0 ? msg.proto : 3
  if (proto < 4) return V3_SERVER
  const caps = Array.isArray(msg.caps) ? msg.caps.filter((cap): cap is string => typeof cap === "string" && !!cap) : []
  const info: ServerInfo = { proto, caps: [...new Set(caps)] }
  // P11 additive：relay 可选中转服务器显示名（不含用户身份）；旧 relay 没有该字段
  if (typeof msg.serverName === "string" && msg.serverName.trim()) info.serverName = msg.serverName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64)
  return info
}

export function hasCap(info: ServerInfo, cap: Cap): boolean {
  return info.caps.includes(cap)
}

const CID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isCid(value: unknown): value is string {
  return typeof value === "string" && CID_RE.test(value)
}

let cidSeq = 0

/** 消息 id：时间 + 页内序号 + 随机段，同一页面内不重复，跨页面/跨设备撞上的概率可以忽略 */
export function newCid(now = Date.now()): string {
  cidSeq = (cidSeq + 1) % 1_000_000
  const random = Math.random().toString(36).slice(2, 10).padEnd(8, "0")
  return `w${now.toString(36)}-${cidSeq.toString(36)}-${random}`
}
