/**
 * 设置 › 使用活动（设计册 §12 / 源码 settings-set-usage.html）。
 *
 * 数据：直接复用 ui/src/pi/usage 的真实链路（useUsageActivity → relay.getUsage → usage.activity.v1），
 * 不在页面里造数；空态 / 旧 relay / 设备离线 / 超时都按 hook 的 reason 诚实呈现。
 * 口径：Token 按 API 处理量计、分天按设备本地时区、同一份会话记录只算一遍；**不显示费用**。
 * 布局：本页在 SETTINGS_PAGE_META.usage.wide = true，外壳给 880 内容列（其余页 692）。
 * 颜色：数据色全走 --st-accent；陶土高亮两点（今天格描边、单日峰值）固定陶土色。
 */
import { useState, type CSSProperties, type ReactNode } from "react"
import {
  addDaysToDayKey,
  dayKeyRange,
  formatCount,
  formatPercent,
  formatTokenCount,
  heatmapScaleOf,
  MONTHLY_BUDGET_PRESETS,
  monthlyBudgetPresetLabel,
  monthlyQuotaSummaryOf,
  usageCoverageText,
  usageDeltaOf,
  usageTodayDayKey,
  useUsageActivity,
  weekdayOfDayKey,
  type UsageDay,
  type UsageSnapshotV1,
} from "@/pi/usage"
import { settingsDeviceOfflineOf } from "../model"
import { useSettings } from "../SettingsContext"
import type { SettingsUsageMetric, SettingsUsageRange } from "../types"
import { SettingsHoverTitle, SettingsSegmented } from "../ui"
import "./usage.css"

const HEAT_LABEL: Record<SettingsUsageMetric, string> = { tokens: "Token 活动", messages: "消息活动", sessions: "会话活动" }
const METRIC_UNIT: Record<SettingsUsageMetric, string> = { tokens: "Token", messages: "条消息", sessions: "次会话" }
const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

const METRIC_OPTIONS = [
  { value: "messages", label: "消息数" },
  { value: "tokens", label: "Token" },
  { value: "sessions", label: "会话数" },
] as const satisfies readonly { value: SettingsUsageMetric; label: string }[]

const VIEW_OPTIONS = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "cumulative", label: "累计总量" },
] as const satisfies readonly { value: SettingsUsageRange; label: string }[]

const REASON_COPY: Record<string, { title: string; body: string }> = {
  unsupported: {
    title: "使用活动数据不可用",
    body: "当前 pi 扩展 / relay 版本不支持使用活动数据（usage.activity.v1），升级后即可查看。",
  },
  no_data: { title: "还没有使用活动", body: "开始和 pi 对话后，这里会出现你的使用活动。" },
  device_offline: {
    title: "设备离线，暂无可展示数据",
    body: "设备当前不在线，且没有可用缓存；连接恢复后会自动更新。",
  },
  timeout: { title: "读取超时", body: "读取本机使用数据超时，可稍后重试。" },
  stale: { title: "数据可能不是最新", body: "展示的是 relay 缓存数据，设备恢复连接后会自动更新。" },
  invalid: { title: "使用活动数据读取失败", body: "设备上报的聚合数据没有通过校验，已拒绝展示；可重试或等设备重新生成快照。" },
}

function metricValueOf(day: UsageDay, metric: SettingsUsageMetric): number {
  return metric === "tokens" ? day.tokens.total : metric === "messages" ? day.messages.user : day.sessions
}

function metricTextOf(value: number, metric: SettingsUsageMetric): string {
  return metric === "tokens" ? formatTokenCount(value) : formatCount(value)
}

function formatDayHuman(dayKey: string): string {
  return `${formatDayDate(dayKey)} · ${formatDayWeekday(dayKey)}`
}

function formatDayDate(dayKey: string): string {
  const [, month, day] = dayKey.split("-").map(Number)
  return `${month}月${day}日`
}

function formatDayWeekday(dayKey: string): string {
  return WEEKDAY_LABEL[weekdayOfDayKey(dayKey)]
}

function tokenParts(tokens: number): { value: string; unit: string } {
  const text = formatTokenCount(tokens)
  const match = text.match(/^([\d.,]+)([KMB])$/)
  return match ? { value: match[1], unit: match[2] } : { value: text, unit: "" }
}

function errorSummaryOf(error: string | null): string | null {
  if (!error) return null
  const text = error.replace(/\s+/g, " ").trim()
  if (!text) return null
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

export function UsagePage() {
  const { p, prefs, act } = useSettings()
  const { relay } = p
  const metric = prefs.usageMetric
  const view = prefs.usageRange
  const deviceId = relay.selectedDeviceId ?? relay.selectedDevice?.id ?? undefined
  const usage = useUsageActivity(relay, { deviceId })
  const snapshot: UsageSnapshotV1 | null = usage.snapshot
  // 离线或 relay 回缓存时，指标 / 查看方式仍可切但会让人以为数据是实时的；明确标缓存态并锁定分段。
  const deviceOffline = settingsDeviceOfflineOf(relay)
  const offlineCache = deviceOffline || usage.stale || usage.reason === "device_offline"
  const offlineText = deviceOffline
    ? "设备离线，显示上次缓存的数据（可能不是最新）；统计指标 / 查看方式已锁定，连接恢复后自动更新。"
    : "数据可能不是最新（relay 缓存）；统计指标 / 查看方式已锁定，设备恢复连接后自动更新。"
  const [tip, setTip] = useState<{ date: string; day: UsageDay | null; x: number; y: number } | null>(null)

  const showTip = (date: string, day: UsageDay | null, element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    setTip({ date, day, x: rect.left + rect.width / 2, y: rect.top - 8 })
  }

  const header = (
    <header className="settings-usage-head">
      <div>
        <h1 className="settings-page-title">
          <SettingsHoverTitle tooltip="由运行 pi 的设备在本地按自然日统计（Token 按 API 处理量计），经中转仅同步每日聚合计数；分天按设备本地时区，中转侧的镜像副本不重复计。">
            使用活动
          </SettingsHoverTitle>
        </h1>
      </div>
      <div className="settings-usage-controls">
        <div className="settings-usage-control">
          <span className="settings-usage-control-label">统计指标</span>
          <SettingsSegmented
            label="统计指标"
            value={metric}
            options={METRIC_OPTIONS}
            disabled={offlineCache}
            onChange={(value) => act.setPref("usageMetric", value)}
          />
        </div>
        <div className="settings-usage-control">
          <span className="settings-usage-control-label">查看方式</span>
          <SettingsSegmented
            label="查看方式"
            value={view}
            options={VIEW_OPTIONS}
            disabled={offlineCache}
            onChange={(value) => act.setPref("usageRange", value)}
          />
        </div>
      </div>
    </header>
  )

  if (!snapshot) {
    // 第一次渲染时 hook 还没跑 effect（loading=false、reason=null），按读取中处理，避免闪一下空态。
    const loading = usage.loading || usage.reason == null
    const reason = usage.reason ?? "no_data"
    const copy = REASON_COPY[reason] ?? REASON_COPY.no_data
    const error = errorSummaryOf(usage.error)
    return (
      <div className="settings-page settings-usage" data-settings-page="usage">
        {header}
        {offlineCache ? (
          <p className="settings-usage-stale" role="status" data-settings-usage-offline={deviceOffline ? "device" : "cache"}>
            {offlineText}
          </p>
        ) : null}
        <section className="settings-usage-card settings-usage-state" aria-live="polite">
          <h2 className="settings-usage-state-title">{loading ? "正在读取本机使用数据…" : copy.title}</h2>
          <p className="settings-usage-state-body">
            {loading ? "正在从设备读取聚合后的使用活动，不会显示演示数据。" : copy.body}
          </p>
          {!loading && error && (reason === "invalid" || reason === "timeout") ? (
            <p className="settings-usage-state-error">{error}</p>
          ) : null}
          {!loading && (reason === "timeout" || reason === "invalid") ? (
            <button type="button" className="settings-usage-retry" onClick={usage.refresh}>
              重试
            </button>
          ) : null}
        </section>
      </div>
    )
  }

  const days = snapshot.days
  const empty = days.length === 0
  const todayKey = usageTodayDayKey(snapshot)
  const quotaSummary = monthlyQuotaSummaryOf(snapshot, todayKey, prefs.monthlyTokenBudget)
  // days 只含有记录的日子（稀疏）：按首个记录日算历史长短，不按条数——低频用户记录少不等于数据还在积累。
  const short = !empty && days[0].date > addDaysToDayKey(todayKey, -29)
  const totals = snapshot.summary.totals
  const prevStart = addDaysToDayKey(todayKey, -59)
  const prevEnd = addDaysToDayKey(todayKey, -30)
  const prev30 = days.filter((day) => day.date >= prevStart && day.date <= prevEnd)
  const prevTotals = prev30.reduce(
    (acc, day) => ({ tokens: acc.tokens + day.tokens.total, messages: acc.messages + day.messages.user }),
    { tokens: 0, messages: 0 },
  )
  const tokenMain = tokenParts(totals.tokens)
  const deltaNode = (current: number, previous: number): ReactNode => {
    if (short || empty) return "数据积累中"
    const info = usageDeltaOf(current, previous)
    if (!info.show) return "数据积累中"
    return (
      <>
        <span className={info.dir === "up" ? "settings-usage-up" : "settings-usage-flat"}>{info.text}</span> 较前 30 天
      </>
    )
  }
  const summaryCards: { label: string; value: string; unit: string; sub: ReactNode }[] = [
    { label: "近 30 天 Token 总量", value: tokenMain.value, unit: tokenMain.unit, sub: deltaNode(totals.tokens, prevTotals.tokens) },
    { label: "发送消息数", value: formatCount(totals.messagesUser), unit: "条", sub: deltaNode(totals.messagesUser, prevTotals.messages) },
    {
      label: "活跃天数",
      value: String(totals.activeDays),
      unit: "/ 30 天",
      sub: short || empty ? (
        <>
          数据积累中 · 已记录 <span className="settings-usage-flat">{days.length} 天</span>
        </>
      ) : (
        <>
          占近 30 天的 <span className="settings-usage-flat">{formatPercent(totals.activeDays / 30)}</span>
        </>
      ),
    },
    {
      label: "最长连续使用",
      value: String(snapshot.summary.streaks.longest),
      unit: "天",
      sub: (
        <>
          当前已连续 <span className="settings-usage-flat">{snapshot.summary.streaks.current} 天</span>
        </>
      ),
    },
  ]

  const currentSunday = addDaysToDayKey(todayKey, -weekdayOfDayKey(todayKey))
  const heatStart = addDaysToDayKey(currentSunday, -51 * 7)
  const byDate = new Map(days.map((day) => [day.date, day]))
  const cells = dayKeyRange(heatStart, addDaysToDayKey(heatStart, 363)).map((date) => ({
    date,
    day: date <= todayKey ? byDate.get(date) ?? null : null,
  }))
  const weeks: (typeof cells)[] = []
  for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7))
  const monthLabels: { key: string; label: string }[] = []
  let lastMonth = ""
  let lastLabelIndex = -1
  for (const week of weeks) {
    const first = week[0]?.date ?? ""
    const month = first.slice(0, 7)
    if (month !== lastMonth) {
      // 首列常是上个月的零头：离下一个月份标签不足 3 列时让位，免得两个标签叠在一起。
      const previous = monthLabels[lastLabelIndex]
      if (previous && monthLabels.length - lastLabelIndex < 3) previous.label = ""
      lastLabelIndex = monthLabels.length
      monthLabels.push({ key: first, label: first ? `${Number(first.slice(5, 7))}月` : "" })
      lastMonth = month
    } else {
      monthLabels.push({ key: first || `w-${monthLabels.length}`, label: "" })
    }
  }
  const heat = heatmapScaleOf(days.map((day) => metricValueOf(day, metric)))
  const coverage = usageCoverageText(snapshot)
  const coverageWarn =
    snapshot.coverage.truncated || snapshot.coverage.skippedFiles > 0 || snapshot.coverage.errors > 0

  const todayWeekday = weekdayOfDayKey(todayKey)
  const mondayOffset = (todayWeekday + 6) % 7
  const currentMonday = addDaysToDayKey(todayKey, -mondayOffset)
  const weekBuckets: { start: string; end: string; value: number }[] = []
  for (let index = 13; index >= 0; index--) {
    const start = addDaysToDayKey(currentMonday, -index * 7)
    const end = addDaysToDayKey(start, 6)
    let value = 0
    for (let offset = 0; offset < 7; offset++) {
      const day = byDate.get(addDaysToDayKey(start, offset))
      if (day) value += metricValueOf(day, metric)
    }
    weekBuckets.push({ start, end: end > todayKey ? todayKey : end, value })
  }
  const peakWeek = weekBuckets.reduce((best, week) => (week.value > best.value ? week : best), weekBuckets[0] ?? { start: "", end: "", value: 0 })
  const latestWeek = weekBuckets[weekBuckets.length - 1] ?? { start: todayKey, end: todayKey, value: 0 }

  const cumulativePoints = days.reduce<number[]>((points, day) => {
    const previous = points.length > 0 ? points[points.length - 1] : 0
    points.push(previous + metricValueOf(day, metric))
    return points
  }, [])
  const cumulativeValue = cumulativePoints[cumulativePoints.length - 1] ?? 0
  const cumulativeMax = Math.max(1, cumulativeValue)
  const cumulativeStep = cumulativePoints.length > 1 ? 100 / (cumulativePoints.length - 1) : 100
  const cumulativeLine = cumulativePoints
    .map((value, index) => `${index === 0 ? "M" : "L"}${(index * cumulativeStep).toFixed(2)},${(40 - (value / cumulativeMax) * 36).toFixed(2)}`)
    .join(" ")
  const cumulativeArea = `${cumulativeLine} L100,40 L0,40 Z`

  const mostActive = snapshot.summary.peaks.messages
  const tokenPeak = snapshot.summary.peaks.tokens
  const mostActiveDay = mostActive ? days.find((day) => day.date === mostActive.date) ?? null : null
  const averageMessages = totals.activeDays > 0 ? totals.messagesUser / totals.activeDays : 0
  const modelRows = snapshot.summary.models.slice(0, 4)
  const otherTokens = snapshot.summary.models.slice(4).reduce((sum, row) => sum + row.tokens, 0)
  const modelSum = snapshot.summary.models.reduce((sum, row) => sum + row.tokens, 0)

  return (
    <div className="settings-page settings-usage" data-settings-page="usage">
      {header}
      {offlineCache ? (
        <p className="settings-usage-stale" role="status" data-settings-usage-offline={deviceOffline ? "device" : "cache"}>
          {offlineText}
        </p>
      ) : null}
      {coverage && coverageWarn ? <p className="settings-usage-coverage">{coverage}</p> : null}

      <section className="settings-usage-stats" aria-label="近 30 天汇总">
        {summaryCards.map((card) => (
          <div key={card.label} className="settings-usage-card settings-usage-stat">
            <p className="settings-usage-stat-label">
              <span className="settings-usage-dot" aria-hidden="true" />
              {card.label}
            </p>
            <p className="settings-usage-stat-value">
              {card.value}
              {card.unit ? <span className="settings-usage-stat-unit">{card.unit}</span> : null}
            </p>
            <p className="settings-usage-stat-sub">{card.sub}</p>
          </div>
        ))}
      </section>

      <section className="settings-usage-card settings-usage-quota" aria-label="本月用量与供应商预算">
        <div className="settings-usage-quota-head">
          <span className="settings-usage-quota-title">
            <SettingsHoverTitle tooltip="本地月度 Token 提醒阈值，仅保存在当前浏览器，不限制实际模型调用。">
              本月用量 · 供应商
            </SettingsHoverTitle>
          </span>
          <div className="settings-usage-quota-presets" role="group" aria-label="月度 Token 预算">
            {MONTHLY_BUDGET_PRESETS.map((preset) => {
              const active = prefs.monthlyTokenBudget === preset
              return (
                <button
                  key={preset}
                  type="button"
                  aria-pressed={active}
                  className={active ? "settings-usage-quota-preset is-active" : "settings-usage-quota-preset"}
                  onClick={() => act.setPref("monthlyTokenBudget", preset)}
                >
                  {monthlyBudgetPresetLabel(preset)}
                </button>
              )
            })}
          </div>
        </div>
        <p className="settings-usage-quota-sub">
          {quotaSummary.budgetTokens > 0
            ? `${quotaSummary.monthLabel}已用 ${formatTokenCount(quotaSummary.monthTokens)} / 预算 ${formatTokenCount(quotaSummary.budgetTokens)} Token（${formatPercent(quotaSummary.usageRatio ?? 0)}）`
            : `${quotaSummary.monthLabel}累计 ${formatTokenCount(quotaSummary.monthTokens)} Token · ${quotaSummary.activeDays} 个活跃日`}
        </p>
        <div className="settings-usage-quota-bar" aria-hidden="true">
          <span
            className={quotaSummary.overBudget ? "is-over" : undefined}
            style={{
              width: `${quotaSummary.budgetTokens > 0 ? Math.min(100, Math.round((quotaSummary.usageRatio ?? 0) * 100)) : quotaSummary.monthTokens > 0 ? 100 : 0}%`,
            }}
          />
        </div>
        {quotaSummary.topProviders.length > 0 ? (
          <div className="settings-usage-quota-providers">
            {quotaSummary.topProviders.map((row) => (
              <div key={row.provider} className="settings-usage-quota-provider">
                <span className="settings-usage-quota-provider-name">{row.provider}</span>
                <span className="settings-usage-quota-provider-val">
                  {formatTokenCount(row.tokens)} · {formatPercent(row.share)}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="settings-usage-quota-foot">
          <span>
            本月会话 {formatCount(quotaSummary.monthSessions)} · 消息 {formatCount(quotaSummary.monthMessages)}
          </span>
          <span>{quotaSummary.resetLabel}</span>
        </div>
      </section>

      <section className="settings-usage-card settings-usage-heat-card" aria-label={HEAT_LABEL[metric]}>
        <div className="settings-usage-heat-head">
          <h2 className="settings-usage-card-title">{HEAT_LABEL[metric]}</h2>
        </div>
        {view === "daily" ? (
          empty ? (
            <div className="settings-usage-empty">
              <p className="settings-usage-empty-title">还没有使用活动</p>
              <p className="settings-usage-empty-body">开始和 pi 对话后，这里会出现你的使用活动。</p>
            </div>
          ) : (
            <div className="settings-usage-heat">
              <div className="settings-usage-heat-scroll">
                <div
                  className="settings-usage-heat-grid"
                  role="group"
                  aria-label="每日使用热力图"
                  onKeyDown={(event) => {
                    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return
                    const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-usage-date]")
                    const date = cell?.dataset.usageDate
                    if (!date) return
                    event.preventDefault()
                    const delta = event.key === "ArrowUp" ? -7 : event.key === "ArrowDown" ? 7 : event.key === "ArrowLeft" ? -1 : 1
                    const index = cells.findIndex((item) => item.date === date)
                    if (index < 0) return
                    const next = cells[Math.max(0, Math.min(cells.length - 1, index + delta))]
                    if (!next) return
                    const grid = (event.currentTarget as HTMLElement).closest(".settings-usage-heat-scroll")
                    const target = grid?.querySelector<HTMLElement>(`[data-usage-date="${next.date}"]`)
                    target?.focus()
                  }}
                >
                  {weeks.map((week, weekIndex) => (
                    <div key={weekIndex} className="settings-usage-heat-week">
                      {Array.from({ length: 7 }, (_, dayIndex) => {
                        const cell = week[dayIndex]
                        if (!cell) return <span key={dayIndex} className="settings-usage-cell" data-level="0" />
                        const level = cell.day ? heat.bucketOf(metricValueOf(cell.day, metric)) : 0
                        const isToday = cell.date === todayKey
                        return (
                          <button
                            key={cell.date}
                            type="button"
                            className="settings-usage-cell"
                            data-level={level}
                            data-today={isToday ? "" : undefined}
                            data-usage-date={cell.date}
                            tabIndex={isToday ? 0 : -1}
                            aria-label={
                              cell.day
                                ? `${formatDayHuman(cell.date)}：${formatTokenCount(cell.day.tokens.total)} Token / ${formatCount(cell.day.messages.user)} 条消息 / ${formatCount(cell.day.sessions)} 次会话`
                                : `${formatDayHuman(cell.date)}：无数据`
                            }
                            onFocus={(event) => showTip(cell.date, cell.day, event.currentTarget)}
                            onBlur={() => setTip(null)}
                            onMouseEnter={(event) => showTip(cell.date, cell.day, event.currentTarget)}
                            onMouseLeave={() => setTip(null)}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
                <div
                  className="settings-usage-months"
                  aria-hidden="true"
                  style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` } as CSSProperties}
                >
                  {monthLabels.map((month) => (
                    <span key={month.key} className="settings-usage-month">
                      {month.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )
        ) : view === "weekly" ? (
          empty ? (
            <div className="settings-usage-empty">
              <p className="settings-usage-empty-title">还没有使用活动</p>
              <p className="settings-usage-empty-body">开始和 pi 对话后，这里会出现你的每周使用活动。</p>
            </div>
          ) : (
            <div className="settings-usage-week">
              <div className="settings-usage-bars">
                {weekBuckets.map((week) => (
                  <div key={week.start} className="settings-usage-bar-col" title={`${week.start} ~ ${week.end}`}>
                    <span
                      className="settings-usage-bar"
                      data-peak={week.start === peakWeek.start ? "" : undefined}
                      style={{ height: `${Math.max(2, Math.round((week.value / Math.max(1, peakWeek.value)) * 100))}%` }}
                    />
                  </div>
                ))}
              </div>
              <p className="settings-usage-chart-note">
                近 14 周（周一为一周起点）；峰值周 {formatDayHuman(peakWeek.start)} ~ {formatDayHuman(peakWeek.end)}：
                {metricTextOf(peakWeek.value, metric)} {METRIC_UNIT[metric]}；本周 {formatDayHuman(latestWeek.start)} 至今：
                {metricTextOf(latestWeek.value, metric)}
              </p>
            </div>
          )
        ) : (
          <div className="settings-usage-cumulative">
            {empty ? (
              <p className="settings-usage-empty-body">开始和 pi 对话后，这里会出现累计曲线。</p>
            ) : (
              <>
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="settings-usage-area" role="img" aria-label="累计总量面积曲线">
                  <path d={cumulativeArea} className="settings-usage-area-fill" />
                  <path d={cumulativeLine} className="settings-usage-area-line" />
                </svg>
                <p className="settings-usage-chart-note">
                  {days[0]?.date ?? "—"} 至 {todayKey} 累计 {metricTextOf(cumulativeValue, metric)} {METRIC_UNIT[metric]}
                  {short ? "（数据积累中）" : ""}
                </p>
              </>
            )}
          </div>
        )}
      </section>

      <div className="settings-usage-detail-grid">
        <section className="settings-usage-card settings-usage-detail" aria-label="明细">
          <h2 className="settings-usage-card-title">明细</h2>
          <div className="settings-usage-detail-row">
            <span>最活跃的一天</span>
            <span className="settings-usage-detail-value">
              {mostActive ? (
                <>
                  {formatDayDate(mostActive.date)}
                  <small>
                    {formatDayWeekday(mostActive.date)} · {formatCount(mostActive.value)} 条消息 · {formatCount(mostActiveDay?.sessions ?? 0)} 次会话
                  </small>
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="settings-usage-detail-row">
            <span>单日 Token 峰值</span>
            <span className="settings-usage-detail-value settings-usage-peak">
              {tokenPeak ? (
                <>
                  {formatTokenCount(tokenPeak.value)}
                  <small>
                    {formatDayDate(tokenPeak.date)} · {formatDayWeekday(tokenPeak.date)}
                  </small>
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
          <div className="settings-usage-detail-row">
            <SettingsHoverTitle tooltip="仅按近 30 天内有消息记录的活跃日折算平均值。">
              平均每日消息
            </SettingsHoverTitle>
            <span className="settings-usage-detail-value">
              {averageMessages > 0 ? `${averageMessages.toFixed(1)} 条` : "—"}
            </span>
          </div>
        </section>

        <section className="settings-usage-card settings-usage-models" aria-label="按模型分布">
          <h2 className="settings-usage-card-title">
            <SettingsHoverTitle tooltip="按近 30 天各模型的 Token 处理量占比统计。">按模型分布</SettingsHoverTitle>
          </h2>
          {modelRows.length === 0 ? (
            <p className="settings-usage-empty-body">还没有模型使用数据。</p>
          ) : (
            <>
              {modelRows.map((row, index) => (
                <div key={`${row.provider}/${row.model}`} className="settings-usage-model-row">
                  <span className="settings-usage-model-top">
                    <span className="settings-usage-model-name">{row.model}</span>
                    <span className="settings-usage-model-pct">{formatPercent(modelSum > 0 ? row.tokens / modelSum : 0)}</span>
                  </span>
                  <span className="settings-usage-model-bar">
                    <span
                      className="settings-usage-model-fill"
                      data-rank={index}
                      style={{ width: `${modelSum > 0 ? Math.round((row.tokens / modelSum) * 100) : 0}%` }}
                    />
                  </span>
                </div>
              ))}
              {otherTokens > 0 ? (
                <div className="settings-usage-model-row">
                  <span className="settings-usage-model-top">
                    <span className="settings-usage-model-name">其他模型</span>
                    <span className="settings-usage-model-pct">{formatPercent(modelSum > 0 ? otherTokens / modelSum : 0)}</span>
                  </span>
                  <span className="settings-usage-model-bar">
                    <span
                      className="settings-usage-model-fill"
                      data-rank="other"
                      style={{ width: `${modelSum > 0 ? Math.round((otherTokens / modelSum) * 100) : 0}%` }}
                    />
                  </span>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>

      {tip ? (
        <div
          className="settings-usage-tip"
          role="tooltip"
          style={{ left: tip.x, top: tip.y }}
        >
          <b>{formatDayHuman(tip.date)}</b>
          <span>
            {tip.day
              ? `${formatTokenCount(tip.day.tokens.total)} Token · ${formatCount(tip.day.messages.user)} 条消息 · ${formatCount(tip.day.sessions)} 次会话`
              : "无数据"}
          </span>
        </div>
      ) : null}
    </div>
  )
}
