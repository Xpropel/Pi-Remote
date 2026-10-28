import { useSyncExternalStore } from "react"

/*
 * 对话流的吸底状态（b 线实现；c 线的 ComposerContainer 读它画 tray 的"回到底部"钮和新消息计数，D21）。
 * 照 #/play 的 PlayStickTray：TranscriptContainer 把 PiTranscript 的 onStickChange 报进这个模块级 store（piTranscriptStick.report），
 * 并把 PiTranscript 的 ref 登记在这里（piTranscriptStick.handle）；onScrollDown 调它的 scrollToBottom。一页只有一个对话流。
 * 返回值的形状是跨线契约（R2/p5-lanes.md §2），b 线只改实现。
 */
export interface PiTranscriptStick {
  /** 已上滑离开底部：tray 出"回到底部" */
  scrollDown: boolean
  /** 离开底部后新来的消息数 */
  newCount: number
  onScrollDown: () => void
}

type StickState = { atBottom: boolean; newCount: number }

const AT_BOTTOM: StickState = { atBottom: true, newCount: 0 }
let state: StickState = AT_BOTTOM
const subs = new Set<() => void>()

/** PiTranscript 的命令（ref 拿到的 PiTranscriptHandle，形状只要 scrollToBottom） */
type StickHandle = { scrollToBottom: () => void }

/** TranscriptContainer 用：报吸底状态、登记 ref、卸载时复位 */
export const piTranscriptStick = {
  /** PiTranscript 的 onStickChange（挂载时先报一次；状态没变不通知） */
  report(next: StickState): void {
    if (next.atBottom === state.atBottom && next.newCount === state.newCount) return
    state = next.atBottom && next.newCount === 0 ? AT_BOTTOM : { atBottom: next.atBottom, newCount: next.newCount }
    for (const f of subs) f()
  },
  /** PiTranscript 的 ref（React 19 的 ref 回调：挂上给 handle，卸掉给 null） */
  handle: { current: null as StickHandle | null },
  /** 对话流卸掉（换页、关会话）：复位成"在底部"，免得 tray 留着上一页的"回到底部" */
  reset(): void {
    piTranscriptStick.report(AT_BOTTOM)
  },
}

function subscribe(f: () => void): () => void {
  subs.add(f)
  return () => {
    subs.delete(f)
  }
}

const getState = () => state

const scrollDown = () => piTranscriptStick.handle.current?.scrollToBottom()

export function useTranscriptStick(): PiTranscriptStick {
  const s = useSyncExternalStore(subscribe, getState, getState)
  return { scrollDown: !s.atBottom, newCount: s.atBottom ? 0 : s.newCount, onScrollDown: scrollDown }
}
