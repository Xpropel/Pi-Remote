/**
 * 设置 › 扩展 · 纯数据层（无 React / 无 DOM，node --test 直载）。
 *
 * 数据源（设计册附录 A）：
 *   get_commands     → 技能 / 提示词模板清单（source 字段区分来源，sourceInfo 是 pi 的官方元数据）
 *   get_mcp_servers  → MCP 清单（name / transport / exposure / enabled / connected / toolCount / error）
 *   get_settings     → 技能斜杠命令总闸（enableSkillCommands，读得到、写要桥）
 *
 * 解析一律“宽进严出”：坏条目丢弃，缺字段给安全默认，不把没读到的值说成读到了。
 */

type Obj = Record<string, unknown>

function obj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/* ------------------------------------------------------------------ */
/* get_commands                                                        */
/* ------------------------------------------------------------------ */

export interface HostCommand {
  /** pi 注册名（技能常带 skill: 前缀，模板就是文件名）。 */
  name: string
  description: string
  /** extension / prompt / skill / 其它；小写。 */
  source: string
  /** 技能文件 frontmatter 的 disable-model-invocation。 */
  manualOnly: boolean
  /** pi 提供的来源文件路径（sourceInfo.path）。 */
  sourcePath?: string
}

const MANUAL_KEYS = [
  "manualOnly",
  "disableModelInvocation",
  "disable-model-invocation",
  "disableModel",
  "disable-model",
] as const

function manualFlag(record: Obj | null): boolean {
  if (!record) return false
  for (const key of MANUAL_KEYS) {
    if (record[key] === true || record[key] === "true") return true
  }
  return false
}

/** sourceInfo 是 pi 的官方元数据；字段名未在协议里收紧，所以顶层与 sourceInfo / frontmatter 都认。 */
function manualOnlyOf(raw: Obj): boolean {
  if (manualFlag(raw)) return true
  const info = obj(raw.sourceInfo)
  if (manualFlag(info)) return true
  return manualFlag(obj(info?.frontmatter))
}

/** 任意 get_commands 回包 → 非内置资源命令（去重、去脏行）。 */
export function hostCommandsOf(data: unknown): HostCommand[] {
  const record = obj(data)
  const raw = Array.isArray(record?.commands) ? (record.commands as unknown[]) : []
  const seen = new Set<string>()
  const out: HostCommand[] = []
  for (const item of raw) {
    const rec = obj(item)
    if (!rec) continue
    const name = text(rec.name).replace(/^\/+/, "")
    if (!name || /\s/.test(name)) continue
    const source = text(rec.source).toLowerCase()
    const kind = text(rec.kind).toLowerCase()
    // 内置命令不属于资源清单；即使旧 / 新 pi 混进来也不显示成技能或模板。
    if (source === "builtin" || kind === "builtin") continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const info = obj(rec.sourceInfo)
    const sourcePath = text(info?.path) || text(rec.path)
    out.push({
      name,
      description: text(rec.description),
      source,
      manualOnly: manualOnlyOf(rec),
      ...(sourcePath ? { sourcePath } : {}),
    })
  }
  return out
}

export function skillsOf(commands: readonly HostCommand[]): HostCommand[] {
  return commands.filter((command) => command.source === "skill")
}

export function promptsOf(commands: readonly HostCommand[]): HostCommand[] {
  return commands.filter((command) => command.source === "prompt")
}

/** 技能显示名：`skill:code-review` → `code-review`；没有前缀就原样。 */
export function skillDisplayNameOf(name: string): string {
  return name.replace(/^\/+/, "").replace(/^skill:/i, "") || name
}

/** 提示词模板显示名：文件名即命令名，统一带一个 `/`。 */
export function promptDisplayNameOf(name: string): string {
  return `/${name.replace(/^\/+/, "")}`
}

/** get_settings 里的 enableSkillCommands；读不到时保持设计稿的开启态。 */
export function skillCommandsEnabledOf(data: unknown): boolean {
  const record = obj(data)
  const settings = obj(record?.settings) ?? record
  const value = settings?.enableSkillCommands
  return typeof value === "boolean" ? value : true
}

/* ------------------------------------------------------------------ */
/* get_mcp_servers                                                     */
/* ------------------------------------------------------------------ */

export interface McpServerRow {
  name: string
  transport: string
  /** pi 的曝光档：direct / callable / codemode / search 等。 */
  exposure: string
  enabled: boolean
  connected: boolean
  toolCount: number | null
  error: string
  command?: string
  args?: string[]
  url?: string
  hasUrlQuery?: boolean
  description?: string
  timeout?: number
  envKeys?: string[]
  headerKeys?: string[]
}

/** 任意 get_mcp_servers 回包 → 可渲染清单。字段缺失不补假值。 */
export function mcpServersOf(data: unknown): McpServerRow[] {
  const record = obj(data)
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(record?.servers)
      ? (record.servers as unknown[])
      : []
  const out: McpServerRow[] = []
  for (const item of raw) {
    const rec = obj(item)
    if (!rec) continue
    const name = text(rec.name) || text(rec.id)
    if (!name) continue
    const toolCount = typeof rec.toolCount === "number" && Number.isFinite(rec.toolCount) ? Math.max(0, Math.round(rec.toolCount)) : null
    const row: McpServerRow = {
      name,
      transport: text(rec.transport),
      exposure: text(rec.exposure).toLowerCase(),
      enabled: rec.enabled === true,
      connected: rec.connected === true,
      toolCount,
      error: text(rec.error),
    }
    const command = text(rec.command)
    if (command) row.command = command
    if (Array.isArray(rec.args)) row.args = rec.args.filter((x): x is string => typeof x === "string")
    const url = text(rec.url)
    if (url) row.url = url
    if (rec.hasUrlQuery === true) row.hasUrlQuery = true
    const description = text(rec.description)
    if (description) row.description = description
    if (typeof rec.timeout === "number" && Number.isFinite(rec.timeout)) row.timeout = rec.timeout
    if (Array.isArray(rec.envKeys)) row.envKeys = rec.envKeys.filter((x): x is string => typeof x === "string")
    if (Array.isArray(rec.headerKeys)) row.headerKeys = rec.headerKeys.filter((x): x is string => typeof x === "string")
    out.push(row)
  }
  return out
}

/** 工具曝光档 → 设计稿文案。direct = 工具直接可用，其余（按需 / 未知）都按需查找。 */
export function mcpExposureTextOf(exposure: string): string {
  return exposure === "direct" ? "工具直接可用" : "工具按需查找"
}

/** 一行状态文案：`已连接 · 工具直接可用`。 */
export function mcpStatusTextOf(server: McpServerRow): string {
  return `${server.connected ? "已连接" : "未连接"} · ${mcpExposureTextOf(server.exposure)}`
}

export function mcpToneOf(server: McpServerRow): "online" | "offline" {
  return server.connected ? "online" : "offline"
}

/** 解析 MCP server 启动参数串，支持单/双引号与反斜杠转义。 */
export function splitCommandArgs(raw: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
        current += raw[i + 1]
        i += 1
        hasToken = true
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      hasToken = true
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        out.push(current)
        current = ""
        hasToken = false
      }
      continue
    }
    current += ch
    hasToken = true
  }
  if (hasToken) out.push(current)
  return out
}

/** 将 MCP server 启动参数数组格式化为可编辑命令行文本。 */
export function formatCommandArgs(args?: readonly string[]): string {
  if (!args?.length) return ""
  return args
    .map((arg) => (/[\s"'\\]/.test(arg) || arg === "" ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg))
    .join(" ")
}

/* ------------------------------------------------------------------ */
/* 技能 / 提示词模板 / 扩展 / Pi 包清单增删与启停                         */
/* ------------------------------------------------------------------ */

export type ExtensionResourceKind = "skill" | "prompt" | "extension" | "package"

export interface BuiltinExtensionSpec {
  id: string
  target: string
  label: string
  defaultEnabled: boolean
}

export const BUILTIN_EXTENSION_SPECS: readonly BuiltinExtensionSpec[] = [
  { id: "mcp", target: "builtin:mcp", label: "MCP 支持", defaultEnabled: true },
  { id: "codemode", target: "builtin:codemode", label: "代码模式 codemode", defaultEnabled: true },
  { id: "tool-search", target: "builtin:tool-search", label: "工具搜索", defaultEnabled: true },
  { id: "llama.cpp", target: "builtin:llama.cpp", label: "本地模型 llama.cpp", defaultEnabled: false },
]

export function stripResourcePrefix(entry: string): { prefix: "" | "+" | "-" | "!"; bare: string } {
  const trimmed = entry.trim()
  if (trimmed.startsWith("+") || trimmed.startsWith("-") || trimmed.startsWith("!")) {
    return { prefix: trimmed[0] as "+" | "-" | "!", bare: trimmed.slice(1).trim() }
  }
  return { prefix: "", bare: trimmed }
}

function resourceTargetMatches(entryBare: string, candidate: string): boolean {
  const cleanEntry = entryBare.trim().toLowerCase()
  const cleanCand = candidate.trim().toLowerCase()
  if (!cleanEntry || !cleanCand) return false
  if (cleanEntry === cleanCand) return true
  if (cleanEntry.endsWith(`/${cleanCand}`) || cleanCand.endsWith(`/${cleanEntry}`)) return true
  return false
}

export function isResourceEnabled(
  entries: readonly string[] | null,
  candidates: readonly string[],
  defaultOn = true,
): boolean {
  const list = entries ?? []
  let result = defaultOn
  for (const raw of list) {
    const { prefix, bare } = stripResourcePrefix(raw)
    if (!candidates.some((cand) => resourceTargetMatches(bare, cand))) continue
    if (prefix === "-" || prefix === "!") result = false
    else result = true
  }
  return result
}

export function toggleResourceEntry(
  entries: readonly string[] | null,
  target: string,
  enabled: boolean,
  defaultOn = true,
  matchCandidates: readonly string[] = [target],
): string[] {
  const list = entries ?? []
  const filtered = list.filter((raw) => {
    const { bare } = stripResourcePrefix(raw)
    return !matchCandidates.some((cand) => resourceTargetMatches(bare, cand))
  })
  if (defaultOn) {
    return enabled ? filtered : [...filtered, `-${target}`]
  }
  return enabled ? [...filtered, `+${target}`] : filtered
}

export function addResourceEntry(entries: readonly string[] | null, rawTarget: string): string[] | null {
  const clean = rawTarget.trim()
  if (!clean) return null
  const { prefix, bare } = stripResourcePrefix(clean)
  if (!bare || /[\r\n]/.test(clean)) return null
  const list = entries ?? []
  const filtered = list.filter((raw) => {
    const existing = stripResourcePrefix(raw)
    return existing.bare.toLowerCase() !== bare.toLowerCase()
  })
  return [...filtered, prefix === "-" || prefix === "!" ? bare : clean]
}

export function removeResourceEntry(
  entries: readonly string[] | null,
  target: string,
  matchCandidates: readonly string[] = [target],
): string[] {
  const list = entries ?? []
  return list.filter((raw) => {
    const { bare } = stripResourcePrefix(raw)
    return !matchCandidates.some((cand) => resourceTargetMatches(bare, cand))
  })
}

export interface CustomResourceRow {
  raw: string
  target: string
  enabled: boolean
}

export function customResourceRowsOf(
  entries: readonly string[] | null,
  excludeTargets: readonly string[] = [],
): CustomResourceRow[] {
  const list = entries ?? []
  const byTarget = new Map<string, CustomResourceRow>()
  for (const raw of list) {
    const { prefix, bare } = stripResourcePrefix(raw)
    if (!bare) continue
    if (bare.toLowerCase().startsWith("builtin:")) continue
    if (excludeTargets.some((ex) => resourceTargetMatches(bare, ex))) continue
    byTarget.set(bare.toLowerCase(), {
      raw,
      target: bare,
      enabled: prefix !== "-" && prefix !== "!",
    })
  }
  return [...byTarget.values()]
}

export type PackageSettingInput =
  | string
  | {
      source: string
      extensions?: string[]
      skills?: string[]
      prompts?: string[]
      themes?: string[]
    }

export interface PackageRow {
  key: string
  index: number
  source: string
  enabled: boolean
}

export function packageRowsOf(entries: readonly PackageSettingInput[] | null): PackageRow[] {
  const list = entries ?? []
  return list
    .map((entry, index) => {
      const rawSource = typeof entry === "string" ? entry : entry.source
      const { prefix, bare } = stripResourcePrefix(rawSource)
      if (!bare) return null
      return {
        key: `${index}:${bare}`,
        index,
        source: bare,
        enabled: prefix !== "-" && prefix !== "!",
      }
    })
    .filter((row): row is PackageRow => row !== null)
}

export function togglePackageEntry(
  entries: readonly PackageSettingInput[] | null,
  index: number,
  enabled: boolean,
): PackageSettingInput[] {
  const list = [...(entries ?? [])]
  const current = list[index]
  if (current === undefined) return list
  const rawSource = typeof current === "string" ? current : current.source
  const { bare } = stripResourcePrefix(rawSource)
  if (!bare) return list
  const nextSource = enabled ? bare : `-${bare}`
  list[index] = typeof current === "string" ? nextSource : { ...current, source: nextSource }
  return list
}

export function addPackageEntry(entries: readonly PackageSettingInput[] | null, rawSource: string): PackageSettingInput[] | null {
  const clean = rawSource.trim()
  if (!clean || /[\r\n]/.test(clean)) return null
  const { bare } = stripResourcePrefix(clean)
  if (!bare) return null
  const list = entries ?? []
  const filtered = list.filter((item) => {
    const src = typeof item === "string" ? item : item.source
    return stripResourcePrefix(src).bare.toLowerCase() !== bare.toLowerCase()
  })
  return [...filtered, bare]
}

export function removePackageEntry(entries: readonly PackageSettingInput[] | null, index: number): PackageSettingInput[] {
  const list = entries ?? []
  return list.filter((_, i) => i !== index)
}
