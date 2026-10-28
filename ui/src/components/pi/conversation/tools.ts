/**
 * 工具块 → 呈现方式（§1.5 "工具活动按动作的重量呈现"）。只做查表与取数，不猜缺失字段。
 * 对应产品里 toolConfigs.ts 的 form 字段（one-line / collapsible / plan / panel），查表逻辑不变。
 */
import type { PiTerminalStatus } from "./PiTerminalCard"
import { piBaseName } from "@/components/pi/shared/format"
import { turnErrorOf } from "@/pi/model/turnError"
import type { PiToolBlock } from "@/components/pi/shared/types"

export type ToolWeight = "explore" | "read" | "terminal" | "diff" | "todo" | "other"

const EXPLORE = new Set(["grep", "find", "ls", "glob"])
const TERMINAL = new Set(["bash", "powershell", "shell"])
const TODO = new Set(["todo", "todo_write", "todowrite", "todo_read", "todoread", "tasks"])

export function toolWeight(name: string): ToolWeight {
  const n = name.toLowerCase()
  if (EXPLORE.has(n)) return "explore"
  if (n === "read" || n === "read_file") return "read"
  if (TERMINAL.has(n)) return "terminal"
  if (n === "edit" || n === "write" || n === "multi_edit") return "diff"
  if (TODO.has(n)) return "todo"
  return "other"
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

export function toolCommand(b: PiToolBlock): string {
  return str(b.input?.command) ?? b.argsText
}

export function toolPath(b: PiToolBlock): string {
  return str(b.input?.path) ?? str(b.input?.file_path) ?? ""
}

/**
 * bash 的人话短语。pi 的 bash 参数只有 command / timeout，没有"描述"字段，
 * 所以按命令开头查表（推断）；查不到就写"运行命令"。
 */
export function bashPhrase(command: string): string {
  const c = command.trim().replace(/^(sudo|env \S+=\S+)\s+/, "")
  const rules: [RegExp, string][] = [
    [/^(npm|pnpm|yarn) (run )?test\b|^npx (vitest|jest)\b|^node --test\b/, "运行测试"],
    [/^(npm|pnpm|yarn) run lint\b|^npx eslint\b/, "检查代码规范"],
    [/^npx tsc\b|^(npm|pnpm|yarn) run typecheck\b/, "类型检查"],
    [/^(npm|pnpm|yarn) run build\b/, "构建项目"],
    [/^git diff\b/, "查看 git 改动"],
    [/^git status\b/, "查看 git 状态"],
    [/^git log\b/, "查看提交记录"],
    [/^git\b/, "执行 git 命令"],
    [/^node\b/, "运行脚本"],
    [/^rm\b/, "删除文件"],
    [/^psql\b/, "执行 SQL"],
    [/^nginx -t\b/, "检查 nginx 配置"],
    [/^(ls|find|cat|head|tail|wc)\b/, "查看文件"],
  ]
  for (const [re, phrase] of rules) if (re.test(c)) return phrase
  return "运行命令"
}

/** 读取行的宾语："useMobileViewport.ts L1-128"（行号区间来自 offset / limit，或结果的行数） */
export function readDetail(b: PiToolBlock): string {
  const name = piBaseName(toolPath(b)) || b.argsText
  const offset = num(b.input?.offset)
  const limit = num(b.input?.limit)
  if (offset != null && limit != null) return `${name} L${offset}-${offset + limit - 1}`
  if (b.state === "output-available" && b.outputText) {
    const n = b.outputText.replace(/\n$/, "").split("\n").length
    return `${name} L${offset ?? 1}-${(offset ?? 1) + n - 1}`
  }
  return name
}

/** 一段连续探索调用 → "查看了 3 个文件，搜索 2 次"：grep = 搜索；find / ls = 按结果里列出的文件计数 */
export function exploreSummary(blocks: readonly PiToolBlock[]): string {
  let searches = 0
  let files = 0
  for (const b of blocks) {
    const n = b.name.toLowerCase()
    if (n === "grep") searches++
    else files += b.outputText ? b.outputText.replace(/\n$/, "").split("\n").filter(Boolean).length : 0
  }
  const parts: string[] = []
  if (files > 0) parts.push(`${files} 个文件`)
  if (searches > 0) parts.push(`搜索 ${searches} 次`)
  if (parts.length === 0) return `${blocks.length} 次`
  return files > 0 ? parts.join("，") : parts[0]
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
  return typeof first === "string" ? first : b.argsText
}

/** 思考正文 → 阶段小标题（首行 **…**）+ 正文 */
export function splitThinking(text: string): { phase?: string; body: string } {
  const m = /^\s*\*\*(.+?)\*\*\s*\n+([\s\S]*)$/.exec(text)
  if (m) return { phase: m[1], body: m[2].trim() }
  return { body: text.trim() }
}

/** 回合结束原因 → 一行字（D18）：口径在 pi/model/turnError.ts（错误原文对中文，P5.4） */
export function stopReasonText(stopReason: string | undefined, errorMessage: string | undefined): { text: string; error: boolean } | null {
  return turnErrorOf(stopReason, errorMessage)
}
