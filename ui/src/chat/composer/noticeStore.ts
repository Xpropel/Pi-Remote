/** 通知栈的全局单例存储：让所有页面（含手机列表页、设置页）共用同一个 1 张可见上限。
 *
 *  生命周期仍然全部由 noticeCore 的纯 reducer 决定；本文件只补：
 *  - 订阅（useSyncExternalStore）
 *  - 到期定时器（只按最早 expiresAt 排一次）
 *  - action 回调表
 */

import {
  emptyNotices,
  noticeActionCloses,
  noticeReducer,
  type NoticeAction,
  type NoticeInput,
  type NoticeItem,
  type NoticePauseReason,
  type NoticeState,
} from "../noticeCore.ts"

let state: NoticeState = emptyNotices()
const listeners = new Set<() => void>()
const handlers = new Map<string, (action: NoticeAction) => void>()
let idSeq = 0
let tickTimer: ReturnType<typeof setTimeout> | null = null
let tickAt = 0

function emit() {
  for (const listener of listeners) listener()
}

function scheduleTick() {
  const next = state.visible.reduce<number>((min, item) => {
    if (item.expiresAt === null) return min
    return item.expiresAt < min ? item.expiresAt : min
  }, Number.POSITIVE_INFINITY)
  if (!Number.isFinite(next)) {
    if (tickTimer !== null) clearTimeout(tickTimer)
    tickTimer = null
    tickAt = 0
    return
  }
  // 已有更早/相同的定时器就不重排；更晚的到点后再排下一张。
  if (tickTimer !== null && tickAt <= next) return
  if (tickTimer !== null) clearTimeout(tickTimer)
  tickAt = next
  tickTimer = setTimeout(() => {
    tickTimer = null
    tickAt = 0
    dispatch({ type: "tick", now: Date.now() })
  }, Math.max(0, next - Date.now()))
}

/** 只保留仍在可见区/队列里的 action 回调，避免合并/溢出/关闭后长期持有闭包。 */
function pruneHandlers() {
  const live = new Set<string>()
  for (const item of [...state.visible, ...state.queue]) {
    live.add(item.id)
    if (item.dedupeKey) live.add(`key:${item.dedupeKey}`)
  }
  for (const key of handlers.keys()) {
    if (!live.has(key)) handlers.delete(key)
  }
}

function commit(next: NoticeState) {
  if (next === state) return
  state = next
  pruneHandlers()
  scheduleTick()
  emit()
}

function dispatch(event: Parameters<typeof noticeReducer>[1]) {
  commit(noticeReducer(state, event))
}

export function getNoticeSnapshot(): NoticeState {
  return state
}

export function subscribeNotices(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const noticeStore = {
  /** 入栈；返回实际 id（显式 id 优先，否则 n1、n2…）。 */
  push(input: NoticeInput, onAction?: (action: NoticeAction) => void): string {
    const id = input.id?.trim() || `n${++idSeq}`
    const key = input.dedupeKey?.trim()
    if (onAction) {
      handlers.set(id, onAction)
      // N3 合并时 reducer 沿用旧 id，用 dedupeKey 再挂一份。
      if (key) handlers.set(`key:${key}`, onAction)
    }
    dispatch({ type: "push", notice: { ...input, id }, now: Date.now() })
    return id
  },
  dismiss(id: string) {
    dispatch({ type: "dismiss", id, now: Date.now() })
  },
  dismissTop() {
    dispatch({ type: "dismiss-top", now: Date.now() })
  },
  pause(id: string, reason: NoticePauseReason) {
    dispatch({ type: "pause", id, reason, now: Date.now() })
  },
  resume(id: string, reason: NoticePauseReason) {
    dispatch({ type: "resume", id, reason, now: Date.now() })
  },
  retract(scope: string) {
    dispatch({ type: "retract-scope", scope, now: Date.now() })
  },
  clear() {
    dispatch({ type: "clear" })
  },
  setMaxVisible(maxVisible: number) {
    dispatch({ type: "set-max-visible", maxVisible, now: Date.now() })
  },
  runAction(item: Pick<NoticeItem, "id" | "dedupeKey">, action: NoticeAction) {
    // N3 合并沿用旧 id，但最新一次 push 的 action 回调挂在 dedupeKey 上，优先用它。
    const handler =
      (item.dedupeKey ? handlers.get(`key:${item.dedupeKey}`) : undefined) ?? handlers.get(item.id)
    handler?.(action)
    if (noticeActionCloses(action)) dispatch({ type: "dismiss", id: item.id, now: Date.now() })
  },
}

export type NoticeStore = typeof noticeStore

export type NoticesApi = NoticeStore & {
  visible: NoticeItem[]
  queue: NoticeItem[]
}

/** 测试用：只重置内存态，不改变 UI 上限。 */
export function resetNoticeStoreForTest() {
  if (tickTimer !== null) clearTimeout(tickTimer)
  tickTimer = null
  tickAt = 0
  handlers.clear()
  idSeq = 0
  state = emptyNotices()
  emit()
}
