/**
 * 定时/心跳排期的 UI 侧形状与纯函数（设计 D §3.7）：排期表归 relay，本文件只做
 * 入站清洗（room_list 条目内的 schedules / schedule_update 帧）、状态行文案，
 * 以及排队条目 cid 的来源标注解析。创建/取消命令在 useRelay 里走 sendQuery。
 */

export type ScheduleSegment = "steer" | "follow_up"
export type ScheduleKind = "once" | "every"
export type ScheduleState = "armed" | "retired" | "failed"
export type ScheduleRetireReason = "canceled" | "session_ended" | "expired" | "max_fires" | "missed" | "delivery_failed"

export type ScheduleEntry = {
  id: string
  roomId: string
  deviceId: string | null
  text: string
  segment: ScheduleSegment
  kind: ScheduleKind
  /** once 的目标时刻 */
  at?: number
  /** every 的间隔（≥60 秒） */
  intervalMs?: number
  /** 下一拍时刻（relay 维护） */
  nextAt: number
  firedCount: number
  maxFires?: number
  expireAt: number
  state: ScheduleState
  retireReason?: ScheduleRetireReason
  createdAt: number
  stateAt: number
  lastFiredAt?: number
  lastError?: string
}

/** schedule_create 的入参（roomId 由 useRelay 按当前房补）。 */
export type ScheduleCreateInput = {
  text: string
  segment: ScheduleSegment
  kind: ScheduleKind
  at?: number
  intervalMs?: number
  maxFires?: number
  expireAt?: number
}

const SEGMENTS: ReadonlySet<string> = new Set(["steer", "follow_up"])
const KINDS: ReadonlySet<string> = new Set(["once", "every"])
const STATES: ReadonlySet<string> = new Set(["armed", "retired", "failed"])
const REASONS: ReadonlySet<string> = new Set(["canceled", "session_ended", "expired", "max_fires", "missed", "delivery_failed"])
const ID_RE = /^sch_[a-z0-9]{8,32}$/
const CID_RE = /^(sch_[a-z0-9]{8,32})_(\d{1,9})$/

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function cleanEntry(raw: unknown): ScheduleEntry | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== "string" || !ID_RE.test(r.id)) return null
  if (typeof r.roomId !== "string" || !r.roomId) return null
  if (typeof r.text !== "string" || !r.text) return null
  if (typeof r.segment !== "string" || !SEGMENTS.has(r.segment)) return null
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null
  if (typeof r.state !== "string" || !STATES.has(r.state)) return null
  const nextAt = num(r.nextAt)
  const expireAt = num(r.expireAt)
  const createdAt = num(r.createdAt)
  if (nextAt == null || expireAt == null || createdAt == null) return null
  const entry: ScheduleEntry = {
    id: r.id,
    roomId: r.roomId,
    deviceId: typeof r.deviceId === "string" ? r.deviceId : null,
    text: r.text,
    segment: r.segment as ScheduleSegment,
    kind: r.kind as ScheduleKind,
    nextAt,
    firedCount: typeof r.firedCount === "number" && Number.isSafeInteger(r.firedCount) && r.firedCount >= 0 ? r.firedCount : 0,
    expireAt,
    state: r.state as ScheduleState,
    createdAt,
    stateAt: num(r.stateAt) ?? createdAt,
  }
  if (entry.kind === "once") {
    const at = num(r.at)
    if (at == null) return null
    entry.at = at
  } else {
    const intervalMs = num(r.intervalMs)
    if (intervalMs == null) return null
    entry.intervalMs = intervalMs
  }
  if (typeof r.maxFires === "number" && Number.isSafeInteger(r.maxFires) && r.maxFires >= 1) entry.maxFires = r.maxFires
  if (typeof r.retireReason === "string" && REASONS.has(r.retireReason)) entry.retireReason = r.retireReason as ScheduleRetireReason
  const lastFiredAt = num(r.lastFiredAt)
  if (lastFiredAt != null) entry.lastFiredAt = lastFiredAt
  if (typeof r.lastError === "string" && r.lastError) entry.lastError = r.lastError
  return entry
}

/** 一份排期清单清洗（schedule_update 帧 / room_list 条目 / ack 回包共用）。 */
export function parseScheduleEntries(raw: unknown): ScheduleEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ScheduleEntry[] = []
  for (const item of raw) {
    const entry = cleanEntry(item)
    if (entry) out.push(entry)
  }
  return out
}

/**
 * 从 room_list 原始条目组装「房间 → 排期清单」快照。seen=false 表示这批条目没有任何
 * 一房带 schedules 字段（旧 relay）：调用方不要动本地副本。
 */
export function scheduleMapOfRooms(rawRooms: unknown): { map: Record<string, ScheduleEntry[]>; seen: boolean } {
  const map: Record<string, ScheduleEntry[]> = {}
  let seen = false
  if (!Array.isArray(rawRooms)) return { map, seen }
  for (const raw of rawRooms) {
    if (!raw || typeof raw !== "object") continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== "string" || !Array.isArray(r.schedules)) continue
    seen = true
    map[r.id] = parseScheduleEntries(r.schedules)
  }
  return { map, seen }
}

/** 定时投递的 cid 解析：sch_<id>_<拍号>；不是定时来源返回 null。 */
export function parseScheduleCid(cid: unknown): { scheduleId: string; fireNo: number } | null {
  if (typeof cid !== "string") return null
  const m = CID_RE.exec(cid)
  if (!m) return null
  const fireNo = Number(m[2])
  if (!Number.isSafeInteger(fireNo) || fireNo < 1) return null
  return { scheduleId: m[1], fireNo }
}

/** 排队卡上的来源标注（§3.7：scheduleId/fireNo 搭 cid 下行，卡片据此标注）。 */
export function scheduleSourceLabel(cid: unknown): string | null {
  const parsed = parseScheduleCid(cid)
  return parsed ? `来自定时 · 第 ${parsed.fireNo} 次` : null
}

/* ---------------- 状态行文案（§3.7 定版式样） ---------------- */

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

export function formatClock(at: number): string {
  const d = new Date(at)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function startOfDay(t: number): number {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 今天/明天带日期的时刻：今天 21:30 / 明天 09:00 / 10月30日 09:00 / 2027年1月2日 09:00。 */
export function formatDayTime(at: number, now: number): string {
  const day = startOfDay(at)
  const today = startOfDay(now)
  const clock = formatClock(at)
  if (day === today) return `今天 ${clock}`
  if (day === today + 24 * 60 * 60 * 1000) return `明天 ${clock}`
  const d = new Date(at)
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  return d.getFullYear() === new Date(now).getFullYear() ? `${md} ${clock}` : `${d.getFullYear()}年${md} ${clock}`
}

export function formatInterval(intervalMs: number): string {
  const minutes = Math.round(intervalMs / 60000)
  if (minutes >= 60 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`
  return `每 ${minutes} 分钟`
}

const SEGMENT_TEXT: Record<ScheduleSegment, string> = {
  steer: "插入当前回合",
  follow_up: "回合结束后发送",
}

const RETIRE_TEXT: Record<ScheduleRetireReason, string> = {
  canceled: "已取消",
  session_ended: "已结束 · 会话已结束",
  expired: "已到期",
  max_fires: "已完成",
  missed: "已作废 · 错过投递窗口",
  delivery_failed: "投递失败",
}

/** 排期卡的状态行：armed 报节律与下次时刻，终态报结局（§3.7 一行式样）。 */
export function scheduleStatusLine(entry: ScheduleEntry, now: number): string {
  if (entry.state === "failed") {
    return entry.lastError ? `投递失败 · ${entry.lastError}` : RETIRE_TEXT.delivery_failed
  }
  if (entry.state === "retired") {
    const base = entry.retireReason ? RETIRE_TEXT[entry.retireReason] : "已结束"
    if (entry.retireReason === "max_fires" && entry.kind === "every") return `已达触发上限 · 共 ${entry.firedCount} 次`
    return base
  }
  if (entry.kind === "once") {
    return `⏰ ${formatDayTime(entry.at ?? entry.nextAt, now)} · 一次 · ${SEGMENT_TEXT[entry.segment]}`
  }
  const parts = [`🔁 ${formatInterval(entry.intervalMs ?? 0)}`]
  parts.push(entry.firedCount > 0 ? `已触发 ${entry.firedCount} 次` : "未触发")
  parts.push(`下次 ${formatDayTime(entry.nextAt, now)}`)
  return parts.join(" · ")
}
