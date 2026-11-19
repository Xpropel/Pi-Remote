/**
 * 工具块 → 呈现方式（§1.5 "工具活动按动作的重量呈现"）。只做查表与取数，不猜缺失字段。
 * 对应产品里 toolConfigs.ts 的 form 字段（one-line / collapsible / plan / panel），查表逻辑不变。
 */
import type { PiTerminalStatus } from "./PiTerminalCard"
import { abortedToolResult } from "@/chat/capsules/terminalModel"
import { piBaseName } from "@/components/pi/shared/format"
import { turnErrorEnOf, turnErrorOf, type PiTurnEnd } from "@/pi/model/turnError"
import type { PiToolBlock } from "@/components/pi/shared/types"

export type ToolWeight = "explore" | "read" | "terminal" | "diff" | "todo" | "subagent" | "other"

const EXPLORE = new Set(["grep", "find", "ls", "glob"])
const TERMINAL = new Set(["bash", "powershell", "shell"])
const TODO = new Set(["todo", "todo_write", "todowrite", "todo_read", "todoread", "tasks"])
const SUBAGENT = new Set(["subagent", "task", "agent"])

export function toolWeight(name: string): ToolWeight {
  const n = name.trim().toLowerCase()
  if (EXPLORE.has(n)) return "explore"
  if (n === "read" || n === "read_file") return "read"
  if (TERMINAL.has(n)) return "terminal"
  if (n === "edit" || n === "write" || n === "multi_edit") return "diff"
  if (TODO.has(n)) return "todo"
  if (SUBAGENT.has(n)) return "subagent"
  return "other"
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

/** 参数还在流（input 未到）时 argsText 是半截 JSON：取出某个字符串字段已经到了的那部分（"command"、"path"），取不到 = undefined */
function partialArg(b: PiToolBlock, key: string): string | undefined {
  if (b.input != null) return undefined
  const m = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(b.argsText)
  if (!m) return undefined
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return m[1]
  }
}

/** 没有结构化参数时的兜底文字：半截 JSON 不露出来 */
function argsFallback(b: PiToolBlock): string {
  return b.input == null && b.argsText.trimStart().startsWith("{") ? "" : b.argsText
}

export function toolCommand(b: PiToolBlock): string {
  return str(b.input?.command) ?? partialArg(b, "command") ?? argsFallback(b)
}

export function toolPath(b: PiToolBlock): string {
  return str(b.input?.path) ?? str(b.input?.file_path) ?? partialArg(b, "path") ?? partialArg(b, "file_path") ?? ""
}

export type EditPair = { oldText: string; newText: string }

function isEditPair(v: unknown): v is EditPair {
  return typeof v === "object" && v != null && typeof (v as EditPair).oldText === "string" && typeof (v as EditPair).newText === "string"
}

/** 没有可画改动的写入 / 编辑（参数没到，或停止时被 pi 丢掉）：一行的动词 + 文件名，不知道文件时写 "Wrote file" / "Writing file" */
export function diffLineOf(b: PiToolBlock, running: boolean): { verb: string; detail?: string } {
  const path = toolPath(b)
  const write = b.name.toLowerCase() === "write"
  const verb = `${running ? (write ? "Writing" : "Editing") : write ? "Wrote" : "Edited"}${path ? "" : " file"}`
  return path ? { verb, detail: piBaseName(path) } : { verb }
}

/** edit 参数里成对的替换（pi 现在是 edits[]，旧版是顶层 oldText / newText）；参数还在写时只取已经成对的 */
export function editsOf(b: PiToolBlock): EditPair[] | undefined {
  const input = b.input
  const list: unknown[] = input && Array.isArray(input.edits) ? input.edits : [input]
  const pairs = list.filter(isEditPair).map(({ oldText, newText }) => ({ oldText, newText }))
  return pairs.length ? pairs : undefined
}

/** 工具名：模型还没报名字时数据层留空（旧数据里是参数在流时的占位 "tool"），这时 = null */
export function toolNameOf(b: PiToolBlock): string | null {
  return !b.name || (b.name === "tool" && b.input == null) ? null : b.name
}

/**
 * bash 的人话短语。pi 的 bash 参数只有 command / timeout，没有"描述"字段，
 * 所以按命令开头查表（推断）；查不到就写"运行命令"。
 */
export function bashPhrase(command: string): string {
  const c = command
    .trim()
    // 先进目录再干活（"cd D:/proj && node --test"）：按后面真正干活的那条查表
    .replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, "")
    .replace(/^(sudo|env \S+=\S+)\s+/, "")
  const rules: [RegExp, string][] = [
    [/^(npm|pnpm|yarn) (run )?test\b|^npx (vitest|jest)\b|^node --test\b/, "Run tests"],
    [/^(npm|pnpm|yarn) run lint\b|^npx eslint\b/, "Run lint"],
    [/^npx tsc\b|^(npm|pnpm|yarn) run typecheck\b/, "Typecheck"],
    [/^(npm|pnpm|yarn) run build\b/, "Build project"],
    [/^git diff\b/, "Check git diff"],
    [/^git status\b/, "Check git status"],
    [/^git log\b/, "View git log"],
    [/^git\b/, "Run git"],
    [/^node\b/, "Run script"],
    [/^rm\b/, "Remove files"],
    [/^psql\b/, "Run SQL"],
    [/^nginx -t\b/, "Check nginx config"],
    [/^(ls|find|cat|head|tail|wc)\b/, "Inspect files"],
    [/^(grep|rg)\b/, "Search text"],
  ]
  for (const [re, phrase] of rules) if (re.test(c)) return phrase
  return "Run command"
}

/**
 * pi 的 bash 结果把非零退出码写在输出最后一行（"Command exited with code 1"，readyUI/data-interface.md）。
 * 数据里没有结构化的退出码时从这行取，卡头写"失败 · 退出 1"；这行不是命令自己的输出，从输出里去掉。
 */
export function splitExitTrailer(output: string | undefined, exitCode: number | undefined): { output: string | undefined; exitCode: number | undefined } {
  const m = output ? /\n*Command exited with code (\d+)\s*$/.exec(output) : null
  if (!output || !m) return { output, exitCode }
  return { output: output.slice(0, m.index), exitCode: exitCode ?? Number(m[1]) }
}

/** 读取行的宾语："useMobileViewport.ts L1-128"（行号区间来自 offset / limit，或结果的行数） */
export function readDetail(b: PiToolBlock): string {
  const name = piBaseName(toolPath(b)) || argsFallback(b)
  const offset = num(b.input?.offset)
  const limit = num(b.input?.limit)
  if (offset != null && limit != null) return `${name} L${offset}-${offset + limit - 1}`
  if (b.state === "output-available" && b.outputText) {
    const n = b.outputText.replace(/\n$/, "").split("\n").length
    return `${name} L${offset ?? 1}-${(offset ?? 1) + n - 1}`
  }
  return name
}

/** 一段连续探索调用 → "Explored 3 files, 2 searches" */
export function exploreSummary(blocks: readonly PiToolBlock[]): string {
  if (blocks.length === 0) return ""
  let searches = 0
  let files = 0
  for (const b of blocks) {
    const n = b.name.trim().toLowerCase()
    if (n === "grep") searches++
    else if (n === "read" || n === "read_file") files++
    else files += b.outputText ? b.outputText.replace(/\n$/, "").split("\n").filter(Boolean).length : 0
  }
  const parts: string[] = []
  if (files > 0) parts.push(`${files} ${files === 1 ? "file" : "files"}`)
  if (searches > 0) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`)
  if (parts.length === 0) return `${blocks.length} ${blocks.length === 1 ? "call" : "calls"}`
  return files > 0 ? parts.join(", ") : parts[0]
}

/** 探索行展开后的一行（一次调用）：动词 + 对象 + 范围 + 结果计数 */
export type ExploreRow = { id: string; verb: string; target: string; scope?: string; count?: string; path?: string; running: boolean; failed: boolean }

export function exploreRowOf(b: PiToolBlock, stopped = false): ExploreRow {
  const n = b.name.toLowerCase()
  const status = streamToolStatus(b, stopped)
  const done = status === "succeeded"
  const lines = b.outputText ? b.outputText.replace(/\n$/, "").split("\n").filter(Boolean).length : 0
  const base = { id: b.id, running: status === "running", failed: status === "failed" }
  const scope = str(b.input?.path)
  if (n === "grep") return { ...base, verb: "Search", target: str(b.input?.pattern) ?? partialArg(b, "pattern") ?? argsFallback(b), scope, count: done ? (lines > 0 ? `${lines} ${lines === 1 ? "match" : "matches"}` : "no matches") : undefined }
  if (n === "read" || n === "read_file") return { ...base, verb: "Read", target: readDetail(b), path: toolPath(b) || undefined }
  if (n === "ls") return { ...base, verb: "List", target: scope ?? partialArg(b, "path") ?? argsFallback(b), count: done ? `${lines} ${lines === 1 ? "item" : "items"}` : undefined }
  const target = str(b.input?.pattern) ?? str(b.input?.glob) ?? str(b.input?.name) ?? partialArg(b, "pattern") ?? argsFallback(b)
  return { ...base, verb: "Find", target, scope, count: done ? (lines > 0 ? `${lines} ${lines === 1 ? "file" : "files"}` : "no matches") : undefined }
}

/** 工具块的终端 / 轻行状态（toolDisplayState 的口径 + outcome） */
export function toolStatus(b: PiToolBlock): PiTerminalStatus {
  if (b.state === "denied" || (b.state === "output-error" && b.outcome === "denied")) return "denied"
  if (b.state === "output-error" && b.outcome === "timeout") return "timed_out"
  switch (b.state) {
    case "output-error":
      return "failed"
    case "output-available":
      return "succeeded"
    case "cancelled":
      return "aborted"
    // 下面两态现在的协议里还没有来源（transcript.ts 注释），数据真的出现时才映射
    case "waiting_approval":
      return "waiting"
    case "queued":
      return "queued"
    default:
      return "running"
  }
}

/** 回合停在这条消息上：用户停止（pi 有时把被打断的那次模型调用记成 error + AbortSignal 原文，同 turnErrorOf 的口径） */
export function stoppedEnd(stopReason: string | undefined, errorMessage: string | undefined): boolean {
  return stopReason === "aborted" || (stopReason === "error" && turnErrorOf("error", errorMessage)?.error === false)
}

/**
 * 工具在流里的状态。停止回合时被打断的（结果是 pi 的停止样板）算已取消、不算失败，和终端视图同一口径；
 * 消息停在了半路（stopped）时还没跑的（参数写到一半、没轮到执行）也算已取消：它不会再跑，
 * 不能一直"运行中"，写入 / 编辑卡也不能看着像已经写进文件了
 */
export function streamToolStatus(b: PiToolBlock, stopped: boolean): PiTerminalStatus {
  const status = toolStatus(b)
  if (status === "failed" && abortedToolResult(b.outputText)) return "aborted"
  return stopped && status === "running" ? "aborted" : status
}

/** 超时秒数：先看结果样板 "Command timed out after N seconds"，再看参数 timeout（秒） */
export function timeoutSeconds(b: PiToolBlock): number | undefined {
  const m = /timed out after (\d+) seconds/i.exec(`${b.errorText ?? ""}\n${b.outputText}`)
  if (m) return Number(m[1])
  return num(b.input?.timeout)
}

/** 其他工具的轻行："调用 fetch · example.com" */
export function otherDetail(b: PiToolBlock): string {
  const url = str(b.input?.url)
  if (url) {
    try {
      return new URL(url).host
    } catch {
      return url
    }
  }
  const first = b.input ? Object.values(b.input).find((v) => typeof v === "string") : undefined
  return typeof first === "string" ? first : argsFallback(b)
}

/** 思考正文 → 阶段小标题（首行 **…**）+ 正文 */
export function splitThinking(text: string): { phase?: string; body: string } {
  const m = /^\s*\*\*(.+?)\*\*\s*\n+([\s\S]*)$/.exec(text)
  if (m) return { phase: m[1], body: m[2].trim() }
  return { body: text.trim() }
}

/** 回合结束原因 → 一行字（D18）：口径在 pi/model/turnError.ts */
export function stopReasonText(stopReason: string | undefined, errorMessage: string | undefined): PiTurnEnd | null {
  return turnErrorEnOf(stopReason, errorMessage)
}
