/** 未载入会话的本地状态机（不依赖 React）。
 *
 *  点选一个不在跑的会话时只记一个本地选择，哨兵 roomRef 仍为空；真正发送时才
 *  harness_start，等目标房间上线后只提交一次。把这些状态迁移写成纯函数，
 *  是因为这里最容易出现「重复发送」和「切走后还发到旧会话」两个问题。 */

import { parseEncReason, type ListedSession, type RoomInfo } from "./devices.ts"
import { sessionTitleOf } from "./titleText.ts"

export type LazySelection = ListedSession & { deviceId: string }

/** sessionStorage key holding the not-yet-loaded selection, written next to
 *  the live room's "pi_room" entry: a reload / shell switch must restore the
 *  record the user had open, not fall back to a live room (C-D1). */
export const LAZY_SESSION_STORAGE_KEY = "pi_lazy_session"

export function serializeLazySelection(selection: LazySelection): string {
  return JSON.stringify(selection)
}

/** Parse a stored lazy selection. Only id + deviceId are load-bearing, so
 *  they are required; every other field falls back to the neutral value the
 *  session list would produce, and a malformed payload restores nothing.
 *  Display fields (title / firstMessage / cwd / updatedAt) survive the round
 *  trip so the restored placeholder shows the same title chain as a click. */
export function parseLazySelection(raw: string | null): LazySelection | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === "string" ? row.id : ""
  const deviceId = typeof row.deviceId === "string" ? row.deviceId : ""
  if (!id || !deviceId) return null
  const text = (v: unknown): string => (typeof v === "string" ? v : "")
  const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const selection: LazySelection = {
    id,
    deviceId,
    title: text(row.title),
    cwd: text(row.cwd),
    online: row.online === true,
    busy: row.busy === true,
    viewers: count(row.viewers),
    messageCount: count(row.messageCount),
    updatedAt: count(row.updatedAt),
    openable: row.openable === true,
  }
  const firstMessage = text(row.firstMessage)
  if (firstMessage) selection.firstMessage = firstMessage
  const path = text(row.path)
  if (path) selection.path = path
  if (row.enc === true) selection.enc = true
  const encReason = parseEncReason(row.encReason)
  if (encReason) selection.encReason = encReason
  const parentLabel = text(row.parentLabel)
  if (parentLabel) selection.parentLabel = parentLabel
  return selection
}

export type LazySendImage = { data: string; mimeType: string }

export type LazySendPhase = "starting" | "waiting" | "sending"

export type LazySend = {
  /** 每次发送的本地序号：异步结束后用它判断队列是否已经被换掉/取消 */
  token: number
  sessionId: string
  deviceId: string
  phase: LazySendPhase
  text: string
  /** 已经按发送要求校验过的图（mime 归一、体积不超限） */
  image: LazySendImage | null
  /** relay 支持 msg.cid 时用于把乐观气泡和送达回执对上 */
  cid: string
}

export type LazySendEvent =
  | { type: "harness-accepted" }
  | { type: "room-ready"; roomId: string; deviceId: string }
  | { type: "submitted" }
  | { type: "failed" }
  | { type: "cancelled" }

export type LazySendTransition = {
  send: LazySend | null
  action: "none" | "submit" | "fail" | "cancel"
}

/** 房间上线通知可能来自 subscribed / snapshot / room_list 好几处：
 *  只有第一次把 waiting 推进到 sending，后续同目标的通知都返回 none。 */
export function stepLazySend(current: LazySend | null, event: LazySendEvent): LazySendTransition {
  if (!current) return { send: null, action: "none" }
  switch (event.type) {
    case "harness-accepted":
      return current.phase === "starting" ? { send: { ...current, phase: "waiting" }, action: "none" } : { send: current, action: "none" }
    case "room-ready":
      if (event.roomId !== current.sessionId || event.deviceId !== current.deviceId) return { send: current, action: "none" }
      if (current.phase === "sending") return { send: current, action: "none" }
      return { send: { ...current, phase: "sending" }, action: "submit" }
    case "submitted":
      return { send: null, action: "none" }
    case "failed":
      return { send: null, action: "fail" }
    case "cancelled":
      return { send: null, action: "cancel" }
  }
}

export function lazySendPhaseText(phase: LazySendPhase): string {
  if (phase === "sending") return "正在发送…"
  if (phase === "waiting") return "正在载入会话并发送…"
  return "正在启动本机会话…"
}

/** 队列只属于一个“设备 + 会话”：切走时用它做最后一道校验。 */
export function lazySendTargets(send: LazySend | null, sessionId: string, deviceId: string): boolean {
  return !!send && send.sessionId === sessionId && send.deviceId === deviceId
}

/**
 * Whether a crypto_required refusal for `roomId` kills the pending lazy send.
 * The relay refuses a subscription to an encrypted room from a viewer
 * connection without the content capability (a token-auth viewer never
 * declares it) and then sends neither subscribed nor snapshot -- the two
 * events the state machine waits for -- so the queued send can never flush
 * and would hang until the generic watch timeout. The refusal is fatal only
 * for the send that targets that very room and has not been submitted yet;
 * a send already in "sending" got its room-ready and is unaffected, and an
 * unrelated room's refusal must not touch the queue.
 */
export function lazySendCryptoBlocked(send: LazySend | null, roomId: string): boolean {
  return !!send && !!roomId && send.sessionId === roomId && send.phase !== "sending"
}

/** 未载入会话在列表里的合成房间：online 只表示“设备在线，可点选/可发送”，
 *  不代表本机已有这个房间；正文由 UI 的空态接管，不订阅。 */
export function lazyRoomFromRow(row: LazySelection): RoomInfo {
  // Callers may hand in a raw stored-session entry (no resolved title,
  // first message possibly sealed and therefore empty). The listed title
  // only counts as the session name when the first message / workspace
  // would not produce it: a derived title posing as `name` would outrank
  // the stored entry's real name and a first message decrypted later.
  const derived = sessionTitleOf({ firstMessage: row.firstMessage, cwd: row.cwd })
  const name = row.title && row.title !== derived ? row.title : null
  return {
    id: row.id,
    label: row.title || derived,
    name,
    firstMessage: row.firstMessage || null,
    cwd: row.cwd || null,
    online: true,
    busy: false,
    viewers: 0,
    lastActivity: row.updatedAt || 0,
    deviceId: row.deviceId,
  }
}

/** 把合成房间并进 relay 的房间列表：同 id 的真实在线房间优先，真实离线房间被合成项替换。 */
export function withLazyRoom(rooms: RoomInfo[], lazy: RoomInfo | null): RoomInfo[] {
  if (!lazy) return rooms
  const at = rooms.findIndex((room) => room.id === lazy.id)
  if (at < 0) return [lazy, ...rooms]
  if (rooms[at]?.online) return rooms
  const next = rooms.slice()
  next[at] = lazy
  return next
}

/** 载入/发送失败时退回草稿：用户若已经在输入框里写了新内容，不覆盖新内容。 */
export function restoreLazyDraft(current: string, original: string): string {
  if (!original) return current
  if (!current.trim()) return original
  if (current.includes(original)) return current
  return `${original}\n\n${current}`
}

/** 图片同理：输入条里已经有新图就不动，空着才把排队时那张放回去。 */
export function restoreLazyImage<T>(current: T | null, original: T | null): T | null {
  if (current) return current
  return original
}
