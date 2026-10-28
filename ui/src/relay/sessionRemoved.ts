/**
 * 会话被服务器删掉（P9 B，session.purge / session_removed）的本地清理：纯函数，node --test 直接加载。
 *
 * 为什么要有：relay 在设备确认删除成功后清掉会话的全部副本，并向声明了 session.purge 的
 * 网页广播 `session_removed{deviceId,ids}`。网页要把同一次删除在本地的五个面一起摘掉——
 * 会话清单（sessionsByDevice）、名册里的离线房间（rooms）、会话库正文缓存（archives）、
 * 按房间键存的草稿（drafts.ts），以及"正在看的就是它"时的切走目标。
 *
 * 分工：本文件只做数据变换（引用不变时原样返回，调用方可据此跳过 setState）；副作用
 * （setState / subscribe / notify）留在 useRelay 的帧分支里。帧校验也在这里，坏帧整帧丢掉。
 */
import type { DraftTable } from "./drafts.ts"
import { roomDeviceId, type RoomInfo, type SessionEntry } from "./devices.ts"

/** session_removed 一帧的内容（`{ type, deviceId, ids }`，协议 §4.3）。 */
export type SessionRemoved = { deviceId: string; ids: string[] }

/** 一帧最多认多少条 id：relay 一次 purge 不会这么多，防坏帧把清理循环撑爆。 */
export const SESSION_REMOVED_MAX_IDS = 200

/**
 * 校验 session_removed 帧：deviceId 必须是非空字符串，ids 是去重后的非空字符串数组。
 * 合法的 id 形状与 relay / 扩展的会话 id 同口径（字母数字、_、-，1–200）。
 */
export function parseSessionRemoved(msg: { deviceId?: unknown; ids?: unknown }): SessionRemoved | null {
  const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : ""
  if (!deviceId) return null
  const raw = Array.isArray(msg.ids) ? msg.ids : []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (ids.length >= SESSION_REMOVED_MAX_IDS) break
    if (typeof item !== "string" || !item || seen.has(item)) continue
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(item)) continue
    seen.add(item)
    ids.push(item)
  }
  return ids.length ? { deviceId, ids } : null
}

/**
 * B1（公网延迟下的整表覆盖竞态）：这台设备上已被 session_removed 点名过的会话 id。
 * purge 是永久删除（relay 清掉全部副本、设备上文件也删了），之后再晚到的 get_sessions 快照
 * 也不能把它写回清单；所以按 deviceId 一直留着（页面刷新即清）。
 */
export type PurgedSessionTable = ReadonlyMap<string, ReadonlySet<string>>

export function createPurgedSessionTable(): PurgedSessionTable {
  return new Map()
}

/**
 * 记下 session_removed 点名的 id。纯函数：不改入参；没有新增时返回原表（调用方可据此省掉后续处理）。
 * 同一 id 重复点名（relay 幂等重发 / 多帧）不会改变结果。
 */
export function rememberPurgedSessions(table: PurgedSessionTable, deviceId: string, ids: readonly string[]): PurgedSessionTable {
  const key = String(deviceId || "").trim()
  if (!key || !ids.length) return table
  const prev = table.get(key)
  let added: Set<string> | null = null
  let seen: ReadonlySet<string> | undefined = prev
  for (const id of ids) {
    if (!id || seen?.has(id)) continue
    added ??= new Set(prev)
    added.add(id)
    seen = added
  }
  if (!added) return table
  const next = new Map(table)
  next.set(key, added)
  return next
}

/** 这台设备已 purge 的 id 名单（没有时 undefined；直接给 withoutPurgedSessions 用）。 */
export function purgedIdsOf(table: PurgedSessionTable, deviceId: string): ReadonlySet<string> | undefined {
  return table.get(String(deviceId || "").trim())
}

/**
 * B1：get_sessions 回包（整表快照）落地前，去掉这台设备已 purge 的会话。
 * 主要覆盖「请求发出 → 期间 session_removed → 回包才落地」的顺序（公网 + archive burst 下见过 ~1.3s）；
 * 反方向（快照先到、删除帧后到）由帧分支的 withoutRemovedSessions 清理。两条路合起来，已删行不会再被写回。
 * 没有要去的原样返回同一个数组（引用不变 → 调用方跳过 setState）。
 */
export function withoutPurgedSessions<T extends Pick<SessionEntry, "id">>(
  list: readonly T[] | undefined,
  ids: ReadonlySet<string> | undefined,
): readonly T[] | undefined {
  if (!ids || !ids.size || !list?.length) return list
  const kept = list.filter((item) => !ids.has(item.id))
  return kept.length === list.length ? list : kept
}

/** 会话清单：去掉这些 id；没有要去的就原样返回同一个数组。 */
export function withoutRemovedSessions<T extends Pick<SessionEntry, "id">>(list: readonly T[] | undefined, ids: ReadonlySet<string>): readonly T[] | undefined {
  if (!list || !list.length) return list
  const kept = list.filter((item) => !ids.has(item.id))
  return kept.length === list.length ? list : kept
}

/**
 * 名册：去掉这台设备上这些 id 对应的离线房间（在线房间不动——正在运行的会话不该被删；
 * relay 的 purgeSessions 也跳过在线房间，两端同口径）。别的设备上的同 id 房间不动。
 * 没有要去的就原样返回同一个数组。
 */
export function withoutRemovedRooms(rooms: readonly RoomInfo[], deviceId: string, ids: ReadonlySet<string>): RoomInfo[] {
  if (!rooms.length) return rooms as RoomInfo[]
  const kept = rooms.filter((room) => room.online || !ids.has(room.id) || roomDeviceId(room) !== deviceId)
  return kept.length === rooms.length ? (rooms as RoomInfo[]) : kept
}

/** 会话库正文缓存的键（useRelay 的 archivesRef 用 `${deviceId}\n${id}`）。 */
export function archiveKeysOf(deviceId: string, ids: readonly string[]): string[] {
  return ids.map((id) => `${deviceId}\n${id}`)
}

/** 按房间键存的草稿表：去掉被删会话的条目；没有要去的就原样返回同一个表。 */
export function withoutRemovedDrafts(table: DraftTable, ids: ReadonlySet<string>): DraftTable {
  const keys = Object.keys(table)
  if (!keys.length) return table
  const next: DraftTable = { ...table }
  let changed = false
  for (const id of ids) {
    if (next[id]) {
      delete next[id]
      changed = true
    }
  }
  return changed ? next : table
}

/**
 * 正在看的会话被删后切到哪：同一台设备上最近的一个会话（清单已按 updatedAt 新到旧）。
 * 优先还有房间的（打开后可看历史 / 实时），退而求其次取清单里的第一行；都被删了返回 null
 * （调用方清房，界面停在空态）。removalTargetOf 是这个决策的一部分。
 */
export function fallbackSessionOf(
  sessions: readonly Pick<SessionEntry, "id">[] | undefined,
  knownRoomIds: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): string | null {
  const rest = (sessions ?? []).filter((item) => item.id && !removed.has(item.id))
  if (!rest.length) return null
  const withRoom = rest.find((item) => knownRoomIds.has(item.id))
  return (withRoom ?? rest[0]).id
}

/**
 * 当前看的会话被删后的去向（spec §4.7.1 第 5 条）：同一台设备上还有会话就切过去，
 * 一条都没有就进新建会话页。纯决策，副作用（subscribe / clearRoom / 界面跳转）由调用方做：
 * useRelay 只发一次性信号，容器层（PiAppBody）负责把 ui.view 切到 "new"。
 */
export type RemovalTarget = { kind: "switch"; id: string } | { kind: "new-session" }

export function removalTargetOf(
  sessions: readonly Pick<SessionEntry, "id">[] | undefined,
  knownRoomIds: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): RemovalTarget {
  const id = fallbackSessionOf(sessions, knownRoomIds, removed)
  return id ? { kind: "switch", id } : { kind: "new-session" }
}
