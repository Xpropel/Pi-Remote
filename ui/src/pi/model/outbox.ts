/**
 * 离线 outbox（design §1.12、§9.1，决定 5）：断线或设备离线时点发送，消息进本页 outbox，
 * 恢复后按顺序发出；回放失败留在 outbox 标失败，可重试或取消。
 *
 * 纯逻辑、不依赖 React（node --test 直接 import）：import 只用 .ts、相对路径带扩展名。
 *
 * 不重复发送由客户端保证（relay 只按 (room, dedupeKey) 在内存里去重 10 分钟，不按 cid 去重，
 * 重启即丢）：
 *  - 一条只在 queued → replaying 时被认领一次，replaying 的条目绝不自动再发；
 *  - B-3：命令结果只证明设备接受了调用，条目先转 awaiting（已到设备、等 pi 确认），
 *    收到 remote_message_delivered 才算真送达移出；remote_message_failed 或超
 *    OUTBOX_DELIVERY_CONFIRM_MS 无确认 → failed（正文保留，用户决定重试）；
 *  - 页面在 replaying 途中关掉，下次载入时由 recover 转成 failed（结果未知），由用户决定重试；
 *  - 重试换新的 cid + dedupeKey：等同于用户重新发一条，旧 cid 不会第二次上线。
 */
import { isCid } from "../../relay/protocol.ts"

export const OUTBOX_STORAGE_KEY = "pi_remote_outbox_v1"
/** 每个会话最多排多少条：localStorage 配额有限，超出时入队被拒，消息留在输入框 */
export const OUTBOX_ROOM_MAX = 50
/**
 * B-3: after the command result comes back the message is only known to have
 * reached the device-side extension (it may still sit in the device queue,
 * waiting for the current turn to end). The entry leaves the outbox only when
 * the device confirms pi actually consumed the message
 * (remote_message_delivered). If neither delivered nor failed arrives within
 * this bound, the entry surfaces as failed with unknown=true instead of
 * pretending it was sent. The bound matches the extension's own idle
 * delivery-watch cap (DELIVERY_MAX_WAIT_MS) so both ends give up at roughly
 * the same horizon.
 */
export const OUTBOX_DELIVERY_CONFIRM_MS = 10 * 60 * 1000
/** 单条正文上限，与 composer 的 COMPOSER_TEXT_MAX 一致 */
export const OUTBOX_TEXT_MAX = 100_000
const DEDUPE_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/

export type OutboxStatus = "queued" | "replaying" | "awaiting" | "failed"

/** 结构上兼容 P5.1 的 PiOutboxItemView（cid / text / status） */
export type OutboxEntry = {
  cid: string
  /** 命令帧的 dedupeKey：channel 重发同一帧时 relay 合并 / 回放结果，不会二次执行 */
  dedupeKey: string
  roomId: string
  /** 上线的全文（引用行已展开） */
  text: string
  /** 入队时刻（ms） */
  at: number
  status: OutboxStatus
  /** awaiting 时的交出时刻（ms）：命令已被设备接受、等设备确认 pi 真正接收 */
  handedAt?: number
  /** failed 时的原因 */
  error?: string
  /** failed 且命令可能已执行（发出后没等到结果）：提示用户先看会话再决定重试 */
  unknown?: boolean
  /**
   * 回放认领者（标签页级随机 id，UI 低危：跨标签页认领分不清自他）。
   * 只在 replaying 时存在：本页认领后写进 localStorage，别的标签页的 sent/fail/requeue 带自己的
   * owner 就对不上，不会把别人正在发的条目改掉；载入时 recover 会一并清掉。
   */
  claim?: string
}

export type OutboxState = { readonly byRoom: Readonly<Record<string, readonly OutboxEntry[]>> }

export type OutboxAction =
  /** 入队；cid / dedupeKey 已存在（任一会话）或该会话已满时不变 */
  | { type: "enqueue"; roomId: string; cid: string; dedupeKey: string; text: string; at: number }
  /** 回放认领：queued → replaying（同一会话同时只有一条在飞，保证顺序）。owner = 认领的标签页 id */
  | { type: "replay"; roomId: string; cid: string; owner?: string }
  /** 回放成功：移出 outbox（owner 与认领者不一致时不动，防跨标签页误清） */
  | { type: "sent"; roomId: string; cid: string; owner?: string }
  /**
   * B-3: 命令已被设备接受（command_result ok）但 pi 还没确认接收：replaying → awaiting。
   * 条目留在 outbox 里，直到 delivered / delivery-failed / 超时巡查给出终局。
   */
  | { type: "handoff"; roomId: string; cid: string; at: number; owner?: string }
  /**
   * B-3: 设备确认 pi 已真正接收（remote_message_delivered 按 cid 对上）：移出 outbox。
   * 这是设备侧事实，哪个标签页收到事件都可落定，不查 owner；迟到时 failed 也认
   * （超时巡查先标了失败、确认随后才到，以设备事实为准）。
   */
  | { type: "delivered"; roomId: string; cid: string }
  /** B-3: 设备明确报注入失败（remote_message_failed 按 cid 对上）：awaiting / replaying → failed，正文保留可重试 */
  | { type: "delivery-failed"; roomId: string; cid: string; error: string }
  /** B-3: 交出后超过 OUTBOX_DELIVERY_CONFIRM_MS 仍无确认：awaiting → failed（结果未知，正文保留） */
  | { type: "confirm-timeout"; roomId: string; cid: string; error: string }
  /** 回放失败：replaying → failed，留在原位（owner 同 sent） */
  | { type: "fail"; roomId: string; cid: string; error: string; unknown?: boolean; owner?: string }
  /** 帧根本没发出去（连接已断、本机未连接）：replaying → queued，cid 没上过线，原样再排 */
  | { type: "requeue"; roomId: string; cid: string; owner?: string }
  /** 用户点重试：failed → queued，换新 cid + dedupeKey */
  | { type: "retry"; roomId: string; cid: string; nextCid: string; nextDedupeKey: string }
  /** 用户取消：queued / failed 移出；replaying 已在飞，不能取消 */
  | { type: "cancel"; roomId: string; cid: string }
  /** 载入时调用一次：上次页面关在 replaying / awaiting 途中的条目转 failed（结果未知） */
  | { type: "recover"; error: string }

export const EMPTY_OUTBOX: OutboxState = { byRoom: {} }

/**
 * E1/E2: one terminal delivery outcome as re-sent by the relay on room
 * snapshots (additive `finalFrames` field). A viewer that was not
 * subscribed when the delivered / failed frame first went out settles
 * its pending entries from these instead of waiting for the confirm
 * sweep: same cids, same two dispositions as the live frames.
 */
export type FinalFrame = { cid: string; disposition: "delivered" | "failed"; at: number }

/**
 * Validate a snapshot's `finalFrames` field. Anything malformed is
 * dropped item by item (never guessed); a missing field (old relay)
 * yields an empty list, so behavior is exactly the pre-E1 behavior.
 */
export function finalFramesOf(raw: unknown): FinalFrame[] {
  if (!Array.isArray(raw)) return []
  const out: FinalFrame[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const { cid, disposition, at } = item
    if (!isCid(cid)) continue
    if (disposition !== "delivered" && disposition !== "failed") continue
    out.push({ cid, disposition, at: typeof at === "number" && Number.isFinite(at) ? at : 0 })
  }
  return out
}

export function outboxOf(state: OutboxState, roomId: string | null | undefined): readonly OutboxEntry[] {
  return (roomId && state.byRoom[roomId]) || []
}

export function outboxSize(state: OutboxState): number {
  let n = 0
  for (const list of Object.values(state.byRoom)) n += list.length
  return n
}

/** 一个标签页的回放认领 id（随机 + 时间，不落 token / 会话内容）。 */
export function newOutboxOwner(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 这条 replaying 条目是否正由 owner 认领（回放前回读共享存储时用；没有 claim / 不是 replaying 都返回 false）。 */
export function outboxClaimedBy(state: OutboxState, roomId: string, cid: string, owner: string): boolean {
  const entry = outboxOf(state, roomId).find((item) => item.cid === cid)
  return !!entry && entry.status === "replaying" && entry.claim === owner
}

/** 下一条该回放的：该会话第一条 queued；已有条目在飞（replaying / awaiting）时返回 null（一条一条按序发，等上一条有设备侧终局再发下一条） */
export function nextReplay(state: OutboxState, roomId: string | null | undefined): OutboxEntry | null {
  const list = outboxOf(state, roomId)
  if (list.some((entry) => entry.status === "replaying" || entry.status === "awaiting")) return null
  return list.find((entry) => entry.status === "queued") ?? null
}

function hasId(state: OutboxState, cid: string, dedupeKey: string): boolean {
  for (const list of Object.values(state.byRoom)) {
    for (const entry of list) if (entry.cid === cid || entry.dedupeKey === dedupeKey) return true
  }
  return false
}

function withRoom(state: OutboxState, roomId: string, list: readonly OutboxEntry[]): OutboxState {
  const byRoom = { ...state.byRoom }
  if (list.length) byRoom[roomId] = list
  else delete byRoom[roomId]
  return { byRoom }
}

function patchEntry(
  state: OutboxState,
  roomId: string,
  cid: string,
  from: readonly OutboxStatus[],
  patch: (entry: OutboxEntry) => OutboxEntry | null,
  owner?: string,
): OutboxState {
  const list = outboxOf(state, roomId)
  const at = list.findIndex((entry) => entry.cid === cid)
  if (at < 0 || !from.includes(list[at].status)) return state
  // 认领归属：认领者已被别的标签页覆盖时，本页的 sent/fail/requeue 不能动这条
  if (owner && list[at].claim && list[at].claim !== owner) return state
  const next = patch(list[at])
  const copy = [...list]
  if (next) copy[at] = next
  else copy.splice(at, 1)
  return withRoom(state, roomId, copy)
}

function settled(entry: OutboxEntry, status: OutboxStatus): OutboxEntry {
  // handedAt only means something while awaiting; every transition out of a
  // handoff (or into a fresh attempt) drops it along with error/unknown/claim.
  const { error: _error, unknown: _unknown, claim: _claim, handedAt: _handedAt, ...rest } = entry
  return { ...rest, status }
}

export function outboxReducer(state: OutboxState, action: OutboxAction): OutboxState {
  switch (action.type) {
    case "enqueue": {
      const text = action.text.trim()
      if (!action.roomId || !text || text.length > OUTBOX_TEXT_MAX) return state
      if (!isCid(action.cid) || !DEDUPE_KEY_RE.test(action.dedupeKey)) return state
      if (hasId(state, action.cid, action.dedupeKey)) return state
      const list = outboxOf(state, action.roomId)
      if (list.length >= OUTBOX_ROOM_MAX) return state
      const entry: OutboxEntry = { cid: action.cid, dedupeKey: action.dedupeKey, roomId: action.roomId, text, at: action.at, status: "queued" }
      return withRoom(state, action.roomId, [...list, entry])
    }
    case "replay": {
      // 只认领"下一条"：前面还有 queued 或已有在飞的，一律不动（顺序与单飞都由这里守）
      const next = nextReplay(state, action.roomId)
      if (!next || next.cid !== action.cid) return state
      const owner = action.owner ? action.owner.trim().slice(0, 128) : ""
      return patchEntry(state, action.roomId, action.cid, ["queued"], (entry) => ({
        ...settled(entry, "replaying"),
        ...(owner ? { claim: owner } : {}),
      }))
    }
    case "sent":
      // failed 也认：别的标签页载入时可能已把在飞条目 recover 成 failed，结果实际送达了
      return patchEntry(state, action.roomId, action.cid, ["replaying", "failed"], () => null, action.owner)
    case "handoff":
      return patchEntry(
        state,
        action.roomId,
        action.cid,
        ["replaying"],
        (entry) => ({ ...settled(entry, "awaiting"), handedAt: action.at }),
        action.owner,
      )
    case "delivered":
      // 设备侧事实，不查 owner：回放中的竞态（确认先于 handoff 落定）与超时后的迟到确认都认
      return patchEntry(state, action.roomId, action.cid, ["replaying", "awaiting", "failed"], () => null)
    case "delivery-failed":
      return patchEntry(
        state,
        action.roomId,
        action.cid,
        ["replaying", "awaiting"],
        (entry) => ({ ...settled(entry, "failed"), error: action.error || "发送失败" }),
      )
    case "confirm-timeout":
      return patchEntry(
        state,
        action.roomId,
        action.cid,
        ["awaiting"],
        (entry) => ({ ...settled(entry, "failed"), error: action.error || "设备长时间没有确认收到", unknown: true }),
      )
    case "fail":
      return patchEntry(
        state,
        action.roomId,
        action.cid,
        ["replaying"],
        (entry) => ({
          ...settled(entry, "failed"),
          error: action.error || "发送失败",
          ...(action.unknown ? { unknown: true } : {}),
        }),
        action.owner,
      )
    case "requeue":
      return patchEntry(state, action.roomId, action.cid, ["replaying"], (entry) => settled(entry, "queued"), action.owner)
    case "retry": {
      if (!isCid(action.nextCid) || !DEDUPE_KEY_RE.test(action.nextDedupeKey)) return state
      if (hasId(state, action.nextCid, action.nextDedupeKey)) return state
      return patchEntry(state, action.roomId, action.cid, ["failed"], (entry) => ({
        ...settled(entry, "queued"),
        cid: action.nextCid,
        dedupeKey: action.nextDedupeKey,
      }))
    }
    case "cancel":
      return patchEntry(state, action.roomId, action.cid, ["queued", "failed"], () => null)
    case "recover": {
      let changed = false
      const byRoom: Record<string, readonly OutboxEntry[]> = {}
      for (const [roomId, list] of Object.entries(state.byRoom)) {
        byRoom[roomId] = list.map((entry) => {
          if (entry.status !== "replaying" && entry.status !== "awaiting") return entry
          changed = true
          return { ...settled(entry, "failed"), error: action.error, unknown: true }
        })
      }
      return changed ? { byRoom } : state
    }
  }
}

// —— 持久化（localStorage，按会话分组存在一个键里） ——

export type StorageLike = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseEntry(raw: unknown, roomId: string): OutboxEntry | null {
  if (!isRecord(raw)) return null
  const { cid, dedupeKey, text, at, status, error, unknown } = raw
  if (!isCid(cid) || typeof dedupeKey !== "string" || !DEDUPE_KEY_RE.test(dedupeKey)) return null
  if (typeof text !== "string" || !text.trim() || text.length > OUTBOX_TEXT_MAX) return null
  if (typeof at !== "number" || !Number.isFinite(at)) return null
  if (status !== "queued" && status !== "replaying" && status !== "awaiting" && status !== "failed") return null
  const entry: OutboxEntry = { cid, dedupeKey, roomId, text, at, status }
  if (status === "replaying" || status === "awaiting") {
    const claim = (raw as { claim?: unknown }).claim
    if (typeof claim === "string" && claim && claim.length <= 128) entry.claim = claim
  }
  if (status === "awaiting") {
    const handedAt = (raw as { handedAt?: unknown }).handedAt
    entry.handedAt = typeof handedAt === "number" && Number.isFinite(handedAt) ? handedAt : at
  }
  if (status === "failed") {
    entry.error = typeof error === "string" && error ? error : "发送失败"
    if (unknown === true) entry.unknown = true
  }
  return entry
}

/** 容错解析：坏 JSON、错类型、坏条目一律丢弃，不抛；重复的 cid / dedupeKey 只留第一条 */
export function parseOutbox(raw: string | null | undefined): OutboxState {
  if (!raw) return EMPTY_OUTBOX
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return EMPTY_OUTBOX
  }
  if (!isRecord(data) || data.v !== 1 || !isRecord(data.rooms)) return EMPTY_OUTBOX
  const cids = new Set<string>()
  const keys = new Set<string>()
  const byRoom: Record<string, readonly OutboxEntry[]> = {}
  for (const [roomId, list] of Object.entries(data.rooms)) {
    if (!roomId || !Array.isArray(list)) continue
    const entries: OutboxEntry[] = []
    for (const item of list) {
      const entry = parseEntry(item, roomId)
      if (!entry || cids.has(entry.cid) || keys.has(entry.dedupeKey) || entries.length >= OUTBOX_ROOM_MAX) continue
      cids.add(entry.cid)
      keys.add(entry.dedupeKey)
      entries.push(entry)
    }
    if (entries.length) byRoom[roomId] = entries
  }
  return { byRoom }
}

export function serializeOutbox(state: OutboxState): string {
  const rooms: Record<string, unknown[]> = {}
  for (const [roomId, list] of Object.entries(state.byRoom)) {
    // roomId 是分组键，不重复写进每条
    if (list.length) rooms[roomId] = list.map(({ roomId: _roomId, ...rest }) => rest)
  }
  return JSON.stringify({ v: 1, rooms })
}

/** 读不到（隐私模式、被禁用）时当作空 outbox */
export function loadOutbox(storage: StorageLike | null | undefined): OutboxState {
  if (!storage) return EMPTY_OUTBOX
  try {
    return parseOutbox(storage.getItem(OUTBOX_STORAGE_KEY))
  } catch {
    return EMPTY_OUTBOX
  }
}

/** 写入；配额满 / 存储不可用返回 false（调用方据此拒绝入队，消息留在输入框） */
export function saveOutbox(storage: StorageLike | null | undefined, state: OutboxState): boolean {
  if (!storage) return false
  try {
    if (outboxSize(state) === 0) storage.removeItem(OUTBOX_STORAGE_KEY)
    else storage.setItem(OUTBOX_STORAGE_KEY, serializeOutbox(state))
    return true
  } catch {
    return false
  }
}
