/**
 * 模型菜单与思考级别（plan §7.3 model-menu、P5.5 c 线；取数口径照 chat/dialogs.tsx 的 ModelDialog / ThinkingDialog，HEAD 版）。
 * 纯函数，node --test 直接加载。数据来自 get_available_models / get_available_thinking_levels 的回包，缺字段就不写（design §1.9）。
 * 费用说明（G12）用 costNoteOf，旧版 pi 没有 tiers 时不出现。
 */
import { costNoteOf } from "./costNote.ts"

/** 菜单的一行（形状同 components/pi/composer 的 CModel） */
export type PiModelRow = {
  key: string
  provider: string
  modelId: string
  name: string
  /** 规格："200k · 可发图片" / "128k"；回包没有窗口和输入类型时为 "" */
  spec: string
  current?: boolean
  /** provider 没配置（在 models 里、不在 available 里）：灰字"未配置"，不可选 */
  unconfigured?: boolean
  /** 输入分档的费用说明（G12）："输入超过 200k 时单价翻倍" */
  costNote?: string
  /** Context window in tokens, when the reply carries it (redesign: variant grouping and the facts line) */
  contextWindow?: number
  /** Thinking levels this model supports, when the bridge reply carries them per model (redesign section 2.3) */
  thinkingLevels?: string[]
  /** Whether the model supports thinking at all, when the catalog says so; absent means unknown */
  reasoning?: boolean
  /** Whether the model accepts image input, when the reply carries the input list */
  supportsImage?: boolean
}

/** 当前模型：useRelay 的 model（模型 id 或名字）+ modelMeta（provider / modelId / name） */
export type PiCurrentModel = { model?: string | null; modelMeta?: { provider?: string; modelId?: string; name?: string } | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** 窗口 token 数的短写："200k"、"1M"、"1.05M"、"128k" */
export function contextWindowLabel(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round((n / 1000) * 10) / 10}k`
  return `${Math.round((n / 1_000_000) * 100) / 100}M`
}

function specOf(item: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof item.contextWindow === "number" && Number.isFinite(item.contextWindow) && item.contextWindow > 0) parts.push(contextWindowLabel(item.contextWindow))
  if (Array.isArray(item.input) && item.input.includes("image")) parts.push("可发图片")
  return parts.join(" · ")
}

function idOf(item: Record<string, unknown>): string {
  return typeof item.modelId === "string" ? item.modelId : typeof item.id === "string" ? item.id : ""
}

function isCurrent(provider: string, modelId: string, name: string, current: PiCurrentModel): boolean {
  const meta = current.modelMeta ?? {}
  if (meta.provider && meta.modelId) return meta.provider === provider && meta.modelId === modelId
  const label = (current.model ?? "").trim()
  return !!label && (label === name || label === modelId || label === `${provider}/${modelId}`)
}

/**
 * get_available_models 回包 → 菜单行。回包是 `{ models: 全部, available: 已配置 }`（chat/dialogs.tsx 的读法）：
 * 列出全部 models（顺序照回包），available 非空时不在其中的标"未配置"；只有一张表时按那张表列、不标。
 * 已配置的排在前面、未配置的接在后面（各自保持回包顺序）：真实 pi 1.3 的 models 是整份内置目录（一千多个），
 * 用户配了的那几个按回包顺序排在最末，要滚过上千行灰字才看得到当前模型（lane-real F-R3；design model-menu 的 mock 也是未配置在后）。
 */
/** Per-model thinking levels from a reply item; absent or malformed means the field is not carried */
function thinkingLevelsOf(item: Record<string, unknown>): string[] | undefined {
  if (!Array.isArray(item.thinkingLevels)) return undefined
  const levels = item.thinkingLevels.filter((level): level is string => typeof level === "string" && level.length > 0)
  return levels.length ? [...new Set(levels)] : undefined
}

export function modelRowsOf(data: unknown, current: PiCurrentModel = {}): PiModelRow[] {
  const rec = isRecord(data) ? data : {}
  const models = Array.isArray(rec.models) ? rec.models : []
  const available = Array.isArray(rec.available) ? rec.available : []
  const list = models.length ? models : available
  const configured = new Set(
    available.flatMap((item) => (isRecord(item) && typeof item.provider === "string" && idOf(item) ? [`${item.provider}/${idOf(item)}`] : [])),
  )
  // Per-model thinking levels live on the available entries; when the menu lists the full
  // catalog (models), borrow the levels from the configured twin of the same model.
  const availableByKey = new Map<string, Record<string, unknown>>()
  for (const item of available) {
    if (!isRecord(item) || typeof item.provider !== "string") continue
    const modelId = idOf(item)
    if (modelId) availableByKey.set(`${item.provider}/${modelId}`, item)
  }
  const rows: PiModelRow[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!isRecord(item) || typeof item.provider !== "string") continue
    const modelId = idOf(item)
    if (!modelId) continue
    const key = `${item.provider}/${modelId}`
    if (seen.has(key)) continue
    seen.add(key)
    const name = String(item.name || modelId)
    const row: PiModelRow = { key, provider: item.provider, modelId, name, spec: specOf(item) }
    if (isCurrent(item.provider, modelId, name, current)) row.current = true
    if (models.length && available.length && !configured.has(key)) row.unconfigured = true
    const note = costNoteOf(item.cost)
    if (note) row.costNote = note
    if (typeof item.contextWindow === "number" && Number.isFinite(item.contextWindow) && item.contextWindow > 0) row.contextWindow = item.contextWindow
    const levels = thinkingLevelsOf(item) ?? (availableByKey.has(key) ? thinkingLevelsOf(availableByKey.get(key)!) : undefined)
    if (levels) row.thinkingLevels = levels
    if (typeof item.reasoning === "boolean") row.reasoning = item.reasoning
    if (Array.isArray(item.input)) row.supportsImage = item.input.includes("image")
    rows.push(row)
  }
  return [...rows.filter((r) => !r.unconfigured), ...rows.filter((r) => r.unconfigured)]
}

/**
 * The device default model from a get_available_models reply (redesign section 2.5):
 * the bridge may carry `defaultModel: { provider, id }` (models.json defaultProvider /
 * defaultModel). Returns null when the field is missing or malformed -- callers must
 * hide the Auto row then, never guess a default. The display name is resolved from the
 * reply's own model entries when one matches, and falls back to the model id.
 */
export function modelDefaultOf(data: unknown): { provider: string; modelId: string; key: string; name: string } | null {
  const rec = isRecord(data) ? data : {}
  const raw = isRecord(rec.defaultModel) ? rec.defaultModel : null
  if (!raw || typeof raw.provider !== "string" || !raw.provider) return null
  const modelId = idOf(raw)
  if (!modelId) return null
  const key = `${raw.provider}/${modelId}`
  let name = modelId
  for (const list of [rec.available, rec.models]) {
    if (!Array.isArray(list)) continue
    const hit = list.find((item) => isRecord(item) && item.provider === raw.provider && idOf(item) === modelId)
    if (hit && typeof hit.name === "string" && hit.name) {
      name = hit.name
      break
    }
  }
  return { provider: raw.provider, modelId, key, name }
}

/** One rendered entry of the redesigned model menu (redesign section 2.2) */
export interface PiModelMenuEntry<T> {
  /** Stable entry key: the representative row's key */
  key: string
  /** The row the list renders for this entry */
  representative: T
  /** One row per distinct context window, ascending by size; longer than 1 only for a real variant group */
  variants: T[]
  /** True when this entry folds two or more distinct context windows of one (provider, name) group */
  hasContextVariants: boolean
}

type ModelEntryRow = { key: string; provider?: string; name: string; contextWindow?: number; current?: boolean }

/**
 * Fold model rows into menu entries (redesign section 2.2, viewer-side only):
 * rows sharing (provider, name) with two or more distinct context windows collapse
 * into one entry whose representative is the current row when one is in the group,
 * else the first row; the entry's variants hold one row per distinct window size.
 * Rows without a context window, duplicate rows of an already-kept window size, and
 * groups with a single window size all stay individual entries -- nothing is merged
 * on a guess. Entry order follows the first member row's position.
 */
export function modelMenuEntriesOf<T extends ModelEntryRow>(rows: readonly T[]): PiModelMenuEntry<T>[] {
  const buckets = new Map<string, { firstIndex: number; rows: T[] }>()
  rows.forEach((row, index) => {
    const bucketKey = `${row.provider ?? ""}\n${row.name}`
    const bucket = buckets.get(bucketKey)
    if (bucket) bucket.rows.push(row)
    else buckets.set(bucketKey, { firstIndex: index, rows: [row] })
  })
  const placed: { index: number; entry: PiModelMenuEntry<T> }[] = []
  const indexOfRow = new Map<T, number>()
  rows.forEach((row, index) => indexOfRow.set(row, index))
  for (const bucket of buckets.values()) {
    const windows = [...new Set(bucket.rows.map((row) => row.contextWindow).filter((w): w is number => typeof w === "number" && w > 0))].sort((a, b) => a - b)
    if (windows.length >= 2) {
      const variants = windows.map((windowSize) => {
        const candidates = bucket.rows.filter((row) => row.contextWindow === windowSize)
        return candidates.find((row) => row.current) ?? candidates[0]
      })
      const representative = variants.find((row) => row.current) ?? variants[0]
      placed.push({ index: bucket.firstIndex, entry: { key: representative.key, representative, variants, hasContextVariants: true } })
      const folded = new Set(variants)
      for (const row of bucket.rows) {
        if (!folded.has(row)) placed.push({ index: indexOfRow.get(row) ?? bucket.firstIndex, entry: { key: row.key, representative: row, variants: [row], hasContextVariants: false } })
      }
    } else {
      for (const row of bucket.rows) placed.push({ index: indexOfRow.get(row) ?? bucket.firstIndex, entry: { key: row.key, representative: row, variants: [row], hasContextVariants: false } })
    }
  }
  return placed.sort((a, b) => a.index - b.index).map((placedEntry) => placedEntry.entry)
}

/** Thinking options for one model's parameter panel: raw level values mapped to Chinese labels, deduplicated */
export function modelThinkingOptionsOf(levels: readonly string[] | undefined): { value: string; label: string }[] {
  if (!levels) return []
  const out: { value: string; label: string }[] = []
  for (const level of levels) {
    if (level && !out.some((option) => option.value === level)) out.push({ value: level, label: thinkingLevelZh(level) })
  }
  return out
}

/**
 * The facts line for the intro card and the phone parameter page (redesign section 2.4):
 * only facts the data carries -- context size, image input, thinking support -- joined
 * with " · ". Rows that predate the per-model fields fall back to their spec string.
 */
export function modelFactsLineOf(row: { contextWindow?: number; supportsImage?: boolean; reasoning?: boolean; spec?: string }): string {
  const parts: string[] = []
  if (typeof row.contextWindow === "number" && row.contextWindow > 0) parts.push(`上下文 ${contextWindowLabel(row.contextWindow)}`)
  if (row.supportsImage) parts.push("支持图片输入")
  if (row.reasoning) parts.push("支持思考")
  if (parts.length) return parts.join(" · ")
  return row.spec ?? ""
}

/** Unconfigured models beyond this count are folded out of the menu
 *  (F-R4); at or below it they are listed row by row as before. */
export const PI_MODEL_MENU_UNCONFIGURED_MAX = 5
/**
 * The rows the model menu actually lists (F-R4): a real pi model list is
 * the whole built-in catalog (1619 entries, only a few configured), and
 * listing all of them pushes the menu off screen.
 * - No search query: unconfigured rows up to PI_MODEL_MENU_UNCONFIGURED_MAX
 *   are listed as-is; past that only configured rows are listed and the
 *   rest are folded away (hiddenUnconfigured reports how many, for tests
 *   and diagnostics -- the menu itself renders no count line; the full
 *   catalog lives on the settings page).
 * - With a search query: every hit is listed, configured first, then the
 *   unconfigured hits (each in its original order); nothing is folded.
 * matches is the component's filter (paletteMatches: name / model id /
 * provider).
 */
export function modelMenuListOf<T extends { unconfigured?: boolean }>(
  rows: readonly T[],
  query: string,
  matches: (row: T) => boolean,
): { list: T[]; hiddenUnconfigured: number } {
  if (query.trim()) {
    const hit = rows.filter(matches)
    return { list: [...hit.filter((r) => !r.unconfigured), ...hit.filter((r) => r.unconfigured)], hiddenUnconfigured: 0 }
  }
  const unconfigured = rows.filter((r) => r.unconfigured).length
  if (unconfigured <= PI_MODEL_MENU_UNCONFIGURED_MAX) return { list: [...rows], hiddenUnconfigured: 0 }
  return { list: rows.filter((r) => !r.unconfigured), hiddenUnconfigured: unconfigured }
}
/** 思考级别的中文标签（design c/model-menu：关 / 最少 / 低 / 中 / 高）；不认识的档位原样显示，不猜 */
const THINKING_LABEL: Record<string, string> = {
  off: "关",
  minimal: "最少",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最高",
}

export function thinkingLevelZh(level: string): string {
  return THINKING_LABEL[level.trim().toLowerCase()] ?? level
}

/** get_available_thinking_levels 回包（{ levels: string[] } 或 {id|name|level}[]）→ 分段控件的档位 */
export function thinkingSegmentsOf(data: unknown): { value: string; label: string }[] {
  if (!isRecord(data) || !Array.isArray(data.levels)) return []
  const out: { value: string; label: string }[] = []
  for (const item of data.levels) {
    const value = typeof item === "string" ? item : isRecord(item) ? String(item.id || item.name || item.level || "") : ""
    if (value && !out.some((x) => x.value === value)) out.push({ value, label: thinkingLevelZh(value) })
  }
  return out
}

/** composer 里模型选择器的名字：去掉"Claude "前缀（design：Sonnet 4.5）；没有模型时 null */
export function modelPillName(current: PiCurrentModel): string | null {
  const name = (current.modelMeta?.name || current.modelMeta?.modelId || current.model || "").trim()
  if (!name) return null
  return name.replace(/^Claude\s+/i, "")
}

/**
 * 桌面模型说明卡（ch4/ModelExplainerCard）的数据：标题、窗口、费用说明（两行）、provider/modelId。
 * 介绍一行（tagline）pi 没有来源，留空（§1.9）。费用说明拆在"时"后面成两行；没有说明就不出费用段。
 */
export function modelExplainerOf(row: PiModelRow, contextWindow?: number | null): { title: string; tagline: string[]; context?: string; cost?: string[]; version: string[] } {
  const out: { title: string; tagline: string[]; context?: string; cost?: string[]; version: string[] } = { title: row.name, tagline: [], version: [row.key] }
  // Facts only (redesign section 2.4): window size plus the capabilities the row
  // actually carries; fields the data does not carry add nothing.
  const facts: string[] = []
  if (typeof contextWindow === "number" && contextWindow > 0) facts.push(`上下文窗口 ${contextWindowLabel(contextWindow)}`)
  if (row.supportsImage) facts.push("支持图片输入")
  if (row.reasoning) facts.push("支持思考")
  if (facts.length) out.context = facts.join(" · ")
  if (row.costNote) {
    const i = row.costNote.indexOf("时")
    out.cost = i > 0 && i < row.costNote.length - 1 ? [row.costNote.slice(0, i + 1), row.costNote.slice(i + 1)] : [row.costNote]
  }
  return out
}

/** 回包里某个模型的窗口（说明卡用）；没有就是 null */
export function modelContextWindowOf(data: unknown, key: string): number | null {
  const rec = isRecord(data) ? data : {}
  const list = [...(Array.isArray(rec.models) ? rec.models : []), ...(Array.isArray(rec.available) ? rec.available : [])]
  for (const item of list) {
    if (!isRecord(item) || typeof item.provider !== "string") continue
    if (`${item.provider}/${idOf(item)}` === key && typeof item.contextWindow === "number") return item.contextWindow
  }
  return null
}
