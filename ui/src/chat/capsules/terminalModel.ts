/**
 * 终端胶囊的派生层（纯函数，不依赖 React / DOM）。
 *
 * 数据纪律（对齐《终端胶囊功能规格》§三/§四）：
 *  - 只认 bash / powershell 两种工具，一次 toolCall 等于一张独立终端窗口；
 *  - id 就是 toolCallId，按 id 去重；状态单调，已结束条目不接受迟到的 running 类更新；
 *  - settled 后的兜底推定记 inferredEnd，迟到的权威 end 可以覆盖它（唯一例外）；
 *  - 超时/取消只读 end 帧的 termStatus 枚举，退出码/耗时只读 exitCode / wall_time_seconds，
 *    绝不从输出文本里解析；
 *  - ANSI 与 `\r` 只在展示派生层处理，不改转发载荷；显示只留最后 200 行；
 *    stderr 只认数据层明确分流的字段，合并文本不猜、不染。
 */

export const TERMINAL_TAIL_LINES = 200
/** 输出尾巴默认只露最后 10 行（顶部渐隐）；展开后才铺到 200 行。 */
export const TERMINAL_PREVIEW_LINES = 10
/** 条目总数上限；running 永不滚出。 */
export const TERMINAL_MAX_ITEMS = 20
/** 工具中间输出的合并刷新间隔：250ms 一帧。 */
export const TERMINAL_UPDATE_FLUSH_MS = 250
/** 每张已结束窗口自己的停留：完成/取消 30s，失败/超时 60s。 */
export const TERMINAL_DONE_MS = 30_000
export const TERMINAL_FAILED_DONE_MS = 60_000
/** relay `tool_end_meta` 帧类型（订阅/补发全量 entries，live end 后单条）。 */
export const TOOL_END_META_TYPE = "tool_end_meta"
/** 暂存元数据的条数上限：与 relay 的 2000 条保留上限对齐，避免浏览器先丢历史。 */
export const TOOL_END_META_MAX = 2_000

export type TerminalEntryState = "running" | "succeeded" | "failed" | "timed_out" | "aborted"
export type TerminalDisplayState = TerminalEntryState | "unknown"

export type TerminalItem = {
  id: string
  toolName: string
  command: string
  /** start 事件的 startedAt（relay 补丁 1）或这一帧的接收时刻；end-only 时为 null。 */
  startedAt: number | null
  endedAt: number | null
  /** end 的 wall_time_seconds（秒 → 毫秒）或 endedAt - startedAt；未知保持 null。 */
  durationMs: number | null
  state: TerminalEntryState
  exitCode?: number
  /** 归一化后的输出尾巴（ANSI 已剥离、`\r` 已按覆盖本行处理、最多 200 行）。 */
  output: string
  /** 输出被截断：上游截断或超过 200 行。 */
  outputTruncated: boolean
  /** 数据层明确分流的 stderr（同样剥离 ANSI、最多 200 行）；合并文本不猜、不染。 */
  stderr?: string
  /** settled 兜底的推定结束；迟到 end 到达时以 end 为准覆盖。 */
  inferredEnd: boolean
  /** 由 tool_end_meta 先结束：随后到达的 live end 仍可补命令/结果/输出。 */
  metaEnded?: boolean
}

export type TerminalEvent = {
  type?: unknown
  toolCallId?: unknown
  toolName?: unknown
  args?: unknown
  partialResult?: unknown
  result?: unknown
  isError?: unknown
  startedAt?: unknown
  endedAt?: unknown
  /** 帧发出时刻（relay 时钟）：首帧用它做一次时钟偏移校正。 */
  at?: unknown
  exitCode?: unknown
  exit_code?: unknown
  termStatus?: unknown
  wall_time_seconds?: unknown
  wallTimeSeconds?: unknown
  /** 元数据合成事件带的毫秒墙钟（已经是毫秒，不再乘 1000）。 */
  durationMs?: unknown
  /** 由 `tool_end_meta` 合成的权威结束帧：允许补齐/覆盖已结束条目的元数据。 */
  meta?: unknown
  truncated?: unknown
}

/**
 * relay `tool_end_meta` 的单条元数据：
 * `{toolCallId, exitCode?, wallTimeSeconds?, termStatus?, endedAt?, isError?}`。
 * 这里绝不带命令/输出/工具名，历史条目只能由 transcript 工具块与它合并，不能凭空造。
 */
export type ToolEndMeta = {
  toolCallId: string
  exitCode?: number
  /** relay 主字段（秒），兼容 `wall_time_seconds`。 */
  wallTimeSeconds?: number
  termStatus?: "timeout" | "aborted" | null
  endedAt?: number
  isError?: boolean
  /** 契约未要求；帧里真有时才用，不猜。 */
  startedAt?: number
}

export type TerminalCapsuleView =
  | {
      kind: "running"
      /** 坞里所有可见窗口（running + 保留窗内的已结束窗口）。 */
      count: number
      /** 保留窗内已失败的条目数：运行态只用来追加一个 ✕ 静默提示。 */
      failed: number
      aborted: number
      /** 房间离线：不假装还在跑，耗时停走、文字降 tertiary。 */
      unknown: boolean
    }
  | {
      kind: "done"
      count: number
      failed: number
      aborted: number
      glyph: "success" | "failure" | "cancel"
      expiresAt: number
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  const parts: string[] = []
  for (const block of value) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text)
  }
  return parts.join("\n")
}

/** partialResult / result 的正文：字符串、content 数组或 { content } 对象。 */
function resultTextOf(result: unknown): string {
  if (typeof result === "string") return result
  if (Array.isArray(result)) return textOf(result)
  if (isRecord(result) && "content" in result) return textOf(result.content)
  return ""
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function textField(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** 首帧校正锚点：帧发出时刻 `at` 优先，其次事件自带的 startedAt。 */
export function terminalClockStamp(event: TerminalEvent): number | null {
  return finiteNumber(event.at) ?? finiteNumber(event.startedAt)
}

/**
 * 首帧时钟偏移：本地 now - relay 事件时刻。
 * 只应在每个房间的第一帧调用一次；返回值加到事件时间戳上即换成本地时钟。
 */
export function terminalClockOffset(event: TerminalEvent, now: number): number | null {
  const stamp = terminalClockStamp(event)
  return stamp === null ? null : now - stamp
}

/** 把 relay 时刻（startedAt / endedAt / at）平移成本地时钟；无变化时保持原引用。 */
export function shiftTerminalEvent(event: TerminalEvent, offset: number): TerminalEvent {
  if (!offset) return event
  const next = { ...event }
  let changed = false
  for (const key of ["startedAt", "endedAt", "at"] as const) {
    const value = finiteNumber(event[key])
    if (value !== null) {
      next[key] = value + offset
      changed = true
    }
  }
  return changed ? next : event
}

/** 同一条元数据里的 relay 时刻平移（endedAt / startedAt）。 */
export function shiftToolEndMeta(meta: ToolEndMeta, offset: number): ToolEndMeta {
  if (!offset) return meta
  const next = { ...meta }
  if (typeof meta.endedAt === "number") next.endedAt = meta.endedAt + offset
  if (typeof meta.startedAt === "number") next.startedAt = meta.startedAt + offset
  return next
}

/** 胶囊只数父会话直接发起的 bash 类执行；Windows 的 powershell 等价。 */
export function isTerminalToolName(value: unknown): boolean {
  const name = textField(value).toLowerCase()
  return name === "bash" || name === "powershell"
}

const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const ANSI_DCS = /\u001b[P^_][\s\S]*?\u001b\\/g
const ANSI_CSI =
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

/** 剥离 ANSI 转义（CSI / OSC / DCS）；只作用于胶囊展示文本。 */
export function stripAnsi(text: string): string {
  if (!text) return ""
  return text.replace(ANSI_OSC, "").replace(ANSI_DCS, "").replace(ANSI_CSI, "")
}

/** `\r` 覆盖本行：同一物理行里只保留最后一截非空文本（进度条式输出）。 */
export function applyCarriageReturns(text: string): string {
  if (!text || !text.includes("\r")) return text
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line
      const parts = line.split("\r")
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (parts[index] !== "") return parts[index]
      }
      return ""
    })
    .join("\n")
}

export function normalizeTerminalOutput(text: string): string {
  return applyCarriageReturns(stripAnsi(typeof text === "string" ? text : ""))
}

export type TerminalTail = { text: string; lines: string[]; truncated: boolean }

/** 显示侧尾巴：最多 200 行；返回保留的行与是否截断。 */
export function tailTerminalOutput(text: string, limit = TERMINAL_TAIL_LINES): TerminalTail {
  const normalized = normalizeTerminalOutput(text)
  const all = normalized.split("\n")
  while (all.length && all[all.length - 1] === "") all.pop()
  const truncated = all.length > limit
  const lines = truncated ? all.slice(-limit) : all
  return { text: lines.join("\n"), lines, truncated }
}

/** 工具参数里的命令：bash 是 command，兼容 cmd/script；只取非空字符串。 */
function commandFromInput(input: unknown): string {
  if (!isRecord(input)) return ""
  for (const key of ["command", "cmd", "script"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value
  }
  return ""
}

function argsCommandOf(event: TerminalEvent): string {
  return commandFromInput(event.args)
}

function termStatusOf(value: unknown): "timeout" | "aborted" | null {
  const status = textField(value).toLowerCase()
  if (status === "timeout" || status === "timed_out" || status === "timedout") return "timeout"
  if (status === "aborted" || status === "abort" || status === "cancelled" || status === "canceled") return "aborted"
  return null
}

function exitCodeOf(event: TerminalEvent): number | undefined {
  const code = finiteNumber(event.exitCode) ?? finiteNumber(event.exit_code)
  return code === null ? undefined : code
}

function wallTimeMsOf(event: TerminalEvent): number | null {
  const explicit = finiteNumber(event.durationMs)
  if (explicit !== null) return explicit < 0 ? null : Math.round(explicit)
  const seconds = finiteNumber(event.wall_time_seconds) ?? finiteNumber(event.wallTimeSeconds)
  if (seconds === null || seconds < 0) return null
  return Math.round(seconds * 1000)
}

/** end 状态映射（写死）：termStatus 优先，其次 isError / 非零退出码。 */
export function terminalStateForEnd(input: {
  isError?: boolean
  termStatus?: "timeout" | "aborted" | null
  exitCode?: number
}): TerminalEntryState {
  if (input.termStatus === "timeout") return "timed_out"
  if (input.termStatus === "aborted") return "aborted"
  if (!input.isError) {
    return typeof input.exitCode === "number" && input.exitCode !== 0 ? "failed" : "succeeded"
  }
  return "failed"
}

function truncatedFlagOf(result: unknown): boolean {
  if (!isRecord(result)) return false
  return result.truncated === true || result.truncatedHead === true || result.truncated_head === true
}

function outputState(text: string, upstreamTruncated: boolean): { output: string; outputTruncated: boolean } {
  const tail = tailTerminalOutput(text)
  return { output: tail.text, outputTruncated: upstreamTruncated || tail.truncated }
}

/**
 * 工具结果里明确分流的 stderr：与 transcript 工具卡同一口径，只读
 * `details` / `structuredContent`；合并输出里不猜、不染。缺就返回空串。
 */
function stderrTextOf(result: unknown): string {
  if (!isRecord(result)) return ""
  const candidates: Record<string, unknown>[] = []
  if (isRecord(result.details)) candidates.push(result.details)
  if (isRecord(result.structuredContent)) candidates.push(result.structuredContent)
  if (isRecord(result.details) && isRecord(result.details.structuredContent)) {
    candidates.push(result.details.structuredContent)
  }
  for (const value of candidates) {
    for (const key of ["stderr", "standardError"]) {
      const text = value[key]
      if (typeof text === "string" && text.length) return tailTerminalOutput(text).text
    }
  }
  return ""
}

/** 输出尾巴的可视窗口：默认只取最后 10 行，展开后原样返回（派生态已 ≤200 行）。 */
export function terminalOutputWindow(
  lines: readonly string[],
  expanded: boolean,
  limit = TERMINAL_PREVIEW_LINES,
): string[] {
  if (expanded || lines.length <= limit) return lines.slice()
  return lines.slice(-limit)
}

/** 运行中按校正后的 startedAt 走字；已结束一律用 durationMs 冻结。 */
export function terminalElapsedMs(item: TerminalItem, now: number): number | null {
  if (item.state === "running") {
    if (item.startedAt === null) return null
    return Math.max(0, now - item.startedAt)
  }
  return item.durationMs
}

/** `tool_end_meta` 帧判定：只认契约里的类型，不按文案猜。 */
export function isToolEndMetaEvent(value: unknown): boolean {
  return isRecord(value) && textField(value.type) === TOOL_END_META_TYPE
}

/**
 * 解析 `{type:"tool_end_meta", entries:[...]}`。
 *  - 只认 `entries` 数组；坏条目/重复 id 跳过；
 *  - 主字段 exitCode / wallTimeSeconds / termStatus / endedAt / isError，
 *    兼容旧字段 exit_code / wall_time_seconds；
 *  - 一条结束证据都没有的条目跳过，不把“只有 id”当成成功。
 * 返回 null = 不是这个帧；[] = 是合法帧但没有可用条目。
 */
export function parseToolEndMetaFrame(event: unknown): ToolEndMeta[] | null {
  if (!isRecord(event) || textField(event.type) !== TOOL_END_META_TYPE) return null
  if (!Array.isArray(event.entries)) return []
  const result: ToolEndMeta[] = []
  const seen = new Set<string>()
  for (const raw of event.entries) {
    if (!isRecord(raw)) continue
    const toolCallId = textField(raw.toolCallId)
    if (!toolCallId || seen.has(toolCallId)) continue
    const exitCode = finiteNumber(raw.exitCode) ?? finiteNumber(raw.exit_code)
    const seconds = finiteNumber(raw.wallTimeSeconds) ?? finiteNumber(raw.wall_time_seconds)
    const endedAt = finiteNumber(raw.endedAt)
    const termStatus = termStatusOf(raw.termStatus)
    const isError = typeof raw.isError === "boolean" ? raw.isError : undefined
    const startedAt = finiteNumber(raw.startedAt)
    if (exitCode === null && seconds === null && endedAt === null && termStatus === null && isError === undefined) {
      continue
    }
    seen.add(toolCallId)
    const meta: ToolEndMeta = { toolCallId }
    if (exitCode !== null) meta.exitCode = exitCode
    if (seconds !== null && seconds >= 0) meta.wallTimeSeconds = seconds
    if (termStatus !== null) meta.termStatus = termStatus
    if (endedAt !== null) meta.endedAt = endedAt
    if (isError !== undefined) meta.isError = isError
    if (startedAt !== null) meta.startedAt = startedAt
    result.push(meta)
  }
  return result
}

/** 有足够的结束证据才允许改条目状态：缺 status 的元数据只暂存，不伪造成功。 */
export function toolEndMetaHasStatus(meta: ToolEndMeta): boolean {
  return meta.exitCode !== undefined || meta.termStatus != null || typeof meta.isError === "boolean"
}

/** 元数据 → 权威 end 帧；结果/命令故意不带，避免覆盖 live 输出。 */
export function toolEndMetaEvent(meta: ToolEndMeta): TerminalEvent {
  const event: TerminalEvent = {
    type: "tool_execution_end",
    toolCallId: meta.toolCallId,
    meta: true,
  }
  if (meta.exitCode !== undefined) event.exitCode = meta.exitCode
  if (meta.wallTimeSeconds !== undefined) {
    event.wall_time_seconds = meta.wallTimeSeconds
    event.durationMs = Math.round(meta.wallTimeSeconds * 1000)
  }
  if (meta.termStatus != null) event.termStatus = meta.termStatus
  if (meta.isError !== undefined) event.isError = meta.isError
  if (meta.endedAt !== undefined) event.endedAt = meta.endedAt
  if (meta.startedAt !== undefined) event.startedAt = meta.startedAt
  return event
}

/**
 * 把元数据合入现有条目。没有对应条目时不做任何事（没有 toolName/命令，
 * 不能凭空造终端条目）；start/end 后到时由调用方暂存并再次合并。
 */
export function applyToolEndMeta(
  items: TerminalItem[],
  metas: readonly ToolEndMeta[],
  now: number,
): TerminalItem[] {
  let next = items
  for (const meta of metas) {
    if (!toolEndMetaHasStatus(meta)) continue
    next = reduceTerminalEvent(next, toolEndMetaEvent(meta), now)
  }
  return next
}

export type TerminalHistoryToolBlock = {
  id: string
  toolName: string
  command: string
  outputText: string
  stderr?: string
}

/** 从 transcript 条目里提取 bash/powershell 工具块（只读，不改正文）。 */
export function terminalToolBlocks(items: readonly unknown[]): TerminalHistoryToolBlock[] {
  const result: TerminalHistoryToolBlock[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!isRecord(item) || item.kind !== "assistant" || !Array.isArray(item.blocks)) continue
    for (const raw of item.blocks) {
      if (!isRecord(raw) || raw.kind !== "tool") continue
      const id = textField(raw.id)
      const toolName = textField(raw.name)
      if (!id || seen.has(id) || !isTerminalToolName(toolName)) continue
      seen.add(id)
      result.push({
        id,
        toolName,
        command: commandFromInput(raw.input),
        outputText: typeof raw.outputText === "string" ? raw.outputText : "",
        stderr: typeof raw.stderr === "string" ? raw.stderr : undefined,
      })
    }
  }
  return result
}

/**
 * 历史重建：transcript 里已有工具块 + relay 元数据 → 终端条目。
 *  - 元数据未到 / 结束状态不足：不生成，不伪造；
 *  - 没有 endedAt 的条目不生成（无法进入保留窗，会永久滞留）；
 *  - 超过失败保留期（60s）的旧历史不生成；避免整会话的旧命令涌进胶囊。
 */
export function terminalHistoryItems(
  items: readonly unknown[],
  metas: ReadonlyMap<string, ToolEndMeta>,
  now: number,
  maxAgeMs = TERMINAL_FAILED_DONE_MS,
): TerminalItem[] {
  if (!metas.size) return []
  const result: TerminalItem[] = []
  for (const block of terminalToolBlocks(items)) {
    const meta = metas.get(block.id)
    if (!meta || !toolEndMetaHasStatus(meta)) continue
    if (meta.endedAt === undefined) continue
    const state = terminalStateForEnd({
      isError: meta.isError,
      termStatus: meta.termStatus ?? null,
      exitCode: meta.exitCode,
    })
    // 每条历史也按自己的完成态保留：成功 30s、失败/超时 60s，过期的不涌进坞。
    const retention = state === "failed" || state === "timed_out" ? TERMINAL_FAILED_DONE_MS : TERMINAL_DONE_MS
    if (now - meta.endedAt > Math.min(maxAgeMs, retention)) continue
    const wallMs = meta.wallTimeSeconds === undefined ? null : Math.round(meta.wallTimeSeconds * 1000)
    const startedAt =
      meta.startedAt ?? (wallMs !== null ? Math.max(0, meta.endedAt - wallMs) : null)
    const output = outputState(block.outputText, false)
    const stderr = block.stderr ? tailTerminalOutput(block.stderr).text : ""
    result.push({
      id: block.id,
      toolName: block.toolName,
      command: block.command,
      startedAt,
      endedAt: meta.endedAt,
      durationMs: wallMs,
      state,
      exitCode: meta.exitCode,
      output: output.output,
      outputTruncated: output.outputTruncated,
      stderr: stderr || undefined,
      inferredEnd: false,
    })
  }
  return result
}

/** 历史条目并回现有列表：按 id 幂等、按时间排序、仍走 20 条上限（running 不滚出）。 */
export function mergeTerminalHistoryItems(
  current: TerminalItem[],
  history: readonly TerminalItem[],
  now: number,
): TerminalItem[] {
  if (!history.length) return current
  const have = new Set(current.map((item) => item.id))
  const fresh = history.filter((item) => {
    if (have.has(item.id)) return false
    if (item.endedAt === null) return false
    return now - item.endedAt <= terminalRetentionMs(item)
  })
  if (!fresh.length) return current
  const merged = [...fresh, ...current].sort((a, b) => {
    const left = a.startedAt ?? a.endedAt ?? Number.POSITIVE_INFINITY
    const right = b.startedAt ?? b.endedAt ?? Number.POSITIVE_INFINITY
    return left === right ? 0 : left - right
  })
  return pruneItems(merged)
}

/**
 * 面板打开期间的数据级保留：新终端开始会触发派生层清理过期完成批次，
 * 但用户正看着旧条目，不能当面抽走。这里把打开时的已结束快照补回缺失的
 * id；running 不补（它必须跟实时状态走），当前数据永远优先。
 */
export function holdTerminalItems(current: readonly TerminalItem[], snapshot: readonly TerminalItem[]): readonly TerminalItem[] {
  if (!snapshot.length) return current
  const have = new Set(current.map((item) => item.id))
  const missing = snapshot.filter((item) => !have.has(item.id) && item.state !== "running")
  return missing.length ? [...current, ...missing] : current
}

function pruneItems(items: TerminalItem[]): TerminalItem[] {
  if (items.length <= TERMINAL_MAX_ITEMS) return items
  let remove = items.length - TERMINAL_MAX_ITEMS
  const drop = new Set<string>()
  // 最旧的已结束条目先滚出；running 永不滚出。
  for (const item of items) {
    if (remove <= 0) break
    if (item.state === "running") continue
    drop.add(item.id)
    remove -= 1
  }
  return remove > 0 ? items : items.filter((item) => !drop.has(item.id))
}

function replaceAt(items: TerminalItem[], index: number, next: TerminalItem): TerminalItem[] {
  const copy = items.slice()
  copy[index] = next
  return copy
}

/**
 * 已结束条目的幂等补全：
 *  - 普通迟到的 end：只补空字段，不改状态；
 *  - `tool_end_meta` 合成的权威帧：可覆盖 exitCode / durationMs / endedAt / 状态，
 *    重复应用同一份元数据必须返回原引用。
 */
function enrichEndedTerminalItem(
  items: TerminalItem[],
  index: number,
  existing: TerminalItem,
  event: TerminalEvent,
): TerminalItem[] {
  const authoritative = event.meta === true
  const exitCode = exitCodeOf(event)
  const endedAt = finiteNumber(event.endedAt)
  const wallMs = wallTimeMsOf(event)
  const patch: Partial<TerminalItem> = {}
  if (exitCode !== undefined && (existing.exitCode === undefined || (authoritative && existing.exitCode !== exitCode))) {
    patch.exitCode = exitCode
  }
  if (endedAt !== null && (existing.endedAt === null || (authoritative && existing.endedAt !== endedAt))) {
    patch.endedAt = endedAt
  }
  if (existing.durationMs === null) {
    const anchor = endedAt ?? existing.endedAt
    const computed = wallMs ?? (existing.startedAt !== null && anchor !== null ? Math.max(0, anchor - existing.startedAt) : null)
    if (computed !== null) patch.durationMs = computed
  } else if (authoritative && wallMs !== null && existing.durationMs !== wallMs) {
    patch.durationMs = wallMs
  }
  if (authoritative) {
    const state = terminalStateForEnd({
      isError: event.isError === true,
      termStatus: termStatusOf(event.termStatus),
      exitCode,
    })
    if (state !== existing.state) patch.state = state
  }
  // 元数据先结束、live end 后到：live 结果仍是权威输出（覆盖中间 partialResult）。
  const resultText = resultTextOf(event.result)
  if (resultText && (existing.metaEnded === true || !existing.output)) {
    const nextOutput = outputState(resultText, truncatedFlagOf(event.result))
    patch.output = nextOutput.output
    patch.outputTruncated = nextOutput.outputTruncated
  }
  if (existing.stderr === undefined) {
    const stderr = stderrTextOf(event.result)
    if (stderr) patch.stderr = stderr
  }
  if (!authoritative) {
    // 真正的 live end 到了：之后重复的 end 不应再动输出。
    if (existing.metaEnded === true) patch.metaEnded = false
    const command = argsCommandOf(event)
    if (command && !existing.command) patch.command = command
    if (existing.startedAt === null) {
      const startedAt = finiteNumber(event.startedAt)
      if (startedAt !== null) patch.startedAt = startedAt
    }
  }
  if (!Object.keys(patch).length) return items
  return replaceAt(items, index, { ...existing, ...patch })
}

/**
 * 单窗口保留期：成功/取消 30s，失败/超时 60s。
 * 保留按每张窗口自己的结束时刻计算，不是整批共享一个倒计时。
 */
export function terminalRetentionMs(item: Pick<TerminalItem, "state">): number {
  return item.state === "failed" || item.state === "timed_out" ? TERMINAL_FAILED_DONE_MS : TERMINAL_DONE_MS
}

/** 单窗口到期时刻；running / 没有结束锚点的窗口返回 null（不按猜测倒计时）。 */
export function terminalWindowExpiresAt(item: TerminalItem): number | null {
  if (item.state === "running" || item.endedAt === null) return null
  return item.endedAt + terminalRetentionMs(item)
}

function terminalWindowVisible(item: TerminalItem, now: number, holdExpired: boolean): boolean {
  if (item.state === "running") return true
  if (holdExpired) return true
  const expiresAt = terminalWindowExpiresAt(item)
  return expiresAt === null || now <= expiresAt
}

/**
 * 新终端开始时清掉已经过期的旧结束窗口：过期窗口不能因为“又来了一个
 * running”而复活；running 与仍在保留窗内的窗口原样保留。逐条判断，不整批清空。
 */
export function pruneExpiredTerminalItems(items: readonly TerminalItem[], now: number): TerminalItem[] {
  const list = items as TerminalItem[]
  if (!list.length) return list
  const kept = list.filter((item) => terminalWindowVisible(item, now, false))
  return kept.length === list.length ? list : kept
}

/**
 * 单帧归约。start / end / settle 由 useRelay 立即应用；update 走 250ms 合并后批量调用。
 * 非法帧、非终端工具、缺 id 的帧原样返回，保持现有列表。
 */
export function reduceTerminalEvent(items: TerminalItem[], event: TerminalEvent, now: number): TerminalItem[] {
  if (!event || typeof event !== "object") return items
  const type = textField(event.type)
  if (type !== "tool_execution_start" && type !== "tool_execution_update" && type !== "tool_execution_end") return items
  const id = textField(event.toolCallId)
  if (!id) return items
  const toolName = textField(event.toolName)
  const index = items.findIndex((item) => item.id === id)
  const existing = index >= 0 ? items[index] : null

  if (type === "tool_execution_start") {
    if (toolName && !isTerminalToolName(toolName)) return items
    if (existing) {
      // 去重 + 状态单调：已结束条目忽略迟到的 start；running 只补信息，不重置锚点。
      if (existing.state !== "running") return items
      const nextStartedAt =
        typeof finiteNumber(event.startedAt) === "number"
          ? Math.min(existing.startedAt ?? Number.POSITIVE_INFINITY, finiteNumber(event.startedAt) as number)
          : existing.startedAt
      const command = argsCommandOf(event) || existing.command
      if (nextStartedAt === existing.startedAt && command === existing.command && (!toolName || toolName === existing.toolName)) {
        return items
      }
      return replaceAt(items, index, {
        ...existing,
        toolName: toolName || existing.toolName,
        command,
        startedAt: nextStartedAt,
      })
    }
    if (!isTerminalToolName(toolName)) return items
    const startedAt = finiteNumber(event.startedAt) ?? now
    return pruneItems([
      ...pruneExpiredTerminalItems(items, now),
      {
        id,
        toolName,
        command: argsCommandOf(event),
        startedAt,
        endedAt: null,
        durationMs: null,
        state: "running",
        output: "",
        outputTruncated: false,
        inferredEnd: false,
      },
    ])
  }

  if (type === "tool_execution_update") {
    if (!existing) {
      if (!isTerminalToolName(toolName)) return items
      const hasPartial = Object.prototype.hasOwnProperty.call(event, "partialResult")
      const next = outputState(hasPartial ? resultTextOf(event.partialResult) : "", truncatedFlagOf(event.partialResult))
      return pruneItems([
        ...pruneExpiredTerminalItems(items, now),
        {
          id,
          toolName,
          command: argsCommandOf(event),
          startedAt: finiteNumber(event.startedAt) ?? now,
          endedAt: null,
          durationMs: null,
          state: "running",
          output: next.output,
          outputTruncated: next.outputTruncated,
          inferredEnd: false,
        },
      ])
    }
    // 已结束（含推定结束）条目不接受迟到的 update。
    if (existing.state !== "running") return items
    if (!Object.prototype.hasOwnProperty.call(event, "partialResult")) return items
    const next = outputState(resultTextOf(event.partialResult), truncatedFlagOf(event.partialResult))
    return replaceAt(items, index, {
      ...existing,
      toolName: isTerminalToolName(toolName) ? toolName : existing.toolName,
      output: next.output,
      outputTruncated: existing.outputTruncated || next.outputTruncated,
    })
  }

  // tool_execution_end
  if (existing && existing.state !== "running" && !existing.inferredEnd) {
    return enrichEndedTerminalItem(items, index, existing, event)
  }
  if (!existing && !isTerminalToolName(toolName)) return items
  if (!existing && !toolName) return items

  const isError = event.isError === true
  const exitCode = exitCodeOf(event)
  const state = terminalStateForEnd({ isError, termStatus: termStatusOf(event.termStatus), exitCode })
  const endedAt = finiteNumber(event.endedAt) ?? now
  const startedAt = existing
    ? existing.startedAt
    : typeof finiteNumber(event.startedAt) === "number"
      ? (finiteNumber(event.startedAt) as number)
      : null
  const wallMs = wallTimeMsOf(event)
  const durationMs =
    wallMs ?? (startedAt !== null ? Math.max(0, endedAt - startedAt) : null)
  const resultText = resultTextOf(event.result)
  const nextOutput = resultText
    ? outputState(resultText, truncatedFlagOf(event.result))
    : { output: existing?.output ?? "", outputTruncated: existing?.outputTruncated ?? false }
  const nextStderr = stderrTextOf(event.result)
  const next: TerminalItem = {
    id,
    toolName: toolName || existing?.toolName || "bash",
    command: argsCommandOf(event) || existing?.command || "",
    startedAt,
    endedAt,
    durationMs,
    state,
    exitCode,
    output: nextOutput.output,
    outputTruncated: nextOutput.outputTruncated,
    stderr: nextStderr || existing?.stderr,
    inferredEnd: false,
    metaEnded: event.meta === true ? true : undefined,
  }
  if (existing) return replaceAt(items, index, next)
  return pruneItems([...pruneExpiredTerminalItems(items, now), next])
}

/** 一次合并多帧：update 批量落地时保持顺序，后者覆盖前者的累积快照。 */
export function reduceTerminalEvents(items: TerminalItem[], events: readonly TerminalEvent[], now: number): TerminalItem[] {
  let next = items
  for (const event of events) next = reduceTerminalEvent(next, event, now)
  return next
}

/**
 * 回合 settled 兜底：仍 running 的条目推定结束（已取消）。
 * 迟到的权威 end 会在 reduceTerminalEvent 里覆盖它；不编造退出码。
 */
export function settleTerminalItems(items: TerminalItem[], now: number): TerminalItem[] {
  if (!items.some((item) => item.state === "running")) return items
  return items.map((item) => {
    if (item.state !== "running") return item
    return {
      ...item,
      state: "aborted",
      endedAt: now,
      durationMs: item.startedAt !== null ? Math.max(0, now - item.startedAt) : null,
      inferredEnd: true,
    }
  })
}

/** 断线时 running 呈现为 unknown（空心点、耗时停走），数据本身仍是 running。 */
export function terminalDisplayState(item: TerminalItem, offline: boolean): TerminalDisplayState {
  return offline && item.state === "running" ? "unknown" : item.state
}

function isFailure(item: TerminalItem): boolean {
  return item.state === "failed" || item.state === "timed_out"
}

/**
 * 可见窗口：每条已结束窗口按自己的完成态保留 30s / 失败 60s，running 永不消失。
 *
 * holdExpired：终端坞打开期间为 true —— 到期也不当面抽走窗口；坞关闭后的
 * 下一次状态变更再由调用方摘掉这个标记。状态转换本身（running→done）不延迟。
 */
export function visibleTerminalItems(items: readonly TerminalItem[], now: number, holdExpired = false): TerminalItem[] {
  const list = items as TerminalItem[]
  if (!list.length) return list
  const kept = list.filter((item) => terminalWindowVisible(item, now, holdExpired))
  return kept.length === list.length ? list : kept
}

/** 胶囊行摘要：running 数或完成态汇总；没有可显示内容返回 null（不显示 0 terminals）。 */
export function terminalCapsuleView(
  items: readonly TerminalItem[],
  now: number,
  offline = false,
  holdExpired = false,
): TerminalCapsuleView | null {
  const visible = visibleTerminalItems(items, now, holdExpired)
  if (!visible.length) return null
  const running = visible.filter((item) => item.state === "running")
  const ended = visible.filter((item) => item.state !== "running")
  const failed = ended.filter(isFailure).length
  const aborted = ended.filter((item) => item.state === "aborted").length
  if (running.length) {
    // 坞里 running 与保留窗内的已结束窗口都算“几 terminal”；胶囊只做汇总，不藏窗口。
    return { kind: "running", count: visible.length, failed, aborted, unknown: offline }
  }
  if (!ended.length) return null
  let expiresAt = 0
  for (const item of ended) {
    const at = terminalWindowExpiresAt(item)
    if (at !== null && at > expiresAt) expiresAt = at
  }
  return {
    kind: "done",
    count: ended.length,
    failed,
    aborted,
    glyph: failed ? "failure" : aborted ? "cancel" : "success",
    expiresAt,
  }
}

/** 面板条目顺序：按开始时间正序，结束不换位；缺 startedAt 的条目落在后面。 */
export function sortTerminalItems(items: readonly TerminalItem[]): TerminalItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = a.item.startedAt ?? Number.POSITIVE_INFINITY
      const right = b.item.startedAt ?? Number.POSITIVE_INFINITY
      return left === right ? a.index - b.index : left - right
    })
    .map(({ item }) => item)
}
