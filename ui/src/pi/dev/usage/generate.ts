/**
 * P10.3「使用活动」mock 数据生成器（**dev-only**，确定性，无随机/无 wall clock）。
 *
 * 只被 dev 画廊 / mock 工装 / 单测 import；生产入口不引用本目录，也不 import `usage-fixtures/*.json`
 * （那份 JSON 是给 UI 线/验证线参考的静态快照，正式 mock 走本生成器）。
 *
 * 契约：`ui/src/pi/usage/types.ts` 的 `usage.activity.v1`（`UsageSnapshotV1`）。
 * 口径（与 arch `p10-usage-data-plan.md` 一致）：
 * - tokens.total = assistant `usage.totalTokens` 按天求和（API 处理量口径，不是「输入内容量」）；
 * - messages.user 只数 role=user；sessions = 当晚开始的会话文件数；分天按设备本地时区；
 * - 不含 cost/content/cwd/title/path 等敏感字段（`validateUsageSnapshot` 会拒绝）。
 *
 * 五组 fixture（见 `fixtures.ts`）：
 * - `design`   ：**设计对图样张，非自洽**（用户裁决）：严格保留设计稿数字（12.6M/3,214/24·30/9·6/214K 峰值/412·17/68·24·8），
 *                其中峰值显式覆盖为 214K；「↑38%」与「全年 18.9M·10 月 67%」不可同时由同一份日数据成立，对图以 18.9M/67% 为准（见 README）。
 * - `realistic`：**自洽数据**（e2e/数据正确性用）：365 天长尾 + 今天；近 30 天 12.6M Token / 3,214 用户消息 / 24 活跃天 / streak 9·当前 6；
 *                全年 18.9M、10 月占 67%；最活跃 10-22 = 412 消息 / 17 会话 / 86.4K Token；
 *                模型分布 68% / 24% / 8%（step-5-preview / step-3.7-flash / 其他）。
 * - `empty`    ：全新用户（`piUsageEmptySnapshot`）。
 * - `short`    ：12 天少数据（含 2 天断档，当前连续 3 天；旧称 sparse 的别名保留）。
 * - `longtail` ：365 天极端长尾（9 个高用量日占 80%），模型 8 行用于验证「前 4 + 其他」合并。
 */
import {
  addDaysToDayKey,
  dayKeyDiff,
  dayKeyRange,
} from "../../usage/format.ts"
import {
  USAGE_ACTIVITY_VERSION,
  type UsageCoverage,
  type UsageDay,
  type UsageModelSlice,
  type UsagePeak,
  type UsageSnapshotV1,
  type UsageSummary,
} from "../../usage/types.ts"
import { piUsageEmptySnapshot } from "../../usage/validate.ts"

/** mock「今天」（设备本地日；截图/断言基准，不读系统时钟） */
export const PI_UI_USAGE_MOCK_TODAY = "2026-10-27"
/** mock 历史首日（365 天窗口：2025-10-28 → 2026-10-27） */
export const PI_UI_USAGE_MOCK_YEAR_START = "2025-10-28"
/** 快照 generatedAt（2026-10-27 12:00 Asia/Shanghai 的 UTC ms） */
export const PI_UI_USAGE_MOCK_GENERATED_AT = Date.UTC(2026, 9, 27, 4, 0, 0)
/** mock 设备（Pi 语义：MacBook Pro） */
export const PI_UI_USAGE_MOCK_DEVICE_ID = "d-mbp"
/** 设备本地时区（与 generatedAt 的本地日一致） */
export const PI_UI_USAGE_MOCK_TIMEZONE = { id: "Asia/Shanghai", offsetMinutes: 480 } as const
/** 生成器 seed（固定常量；改 fixture 特征时换 seed 并同步快照） */
export const PI_UI_USAGE_MOCK_SEEDS = { normal: 20261027, short: 20261028, longtail: 20261029 } as const
/** mock 快照的 coverage.scanMs（真实本机全量扫描实测 162ms；固定值保证确定性） */
const MOCK_SCAN_MS = 162

const WINDOW_DAYS = 30
const OCT_START = "2026-10-01"
const OCT_PEAK_DAY = "2026-10-19"
const OCT_MOST_ACTIVE_DAY = "2026-10-22"
const OCT_INACTIVE_DAYS = ["2026-10-10", "2026-10-15", "2026-10-21"] as const
/** normal 目标（只在本文件构造数据时使用；测试从 fixtures 元信息读取期望展示值） */
const NORMAL_TARGETS = {
  yearTokens: 18_900_000,
  windowTokens: 12_600_000,
  windowUserMessages: 3_214,
  windowActiveDays: 24,
  windowSessions: 97,
  streakLongest: 9,
  streakCurrent: 6,
  peakTokens: 1_300_000,
  mostActiveUserMessages: 412,
  mostActiveSessions: 17,
  mostActiveTokens: 86_400,
  /** 前 30 天（2026-08-29..2026-09-27）目标：Token 4.5M（环比 +180%）、用户消息 2,870（环比 +12%） */
  prevTokens: 4_500_000,
  prevUserMessages: 2_870,
} as const

/* ------------------------------------------------------------------------------------------------
 * 基础工具（确定性）
 * ---------------------------------------------------------------------------------------------- */

/** mulberry32：确定性 PRNG（与参考设计稿同族；无 Math.random） */
export function piUiUsageMulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 按权重把整数 total 分配到 n 份（最大余数法；保证 sum 精确等于 total） */
function distributeInt(total: number, weights: readonly number[]): number[] {
  const n = weights.length
  const out = new Array<number>(n).fill(0)
  if (n === 0) return out
  const weightSum = weights.reduce((sum, w) => sum + (Number.isFinite(w) && w > 0 ? w : 0), 0)
  if (weightSum <= 0 || total <= 0) return out
  const raw = weights.map((w) => (total * (Number.isFinite(w) && w > 0 ? w : 0)) / weightSum)
  let assigned = 0
  const remainders: Array<{ index: number; fraction: number }> = []
  for (let i = 0; i < n; i++) {
    out[i] = Math.floor(raw[i])
    assigned += out[i]
    remainders.push({ index: i, fraction: raw[i] - out[i] })
  }
  remainders.sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let k = 0; assigned < total; k = (k + 1) % n) {
    out[remainders[k].index] += 1
    assigned += 1
  }
  return out
}

const roundInt = (value: number): number => Math.max(0, Math.round(value))

/** token 拆分（input/output/cacheRead/cacheWrite 之和精确等于 total，全部非负整数） */
function splitTokens(total: number): UsageDay["tokens"] {
  const safeTotal = roundInt(total)
  const input = roundInt(safeTotal * 0.78)
  const output = roundInt(safeTotal * 0.12)
  const cacheRead = roundInt(safeTotal * 0.08)
  const cacheWrite = Math.max(0, safeTotal - input - output - cacheRead)
  return { total: input + output + cacheRead + cacheWrite, input, output, cacheRead, cacheWrite }
}

function zeroDay(date: string): UsageDay {
  return { date, tokens: splitTokens(0), messages: { user: 0, assistant: 0 }, sessions: 0 }
}

function makeDay(date: string, tokens: number, userMessages: number, assistantMessages: number, sessions: number): UsageDay {
  return {
    date,
    tokens: splitTokens(tokens),
    messages: { user: roundInt(userMessages), assistant: roundInt(assistantMessages) },
    sessions: roundInt(sessions),
  }
}

/** assistant 回复数（mock 口径：约 4.2 倍用户消息；有用户消息的天至少 1 条回复） */
function assistantOf(userMessages: number): number {
  if (userMessages <= 0) return 0
  return roundInt(userMessages * 4.2) + 1
}

function coverageOf(files: number, truncated = false): UsageCoverage {
  return { files, parsedFiles: files, cacheHitFiles: 0, skippedFiles: 0, truncated, errors: 0, scanMs: MOCK_SCAN_MS, source: "pi-sessions" }
}

/** 按日期查天（缺失 = 全 0 的空白天，用于 streak/窗口计算） */
function dayMapOf(days: readonly UsageDay[]): Map<string, UsageDay> {
  return new Map(days.map((day) => [day.date, day]))
}

function sumWindow(days: readonly UsageDay[], from: string, to: string): { tokens: number; messagesUser: number; messagesAssistant: number; sessions: number; activeDays: number } {
  const map = dayMapOf(days)
  let tokens = 0
  let messagesUser = 0
  let messagesAssistant = 0
  let sessions = 0
  let activeDays = 0
  for (const date of dayKeyRange(from, to)) {
    const day = map.get(date)
    if (!day) continue
    tokens += day.tokens.total
    messagesUser += day.messages.user
    messagesAssistant += day.messages.assistant
    sessions += day.sessions
    if (day.sessions > 0) activeDays += 1
  }
  return { tokens, messagesUser, messagesAssistant, sessions, activeDays }
}

/** 连续使用天数（以 lastDay 为基准；日历连续性按本地日算，断档日 = 不活跃） */
function streaksOf(days: readonly UsageDay[]): { current: number; longest: number } {
  if (days.length === 0) return { current: 0, longest: 0 }
  const map = dayMapOf(days)
  const first = days[0].date
  const last = days[days.length - 1].date
  let current = 0
  for (let date = last; date >= first; date = addDaysToDayKey(date, -1)) {
    if ((map.get(date)?.sessions ?? 0) > 0) current += 1
    else break
    if (date === first) break
  }
  let longest = 0
  let run = 0
  for (const date of dayKeyRange(first, last)) {
    if ((map.get(date)?.sessions ?? 0) > 0) {
      run += 1
      if (run > longest) longest = run
    } else run = 0
  }
  return { current, longest }
}

function peaksOf(days: readonly UsageDay[]): { tokens: UsagePeak | null; messages: UsagePeak | null } {
  let tokens: UsagePeak | null = null
  let messages: UsagePeak | null = null
  for (const day of days) {
    if (!tokens || day.tokens.total > tokens.value) tokens = { date: day.date, value: day.tokens.total }
    if (!messages || day.messages.user > messages.value) messages = { date: day.date, value: day.messages.user }
  }
  return { tokens: tokens && tokens.value > 0 ? tokens : null, messages: messages && messages.value > 0 ? messages : null }
}

/** 近 30 天（含今天）汇总 + 全期派生指标 */
function summarize(days: readonly UsageDay[], today: string, models: UsageModelSlice[]): UsageSummary {
  const windowFrom = addDaysToDayKey(today, -(WINDOW_DAYS - 1))
  const totals = sumWindow(days, windowFrom, today)
  const streaks = streaksOf(days)
  const peaks = peaksOf(days)
  return {
    totals: {
      tokens: totals.tokens,
      messagesUser: totals.messagesUser,
      messagesAssistant: totals.messagesAssistant,
      sessions: totals.sessions,
      activeDays: totals.activeDays,
    },
    streaks,
    peaks,
    models: models.map((row) => ({ ...row })).sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
    modelsWindowDays: 30,
  }
}

/** 近 30 天 token 总量（模型分布分母） */
function windowTokensOf(days: readonly UsageDay[], today: string): number {
  return sumWindow(days, addDaysToDayKey(today, -(WINDOW_DAYS - 1)), today).tokens
}

/** 按占比生成模型行（份额数组必须和为 1；整数化保证总和精确） */
function modelsOf(shares: ReadonlyArray<{ provider: string; model: string; share: number }>, totalTokens: number): UsageModelSlice[] {
  const tokens = distributeInt(totalTokens, shares.map((share) => share.share))
  return shares
    .map((share, index) => ({ provider: share.provider, model: share.model, tokens: tokens[index] }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
}

/* ------------------------------------------------------------------------------------------------
 * realistic：365 天长尾 + 今天（自洽口径；设计样张数字保留在 design 包装层）
 * ---------------------------------------------------------------------------------------------- */

function buildRealistic(): UsageSnapshotV1 {
  const rnd = piUiUsageMulberry32(PI_UI_USAGE_MOCK_SEEDS.normal)
  const yearDates = dayKeyRange(PI_UI_USAGE_MOCK_YEAR_START, PI_UI_USAGE_MOCK_TODAY)
  const dayMap = new Map<string, UsageDay>(yearDates.map((date) => [date, zeroDay(date)]))

  /* --- 10 月（近 30 天的主体）：24 个活跃日、12.6M Token、3,214 用户消息、97 次会话 --- */
  const octDates = dayKeyRange(OCT_START, PI_UI_USAGE_MOCK_TODAY)
  const octInactive = new Set<string>(OCT_INACTIVE_DAYS)
  const octActive = octDates.filter((date) => !octInactive.has(date))
  const fixed = new Map<string, { tokens: number; user: number; sessions: number }>()
  fixed.set(OCT_PEAK_DAY, { tokens: NORMAL_TARGETS.peakTokens, user: 360, sessions: 12 })
  fixed.set(OCT_MOST_ACTIVE_DAY, { tokens: NORMAL_TARGETS.mostActiveTokens, user: NORMAL_TARGETS.mostActiveUserMessages, sessions: NORMAL_TARGETS.mostActiveSessions })
  const flexibleOct = octActive.filter((date) => !fixed.has(date))
  // Token：先扣峰值日/最活跃日，其余按长尾权重分配（保证峰值日仍是最大值）
  const flexibleTokenTotal = NORMAL_TARGETS.windowTokens - NORMAL_TARGETS.peakTokens - NORMAL_TARGETS.mostActiveTokens
  const flexibleTokenWeights = flexibleOct.map(() => 0.35 + Math.pow(rnd(), 2.4) * 0.65)
  const flexibleTokens = distributeInt(flexibleTokenTotal, flexibleTokenWeights)
  // 用户消息：10-22 固定 412，其余 23 天分配剩余 2,802（上限 380，确保不是峰值）
  const flexibleUserTotal = NORMAL_TARGETS.windowUserMessages - NORMAL_TARGETS.mostActiveUserMessages - 360 // 扣掉 10-19 固定 360 条
  const flexibleUserWeights = flexibleOct.map(() => 0.55 + rnd() * 0.6)
  const flexibleUsers = distributeInt(flexibleUserTotal, flexibleUserWeights).map((value) => Math.min(380, value))
  // 会话：10-22 固定 17，其余 23 天先各 1 再按权重分剩余
  const flexibleSessionTotal = NORMAL_TARGETS.windowSessions - NORMAL_TARGETS.mostActiveSessions - 12 // 扣掉 10-19 固定 12 次
  const sessionBase = flexibleSessionTotal - flexibleOct.length
  const flexibleSessions = distributeInt(sessionBase, flexibleOct.map(() => 0.5 + rnd())).map((value) => value + 1)
  flexibleOct.forEach((date, index) => {
    const tokens = flexibleTokens[index]
    const user = flexibleUsers[index]
    dayMap.set(date, makeDay(date, tokens, user, assistantOf(user), flexibleSessions[index]))
  })
  for (const [date, value] of fixed) dayMap.set(date, makeDay(date, value.tokens, value.user, assistantOf(value.user), value.sessions))

  /* --- 10 月之前（2026-09-27 及以前）：全年剩余 6.3M Token；streak 峰值 9 天在 6 月 --- */
  const preDates = yearDates.filter((date) => date < OCT_START)
  const preActive = new Set<string>()
  // 9 天最长连续（2026-06-05..06-13）
  for (let i = 0; i < 9; i++) preActive.add(addDaysToDayKey("2026-06-05", i))
  // 4 段 8 天连续（不邻接，保证最长仍是 9）
  for (const start of ["2025-12-01", "2026-02-10", "2026-04-14", "2026-05-20"]) {
    for (let i = 0; i < 8; i++) preActive.add(addDaysToDayKey(start, i))
  }
  // 前 30 天窗口内的 8 个单日 + 更早的 9 个单日
  for (const date of ["2026-09-01", "2026-09-05", "2026-09-10", "2026-09-14", "2026-09-18", "2026-09-22", "2026-09-25", "2026-09-27"]) preActive.add(date)
  for (const date of ["2025-11-12", "2025-11-28", "2026-01-06", "2026-01-25", "2026-03-08", "2026-03-29", "2026-07-07", "2026-08-02", "2026-08-19"]) preActive.add(date)
  const preActiveDates = preDates.filter((date) => preActive.has(date))
  const prevWindow = new Set(dayKeyRange(addDaysToDayKey(PI_UI_USAGE_MOCK_TODAY, -(WINDOW_DAYS * 2 - 1)), addDaysToDayKey(PI_UI_USAGE_MOCK_TODAY, -WINDOW_DAYS)))
  const prevActiveDates = preActiveDates.filter((date) => prevWindow.has(date))
  const earlyActiveDates = preActiveDates.filter((date) => !prevWindow.has(date))
  // Token：前 30 天目标 4.5M（环比 +180%；设计稿的 +38% 与 12.6M/18.9M 三数不自洽，取自洽口径），其余 1.8M
  const prevTokenWeights = prevActiveDates.map(() => 0.75 + rnd() * 0.6)
  const earlyTokenWeights = earlyActiveDates.map(() => 0.75 + rnd() * 1.2)
  const prevTokens = distributeInt(NORMAL_TARGETS.prevTokens, prevTokenWeights)
  const earlyTokens = distributeInt(NORMAL_TARGETS.yearTokens - NORMAL_TARGETS.windowTokens - NORMAL_TARGETS.prevTokens, earlyTokenWeights)
  // 用户消息：前 30 天 2,870（环比 +12%），更早 230
  const prevUsers = distributeInt(NORMAL_TARGETS.prevUserMessages, prevActiveDates.map(() => 0.9 + rnd() * 0.2))
  const earlyUsers = distributeInt(230, earlyActiveDates.map(() => 0.8 + rnd()))
  prevActiveDates.forEach((date, index) => {
    const user = prevUsers[index]
    dayMap.set(date, makeDay(date, prevTokens[index], user, assistantOf(user), 1))
  })
  earlyActiveDates.forEach((date, index) => {
    const user = earlyUsers[index]
    dayMap.set(date, makeDay(date, earlyTokens[index], user, assistantOf(user), 1))
  })

  const days = yearDates.map((date) => dayMap.get(date) ?? zeroDay(date))
  const models = modelsOf(
    [
      { provider: "stepfun", model: "step-5-preview", share: 0.68 },
      { provider: "stepfun", model: "step-3.7-flash", share: 0.24 },
      { provider: "openai", model: "gpt-6.1-sol", share: 0.08 },
    ],
    NORMAL_TARGETS.windowTokens,
  )
  const sessions = days.reduce((sum, day) => sum + day.sessions, 0)
  return {
    v: USAGE_ACTIVITY_VERSION,
    generatedAt: PI_UI_USAGE_MOCK_GENERATED_AT,
    deviceId: PI_UI_USAGE_MOCK_DEVICE_ID,
    timezone: { ...PI_UI_USAGE_MOCK_TIMEZONE },
    range: { firstDay: days[0]?.date ?? null, lastDay: days[days.length - 1]?.date ?? null, days: days.length },
    days,
    summary: summarize(days, PI_UI_USAGE_MOCK_TODAY, models),
    coverage: coverageOf(sessions),
    cache: { hit: false, generatedFrom: "full" },
  }
}

/**
 * design：设计对图样张（**非自洽**，用户裁决）。在 realistic 数据上做两处设计稿覆盖：
 * 1) 前 30 天 Token 提到 9,130,435 → UI 环比显「↑38%」（12.6M/9.13M≈1.38）；
 * 2) summary.peaks.tokens 覆盖为 214K(10-19)（日数据真实峰值仍 1.3M）。
 * 指定非自洽：把前 30 天提到 9.13M 后，days 全年合计变为 23,530,435；设计稿「全年 18.9M·10 月 67%」
 * 只保留在 fixture 元信息/README（designTargets），不参与 days 派生。对图/验证按「样张数字」口径引用。
 */
function buildDesign(): UsageSnapshotV1 {
  const snapshot = buildRealistic()
  const lastDay = snapshot.range.lastDay ?? PI_UI_USAGE_MOCK_TODAY
  const from = addDaysToDayKey(lastDay, -(WINDOW_DAYS * 2 - 1))
  const to = addDaysToDayKey(lastDay, -WINDOW_DAYS)
  const prevDates = new Set(dayKeyRange(from, to))
  const prevActive = snapshot.days.filter((day) => prevDates.has(day.date) && day.sessions > 0)
  const prevTarget = 9_130_435
  const prevWeights = prevActive.map((day) => Math.max(1, day.tokens.total))
  const prevTokens = distributeInt(prevTarget, prevWeights)
  prevActive.forEach((day, index) => {
    day.tokens = splitTokens(prevTokens[index] ?? 0)
  })
  snapshot.summary.peaks = {
    tokens: { date: OCT_PEAK_DAY, value: 214_000 },
    messages: { date: OCT_MOST_ACTIVE_DAY, value: NORMAL_TARGETS.mostActiveUserMessages },
  }
  return snapshot
}

/* ------------------------------------------------------------------------------------------------
 * short：12 天少数据（含 3 天断档；最长连续 4、当前连续 3 天）
 * ---------------------------------------------------------------------------------------------- */

function buildShort(): UsageSnapshotV1 {
  const rnd = piUiUsageMulberry32(PI_UI_USAGE_MOCK_SEEDS.short)
  const windowDates = dayKeyRange(addDaysToDayKey(PI_UI_USAGE_MOCK_TODAY, -14), PI_UI_USAGE_MOCK_TODAY)
  // 断档日：10-16 / 10-21 / 10-24 → 12 个活跃日、最长连续 4（10-17..20）、当前连续 3（10-25..27）
  const gaps = new Set(["2026-10-16", "2026-10-21", "2026-10-24"])
  const active = windowDates.filter((date) => !gaps.has(date))
  const tokenWeights = active.map(() => 0.6 + rnd())
  const tokens = distributeInt(42_000, tokenWeights)
  const userWeights = active.map(() => 0.6 + rnd())
  const users = distributeInt(96, userWeights)
  const days = active.map((date, index) => makeDay(date, tokens[index], users[index], assistantOf(users[index]), index % 3 === 0 ? 2 : 1))
  const models = modelsOf(
    [
      { provider: "stepfun", model: "step-5-preview", share: 0.68 },
      { provider: "stepfun", model: "step-3.7-flash", share: 0.32 },
    ],
    days.reduce((sum, day) => sum + day.tokens.total, 0),
  )
  return {
    v: USAGE_ACTIVITY_VERSION,
    generatedAt: PI_UI_USAGE_MOCK_GENERATED_AT,
    deviceId: PI_UI_USAGE_MOCK_DEVICE_ID,
    timezone: { ...PI_UI_USAGE_MOCK_TIMEZONE },
    range: { firstDay: days[0]?.date ?? null, lastDay: days[days.length - 1]?.date ?? null, days: days.length },
    days,
    summary: summarize(days, PI_UI_USAGE_MOCK_TODAY, models),
    coverage: coverageOf(days.reduce((sum, day) => sum + day.sessions, 0)),
    cache: { hit: true, generatedFrom: "incremental" },
  }
}

/* ------------------------------------------------------------------------------------------------
 * longtail：365 天极端长尾（9 个高用量日占 80%），模型 8 行（前 4 + 其他合并回归）
 * ---------------------------------------------------------------------------------------------- */

const LONGTAIL_HEAVY_DAYS = [
  "2025-12-15",
  "2026-01-20",
  "2026-02-18",
  "2026-03-22",
  "2026-04-19",
  "2026-05-24",
  "2026-06-21",
  "2026-08-30",
  "2026-10-05",
] as const
const LONGTAIL_HEAVY_TOKENS = 1_680_000
const LONGTAIL_TOTAL_TOKENS = 18_900_000

function buildLongtail(): UsageSnapshotV1 {
  const rnd = piUiUsageMulberry32(PI_UI_USAGE_MOCK_SEEDS.longtail)
  const yearDates = dayKeyRange(PI_UI_USAGE_MOCK_YEAR_START, PI_UI_USAGE_MOCK_TODAY)
  const heavy = new Set<string>(LONGTAIL_HEAVY_DAYS)
  const lowDates = yearDates.filter((date) => !heavy.has(date))
  // 低用量日：120 天有零星使用、其余接近 0（极端长尾），总和 = 全年 - 9 个高峰日
  const lowTokensTotal = LONGTAIL_TOTAL_TOKENS - LONGTAIL_HEAVY_DAYS.length * LONGTAIL_HEAVY_TOKENS
  const lowActive: string[] = []
  for (let index = 0; index < lowDates.length && lowActive.length < 120; index += 3) lowActive.push(lowDates[index])
  if (lowActive.length < 120) lowActive.push(lowDates[lowDates.length - 1])
  const lowTokenWeights = lowActive.map(() => 0.2 + Math.pow(rnd(), 5) * 1.8)
  const lowTokens = distributeInt(lowTokensTotal, lowTokenWeights)
  const lowUserWeights = lowActive.map(() => 0.5 + rnd())
  const lowUsers = distributeInt(1_600, lowUserWeights)
  const dayMap = new Map<string, UsageDay>(yearDates.map((date) => [date, zeroDay(date)]))
  for (const date of LONGTAIL_HEAVY_DAYS) dayMap.set(date, makeDay(date, LONGTAIL_HEAVY_TOKENS, 300, assistantOf(300), 20))
  lowActive.forEach((date, index) => {
    const user = Math.max(1, lowUsers[index])
    dayMap.set(date, makeDay(date, Math.max(1, lowTokens[index]), user, assistantOf(user), 1))
  })
  const days = yearDates.map((date) => dayMap.get(date) ?? zeroDay(date))
  const recentTokens = windowTokensOf(days, PI_UI_USAGE_MOCK_TODAY)
  const models = modelsOf(
    [
      { provider: "stepfun", model: "step-5-preview", share: 0.68 },
      { provider: "stepfun", model: "step-3.7-flash", share: 0.24 },
      { provider: "openai", model: "gpt-6.1-sol", share: 0.04 },
      { provider: "openai", model: "gpt-6-astra", share: 0.02 },
      { provider: "anthropic", model: "claude-sonnet-4.5", share: 0.008 },
      { provider: "deepseek", model: "deepseek-v3.1", share: 0.005 },
      { provider: "qwen", model: "qwen3-coder", share: 0.004 },
      { provider: "google", model: "gemini-2.5-pro", share: 0.003 },
    ],
    recentTokens,
  )
  return {
    v: USAGE_ACTIVITY_VERSION,
    generatedAt: PI_UI_USAGE_MOCK_GENERATED_AT,
    deviceId: PI_UI_USAGE_MOCK_DEVICE_ID,
    timezone: { ...PI_UI_USAGE_MOCK_TIMEZONE },
    range: { firstDay: days[0]?.date ?? null, lastDay: days[days.length - 1]?.date ?? null, days: days.length },
    days,
    summary: summarize(days, PI_UI_USAGE_MOCK_TODAY, models),
    coverage: coverageOf(days.reduce((sum, day) => sum + day.sessions, 0)),
    cache: { hit: false, generatedFrom: "full" },
  }
}

/* ------------------------------------------------------------------------------------------------
 * 出口
 * ---------------------------------------------------------------------------------------------- */

export type PiUiUsageFixtureId = "design" | "realistic" | "short" | "empty" | "longtail"

function buildEmpty(): UsageSnapshotV1 {
  return piUsageEmptySnapshot({ deviceId: PI_UI_USAGE_MOCK_DEVICE_ID, timezone: { ...PI_UI_USAGE_MOCK_TIMEZONE }, generatedAt: PI_UI_USAGE_MOCK_GENERATED_AT })
}

/** 全部 fixture 快照（确定性；每次调用重建以保证结果与模块加载顺序无关） */
export function piUiUsageFixtures(): Record<PiUiUsageFixtureId, UsageSnapshotV1> {
  return { design: buildDesign(), realistic: buildRealistic(), short: buildShort(), empty: buildEmpty(), longtail: buildLongtail() }
}

/** 单个 fixture（未知 id 回退 normal） */
export function piUiUsageFixtureOf(id: string): { id: PiUiUsageFixtureId; snapshot: UsageSnapshotV1 } {
  const fixtures = piUiUsageFixtures()
  const fixtureId = (["design", "realistic", "short", "empty", "longtail"] as const).find((candidate) => candidate === id) ?? (id === "sparse" ? "short" : id === "normal" ? "realistic" : "realistic")
  return { id: fixtureId, snapshot: fixtures[fixtureId] }
}

/** 派生工具（e2e/单元断言用；与 UI 共用 `format.ts`，不另造格式化） */
export function piUiUsageLast30Of(snapshot: UsageSnapshotV1): { tokens: number; messagesUser: number; sessions: number; activeDays: number } {
  const lastDay = snapshot.range.lastDay ?? PI_UI_USAGE_MOCK_TODAY
  const totals = sumWindow(snapshot.days, addDaysToDayKey(lastDay, -(WINDOW_DAYS - 1)), lastDay)
  return { tokens: totals.tokens, messagesUser: totals.messagesUser, sessions: totals.sessions, activeDays: totals.activeDays }
}

/** 前 30 天窗口（环比用；少数据/空态可能为 0） */
export function piUiUsagePrev30Of(snapshot: UsageSnapshotV1): { tokens: number; messagesUser: number; sessions: number; activeDays: number } {
  const lastDay = snapshot.range.lastDay ?? PI_UI_USAGE_MOCK_TODAY
  const from = addDaysToDayKey(lastDay, -(WINDOW_DAYS * 2 - 1))
  const to = addDaysToDayKey(lastDay, -WINDOW_DAYS)
  const totals = sumWindow(snapshot.days, from, to)
  return { tokens: totals.tokens, messagesUser: totals.messagesUser, sessions: totals.sessions, activeDays: totals.activeDays }
}

/** 全期总 Token（热力图页脚「近一年共使用」） */
export function piUiUsageYearTokensOf(snapshot: UsageSnapshotV1): number {
  return snapshot.days.reduce((sum, day) => sum + day.tokens.total, 0)
}

/** 指定月份（YYYY-MM）总 Token（页脚「10 月占 67%」） */
export function piUiUsageMonthTokensOf(snapshot: UsageSnapshotV1, monthPrefix: string): number {
  return snapshot.days.filter((day) => day.date.startsWith(monthPrefix)).reduce((sum, day) => sum + day.tokens.total, 0)
}

/** 「前 4 + 其他」展示行（与设计/UI 合并口径一致；e2e 断言用） */
export function piUiUsageModelDisplayRows(models: readonly UsageModelSlice[], maxRows = 4): Array<{ label: string; provider: string; model: string; tokens: number; share: number; other: boolean }> {
  const total = models.reduce((sum, row) => sum + row.tokens, 0)
  if (total <= 0) return []
  const top = models.slice(0, maxRows)
  const rest = models.slice(maxRows)
  const rows = top.map((row) => ({
    label: row.model,
    provider: row.provider,
    model: row.model,
    tokens: row.tokens,
    share: row.tokens / total,
    other: false,
  }))
  const otherTokens = rest.reduce((sum, row) => sum + row.tokens, 0)
  if (otherTokens > 0) rows.push({ label: "其他模型", provider: "", model: "", tokens: otherTokens, share: otherTokens / total, other: true })
  return rows
}

/** 供断言用的窗口差（天） */
export function piUiUsageRangeDays(snapshot: UsageSnapshotV1): number {
  return snapshot.range.firstDay && snapshot.range.lastDay ? dayKeyDiff(snapshot.range.firstDay, snapshot.range.lastDay) + 1 : 0
}
