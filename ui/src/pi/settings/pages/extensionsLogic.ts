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
  /** 技能文件 frontmatter 的 disable-model-invocation（只读呈现，改它要桥）。 */
  manualOnly: boolean
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
    out.push({
      name,
      description: text(rec.description),
      source,
      manualOnly: manualOnlyOf(rec),
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
    out.push({
      name,
      transport: text(rec.transport),
      exposure: text(rec.exposure).toLowerCase(),
      enabled: rec.enabled === true,
      connected: rec.connected === true,
      toolCount,
      error: text(rec.error),
    })
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
