/**
 * 对话流的渲染窗与"新消息"计数（PLAN 4.3；design D01、D21）。纯函数，Node 单测直接测（test/pi-p4-b.test.mjs）。
 *
 * - 渲染窗（D01）：长会话一次只挂最近 PI_TRANSCRIPT_WINDOW 条（和旧界面 chat/parts.tsx 的 TRANSCRIPT_PAGE 同为 300）；
 *   窗外还有时，流顶出一行"显示更早的 N 条"（N = 下一页的条数，最多 300），点一次多挂一页。状态层上限是
 *   relay/transcript.ts 的 TRANSCRIPT_MAX_ITEMS（1 万条），渲染窗只管 DOM 里挂多少。
 * - 新消息计数（D21）：用户上滑离开底部时记下当时最后一条的 key；之后追加在它后面的条目数就是 tray 右端
 *   "回到底部"钮旁的"N 条新消息"。流式更新同一条（key 不变）不算新消息；回到底部后清零。
 */

/** 渲染窗：每页条数，也是初始挂载的条数 */
export const PI_TRANSCRIPT_WINDOW = 300

export interface PiTranscriptWindow<T> {
  /** 挂进 DOM 的那一段（最后 limit 条） */
  visible: readonly T[]
  /** 窗外（更早）还有几条 */
  hidden: number
  /** 点"显示更早的 N 条"会多挂几条（= min(hidden, page)） */
  nextPage: number
}

/** 取最后 limit 条；limit 不是正数时按 0 */
export function transcriptWindowOf<T>(items: readonly T[], limit: number, page: number = PI_TRANSCRIPT_WINDOW): PiTranscriptWindow<T> {
  const keep = Math.max(0, Math.floor(limit))
  const hidden = Math.max(0, items.length - keep)
  return { visible: hidden > 0 ? items.slice(hidden) : items, hidden, nextPage: Math.min(hidden, Math.max(0, page)) }
}

/** 流顶那一行的文字（D01） */
export function showEarlierText(nextPage: number): string {
  return `显示更早的 ${nextPage} 条`
}

/**
 * 上滑时记下的最后一条（markKey）之后又追加了几条。markKey 为 null（在底部）时为 0。从尾部往前找：新消息总在末尾，找到得快。
 * markKey 已经不在列表里时（O-R1：记下的是本页发出的乐观气泡，pi 的 user 消息到了会换成另一个 key），
 * 有 markAt（记下时它在列表里的下标）就按下标数：气泡是原位换掉的，条数不变，之后追加的照样算；没有 markAt 为 0。
 */
export function newItemsAfter(items: readonly { key: string }[], markKey: string | null, markAt?: number): number {
  if (markKey == null) return 0
  for (let i = items.length - 1; i >= 0; i--) if (items[i].key === markKey) return items.length - 1 - i
  return typeof markAt === "number" && markAt >= 0 ? Math.max(0, items.length - 1 - markAt) : 0
}

/**
 * 本页刚发出一条消息（O-R1）：最后一条换了，而且是本页的用户气泡（乐观气泡 from=local，或离线进了 outbox 的卡）。
 * 这时对话流回到底部重新贴住，用户能看到自己发的消息和随后的回答；别处（终端、别的网页）发来的不算。
 */
export function isOwnSendAppended(items: readonly { key: string; kind?: string; from?: string; outbox?: boolean }[], prevLastKey: string | null): boolean {
  const last = items[items.length - 1]
  if (!last || last.key === prevLastKey || last.kind !== "user") return false
  return last.from === "local" || last.outbox === true
}

/** 列表最后一条的 key（空列表 null）：上滑离开底部时用它当 markKey */
export function lastKeyOf(items: readonly { key: string }[]): string | null {
  return items.length > 0 ? items[items.length - 1].key : null
}
