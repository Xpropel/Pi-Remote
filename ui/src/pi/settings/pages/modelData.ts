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
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
}

/** 设计稿「默认思考等级」行下的说明。 */
export const MODEL_THINKING_LEVELS_COPY = "共七档：Off / Minimal / Low / Medium / High / XHigh / Max"

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

export interface ModelConfigModelData {
  id: string
  name?: string
  api?: string
  baseUrl?: string
  reasoning?: boolean
  input?: string[]
  contextWindow?: number
  maxTokens?: number
  headerKeys?: string[]
}

export interface ModelConfigProviderData {
  id: string
  name?: string
  baseUrl?: string
  api?: string
  authHeader?: boolean
  headerKeys?: string[]
  inModelsJson: boolean
  inAuthJson: boolean
  hasApiKey: boolean
  apiKeySource?: string | null
  apiKeyHint?: string | null
  models: ModelConfigModelData[]
}

export interface ModelRow {
  /** provider/modelId，与 modelThinkingLevels 的键一致。 */
  key: string
  provider: string
  modelId: string
  /** 卡内左列展示的模型名（等宽），照设计稿用 modelId。 */
  label: string
  /** 可读显示名（来自 get_available_models / models.json），缺失时为空。 */
  name?: string | null
  /** 「思考·最高」里的档位；没配就是 null（页面不编值）。 */
  thinking: string | null
  /** 认证可用 = 开（pi 的可用清单）；或来自 enabledModels 白名单。 */
  enabled: boolean
  /** 来自 models.json 的模型定义（存在即可在设置中编辑/删除）。 */
  customModel?: ModelConfigModelData | null
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
  /** 来自 get_models_config 的供应商详情，供编辑弹窗预填。 */
  customConfig?: ModelConfigProviderData | null
}

export function modelsConfigOf(value: unknown): ModelConfigProviderData[] {
  const record = asRecord(value)
  const list = Array.isArray(record?.providers) ? record.providers : []
  const out: ModelConfigProviderData[] = []
  for (const item of list) {
    const prov = asRecord(item)
    if (!prov) continue
    const id = nonEmptyString(prov.id)
    if (!id) continue
    const rawModels = Array.isArray(prov.models) ? prov.models : []
    const models: ModelConfigModelData[] = []
    for (const rawM of rawModels) {
      const m = asRecord(rawM)
      if (!m) continue
      const mid = modelIdOf(m)
      if (!mid) continue
      const parsed: ModelConfigModelData = { id: mid }
      const mName = nonEmptyString(m.name)
      if (mName) parsed.name = mName
      const mApi = nonEmptyString(m.api)
      if (mApi) parsed.api = mApi
      const mBase = nonEmptyString(m.baseUrl)
      if (mBase) parsed.baseUrl = mBase
      if (typeof m.reasoning === "boolean") parsed.reasoning = m.reasoning
      if (Array.isArray(m.input)) parsed.input = m.input.filter((x): x is string => typeof x === "string")
      if (typeof m.contextWindow === "number" && Number.isFinite(m.contextWindow)) parsed.contextWindow = m.contextWindow
      if (typeof m.maxTokens === "number" && Number.isFinite(m.maxTokens)) parsed.maxTokens = m.maxTokens
      if (Array.isArray(m.headerKeys)) parsed.headerKeys = m.headerKeys.filter((x): x is string => typeof x === "string")
      models.push(parsed)
    }
    const cfg: ModelConfigProviderData = {
      id,
      inModelsJson: prov.inModelsJson === true,
      inAuthJson: prov.inAuthJson === true,
      hasApiKey: prov.hasApiKey === true,
      models,
    }
    const pName = nonEmptyString(prov.name)
    if (pName) cfg.name = pName
    const pBase = nonEmptyString(prov.baseUrl)
    if (pBase) cfg.baseUrl = pBase
    const pApi = nonEmptyString(prov.api)
    if (pApi) cfg.api = pApi
    if (typeof prov.authHeader === "boolean") cfg.authHeader = prov.authHeader
    if (Array.isArray(prov.headerKeys)) cfg.headerKeys = prov.headerKeys.filter((x): x is string => typeof x === "string")
    const source = nonEmptyString(prov.apiKeySource)
    if (source) cfg.apiKeySource = source
    const hint = nonEmptyString(prov.apiKeyHint)
    if (hint) cfg.apiKeyHint = hint
    out.push(cfg)
  }
  return out
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
  name?: string | null
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
    rows.push({
      provider,
      modelId,
      key: `${provider}/${modelId}`,
      name: nonEmptyString(model.name),
      baseUrl: nonEmptyString(model.baseUrl),
    })
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
  modelsConfigData?: unknown,
  enabledModels?: readonly string[] | null,
): ProviderRow[] {
  const authProviders = authProvidersOf(authData)
  const models = modelsOf(modelsData)
  const configProviders = modelsConfigOf(modelsConfigData)
  const available = availableKeysOf(modelsData)
  const authById = new Map(authProviders.map((provider) => [provider.id, provider]))
  const configById = new Map(configProviders.map((provider) => [provider.id, provider]))
  const enabledSet = Array.isArray(enabledModels) ? new Set(enabledModels) : null

  const ids: string[] = authProviders.map((provider) => provider.id)
  for (const model of models) {
    if (!ids.includes(model.provider)) ids.push(model.provider)
  }
  for (const cfg of configProviders) {
    if (!ids.includes(cfg.id)) ids.push(cfg.id)
  }

  return ids.map((id) => {
    const auth = authById.get(id) ?? null
    const config = configById.get(id) ?? null
    const ownFromAvailable = models.filter((model) => model.provider === id)
    const mergedModels: RawModel[] = [...ownFromAvailable]
    const seenModelIds = new Set(ownFromAvailable.map((m) => m.modelId))
    const customModelById = new Map<string, ModelConfigModelData>()
    if (config) {
      for (const cm of config.models) {
        customModelById.set(cm.id, cm)
        if (!seenModelIds.has(cm.id)) {
          seenModelIds.add(cm.id)
          mergedModels.push({
            provider: id,
            modelId: cm.id,
            key: `${id}/${cm.id}`,
            name: cm.name ?? null,
            baseUrl: cm.baseUrl ?? config.baseUrl ?? null,
          })
        }
      }
    }
    const configured = auth ? auth.configured : config ? config.hasApiKey : null
    const modelRows: ModelRow[] = mergedModels.map((model) => {
      const enabled = enabledSet
        ? enabledSet.has(model.key) || enabledSet.has(model.modelId)
        : available
          ? available.has(model.key)
          : true
      const customModel = customModelById.get(model.modelId)
      const displayName = model.name ?? customModel?.name ?? null
      const row: ModelRow = {
        key: model.key,
        provider: model.provider,
        modelId: model.modelId,
        label: model.modelId,
        ...(displayName ? { name: displayName } : {}),
        thinking: modelThinkingLevels[model.key] ?? null,
        enabled,
      }
      if (customModel) row.customModel = customModel
      return row
    })
    const row: ProviderRow = {
      id,
      name: auth?.name ?? config?.name ?? id,
      state: configured === null ? "unknown" : configured ? "connected" : "disconnected",
      endpoint: endpointLabelOf(mergedModels.find((model) => model.baseUrl)?.baseUrl ?? config?.baseUrl ?? null),
      configured,
      models: modelRows,
    }
    if (config) row.customConfig = config
    return row
  })
}

export function toggledEnabledModelsOf(
  providers: readonly ProviderRow[],
  configured: readonly string[] | null,
  targetKey: string,
  nextOn: boolean,
): string[] {
  const base = configured
    ? [...configured]
    : providers.flatMap((provider) => provider.models.filter((model) => model.enabled).map((model) => model.key))
  const slash = targetKey.indexOf("/")
  const modelIdOnly = slash > 0 ? targetKey.slice(slash + 1) : targetKey
  if (nextOn) {
    if (base.includes(targetKey)) return base
    return [...base, targetKey]
  }
  return base.filter((entry) => entry !== targetKey && entry !== modelIdOnly)
}

/** 未配置密钥的供应商少于这个数时不折叠（折叠只为压住 pi 内置目录的几十个空供应商）。 */
export const MODEL_PROVIDER_FOLD_MIN = 4

/**
 * 供应商卡的默认展示：unconfigured 判为未配置的收进一行「另有 N 个」，其余照常列出。
 * 一个可展示的都没有、或未配置的不多时不折叠，原样返回。
 */
export function providerFoldOf<T>(providers: readonly T[], unconfigured: (provider: T) => boolean): { primary: T[]; folded: T[] } {
  const primary = providers.filter((provider) => !unconfigured(provider))
  const folded = providers.filter(unconfigured)
  if (primary.length === 0 || folded.length < MODEL_PROVIDER_FOLD_MIN) return { primary: [...providers], folded: [] }
  return { primary, folded }
}

/** 供应商是否带有用户在 models.json 或 auth.json 中显式写入的配置。 */
export function hasUserProviderConfig(provider: ProviderRow): boolean {
  return Boolean(provider.customConfig?.inModelsJson || provider.customConfig?.inAuthJson)
}

/** 未被用户配置、仅来自内置目录的未认证供应商（无论数量多少都可折起，不淹没设置页）。 */
export function isBuiltInUnconfiguredProvider(provider: ProviderRow): boolean {
  if (hasUserProviderConfig(provider)) return false
  return (
    provider.state === "disconnected" ||
    (provider.state === "unknown" && provider.models.length > 0 && provider.models.every((model) => !model.enabled))
  )
}

/**
 * 模型页「供应商」分区展示拆分与排序：
 * - 已连接 / 用户显式配置的排在最前；
 * - 其余状态未知且已启用模型的供应商排在后面；
 * - 来自内置目录且未配置的供应商（>= MODEL_PROVIDER_FOLD_MIN）统一折进「另有 N 个未配置的供应商」，
 *   即便当前零配置（primary.length === 0）也不直接展开几十个内置空供应商。
 */
export function splitSettingsProviders(providers: readonly ProviderRow[]): { primary: ProviderRow[]; folded: ProviderRow[] } {
  const primaryRaw = providers.filter((provider) => !isBuiltInUnconfiguredProvider(provider))
  const folded = providers.filter(isBuiltInUnconfiguredProvider)
  const primary = [...primaryRaw].sort((a, b) => {
    const aPriority = a.state === "connected" || hasUserProviderConfig(a) ? 0 : 1
    const bPriority = b.state === "connected" || hasUserProviderConfig(b) ? 0 : 1
    return aPriority - bPriority
  })
  if (folded.length < MODEL_PROVIDER_FOLD_MIN) return { primary: [...primary, ...folded], folded: [] }
  return { primary, folded }
}

/** 默认模型下拉只收纳「已配置/可用」的供应商模型（未配置凭据或未启用的模型不进入默认模型清单）。 */
export function isProviderModelSelectable(provider: ProviderRow, model: ModelRow): boolean {
  return provider.configured !== false && model.enabled
}

function duplicateDisplayNamesOf(models: readonly { name?: string | null }[]): Set<string> {
  const counts = new Map<string, number>()
  for (const model of models) {
    const displayName = typeof model.name === "string" && model.name.trim() ? model.name.trim().toLowerCase() : ""
    if (!displayName) continue
    counts.set(displayName, (counts.get(displayName) ?? 0) + 1)
  }
  const dupes = new Set<string>()
  for (const [name, count] of counts) {
    if (count > 1) dupes.add(name)
  }
  return dupes
}

/** 默认模型下拉项标签：优先用人类可读的 name，重名时补充 `(modelId)` 消歧。 */
export function defaultModelOptionLabelOf(
  model: { modelId: string; label: string; name?: string | null },
  duplicateNames?: ReadonlySet<string>,
): string {
  const displayName = typeof model.name === "string" && model.name.trim() ? model.name.trim() : ""
  if (!displayName || displayName.toLowerCase() === model.modelId.toLowerCase()) {
    return model.label || model.modelId
  }
  if (duplicateNames?.has(displayName.toLowerCase())) {
    return `${displayName} (${model.modelId})`
  }
  return displayName
}

export interface DefaultModelChoice {
  key: string
  provider: string
  modelId: string
  label: string
}

/** 仅收集可选的已配置模型；若 settings.json 已存的默认模型不在其中，单独在首位保留这一条当前值。 */
export function configuredModelChoicesOf(
  providers: readonly ProviderRow[],
  defaultProvider: string | null,
  defaultModel: string | null,
): DefaultModelChoice[] {
  const choices: DefaultModelChoice[] = []
  const seen = new Set<string>()
  for (const provider of providers) {
    const selectable = provider.models.filter((model) => isProviderModelSelectable(provider, model))
    if (!selectable.length) continue
    const dupes = duplicateDisplayNamesOf(selectable)
    for (const model of selectable) {
      if (seen.has(model.key)) continue
      seen.add(model.key)
      choices.push({
        key: model.key,
        provider: model.provider,
        modelId: model.modelId,
        label: defaultModelOptionLabelOf(model, dupes),
      })
    }
  }
  const currentKey = defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : ""
  if (currentKey && !seen.has(currentKey)) {
    let matchedModel: ModelRow | null = null
    for (const provider of providers) {
      const hit = provider.models.find((model) => model.key === currentKey)
      if (hit) {
        matchedModel = hit
        break
      }
    }
    choices.unshift({
      key: currentKey,
      provider: defaultProvider!,
      modelId: defaultModel!,
      label: matchedModel ? defaultModelOptionLabelOf(matchedModel) : currentKey,
    })
  }
  return choices
}

export interface DefaultModelGroup {
  label: string
  options: { value: string; label: string }[]
}

/**
 * 默认模型下拉分组：只列已配置/可用的模型，按供应商分组并使用可读模型名；
 * 若当前已保存的 defaultProvider/defaultModel 不在可选清单内（例如已被删或尚未配置凭据），
 * 仅在最上方单独保留这一条已存值，避免丢选或把上千条未配置模型全倾倒进下拉框。
 */
export function defaultModelGroupsOf(providers: readonly ProviderRow[], currentKey: string): DefaultModelGroup[] {
  const groups: DefaultModelGroup[] = []
  const seen = new Set<string>()
  for (const provider of providers) {
    const selectable = provider.models.filter((model) => isProviderModelSelectable(provider, model))
    if (!selectable.length) continue
    const dupes = duplicateDisplayNamesOf(selectable)
    const options = selectable
      .filter((model) => !seen.has(model.key))
      .map((model) => {
        seen.add(model.key)
        return { value: model.key, label: defaultModelOptionLabelOf(model, dupes) }
      })
    if (!options.length) continue
    groups.push({ label: provider.name, options })
  }
  if (currentKey && !seen.has(currentKey)) {
    let matchedProvider: ProviderRow | null = null
    let matchedModel: ModelRow | null = null
    for (const provider of providers) {
      const hit = provider.models.find((model) => model.key === currentKey)
      if (hit) {
        matchedProvider = provider
        matchedModel = hit
        break
      }
    }
    const groupLabel = matchedProvider
      ? matchedProvider.configured === false
        ? `${matchedProvider.name}（当前已存 · 未配置凭据）`
        : matchedProvider.name
      : currentKey.split("/")[0] || currentKey
    groups.unshift({
      label: groupLabel,
      options: [{ value: currentKey, label: matchedModel ? defaultModelOptionLabelOf(matchedModel) : currentKey }],
    })
  }
  return groups
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
