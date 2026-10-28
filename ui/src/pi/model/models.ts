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
export function modelRowsOf(data: unknown, current: PiCurrentModel = {}): PiModelRow[] {
  const rec = isRecord(data) ? data : {}
  const models = Array.isArray(rec.models) ? rec.models : []
  const available = Array.isArray(rec.available) ? rec.available : []
  const list = models.length ? models : available
  const configured = new Set(
    available.flatMap((item) => (isRecord(item) && typeof item.provider === "string" && idOf(item) ? [`${item.provider}/${idOf(item)}`] : [])),
  )
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
    rows.push(row)
  }
  return [...rows.filter((r) => !r.unconfigured), ...rows.filter((r) => r.unconfigured)]
}

/** 未配置的模型超过这么多就折成一行（F-R4）；不超过照旧逐行列出（画廊 c/model-menu 只有 1 个未配置） */
export const PI_MODEL_MENU_UNCONFIGURED_MAX = 5
/**
 * 菜单里实际列出的行（F-R4）：真实 pi 的 models 是整份内置目录（1619 个，配了的只有几个），全列出来菜单伸出视口。
 * - 没有搜索词：未配置的不超过 PI_MODEL_MENU_UNCONFIGURED_MAX 个时照旧全列；超过时只列已配置的，未配置的折成一行
 *   「还有 N 个未配置的模型」（hiddenUnconfigured = N，由部件画）。
 * - 有搜索词：命中的全列，已配置的在前、命中的未配置模型接在后面（各自保持原顺序），不折。
 * matches 是部件的过滤（paletteMatches：名字 / 模型 id / provider）。
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
/** 折叠行的文字 */
export function hiddenUnconfiguredText(n: number): string {
  return `还有 ${n} 个未配置的模型`
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
  if (typeof contextWindow === "number" && contextWindow > 0) out.context = `上下文窗口 ${contextWindowLabel(contextWindow)}`
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
