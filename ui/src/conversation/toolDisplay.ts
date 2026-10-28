/**
 * 工具卡的“人话”展示模型（纯函数，不依赖 React/DOM）。
 *
 * 数据纪律：只消费数据层真实存在的字段。
 *   - 现有四态 preparing / running / succeeded / failed 一一映射，不伪造
 *     queued / waiting_approval / denied / cancelled；
 *   - 退出码 / stderr 只在消息里确实带了 exitCode / stderr 时展示，缺就留空；
 *   - 参数还没流完时不把半截 JSON 当摘要。
 */

export type ToolDisplayState = "preparing" | "running" | "succeeded" | "failed"

export type ToolLike = {
  name: string
  state?: string
  input?: Record<string, unknown>
  argsText?: string
  outputText?: string
  errorText?: string
  exitCode?: number
  stderr?: string
  /** 配置表声明 tasks 的工具才有：从 details 提升的任务清单（transcript 填充）。 */
  tasks?: readonly { status: string }[]
}

export type ToolKind = "bash" | "read" | "write" | "edit" | "search" | "list" | "fetch" | "other"

export type ToolHeadline = {
  /** 动词；fallback 时为空，直接把工具真名当对象。 */
  verb: string | null
  object: string
  /** 真名回退（未知工具）：对象段用等宽 + tertiary。 */
  fallback: boolean
  /** 弱化态（准备中）：对象段用 tertiary，不抢运行/失败的信号。 */
  muted: boolean
}

const VERBS: Record<Exclude<ToolKind, "other">, string> = {
  bash: "运行",
  read: "读取",
  write: "写入",
  edit: "编辑",
  search: "搜索",
  list: "列出",
  fetch: "抓取",
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "target"] as const
const PATTERN_KEYS = ["pattern", "query", "regex", "search"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function stringField(input: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!input) return undefined
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

/** 输入参数：优先结构化 input；只有 argsText 完整可解析时才用，绝不拿半截 JSON 当摘要。 */
export function toolInputOf(tool: ToolLike): Record<string, unknown> | undefined {
  if (tool.input && Object.keys(tool.input).length) return tool.input
  const text = (tool.argsText || "").trim()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export function toolKind(name: string): ToolKind {
  const value = (name || "").toLowerCase()
  // MCP 工具名是 server__tool 形式，别被末尾的 list/read 等词误分类。
  if (/^mcp[_:]/.test(value)) return "other"
  if (/bash|shell|terminal|exec|command|\brun\b|powershell/.test(value)) return "bash"
  if (/write|create|save|append|mkdir|touch/.test(value)) return "write"
  if (/edit|patch|apply|replace|update|insert/.test(value)) return "edit"
  if (/read|view|\bcat\b|open_file|openfile/.test(value)) return "read"
  if (/grep|search|glob|find|query|\brg\b/.test(value)) return "search"
  if (/\bls\b|list|dir|entries/.test(value)) return "list"
  if (/fetch|http|web|url|browser|curl|download/.test(value)) return "fetch"
  return "other"
}

/** 命令首行：空白折叠、96 字符封顶。 */
export function commandSummary(value: string): string {
  return value.replace(/\r\n?/g, "\n").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 96)
}

/** 路径中段省略：首两段 + 末段（文件名全段保留）。 */
export function pathSummary(value: string): string {
  const cleaned = value.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  const parts = cleaned.split("/").filter(Boolean)
  if (parts.length <= 3) return cleaned
  return `${parts.slice(0, 2).join("/")}/…/${parts[parts.length - 1]}`
}

/** 目录：保留可读尾段，末尾补 `/`。 */
export function directorySummary(value: string): string {
  const cleaned = value.trim().replace(/\\/g, "/")
  if (!cleaned) return ""
  const parts = cleaned.split("/").filter(Boolean)
  const shown = parts.length > 2 ? `${parts[0]}/…/${parts[parts.length - 1]}` : parts.join("/")
  return shown ? `${shown}/` : "./"
}

/** URL 的 host + 首段路径，例如 example.com/docs。 */
export function urlSummary(value: string): string {
  const text = value.trim()
  try {
    const url = new URL(text)
    const first = url.pathname.split("/").filter(Boolean)[0]
    return first ? `${url.host}/${first}` : url.host
  } catch {
    return text.slice(0, 96)
  }
}

function objectOf(kind: ToolKind, input: Record<string, unknown> | undefined, name: string): string {
  if (!input) return kind === "other" ? name : ""
  if (kind === "bash") {
    const command = input.command ?? input.cmd ?? input.script
    return typeof command === "string" ? commandSummary(command) : ""
  }
  if (kind === "read" || kind === "write" || kind === "edit") {
    const path = stringField(input, PATH_KEYS)
    return path ? pathSummary(path) : ""
  }
  if (kind === "search") {
    const pattern = stringField(input, PATTERN_KEYS)
    if (!pattern) return ""
    const scope = stringField(input, ["glob", "include", "file", "path"])
    return scope ? `"${pattern}" · ${scope}` : `"${pattern}"`
  }
  if (kind === "list") {
    const path = stringField(input, [...PATH_KEYS, "dir", "directory"])
    return path ? directorySummary(path) : "."
  }
  if (kind === "fetch") {
    const url = stringField(input, ["url", "href", "endpoint"])
    return url ? urlSummary(url) : ""
  }
  return name
}

/**
 * 头部“动词 + 对象”文法。入参没到（preparing 且无 input）显示“准备参数…”，
 * 工具类别未知时退回真名（等宽 500 tertiary），真名同时进 title。
 */
export function toolHeadline(tool: ToolLike, display: ToolDisplayState = "preparing"): ToolHeadline {
  const input = toolInputOf(tool)
  if (!input && display === "preparing") {
    return { verb: null, object: "准备参数…", fallback: false, muted: true }
  }
  const kind = toolKind(tool.name)
  const verb = kind === "other" ? null : VERBS[kind]
  const object = objectOf(kind, input, tool.name)
  if (!verb || !object) {
    return { verb: null, object: tool.name, fallback: true, muted: false }
  }
  return { verb, object, fallback: false, muted: false }
}

export type OutputScale = {
  lines: number
  bytes: number
  size: string
}

/** 只数数据层文本：行数按去掉末尾换行后的真实行数，体积按 UTF-8 字节。 */
export function outputScale(text: string): OutputScale {
  const normalized = (text || "").replace(/\r\n?/g, "\n")
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized
  const lines = trimmed ? trimmed.split("\n").length : 0
  const bytes = new TextEncoder().encode(normalized).length
  const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
  return { lines, bytes, size }
}

export type DiffCounts = { additions: number; deletions: number }

/** U-3：工具耗时与 usage 用时统一 m:ss；正数不足 1s 进到 0:01，不显示 0:00。 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00"
  const seconds = ms < 1000 ? 1 : Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** U-3：tokens 紧凑格式，1_000 → 1k、3_200 → 3.2k、12_345 → 12.3k。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ""
  if (value < 1000) return String(Math.round(value))
  const k = value / 1000
  const digits = k >= 100 ? 0 : 1
  return `${Number(k.toFixed(digits))}k`
}

type SearchHits = { hits: number; files: number }

/** 从 grep/find 的真实输出里数命中；格式对不上就返回 null，退回到输出规模。 */
export function searchHitsOf(text: string): SearchHits | null {
  const files = new Set<string>()
  let hits = 0
  for (const line of (text || "").split("\n")) {
    const match = /^(.+?):(\d+)(?::|$)/.exec(line)
    if (!match) continue
    hits += 1
    files.add(match[1])
  }
  return hits > 0 ? { hits, files: files.size } : null
}

/**
 * 收起态结果摘要。只在成功/失败且卡片收起时调用；没有结构化数据就用输出规模，
 * 空输出显示“无输出”，被拒绝/取消/运行中返回 null（不编造）。
 */
export function toolResultDigest(
  tool: ToolLike,
  display: ToolDisplayState,
  diff?: DiffCounts | null,
): string | null {
  if (display !== "succeeded" && display !== "failed") return null
  const text = tool.outputText || (display === "failed" ? tool.errorText || "" : "")
  const scale = outputScale(text)
  const exit = typeof tool.exitCode === "number" ? tool.exitCode : null
  const hasStderr = !!tool.stderr?.trim()

  if (display === "failed") {
    if (exit !== null) return scale.lines ? `退出 ${exit} · ${scale.lines} 行` : `退出 ${exit}`
    return scale.lines ? `${scale.lines} 行` : null
  }

  if (tool.tasks && tool.tasks.length) {
    const done = tool.tasks.filter((task) => task.status === "completed").length
    return `清单 ${done}/${tool.tasks.length}`
  }
  const kind = toolKind(tool.name)
  if ((kind === "edit" || kind === "write") && diff) {
    return `+${diff.additions} −${diff.deletions}`
  }
  if (kind === "search") {
    const hits = searchHitsOf(text)
    if (hits) return `${hits.hits} 处 · ${hits.files} 个文件`
  }
  if (kind === "bash") {
    const code = exit !== null && (exit !== 0 || hasStderr) ? `退出 ${exit}` : ""
    const scaleText = scale.lines ? `${scale.lines} 行 · ${scale.size}` : "无输出"
    return code ? `${code} · ${scaleText}` : scaleText
  }
  if (!scale.lines) return "无输出"
  if (kind === "read") return `${scale.lines} 行`
  return `${scale.lines} 行 · ${scale.size}`
}

/** 输出按行：保留空行，去掉文件末尾那一个换行。 */
export function outputLines(text: string): string[] {
  if (!text) return []
  const normalized = text.replace(/\r\n?/g, "\n")
  const lines = normalized.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** 折叠阈值：>10 行或 >6000 字符（满足其一）。 */
export function outputNeedsFold(text: string): boolean {
  return outputLines(text).length > 10 || (text || "").length > 6000
}

/** stderr 行级标记：只有数据层提供 stderr 时才标记；合并文本不猜、不染。 */
export function stderrLineSet(stderr: string | undefined): Set<string> {
  return new Set(stderr ? outputLines(stderr) : [])
}

export function languageForPath(path: string | undefined): string {
  if (!path) return "plaintext"
  const match = /\.([A-Za-z0-9]+)$/.exec(path)
  const ext = match?.[1]?.toLowerCase() || ""
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    json: "json",
    css: "css",
    scss: "scss",
    less: "less",
    html: "html",
    md: "markdown",
    markdown: "markdown",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    sql: "sql",
    xml: "xml",
    svg: "xml",
  }
  return map[ext] || "plaintext"
}
