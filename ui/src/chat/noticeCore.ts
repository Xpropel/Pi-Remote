/** 通知栈 N1–N8 的纯 reducer（规范 5.5）。
 *
 *  设计底线（5.5.6）：样式、ttl、合并、顶替、抢占、关闭路径只由
 *  `level` / `scope` / `dedupeKey` / `codes` / 用户交互 / 时钟决定。
 *  本文件不对 `title` / `body` 做任何字符串匹配——改文案不得改变行为。
 *
 *  N1 出队顺序 / N2 可见上限（V2：同屏 1 张）/ N3 dedupe 合并 / N4 scope 顶替 /
 *  N5 error 抢占 / N6 队列上限（V2：5 条）/ N7 ttl 从可见起算 / N8 悬停·焦点暂停。
 */

export type NoticeLevel = "info" | "success" | "warning" | "error"
export type NoticePauseReason = "hover" | "focus"

export type NoticeAction = {
  id: string
  label: string
  kind?: "primary" | "secondary"
  /** 点击后是否保留本卡（如「查看详情」）；默认关闭。 */
  keepOpen?: boolean
}

/** progress / connectivity 是准状态，分别由状态行与连接状态片承载。 */
export type NoticeChannel = "slot" | "progress" | "connectivity"

export type NoticeInput = {
  /** 不传则由 reducer 按入栈序号生成；同一 dedupeKey 合并时沿用旧 id。 */
  id?: string
  level: NoticeLevel
  title: string
  body?: string
  actions?: NoticeAction[]
  scope?: string
  dedupeKey?: string
  /** 旧调用点的稳定类别；只用于准入/默认 dedupeKey，不参与文案匹配。 */
  codes?: readonly string[]
  /** 显式指定通道；progress / connectivity 永远不进通知槽。 */
  channel?: NoticeChannel
  /** 入栈时刻；仅用于展示/审计，队列先到先出用 order。 */
  createdAt?: number
}

export type NoticeItem = {
  id: string
  level: NoticeLevel
  title: string
  body: string
  actions: NoticeAction[]
  scope: string | null
  dedupeKey: string | null
  /** 保留稳定类别，便于队列审计；生命周期仍只看 level/scope/dedupeKey/codes。 */
  codes: string[]
  channel: NoticeChannel
  createdAt: number
  /** 单调入栈序号：同级别先到先出，N5 回队首时可显式前移。 */
  order: number
  /** N3 合并计数；首次为 1，界面上 >1 才显示 ×n。 */
  count: number
  ttlMs: number | null
  remainingMs: number | null
  visibleAt: number | null
  expiresAt: number | null
  /** 当前连续可见段的起点；暂停时为 null。 */
  activeSince: number | null
  /** 之前连续可见段累计的毫秒数（N5 的 50% 判定要扣除暂停时间）。 */
  activeMs: number
  pausedBy: NoticePauseReason[]
}

export type NoticeState = {
  visible: NoticeItem[]
  /** 等待队列；硬上限 NOTICE_QUEUE_LIMIT（5）。溢出时先丢 info/success，再 warning，最后 error。 */
  queue: NoticeItem[]
  seq: number
  maxVisible: number
}

export type NoticeOptions = {
  maxVisible?: number
}

/** V2：桌面同屏只保留 1 张。移动端保持同一口径，常量保留给旧调用点/响应式壳。 */
export const NOTICE_MAX_VISIBLE = 1
export const NOTICE_MAX_VISIBLE_MOBILE = 1
/** V2：等待队列最多 5 条；error 仍优先留在队列里。 */
export const NOTICE_QUEUE_LIMIT = 5
/** 一张通知最多两个操作，保持单卡简洁（V1-5.5.7）。 */
export const NOTICE_MAX_ACTIONS = 2
/** warning 带操作按钮时：不按 8s 消失，但 60s 是硬上限。 */
export const NOTICE_WARNING_ACTION_TTL_MS = 60_000

/** 这些 codes 是持续状态/进度，不占用通知槽（第 5 章 §2.2/§2.3 M7）。 */
export const NOTICE_PROGRESS_CODES = [
  "progress",
  "compaction",
  "summarization",
  "truncated",
  "lazy-send",
] as const
export const NOTICE_CONNECTIVITY_CODES = ["connectivity"] as const

/** 槽位准入：只看显式 channel/codes，不猜文案。 */
export function noticeEntersSlot(input: Pick<NoticeInput, "channel" | "codes">): boolean {
  if (input.channel === "progress" || input.channel === "connectivity") return false
  const codes = input.codes ?? []
  if (codes.some((code) => (NOTICE_CONNECTIVITY_CODES as readonly string[]).includes(code))) return false
  if (codes.some((code) => (NOTICE_PROGRESS_CODES as readonly string[]).includes(code))) return false
  return true
}

/** 未显式给 key 时取首个稳定 code；仍没有就不合并（零文案推断）。 */
export function noticeDedupeKey(input: Pick<NoticeInput, "dedupeKey" | "codes">): string | null {
  const explicit = text(input.dedupeKey)
  if (explicit) return explicit
  return (input.codes ?? []).map(text).find(Boolean) ?? null
}

export const NOTICE_TTL_MS: Record<NoticeLevel, number | null> = {
  info: 5_000,
  success: 4_000,
  warning: 8_000,
  // error 永不自动消失，直到用户关闭或被同 scope 的解决通知顶替。
  error: null,
}

/** error(0) > warning(1) > info = success(2)。数字越小越先出队。 */
export function noticeLevelRank(level: NoticeLevel): number {
  if (level === "error") return 0
  if (level === "warning") return 1
  return 2
}

/**
 * 按类型字段算 ttl：info 5s / success 4s / warning 8s（带 actions 60s 硬上限）/ error 永不。
 * 这里只看 level 与 actions，不读 title/body。
 */
export function noticeTtlMs(level: NoticeLevel, actions: NoticeAction[] = []): number | null {
  if (level === "error") return null
  if (level === "warning" && actions.length > 0) return NOTICE_WARNING_ACTION_TTL_MS
  return NOTICE_TTL_MS[level]
}

export function emptyNotices(options: NoticeOptions = {}): NoticeState {
  const max = options.maxVisible ?? NOTICE_MAX_VISIBLE
  return {
    visible: [],
    queue: [],
    seq: 0,
    maxVisible: Number.isFinite(max) ? Math.max(0, Math.floor(max)) : NOTICE_MAX_VISIBLE,
  }
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function copyActions(actions: NoticeAction[] | undefined): NoticeAction[] {
  return (actions ?? []).slice(0, NOTICE_MAX_ACTIONS).map((action) => ({ ...action }))
}

function createItem(input: NoticeInput, order: number, now: number): NoticeItem {
  const id = text(input.id) || `n${order}`
  const actions = copyActions(input.actions)
  const ttl = noticeTtlMs(input.level, actions)
  return {
    id,
    level: input.level,
    title: input.title,
    body: input.body ?? "",
    actions,
    scope: text(input.scope) || null,
    dedupeKey: noticeDedupeKey(input),
    codes: [...(input.codes ?? [])],
    channel: input.channel ?? "slot",
    createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
    order,
    count: 1,
    ttlMs: ttl,
    remainingMs: ttl,
    visibleAt: null,
    expiresAt: null,
    activeSince: null,
    activeMs: 0,
    pausedBy: [],
  }
}

function activate(item: NoticeItem, now: number): NoticeItem {
  const ttl = noticeTtlMs(item.level, item.actions)
  return {
    ...item,
    visibleAt: now,
    activeSince: now,
    activeMs: 0,
    ttlMs: ttl,
    remainingMs: ttl,
    expiresAt: ttl === null ? null : now + ttl,
    pausedBy: [],
  }
}

/** 更新可见卡内容后 N3 重计 ttl：可见段归零；暂停中的卡保留暂停原因。 */
function restartVisible(item: NoticeItem, now: number): NoticeItem {
  const ttl = noticeTtlMs(item.level, item.actions)
  const paused = item.pausedBy.length > 0
  return {
    ...item,
    visibleAt: now,
    activeSince: paused ? null : now,
    activeMs: 0,
    ttlMs: ttl,
    remainingMs: ttl,
    expiresAt: paused || ttl === null ? null : now + ttl,
  }
}

/** 从可见区回到队列：清掉本次可见的计时，但保留合并计数。 */
function park(item: NoticeItem, order: number = item.order): NoticeItem {
  const ttl = noticeTtlMs(item.level, item.actions)
  return {
    ...item,
    order,
    visibleAt: null,
    expiresAt: null,
    activeSince: null,
    activeMs: 0,
    pausedBy: [],
    ttlMs: ttl,
    remainingMs: ttl,
  }
}

function queueCompare(a: NoticeItem, b: NoticeItem): number {
  const rank = noticeLevelRank(a.level) - noticeLevelRank(b.level)
  return rank !== 0 ? rank : a.order - b.order
}

function enqueueSorted(queue: NoticeItem[], item: NoticeItem): NoticeItem[] {
  return [...queue, item].sort(queueCompare)
}

/** N5 的「回队首」：把 order 前移到当前最小之前，再按 N1 的级别优先排序。 */
function enqueueFront(queue: NoticeItem[], item: NoticeItem): NoticeItem[] {
  const minOrder = queue.reduce((min, row) => Math.min(min, row.order), Number.POSITIVE_INFINITY)
  const order = Number.isFinite(minOrder) ? minOrder - 1 : item.order
  return enqueueSorted(queue, { ...item, order })
}

function pickBest(queue: NoticeItem[]): number {
  let best = 0
  for (let index = 1; index < queue.length; index += 1) {
    if (queueCompare(queue[index], queue[best]) < 0) best = index
  }
  return best
}

/** 有空位就按 N1 出队；被挤回队列的卡再次可见时重新计全量 ttl（N7）。 */
function fillVisible(state: NoticeState, now: number): NoticeState {
  if (state.maxVisible <= 0 || state.queue.length === 0) return state
  let visible = [...state.visible]
  let queue = [...state.queue]
  while (visible.length < state.maxVisible && queue.length > 0) {
    const index = pickBest(queue)
    const item = queue[index]
    queue = [...queue.slice(0, index), ...queue.slice(index + 1)]
    visible = [...visible, activate(item, now)]
  }
  return { ...state, visible, queue }
}

/** 到期只可能发生在可见区；queued 的 remaining 在 activate 时才重新起算。 */
function expireVisible(state: NoticeState, now: number): NoticeState {
  const kept = state.visible.filter((item) => item.expiresAt === null || item.expiresAt > now)
  if (kept.length === state.visible.length) return state
  return fillVisible({ ...state, visible: kept }, now)
}

function dropOldest(pool: NoticeItem[]): NoticeItem {
  return pool.reduce((oldest, item) => (item.order < oldest.order ? item : oldest))
}

/** N6（V2）：队列硬上限 5；超限先丢最旧的 info/success，其次最旧的 warning，最后才丢 error。
 *
 *  error 队列由 enqueueFront 逆序插入（最新在前），所以 order 最大的是最早的一条；
 *  只有队列已经全是 error 时才走到这一步，保证新 error 仍能留在队首可见。
 */
function capQueue(queue: NoticeItem[]): NoticeItem[] {
  let next = [...queue]
  while (next.length > NOTICE_QUEUE_LIMIT) {
    const soft = next.filter((item) => item.level === "info" || item.level === "success")
    const warnings = next.filter((item) => item.level === "warning")
    const victim =
      soft.length > 0
        ? dropOldest(soft)
        : warnings.length > 0
          ? dropOldest(warnings)
          : next.reduce((oldest, item) => (item.order > oldest.order ? item : oldest))
    next = next.filter((item) => item.id !== victim.id)
  }
  return next
}

function findDedupe(state: NoticeState, dedupeKey: string | null): NoticeItem | null {
  if (!dedupeKey) return null
  return (
    state.visible.find((item) => item.dedupeKey === dedupeKey) ??
    state.queue.find((item) => item.dedupeKey === dedupeKey) ??
    null
  )
}

function mergeContent(target: NoticeItem, input: NoticeInput, now: number): NoticeItem {
  const actions = copyActions(input.actions)
  const merged: NoticeItem = {
    ...target,
    level: input.level,
    title: input.title,
    body: input.body ?? "",
    actions,
    scope: text(input.scope) || null,
    dedupeKey: noticeDedupeKey(input),
    codes: [...(input.codes ?? [])],
    channel: input.channel ?? "slot",
    count: target.count + 1,
    ttlMs: noticeTtlMs(input.level, actions),
    remainingMs: noticeTtlMs(input.level, actions),
  }
  return target.visibleAt === null ? park(merged) : restartVisible(merged, now)
}

function elapsedActive(item: NoticeItem, now: number): number {
  return item.activeMs + (item.activeSince === null ? 0 : Math.max(0, now - item.activeSince))
}

/**
 * M3 的牺牲者：error 可抢占任意非 error；warning 只抢占 info/success，
 * 不挤 warning/error；info/success 永不抢占（返回 null 就走队列）。同级取最旧。
 */
function pickVictim(visible: NoticeItem[], incoming: NoticeLevel): NoticeItem | null {
  if (incoming !== "error" && incoming !== "warning") return null
  const candidates = visible.filter((item) =>
    incoming === "error" ? item.level !== "error" : item.level === "info" || item.level === "success",
  )
  if (candidates.length === 0) return null
  return candidates.reduce((victim, item) => {
    const rank = noticeLevelRank(item.level) - noticeLevelRank(victim.level)
    if (rank > 0) return item
    if (rank === 0 && item.order < victim.order) return item
    return victim
  })
}

/** 被挤出的卡：info/success 超过 ttl 50% 直接丢弃；warning 一律回队首。 */
function requeueEvicted(item: NoticeItem, now: number, queue: NoticeItem[]): NoticeItem[] {
  if (item.level !== "warning") {
    const ttl = item.ttlMs
    if (ttl !== null && elapsedActive(item, now) > ttl * 0.5) return queue
  }
  return enqueueFront(queue, park(item))
}

/**
 * 入栈落位：有空位直接上屏；否则 error/warning 按 M3 抢占，没有可抢占对象
 * 就进队列（error 走队首，warning/info/success 按级别排序）。
 * info/success 永不抢占；warning 只挤 info/success；error 挤任意非 error。
 */
function placeIncoming(state: NoticeState, item: NoticeItem, now: number): NoticeState {
  if (state.visible.length < state.maxVisible) {
    return { ...state, visible: [...state.visible, activate(item, now)] }
  }
  const victim = pickVictim(state.visible, item.level)
  if (!victim) {
    return {
      ...state,
      queue: item.level === "error" ? enqueueFront(state.queue, item) : enqueueSorted(state.queue, item),
    }
  }
  return {
    ...state,
    visible: [...state.visible.filter((row) => row.id !== victim.id), activate(item, now)],
    queue: requeueEvicted(victim, now, state.queue),
  }
}

/** N1–N6 的入栈入口。所有时间由调用方传入，便于测试。 */
export function pushNotice(state: NoticeState, input: NoticeInput, now: number): NoticeState {
  // M7 槽位准入：progress / connectivity 是状态，不是通知。
  if (!noticeEntersSlot(input)) return state
  const current = expireVisible(state, now)
  const order = current.seq + 1
  const scope = text(input.scope)
  const dedupeKey = noticeDedupeKey(input)
  const duplicate = findDedupe(current, dedupeKey)

  // N4：同 scope 的可见/排队项被新通知顶替；被合并的那一张保留。
  let visible = current.visible
  let queue = current.queue
  if (scope) {
    const keepId = duplicate?.id ?? null
    visible = visible.filter((item) => item.scope !== scope || item.id === keepId)
    queue = queue.filter((item) => item.scope !== scope || item.id === keepId)
  }

  let next: NoticeState = { ...current, visible, queue, seq: order }

  if (duplicate) {
    const visibleIndex = visible.findIndex((item) => item.id === duplicate.id)
    if (visibleIndex >= 0) {
      visible = visible.map((item, index) => (index === visibleIndex ? mergeContent(item, input, now) : item))
      next = { ...next, visible }
    } else {
      const queueIndex = queue.findIndex((item) => item.id === duplicate.id)
      if (queueIndex >= 0) {
        const merged = mergeContent(queue[queueIndex], input, now)
        queue = queue.filter((_, index) => index !== queueIndex)
        // N3 + M3：排队中的同 key 被合并成 warning/error 后，也按新级别争取可见位。
        next = placeIncoming({ ...next, queue }, merged, now)
      }
    }
    // 顶替可能空出可见位；N3 的合并本身不新增卡。
    return fillVisible({ ...next, queue: capQueue(next.queue) }, now)
  }

  const item = createItem(input, order, now)
  next = placeIncoming(next, item, now)

  return fillVisible({ ...next, queue: capQueue(next.queue) }, now)
}

/** N7：到期清理；随后按 N1 补位。 */
export function tickNotices(state: NoticeState, now: number): NoticeState {
  return expireVisible(state, now)
}

/** 关闭任意可见/排队项；关闭可见项后按 N1 补位。 */
export function dismissNotice(state: NoticeState, id: string, now: number): NoticeState {
  const current = expireVisible(state, now)
  const visible = current.visible.filter((item) => item.id !== id)
  const queue = current.queue.filter((item) => item.id !== id)
  if (visible.length === current.visible.length && queue.length === current.queue.length) return current
  return fillVisible({ ...current, visible, queue }, now)
}

/** 5.5.5：无模态时 Esc 关闭最上层（最新）一张可见卡。 */
export function dismissTopNotice(state: NoticeState, now: number): NoticeState {
  const current = expireVisible(state, now)
  if (current.visible.length === 0) return current
  return dismissNotice(current, current.visible[current.visible.length - 1].id, now)
}

/** 来源以 scope 主动撤回（如连接恢复撤回中断警告）。 */
export function retractNoticeScope(state: NoticeState, scope: string, now: number): NoticeState {
  const target = text(scope)
  if (!target) return state
  const current = expireVisible(state, now)
  const visible = current.visible.filter((item) => item.scope !== target)
  const queue = current.queue.filter((item) => item.scope !== target)
  if (visible.length === current.visible.length && queue.length === current.queue.length) return current
  return fillVisible({ ...current, visible, queue }, now)
}

/** 兼容 shim 的「清空全部」：保留 seq，避免 id 重用。 */
export function clearNotices(state: NoticeState): NoticeState {
  return { ...state, visible: [], queue: [] }
}

/** 响应式切换同屏上限（V2 桌面/移动都是 1）；多出的从最上层开始回队列。 */
export function setNoticeMaxVisible(state: NoticeState, maxVisible: number, now: number): NoticeState {
  const max = Number.isFinite(maxVisible) ? Math.max(0, Math.floor(maxVisible)) : NOTICE_MAX_VISIBLE
  const current = expireVisible(state, now)
  let visible = [...current.visible]
  let queue = [...current.queue]
  while (visible.length > max) {
    const item = visible[visible.length - 1]
    visible = visible.slice(0, -1)
    queue = enqueueSorted(queue, park(item))
  }
  return fillVisible({ ...current, visible, queue: capQueue(queue), maxVisible: max }, now)
}

function pausedItem(item: NoticeItem, reason: NoticePauseReason, now: number): NoticeItem {
  if (item.pausedBy.includes(reason)) return item
  const remaining = item.expiresAt === null ? item.remainingMs : Math.max(0, item.expiresAt - now)
  return {
    ...item,
    pausedBy: [...item.pausedBy, reason],
    activeMs: elapsedActive(item, now),
    activeSince: null,
    remainingMs: remaining,
    expiresAt: null,
  }
}

function resumedItem(item: NoticeItem, reason: NoticePauseReason, now: number): NoticeItem {
  if (!item.pausedBy.includes(reason)) return item
  const pausedBy = item.pausedBy.filter((row) => row !== reason)
  if (pausedBy.length > 0) return { ...item, pausedBy }
  return {
    ...item,
    pausedBy,
    activeSince: now,
    expiresAt: item.remainingMs === null ? null : now + item.remainingMs,
  }
}

/** N8：鼠标悬停 / 焦点进入 → 暂停该卡；多原因叠加，全部移出才恢复。 */
export function pauseNotice(
  state: NoticeState,
  id: string,
  reason: NoticePauseReason,
  now: number,
): NoticeState {
  const current = expireVisible(state, now)
  let changed = false
  const visible = current.visible.map((item) => {
    if (item.id !== id) return item
    const next = pausedItem(item, reason, now)
    changed = changed || next !== item
    return next
  })
  return changed ? { ...current, visible } : current
}

export function resumeNotice(
  state: NoticeState,
  id: string,
  reason: NoticePauseReason,
  now: number,
): NoticeState {
  const current = expireVisible(state, now)
  let changed = false
  const visible = current.visible.map((item) => {
    if (item.id !== id) return item
    const next = resumedItem(item, reason, now)
    changed = changed || next !== item
    return next
  })
  return changed ? { ...current, visible } : current
}

export type NoticeEvent =
  | { type: "push"; notice: NoticeInput; now: number }
  | { type: "tick"; now: number }
  | { type: "dismiss"; id: string; now: number }
  | { type: "dismiss-top"; now: number }
  | { type: "pause"; id: string; reason: NoticePauseReason; now: number }
  | { type: "resume"; id: string; reason: NoticePauseReason; now: number }
  | { type: "retract-scope"; scope: string; now: number }
  | { type: "set-max-visible"; maxVisible: number; now: number }
  | { type: "clear" }

/** 单一 reducer 出口；UI 后续用 useReducer 直接接。 */
export function noticeReducer(state: NoticeState, event: NoticeEvent): NoticeState {
  switch (event.type) {
    case "push":
      return pushNotice(state, event.notice, event.now)
    case "tick":
      return tickNotices(state, event.now)
    case "dismiss":
      return dismissNotice(state, event.id, event.now)
    case "dismiss-top":
      return dismissTopNotice(state, event.now)
    case "pause":
      return pauseNotice(state, event.id, event.reason, event.now)
    case "resume":
      return resumeNotice(state, event.id, event.reason, event.now)
    case "retract-scope":
      return retractNoticeScope(state, event.scope, event.now)
    case "set-max-visible":
      return setNoticeMaxVisible(state, event.maxVisible, event.now)
    case "clear":
      return clearNotices(state)
    default:
      return state
  }
}

/** 5.5.5：操作按钮点击后默认关本卡；声明 keepOpen 的（如展开详情）保留。 */
export function noticeActionCloses(action: NoticeAction): boolean {
  return action.keepOpen !== true
}

export type NoticeAnnouncement = {
  politeness: "polite" | "assertive"
  text: string
}

/** 5.7.4：error 用 assertive，其余 polite；只拼字段，不做文案判断。 */
export function announcementFor(item: Pick<NoticeItem, "level" | "title" | "body">): NoticeAnnouncement {
  const body = item.body.trim()
  return {
    politeness: item.level === "error" ? "assertive" : "polite",
    text: body ? `${item.title}。${body}` : item.title,
  }
}

/** 方案里的短名（施工图 §2.1）；语义与上面的具名函数完全一致。 */
export const tick = tickNotices
export const dismiss = dismissNotice
export const pauseForFocus = (state: NoticeState, id: string, now: number): NoticeState =>
  pauseNotice(state, id, "focus", now)
export const retractScope = retractNoticeScope

/**
 * 兼容 shim 设计（本次只交付内核，**不改** useRelay / UI）：
 *
 * 现有 `type Notice = { text: string; tone: "warn" | "bad"; codes?: NoticeCode[] } | null`
 * 在下一阶段按下面规则接到本 reducer，调用点不直接拼 NoticeItem：
 * - `setNotice(null)` / `notify("", tone)`  → `clearNotices(state)`（空串是清空，不是一条空通知）
 * - `notify(text, "warn")`                  → `{ level: "warning", title: text, body: "" }`
 * - `notify(text, "bad")`                   → `{ level: "error", title: text, body: "" }`（迁移期过渡，正式接入时补 5.5.7 的 body/actions）
 * - `codes` 只做一次**显式白名单**准入，并作为缺省 dedupeKey；生命周期仍只看 level/scope/key：
 *     connectivity → 连接 chip / banner（scope: "connection" 的 warning/success）
 *     progress / compaction / summarization / truncated / lazy-send → StatusLine，不进通知栈
 *     其余 → 通知栈
 * - 132 个调用点按「progress → StatusLine；connectivity → 连接状态；其余 → notify」三分，
 *   禁止在 reducer 里按 title/body 猜类别；`dedupeKey` / `scope` 由调用方显式传入。
 */
