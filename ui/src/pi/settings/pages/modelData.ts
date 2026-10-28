/**
 * 设置 › 模型与会话 · 纯数据适配（无 React / 无 DOM / 无副作用），node --test 直接加载。
 *
 * 设计册 §4 的四组：默认模型 / 供应商 / 上下文压缩 / 新会话。
 * 读侧只用现成只读命令（附录 A）：
 *   get_settings         默认模型 / 默认思考等级 / hideThinkingBlock / modelThinkingLevels / compaction.*
 *   get_provider_auth    供应商清单与登录状态（不含密钥）
 *   get_available_models 供应商下的模型清单 + 认证可用清单（Model.baseUrl 给「接口地址」）
 *   get_state            autoCompactionEnabled
 * 写侧全部是 ◐：本模块只把值整理成只读呈现，不提供任何写入函数。
 *
 * 口径：缺字段就回 null（页面写「—」），不拿当前会话值冒充持久默认值，也不拼默认值。
 */
/* ------------------------------------------------------------------ */
/* 思考等级                                                            */
/* ------------------------------------------------------------------ */

/** pi 的七档（docs/settings.md §Model and thinking）：档位由 pi 按当前模型返回，这里只做文案映射。 */
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number]

export const MODEL_THINKING_LEVEL_LABELS: Record<ModelThinkingLevel, string> = {
  off: "关",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最高",
}

/** 设计稿「默认思考等级」行下的说明，逐字照 v3 图。 */
export const MODEL_THINKING_LEVELS_COPY = "共七档：关 / 最小 / 低 / 中 / 高 / 超高 / 最高"

export function thinkingLevelLabelOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  return (MODEL_THINKING_LEVEL_LABELS as Record<string, string>)[value] ?? null
}

/* ------------------------------------------------------------------ */
/* 设置回包                                                            */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function pathValue(record: Record<string, unknown> | null, path: readonly string[]): unknown {
  let current: unknown = record
  for (const key of path) {
    const node = asRecord(current)
    if (!node) return undefined
    current = node[key]
  }
  return current
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

/** get_settings 回包是 { settings } 或裸设置对象；两种都吃。 */
export function settingsRecordOf(value: unknown): Record<string, unknown> {
  const outer = asRecord(value)
  if (!outer) return {}
  return asRecord(outer.settings) ?? outer
}

/** pi 的设置默认值（docs/settings.md §Compaction），仅用于 ◌ 只读数值行读不到时展示。 */
export const MODEL_COMPACTION_DEFAULTS = { reserveTokens: 16384, keepRecentTokens: 20000 } as const

export interface ModelSettingsView {
  defaultModel: string | null
  defaultProvider: string | null
  /** 已映射成设计稿中文档位（关 / 最小 / … / 最高）；读不到就是 null。 */
  defaultThinkingLevel: string | null
  /** 显示思考过程 = !hideThinkingBlock（pi 默认 false，即默认显示）。 */
  showThinking: boolean
  reserveTokens: number | null
  keepRecentTokens: number | null
  /** "provider/modelId" → 中文档位，供供应商卡的「思考·最高」列。 */
  modelThinkingLevels: Record<string, string>
}

export function modelSettingsOf(value: unknown): ModelSettingsView {
  const record = settingsRecordOf(value)
  const levels = asRecord(pathValue(record, ["modelThinkingLevels"]))
  const modelThinkingLevels: Record<string, string> = {}
  if (levels) {
    for (const [key, level] of Object.entries(levels)) {
      const label = thinkingLevelLabelOf(level)
      if (label) modelThinkingLevels[key] = label
    }
  }
  return {
    defaultModel: nonEmptyString(pathValue(record, ["defaultModel"])),
    defaultProvider: nonEmptyString(pathValue(record, ["defaultProvider"])),
    defaultThinkingLevel: thinkingLevelLabelOf(pathValue(record, ["defaultThinkingLevel"])),
    showThinking: pathValue(record, ["hideThinkingBlock"]) !== true,
    reserveTokens: nonNegativeNumber(pathValue(record, ["compaction", "reserveTokens"])),
    keepRecentTokens: nonNegativeNumber(pathValue(record, ["compaction", "keepRecentTokens"])),
    modelThinkingLevels,
  }
}

/* ------------------------------------------------------------------ */
/* 供应商与模型                                                        */
/* ------------------------------------------------------------------ */

export type ModelProviderState = "connected" | "disconnected" | "unknown"

export interface ModelRow {
  /** provider/modelId，与 modelThinkingLevels 的键一致。 */
  key: string
  provider: string
  modelId: string
  /** 卡内左列展示的模型名（等宽），照设计稿用 modelId。 */
  label: string
  /** 「思考·最高」里的档位；没配就是 null（页面不编值）。 */
  thinking: string | null
  /** 认证可用 = 开（pi 的可用清单）；清单缺失时按已配置模型算可用。 */
  enabled: boolean
}

export interface ProviderRow {
  id: string
  name: string
  state: ModelProviderState
  /** 去掉协议与尾斜杠后的接口地址，例如 api.stepfun.com/v1。 */
  endpoint: string | null
  /** 密钥是否已配置；未知就是 null。 */
  configured: boolean | null
  models: ModelRow[]
}

/** "https://api.stepfun.com/v1/" → "api.stepfun.com/v1"（设计稿的接口地址写法）。 */
export function endpointLabelOf(value: unknown): string | null {
  const raw = nonEmptyString(value)
  if (!raw) return null
  return raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "")
}

function modelIdOf(value: Record<string, unknown>): string | null {
  return nonEmptyString(value.id) ?? nonEmptyString(value.modelId)
}

interface RawModel {
  provider: string
  modelId: string
  key: string
  baseUrl: string | null
}

function modelsOf(value: unknown): RawModel[] {
  const record = asRecord(value)
  const list = Array.isArray(record?.models) ? record.models : []
  const rows: RawModel[] = []
  for (const item of list) {
    const model = asRecord(item)
    if (!model) continue
    const provider = nonEmptyString(model.provider)
    const modelId = modelIdOf(model)
    if (!provider || !modelId) continue
    rows.push({ provider, modelId, key: `${provider}/${modelId}`, baseUrl: nonEmptyString(model.baseUrl) })
  }
  return rows
}

/** get_available_models.available 的键集合；字段缺失返回 null（表示「可用清单没给」）。 */
function availableKeysOf(value: unknown): Set<string> | null {
  const record = asRecord(value)
  if (!Array.isArray(record?.available)) return null
  const keys = new Set<string>()
  for (const item of record.available) {
    const model = asRecord(item)
    if (!model) continue
    const provider = nonEmptyString(model.provider)
    const modelId = modelIdOf(model)
    if (provider && modelId) keys.add(`${provider}/${modelId}`)
  }
  return keys
}

interface RawAuthProvider {
  id: string
  name: string | null
  configured: boolean | null
}

function authProvidersOf(value: unknown): RawAuthProvider[] {
  const record = asRecord(value)
  const list = Array.isArray(record?.providers) ? record.providers : []
  const rows: RawAuthProvider[] = []
  for (const item of list) {
    const provider = asRecord(item)
    if (!provider) continue
    const id = nonEmptyString(provider.id)
    if (!id) continue
    rows.push({
      id,
      name: nonEmptyString(provider.displayName) ?? nonEmptyString(provider.name),
      configured: typeof provider.configured === "boolean" ? provider.configured : null,
    })
  }
  return rows
}

/**
 * 供应商卡数据：以 get_provider_auth 的顺序为准，再补上只出现在模型清单里的供应商。
 * 登录状态只认 configured（true/false），读不到就是 unknown —— 不猜「已连接」。
 */
export function providerRowsOf(
  authData: unknown,
  modelsData: unknown,
  modelThinkingLevels: Record<string, string> = {},
): ProviderRow[] {
  const authProviders = authProvidersOf(authData)
  const models = modelsOf(modelsData)
  const available = availableKeysOf(modelsData)
  const authById = new Map(authProviders.map((provider) => [provider.id, provider]))

  const ids: string[] = authProviders.map((provider) => provider.id)
  for (const model of models) {
    if (!ids.includes(model.provider)) ids.push(model.provider)
  }

  return ids.map((id) => {
    const auth = authById.get(id) ?? null
    const own = models.filter((model) => model.provider === id)
    const configured = auth ? auth.configured : null
    return {
      id,
      name: auth?.name ?? id,
      state: configured === null ? "unknown" : configured ? "connected" : "disconnected",
      endpoint: endpointLabelOf(own.find((model) => model.baseUrl)?.baseUrl ?? null),
      configured,
      models: own.map((model) => ({
        key: model.key,
        provider: model.provider,
        modelId: model.modelId,
        label: model.modelId,
        thinking: modelThinkingLevels[model.key] ?? null,
        enabled: available ? available.has(model.key) : true,
      })),
    }
  })
}

/** 供应商卡只列前几个模型（设计稿一行一个模型），其余数量单独一行。 */
export const MODEL_PROVIDER_MODEL_LIMIT = 3

export function providerModelOverflowOf(provider: ProviderRow): number {
  return Math.max(0, provider.models.length - MODEL_PROVIDER_MODEL_LIMIT)
}

/* ------------------------------------------------------------------ */
/* 状态与数值                                                          */
/* ------------------------------------------------------------------ */

/** get_state.autoCompactionEnabled；读不到就不冒充（页面回落 pi 默认值 true 并保留 ◐ 徽标）。 */
export function autoCompactionOf(value: unknown): boolean | null {
  const record = asRecord(value)
  return record && typeof record.autoCompactionEnabled === "boolean" ? record.autoCompactionEnabled : null
}

/** 千分位（设计稿 16,384 / 20,000）；不依赖 locale。 */
export function tokenCountLabel(value: number | null): string {
  if (value === null) return "—"
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/* ------------------------------------------------------------------ */
/* 新会话                                                              */
/* ------------------------------------------------------------------ */

export const MODEL_NEW_SESSION_MODES = [
  { value: "agent", label: "Agent" },
  { value: "ask", label: "仅提问" },
] as const

export type ModelNewSessionMode = (typeof MODEL_NEW_SESSION_MODES)[number]["value"]

/**
 * 设计稿「默认模式」选中 Agent。pi 1.3 的设置表（schemas/settings.schema.json）里没有
 * 新会话默认模式字段，所以这里按设计稿给只读默认，不声称读到了主机值。
 */
export const MODEL_NEW_SESSION_DEFAULT: ModelNewSessionMode = "agent"
