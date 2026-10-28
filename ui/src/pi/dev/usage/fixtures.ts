/**
 * P10.3「使用活动」dev-only fixture 注册表 + 断言元信息（**dev-only**，不生产）。
 *
 * - `PI_UI_USAGE_FIXTURES`：五组确定性 `UsageSnapshotV1` 快照
 *   （`design` 设计对图样张（非自洽）/ `realistic` 自洽数据 / `short` 12 天少数据 / `empty` 0 会话 / `longtail` 极端长尾回归），
 *   三套 UI 的 dev 预览、gallery `?usage=` 与 e2e 都从这里取数；生产 UI 走真实 relay 快照，不 import 本文件。
 * - `PI_UI_USAGE_STATES`：页面**非快照状态**（`error` 拉取失败 / `unavailable` 能力不可用五 reason），
 *   与 `UsageSnapshotFrame.available=false` 帧语义一致，供 UI 13/14 态与 e2e 使用。
 * - `PI_UI_USAGE_FIXTURE_META`：从快照**派生**的展示期望值（用 arch `format.ts` 共享实现，不另造格式化）。
 * - 静态 JSON 快照由 `开发工具（未随公开仓提供）` 生成到
 *   `.agents/tasks/pi-ui-refs-2026-10-26/usage-fixtures/`；**正式代码不 import 这些 JSON**（单测扫描约束）。
 *
 * 设计样张（hybrid.html）的数字并非全部自洽，用户裁决「两者都要」：
 * - `design`：严格保留设计稿数字（12.6M / 3,214 / 24·30 / 9·6 / 峰值 214K(10-19) / 10-22 412·17 / 68·24·8），
 *   峰值靠 summary 显式覆盖；但「↑38%」与「全年 18.9M·10 月 67%」**无法由同一份日数据同时成立**
 *   （前 30 天要 9.1M 才能 ↑38%，全年就 ≥21.7M）——对图以 18.9M/67% 为准，Token 环比显示 ↑180%，README 已注明。
 * - `realistic`：**自洽**数据（e2e/数据正确性抽检用）：峰值 = 日数据真实最大 1.3M、环比 ↑180%、全年 18.9M。
 */
import {
  dayKeyRange,
  formatCount,
  formatPercent,
  formatTokenCount,
  heatmapScaleOf,
  usageDeltaOf,
  weekdayOfDayKey,
} from "../../usage/format.ts"
import { validateUsageSnapshot } from "../../usage/validate.ts"
import type { UsageModelSlice, UsageSnapshotV1, UsageUnavailableReason } from "../../usage/types.ts"
import type { PiUiUsageFixtureId } from "./generate.ts"
import {
  PI_UI_USAGE_MOCK_DEVICE_ID,
  PI_UI_USAGE_MOCK_GENERATED_AT,
  PI_UI_USAGE_MOCK_TIMEZONE,
  PI_UI_USAGE_MOCK_TODAY,
  PI_UI_USAGE_MOCK_YEAR_START,
  piUiUsageFixtureOf,
  piUiUsageFixtures,
  piUiUsageLast30Of,
  piUiUsageModelDisplayRows,
  piUiUsageMonthTokensOf,
  piUiUsagePrev30Of,
  piUiUsageYearTokensOf,
} from "./generate.ts"

export {
  PI_UI_USAGE_MOCK_DEVICE_ID,
  PI_UI_USAGE_MOCK_GENERATED_AT,
  PI_UI_USAGE_MOCK_TODAY,
  PI_UI_USAGE_MOCK_TIMEZONE,
  PI_UI_USAGE_MOCK_YEAR_START,
  piUiUsageFixtureOf,
  piUiUsageLast30Of,
  piUiUsageModelDisplayRows,
  piUiUsageMonthTokensOf,
  piUiUsagePrev30Of,
  piUiUsageYearTokensOf,
  type PiUiUsageFixtureId,
}

/** 快照类 fixture（页面正常渲染的三种数据态 + 长尾回归） */
export const PI_UI_USAGE_FIXTURE_IDS = ["design", "realistic", "short", "empty", "longtail"] as const satisfies readonly PiUiUsageFixtureId[]

/** 非快照状态（UI P10-USAGE-13/14；对应 usage_snapshot.available=false） */
export const PI_UI_USAGE_STATE_IDS = ["error", "unavailable"] as const
export type PiUiUsageStateId = (typeof PI_UI_USAGE_STATE_IDS)[number]

/** 快照不可用 reason 全集（`UsageUnavailableReason`，顺序与 spec §5.2 一致） */
export const PI_UI_USAGE_UNAVAILABLE_REASONS: readonly UsageUnavailableReason[] = ["no_data", "device_offline", "unsupported", "timeout", "stale"] as const

export interface PiUiUsageErrorState {
  kind: "error"
  id: "error"
  /** UI 错误文案（P10-USAGE-13 重试态）；dev mock 不自动重试，e2e 用 refresh 断言 */
  message: string
  retryable: true
}

export interface PiUiUsageUnavailableState {
  kind: "unavailable"
  id: "unavailable"
  /** available=false 的 reason（五态；UI 文案映射见 spec §3.13/§3.14） */
  reason: UsageUnavailableReason
  /** 设备没有声明 `usage.activity.v1` cap（reason=unsupported 时为 true） */
  capabilityMissing: boolean
}

export interface PiUiUsageStates {
  error: PiUiUsageErrorState
  /** 五 reason 各一（gallery `?usage=unavailable&reason=...` 可切） */
  unavailable: Record<UsageUnavailableReason, PiUiUsageUnavailableState>
}

/** 四组确定性快照（模块加载时构建一次；纯函数、无副作用） */
export const PI_UI_USAGE_FIXTURES: Record<PiUiUsageFixtureId, UsageSnapshotV1> = piUiUsageFixtures()

/** 页面状态 fixture（error / unavailable 五 reason；不含快照） */
export const PI_UI_USAGE_STATES: PiUiUsageStates = {
  error: { kind: "error", id: "error", message: "使用活动数据拉取失败", retryable: true },
  unavailable: {
    no_data: { kind: "unavailable", id: "unavailable", reason: "no_data", capabilityMissing: false },
    device_offline: { kind: "unavailable", id: "unavailable", reason: "device_offline", capabilityMissing: false },
    unsupported: { kind: "unavailable", id: "unavailable", reason: "unsupported", capabilityMissing: true },
    timeout: { kind: "unavailable", id: "unavailable", reason: "timeout", capabilityMissing: false },
    stale: { kind: "unavailable", id: "unavailable", reason: "stale", capabilityMissing: false },
  },
}

const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const

/** 本地日键 → 「10月22日 · 周四」 */
export function formatUsageDayLabel(date: string): string {
  const [, month, day] = date.split("-").map(Number)
  return `${month}月${day}日 · ${WEEKDAY_LABELS[weekdayOfDayKey(date)]}`
}

export interface PiUiUsageModelDisplayExpectation {
  label: string
  provider: string
  model: string
  tokens: number
  pctText: string
  other: boolean
}

export interface PiUiUsageFixtureMeta {
  id: PiUiUsageFixtureId
  label: string
  note: string
  /** 契约校验（必须 ok；测试直接断言） */
  valid: boolean
  validationErrors: string[]
  range: { firstDay: string | null; lastDay: string | null; days: number }
  last30: { tokens: number; messagesUser: number; sessions: number; activeDays: number }
  prev30: { tokens: number; messagesUser: number; sessions: number; activeDays: number } | null
  /** 展示串（与 UI 共用 format.ts） */
  display: {
    tokens: string
    messagesUser: string
    sessions: string
    activeDays: string
    streak: { longest: number; current: number }
    tokenDelta: string
    messageDelta: string
    yearTokens: string
    monthTokens: string
    monthShare: string
    peakTokens: { date: string; dayLabel: string; value: number; text: string } | null
    mostActiveMessages: { date: string; dayLabel: string; value: number; text: string; sessions: number } | null
    models: PiUiUsageModelDisplayExpectation[]
  }
  heatmap: { positiveDays: number; levels: number[]; thresholdCount: number; todayLevel: number }
  /** 页脚/明细可复算口径（e2e 与报告引用） */
  derived: { yearTokens: number; octTokens: number; monthPrefix: string }
  /** design 专用：设计样张目标（非自洽；对图/验证按此引用，页面 days 派生值可能不同） */
  designTargets?: { tokenDeltaText: string; yearTokens: number; monthShareText: string; peakTokensText: string; note: string }
}

export interface PiUiUsageStateMeta {
  id: PiUiUsageStateId
  kind: PiUiUsageStateId
  label: string
  note: string
  available: false
  /** 页面选择器/截图状态（`data-pi-usage-state`） */
  state: "error" | "unavailable"
  reason: UsageUnavailableReason | null
  capabilityMissing: boolean
}

function modelDisplay(models: readonly UsageModelSlice[]): PiUiUsageModelDisplayExpectation[] {
  const rows = piUiUsageModelDisplayRows(models, 4)
  const total = models.reduce((sum, row) => sum + row.tokens, 0)
  return rows.map((row) => ({ label: row.other ? "其他模型" : row.label, provider: row.provider, model: row.model, tokens: row.tokens, pctText: formatPercent(total > 0 ? row.tokens / total : 0), other: row.other }))
}

function metaOf(id: PiUiUsageFixtureId): PiUiUsageFixtureMeta {
  const snapshot = PI_UI_USAGE_FIXTURES[id]
  const validation = validateUsageSnapshot(snapshot)
  const last30 = piUiUsageLast30Of(snapshot)
  const prev30Totals = piUiUsagePrev30Of(snapshot)
  const prev30 = prev30Totals.activeDays > 0 || prev30Totals.tokens > 0 ? prev30Totals : null
  const yearTokens = piUiUsageYearTokensOf(snapshot)
  const monthPrefix = PI_UI_USAGE_MOCK_TODAY.slice(0, 7)
  const octTokens = piUiUsageMonthTokensOf(snapshot, monthPrefix)
  const tokens = snapshot.days.map((day) => day.tokens.total)
  const scale = heatmapScaleOf(tokens, 5)
  const levels = [0, 0, 0, 0, 0]
  for (const value of tokens) levels[scale.bucketOf(value)] += 1
  const todayDay = snapshot.days.find((day) => day.date === PI_UI_USAGE_MOCK_TODAY) ?? null
  const peak = snapshot.summary.peaks.tokens
  const mostActive = snapshot.summary.peaks.messages
  const mostActiveDay = mostActive ? snapshot.days.find((day) => day.date === mostActive.date) ?? null : null
  const delta = usageDeltaOf(last30.tokens, prev30?.tokens ?? 0)
  const messageDelta = usageDeltaOf(last30.messagesUser, prev30?.messagesUser ?? 0)
  return {
    id,
    label: id === "design" ? "设计对图样张（非自洽）" : id === "realistic" ? "自洽数据（365 天长尾）" : id === "short" ? "少数据（12 天）" : id === "empty" ? "空态（0 会话）" : "极端长尾（9 天占 80%）",
    note:
      id === "design"
        ? "对图样张（非自洽）：卡片 12.6M/3,214/24、streak 9·6、峰值 214K(10-19)、10-22 412·17、模型 68/24/8；前 30 天显式设为 9,130,435 → Token 环比 ↑38%；峰值显式覆盖 214K（日数据真实峰值 1.3M）。年度 18.9M·10 月 67% 仅在 designTargets/README 保留（days 全年被改成 23.5M，非自洽样张）。"
        : id === "realistic"
          ? "自洽数据：近 30 天 12.6M/3,214/24、峰值 1.3M(10-19)、环比 ↑180%、全年 18.9M；用于 e2e/数据正确性抽检。"
        : id === "short"
          ? "12 天数据（含 2 天断档，当前连续 3 天）；前 30 天无数据 → 环比「数据积累中」，累计曲线从首日画起。"
          : id === "empty"
            ? "全新用户：days=[]、汇总 0、热力图全浅、模型空；UI 显示空态文案而不报错。"
            : "9 个高用量日占 80% 总量；模型 8 行用于验证 UI「前 4 + 其他」合并（其他 = 第 5 名起合计）。",
    valid: validation.ok,
    validationErrors: validation.ok ? [] : validation.errors,
    range: snapshot.range,
    last30,
    prev30,
    display: {
      tokens: formatTokenCount(last30.tokens),
      messagesUser: formatCount(last30.messagesUser),
      sessions: formatCount(last30.sessions),
      activeDays: formatCount(last30.activeDays),
      streak: snapshot.summary.streaks,
      tokenDelta: delta.text,
      messageDelta: messageDelta.text,
      yearTokens: formatTokenCount(yearTokens),
      monthTokens: formatTokenCount(octTokens),
      monthShare: formatPercent(yearTokens > 0 ? octTokens / yearTokens : 0),
      peakTokens: peak ? { date: peak.date, dayLabel: formatUsageDayLabel(peak.date), value: peak.value, text: formatTokenCount(peak.value) } : null,
      mostActiveMessages: mostActive
        ? {
            date: mostActive.date,
            dayLabel: formatUsageDayLabel(mostActive.date),
            value: mostActive.value,
            text: formatCount(mostActive.value),
            sessions: mostActiveDay?.sessions ?? 0,
          }
        : null,
      models: modelDisplay(snapshot.summary.models),
    },
    heatmap: { positiveDays: tokens.filter((value) => value > 0).length, levels, thresholdCount: scale.thresholds.length, todayLevel: todayDay ? scale.bucketOf(todayDay.tokens.total) : 0 },
    derived: { yearTokens, octTokens, monthPrefix },
    ...(id === "design"
      ? {
          designTargets: {
            tokenDeltaText: "↑38%",
            yearTokens: 18_900_000,
            monthShareText: "67%",
            peakTokensText: "214K",
            note: "设计稿目标值（非自洽）：对图/验证引用该组；days 派生年度=23.5M/月占 54%，属样张口径差异。",
          },
        }
      : null),
  }
}

/** 四组 fixture 的展示期望（每次调用重建，防止外部修改模块级快照） */
export function piUiUsageFixtureMeta(): Record<PiUiUsageFixtureId, PiUiUsageFixtureMeta> {
  return {
    design: metaOf("design"),
    realistic: metaOf("realistic"),
    short: metaOf("short"),
    empty: metaOf("empty"),
    longtail: metaOf("longtail"),
  }
}

/** 单组期望；`sparse` 为旧称别名（= short）；未知 id 回退 normal */
export function piUiUsageFixtureMetaOf(id: string): PiUiUsageFixtureMeta {
  const fixtureId = (PI_UI_USAGE_FIXTURE_IDS as readonly string[]).includes(id) ? (id as PiUiUsageFixtureId) : id === "sparse" ? "short" : id === "normal" ? "realistic" : "realistic"
  return metaOf(fixtureId)
}

/** error / unavailable 状态元信息（UI 13/14 态与 e2e 断言用） */
export function piUiUsageStateMetaOf(id: PiUiUsageStateId, reason: UsageUnavailableReason = "unsupported"): PiUiUsageStateMeta {
  if (id === "error") {
    return { id: "error", kind: "error", label: "拉取失败（可重试）", note: PI_UI_USAGE_STATES.error.message, available: false, state: "error", reason: null, capabilityMissing: false }
  }
  const unavailable = PI_UI_USAGE_STATES.unavailable[reason]
  return {
    id: "unavailable",
    kind: "unavailable",
    label: reason === "unsupported" ? "能力禁用（无 usage.activity.v1）" : `不可用（${reason}）`,
    note: reason === "no_data" ? "有数据源但 0 会话（P10-USAGE-09 空态与 14 禁用态要区分）" : "available=false；UI 按 reason 映射文案，不报错",
    available: false,
    state: "unavailable",
    reason,
    capabilityMissing: unavailable.capabilityMissing,
  }
}

/** fixture 需要的本地日序列（画廊/测试生成空白格用） */
export function piUiUsageFixtureDayKeys(snapshot: UsageSnapshotV1): string[] {
  return dayKeyRange(snapshot.range.firstDay ?? PI_UI_USAGE_MOCK_TODAY, snapshot.range.lastDay ?? PI_UI_USAGE_MOCK_TODAY)
}
