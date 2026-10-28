/**
 * Working 胶囊（子智能体）的派生层（纯函数）。
 *
 * 数据来自未来桥接层生产的 `agent_state` 全量快照（与 task_list_state 同构）：
 *  - `{agents: [...]}` 整帧替换；空数组是合法清空；坏帧保留上一帧；
 *  - 认不出的条目跳过，不补默认状态；
 *  - 只渲染 depth=1；更深层折叠进父条目的 currentActivity，不单独成条；
 *  - 后端可能还没有生产者：没有合法帧就返回 null / 空，不伪造子智能体。
 */

import { formatCapsuleElapsed } from "./capsuleFormat.ts"

export const WORKING_DONE_MS = 30_000

export type AgentStatus = "queued" | "running" | "succeeded" | "failed" | "aborted"

export type AgentEntry = {
  id: string
  seq: number | null
  name: string
  status: AgentStatus
  task: string
  description: string
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  currentActivity: string
  finalOutput: string
  error: string
  model: string
  mode: string
  step: number | null
}

export type WorkingCapsuleView =
  | {
      kind: "working"
      /** queued + running：派发即算在工。 */
      count: number
      succeeded: number
      failed: number
      aborted: number
    }
  | {
      kind: "done"
      count: number
      succeeded: number
      failed: number
      aborted: number
      glyph: "success" | "failure" | "cancel"
      expiresAt: number | null
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

const AGENT_STATUSES: readonly AgentStatus[] = ["queued", "running", "succeeded", "failed", "aborted"]

export function isAgentStatus(value: unknown): value is AgentStatus {
  return typeof value === "string" && (AGENT_STATUSES as readonly string[]).includes(value)
}

/**
 * 解析 agent_state。`agents` 为主键；兼容历史上可能叫 items 的快照。
 *  - 两个字段都不是数组：null（坏帧，保留上一份）；
 *  - 空数组：[]（清空）；
 *  - 单条缺 id / status 非法：跳过；
 *  - depth > 1：不渲染、不计数（不是坏帧）；
 *  - 非空数组一条都认不出：null（坏帧）。
 */
export function parseAgentStateEvent(event: unknown): AgentEntry[] | null {
  if (!isRecord(event)) return null
  const raw = Array.isArray(event.agents) ? event.agents : Array.isArray(event.items) ? event.items : null
  if (!raw) return null
  const entries: AgentEntry[] = []
  const seen = new Set<string>()
  let recognized = 0
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id = textField(item.id)
    if (!id || seen.has(id) || !isAgentStatus(item.status)) continue
    seen.add(id)
    recognized += 1
    const depth = finiteNumber(item.depth)
    if (depth !== null && depth > 1) continue
    const seq = finiteNumber(item.seq)
    const name = textField(item.name) || (seq !== null ? `Agent ${seq}` : "Agent")
    const startedAt = finiteNumber(item.startedAt)
    const endedAt = finiteNumber(item.endedAt)
    const durationFromStamps = startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null
    const durationMs = durationFromStamps ?? finiteNumber(item.durationMs)
    entries.push({
      id,
      seq,
      name,
      status: item.status,
      task: textField(item.task),
      description: textField(item.description),
      startedAt,
      endedAt,
      durationMs,
      currentActivity: textField(item.currentActivity),
      finalOutput: typeof item.finalOutput === "string" ? item.finalOutput : "",
      error: textField(item.error),
      model: textField(item.model),
      mode: textField(item.mode),
      step: finiteNumber(item.step),
    })
  }
  return raw.length && !recognized ? null : entries
}

/** 合法帧替换，非法帧原样保留；空数组清空。 */
export function agentStateAfterEvent(current: AgentEntry[], event: unknown): AgentEntry[] {
  return parseAgentStateEvent(event) ?? current
}

/** 展示状态：官方数据 queued 与 running 不可区分，一期统一按 running 呈现。 */
export function agentDisplayStatus(status: AgentStatus): Exclude<AgentStatus, "queued"> {
  return status === "queued" ? "running" : status
}

export function agentIsActive(entry: AgentEntry): boolean {
  return entry.status === "queued" || entry.status === "running"
}

function lastEndedAt(items: readonly AgentEntry[]): number | null {
  let last: number | null = null
  for (const item of items) {
    if (item.endedAt === null) continue
    if (last === null || item.endedAt > last) last = item.endedAt
  }
  return last
}

/**
 * 保留窗：有未结束条目时全部保留；全结束后停留 30s（或等到下一回合，由调用方决定是否清空）。
 * 已结束但缺 endedAt 的条目无法计时，保持可见（不编造结束时刻）。
 */
export function visibleAgentItems(items: readonly AgentEntry[], now: number): AgentEntry[] {
  const list = items as AgentEntry[]
  if (!list.length) return list
  if (list.some(agentIsActive)) return list
  const last = lastEndedAt(list)
  if (last === null) return list
  return now - last > WORKING_DONE_MS ? [] : list
}

/** 胶囊摘要：n = queued + running；完成态 m = 本轮条目总数。无数据返回 null。 */
export function workingCapsuleView(items: readonly AgentEntry[], now: number): WorkingCapsuleView | null {
  const visible = visibleAgentItems(items, now)
  if (!visible.length) return null
  const active = visible.filter(agentIsActive)
  const succeeded = visible.filter((item) => item.status === "succeeded").length
  const failed = visible.filter((item) => item.status === "failed").length
  const aborted = visible.filter((item) => item.status === "aborted").length
  if (active.length) {
    return { kind: "working", count: active.length, succeeded, failed, aborted }
  }
  const last = lastEndedAt(visible)
  return {
    kind: "done",
    count: visible.length,
    succeeded,
    failed,
    aborted,
    glyph: failed ? "failure" : aborted ? "cancel" : "success",
    expiresAt: last !== null ? last + WORKING_DONE_MS : null,
  }
}

/** 运行中耗时走字（startedAt 锚点）；结束用 endedAt - startedAt 的冻结值。 */
export function agentElapsed(entry: AgentEntry, now: number): number | null {
  if (entry.status === "queued" || entry.status === "running") {
    return entry.startedAt !== null ? Math.max(0, now - entry.startedAt) : null
  }
  if (entry.durationMs !== null) return entry.durationMs
  if (entry.startedAt !== null && entry.endedAt !== null) return Math.max(0, entry.endedAt - entry.startedAt)
  return null
}

/** 活动行：运行中 currentActivity；结束时给结果摘要（失败优先 error 首行）。 */
export function agentActivityLine(entry: AgentEntry): string {
  if (entry.status === "queued") return "排队中"
  if (entry.status === "running") return entry.currentActivity || "运行中"
  if (entry.status === "aborted") return "已取消"
  if (entry.status === "failed") return firstLine(entry.error) || firstLine(entry.finalOutput) || "失败"
  return firstLine(entry.finalOutput) || "已完成"
}

/** 详情里的结果全文：最终输出或失败原因；没有就返回空（不编造）。 */
export function agentResultText(entry: AgentEntry): string {
  if (entry.status === "failed") return entry.error || entry.finalOutput
  return entry.finalOutput || entry.error
}

export function firstLine(text: string): string {
  const line = (text || "").replace(/\r\n?/g, "\n").split("\n")[0].trim()
  return line.length > 160 ? `${line.slice(0, 159)}…` : line
}

export function agentDurationLabel(entry: AgentEntry, now: number): string | null {
  const ms = agentElapsed(entry, now)
  return ms === null ? null : formatCapsuleElapsed(ms)
}

export function agentSecondaryLine(entry: AgentEntry): string {
  const bits: string[] = []
  if (entry.model) bits.push(entry.model)
  if (entry.mode) bits.push(entry.step !== null ? `${entry.mode} · 第 ${entry.step} 步` : entry.mode)
  return bits.join(" · ")
}
