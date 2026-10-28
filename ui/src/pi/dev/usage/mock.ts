import { piUsageEmptySnapshot, validateUsageSnapshot } from "@/pi/usage/validate"
import { USAGE_ACTIVITY_VERSION, USAGE_MODELS_MAX, type UsageDay, type UsageSnapshotV1 } from "@/pi/usage/types"
import { localDayKey } from "@/pi/usage/format"

/*
 * P10 dev-only「使用活动」mock 数据（**不进生产**；只在 dev 预览/测试中通过 `snapshot` prop 显式注入）。
 * 生产组件默认 source=real，无 relay provider 时进入诚实 loading/错误态，不显示任何假数字。
 */
/** dev-only mock provider：按契约生成 1 年数据（不含敏感键；?usage=empty|short 两态） */
export function mockUsageSnapshot(deviceId?: string, mode: "full" | "empty" | "short" = "full"): UsageSnapshotV1 {
  if (mode === "empty") return piUsageEmptySnapshot({ deviceId })
  const total = mode === "short" ? 12 : 365
  const today = new Date()
  let seed = 20261027
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const days: UsageDay[] = []
  const modelTotals = new Map<string, number>()
  for (let i = total - 1; i >= 0; i--) {
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = localDayKey(base.getTime())
    const weekend = base.getDay() === 0 || base.getDay() === 6
    const active = rand() > (weekend ? 0.55 : 0.24)
    if (!active) {
      days.push({ date: key, tokens: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, messages: { user: 0, assistant: 0 }, sessions: 0 })
      continue
    }
    const messages = 2 + Math.round(rand() * 26)
    const perMessage = 2200 + Math.round(rand() * 62000)
    const totalTokens = messages * perMessage
    const model = rand() > 0.28 ? "stepfun/step-5-preview" : "stepfun/step-3.7-flash"
    modelTotals.set(model, (modelTotals.get(model) ?? 0) + totalTokens)
    days.push({
      date: key,
      tokens: { total: totalTokens, input: Math.round(totalTokens * 0.82), output: Math.round(totalTokens * 0.12), cacheRead: Math.round(totalTokens * 0.05), cacheWrite: Math.round(totalTokens * 0.01) },
      messages: { user: messages, assistant: messages + Math.round(rand() * 4) },
      sessions: 1 + Math.round(rand() * 3),
    })
  }
  const last30 = days.slice(-30)
  const sum = (list: UsageDay[], pick: (day: UsageDay) => number): number => list.reduce((n, day) => n + pick(day), 0)
  const tokensWindow = sum(last30, (day) => day.tokens.total)
  const models = [...modelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, USAGE_MODELS_MAX)
    .map(([model, tokens]) => {
      const [provider, name] = model.includes("/") ? model.split("/") : ["stepfun", model]
      return { provider, model: name, tokens: Math.max(1, Math.round(tokens * (tokensWindow / Math.max(1, sum(days, (day) => day.tokens.total))))) }
    })
  let current = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].tokens.total > 0) current += 1
    else break
  }
  let longest = 0
  let run = 0
  for (const day of days) {
    if (day.tokens.total > 0) {
      run += 1
      longest = Math.max(longest, run)
    } else run = 0
  }
  const peak = (pick: (day: UsageDay) => number) => days.reduce<{ date: string; value: number } | null>((best, day) => {
    const value = pick(day)
    return value > (best?.value ?? 0) ? { date: day.date, value } : best
  }, null)
  const activeDays = last30.filter((day) => day.sessions > 0).length
  const snapshot: UsageSnapshotV1 = {
    v: USAGE_ACTIVITY_VERSION,
    generatedAt: Date.now(),
    ...(deviceId ? { deviceId } : {}),
    timezone: { id: Intl.DateTimeFormat().resolvedOptions().timeZone || "local", offsetMinutes: -new Date().getTimezoneOffset() },
    range: { firstDay: days[0]?.date ?? null, lastDay: days[days.length - 1]?.date ?? null, days: days.length },
    days,
    summary: {
      totals: {
        tokens: tokensWindow,
        messagesUser: sum(last30, (day) => day.messages.user),
        messagesAssistant: sum(last30, (day) => day.messages.assistant),
        sessions: sum(last30, (day) => day.sessions),
        activeDays,
      },
      streaks: { current, longest },
      peaks: { tokens: peak((day) => day.tokens.total), messages: peak((day) => day.messages.user) },
      models,
      modelsWindowDays: 30,
    },
    coverage: { files: days.length, parsedFiles: days.length, cacheHitFiles: 0, skippedFiles: 0, truncated: false, errors: 0, scanMs: 0, source: "pi-sessions" },
    cache: { hit: false, generatedFrom: "full" },
  }
  const checked = validateUsageSnapshot(snapshot)
  return checked.ok ? checked.snapshot : piUsageEmptySnapshot({ deviceId })
}


/** dev 预览便捷入口：?usage=empty|short */
export function mockUsageSnapshotForMode(mode: "full" | "empty" | "short", deviceId?: string): UsageSnapshotV1 {
  return mockUsageSnapshot(deviceId, mode)
}

/** dev 预览便捷入口：?usage=empty|short */
