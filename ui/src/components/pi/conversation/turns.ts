/**
 * 对话流按回合切分（PiTranscript 用；纯函数，node --test 直接加载，所以只用相对路径 + .ts 后缀）。
 * - 回合 = 一条用户消息 + 它后面的回复；第一条用户消息之前的回复自成一个没有用户卡的回合。
 * - 重试折叠：「重新回答」= pi 把上一条用户消息原样再发一遍，接在后面成为新的一轮，不替换也不分叉（data-interface regenerate）。
 *   以出错结束、又被下一轮一字不差重发过的回合折进下一轮（"上次出错，已重试"）；自己把同一句话再发一遍也算重试。
 */
import { turnErrorOf } from "../../../pi/model/turnError.ts"
import type { PiAssistantItem, PiItem, PiUserItem } from "../shared/types.ts"

export type Turn = { user?: PiUserItem; rest: PiItem[] }

/** 按用户消息切回合 */
export function splitTurns(items: readonly PiItem[]): Turn[] {
  const turns: Turn[] = []
  for (const item of items) {
    if (item.kind === "user") turns.push({ user: item, rest: [] })
    else {
      if (turns.length === 0) turns.push({ rest: [] })
      turns[turns.length - 1].rest.push(item)
    }
  }
  return turns
}

export function lastAssistantOf(turn: Turn): PiAssistantItem | undefined {
  for (let i = turn.rest.length - 1; i >= 0; i--) {
    const it = turn.rest[i]
    if (it.kind === "assistant") return it
  }
  return undefined
}

/** 以出错结束的这一轮被下一轮重试过：下一轮的用户消息和它一字不差，并且已经交给了 pi（发送失败、还在排队 / 等重连的不算） */
export function retriedBy(turn: Turn, next: Turn | undefined): boolean {
  const text = turn.user?.text.trim()
  const again = next?.user
  if (!text || !again || again.text.trim() !== text || again.failed || again.outbox || again.queued) return false
  const last = lastAssistantOf(turn)
  return !!last && turnErrorOf(last.stopReason, last.errorMessage)?.error === true
}

/** 渲染单位：一个回合（index = 它在 splitTurns 里的位置）+ 折进它的那几轮（之前出错、被它重试掉的，按先后） */
export type TurnView = { turn: Turn; index: number; attempts: Turn[] }
export function turnViewsOf(turns: readonly Turn[]): TurnView[] {
  const views: TurnView[] = []
  let attempts: Turn[] = []
  turns.forEach((turn, index) => {
    if (retriedBy(turn, turns[index + 1])) attempts.push(turn)
    else {
      views.push({ turn, index, attempts })
      attempts = []
    }
  })
  return views
}

/** 用户卡还没交到 pi（排队等注入、等重连、发送失败）：它既不是 pi 在跑的回合，也不标志前一回合收尾 */
export function notYetWithPi(user: PiUserItem): boolean {
  return !!(user.queued || user.outbox || user.awaiting || user.failed) || user.status === "awaiting"
}

/**
 * 正在跑的回合（-1 = 没在跑）：最后一个 pi 已经收下用户消息的回合。流尾还没交到 pi、也还没有回复的用户卡跳过 ——
 * 排队的消息要等前一回合的工具跑完才插进去，在那之前 pi 还在前一回合里（它不出用时与操作行，思考计时、subagent 行照旧挂在它上面）。
 */
export function runningTurnOf(turns: readonly Turn[], running: boolean): number {
  if (!running) return -1
  let t = turns.length - 1
  for (; t > 0; t--) {
    const { user, rest } = turns[t]
    if (rest.length > 0 || !user || !notYetWithPi(user)) break
  }
  return t
}

/** 条目的结束时刻：助手消息 = 结束时间（没有就 开始 + 时长）；其余 = 时间戳 */
export function itemEndOf(item: PiItem): number | undefined {
  if (item.kind === "assistant") {
    if (item.endedAt != null) return item.endedAt
    if (item.startedAt != null && item.durationMs != null) return item.startedAt + item.durationMs
  }
  return item.timestamp
}

const SETTLED_TOOL = new Set<string>(["output-available", "output-error", "denied", "cancelled"])

/**
 * 回合用时（§1.9，毫秒；缺一端、还没有回复时 null）：用户消息时间戳 → 回合里最后结束的那条消息。
 * 回合平时以一条助手消息收尾，工具都在它之前跑完。停在调工具的那条助手消息上（stopReason toolUse）的回合例外：
 * 工具执行的时间不在任何一条消息的起止里（工具结果并进了工具块，转录不记它的时刻），终点只能从下一条消息推。
 * - 插进正在跑的回合的消息（排队的 steer）：pi 在工具跑完（turn_end）时注入它，前一回合的终点取它的时间戳（和最后一个工具结果只差 1–2 ms，会话文件实测）；
 * - 推不出来就不出用时，不先写短了再改口：工具还没出结果、下一条还没交到 pi、pi 中途退出过，
 *   以及停止的那一端（本端按下停止就不算在跑了，工具结果和停止收尾随后才到）。中途停止的回合最后以停止收尾消息结束，按它算。
 */
export function turnDurationOf(turns: readonly Turn[], index: number): number | null {
  const turn = turns[index]
  const start = turn?.user?.timestamp
  if (start == null || !turn.rest.some((r) => r.kind === "assistant")) return null
  let end: number | undefined
  for (const item of turn.rest) {
    const e = itemEndOf(item)
    if (e != null && (end == null || e > end)) end = e
  }
  const last = lastAssistantOf(turn)
  if (last?.stopReason === "toolUse") {
    const next = turns[index + 1]?.user
    const handoff = next && !notYetWithPi(next) ? next.timestamp : undefined
    if (handoff == null || !last.blocks.every((b) => b.kind !== "tool" || SETTLED_TOOL.has(b.state))) return null
    if (end == null || handoff > end) end = handoff
  }
  return end == null ? null : end - start
}

/**
 * 「重新回答」挂在哪个回合（-1 = 不挂）：它重发的是 pi 收到的最后一条用户消息，所以是最近一个有回复的回合
 * （后面还没发出去 / 发送失败的用户卡不算）；pi 在跑时不挂（忙时 regenerate 直接被拒）。
 */
export function retryTurnOf(turns: readonly Turn[], running: boolean): number {
  if (running) return -1
  for (let t = turns.length - 1; t >= 0; t--) if (turns[t].rest.some((r) => r.kind === "assistant")) return t
  return -1
}
