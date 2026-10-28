import type { Item } from "@/relay/transcript"
import { rowsFromPatch, diffRowsFromEdit, type PiDiffLine } from "@/pi/model/diffRows"

/* 对话流渲染的数据整理（变体自己的逻辑，不 import @/components/pi/conversation 的 tools/parts） */

export type CodexTurn = { user: Extract<Item, { kind: "user" }> | null; rest: Item[] }

/** 按用户消息切回合 */
export function splitTurns(items: readonly Item[]): CodexTurn[] {
  const turns: CodexTurn[] = []
  for (const item of items) {
    if (item.kind === "user") turns.push({ user: item, rest: [] })
    else {
      if (turns.length === 0) turns.push({ user: null, rest: [] })
      turns[turns.length - 1].rest.push(item)
    }
  }
  return turns
}

/** 回合结束时间（用于 "Worked for Xs"；缺数据就不写） */
export function turnWorkedMs(turn: CodexTurn): number | null {
  if (!turn.user?.timestamp) return null
  let end: number | undefined
  for (const item of turn.rest) {
    if (item.kind !== "assistant") continue
    const e = item.endedAt ?? (item.startedAt != null && item.durationMs != null ? item.startedAt + item.durationMs : item.timestamp)
    if (e != null && (end == null || e > end)) end = e
  }
  if (end == null) return null
  const ms = end - turn.user.timestamp
  return ms > 0 ? ms : null
}

const TERMINAL = new Set(["bash", "powershell", "shell"])

/** 工具块 → 展示口径（Codex 语言："Ran <cmd> · exit 0" / "Edited <file> +N −M" / 通用行） */
export function toolView(block: Extract<Item, { kind: "assistant" }>["blocks"][number] & { kind: "tool" }) {
  const name = block.name.trim().toLowerCase()
  const terminal = TERMINAL.has(name)
  const edit = name === "edit" || name === "write" || name === "multiedit" || name === "patch"
  const input = (block.input ?? {}) as Record<string, unknown>
  const pathText = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : typeof input.filePath === "string" ? input.filePath : null
  const commandText =
    typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : block.argsText?.trim() || null
  const state = block.state
  const running = state === "input-available" || state === "input-streaming" || state === "output-available" ? state === "input-available" || state === "input-streaming" : false
  const ok = state === "output-available"
  const failed = state === "output-error"
  let rows: PiDiffLine[] | null = null
  if (edit) {
    const fromPatch = block.patch ? rowsFromPatch(block.patch) : null
    const fromArgs = fromPatch ? null : diffRowsFromEdit(input, { patch: block.patch, patchTruncated: block.patchTruncated })
    rows = fromPatch?.rows ?? fromArgs?.rows ?? null
  }
  return { name, terminal, edit, pathText, commandText, running, ok, failed, exitCode: block.exitCode, rows, patchTruncated: block.patchTruncated === true, stderr: block.stderr, output: block.outputText, errorText: block.errorText, outcome: block.outcome, tasks: block.tasks }
}

/** 渲染 diff 行时前面插 "N 行未改动" 折叠（同 kit 的折叠规则：连续 context 超过 6 行时折叠中间） */
export type CodexDiffRow = { kind: "add" | "del" | "context"; n: number | null; text: string } | { kind: "fold"; count: number }

export function foldDiffRows(rows: readonly PiDiffLine[]): CodexDiffRow[] {
  const out: CodexDiffRow[] = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.kind !== "context") {
      out.push(row)
      continue
    }
    let j = i
    while (j + 1 < rows.length && rows[j + 1].kind === "context") j += 1
    const run = rows.slice(i, j + 1)
    if (run.length > 6) {
      out.push({ kind: "fold", count: run.length - 2 })
      out.push(run[0], run[run.length - 1])
    } else out.push(...run)
    i = j
  }
  return out
}

/** 工具行的状态点：运行中 / 成功绿 / 失败红 / 拒绝或超时灰 */
export function toolTone(view: ReturnType<typeof toolView>): "running" | "ok" | "fail" | "muted" {
  if (view.running) return "running"
  if (view.failed) return view.outcome === "denied" || view.outcome === "timeout" ? "muted" : "fail"
  return "ok"
}

/** 外壳 / thread 用的别名（同一实现） */
export const codexSplitTurns = splitTurns
export const codexTurnWorkedMs = turnWorkedMs
export const codexWorkedText = workedText

/** 助手回合总用时（没有 Worked for 数据就不写） */
export function workedText(ms: number | null): string | null {
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `Worked for ${s}s`
  const m = Math.floor(s / 60)
  return `Worked for ${m}m ${s % 60}s`
}
