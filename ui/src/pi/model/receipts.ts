/**
 * 回合收据行（design §1.9 诚实数据、§1.10 文案、§10）。纯函数，node --test 直接加载。
 * 用时的文字由容器用 components/pi/shared/format.ts 的 piDuration(workedMs) 写成"用时 2m 14s"，这里只给毫秒。
 */
import type { Item } from "../../relay/transcript.ts"

export type PiTurnInput = {
  /** 一个回合的条目：第一条是用户消息，后面是它引出的回复 */
  items: readonly Item[]
  /** 界面层实时观测到的思考时长（observedMs）；快照恢复的历史没有 */
  thinkingObservedMs?: number | null
}

export type PiTurnReceipts = {
  /** 回合用时 = 最后一条消息时间 − 第一条用户消息时间；缺任一时间戳为 null */
  workedMs: number | null
  /** "思考 6 秒"（观测到起止）/ "已思考"（有思考块但没有时长）；没有思考为 null */
  thinking: { text: string; ms: number | null } | null
}

function stamp(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null
}

function endOf(item: Item): number | null {
  if (item.kind === "assistant") return stamp(item.endedAt) ?? stamp(item.timestamp)
  return stamp(item.timestamp)
}

/** 回合 → 收据。两项都没有时返回 null（整行不出现）。 */
export function turnReceipts(turn: PiTurnInput | null | undefined): PiTurnReceipts | null {
  if (!turn || turn.items.length === 0) return null
  const first = turn.items[0]
  const last = turn.items[turn.items.length - 1]
  const start = first.kind === "user" ? stamp(first.timestamp) : null
  const end = turn.items.length > 1 ? endOf(last) : null
  const workedMs = start !== null && end !== null && end >= start ? end - start : null

  const thought = turn.items.some((item) => item.kind === "assistant" && item.blocks.some((b) => b.kind === "thinking"))
  let thinking: PiTurnReceipts["thinking"] = null
  if (thought) {
    const ms = stamp(turn.thinkingObservedMs)
    thinking = ms !== null ? { text: `思考 ${Math.max(1, Math.round(ms / 1000))} 秒`, ms } : { text: "已思考", ms: null }
  }
  if (workedMs === null && thinking === null) return null
  return { workedMs, thinking }
}
