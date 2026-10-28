/**
 * 网页删掉的会话（P8 R25，编排 10-26 00:40）。纯函数，node --test 直接加载；storage 由调用方传入（拿不到 localStorage 时传 null，等于不记）。
 * - 为什么：relay 把会话的离线房间留在名册里，直到房间被驱逐（rooms.evictIdle：离线、没人看、最近活动超过 roomIdleEvictMs，默认 6 小时）；
 *   会话文件删掉、索引打了墓碑也不会把它移出名册。mergeDeviceSessions 又把「没进索引的离线房间」当可回看的行，
 *   于是删掉的会话会以 pi 的标签回到侧栏（远程 R25 复验 B / C）。
 * - 做法：删除成功后在 localStorage 记下会话 id，每条 6 小时后过期（读的时候顺带清掉过期的）。同一个浏览器的所有标签页读同一份记录，
 *   和 P6 的偏好一样各页一致。名册里这些 id 的离线房间去掉；在线房间一律不隐藏（有 pi 正开着它）；
 *   本页正打开的那个房间也留着（别的标签页删了它时，这一页的正文不突然消失，离开以后下一份名册再去掉）。
 * - 管不到的：别的设备（例如手机）没有这份记录，6 小时内仍会看到这一行。真正的修法在 relay（R2/protocol-followups.md「P5 追加」F-R7）。
 */
export const DELETED_SESSIONS_KEY = "pi_remote_deleted_sessions"
export const DELETED_SESSION_TTL_MS = 6 * 60 * 60 * 1000

export type DeletedSessionsStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function write(storage: DeletedSessionsStorage, live: ReadonlyMap<string, number>): void {
  try {
    if (live.size) storage.setItem(DELETED_SESSIONS_KEY, JSON.stringify(Object.fromEntries(live)))
    else storage.removeItem(DELETED_SESSIONS_KEY)
  } catch {
    // 隐私模式 / 配额满：记不下就算了，最多是这一行在侧栏里多留一会儿
  }
}

/** 读出还没过期的记录（会话 id → 过期时刻）。过期的、坏的条目顺带清掉并写回；全清掉了就删掉这个键 */
export function readDeletedSessions(storage: DeletedSessionsStorage | null, now: number): Map<string, number> {
  const live = new Map<string, number>()
  if (!storage) return live
  let raw: string | null = null
  try {
    raw = storage.getItem(DELETED_SESSIONS_KEY)
  } catch {
    return live
  }
  if (!raw) return live
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  let dropped = !parsed || typeof parsed !== "object" || Array.isArray(parsed)
  if (!dropped) {
    for (const [id, until] of Object.entries(parsed as Record<string, unknown>)) {
      if (id && typeof until === "number" && Number.isFinite(until) && until > now) live.set(id, until)
      else dropped = true
    }
  }
  if (dropped) write(storage, live)
  return live
}

/** 记下刚删掉的会话（ttl 之后过期，默认 6 小时）；返回记下以后还有效的全部记录 */
export function rememberDeletedSession(storage: DeletedSessionsStorage | null, id: string, now: number, ttl: number = DELETED_SESSION_TTL_MS): Map<string, number> {
  const live = readDeletedSessions(storage, now)
  if (!id) return live
  live.set(id, now + ttl)
  if (storage) write(storage, live)
  return live
}

/**
 * 会话清单（get_sessions 的结果）去掉删掉的会话：relay 的索引已经打了墓碑，新拉的清单本来就没有它；
 * 这里管的是别的标签页手里还没刷新的旧清单（storage 事件时过一遍），和删完马上拉到的、索引还没更新的那一份。
 * 没有要去掉的就原样返回同一个数组。
 */
export function withoutDeletedSessions<T extends { id: string }>(sessions: T[], deleted: { has(id: string): boolean; readonly size: number }): T[] {
  if (!deleted.size) return sessions
  const next = sessions.filter((session) => !deleted.has(session.id))
  return next.length === sessions.length ? sessions : next
}

/**
 * 名册去掉删掉的会话的离线房间：在线的、本页正打开的（keepId）一律留着。
 * 没有要去掉的就原样返回同一个数组（调用方据此判断要不要 setRooms）。
 */
export function withoutDeletedRooms<T extends { id: string; online: boolean }>(
  rooms: T[],
  deleted: { has(id: string): boolean; readonly size: number },
  keepId: string | null = null,
): T[] {
  if (!deleted.size) return rooms
  const next = rooms.filter((room) => room.online || (!!keepId && room.id === keepId) || !deleted.has(room.id))
  return next.length === rooms.length ? rooms : next
}
