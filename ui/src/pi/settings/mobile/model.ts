/**
 * 手机端设置 · 纯数据派生（无 React、无 DOM；node --test 直载）。
 *
 * 只做三件事：
 *   1. 26 周日历（热力图）与日键运算；
 *   2. `get_settings` / `get_provider_auth` / `get_mcp_servers` / `get_commands` 回包的宽容解析
 *      （主机字段缺失时返回空数组 / null，页面用自己的设计默认形态兜底，不伪造已写入）；
 *   3. 少量展示格式（缓存大小、连接状态）。
 *
 * 所有解析都是「读不到就是没有」：不编造值、不把字符串猜成对象。
 */

/* ------------------------------------------------------------------ */
/* 日键 / 26 周热力图                                                   */
/* ------------------------------------------------------------------ */

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 合法日历日键（YYYY-MM-DD，真实存在；不把 2 月 31 日归一化）。 */
export function isDayKey(value: unknown): value is string {
  if (typeof value !== "string") return false
  const match = DAY_KEY_RE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

function dayKeyFromUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
}

/** 日键 ± n 天（UTC 算术，避免 DST）。 */
export function addDayKeys(dayKey: string, delta: number): string {
  if (!isDayKey(dayKey)) return dayKey
  const [year, month, day] = dayKey.split("-").map(Number)
  const next = new Date(Date.UTC(year, month - 1, day) + Math.trunc(delta) * 86_400_000)
  return dayKeyFromUtc(next)
}

/** 星期几：0=周日 … 6=周六；非法日键返回 NaN。 */
export function weekdayOf(dayKey: string): number {
  if (!isDayKey(dayKey)) return Number.NaN
  const [year, month, day] = dayKey.split("-").map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * 近 N 周热力图窗口：从 anchor 所在周的周日往回 (weeks-1) 周的周日开始，
 * 返回按「列 = 周、行 = 周日→周六」的 weeks × 7 日键矩阵（含今天之后的未来格）。
 * 手机固定传 26；桌面热力图仍由 usage 页面自己算 52 周。
 */
export function heatmapWeekDates(anchorDayKey: string, weeks = 26): string[][] {
  const anchor = isDayKey(anchorDayKey) ? anchorDayKey : dayKeyFromUtc(new Date())
  const count = Math.max(1, Math.trunc(weeks))
  const weekday = weekdayOf(anchor)
  const currentSunday = addDayKeys(anchor, -weekday)
  const firstSunday = addDayKeys(currentSunday, -(count - 1) * 7)
  const columns: string[][] = []
  for (let week = 0; week < count; week += 1) {
    const weekStart = addDayKeys(firstSunday, week * 7)
    const days: string[] = []
    for (let day = 0; day < 7; day += 1) days.push(addDayKeys(weekStart, day))
    columns.push(days)
  }
  return columns
}

/* ------------------------------------------------------------------ */
/* get_settings / get_state 宽容解析                                    */
/* ------------------------------------------------------------------ */

type Loose = Record<string, unknown>

function recordOf(value: unknown): Loose | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Loose) : null
}

/** `get_settings` 回包里的设置对象（`{settings}` 或直接是对象）。 */
export function hostSettingsOf(data: unknown): Loose {
  const record = recordOf(data)
  if (!record) return {}
  return recordOf(record.settings) ?? record
}

/** 点号路径取值；任一层不是对象就返回 undefined。 */
export function settingAt(source: unknown, path: string): unknown {
  let current: unknown = source
  for (const key of path.split(".")) {
    const record = recordOf(current)
    if (!record || !(key in record)) return undefined
    current = record[key]
  }
  return current
}

/** 多个候选路径里第一个非空字符串 / 数字（数字转字符串）；都没有就返回 fallback。 */
export function settingText(source: unknown, paths: readonly string[], fallback = "—"): string {
  for (const path of paths) {
    const value = settingAt(source, path)
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return fallback
}

/** 多个候选路径里第一个布尔值；都没有返回 fallback。 */
export function settingBool(source: unknown, paths: readonly string[], fallback: boolean): boolean {
  for (const path of paths) {
    const value = settingAt(source, path)
    if (typeof value === "boolean") return value
  }
  return fallback
}

/** 多个候选路径里第一个有限非负数；都没有（或负数）返回 null，不拿 0 冒充缺失。 */
export function settingNumber(source: unknown, paths: readonly string[]): number | null {
  for (const path of paths) {
    const value = settingAt(source, path)
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

/** 列表字段（packages / extensions 等）：字符串或带 name 的对象都收，去重后返回字符串数组。 */
export function nameListAt(source: unknown, paths: readonly string[]): string[] {
  for (const path of paths) {
    const value = settingAt(source, path)
    if (!Array.isArray(value)) continue
    const names = value.flatMap((item) => {
      if (typeof item === "string" && item.trim()) return [item.trim()]
      const record = recordOf(item)
      if (!record) return []
      for (const key of ["name", "id", "package"]) {
        const name = record[key]
        if (typeof name === "string" && name.trim()) return [name.trim()]
      }
      return []
    })
    return [...new Set(names)]
  }
  return []
}

/** `get_available_models.models` → 可选的默认模型（provider/modelId 成对）。 */
export interface MobileModelChoice {
  key: string
  provider: string
  modelId: string
  label: string
}

export function modelChoicesOf(data: unknown): MobileModelChoice[] {
  const record = recordOf(data)
  const list = Array.isArray(record?.models) ? record.models : []
  const seen = new Set<string>()
  const choices: MobileModelChoice[] = []
  for (const item of list) {
    const row = recordOf(item)
    if (!row) continue
    const provider = typeof row.provider === "string" ? row.provider.trim() : ""
    const modelId =
      typeof row.id === "string" && row.id.trim()
        ? row.id.trim()
        : typeof row.modelId === "string" && row.modelId.trim()
          ? row.modelId.trim()
          : ""
    if (!provider || !modelId) continue
    const key = `${provider}/${modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    choices.push({ key, provider, modelId, label: modelId })
  }
  return choices
}

export interface MobileModelGroup {
  label: string
  options: { value: string; label: string }[]
}

/**
 * Groups for the default-model select (F7, same fix as the desktop page):
 * one group per provider in first-seen order instead of one flat list
 * mixing every catalog; a provider the auth payload does not report as
 * configured is marked in its group label. Options stay selectable.
 */
export function modelGroupsOf(choices: readonly MobileModelChoice[], providers: readonly MobileProviderRow[]): MobileModelGroup[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  const groups: MobileModelGroup[] = []
  const index = new Map<string, MobileModelGroup>()
  for (const choice of choices) {
    let group = index.get(choice.provider)
    if (!group) {
      const row = byId.get(choice.provider)
      const name = row?.name ?? choice.provider
      group = { label: row && !row.configured ? `${name}（未配置凭据）` : name, options: [] }
      index.set(choice.provider, group)
      groups.push(group)
    }
    group.options.push({ value: choice.key, label: choice.label })
  }
  return groups
}

/** `get_settings` 里的默认模型键（provider/model）；任一缺失返回 null。 */
export function defaultModelKeyOf(settings: unknown): string | null {
  const provider = settingText(settings, ["defaultProvider"], "")
  const model = settingText(settings, ["defaultModel"], "")
  return provider && model ? `${provider}/${model}` : null
}

/** `modelThinkingLevels` → 每模型默认思考档（只读；模型名与档位都来自主机设置）。 */
export function modelThinkingRowsOf(source: unknown): { model: string; level: string }[] {
  const value = settingAt(source, "modelThinkingLevels")
  const record = recordOf(value)
  if (!record) return []
  return Object.entries(record).flatMap(([model, level]) => {
    if (!model.trim() || typeof level !== "string" || !level.trim()) return []
    return [{ model: model.trim(), level: level.trim() }]
  })
}

/* ------------------------------------------------------------------ */
/* 主机只读清单                                                        */
/* ------------------------------------------------------------------ */

export interface MobileProviderRow {
  id: string
  name: string
  connected: boolean
  configured: boolean
  models: number
  authSource: string | null
}

function numberAt(record: Loose, keys: readonly string[]): number {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value)
  }
  return 0
}

/** `get_provider_auth` → 供应商行（不含密钥；只认 id / displayName / configured / authSource / models）。 */
export function providersOf(data: unknown): MobileProviderRow[] {
  const record = recordOf(data)
  const list = Array.isArray(record?.providers) ? record.providers : []
  return list.flatMap((item) => {
    const row = recordOf(item)
    if (!row) return []
    const id = typeof row.id === "string" ? row.id.trim() : ""
    if (!id) return []
    const displayName = typeof row.displayName === "string" && row.displayName.trim() ? row.displayName.trim() : id
    const configured = row.configured === true || row.connected === true
    return [
      {
        id,
        name: displayName,
        connected: row.connected === true || configured,
        configured,
        models: numberAt(row, ["models", "modelCount"]),
        authSource: typeof row.authSource === "string" && row.authSource.trim() ? row.authSource.trim() : null,
      },
    ]
  })
}

export interface MobileMcpRow {
  name: string
  connected: boolean
  enabled: boolean
  transport: string | null
  exposure: string | null
  toolCount: number
}

/** `get_available_models` 的模型条目数（只用于刷新行右侧的「N 个模型」；缺失就是 0）。 */
export function availableModelCountOf(data: unknown): number {
  const record = recordOf(data)
  return Array.isArray(record?.models) ? record.models.length : 0
}

/** `get_mcp_servers` → MCP 行（只读；不改配置）。 */
export function mcpServersOf(data: unknown): MobileMcpRow[] {
  const record = recordOf(data)
  const list = Array.isArray(record?.servers) ? record.servers : []
  return list.flatMap((item) => {
    const row = recordOf(item)
    if (!row) return []
    const name = typeof row.name === "string" ? row.name.trim() : typeof row.id === "string" ? row.id.trim() : ""
    if (!name) return []
    return [
      {
        name,
        connected: row.connected === true,
        enabled: row.enabled !== false,
        transport: typeof row.transport === "string" && row.transport.trim() ? row.transport.trim() : null,
        exposure: typeof row.exposure === "string" && row.exposure.trim() ? row.exposure.trim() : null,
        toolCount: numberAt(row, ["toolCount", "tools"]),
      },
    ]
  })
}

export interface MobileCommandRow {
  name: string
  description: string
  source: string
  /** 技能文件 frontmatter 的 disable-model-invocation（仅手动调用）真实字段。 */
  manualOnly: boolean
}

/** `get_commands` → 命令行；`kind` 过滤 source（skill / prompt，大小写不敏感）。 */
export function commandsOf(data: unknown, kind?: "skill" | "prompt"): MobileCommandRow[] {
  const record = recordOf(data)
  const list = Array.isArray(record?.commands) ? record.commands : []
  const rows = list.flatMap((item) => {
    const row = recordOf(item)
    if (!row) return []
    const name = typeof row.name === "string" ? row.name.trim() : ""
    if (!name) return []
    const source = typeof row.source === "string" ? row.source.trim() : ""
    const sourceInfo = recordOf(row.sourceInfo)
    const manualOnly =
      row.manualOnly === true ||
      row.disableModelInvocation === true ||
      sourceInfo?.disableModelInvocation === true ||
      sourceInfo?.["disable-model-invocation"] === true
    return [
      {
        name,
        description: typeof row.description === "string" ? row.description.trim() : "",
        source,
        manualOnly,
      },
    ]
  })
  if (!kind) return rows
  return rows.filter((row) => row.source.toLowerCase().includes(kind))
}

/* ------------------------------------------------------------------ */
/* 展示                                                                */
/* ------------------------------------------------------------------ */

/** 本机缓存大小的诚实展示（只算 localStorage 里的字符串字节数，不冒充设备会话体积）。 */
export function cacheSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB"
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** localStorage 字符串键值总字节数（UTF-16 按 2 字节/字符估算）。 */
export function localStorageBytesOf(storage: { length: number; key(index: number): string | null; getItem(key: string): string | null } | null | undefined): number {
  if (!storage) return 0
  let total = 0
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (!key) continue
    const value = storage.getItem(key)
    total += (key.length + (value?.length ?? 0)) * 2
  }
  return total
}

/** 连接状态一句话（● 现成桥）。 */
export function connectionLabel(input: { authed?: boolean; browserOnline?: boolean }): string {
  if (input.browserOnline === false) return "浏览器离线"
  return input.authed === true ? "已连接" : "未连接"
}
