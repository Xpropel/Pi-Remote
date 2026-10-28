/**
 * 弹窗家族的取数解析（plan §7.3 dialog-usage 及弹窗家族、P5.5 c 线；口径照 chat/dialogs.tsx 的 HEAD 版逐个抽出来，不改原文件）。
 * 纯函数，node --test 直接加载。回包缺字段时返回 null / 空，不填默认值（design §1.9）。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/* ---------------- 用量与费用（get_session_stats） ---------------- */

export type PiUsageStats = { userMessages: number; assistantMessages: number; toolCalls: number; toolResults: number; totalMessages: number }

/** get_session_stats 的计数五项；任何一项缺失就整组为 null（三格写"—"，不拼凑） */
export function usageStatsOf(data: unknown): PiUsageStats | null {
  if (!isRecord(data)) return null
  const userMessages = num(data.userMessages)
  const assistantMessages = num(data.assistantMessages)
  const toolCalls = num(data.toolCalls)
  const toolResults = num(data.toolResults)
  const totalMessages = num(data.totalMessages)
  if (userMessages == null || assistantMessages == null || toolCalls == null || toolResults == null || totalMessages == null) return null
  return { userMessages, assistantMessages, toolCalls, toolResults, totalMessages }
}

/* ---------------- 当前状态（get_state，G17） ---------------- */

function textOf(value: unknown): string {
  if (typeof value === "string" && value) return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value === "boolean") return value ? "是" : "否"
  return ""
}

function fullNumber(value: number | null): string {
  return value == null ? "" : value.toLocaleString("zh-CN")
}

/** get_state → 键值行（照 SessionDialog 的行与顺序）；值为空串的行界面写"—" */
export function sessionStateRowsOf(data: unknown): [string, string][] {
  const d = isRecord(data) ? data : {}
  const model = isRecord(d.model) ? String(d.model.name || d.model.modelId || d.model.id || "") : ""
  const phase = d.isCompacting ? "压缩中" : d.isStreaming || d.busy ? "输出中" : "空闲"
  const mode = textOf(d.mode) || "—"
  const hasUi = typeof d.hasUI === "boolean" ? (d.hasUI ? "有界面" : "无界面") : "—"
  const count = num(d.messageCount) ?? num(d.entryCount)
  return [
    ["会话名", textOf(d.sessionName)],
    ["目录", textOf(d.cwd)],
    ["模型", model],
    ["思考级别", textOf(d.thinkingLevel)],
    ["消息数", fullNumber(count)],
    ["待发消息", fullNumber(num(d.pendingMessageCount))],
    ["mode · hasUI", `${mode} · ${hasUi}`],
    ["项目已信任", typeof d.projectTrusted === "boolean" ? (d.projectTrusted ? "是" : "否") : ""],
    ["steer 模式", textOf(d.steeringMode)],
    ["followUp 模式", textOf(d.followUpMode)],
    ["自动压缩", typeof d.autoCompactionEnabled === "boolean" ? (d.autoCompactionEnabled ? "开" : "关") : ""],
    ["运行态", isRecord(data) ? phase : ""],
  ]
}

/* ---------------- 系统提示词（get_system_prompt，G15） ---------------- */

export type PiSystemPromptView = { kind: "prompt"; text: string; truncated: boolean; chars: number | null } | { kind: "reason"; text: string }

export function systemPromptViewOf(data: unknown): PiSystemPromptView {
  if (!isRecord(data)) return { kind: "reason", text: "没有返回系统提示词" }
  if (data.supported === false) {
    const reason = typeof data.error === "string" && data.error.trim() ? data.error.trim() : "当前会话不支持读取系统提示词"
    return { kind: "reason", text: reason }
  }
  if (typeof data.prompt === "string") {
    return { kind: "prompt", text: data.prompt, truncated: data.truncated === true, chars: num(data.chars) }
  }
  const reason = typeof data.error === "string" && data.error.trim() ? data.error.trim() : "没有返回系统提示词"
  return { kind: "reason", text: reason }
}

/** 字数（照"共 N 字"的口径）：截断时用回包的 chars，否则按全文字符数 */
export function systemPromptChars(view: PiSystemPromptView): number | null {
  if (view.kind !== "prompt") return null
  return view.truncated ? view.chars : Array.from(view.text).length
}

/* ---------------- 工具（get_active_tools / get_all_tools / set_active_tools，G16） ---------------- */

export function toolNamesOf(data: unknown): string[] {
  if (!isRecord(data) || !Array.isArray(data.tools)) return []
  return data.tools.flatMap((item) => {
    if (typeof item === "string" && item) return [item]
    if (isRecord(item) && typeof item.name === "string" && item.name) return [item.name]
    return []
  })
}

export function toolDetailsOf(data: unknown): { name: string; description?: string }[] {
  if (!isRecord(data) || !Array.isArray(data.tools)) return []
  return data.tools.flatMap((item) => {
    if (typeof item === "string" && item) return [{ name: item }]
    if (!isRecord(item) || typeof item.name !== "string" || !item.name) return []
    const description = typeof item.description === "string" ? item.description.replace(/\s+/g, " ").slice(0, 120) : undefined
    return [description ? { name: item.name, description } : { name: item.name }]
  })
}

/** 全表 + 已启用：全表没有的已启用工具补在后面；fallback = 全表拿不到、只列已启用的 */
export function toolRowsOf(active: unknown, all: unknown): { rows: { name: string; description?: string }[]; enabled: string[]; fallback: boolean } {
  const enabled = toolNamesOf(active)
  const full = toolDetailsOf(all)
  const rows = [...full]
  for (const name of enabled) if (!rows.some((row) => row.name === name)) rows.push({ name })
  return { rows, enabled, fallback: rows.length > 0 && full.length === 0 }
}

export function sameToolSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((name) => set.has(name))
}

/* ---------------- 分叉（get_fork_messages，G08） ---------------- */

export function forkMessagesOf(data: unknown): { id: string; text: string }[] {
  const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : []
  return messages.flatMap((item) =>
    isRecord(item) && typeof item.entryId === "string" ? [{ id: item.entryId, text: String(item.text || "用户消息").replace(/\s+/g, " ").slice(0, 80) }] : [],
  )
}

/* ---------------- 导出（export_session / export_session_file，G12） ---------------- */

/** 导出单次上限（扩展侧口径 512KB，超限报错而不是导出半份） */
export const EXPORT_MAX_BYTES = 512 * 1024

export function exportViewOf(data: unknown): { text: string; truncated: boolean; chars: number | null; bytes: number | null } {
  const rec = isRecord(data) ? data : {}
  return { text: typeof rec.text === "string" ? rec.text : "", truncated: rec.truncated === true, chars: num(rec.chars), bytes: num(rec.bytes) }
}

export function fileBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "session"
}

/** "512 KB" / "1.2 MB" / "800 B"（照 dialogs.tsx formatBytesLabel） */
export function bytesLabel(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

/* ---------------- 本机设置 / 检视（get_settings 等，G14 / G18） ---------------- */

/** JSON 全文（≤ 200k 字符，超出截断并标出） */
export function jsonTextOf(value: unknown): { text: string; clipped: boolean } {
  let text = ""
  try {
    text = JSON.stringify(value, null, 2) ?? "null"
  } catch {
    text = String(value)
  }
  if (text.length > 200_000) return { text: text.slice(0, 200_000), clipped: true }
  return { text, clipped: false }
}

/** get_settings 回包里的设置对象（{ settings } 或直接是对象） */
export function settingsOf(data: unknown): unknown {
  return isRecord(data) && "settings" in data ? data.settings : data
}

/** 检视本机信息的分类页签（照 dialogs.tsx 的 INSPECT） */
export const INSPECT_PAGES: readonly { id: string; label: string; command: string; args?: Record<string, unknown> }[] = [
  { id: "tools", label: "工具全表", command: "get_all_tools" },
  { id: "auth", label: "Provider 认证", command: "get_provider_auth" },
  { id: "mcp", label: "MCP", command: "get_mcp_servers" },
  { id: "scoped", label: "模型作用域", command: "get_scoped_models" },
  { id: "routing", label: "虚拟路由", command: "get_routing" },
  { id: "flags", label: "扩展 flags", command: "get_flags", args: { names: [] } },
  { id: "children", label: "会话树子节点", command: "get_children" },
  { id: "labels", label: "书签", command: "get_labels" },
  { id: "git", label: "git 分支", command: "get_git_branch" },
  { id: "projection", label: "模型看到的上下文", command: "get_projection" },
]

/* ---------------- 会话树（get_tree，G10） ---------------- */

export const TREE_FILTER_OPTIONS: readonly { value: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; label: string }[] = [
  { value: "default", label: "默认" },
  { value: "no-tools", label: "不要工具" },
  { value: "user-only", label: "只看用户" },
  { value: "labeled-only", label: "只看书签" },
  { value: "all", label: "全部" },
]

/** get_tree 回包的 tree / leafId */
export function treeDataOf(data: unknown): { tree: unknown; leafId: string } {
  const rec = isRecord(data) ? data : {}
  return { tree: rec.tree ?? [], leafId: rec.leafId != null ? String(rec.leafId) : "" }
}

/** navigate_tree 的回包 → 一句回执 */
export function treeJumpNotice(data: unknown, summarize: boolean): string {
  const summarized = isRecord(data) && data.summary === true
  const noop = isRecord(data) && data.noop === true
  if (summarized) return "已总结离开的分支并跳到所选节点"
  if (noop) return summarize ? "已在当前叶，无需总结" : "已跳到所选节点"
  return summarize ? "已跳到所选节点（没有需要总结的分支）" : "已跳到所选节点"
}
