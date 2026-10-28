/**
 * 手机端设置 · 使用活动（移动压缩版）。
 *
 * 数据源：`useUsageActivity` → relay `usage_get` / `usage_snapshot`（usage.activity.v1），
 * 不在本页造数；无数据 / 离线 / 旧端 / 超时按诚实空态显示。
 *
 * 指标 / 查看方式沿用设置偏好（○，本机即存）。
 * 热力图只取近 26 周（设计册「变体与手机端」），卡内小字注明「按屏幕宽度显示近 26 周」；
 * 供应商用量额度卡无数据源 → ◌ 设计预留。
 */
import { useMemo, useState } from "react"
import {
  addDaysToDayKey,
  formatCount,
  formatTokenCount,
  heatmapScaleOf,
  usageDeltaOf,
  usageTodayDayKey,
  weekdayOfDayKey,
} from "@/pi/usage/format"
import { useUsageActivity } from "@/pi/usage/useUsage"
import type { UsageDay, UsageSnapshotV1 } from "@/pi/usage/types"
import { settingsDeviceOfflineOf } from "../../model.ts"
import { useSettings } from "../../SettingsContext.tsx"
import { heatmapWeekDates } from "../model.ts"
import { MOBILE_SETTINGS_COPY } from "../types.ts"
import {
  MobileActionRow,
  MobileCard,
  MobileEmpty,
  MobileGroup,
  MobileNote,
  MobilePageBody,
  MobileRow,
  MobileSegmented,
  MobileStatCard,
} from "../atoms.tsx"

const METRIC_OPTIONS = [
  { value: "messages", label: "消息数" },
  { value: "tokens", label: "Token" },
  { value: "sessions", label: "会话数" },
] as const

const RANGE_OPTIONS = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "cumulative", label: "累计" },
] as const

const ACTIVITY_LABEL: Record<string, string> = { tokens: "Token 活动", messages: "消息活动", sessions: "会话活动" }
const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

const REASON_COPY: Record<string, { title: string; body: string }> = {
  unsupported: { title: "使用活动数据不可用", body: "当前 pi 扩展 / relay 版本不支持使用活动数据，升级后即可查看。" },
  no_data: { title: "还没有使用活动", body: "开始和 pi 对话后，这里会出现你的使用活动。" },
  device_offline: { title: "设备离线，暂无可展示数据", body: "设备当前不在线，且没有可用缓存；连接恢复后会自动更新。" },
  timeout: { title: "读取超时", body: "读取本机使用数据超时，可稍后重试。" },
  stale: { title: "数据可能不是最新", body: "展示的是 relay 缓存数据，设备恢复连接后会自动更新。" },
  invalid: { title: "使用活动数据读取失败", body: "设备上报的聚合数据没有通过校验，已拒绝展示。" },
}

function metricValueOf(day: UsageDay, metric: string): number {
  if (metric === "messages") return day.messages.user
  if (metric === "sessions") return day.sessions
  return day.tokens.total
}

function formatDayHuman(dayKey: string): string {
  const parts = dayKey.split("-").map(Number)
  if (parts.length !== 3 || parts.some((value) => !Number.isFinite(value))) return dayKey
  const weekday = WEEKDAY_LABEL[weekdayOfDayKey(dayKey)]
  return `${parts[1]}月${parts[2]}日 · ${weekday}`
}

function sumDays(days: readonly UsageDay[], metric: string): number {
  return days.reduce((total, day) => total + metricValueOf(day, metric), 0)
}

function previousWindow(days: readonly UsageDay[], todayKey: string): UsageDay[] {
  const start = addDaysToDayKey(todayKey, -59)
  const end = addDaysToDayKey(todayKey, -30)
  return days.filter((day) => day.date >= start && day.date <= end)
}

/** 周聚合：从今天所在周的周日往前 8 周。 */
function weeklyBuckets(days: readonly UsageDay[], todayKey: string, metric: string): { label: string; value: number }[] {
  const currentSunday = addDaysToDayKey(todayKey, -weekdayOfDayKey(todayKey))
  const buckets: { label: string; value: number }[] = []
  for (let index = 7; index >= 0; index -= 1) {
    const start = addDaysToDayKey(currentSunday, -index * 7)
    const end = addDaysToDayKey(start, 6)
    const subset = days.filter((day) => day.date >= start && day.date <= end)
    const parts = start.split("-").map(Number)
    buckets.push({ label: `${parts[1]}/${parts[2]}`, value: sumDays(subset, metric) })
  }
  return buckets
}

function Heatmap({ snapshot, metric }: { snapshot: UsageSnapshotV1; metric: string }) {
  const todayKey = usageTodayDayKey(snapshot)
  const columns = useMemo(() => heatmapWeekDates(todayKey, 26), [todayKey])
  const byDate = useMemo(() => new Map(snapshot.days.map((day) => [day.date, metricValueOf(day, metric)])), [snapshot.days, metric])
  const scale = useMemo(() => heatmapScaleOf([...byDate.values()]), [byDate])
  const max = Math.max(0, ...byDate.values())
  return (
    <div className="sm-heat">
      <div className="sm-heat-body">
        {columns.map((week, weekIndex) => (
          <div className="sm-heat-week" key={`${week[0]}-${weekIndex}`}>
            {week.map((date) => {
              const value = byDate.get(date) ?? 0
              const future = date > todayKey
              const level = future ? 0 : scale.bucketOf(value)
              const label = future
                ? `${date} · 未到`
                : `${formatDayHuman(date)} · ${metric === "messages" ? `${formatCount(value)} 条` : metric === "sessions" ? `${formatCount(value)} 次` : formatTokenCount(value)}`
              return (
                <span
                  key={date}
                  className="sm-heat-cell"
                  data-level={value > 0 ? level : 0}
                  data-empty={value <= 0 && !future ? "" : undefined}
                  data-future={future ? "" : undefined}
                  data-today={date === todayKey ? "" : undefined}
                  data-hot={value > 0 && value >= max ? "" : undefined}
                  title={label}
                  aria-label={label}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="sm-heat-foot">
        <span className="sm-heat-legend">
          少
          <i data-level="0" />
          <i data-level="1" />
          <i data-level="2" />
          <i data-level="3" />
          <i data-level="4" />
          多
        </span>
        <span className="sm-heat-note">{MOBILE_SETTINGS_COPY.heatmapWeeksNote}</span>
      </div>
    </div>
  )
}

function WeeklyBars({ days, todayKey, metric }: { days: readonly UsageDay[]; todayKey: string; metric: string }) {
  const buckets = weeklyBuckets(days, todayKey, metric)
  const max = Math.max(0, ...buckets.map((bucket) => bucket.value))
  return (
    <div className="sm-week-bars">
      {buckets.map((bucket) => (
        <div className="sm-week-row" key={bucket.label}>
          <span className="sm-week-label">{bucket.label}</span>
          <span className="sm-week-track">
            <span className="sm-week-fill" style={{ width: `${max > 0 ? Math.max(2, (bucket.value / max) * 100) : 0}%` }} />
          </span>
          <span className="sm-week-value">{metric === "tokens" ? formatTokenCount(bucket.value) : formatCount(bucket.value)}</span>
        </div>
      ))}
    </div>
  )
}

export function UsagePage() {
  const { p, prefs, act } = useSettings()
  const relay = p.relay
  const usage = useUsageActivity(relay, { deviceId: relay.selectedDevice?.id ?? relay.selectedDeviceId ?? undefined })
  const snapshot = usage.snapshot
  const metric = prefs.usageMetric
  const range = prefs.usageRange
  const [retrying, setRetrying] = useState(false)
  const todayKey = snapshot ? usageTodayDayKey(snapshot) : usageTodayDayKey(null)
  const totals = snapshot?.summary.totals
  const activeDays = totals?.activeDays ?? 0
  const activeRatio = Math.min(100, Math.round((activeDays / 30) * 100))
  const previous = snapshot ? previousWindow(snapshot.days, todayKey) : []
  const tokenDelta = snapshot ? usageDeltaOf(totals?.tokens ?? 0, previous.reduce((sum, day) => sum + day.tokens.total, 0)) : null
  const messageDelta = snapshot ? usageDeltaOf(totals?.messagesUser ?? 0, previous.reduce((sum, day) => sum + day.messages.user, 0)) : null
  const models = snapshot?.summary.models ?? []
  const modelTotal = models.reduce((sum, row) => sum + row.tokens, 0)
  const topModels = models.slice(0, 3)
  const otherTokens = models.slice(3).reduce((sum, row) => sum + row.tokens, 0)
  const cumulative = snapshot ? sumDays(snapshot.days, metric) : 0
  const reason = usage.reason ? REASON_COPY[usage.reason] : null
  // 设备离线 / relay 缓存时明确标缓存态并锁定分段，避免把旧数据当成实时数据继续切。
  const deviceOffline = settingsDeviceOfflineOf(relay)
  const offlineCache = deviceOffline || usage.stale || usage.reason === "device_offline"
  const offlineText = deviceOffline
    ? "设备离线，显示上次缓存的数据（可能不是最新）；统计指标 / 查看方式已锁定，连接恢复后自动更新。"
    : "数据可能不是最新（relay 缓存）；统计指标 / 查看方式已锁定，设备恢复连接后自动更新。"

  const retry = () => {
    setRetrying(true)
    usage.refresh()
    window.setTimeout(() => setRetrying(false), 600)
  }

  return (
    <MobilePageBody page="usage">
      <MobileCard className="sm-usage-controls">
        <MobileSegmented
          label="统计指标"
          value={metric}
          options={METRIC_OPTIONS}
          disabled={offlineCache}
          onChange={(value) => act.setPref("usageMetric", value)}
        />
        <MobileSegmented
          label="查看方式"
          value={range}
          options={RANGE_OPTIONS}
          disabled={offlineCache}
          onChange={(value) => act.setPref("usageRange", value)}
        />
      </MobileCard>
      {offlineCache ? <MobileNote>{offlineText}</MobileNote> : null}

      {snapshot ? (
        <>
          <div className="sm-stats">
            <MobileStatCard
              label="Token 总量"
              value={formatTokenCount(totals?.tokens ?? 0)}
              delta={tokenDelta?.show ? { text: tokenDelta.text, dir: tokenDelta.dir } : undefined}
              aside="较前 30 天"
            />
            <MobileStatCard
              label="发送消息数"
              value={formatCount(totals?.messagesUser ?? 0)}
              unit="条"
              delta={messageDelta?.show ? { text: messageDelta.text, dir: messageDelta.dir } : undefined}
              aside="较前 30 天"
            />
            <MobileStatCard label="活跃天数" value={activeDays} unit="/ 30 天" aside={`占 ${activeRatio}%`} />
            <MobileStatCard
              label="最长连续使用"
              value={snapshot.summary.streaks.longest}
              unit="天"
              aside={`连续 ${snapshot.summary.streaks.current} 天`}
            />
          </div>

          <MobileGroup label="供应商用量" stacked>
            <MobileCard>
              <MobileRow title="供应商用量额度" description="本月用量 · 按供应商账户计" status="reserved">
                <span className="sm-value">暂不可用</span>
              </MobileRow>
            </MobileCard>
          </MobileGroup>

          <MobileGroup label={ACTIVITY_LABEL[metric] ?? "Token 活动"} stacked>
            <MobileCard>
              {range === "daily" ? (
                <Heatmap snapshot={snapshot} metric={metric} />
              ) : range === "weekly" ? (
                <>
                  <WeeklyBars days={snapshot.days} todayKey={todayKey} metric={metric} />
                  <div className="sm-heat-foot">
                    <span className="sm-heat-note">近 8 周 · 每周从周日开始</span>
                  </div>
                </>
              ) : (
                <div className="sm-cumulative">
                  <div className="sm-cumulative-label">累计总量</div>
                  <div className="sm-cumulative-value">
                    {metric === "tokens" ? formatTokenCount(cumulative) : formatCount(cumulative)}
                  </div>
                  <div className="sm-cumulative-aside">
                    {snapshot.range.firstDay ?? snapshot.days[0]?.date ?? "—"} 至 {snapshot.range.lastDay ?? todayKey}
                  </div>
                </div>
              )}
            </MobileCard>
          </MobileGroup>

          <MobileGroup label="明细">
            <MobileRow title="最活跃的一天">
              <span className="sm-value">
                {snapshot.summary.peaks.messages
                  ? `${formatDayHuman(snapshot.summary.peaks.messages.date)} · ${formatCount(snapshot.summary.peaks.messages.value)} 条`
                  : "—"}
              </span>
            </MobileRow>
            <MobileRow title="单日 Token 峰值">
              <span className="sm-value">
                {snapshot.summary.peaks.tokens ? (
                  <>
                    <b className="sm-peak">{formatTokenCount(snapshot.summary.peaks.tokens.value)}</b>
                    <span> · {formatDayHuman(snapshot.summary.peaks.tokens.date)}</span>
                  </>
                ) : (
                  "—"
                )}
              </span>
            </MobileRow>
            <MobileRow title="平均每日消息">
              <span className="sm-value">
                {activeDays > 0 ? `${formatCount((totals?.messagesUser ?? 0) / activeDays)} 条 · 近 30 天` : "—"}
              </span>
            </MobileRow>
            {models.length > 0 ? (
              <div className="sm-models">
                <div className="sm-models-title">按模型分布 · 近 30 天</div>
                {topModels.map((row) => (
                  <div className="sm-model-row" key={`${row.provider}/${row.model}`}>
                    <span className="sm-model-name">{row.model}</span>
                    <span className="sm-model-track">
                      <span
                        className="sm-model-fill"
                        style={{ width: `${modelTotal > 0 ? Math.max(2, (row.tokens / modelTotal) * 100) : 0}%` }}
                      />
                    </span>
                    <span className="sm-model-percent">{modelTotal > 0 ? `${Math.round((row.tokens / modelTotal) * 100)}%` : "—"}</span>
                  </div>
                ))}
                {otherTokens > 0 || models.length > 3 ? (
                  <div className="sm-model-row">
                    <span className="sm-model-name">其他模型</span>
                    <span className="sm-model-track">
                      <span
                        className="sm-model-fill"
                        style={{ width: `${modelTotal > 0 ? Math.max(2, (otherTokens / modelTotal) * 100) : 0}%` }}
                      />
                    </span>
                    <span className="sm-model-percent">{modelTotal > 0 ? `${Math.round((otherTokens / modelTotal) * 100)}%` : "—"}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </MobileGroup>

        </>
      ) : (
        <MobileGroup stacked>
          <MobileCard>
            <MobileEmpty
              title={usage.loading ? "正在读取使用活动…" : reason?.title ?? "正在读取使用活动…"}
              body={usage.loading ? "从设备上的 pi 会话记录聚合，稍等片刻。" : reason?.body ?? "从设备上的 pi 会话记录聚合。"}
            />
            {!usage.loading ? (
              <MobileActionRow title={retrying ? "正在重试…" : "重新读取"} onClick={retry} />
            ) : null}
          </MobileCard>
        </MobileGroup>
      )}

      <MobileNote>
        数据口径：Token 按 API 处理量计；分天按设备本地时区；同一份会话记录只算一遍，中转侧的镜像副本不重复计。
        供应商用量额度卡暂无数据源，保留「设计预留」形态。
      </MobileNote>
      {usage.error && !usage.loading ? <MobileNote>读取提示：{usage.error}</MobileNote> : null}
    </MobilePageBody>
  )
}
