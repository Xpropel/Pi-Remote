import type { Block } from "@/relay/transcript"
import { rowsFromPatch, diffRowsFromEdit, type PiDiffLine } from "@/pi/model/diffRows"

const TERMINAL = new Set(["bash", "powershell", "shell"])
const EDIT = new Set(["edit", "write", "multiedit", "patch"])
const SEARCH = new Set(["grep", "glob", "search", "web_search", "search_query", "code_search", "find"])
const BROWSER = new Set(["browser", "fetch", "web_fetch", "navigate", "open_url", "open"])

export type CodexToolKind = "terminal" | "edit" | "search" | "browser" | "mcp" | "other"

export type CodexToolView = {
  name: string
  kind: CodexToolKind
  terminal: boolean
  edit: boolean
  pathText: string | null
  commandText: string | null
  /** 搜索词 / 访问地址（search / browser 行展示） */
  queryText: string | null
  running: boolean
  ok: boolean
  failed: boolean
  /** 非四态（queued / waiting_approval / denied / cancelled）的状态提示；null = 常规四态 */
  stateNote: string | null
  exitCode?: number
  rows: PiDiffLine[] | null
  patchTruncated: boolean
  stderr?: string
  output: string
  errorText?: string
  outcome?: string
  tasks?: NonNullable<Extract<Block, { kind: "tool" }>["tasks"]>
}

/** 工具块 → Codex 展示口径（Ran / Edited +N −M / 通用行）；diff 解析复用 @/pi/model/diffRows */
export function codexToolView(block: Extract<Block, { kind: "tool" }>): CodexToolView {
  const name = block.name.trim().toLowerCase()
  const terminal = TERMINAL.has(name)
  const edit = EDIT.has(name)
  const mcp = name.startsWith("mcp") || name.includes("__mcp") || name.includes("mcp__")
  const kind: CodexToolKind = terminal ? "terminal" : edit ? "edit" : mcp ? "mcp" : SEARCH.has(name) ? "search" : BROWSER.has(name) ? "browser" : "other"
  const input = (block.input ?? {}) as Record<string, unknown>
  const pathText = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : typeof input.filePath === "string" ? input.filePath : null
  const commandText = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : block.argsText?.trim() || null
  const queryText = typeof input.query === "string" ? input.query : typeof input.pattern === "string" ? input.pattern : typeof input.url === "string" ? input.url : typeof input.q === "string" ? input.q : null
  const running = block.state === "input-available" || block.state === "input-streaming"
  const ok = block.state === "output-available"
  const failed = block.state === "output-error"
  const stateNote = block.state === "queued" ? "排队中" : block.state === "waiting_approval" ? "等待批准" : block.state === "denied" ? "已拒绝" : block.state === "cancelled" ? "已取消" : null
  let rows: PiDiffLine[] | null = null
  if (edit) {
    const fromPatch = block.patch ? rowsFromPatch(block.patch) : null
    rows = fromPatch?.rows ?? diffRowsFromEdit(input, { patch: block.patch, patchTruncated: block.patchTruncated })?.rows ?? null
  }
  return { name, kind, terminal, edit, pathText, commandText, queryText, running, ok, failed, stateNote, exitCode: block.exitCode, rows, patchTruncated: block.patchTruncated === true, stderr: block.stderr, output: block.outputText, errorText: block.errorText, outcome: block.outcome, tasks: block.tasks }
}

export function codexToolTone(view: CodexToolView): "running" | "ok" | "fail" | "muted" {
  if (view.running) return "running"
  if (view.failed) return view.outcome === "denied" || view.outcome === "timeout" ? "muted" : "fail"
  if (view.stateNote) return "muted"
  return "ok"
}
