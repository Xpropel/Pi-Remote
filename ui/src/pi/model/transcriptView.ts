/**
 * 对话流容器（TranscriptContainer，PLAN 5.4 / §7.2）用的纯函数：relay 的转录 → PiTranscript 的 props。
 * 纯函数，node --test 直接加载（相对导入带 .ts）。口径：
 * - 诚实数据（design §1.9）：时间戳缺就不写用时；思考时长只有界面层实时观测到起止时才有（observedMs），快照恢复的历史写"已思考"。
 * - 工具块上由 transcript 提升的 patch（G5）交给 diff 卡（PiToolBlock.details.patch）；write 没有 patch，diff 卡用 input.content。
 * - 默认展开（推断，和 replica 各屏一致）：回合在跑、没在等你回答、右 pane 没开时，展开本回合的思考块和正在跑的终端卡
 *   （pane 开着时终端输出在终端视图里展开，§1.8 同一条命令只在一处展开）；回合结束后，最近一个有回复的回合里失败的终端卡展开
 *   （stderr 红字看得到）。
 */
import { isLiveThinking, toolDisplayState, type Block, type Item } from "../../relay/transcript.ts"
import { agentIsActive, type AgentEntry } from "../../chat/capsules/workingModel.ts"
import { assistantMarkdown } from "../../conversation/messageActionsModel.ts"
import type { PiItem, PiSubagent, PiUserItem } from "../../components/pi/shared/types.ts"
import type { OutboxEntry } from "./outbox.ts"

type ToolBlock = Extract<Block, { kind: "tool" }>

const TERMINAL_TOOLS = new Set(["bash", "powershell", "shell"])

function isTerminalTool(block: Block): block is ToolBlock {
  return block.kind === "tool" && TERMINAL_TOOLS.has(block.name.trim().toLowerCase())
}

/** 思考块的键（PiTranscript 的 expanded / observed 都用它）："<item.key>:<块下标>" */
export function thinkingKey(itemKey: string, index: number): string {
  return `${itemKey}:${index}`
}

/**
 * relay 条目 → PiTranscript 的条目：工具块的 patch 放进 details.patch；思考块补上观测到的时长。
 * 没有要改的条目原样返回（同一个对象），方便部件按引用比较。
 */
export function piItemsOf(items: readonly Item[], observedMs?: ReadonlyMap<string, number> | null): PiItem[] {
  return items.map((item): PiItem => {
    // 压缩摘要的收据行写 design D19 的"已压缩上下文"（relay 转录层沿用旧界面的"已折叠早期对话"，分支摘要不动）
    if (item.kind === "summary") return item.title === "已折叠早期对话" ? { ...item, title: "已压缩上下文" } : item
    if (item.kind !== "assistant") return item
    let changed = false
    const blocks = item.blocks.map((block, index) => {
      if (block.kind === "tool" && typeof block.patch === "string" && block.patch) {
        changed = true
        return { ...block, details: { patch: block.patch } }
      }
      if (block.kind === "thinking") {
        const ms = observedMs?.get(thinkingKey(item.key, index))
        if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
          changed = true
          return { ...block, observedMs: ms }
        }
      }
      return block
    })
    return changed ? { ...item, blocks } : item
  })
}

/** outbox 条目里流尾要用的字段（OutboxEntry 的子集） */
export type PiOutboxStreamEntry = Pick<OutboxEntry, "cid" | "text" | "status" | "at">

/**
 * 本页 outbox（P5.6，design §1.12 / A07）→ 接在流尾的用户卡，卡下灰字"等重连后发送"（PiUserItem.outbox）。
 * - 只画还没送出去的（queued；replaying 在回放 echo 之前的一瞬也算）：转录里已经有同 cid 气泡的不重复画
 *   （回放时 useRelay 先 echo 同 cid 的气泡，之后由它显示发送中 / 送达 / 失败）。
 * - failed 不画：回放失败的气泡在转录里（红字"发送失败 · 重试"）；页面重开后结果未知的只在排队面板里（"可能已送达，先看会话"），
 *   流里不再画一张可能重复的卡。
 * 形状同画廊屏 a/reconnecting（from "remote" = 从网页发的；key 带 cid，重试换了 cid 这一行会重建）。
 */
export function outboxItemsOf(outbox: readonly PiOutboxStreamEntry[], items: readonly Item[]): PiUserItem[] {
  if (outbox.length === 0) return []
  const shown = new Set<string>()
  for (const item of items) if (item.kind === "user" && item.cid) shown.add(item.cid)
  const out: PiUserItem[] = []
  for (const entry of outbox) {
    if (entry.status === "failed" || shown.has(entry.cid)) continue
    out.push({ kind: "user", key: `outbox-${entry.cid}`, text: entry.text, images: [], timestamp: entry.at, from: "remote", cid: entry.cid, outbox: true })
  }
  return out
}

/** 按用户消息切回合：返回每个回合在 items 里的 [起, 止)；第一条用户消息之前的条目单独算一个回合 */
function turnRanges(items: readonly Item[]): [number, number][] {
  const out: [number, number][] = []
  let start = 0
  for (let i = 1; i <= items.length; i++) {
    if (i === items.length || items[i].kind === "user") {
      if (i > start) out.push([start, i])
      start = i
    }
  }
  return out
}

function stamp(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null
}

/** 正在跑的回合从什么时候开始：最后一条用户消息的时间戳；没有就用它后面第一条助手消息的开始时间；都没有返回 null（不编） */
export function turnStartOf(items: readonly Item[]): number | null {
  const last = turnRanges(items).at(-1)
  if (!last) return null
  const first = items[last[0]]
  if (first.kind === "user" && stamp(first.timestamp) !== null) return stamp(first.timestamp)
  for (let i = last[0]; i < last[1]; i++) {
    const it = items[i]
    if (it.kind === "assistant") return stamp(it.startedAt) ?? stamp(it.timestamp)
  }
  return null
}

/**
 * 运行行（PiTranscript 的 running）：回合在跑才有。waiting = 有审批卡在等你（"等你回答"只在卡上表达，流末尾不放运行行，§5）。
 * since 为 null 时运行行不写用时。
 */
export function runningOf(items: readonly Item[], busy: boolean, waiting: boolean): { since: number | null; line: boolean } | null {
  if (!busy) return null
  return { since: turnStartOf(items), line: !waiting }
}

export type PiExpandInput = {
  /** 回合在跑（relay.busy） */
  running: boolean
  /** 有审批卡在等你：不自动展开（终端卡其实停在确认框前，G6） */
  waiting: boolean
  /** 右 pane 开着（桌面）：主区变窄，运行中也不自动展开；终端输出这时在终端视图里展开（§1.8 同一条命令只在一处展开） */
  paneOpen: boolean
}

/** 默认展开的块（工具块 id、思考块键），规则见文件头 */
export function liveExpandedOf(items: readonly Item[], input: PiExpandInput): string[] {
  const out: string[] = []
  const turns = turnRanges(items)
  if (input.running) {
    const last = turns.at(-1)
    if (input.waiting || input.paneOpen || !last) return out
    for (let i = last[0]; i < last[1]; i++) {
      const it = items[i]
      if (it.kind !== "assistant") continue
      it.blocks.forEach((block, index) => {
        if (block.kind === "thinking" && block.text.trim()) out.push(thinkingKey(it.key, index))
        else if (isTerminalTool(block) && toolDisplayState(block) === "running") out.push(block.id)
      })
    }
    return out
  }
  // 回合结束：最近一个有回复的回合里失败的终端卡（拒绝 / 超时只是一行灰字，不算）
  for (let t = turns.length - 1; t >= 0; t--) {
    const [from, to] = turns[t]
    const turn = items.slice(from, to)
    if (!turn.some((it) => it.kind === "assistant")) continue
    for (const it of turn) {
      if (it.kind !== "assistant") continue
      for (const block of it.blocks) {
        if (isTerminalTool(block) && toolDisplayState(block) === "failed" && block.outcome !== "timeout") out.push(block.id)
      }
    }
    break
  }
  return out
}

/** agent_state → subagent 行：只要排队 / 在跑、有开始时间的（没有上报就是空数组，不出现 subagent 行，D13） */
export function subagentsOf(agents: readonly AgentEntry[] | null | undefined): PiSubagent[] {
  if (!agents) return []
  const out: PiSubagent[] = []
  for (const a of agents) {
    const startedAt = stamp(a.startedAt)
    if (!agentIsActive(a) || startedAt === null) continue
    out.push({ name: a.name || "subagent", task: a.task || a.description || "", startedAt })
  }
  return out
}

/* ---------------- 思考时长的实时观测（observedMs，design §1.9、§7.2 conversation-streaming） ---------------- */

/**
 * open：正在思考的块 → 开始时刻；done：已结束的块 → 观测到的时长；skip：第一次观测时已经在思考的块
 * （开头没看到，计出来会偏短，所以不计，照旧写"已思考"）。started = 这个会话已经观测过一次。
 */
export type PiThinkingClock = {
  readonly open: ReadonlyMap<string, number>
  readonly done: ReadonlyMap<string, number>
  readonly skip: ReadonlySet<string>
  readonly started: boolean
}

export const EMPTY_THINKING_CLOCK: PiThinkingClock = Object.freeze({
  open: new Map<string, number>(),
  done: new Map<string, number>(),
  skip: new Set<string>(),
  started: false,
})

function liveThinkingKeys(items: readonly Item[]): Set<string> {
  const live = new Set<string>()
  for (const item of items) {
    if (item.kind !== "assistant" || !item.live) continue
    item.blocks.forEach((block, index) => {
      if (block.kind === "thinking" && isLiveThinking(item.blocks, index, item.live)) live.add(thinkingKey(item.key, index))
    })
  }
  return live
}

/**
 * 每次转录变化时调一次（容器在快照落地之后才开始调）：活动尾部的思考块从无到有 = 开始，不再是活动尾部 = 结束，
 * 时长 = 两次调用的时刻差。没有变化时原样返回同一个对象。
 */
export function observeThinking(clock: PiThinkingClock, items: readonly Item[], now: number): PiThinkingClock {
  const live = liveThinkingKeys(items)
  if (!clock.started) return { open: new Map(), done: new Map(), skip: live, started: true }
  let open: Map<string, number> | null = null
  let done: Map<string, number> | null = null
  const edit = () => {
    open ??= new Map(clock.open)
    done ??= new Map(clock.done)
  }
  for (const key of live) {
    if (clock.open.has(key) || clock.done.has(key) || clock.skip.has(key)) continue
    edit()
    open!.set(key, now)
  }
  for (const [key, start] of clock.open) {
    if (live.has(key)) continue
    edit()
    open!.delete(key)
    // 时刻是秒级时钟（useNow(1000)）：不到一秒的思考起止落在同一拍时差为 0。起止都看到了就是观测到了，
    // 至少记 1ms（显示"思考 1 秒"），不然会被 piItemsOf 的 ms > 0 当成"没有时长"写成"已思考"（design §1.9）
    done!.set(key, Math.max(1, now - start))
  }
  return open && done ? { ...clock, open, done } : clock
}

/* ---------------- 流顶一行（D02 补拉、未载入会话的本机记录） ---------------- */

/** relay.history 的形状（useRelay 的 history state） */
export type HistoryLike = { room: string; status: "more" | "loading" | "error" | "done"; error?: string; truncated: boolean }

export type PiTopLine = { text: string; action?: "load-earlier"; actionText?: string; tone?: "muted" | "error"; spinner?: boolean }

/**
 * 历史补拉的流顶行（D02，状态来自 relay.history，补拉规则不变【测试 history-backfill】）：
 * more = 更早的还在电脑上；loading = 正在拉；error = 失败可重试；done 且截断过 = 到顶了。别的房间的状态不显示。
 */
export function historyTopLineOf(history: HistoryLike | null | undefined, roomId: string | null | undefined): PiTopLine | null {
  if (!history || !roomId || history.room !== roomId) return null
  switch (history.status) {
    case "more":
      return { text: "更早的消息还没加载", action: "load-earlier", actionText: "加载" }
    case "loading":
      return { text: "正在加载更早的消息…", spinner: true }
    case "error":
      return { text: "更早的消息加载失败", action: "load-earlier", actionText: "重试" }
    case "done":
      return history.truncated ? { text: "已到会话开头" } : null
    default:
      return null
  }
}

export type PiArchiveLike = { truncated: boolean; omitted: number }

/** 未载入会话（session-archived）的流顶说明：有本机记录 / 没有本机记录（只显示首条消息） */
export function archiveTopLinesOf(archive: PiArchiveLike | null, deviceName: string | null | undefined): PiTopLine[] {
  const where = deviceName ? `在 ${deviceName} 上` : ""
  if (!archive) return [{ text: `这个会话还没载入，发第一条消息时${where}载入` }]
  const lines: PiTopLine[] = [{ text: `这是电脑上保存的记录，发第一条消息时${where}载入` }]
  if (archive.truncated && archive.omitted > 0) lines.push({ text: `更早的 ${archive.omitted} 条没有放进这一页` })
  return lines
}

/** 复制回复（PiReplyActions）：这条助手消息所在回合的全部正文（Markdown 原文，messageActionsModel 的口径，按出现顺序空行拼接） */
export function turnTextOf(items: readonly Item[], itemKey: string): string {
  const at = items.findIndex((it) => it.key === itemKey)
  if (at < 0) return ""
  const range = turnRanges(items).find(([from, to]) => at >= from && at < to)
  if (!range) return ""
  const parts: string[] = []
  for (let i = range[0]; i < range[1]; i++) {
    const it = items[i]
    if (it.kind !== "assistant") continue
    const text = assistantMarkdown(it.blocks)
    if (text.trim()) parts.push(text.trim())
  }
  return parts.join("\n\n")
}
