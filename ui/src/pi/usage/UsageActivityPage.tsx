import { useEffect, useMemo, useRef, useState } from "react"
import "./usage.css"
import {
  addDaysToDayKey,
  dayKeyRange,
  formatCount,
  formatPercent,
  formatTokenCount,
  heatmapScaleOf,
  usageCoverageText,
  usageTodayDayKey,
  usageDeltaOf,
  weekdayOfDayKey,
} from "./format"
import { piUsageEmptySnapshot } from "./validate"
import { useUsageActivity as useUsageActivityState, type UsageActivityRelayLike } from "./useUsage"
import { USAGE_MODELS_MAX, type UsageDay, type UsageSnapshotV1 } from "./types"

/**
 * P10「使用活动」共享页面组件（契约 `usage.activity.v1`）。
 *
 * 数据：`useUsageActivity({deviceId})`（本文件内置 mock provider；arch 接入 relay `usage_get/snapshot` 后替换实现，
 * 组件/UI 不变）。快照经 `validateUsageSnapshot` 校验（无正文/路径/金额等敏感键）。
 * 视觉：混搭（Cursor 深玻璃底盘 / Codex 骨架由宿主提供 / Claude 衬线数字 / 紫色数据 / 陶土橙仅今天环+峰值），
 * 样式自包含在 usage.css（`.pi-usage-root` + `--pu-*`，不依赖任何变体变量）；深色定稿 + 浅色派生自动跟随
 * `<html data-pi-theme>`，也可 `theme` prop 强制。六段结构：页头切换 ×2 → 汇总卡×4 → 主图（热力/周柱/累计）→
 * 明细 + 模型分布 → 口径小字；空态/少数据/420 窄屏均覆盖。
 */
export type UsageMetric = "tokens" | "messages" | "sessions"
export type UsageViewMode = "daily" | "weekly" | "cumulative"

const METRIC_LABEL: Record<UsageMetric, string> = { tokens: "Token", messages: "消息", sessions: "会话" }
const VIEW_LABEL: Record<UsageViewMode, string> = { daily: "每天", weekly: "每周", cumulative: "累计总量" }
const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

/** 中文日期：10月22日 · 周四（tooltip/明细/峰值统一） */
function formatDayHuman(dayKey: string): string {
  const [, m, d] = dayKey.split("-").map(Number)
  const weekday = WEEKDAY_LABEL[weekdayOfDayKey(dayKey)]
  return `${m}月${d}日 · ${weekday}`
}

function metricOf(day: UsageDay, metric: UsageMetric): number {
  return metric === "tokens" ? day.tokens.total : metric === "messages" ? day.messages.user : day.sessions
}

function useDomTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (typeof document !== "undefined" && document.documentElement.dataset.piTheme === "light" ? "light" : "dark")
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-pi-theme"] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** dev 对图展示覆盖（只影响文本展示，不影响数据计算/无障碍朗读；生产挂载不传） */
export interface UsageDisplayOverrides {
  /** 例 "↑38%"；替换环比文案 */
  tokenDeltaText?: string
  /** 例 "18.9M" */
  yearTokensText?: string
  /** 例 "67%" */
  monthShareText?: string
  /** 例 "214K" */
  peakTokensText?: string
}

export interface UsageActivityPageProps {
  deviceId?: string
  /** 真实 relay（设置页传入；有 getUsage 走真实数据，无则诚实降级） */
  relay?: UsageActivityRelayLike | null
  /** 强制主题（截图/静态构建用）；默认跟随 <html data-pi-theme> */
  theme?: "light" | "dark"
  className?: string
  /** 覆盖数据源（dev 预览/测试注入 mock 快照；生产不传） */
  snapshot?: UsageSnapshotV1
  /**
   * dev/对图专用展示覆盖（design fixture A/B 组）：**只影响文本展示**，不影响数据计算与无障碍朗读。
   * 生产挂载（Claude/Codex/Cursor 设置页）绝不传；devPreview 仅在 ?fixture= 时映射 designTargets。
   */
  displayOverrides?: UsageDisplayOverrides
  /** dev 三态预览（gallery/截图用；生产挂载不传）：强制 loading / error / unavailable */
  previewState?: "loading" | "error" | "unavailable"
  /** dev 降级 reason 覆盖（配合 previewState=unavailable/error；生产不传） */
  previewReason?: "no_data" | "device_offline" | "unsupported" | "timeout" | "stale"
}

/** spec v1.3 §7.6：reason → 降级文案（逐字）；invalid = UI 侧校验失败（不是「还没有活动」） */
const REASON_COPY: Record<string, { title: string; body: string }> = {
  unsupported: {
    title: "使用活动数据不可用",
    body: "当前 pi 扩展 / relay 版本不支持使用活动数据（usage.activity.v1），升级后即可查看。",
  },
  no_data: { title: "还没有使用活动", body: "开始和 pi 对话后，这里会出现你的使用活动。" },
  device_offline: { title: "设备离线，暂无可展示数据", body: "设备当前不在线，且没有可用缓存；连接恢复后会自动更新。" },
  timeout: { title: "读取超时", body: "读取本机使用数据超时，可稍后重试。" },
  stale: { title: "数据可能不是最新", body: "展示的是 relay 缓存数据，设备恢复连接后会自动更新。" },
  invalid: { title: "使用活动数据读取失败", body: "设备上报的聚合数据没有通过校验，已拒绝展示；可重试或等设备重新生成快照。" },
}

/** 降级卡里的错误摘要：只留一行短句，技术细节/正文绝不展示。 */
const ERROR_SUMMARY_MAX = 160
function errorSummaryOf(error: string | null): string | null {
  if (!error) return null
  const text = error.replace(/\s+/g, " ").trim()
  if (!text) return null
  return text.length > ERROR_SUMMARY_MAX ? `${text.slice(0, ERROR_SUMMARY_MAX - 1)}…` : text
}

export function UsageActivityPage({ deviceId, relay, theme: forcedTheme, className, snapshot: provided, displayOverrides, previewState, previewReason }: UsageActivityPageProps) {
  const domTheme = useDomTheme()
  const theme = forcedTheme ?? domTheme
  // 真实链路（arch `useUsageActivity(relay,{deviceId})`）；dev 预览/测试用显式 snapshot 覆盖
  const real = useUsageActivityState(relay ?? null, { deviceId })
  const hasSnapshot = !!provided || !!real.snapshot
  const forcedLoading = previewState === "loading"
  const forcedDegradation = previewState === "error" || previewState === "unavailable" || (previewReason != null && previewState !== "loading")
  const loading = forcedLoading || (!provided && real.loading && !real.snapshot)
  const reason = provided ? null : real.reason
  const stale = !provided && real.stale
  const snapshot = provided ?? real.snapshot ?? piUsageEmptySnapshot({ deviceId })
  const [metric, setMetric] = useState<UsageMetric>("tokens")
  const [view, setView] = useState<UsageViewMode>("daily")
  const days = snapshot.days
  const empty = hasSnapshot && days.length === 0
  const short = !empty && days.length < 30
  // 「今天」由快照派生（生成时间 + 设备时区偏移），不拿查看端浏览器时区冒充设备时区（UI·usage 中-1）
  const todayKey = usageTodayDayKey(snapshot)
  // 低危 23：覆盖范围/快照时间/截断下限必须页面可见，别把「只扫到一部分」的数字当全集。
  const coverageText = usageCoverageText(snapshot)
  const errorSummary = errorSummaryOf(real.error)
  // 近 30 天 = 本地自然日 today-29..today（不能用记录切片：真实数据有缺日会错窗）
  const prevStart = addDaysToDayKey(todayKey, -59)
  const prevEnd = addDaysToDayKey(todayKey, -30)
  const prev30 = days.filter((day) => day.date >= prevStart && day.date <= prevEnd)
  // 卡片/明细直接消费契约 summary（extension 已按近 30 天窗口聚合；UI 不用稀疏 days 重算）
  const totals = snapshot.summary.totals
  const prevTotals = prev30.reduce((acc, day) => ({ tokens: acc.tokens + day.tokens.total, messages: acc.messages + day.messages.user, sessions: acc.sessions + day.sessions }), { tokens: 0, messages: 0, sessions: 0 })
  const heat = useMemo(() => heatmapScaleOf(days.map((day) => metricOf(day, metric))), [days, metric])
  const cells = useMemo(() => {
    if (days.length === 0) return [] as (UsageDay | null)[]
    // spec §3.3：52 周 × 7 行，行=周日→周六；end=今天，start=今天所在周的周日往回 51 周的周日；
    // 今天所在周之后的格不渲染数据（占位透明）。
    const currentSunday = addDaysToDayKey(todayKey, -weekdayOfDayKey(todayKey)) // 0=周日
    const start = addDaysToDayKey(currentSunday, -51 * 7)
    const map = new Map(days.map((day) => [day.date, day]))
    return dayKeyRange(start, addDaysToDayKey(start, 363)).map((date) => (date <= todayKey ? map.get(date) ?? null : null))
  }, [days, todayKey])
  const weeks: (UsageDay | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  const [tip, setTip] = useState<{ day: UsageDay; x: number; y: number; flip: boolean } | null>(null)
  const [focusDate, setFocusDate] = useState<string | null>(null)
  const months = useMemo(() => {
    const result: { key: string; label: string }[] = []
    let lastMonth = ""
    for (const week of weeks) {
      const first = week.find((day): day is UsageDay => day != null)
      if (!first) {
        result.push({ key: `w-${result.length}`, label: "" })
        continue
      }
      const month = first.date.slice(0, 7)
      if (month !== lastMonth) {
        result.push({ key: first.date, label: `${Number(first.date.slice(5, 7))}月` })
        lastMonth = month
      } else result.push({ key: `w-${result.length}`, label: "" })
    }
    return result
  }, [weeks])
  const heatScrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTip(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  useEffect(() => {
    const el = heatScrollRef.current
    if (!el || view !== "daily") return
    // 窄屏初始滚到最近端（今天/密集区）
    el.scrollLeft = el.scrollWidth
  }, [view, cells.length])
  const modelRows = snapshot.summary.models.slice(0, 4)
  const otherTokens = snapshot.summary.models.slice(4).reduce((n, row) => n + row.tokens, 0)
  const modelSum = snapshot.summary.models.reduce((n, row) => n + row.tokens, 0)
  const weekBuckets = useMemo(() => {
    // 周一为一周起点：以今天所在周的周一为锚，向前取 14 个完整/进行中的周
    const todayWeekday = weekdayOfDayKey(todayKey) // 0=周日
    const mondayOffset = (todayWeekday + 6) % 7
    const currentMonday = addDaysToDayKey(todayKey, -mondayOffset)
    const byDay = new Map(days.map((day) => [day.date, day]))
    const list: { start: string; end: string; value: number }[] = []
    for (let i = 13; i >= 0; i--) {
      const start = addDaysToDayKey(currentMonday, -i * 7)
      const end = addDaysToDayKey(start, 6)
      let value = 0
      for (let d = 0; d < 7; d++) {
        const day = byDay.get(addDaysToDayKey(start, d))
        if (day) value += metricOf(day, metric)
      }
      list.push({ start, end: end > todayKey ? todayKey : end, value })
    }
    return list
  }, [days, metric, todayKey])
  const peakWeek = weekBuckets.reduce((best, week) => (week.value > best.value ? week : best), weekBuckets[0] ?? { start: "", end: "", value: 0 })
  const latestWeek = { start: weekBuckets[weekBuckets.length - 1]?.start ?? todayKey, end: todayKey, value: weekBuckets[weekBuckets.length - 1]?.value ?? 0 }
  const cumulative = useMemo(() => {
    let sum = 0
    const points = days.map((day) => (sum += metricOf(day, metric)))
    const max = Math.max(1, sum)
    const step = points.length > 1 ? 100 / (points.length - 1) : 100
    const line = points.map((value, index) => `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${(40 - (value / max) * 36).toFixed(2)}`).join(" ")
    return { line, area: `${line} L100,40 L0,40 Z`, total: sum, start: days[0]?.date ?? null }
  }, [days, metric])
  // 累计视图解读：本月新增 vs 此前月份
  const monthlyTotals = new Map<string, number>()
  for (const day of days) monthlyTotals.set(day.date.slice(0, 7), (monthlyTotals.get(day.date.slice(0, 7)) ?? 0) + metricOf(day, metric))
  const currentMonthKey = todayKey.slice(0, 7)
  const currentMonthValue = monthlyTotals.get(currentMonthKey) ?? 0
  const prevMonths = [...monthlyTotals.entries()].filter(([month]) => month < currentMonthKey).map(([, value]) => value)
  const prevMonthsSum = prevMonths.reduce((n, value) => n + value, 0)
  const prevMonthsAvg = prevMonths.length ? prevMonthsSum / prevMonths.length : 0
  const monthLabel = `${Number(currentMonthKey.slice(5, 7))} 月`
  const cumulativeInsight =
    days.length === 0
      ? ""
      : currentMonthValue === 0
        ? `${monthLabel}还没有新增${METRIC_LABEL[metric]}`
        : prevMonths.length === 0
          ? `本月新增 ${formatTokenCount(currentMonthValue)} ${METRIC_LABEL[metric]}`
          : currentMonthValue > prevMonthsSum
            ? `本月新增 ${formatTokenCount(currentMonthValue)} ${METRIC_LABEL[metric]}，超过此前 ${prevMonths.length} 个月总和`
            : `本月新增 ${formatTokenCount(currentMonthValue)} ${METRIC_LABEL[metric]}，约为此前 ${prevMonths.length} 个月平均的 ${formatPercent(prevMonthsAvg ? currentMonthValue / prevMonthsAvg : 0)}`
  const delta = (current: number, previous: number) => {
    const info = usageDeltaOf(current, previous)
    return short || empty ? "数据积累中" : info.show ? `${info.text} 较前 30 天` : "数据积累中"
  }
  const mostActive = snapshot.summary.peaks.messages
  const tokenPeak = snapshot.summary.peaks.tokens
  const avgMessages = totals.activeDays > 0 ? totals.messagesUser / totals.activeDays : 0
  const forcedReason = previewReason ?? (previewState === "error" ? "timeout" : "unsupported")
  const degradation = forcedDegradation ? REASON_COPY[forcedReason] : !hasSnapshot && !loading ? REASON_COPY[reason ?? "unsupported"] ?? REASON_COPY.unsupported : null
  const overrides = displayOverrides ?? {}
  const yearStart = addDaysToDayKey(todayKey, -364)
  const yearTokens = days.filter((day) => day.date >= yearStart).reduce((n, day) => n + day.tokens.total, 0)
  const monthKey = todayKey.slice(0, 7)
  const monthTokens = days.filter((day) => day.date.startsWith(monthKey)).reduce((n, day) => n + day.tokens.total, 0)
  const yearTokensText = overrides.yearTokensText ?? (yearTokens > 0 ? formatTokenCount(yearTokens) : null)
  const monthShareText = overrides.monthShareText ?? (yearTokens > 0 ? formatPercent(monthTokens / yearTokens) : null)
  const showYearLine = !empty && (yearTokensText != null || monthShareText != null)
  const tokenParts = (tokens: number): { value: string; unit: string } => {
    const text = formatTokenCount(tokens)
    const match = text.match(/^([\d.,]+)([KMB])$/)
    return match ? { value: match[1], unit: match[2] } : { value: text, unit: "" }
  }
  const tokenMain = tokenParts(totals.tokens)
  const summaryCards = [
    { label: "近 30 天 Token 总量", value: tokenMain.value, unit: tokenMain.unit, sub: overrides.tokenDeltaText ?? delta(totals.tokens, prevTotals.tokens) },
    { label: "发送消息数", value: formatCount(totals.messagesUser), unit: "条", sub: delta(totals.messagesUser, prevTotals.messages) },
    { label: "活跃天数", value: String(totals.activeDays), unit: "/ 30 天", sub: short || empty ? `数据积累中 · 已记录 ${days.length} 天` : `占近 30 天的 ${formatPercent((totals.activeDays || 0) / 30)}` },
    { label: "最长连续使用", value: String(snapshot.summary.streaks.longest), unit: "天", sub: `当前已连续 ${snapshot.summary.streaks.current} 天` },
  ]
  if (loading || degradation) {
    const showRetry = !loading && (reason === "timeout" || reason === "invalid" || previewState === "error")
    return (
      <div className={className ? `pi-usage-root ${className}` : "pi-usage-root"} data-theme={theme} data-pi-usage="root" data-pi-usage-activity="page">
        <span hidden data-pi-usage-surface="P10-USAGE-00" />
        <span hidden data-pi-usage-surface="P10-USAGE-13" />
        <span hidden data-pi-usage-surface="P10-USAGE-14" />
        {stale ? (
        <p className="pi-usage-stale" role="status">
          {reason === "device_offline" ? "设备离线，展示上次缓存" : "数据可能不是最新（relay 缓存）"}
        </p>
      ) : null}
      <section className="pi-usage-head" data-pi-usage-surface="P10-USAGE-01">
          <div>
            <h2 className="pi-usage-title">使用活动</h2>
            <p className="pi-usage-subtitle">按设备本地时区自然日统计；Token 为 API 处理量口径</p>
          </div>
        </section>
        <section className="pi-usage-card pi-usage-main" aria-live="polite" data-pi-usage-surface="P10-USAGE-13">
          <h3 className="pi-usage-card-title">{loading ? "正在读取本机使用数据…" : degradation?.title}</h3>
          <p className="pi-usage-empty-line">{loading ? "正在从设备读取聚合后的使用活动（不会显示演示数据）。" : degradation?.body}</p>
          {!loading && reason === "invalid" && errorSummary ? (
            <p className="pi-usage-error" role="status" data-pi-usage-error>
              {errorSummary}
            </p>
          ) : null}
          {!loading && (reason === "unsupported" || reason === "timeout" || reason === "invalid" || previewState === "error" || previewState === "unavailable") ? (
            <p className="pi-usage-footnote">
              <span>数据口径见项目文档（未随本仓库提供）</span>
              {showRetry ? (
                <button type="button" className="pi-usage-retry" onClick={real.refresh}>
                  重试
                </button>
              ) : null}
            </p>
          ) : null}
        </section>
      </div>
    )
  }
  return (
    <div className={className ? `pi-usage-root ${className}` : "pi-usage-root"} data-theme={theme} data-pi-usage="root" data-pi-usage-activity="page">
      <span hidden data-pi-usage-surface="P10-USAGE-00" />
      <span hidden data-pi-usage-surface="P10-USAGE-11" />
      {short ? <span hidden data-pi-usage-surface="P10-USAGE-10" /> : null}
      {stale ? (
        <p className="pi-usage-stale" role="status">
          {reason === "device_offline" ? "设备离线，展示上次缓存" : "数据可能不是最新（relay 缓存）"}
        </p>
      ) : null}
      <section className="pi-usage-head" data-pi-usage-surface="P10-USAGE-01">
        <div>
          <h2 className="pi-usage-title">使用活动</h2>
          <p className="pi-usage-subtitle">
            按设备本地时区自然日统计；Token 为 API 处理量口径{snapshot.cache.hit ? "（缓存）" : ""}
          </p>
        </div>
        <div className="pi-usage-switches">
          <div
            className="pi-usage-seg"
            role="radiogroup"
            aria-label="统计指标"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
              event.preventDefault()
              const ids: UsageMetric[] = ["tokens", "messages", "sessions"]
              const index = ids.indexOf(metric)
              setMetric(ids[(index + (event.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length])
            }}
          >
            {(Object.keys(METRIC_LABEL) as UsageMetric[]).map((id) => (
              <button key={id} type="button" role="radio" aria-checked={metric === id} data-active={metric === id ? "" : undefined} onClick={() => setMetric(id)}>
                {METRIC_LABEL[id]}
              </button>
            ))}
          </div>
          <div
            className="pi-usage-seg"
            role="radiogroup"
            aria-label="查看方式"
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
              event.preventDefault()
              const ids: UsageViewMode[] = ["daily", "weekly", "cumulative"]
              const index = ids.indexOf(view)
              setView(ids[(index + (event.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length])
            }}
          >
            {(Object.keys(VIEW_LABEL) as UsageViewMode[]).map((id) => (
              <button key={id} type="button" role="radio" aria-checked={view === id} data-active={view === id ? "" : undefined} onClick={() => setView(id)}>
                {VIEW_LABEL[id]}
              </button>
            ))}
          </div>
        </div>
      </section>
      {coverageText ? (
        <p className="pi-usage-coverage" data-pi-usage-coverage>
          {coverageText}
        </p>
      ) : null}
      <section className="pi-usage-stats" aria-label="近 30 天汇总" data-pi-usage-surface="P10-USAGE-02">
        {summaryCards.map((card) => (
          <div key={card.label} className="pi-usage-card pi-usage-stat">
            <p className="pi-usage-stat-label">{card.label}</p>
            <p className="pi-usage-stat-value">
              {card.value}
              {card.unit ? <span className="pi-usage-stat-unit">{card.unit}</span> : null}
            </p>
            <p className="pi-usage-stat-sub">{card.sub}</p>
          </div>
        ))}
      </section>
      <section className="pi-usage-card pi-usage-main" aria-label={`${METRIC_LABEL[metric]} 活动`}>
        <div className="pi-usage-main-head">
          <h3 className="pi-usage-card-title">{METRIC_LABEL[metric]} 活动</h3>
          <span className="pi-usage-hint">{view === "daily" ? "近一年 · 按分位数分档" : view === "weekly" ? "近 14 周" : "有记录起累计"}</span>
        </div>
        {empty ? (
          <div className="pi-usage-empty" data-pi-usage-surface="P10-USAGE-09">
            <div className="pi-usage-empty-grid" aria-hidden>
              {Array.from({ length: 7 * 52 }, (_, i) => (
                <span key={i} className="pi-usage-cell" data-level="0" />
              ))}
            </div>
            <p className="pi-usage-empty-line">开始和 pi 对话后，这里会出现你的使用活动。</p>
          </div>
        ) : view === "daily" ? (
          <div className="pi-usage-heat" data-pi-usage-surface="P10-USAGE-03">
            <div className="pi-usage-heat-scroll" ref={heatScrollRef} onPointerDown={(event) => { if (event.currentTarget === event.target) setTip(null) }}>
              <div
                className="pi-usage-heat-grid"
                role="group"
                aria-label="每日使用热力图"
                onKeyDown={(event) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
                  const cell = (event.target as HTMLElement).closest(".pi-usage-cell") as HTMLElement | null
                  const date = cell?.dataset.date
                  if (!date) return
                  event.preventDefault()
                  const delta = event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : event.key === "ArrowLeft" ? -1 : 1
                  const index = cells.findIndex((day) => day?.date === date)
                  if (index < 0) return
                  const nextDay = cells[Math.max(0, Math.min(cells.length - 1, index + delta))]
                  if (!nextDay) return
                  setFocusDate(nextDay.date)
                  const scope = (event.currentTarget as HTMLElement).querySelector(`[data-date="${nextDay.date}"]`) as HTMLElement | null
                  scope?.focus()
                }}
              >
                {weeks.map((week, wi) => (
                  <div key={wi} className="pi-usage-heat-col">
                    {Array.from({ length: 7 }, (_, di) => {
                      const day = week[di]
                      const level = day ? heat.bucketOf(metricOf(day, metric)) : 0
                      return (
                        <button
                          key={di}
                          type="button"
                          className="pi-usage-cell"
                          data-level={level}
                          data-date={day?.date}
                          data-today={day?.date === todayKey ? "" : undefined}
                          tabIndex={day && (focusDate ? day.date === focusDate : day.date === todayKey) ? 0 : -1}
                          aria-label={day ? `${formatDayHuman(day.date)}：${formatTokenCount(day.tokens.total)} Token / ${formatCount(day.messages.user)} 消息 / ${formatCount(day.sessions)} 会话` : "无数据"}
                          onFocus={(event) => {
                            if (!day) return
                            const rect = event.currentTarget.getBoundingClientRect()
                            setFocusDate(day.date)
                            setTip({ day, x: Math.max(8, rect.left), y: Math.max(44, rect.top), flip: rect.left < 190 })
                          }}
                          onBlur={() => setTip(null)}
                          onMouseEnter={(event) => {
                            if (!day) return
                            const rect = event.currentTarget.getBoundingClientRect()
                            setTip({ day, x: Math.max(8, rect.left), y: Math.max(44, rect.top), flip: rect.left < 190 })
                          }}
                          onClick={(event) => {
                            if (!day) return
                            const rect = event.currentTarget.getBoundingClientRect()
                            setTip({ day, x: Math.max(8, rect.left), y: Math.max(44, rect.top), flip: rect.left < 190 })
                          }}
                          onMouseLeave={() => setTip(null)}
                        />
                      )
                    })}
                  </div>
                ))}
              </div>
            <div className="pi-usage-months" aria-hidden>
              {months.map((month) => (
                <span key={month.key} className="pi-usage-month">{month.label}</span>
              ))}
            </div>
              {tip ? (
                <div className="pi-usage-tip" data-flip={tip.flip ? "" : undefined} style={{ left: tip.x, top: tip.y }} role="tooltip" data-pi-usage-surface="P10-USAGE-08">
                  <p className="pi-usage-tip-date">{formatDayHuman(tip.day.date)}</p>
                  <p className="pi-usage-tip-values">
                    {formatTokenCount(tip.day.tokens.total)} Token · {formatCount(tip.day.messages.user)} 消息 · {formatCount(tip.day.sessions)} 会话
                  </p>
                </div>
              ) : null}
            </div>
            <div className="pi-usage-legend">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <span key={level} className="pi-usage-legend-cell" data-level={level} />
              ))}
              <span>多</span>
            </div>
          </div>
        ) : view === "weekly" ? (
          <div className="pi-usage-week" data-pi-usage-surface="P10-USAGE-04">
            <div className="pi-usage-bars">
              {weekBuckets.map((week) => (
                <div key={week.start} className="pi-usage-bar-col" title={`${week.start} ~ ${week.end}`}>
                  <div className="pi-usage-bar" data-peak={week.start === peakWeek.start ? "" : undefined} style={{ height: `${Math.max(2, Math.round((week.value / Math.max(1, peakWeek.value)) * 100))}%` }} />
                </div>
              ))}
            </div>
            <p className="pi-usage-chart-note">
              近 14 周（周一为一周起点）；峰值周 {formatDayHuman(peakWeek.start)} ~ {formatDayHuman(peakWeek.end)}：{formatTokenCount(peakWeek.value)} {METRIC_LABEL[metric]}；本周 {formatDayHuman(latestWeek.start)} 至今：{formatTokenCount(latestWeek.value)}
            </p>
          </div>
        ) : (
          <div className="pi-usage-cum" data-pi-usage-surface="P10-USAGE-05">
            <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="pi-usage-area" role="img" aria-label="累计总量面积曲线">
              <path d={cumulative.area} className="pi-usage-area-fill" />
              <path d={cumulative.line} className="pi-usage-area-line" />
            </svg>
            <p className="pi-usage-chart-note">
              从 {cumulative.start ?? "—"} 起累计到今天的 {METRIC_LABEL[metric]}总量：{formatTokenCount(cumulative.total)}
              {days.length < 30 ? "（数据积累中）" : ""}
            </p>
            <p className="pi-usage-chart-note">{cumulativeInsight}</p>
          </div>
        )}
      </section>
      <div className="pi-usage-detail-grid">
        <section className="pi-usage-card" aria-label="明细" data-pi-usage-surface="P10-USAGE-06">
          <h3 className="pi-usage-card-title">明细</h3>
          <div className="pi-usage-detail-row">
            <span>最活跃的一天</span>
            <span>
              {mostActive
                ? `${formatDayHuman(mostActive.date)} · ${formatCount(mostActive.value)} 条消息 · ${formatCount(days.find((day) => day.date === mostActive.date)?.sessions ?? 0)} 次会话`
                : "—"}
            </span>
          </div>
          <div className="pi-usage-detail-row">
            <span>单日 Token 峰值</span>
            <span className="pi-usage-peak">{overrides.peakTokensText ?? (tokenPeak ? `${formatTokenCount(tokenPeak.value)} · ${formatDayHuman(tokenPeak.date)}` : "—")}</span>
          </div>
          <div className="pi-usage-detail-row">
            <span>平均每日消息（按活跃日）</span>
            <span>{avgMessages > 0 ? `${avgMessages.toFixed(1)} 条` : "—"}</span>
          </div>
        </section>
        <section className="pi-usage-card" aria-label="按模型分布" data-pi-usage-surface="P10-USAGE-07">
          <h3 className="pi-usage-card-title">按模型分布（近 30 天 Token 占比）</h3>
          {[...modelRows.map((row) => ({ label: `${row.model}`, tokens: row.tokens })), ...(otherTokens > 0 ? [{ label: "其他", tokens: otherTokens }] : [])].map((row, index) => (
            <div key={row.label} className="pi-usage-model-row">
              <span className="pi-usage-model-name">{row.label}</span>
              <span className="pi-usage-model-bar">
                <span className="pi-usage-model-fill" data-rank={index} style={{ width: `${modelSum ? Math.round((row.tokens / modelSum) * 100) : 0}%` }} />
              </span>
              <span className="pi-usage-model-pct">{formatPercent(modelSum ? row.tokens / modelSum : 0)}</span>
            </div>
          ))}
          {modelRows.length === 0 ? <p className="pi-usage-empty-line">还没有模型使用数据。</p> : null}
        </section>
      </div>
      {showYearLine ? (
        <p className="pi-usage-fixture-stats">
          近一年共使用 {yearTokensText ?? "—"} Token · 其中 {Number(todayKey.slice(5, 7))} 月占 {monthShareText ?? "—"}
        </p>
      ) : null}
      <p className="pi-usage-footnote">
        统计仅在本机聚合；经 relay 传输与缓存的只有每日聚合计数（tokens / 消息 / 会话 / 模型名），不含对话内容；金额不统计。Token 为 API 处理量（每轮会重报上下文）；时间按设备本地时区自然日切分，仅统计现存会话。
        {real.error && !provided ? (real.snapshot ? "（部分异常数据已跳过）" : "（读取失败，可稍后重试）") : ""}
      </p>
    </div>
  )
}

export { USAGE_MODELS_MAX }
