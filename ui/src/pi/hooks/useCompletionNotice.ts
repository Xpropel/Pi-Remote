/**
 * 设置页 v2 · 应用内提醒（宿主 hook）。
 *
 * 两条真实信号，分别消费 prefs.notifications：
 *   - 回合结束（relay.turnEnd，当前房间）：出错 / 完成（用户手动停止不产生信号，见 useRelay finishTurn）；
 *   - 新出现的等待条目（attentionItemsOf 的 waiting key）：等你回答；提醒过的等待全部结束时撤回那张卡。
 * 「仅当我不在页面时 / 总是提醒」由 prefs.notifyOnlyWhenAway 控制；
 * 文案只有事件类型（「回合出错」/「任务完成」/「有任务等你回答」），永远不带会话标题或正文——
 * 这样隐私模式与非隐私模式共用一条安全文案。
 *
 * 通过 relay.pushNotice 进入第 5 章通知栈（NoticeContainer 已渲染），不新增系统通知权限。
 */
import { useEffect, useRef, useState } from "react"
import { pageAway } from "@/chat/composer/faviconBadge"
import { playCompletionSound } from "@/chat/composer/sound"
import {
  notificationNoticeOf,
  notificationSoundVisible,
  WAITING_NOTICE_SCOPE,
  waitingNoticeAnnounced,
  waitingNoticeStep,
  type PiNotificationGate,
  type PiNotificationNotice,
  type WaitingNoticeLedger,
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
    pushNotice({ ...notice, context: `room:${signal.roomId}` })
  }, [signal, away, enabled, gate, pushNotice])
}

interface WaitingRelay {
  pushNotice: (input: PiNotificationNotice) => unknown
  retractNoticeScope: (scope: string) => void
}

export interface UseWaitingNoticeOptions {
  gate: PiNotificationGate
  /** 宿主总开关（静态画廊 / 旧入口可关）。 */
  enabled?: boolean
  /** 当前所有 waiting 条目的稳定 key（顺序无关）。 */
  waitingKeys: readonly string[]
  /** 全部会话（含当前会话账本）的 waiting key：只用来建基线。 */
  knownKeys: readonly string[]
  /** 首份真实数据已到（连上且收到名册 / 账本）。false 时不建基线；断线重连后重建。 */
  ready: boolean
}

/**
 * 等待提醒：只在 waiting key 集合「新增」时发一次（一个回合可能同时开多个弹窗）。
 * 基线等首份真实数据到了再建：页面打开 / 重连时已经挂着的等待不补发；
 * 偏好关闭 / 仅页面外不满足时静默记账，之后再打开偏好不会把旧等待重新提醒一遍。
 * 弹过的提醒记进账本；那些等待全部结束（答了 / 取消 / 停止回合）时按 scope 撤回卡片，不等 ttl。
 */
export function useWaitingNotice(relay: WaitingRelay, options: UseWaitingNoticeOptions): void {
  const { gate, enabled = true, waitingKeys, knownKeys, ready } = options
  const away = usePageAwayState()
  const ledgerRef = useRef<WaitingNoticeLedger | null>(null)
  const pushNotice = relay.pushNotice
  const retractNoticeScope = relay.retractNoticeScope

  useEffect(() => {
    const step = waitingNoticeStep(ledgerRef.current, { ready, waitingKeys, knownKeys })
    ledgerRef.current = step.ledger
    if (step.retract) retractNoticeScope(WAITING_NOTICE_SCOPE)
    if (!enabled || step.fresh.length === 0) return
    const notice = notificationNoticeOf(gate, "waiting", away)
    if (notice) {
      pushNotice(notice)
      ledgerRef.current = waitingNoticeAnnounced(ledgerRef.current, step.fresh)
    }
    if (notificationSoundVisible(gate, "waiting", away)) {
      playCompletionSound("waiting", { enabled: gate.sound, requireAway: gate.onlyWhenAway })
    }
  }, [waitingKeys, knownKeys, ready, away, enabled, gate, pushNotice, retractNoticeScope])
}
