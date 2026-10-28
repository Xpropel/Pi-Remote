/**
 *「使用活动」纯格式化/派生工具（无 React/无 Node，UI 三套共用；node --test 直接加载）。
 *
 * 口径约束（见 p10-usage-data-plan §1/设计说明 §9）：
 * - Token 用 K/M 缩写（86.4K / 12.6M），消息/会话用千分位整数；
 * - 环比箭头只在前一窗口有数据时显示（previous<=0 → 不显示，避免「↑∞%」）；
 * - 热力图分档按**分位数**切，不按线性（长尾使用量下线性会让图几乎全浅）。
 */

const ONE_K = 1000
const ONE_M = 1_000_000

const trimFixed = (value: number, digits: number): string => {
  const s = value.toFixed(digits)
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")
}

/** Token 数 → 展示串：<1000 原样整数；≥1000 K（1 位小数，去尾 0）；≥1e6 M；≥1e9 B（2 位小数，去尾 0）。负数按 0。 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens < ONE_K) return String(Math.round(tokens))
  if (tokens < ONE_M) return `${trimFixed(tokens / ONE_K, 1)}K`
  if (tokens < 1_000_000_000) return `${trimFixed(tokens / ONE_M, 1)}M`
  return `${trimFixed(tokens / 1_000_000_000, 2)}B`
}

/** 消息/会话数 → 千分位整数（3,214）。 */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return "0"
  return Math.round(count).toLocaleString("en-US")
}

/** 百分比展示：0.384 → "38%"。 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%"
  return `${Math.round(ratio * 100)}%`
}

export interface UsageDelta {
  /** 是否显示（前一窗口没有数据 → false，显示「数据积累中」） */
  show: boolean
  dir: "up" | "down" | "flat"
  /** 比例变化（0.38 = +38%）；previous<=0 时为 null */
  ratio: number | null
  /** 展示文案：↑38% / ↓12% / — */
  text: string
}

/** 环比（近 30 天 vs 前 30 天）；previous<=0 时 show=false。 */
export function usageDeltaOf(current: number, previous: number): UsageDelta {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return { show: false, dir: "flat", ratio: null, text: "数据积累中" }
  const ratio = (current - previous) / previous
  if (Math.abs(ratio) < 0.005) return { show: true, dir: "flat", ratio: 0, text: "—" }
  const dir = ratio > 0 ? "up" : "down"
  return { show: true, dir, ratio, text: `${dir === "up" ? "↑" : "↓"}${Math.round(Math.abs(ratio) * 100)}%` }
}

const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const pad2 = (value: number): string => String(value).padStart(2, "0")
const offsetMinutesOf = (snapshot: { timezone?: { offsetMinutes?: number } | null } | null | undefined): number => {
  const offset = snapshot?.timezone?.offsetMinutes
  return typeof offset === "number" && Number.isFinite(offset) ? Math.trunc(offset) : 0
}

/**
 * 合法日键（UI·usage 低危 25）：`YYYY-MM-DD` **且日历真实存在**。
 *
 * 不能用 `Date.parse("2026-02-31T00:00:00Z")` 判合法——V8 会把它归一化成 2026-03-03，
 * 于是 2 月 31 日通过校验，后续热力图/差值/星期计算整体错位。这里用 UTC 回读比对。
 */
export function isValidDayKey(value: unknown): value is string {
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

/** 本地日键（浏览器/设备时区）：2026-10-27。 */
export function localDayKey(timestampMs: number): string {
  const d = new Date(timestampMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** 日键加减（用 UTC 算术避免 DST 影响）；返回 YYYY-MM-DD。非法日键原样返回，不静默归一化。 */
export function addDaysToDayKey(dayKey: string, delta: number): string {
  if (!isValidDayKey(dayKey)) return dayKey
  const [y, m, d] = dayKey.split("-").map(Number)
  const base = Date.UTC(y, m - 1, d)
  const next = new Date(base + Math.trunc(delta) * 86_400_000)
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`
}

/** 两个日键相差天数（to - from）；任一非法返回 NaN（与旧实现对畸形字符串的口径一致）。 */
export function dayKeyDiff(from: string, to: string): number {
  if (!isValidDayKey(from) || !isValidDayKey(to)) return Number.NaN
  const parse = (key: string): number => {
    const [y, m, d] = key.split("-").map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((parse(to) - parse(from)) / 86_400_000)
}

/** 星期几（0=周日 … 6=周六；与热力图列对齐）；非法日键返回 NaN。 */
export function weekdayOfDayKey(dayKey: string): number {
  if (!isValidDayKey(dayKey)) return Number.NaN
  const [y, m, d] = dayKey.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** 今天（本地日键）。 */
export function todayDayKey(now = Date.now()): string {
  return localDayKey(now)
}

/**
 * 设备时区自然日键：按快照自带的 UTC 偏移换算（不是查看端浏览器时区）。
 * 例：UTC 2026-10-28T02:00Z + 纽约 -300 → 2026-10-27；+ 上海 480 → 2026-10-28。
 */
export function dayKeyInOffset(timestampMs: number, offsetMinutes: number): string {
  const ts = Number.isFinite(timestampMs) ? timestampMs : 0
  const offset = Number.isFinite(offsetMinutes) ? Math.trunc(offsetMinutes) : 0
  const d = new Date(ts + offset * 60_000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** 「今天」锚点所需的最小快照面（结构类型，不依赖 usage 契约完整形状）。 */
export interface UsageTodayAnchor {
  generatedAt?: number
  timezone?: { offsetMinutes?: number } | null
  range?: { lastDay?: string | null } | null
  days?: readonly { date: string }[]
}

/**
 * 「使用活动」页面「今天」的设备口径锚点（UI·usage 中-1）：
 * 用**快照生成时间 + 设备时区偏移**换算，而不是查看端浏览器本地时区——两端时区不同时
 * 近 30 天窗口/热力图/周柱都以设备自然日为准。生成时间不可用时退到快照范围最后一天，
 * 再不行才退回查看端本地今天（空态快照）。
 */
export function usageTodayDayKey(snapshot: UsageTodayAnchor | null | undefined, now = Date.now()): string {
  const offset = offsetMinutesOf(snapshot)
  const lastDay = snapshot?.range?.lastDay
  const lastKnownDay = isValidDayKey(lastDay) ? lastDay : null
  const generatedAt = snapshot?.generatedAt
  if (typeof generatedAt === "number" && Number.isFinite(generatedAt) && generatedAt > 0) {
    const generatedDay = dayKeyInOffset(generatedAt, offset)
    // 生成时间与设备时区换算出的日子早于范围末日（时钟/时区异常）时，以末日为锚，别把已有数据挡在今天之后。
    return lastKnownDay && lastKnownDay > generatedDay ? lastKnownDay : generatedDay
  }
  if (lastKnownDay) return lastKnownDay
  const last = snapshot?.days?.[snapshot.days.length - 1]?.date
  if (isValidDayKey(last)) return last
  return todayDayKey(now)
}

/** 快照生成时刻（设备本地时区）：2026-10-27 12:00；generatedAt 不可用时 null。 */
export function snapshotMomentLabel(snapshot: { generatedAt?: number; timezone?: { offsetMinutes?: number } | null } | null | undefined): string | null {
  const generatedAt = snapshot?.generatedAt
  if (typeof generatedAt !== "number" || !Number.isFinite(generatedAt) || generatedAt <= 0) return null
  const d = new Date(generatedAt + offsetMinutesOf(snapshot) * 60_000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

/** 覆盖/新鲜度文案所需的最小快照面（结构类型，不依赖契约完整形状）。 */
export interface UsageCoverageAnchor {
  generatedAt?: number
  timezone?: { offsetMinutes?: number } | null
  range?: { firstDay?: string | null; lastDay?: string | null; days?: number } | null
  days?: readonly { date?: string }[]
  coverage?: { skippedFiles?: number; truncated?: boolean; errors?: number } | null
}

/**
 * 页面可见的「数据覆盖范围 / 快照时间 / 是否为下限」一行（UI·usage 低危 23）：
 * - 覆盖范围：range.firstDay ~ range.lastDay（缺失时退到 days 首尾）；
 * - 快照时间：generatedAt 按设备时区偏移换算（不是查看端时区）；
 * - 截断/跳过/解析失败 → 明说「数字可能只是下限」，避免把覆盖不足的数字当全集；
 * - 范围末日晚于设备今天（未来日期混入，UI·usage 低危 26）→ 明说「统计可能偏高」。
 */
export function usageCoverageText(snapshot: UsageCoverageAnchor | null | undefined): string | null {
  const first = snapshot?.range?.firstDay
  const last = snapshot?.range?.lastDay
  const days = snapshot?.days ?? []
  const start = isValidDayKey(first) ? first : isValidDayKey(days[0]?.date) ? days[0].date : null
  const end = isValidDayKey(last) ? last : isValidDayKey(days[days.length - 1]?.date) ? days[days.length - 1].date : null
  const rangeDays = snapshot?.range?.days
  const count = typeof rangeDays === "number" && Number.isInteger(rangeDays) && rangeDays >= 0 ? rangeDays : days.length
  const parts: string[] = []
  if (start && end && start <= end) parts.push(`数据覆盖 ${start} ~ ${end}（${count} 天有记录）`)
  const moment = snapshotMomentLabel(snapshot)
  if (moment) parts.push(`快照 ${moment}（设备时间）`)
  const truncated = snapshot?.coverage?.truncated === true
  const skipped = Math.max(0, Math.trunc(Number(snapshot?.coverage?.skippedFiles) || 0))
  const errors = Math.max(0, Math.trunc(Number(snapshot?.coverage?.errors) || 0))
  if (truncated || skipped > 0) {
    const reason = truncated && skipped > 0 ? "扫描已截断且跳过部分文件" : truncated ? "扫描已截断" : `跳过 ${skipped} 个文件`
    parts.push(`${reason}，数字可能只是下限`)
  } else if (errors > 0) parts.push(`${errors} 条记录解析失败，数字可能只是下限`)
  const generatedAt = snapshot?.generatedAt
  if (end && typeof generatedAt === "number" && Number.isFinite(generatedAt) && generatedAt > 0) {
    const deviceToday = dayKeyInOffset(generatedAt, offsetMinutesOf(snapshot))
    if (end > deviceToday) parts.push("数据含晚于设备今天的日期，统计可能偏高")
  }
  return parts.length ? parts.join(" · ") : null
}

export type HeatLevel = 0 | 1 | 2 | 3 | 4

export interface HeatmapScale {
  /** 正数分位阈值（长度 = levels-1），用于 bucketOf；0 值固定 level 0 */
  thresholds: number[]
  levels: number
  /** 值 → 0..levels-1（0 值 → 0） */
  bucketOf(value: number): HeatLevel
}

/**
 * 热力图分档（默认 5 档：0 = 空白 + 4 档紫色，对齐设计稿「少 → 多」）。
 * 按正数分位数切（q = i/levels），长尾分布下也能分出色阶；values 为空/全 0 时正数都落 0。
 */
export function heatmapScaleOf(values: readonly number[], levels = 5): HeatmapScale {
  const safe = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b)
  const bucketCount = Math.max(2, Math.trunc(levels))
  // 用**去重后的值**取分位阈值：使用量长尾且大量并列值（如一堆 1）时，按全量分位会把阈值挤成同一个数，
  // 导致高值也只能落到低档。去重后 1 / 100 / 10000 能切成 3 条阈值，色阶真正拉开。
  const unique = safe.filter((v, i) => i === 0 || v !== safe[i - 1])
  const thresholds: number[] = []
  for (let i = 1; i < bucketCount; i++) {
    if (!unique.length) break
    const idx = Math.min(unique.length - 1, Math.floor((i / bucketCount) * unique.length))
    const threshold = unique[idx]
    if (threshold > 0 && (thresholds.length === 0 || threshold > thresholds[thresholds.length - 1])) thresholds.push(threshold)
  }
  const bucketOf = (value: number): HeatLevel => {
    if (!Number.isFinite(value) || value <= 0) return 0
    if (!thresholds.length) return 1 as HeatLevel
    let bucket = 1
    for (const t of thresholds) if (value >= t) bucket += 1
    return Math.min(bucketCount - 1, bucket) as HeatLevel
  }
  return { thresholds, levels: bucketCount, bucketOf }
}

/** 热力图日期窗口：从 start 到 end 的连续日键（含两端）。 */
export function dayKeyRange(start: string, end: string): string[] {
  const out: string[] = []
  const total = dayKeyDiff(start, end)
  if (total < 0) return out
  for (let i = 0; i <= total; i++) out.push(addDaysToDayKey(start, i))
  return out
}

/* ---- R10 组件用便捷别名/辅助（与上方契约函数同源，勿另实现逻辑） ---- */

/** formatTokenCount 的别名（组件历史命名）。 */
export const formatTokens = formatTokenCount

/** 环比展示文本：前窗无数据返回 null（表示「数据积累中」）。 */
export function deltaText(current: number, previous: number | null | undefined): string | null {
  if (previous == null || previous <= 0) return null
  const pct = Math.round(((current - previous) / previous) * 100)
  if (!Number.isFinite(pct)) return null
  return `${pct >= 0 ? "↑" : "↓"}${Math.abs(pct)}% 较前 30 天`
}

/** Date → 本地日键（组件入口便捷版）。 */
export function dayKey(date: Date): string {
  return localDayKey(date.getTime())
}

export function dateLabel(key: string): string {
  if (!isValidDayKey(key)) return key
  const [, m, d] = key.split("-").map(Number)
  return `${m}月${d}日`
}

export function weekdayLabel(key: string): string {
  const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
  const index = weekdayOfDayKey(key)
  return Number.isInteger(index) ? names[index] : ""
}

/** 分位数阈值（4 个阈值 → level 0..4；长尾下仍能分出色阶）。 */
export function quantileLevels(values: readonly number[]): number[] {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0).slice().sort((a, b) => a - b)
  if (positive.length === 0) return [0, 0, 0, 0]
  const q = (p: number) => positive[Math.min(positive.length - 1, Math.max(0, Math.floor((positive.length - 1) * p)))]
  return [q(0.25), q(0.5), q(0.75), q(0.9)]
}

export function levelOf(value: number, thresholds: readonly number[]): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value <= thresholds[0]) return 1
  if (value <= thresholds[1]) return 2
  if (value <= thresholds[2]) return 3
  return 4
}
