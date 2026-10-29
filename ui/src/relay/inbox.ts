/**
 * 收件箱账本的 UI 侧形状与纯函数（设计 D §1.5）：relay 账本（room.inbox cap）下发的
 * 条目只含元数据（房 / 对话 id / 种类 / 一句标题 / 时刻），正文面（options/message/
 * prefill）协议上就不存在。本文件只做三件事：清洗入站条目、把增量帧并入本地副本、
 * 把 turn 条目提炼成 RoomTurnTracker 的种子——计数与清单派生仍唯一走 attention.ts，
 * 这里不许出现第二套计数。
 */
import type { RoomTurnSeed } from "./attention.ts"

export type InboxKind = "waiting" | "error" | "done"
export type InboxSubkind = "dialog" | "prompt" | "ask" | "turn" | "schedule"

export type InboxEntry = {
  /** 稳定键，与 attention 条目键同格式：dialog:<id> / prompt:<roomId>:<at> / turn:<roomId>:<at> / ask:<id> / sched:<id> */
  key: string
  accountId: string
  roomId: string
  deviceId: string | null
  kind: InboxKind
  subkind: InboxSubkind
  /** dialog/prompt 条目的对话种类（confirm/select/input/editor…），ask 条目可缺省 */
  dialogKind?: string
  /** 一句标题（≤120 字，协议面摘要）；turn 条目恒无 */
  title?: string
  /** dialog 条目：当前任一连接声明了 dialog.respond 时为 true（可远程答） */
  answerable?: boolean
  at: number
}

const KINDS: ReadonlySet<string> = new Set(["waiting", "error", "done"])
const SUBKINDS: ReadonlySet<string> = new Set(["dialog", "prompt", "ask", "turn", "schedule"])

function cleanEntry(raw: unknown): InboxEntry | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.key !== "string" || !r.key || typeof r.roomId !== "string" || !r.roomId) return null
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null
  if (typeof r.subkind !== "string" || !SUBKINDS.has(r.subkind)) return null
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return null
  const entry: InboxEntry = {
    key: r.key,
    accountId: typeof r.accountId === "string" ? r.accountId : "default",
    roomId: r.roomId,
    deviceId: typeof r.deviceId === "string" ? r.deviceId : null,
    kind: r.kind as InboxKind,
    subkind: r.subkind as InboxSubkind,
    at: r.at,
  }
  if (typeof r.dialogKind === "string" && r.dialogKind) entry.dialogKind = r.dialogKind
  if (typeof r.title === "string" && r.title) entry.title = r.title
  if (typeof r.answerable === "boolean") entry.answerable = r.answerable
  return entry
}

/** auth_result / room_list 附带的账本快照清洗（旧 relay 无此字段 → 空数组，行为回落既有面）。 */
export function parseInboxEntries(raw: unknown): InboxEntry[] {
  if (!Array.isArray(raw)) return []
  const out: InboxEntry[] = []
  for (const item of raw) {
    const entry = cleanEntry(item)
    if (entry) out.push(entry)
  }
  return out
}

function sameEntry(a: InboxEntry, b: InboxEntry): boolean {
  return a.roomId === b.roomId && a.deviceId === b.deviceId && a.kind === b.kind &&
    a.subkind === b.subkind && a.dialogKind === b.dialogKind && a.title === b.title &&
    a.answerable === b.answerable && a.at === b.at
}

/** inbox_update 增量并入：upserts 按 key 覆盖、removed 按 key 删；无实际变化时原样返回入参（引用不变）。 */
export function applyInboxUpdate(
  entries: readonly InboxEntry[],
  upserts: readonly InboxEntry[],
  removed: readonly string[],
): readonly InboxEntry[] {
  if (!upserts.length && !removed.length) return entries
  const byKey = new Map(entries.map((e) => [e.key, e]))
  let changed = false
  for (const key of removed) {
    if (byKey.delete(key)) changed = true
  }
  for (const entry of upserts) {
    const prev = byKey.get(entry.key)
    if (!prev || !sameEntry(prev, entry)) changed = true
    byKey.set(entry.key, entry)
  }
  if (!changed) return entries
  return [...byKey.values()].sort((a, b) => a.at - b.at)
}

/** turn 条目 → 追踪器种子：账本只补追踪器空缺（先到为准在 seedRoomTurnEnds 里裁决）。 */
export function inboxTurnSeedsOf(entries: readonly InboxEntry[]): RoomTurnSeed[] {
  const seeds: RoomTurnSeed[] = []
  for (const entry of entries) {
    if (entry.subkind !== "turn") continue
    if (entry.kind !== "done" && entry.kind !== "error") continue
    seeds.push({ roomId: entry.roomId, kind: entry.kind, at: entry.at })
  }
  return seeds
}

/** dialog 条目的 dialogId（key 形如 dialog:<dialogId>）；非 dialog 条目返回 null。 */
export function inboxDialogIdOf(entry: InboxEntry): string | null {
  if (entry.subkind !== "dialog") return null
  return entry.key.startsWith("dialog:") ? entry.key.slice("dialog:".length) : null
}
