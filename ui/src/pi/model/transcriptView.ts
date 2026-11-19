/**
 * 对话流容器（TranscriptContainer，PLAN 5.4 / §7.2）用的纯函数：relay 的转录 → PiTranscript 的 props。
 * 纯函数，node --test 直接加载（相对导入带 .ts）。口径：
 * - 诚实数据（design §1.9）：时间戳缺就不写用时；思考时长只有界面层实时观测到起止时才有（observedMs），快照恢复的历史写"已思考"。
 * - 工具块上由 transcript 提升的 patch（G5）交给 diff 卡（PiToolBlock.details.patch）；write 没有 patch，diff 卡用 input.content。
 * - 默认展开（推断，和 replica 各屏一致）：回合在跑、没在等你批准 / 回答、右 pane 没开时，展开本回合的思考块和正在跑的终端卡
 *   （pane 开着时终端输出在终端视图里展开，§1.8 同一条命令只在一处展开）；失败的终端卡只在报错还要看时展开（stderr 红字看得到）：
 *   回合以出错结束，或它是回合里最后一条命令；中途失败、智能体自己绕过去的收起（见 liveExpandedOf）。
 */
import { isLiveThinking, toolDisplayState, type Block, type Item } from "../../relay/transcript.ts"
import { turnErrorOf } from "./turnError.ts"
import { agentIsActive, type AgentEntry } from "../../chat/capsules/workingModel.ts"
import { abortedToolResult } from "../../chat/capsules/terminalModel.ts"
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
    out.push({ kind: "user", key: `outbox-${entry.cid}`, text: entry.text, images: [], timestamp: entry.at, from: "remote", cid: entry.cid, outbox: true, ...(entry.status === "awaiting" ? { awaiting: true } : {}) })
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

/**
 * pi 在跑的回合在 items 里的 [起, 止)：最后一个回合；流尾只有一条还没交到 pi 的用户消息（排队等注入 = awaiting、发送失败）的回合跳过 ——
 * 排队的消息要等前一回合的工具跑完才插进去，在那之前 pi 还在前一回合里（同 PiTranscript 的 runningTurnOf）。
 */
function activeRangeOf(items: readonly Item[]): [number, number] | undefined {
  const ranges = turnRanges(items)
  let t = ranges.length - 1
  for (; t > 0; t--) {
    const [from, to] = ranges[t]
    const first = items[from]
    if (to - from > 1 || first.kind !== "user" || (first.status !== "awaiting" && !first.failed)) break
  }
  return ranges[t]
}

function stamp(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null
}

/** 正在跑的回合从什么时候开始：它的用户消息的时间戳；没有就用它后面第一条助手消息的开始时间；都没有返回 null（不编） */
export function turnStartOf(items: readonly Item[]): number | null {
  const last = activeRangeOf(items)
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
 * 运行行（PiTranscript 的 running）：回合在跑才有。waiting = 有审批卡在等你（"等你批准 / 等你回答"只在卡上表达，流末尾不放运行行，§5）。
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

/** 失败的终端卡（拒绝 / 超时 / 停止打断的只是一行灰字，不算） */
function isFailedCard(block: Block): block is ToolBlock {
  return isTerminalTool(block) && toolDisplayState(block) === "failed" && block.outcome !== "timeout" && !abortedToolResult(block.outputText)
}

/** 回合里最后一条终端命令（不管结果）；没有返回 null */
function lastCommandOf(turn: readonly Item[]): Block | null {
  for (let i = turn.length - 1; i >= 0; i--) {
    const it = turn[i]
    if (it.kind !== "assistant") continue
    for (let k = it.blocks.length - 1; k >= 0; k--) if (isTerminalTool(it.blocks[k])) return it.blocks[k]
  }
  return null
}

/** 回合以出错结束：最后一条助手消息的结尾是红字出错行（停止、截断不算） */
function endedWithError(turn: readonly Item[]): boolean {
  for (let i = turn.length - 1; i >= 0; i--) {
    const it = turn[i]
    if (it.kind === "assistant") return turnErrorOf(it.stopReason, it.errorMessage)?.error === true
  }
  return false
}

/**
 * 默认展开的块（工具块 id、思考块键），规则见文件头。失败的终端卡：
 * - 回合在跑：还是本回合最后一条命令时展开（报错看得到），智能体接着跑别的命令（绕过去了）就收起，只留"失败 · 退出 N"卡头；
 * - 回合结束（最近一个有回复的回合）：以出错结束时，所有失败卡展开；否则只展开失败的最后一条命令，中途失败、后面又跑了别的命令的收起。
 */
export function liveExpandedOf(items: readonly Item[], input: PiExpandInput): string[] {
  const out: string[] = []
  if (input.running) {
    const last = activeRangeOf(items)
    if (input.waiting || input.paneOpen || !last) return out
    const lastCommand = lastCommandOf(items.slice(last[0], last[1]))
    for (let i = last[0]; i < last[1]; i++) {
      const it = items[i]
      if (it.kind !== "assistant") continue
      it.blocks.forEach((block, index) => {
        if (block.kind === "thinking" && block.text.trim()) out.push(thinkingKey(it.key, index))
        else if (isTerminalTool(block) && toolDisplayState(block) === "running") out.push(block.id)
        else if (block === lastCommand && isFailedCard(block)) out.push(block.id)
      })
    }
    return out
  }
  const turns = turnRanges(items)
  for (let t = turns.length - 1; t >= 0; t--) {
    const [from, to] = turns[t]
    const turn = items.slice(from, to)
    if (!turn.some((it) => it.kind === "assistant")) continue
    const allFailed = endedWithError(turn)
    const lastCommand = lastCommandOf(turn)
    for (const it of turn) {
      if (it.kind !== "assistant") continue
      for (const block of it.blocks) {
        if (isFailedCard(block) && (allFailed || block === lastCommand)) out.push(block.id)
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

export type PiTopLine = { text: string; action?: "load-earlier" | "enable-identity"; actionText?: string; tone?: "muted" | "error"; spinner?: boolean }

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

/**
 * The crypto-required top line (the relay refused this viewer the room's
 * content: no usable viewer identity / content key on this end). The
 * line always carries the one actionable next step -- enabling the
 * viewer identity. A-4 first added the action for rooms with a dialog
 * waiting; D-1 generalized it: without identity the room stays an empty
 * shell forever, so the way out must be reachable from the room itself
 * even when nothing is pending.
 */
export function cryptoRequiredTopLineOf(): PiTopLine {
  return { text: "这个房间已加密，当前观看端无法读取加密内容", tone: "error", action: "enable-identity", actionText: "启用观看端身份" }
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

export type PiForkTurnTarget = {
  /** Committed turn index from the end (0 = latest committed turn). */
  fromEnd: number
  /** True if this turn is the latest committed turn in items. */
  isLatest: boolean
  /** Trimmed user prompt text for sanity-matching tree turns if counts diverge. */
  userText: string
}

export type PiTreeEntryLike = {
  id?: unknown
  parentId?: unknown
  type?: unknown
  role?: unknown
  preview?: unknown
}

export type PiTreeNodeLike = {
  entry?: PiTreeEntryLike | null
  onPath?: unknown
  children?: unknown
}

export type PiTreeLike = {
  tree?: unknown
  leafId?: unknown
  path?: unknown
}

/** Identify which committed turn owns `itemKey`, indexed from the tail so truncated histories still align with `get_tree`. */
export function forkTurnOf(items: readonly Item[], itemKey: string): PiForkTurnTarget | null {
  const committed = items.filter(
    (it) => !(it.kind === "user" && (it.queued || it.status === "sending" || it.status === "awaiting" || it.failed)),
  )
  const at = committed.findIndex((it) => it.key === itemKey)
  if (at < 0) return null
  const ranges = turnRanges(committed)
  const turnIndex = ranges.findIndex(([from, to]) => at >= from && at < to)
  if (turnIndex < 0) return null
  const first = committed[ranges[turnIndex][0]]
  const userText = first?.kind === "user" ? first.text.trim() : ""
  return {
    fromEnd: ranges.length - 1 - turnIndex,
    isLatest: turnIndex === ranges.length - 1,
    userText,
  }
}

function activeTreeEntries(treeData: PiTreeLike | null | undefined): PiTreeEntryLike[] {
  if (!treeData || !Array.isArray(treeData.tree)) return []
  const byId = new Map<string, PiTreeEntryLike>()
  const onPathList: PiTreeEntryLike[] = []
  const stack: PiTreeNodeLike[] = []
  for (let i = treeData.tree.length - 1; i >= 0; i--) {
    const n = treeData.tree[i]
    if (n && typeof n === "object") stack.push(n as PiTreeNodeLike)
  }
  while (stack.length) {
    const node = stack.pop()!
    const entry = node.entry
    if (entry && typeof entry === "object" && typeof entry.id === "string" && entry.id) {
      byId.set(entry.id, entry)
      if (node.onPath) onPathList.push(entry)
    }
    if (Array.isArray(node.children)) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const c = node.children[i]
        if (c && typeof c === "object") stack.push(c as PiTreeNodeLike)
      }
    }
  }
  if (Array.isArray(treeData.path) && treeData.path.length > 0) {
    const out: PiTreeEntryLike[] = []
    for (const id of treeData.path) {
      if (typeof id === "string") {
        const e = byId.get(id)
        if (e) out.push(e)
      }
    }
    if (out.length > 0) return out
  }
  if (onPathList.length > 0) return onPathList
  const leafId = typeof treeData.leafId === "string" ? treeData.leafId : ""
  const reversed: PiTreeEntryLike[] = []
  let cur = leafId ? byId.get(leafId) : undefined
  const seen = new Set<string>()
  while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
    seen.add(cur.id)
    reversed.push(cur)
    cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined
  }
  reversed.reverse()
  return reversed
}

function isRenderableTurnEntry(entry: PiTreeEntryLike): boolean {
  if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message") return true
  if (entry.type === "message") {
    return entry.role === "assistant" || entry.role === "bashExecution" || entry.role === "user"
  }
  return false
}

const FORK_MESSAGE_ROLES = new Set(["assistant", "toolResult", "bashExecution", "user"])

/** Resolve the session entry ID to branch from for a turn targeted by `forkTurnOf`. */
export function forkEntryIdForTurn(treeData: PiTreeLike | null | undefined, target: PiForkTurnTarget): string | null {
  const entries = activeTreeEntries(treeData)
  if (entries.length === 0) return null
  const turns: PiTreeEntryLike[][] = []
  let cur: PiTreeEntryLike[] = []
  let seenUser = false
  for (const e of entries) {
    const isUser = e.type === "message" && e.role === "user"
    if (isUser) {
      if (seenUser || cur.some(isRenderableTurnEntry)) turns.push(cur)
      cur = [e]
      seenUser = true
    } else {
      cur.push(e)
    }
  }
  if (seenUser || cur.some(isRenderableTurnEntry)) turns.push(cur)
  if (turns.length === 0) return null

  const byOffset = turns.length - 1 - target.fromEnd
  let chosen = byOffset >= 0 && byOffset < turns.length ? turns[byOffset] : null
  const u = target.userText.trim()
  const previewOf = (t: PiTreeEntryLike[]) => (typeof t[0]?.preview === "string" ? t[0].preview.trim() : "")
  const matches = (t: PiTreeEntryLike[] | null) => {
    if (!t) return false
    const p = previewOf(t)
    if (!p) return u.length === 0
    return u.length > 0 && (u.startsWith(p) || p.startsWith(u))
  }
  if (!matches(chosen)) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (matches(turns[i])) {
        chosen = turns[i]
        break
      }
    }
  }
  if (!chosen) return null
  for (let i = chosen.length - 1; i >= 0; i--) {
    const e = chosen[i]
    if (e.type === "message" && typeof e.role === "string" && FORK_MESSAGE_ROLES.has(e.role) && typeof e.id === "string" && e.id) {
      return e.id
    }
  }
  for (let i = chosen.length - 1; i >= 0; i--) {
    if (typeof chosen[i].id === "string" && chosen[i].id) return chosen[i].id as string
  }
  return null
}
