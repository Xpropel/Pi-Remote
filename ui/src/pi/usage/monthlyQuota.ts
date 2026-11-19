/**
 * 设置 › 使用活动 · 本月用量预算与供应商分布（无 React / 无 DOM，node --test 直载）。
 * 数据全部源自 usage.activity.v1 真实聚合快照与本机 monthlyTokenBudget 偏好。
 */
import type { UsageSnapshotV1 } from "./types.ts"

export const MONTHLY_BUDGET_PRESETS = [0, 5_000_000, 20_000_000, 50_000_000, 100_000_000] as const

export interface MonthlyProviderShare {
  provider: string
  tokens: number
  share: number
}

export interface MonthlyQuotaSummary {
  monthPrefix: string
  monthLabel: string
  resetLabel: string
  monthTokens: number
  monthMessages: number
  monthSessions: number
  activeDays: number
  budgetTokens: number
  usageRatio: number | null
  overBudget: boolean
  topProviders: MonthlyProviderShare[]
}

export function monthlyBudgetPresetLabel(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "不设上限"
  const millions = Math.round(tokens / 1_000_000)
  return `${millions}M`
}

function resolveMonthPrefix(todayKey: string): { prefix: string; label: string } {
  const match = /^(\d{4})-(\d{2})/.exec((todayKey ?? "").trim())
  if (match) {
    return { prefix: `${match[1]}-${match[2]}`, label: `${Number(match[2])}月` }
  }
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1
  return {
    prefix: `${year}-${String(month).padStart(2, "0")}`,
    label: `${month}月`,
  }
}

/** 汇总当自然月已用 Token / 消息 / 会话，并按近 30 天模型快照归纳供应商占比。 */
export function monthlyQuotaSummaryOf(
  snapshot: UsageSnapshotV1 | null | undefined,
  todayKey: string,
  budgetTokens: number,
): MonthlyQuotaSummary {
  const { prefix, label } = resolveMonthPrefix(todayKey)
  let monthTokens = 0
  let monthMessages = 0
  let monthSessions = 0
  let activeDays = 0

  for (const day of snapshot?.days ?? []) {
    if (!day.date.startsWith(prefix)) continue
    const dayTokens = Number.isFinite(day.tokens?.total) ? day.tokens.total : 0
    const dayMessages = Number.isFinite(day.messages?.user) ? day.messages.user : 0
    const daySessions = Number.isFinite(day.sessions) ? day.sessions : 0
    monthTokens += dayTokens
    monthMessages += dayMessages
    monthSessions += daySessions
    if (dayTokens > 0 || dayMessages > 0 || daySessions > 0) {
      activeDays += 1
    }
  }

  const byProvider = new Map<string, number>()
  let totalModelTokens = 0
  for (const slice of snapshot?.summary?.models ?? []) {
    const tokens = Number.isFinite(slice.tokens) && slice.tokens > 0 ? slice.tokens : 0
    if (tokens <= 0) continue
    const key = (slice.provider ?? "").trim() || "其他"
    byProvider.set(key, (byProvider.get(key) ?? 0) + tokens)
    totalModelTokens += tokens
  }

  const topProviders: MonthlyProviderShare[] = [...byProvider.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([provider, tokens]) => ({
      provider,
      tokens,
      share: totalModelTokens > 0 ? tokens / totalModelTokens : 0,
    }))

  const budget = typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0 ? Math.round(budgetTokens) : 0
  const usageRatio = budget > 0 ? monthTokens / budget : null
  const overBudget = budget > 0 && monthTokens > budget

  return {
    monthPrefix: prefix,
    monthLabel: label,
    resetLabel: "每月 1 日重置",
    monthTokens,
    monthMessages,
    monthSessions,
    activeDays,
    budgetTokens: budget,
    usageRatio,
    overBudget,
    topProviders,
  }
}
