/**
 * 设置页 v2 · 应用内提醒（宿主 hook）。
 *
 * 两条真实信号，分别消费 prefs.notifications：
 *   - 回合结束（relay.turnEnd，当前房间）：出错 / 完成；
 *   - 新出现的等待条目（attentionItemsOf 的 waiting key）：等待你确认。
 * 「仅当我不在页面时 / 总是提醒」由 prefs.notifyOnlyWhenAway 控制；
 * 文案只有事件类型（「回合出错」/「任务完成」/「有任务等你确认」），永远不带会话标题或正文——
 * 这样隐私模式与非隐私模式共用一条安全文案。
 *
 * 通过 relay.pushNotice 进入第 5 章通知栈（NoticeContainer 已渲染），不新增系统通知权限。
 */
import { useEffect, useRef, useState } from "react"
import { pageAway } from "@/chat/composer/faviconBadge"
import { playCompletionSound } from "@/chat/composer/sound"
import {
  freshWaitingKeys,
  notificationNoticeOf,
  notificationSoundVisible,
  type PiNotificationGate,
  type PiNotificationNotice,
} from "../model/settingsHost"

/** 页面在不在场（与角标 / 提示音 / 应用内提醒同一口径）。 */
function usePageAwayState(): boolean {
  const [away, setAway] = useState(pageAway)
  useEffect(() => {
    const update = () => setAway(pageAway())
    document.addEventListener("visibilitychange", update)
    window.addEventListener("focus", update)
    window.addEventListener("blur", update)
    return () => {
      document.removeEventListener("visibilitychange", update)
      window.removeEventListener("focus", update)
      window.removeEventListener("blur", update)
    }
  }, [])
  return away
}

interface TurnEndRelay {
  roomId: string
  turnEnd: { seq: number; at: number; roomId: string; error: boolean } | null
  pushNotice: (input: PiNotificationNotice) => unknown
}

export interface UseCompletionNoticeOptions {
  gate: PiNotificationGate
  /** 宿主总开关（开发画廊静态态 / 旧入口可关）。 */
  enabled?: boolean
}

export function useCompletionNotice(relay: TurnEndRelay, options: UseCompletionNoticeOptions): void {
  const { gate, enabled = true } = options
  const away = usePageAwayState()
  const consumedRef = useRef(0)

  const signal = relay.turnEnd && relay.turnEnd.roomId === relay.roomId ? relay.turnEnd : null
  const pushNotice = relay.pushNotice

  useEffect(() => {
    if (!signal) return
    // 无论发不发，都记下这条 seq：关掉偏好后又打开，不能把旧回合补发出来。
    if (signal.seq === consumedRef.current) return
    consumedRef.current = signal.seq
    if (!enabled) return
    const notice = notificationNoticeOf(gate, signal.error ? "error" : "done", away)
    if (!notice) return
    pushNotice(notice)
  }, [signal, away, enabled, gate, pushNotice])
}

interface WaitingRelay {
  pushNotice: (input: PiNotificationNotice) => unknown
}

export interface UseWaitingNoticeOptions {
  gate: PiNotificationGate
  /** 宿主总开关（静态画廊 / 旧入口可关）。 */
  enabled?: boolean
  /** 当前所有 waiting 条目的稳定 key（顺序无关）。 */
  waitingKeys: readonly string[]
}

/**
 * 等待提醒：只在 waiting key 集合「新增」时发一次（一个回合可能同时开多个弹窗）。
 * 页面打开时已经挂着的弹窗不补发（首次快照只记账）；偏好关闭 / 仅页面外不满足时静默记账，
 * 之后再打开偏好不会把旧等待重新提醒一遍。
 */
export function useWaitingNotice(relay: WaitingRelay, options: UseWaitingNoticeOptions): void {
  const { gate, enabled = true, waitingKeys } = options
  const away = usePageAwayState()
  const seenRef = useRef<readonly string[] | null>(null)
  const pushNotice = relay.pushNotice

  useEffect(() => {
    const fresh = freshWaitingKeys(seenRef.current, waitingKeys)
    seenRef.current = waitingKeys
    if (!enabled || fresh.length === 0) return
    const notice = notificationNoticeOf(gate, "waiting", away)
    if (notice) pushNotice(notice)
    if (notificationSoundVisible(gate, "waiting", away)) {
      playCompletionSound("waiting", { enabled: gate.sound, requireAway: gate.onlyWhenAway })
    }
  }, [waitingKeys, away, enabled, gate, pushNotice])
}
