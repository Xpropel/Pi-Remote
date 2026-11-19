/**
 * 设置 › 审批与执行 · 纯数据适配（无 React / 无 DOM / 无副作用），node --test 直接加载。
 *
 *   - 何时询问 / 能碰什么（活动范围）/ 高危解锁 / 免审命令名单：实时同步到当前会话（set_approval_policy）；
 *   - 项目信任：当前项目信任状态读 get_state.projectTrusted；默认策略写 settings_set.defaultProjectTrust；
 *   - 可用工具：get_active_tools + get_all_tools 读，set_active_tools 写，
 *     **作用域 = 当前会话**（无会话时写 defaultTools）。
 */
import { toolNamesOf } from "../../model/dialogsData.ts"

/* ------------------------------------------------------------------ */
/* 口径说明                                                            */
/* ------------------------------------------------------------------ */

export const APPROVAL_BRIEF =
  "pi 没有 Codex 式权限档位；本页通过扩展的 tool_call 权限门与项目信任实施边界。「何时询问 / 能碰什么（活动范围）/ 高危解锁 / 免审命令名单」实时同步到当前会话。"

/* ------------------------------------------------------------------ */
/* 何时询问                                                            */
/* ------------------------------------------------------------------ */

export const APPROVAL_ASK_OPTIONS = [
  { value: "ask", label: "逐项询问", description: "命令与工具调用先经你确认" },
  { value: "allowlist", label: "名单内自动通过", description: "免审名单里的命令直接执行，其余仍询问" },
  {
    value: "never",
    label: "永不询问",
    description: "全部直接执行",
    note: "风险高，仅建议在可信环境开启",
  },
] as const

export type ApprovalAskMode = (typeof APPROVAL_ASK_OPTIONS)[number]["value"]

export const APPROVAL_ASK_DEFAULT: ApprovalAskMode = "ask"

/* ------------------------------------------------------------------ */
/* 项目信任 ◐                                                          */
/* ------------------------------------------------------------------ */

export const APPROVAL_TRUST_OPTIONS = [
  { value: "ask", label: "打开新项目时先询问" },
  { value: "always", label: "总是信任" },
  { value: "never", label: "从不信任" },
] as const

export type ApprovalTrust = (typeof APPROVAL_TRUST_OPTIONS)[number]["value"]

/** pi defaultProjectTrust 的默认值（docs/settings.md）。 */
export const APPROVAL_TRUST_DEFAULT: ApprovalTrust = "ask"

export const APPROVAL_TRUST_NOTE = "项目级配置、扩展与 MCP 服务器都要信任后才加载。"

export type ApprovalProjectTrust = "trusted" | "untrusted" | "unknown"

export const APPROVAL_TRUST_STATE_LABELS: Record<ApprovalProjectTrust, string> = {
  trusted: "已信任",
  untrusted: "未信任",
  unknown: "未知",
}

/** get_state.projectTrusted 是「当前项目」的信任状态，不是默认策略；缺字段回 unknown。 */
export function projectTrustOf(value: unknown): ApprovalProjectTrust {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown"
  const trusted = (value as Record<string, unknown>).projectTrusted
  return typeof trusted === "boolean" ? (trusted ? "trusted" : "untrusted") : "unknown"
}

/* ------------------------------------------------------------------ */
/* 能碰什么                                                            */
/* ------------------------------------------------------------------ */

export const APPROVAL_SCOPE_OPTIONS = [
  { value: "read-only", label: "仅查看", description: "只能读取，不能改动" },
  { value: "workspace", label: "工作区内可改", description: "可改当前工作区内的文件" },
  { value: "full", label: "完全访问", description: "可改设备上任意文件", note: "需先在下方解锁" },
] as const

export type ApprovalScope = (typeof APPROVAL_SCOPE_OPTIONS)[number]["value"]

export const APPROVAL_SCOPE_DEFAULT: ApprovalScope = "workspace"

/* ------------------------------------------------------------------ */
/* 高危解锁                                                            */
/* ------------------------------------------------------------------ */

export const APPROVAL_UNLOCK_LABEL = "允许「完全访问」与「永不询问」"
export const APPROVAL_UNLOCK_DESCRIPTION = "打开后上面两组的高危档位才可选，防误触"

/* ------------------------------------------------------------------ */
/* 免审命令名单                                                        */
/* ------------------------------------------------------------------ */

export const APPROVAL_ALLOWLIST = ["git status", "cat *", "npm run test"] as const

export const APPROVAL_ALLOWLIST_NOTE = "名单内命令按上方策略自动通过，仍会记录在会话里。"

export function approvalAskModeOf(approvalGateEnabled: boolean, useAllowlist: boolean): ApprovalAskMode {
  if (!approvalGateEnabled) return "never"
  return useAllowlist ? "allowlist" : "ask"
}

const SHELL_COMPOUND_RE = /&&|\|\||[;|`<>]|&\s*$|\$\(|[\r\n]/

export function validateAllowlistCommand(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim()
  if (!value) return { ok: false, error: "请输入命令模式（例如 git status 或 npm run test）" }
  if (value.length > 160) return { ok: false, error: "命令模式过长（最多 160 个字符）" }
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return { ok: false, error: "命令模式不能包含控制字符或换行" }
  }
  if (SHELL_COMPOUND_RE.test(value)) {
    return { ok: false, error: "出于安全限制，免审名单不支持管道、重定向、命令替换或串接符号（|、&&、||、;、>、<、$()）" }
  }
  return { ok: true, value }
}

/* ------------------------------------------------------------------ */
/* 可用工具 ●（作用域 = 当前会话）                                     */
/* ------------------------------------------------------------------ */

export interface ApprovalToolSpec {
  id: string
  /** 设计稿行标题（逐字）。 */
  label: string
  /** 对应 pi 工具名候选（内置工具名见 docs/settings.md §Tools）。 */
  names: readonly string[]
  /** 「脚本工具 codemode」那种工具名要等宽显示。 */
  mono?: boolean
  /** 行尾弱签（「默认关」）。 */
  note?: string
}

export const APPROVAL_TOOL_SPECS: readonly ApprovalToolSpec[] = [
  { id: "read", label: "读取文件", names: ["read", "read_file"] },
  { id: "bash", label: "运行命令", names: ["bash", "run_command"] },
  { id: "edit", label: "编辑文件", names: ["edit", "edit_file"] },
  { id: "write", label: "写入文件", names: ["write", "write_file"] },
  { id: "grep", label: "搜索文件", names: ["grep", "search_files"] },
  { id: "ls", label: "文件列表", names: ["ls", "find", "list_files"] },
  { id: "codemode", label: "脚本工具", names: ["codemode"], mono: true, note: "默认关" },
  { id: "tool_search", label: "工具搜索", names: ["tool_search", "searchTools", "search_tools"], note: "默认关" },
]

export interface ApprovalToolRow {
  id: string
  label: string
  /** 本机注册表里命中的实际工具名；没有命中就是 null（页面标「未注册」，不拿别的工具顶替）。 */
  toolName: string | null
  /** 行内显示的工具名：命中用真名，未命中用设计稿里的工具名（「脚本工具 codemode」仍成立）。 */
  displayName: string
  available: boolean
  enabled: boolean
  mono: boolean
  note: string | null
}

export interface ApprovalToolView {
  rows: ApprovalToolRow[]
  /** 当前会话已启用的工具全量（包含设计稿八行之外的工具，切换时原样保留）。 */
  enabled: string[]
}

export const DEFAULT_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "ls"] as const

/**
 * 无打开会话时的默认可用工具视图：读自 settings.json 的 defaultTools（缺省为内置六项开启）。
 */
export function approvalDefaultToolRowsOf(configuredTools: readonly string[] | null): ApprovalToolView {
  const enabledList = configuredTools ? [...configuredTools] : [...DEFAULT_BUILTIN_TOOLS]
  return {
    enabled: enabledList,
    rows: APPROVAL_TOOL_SPECS.map((spec) => {
      const matched = spec.names.find((name) => enabledList.includes(name))
      return {
        id: spec.id,
        label: spec.label,
        toolName: matched ?? spec.names[0],
        displayName: spec.names[0],
        available: true,
        enabled: matched !== undefined,
        mono: spec.mono === true,
        note: spec.note ?? null,
      }
    }),
  }
}

/**
 * 按设计稿八行映射到真实工具名：候选名里第一个在本机注册表里出现的就是这一行的工具。
 * 注册表缺一个工具时该行不可用（不拿别的工具顶替）。
 */
export function approvalToolRowsOf(activeData: unknown, allData: unknown): ApprovalToolView {
  const activeNames = toolNamesOf(activeData)
  const known = new Set([...toolNamesOf(allData), ...activeNames])
  return {
    enabled: activeNames,
    rows: APPROVAL_TOOL_SPECS.map((spec) => {
      const toolName = spec.names.find((name) => known.has(name)) ?? null
      return {
        id: spec.id,
        label: spec.label,
        toolName,
        displayName: toolName ?? spec.names[0],
        available: toolName !== null,
        enabled: toolName !== null && activeNames.includes(toolName),
        mono: spec.mono === true,
        note: spec.note ?? null,
      }
    }),
  }
}

/** set_active_tools 回包里的 tools（数组缺失时用本地算出的下一份）。 */
export function toolsFromResponse(value: unknown, fallback: readonly string[]): string[] {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  return record && Array.isArray(record.tools) ? toolNamesOf(value) : [...fallback]
}

/**
 * 只增删这一行的工具，其余启用项原样保留：
 * 设计稿只列八个内置工具，注册表里的其他工具不该因为本页切换而掉线。
 */
export function toggledToolSet(enabled: readonly string[], toolName: string, next: boolean): string[] {
  if (next) return enabled.includes(toolName) ? [...enabled] : [...enabled, toolName]
  return enabled.filter((name) => name !== toolName)
}

export const APPROVAL_TOOLS_NOTE =
  "改动只作用于当前会话，不是持久默认。关掉的工具不会递到模型手里，与上面的「能碰什么」是两回事。"

export const APPROVAL_TOOLS_EMPTY_HINT = "读不到当前会话的工具清单（未连上主机，或只读命令不可用）。"
