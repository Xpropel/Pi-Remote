/**
 * s5/usage：设置页「有数据」的样子（只给截图 / 对图，入口从侧栏进设置）。
 * 在 settings 的基础上，房间命令回设置文档、供应商、模型、MCP、技能与模板，getUsage 回一份按种子生成的近一年快照，
 * 这样「模型与会话」「扩展」「使用活动」都能看到真实形状的内容；日子以 MOCK_NOW（+08:00）为今天，截图稳定。
 */
import { addDaysToDayKey } from "../../../usage/format.ts"
import type { UsageDay, UsageSnapshotV1 } from "../../../usage/types.ts"
import { BASE, MBP } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const TODAY = "2026-10-24"
const DAYS = 364

function seeded(seed: number): () => number {
  let value = seed
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296
    return value / 4294967296
  }
}

function usageSnapshot(): UsageSnapshotV1 {
  const rnd = seeded(20261024)
  const days: UsageDay[] = Array.from({ length: DAYS }, (_, index) => {
    const date = addDaysToDayKey(TODAY, index - (DAYS - 1))
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay()
    const base = weekday === 0 || weekday === 6 ? 0.3 : 1
    const ramp = 0.25 + 0.75 * (index / DAYS)
    const wave = 0.55 + 0.45 * Math.sin(index / 11)
    const activity = rnd() < 0.18 ? 0 : Math.max(0, base * ramp * wave * (0.3 + rnd() * 1.2))
    const tokens = Math.round(activity * (160_000 + rnd() * 240_000))
    const messages = Math.round(activity * (40 + rnd() * 60))
    return {
      date,
      tokens: {
        total: tokens,
        input: Math.round(tokens * 0.72),
        output: Math.round(tokens * 0.2),
        cacheRead: Math.round(tokens * 0.06),
        cacheWrite: tokens - Math.round(tokens * 0.72) - Math.round(tokens * 0.2) - Math.round(tokens * 0.06),
      },
      messages: { user: messages, assistant: messages },
      sessions: messages > 0 ? Math.max(1, Math.round(activity * 5)) : 0,
    }
  })
  const recent = days.slice(-30)
  const totals = recent.reduce(
    (acc, day) => ({
      tokens: acc.tokens + day.tokens.total,
      messagesUser: acc.messagesUser + day.messages.user,
      messagesAssistant: acc.messagesAssistant + day.messages.assistant,
      sessions: acc.sessions + day.sessions,
      activeDays: acc.activeDays + (day.sessions > 0 ? 1 : 0),
    }),
    { tokens: 0, messagesUser: 0, messagesAssistant: 0, sessions: 0, activeDays: 0 },
  )
  let current = 0
  for (let index = days.length - 1; index >= 0 && days[index].sessions > 0; index--) current += 1
  let longest = 0
  let run = 0
  for (const day of days) {
    run = day.sessions > 0 ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  const peakOf = (pick: (day: UsageDay) => number) =>
    days.reduce<{ date: string; value: number } | null>((best, day) => (pick(day) > (best?.value ?? 0) ? { date: day.date, value: pick(day) } : best), null)
  return {
    v: "usage.activity.v1",
    generatedAt: MOCK_NOW,
    deviceId: MBP.id,
    timezone: { id: "Asia/Shanghai", offsetMinutes: 480 },
    range: { firstDay: days[0].date, lastDay: days[days.length - 1].date, days: days.length },
    days,
    summary: {
      totals,
      streaks: { current, longest },
      peaks: { tokens: peakOf((day) => day.tokens.total), messages: peakOf((day) => day.messages.user) },
      models: [
        { provider: "anthropic", model: "claude-sonnet-4-5", tokens: Math.round(totals.tokens * 0.64) },
        { provider: "39api", model: "deepseek-v4.1-flash", tokens: Math.round(totals.tokens * 0.22) },
        { provider: "openai", model: "gpt-5.1-codex", tokens: Math.round(totals.tokens * 0.09) },
        { provider: "local", model: "llama-3.3", tokens: Math.round(totals.tokens * 0.03) },
        { provider: "local", model: "qwen3-coder", tokens: Math.round(totals.tokens * 0.02) },
      ],
      modelsWindowDays: 30,
    },
    coverage: { files: 212, parsedFiles: 212, cacheHitFiles: 188, skippedFiles: 0, truncated: false, errors: 0, scanMs: 140, source: "pi-sessions" },
    cache: { hit: false, generatedFrom: "incremental" },
  }
}

const SNAPSHOT = usageSnapshot()

const RESPONSES: Record<string, unknown> = {
  get_settings: {
    settings: {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      defaultThinkingLevel: "medium",
      hideThinkingBlock: false,
      enableSkillCommands: true,
      enableInstallTelemetry: true,
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      images: { blockImages: false, autoResize: true },
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 24576 },
      modelThinkingLevels: { "claude-sonnet-4-5": "medium" },
      packages: [],
      extensions: [],
    },
  },
  get_provider_auth: {
    providers: [
      { id: "anthropic", displayName: "Anthropic", models: 3, configured: true, authSource: "stored" },
      { id: "39api", displayName: "39api", models: 2, configured: true, authSource: "models_json_key", baseUrl: "https://api.39api.com/v1" },
      { id: "openai", displayName: "OpenAI", models: 1, configured: false },
    ],
  },
  get_available_models: {
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5" },
      { provider: "anthropic", id: "claude-opus-4-1" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
      { provider: "39api", id: "deepseek-v4.1-flash" },
      { provider: "39api", id: "deepseek-v4.1" },
    ],
  },
  get_mcp_servers: {
    servers: [
      { name: "github", transport: "stdio", exposure: "direct", enabled: true, connected: true, toolCount: 12 },
      { name: "filesystem", transport: "stdio", exposure: "search", enabled: true, connected: false, toolCount: 5 },
    ],
  },
  get_commands: {
    commands: [
      { name: "code-review", description: "审查代码改动并列出问题", source: "skill" },
      { name: "literature", description: "检索并整理学术文献", source: "skill", sourceInfo: { disableModelInvocation: true } },
      { name: "review", description: "代码审查模板 · 带文件参数", source: "prompt" },
      { name: "summarize", description: "把长文总结成要点", source: "prompt" },
    ],
  },
  get_active_tools: { tools: ["read", "bash", "edit", "write", "grep", "ls"] },
  get_all_tools: {
    tools: [
      { name: "read", description: "读取文件" },
      { name: "bash", description: "运行命令" },
      { name: "edit", description: "编辑文件" },
      { name: "write", description: "写入文件" },
      { name: "grep", description: "搜索文件" },
      { name: "ls", description: "文件列表" },
    ],
  },
  get_host_diag: { piVersion: "1.3.0", nodeVersion: "v22.18.0", platform: "darwin", arch: "arm64", extensionVersion: "4.0.0" },
}

const fixture: PiLiveFixture = {
  id: "s5-usage",
  now: MOCK_NOW,
  note: "设置页有数据的样子：房间命令回设置文档 / 供应商 / 模型 / MCP / 技能，getUsage 回近一年快照；都是演示值。",
  relay: {
    ...BASE,
    runCommand: async (command: string) => RESPONSES[command] ?? {},
    runDeviceCommand: async (_deviceId: string, command: string) => RESPONSES[command] ?? {},
    getUsage: async (deviceId: string) => ({ type: "usage_snapshot", deviceId, available: true, snapshot: SNAPSHOT }),
  },
}
export default fixture
