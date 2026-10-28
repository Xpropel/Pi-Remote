/**
 * 手机端设置 · 开发预览（只给截图 / 对图，不进产品入口）。
 *
 * 打开 `…/src/pi/settings/mobile/dev/harness.html?page=usage&style=claude&theme=dark`
 * page = index | general | model | approval | extensions | appearance | devices |
 *        notifications | shortcuts | privacy | usage | about | interaction
 * style = cursor | claude | codex；theme = dark | light
 *
 * mock 只实现页面会读的 relay 字段；不连真 relay、不写任何存储。
 */
import { createRoot } from "react-dom/client"
import type { PiContainerProps } from "@/pi/containers/types"
import type { PiUi, PiUiActions } from "@/pi/hooks/usePiUiState"
import type { Device } from "@/relay/devices"
import type { UsageSnapshotV1 } from "@/pi/usage/types"
import type { PiMobileNavMode } from "@/pi/mobile/types"
import { MobileSettingsPage } from "../MobileSettingsPage.tsx"
import {
  SETTINGS_USAGE_METRICS,
  SETTINGS_USAGE_RANGES,
  settingsStyleOf,
  settingsThemeOf,
  type SettingsStyle,
  type SettingsTheme,
} from "../../types.ts"
import { mobilePageIdOf } from "../types.ts"
import { createDefaultSettingsPrefs, saveSettingsLocal } from "../../model.ts"

function localDay(offset: number): string {
  const date = new Date(Date.now() + offset * 86_400_000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function seeded(seed: number): () => number {
  let value = seed
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296
    return value / 4294967296
  }
}

function usageSnapshot(): UsageSnapshotV1 {
  const rnd = seeded(20261028)
  const days = Array.from({ length: 196 }, (_, index) => {
    const date = localDay(index - 195)
    const weekend = [0, 6].includes(new Date(`${date}T12:00:00`).getDay())
    const base = weekend ? 0.35 : 1
    const wave = 0.55 + 0.45 * Math.sin(index / 9)
    const activity = Math.max(0, base * wave * (0.35 + rnd() * 1.15))
    const tokens = Math.round(activity * (180_000 + rnd() * 220_000))
    const messages = Math.round(activity * (60 + rnd() * 70))
    return {
      date,
      tokens: {
        total: tokens,
        input: Math.round(tokens * 0.72),
        output: Math.round(tokens * 0.2),
        cacheRead: Math.round(tokens * 0.06),
        cacheWrite: Math.round(tokens * 0.02),
      },
      messages: { user: messages, assistant: messages },
      sessions: Math.round(activity * 6),
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
  const peakTokens = days.reduce((best, day) => (day.tokens.total > best.value ? { date: day.date, value: day.tokens.total } : best), { date: days[0].date, value: 0 })
  const peakMessages = days.reduce((best, day) => (day.messages.user > best.value ? { date: day.date, value: day.messages.user } : best), { date: days[0].date, value: 0 })
  return {
    v: "usage.activity.v1",
    generatedAt: Date.now(),
    deviceId: "d-mac",
    timezone: { id: "Asia/Shanghai", offsetMinutes: 480 },
    range: { firstDay: days[0].date, lastDay: days[days.length - 1].date, days: days.length },
    days,
    summary: {
      totals,
      streaks: { current: 6, longest: 9 },
      peaks: { tokens: peakTokens, messages: peakMessages },
      models: [
        { provider: "stepfun", model: "step-5-preview", tokens: Math.round(totals.tokens * 0.68) },
        { provider: "stepfun", model: "step-3.7-flash", tokens: Math.round(totals.tokens * 0.24) },
        { provider: "stepfun", model: "step-3", tokens: Math.round(totals.tokens * 0.05) },
        { provider: "local", model: "llama-3.3", tokens: Math.round(totals.tokens * 0.03) },
      ],
      modelsWindowDays: 30,
    },
    coverage: { files: 24, parsedFiles: 24, cacheHitFiles: 20, skippedFiles: 0, truncated: false, errors: 0, scanMs: 120, source: "pi-sessions" },
    cache: { hit: false, generatedFrom: "incremental" },
  }
}

const devices: Device[] = [
  {
    id: "d-mac",
    accountId: "a1",
    name: "MacBook Pro",
    platform: "darwin",
    online: true,
    projects: ["/Users/user/CLI/Pi-Remote"],
    browseRoots: [],
    lastAttachAt: Date.now() - 60_000,
    firstSeenAt: Date.now() - 86_400_000 * 40,
    windowExpiresAt: Date.now() + 3_600_000,
    auth: "token",
    paired: true,
    latencyMs: 38,
    features: ["session.files"],
    trash: true,
  },
  {
    id: "d-win",
    accountId: "a1",
    name: "Windows 电脑",
    platform: "win32",
    online: false,
    projects: [],
    browseRoots: [],
    lastAttachAt: Date.now() - 86_400_000 - 3_600_000,
    firstSeenAt: Date.now() - 86_400_000 * 20,
    windowExpiresAt: null,
    auth: "token",
    paired: true,
    latencyMs: null,
    features: [],
    trash: false,
  },
]

const HARNESS_RESPONSES: Record<string, unknown> = {
  get_settings: {
    settings: {
      defaultModel: "step-5-preview",
      defaultThinkingLevel: "max",
      hideThinkingBlock: false,
      enableSkillCommands: true,
      enableInstallTelemetry: true,
      images: { blockImages: false, autoResize: true },
      compaction: { enabled: true },
      modelThinkingLevels: { "step-5-preview": "max", "step-3.7-flash": "high" },
      packages: [],
      extensions: [],
    },
  },
  get_provider_auth: {
    providers: [
      { id: "stepfun", displayName: "StepFun", models: 2, configured: true, authSource: "api_key" },
    ],
  },
  get_available_models: {
    models: [
      { provider: "stepfun", id: "step-5-preview" },
      { provider: "stepfun", id: "step-3.7-flash" },
    ],
  },
  get_mcp_servers: {
    servers: [
      { name: "github", transport: "stdio", exposure: "direct", enabled: true, connected: true, toolCount: 12 },
      { name: "zotero", transport: "stdio", exposure: "search", enabled: true, connected: true, toolCount: 8 },
      { name: "filesystem", transport: "stdio", exposure: "search", enabled: true, connected: false, toolCount: 5 },
    ],
  },
  get_commands: {
    commands: [
      { name: "code-review", description: "审查代码改动并列出问题", source: "skill" },
      { name: "literature", description: "检索并整理学术文献", source: "skill", sourceInfo: { disableModelInvocation: true } },
      { name: "web-fetch", description: "把网页正文抓成文本", source: "skill" },
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
      { name: "codemode", description: "脚本工具" },
      { name: "tool_search", description: "工具搜索" },
    ],
  },
  get_state: {
    projectTrusted: true,
    autoCompactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    thinkingLevel: "max",
    model: { provider: "stepfun", id: "step-5-preview", name: "step-5-preview" },
  },
}

const params = new URLSearchParams(window.location.search)
const style: SettingsStyle = settingsStyleOf(params.get("style"))
const theme: SettingsTheme = settingsThemeOf(params.get("theme")) ?? "dark"
const page = mobilePageIdOf(params.get("page"))
const mobileNav: PiMobileNavMode = params.get("nav") === "drawer" ? "drawer" : "list"

// 截图用：?range=weekly|cumulative&metric=tokens|messages|sessions 强制设置页偏好（只写开发浏览器的 localStorage）。
const forcedRange = params.get("range")
const forcedMetric = params.get("metric")
if (forcedRange || forcedMetric) {
  const prefs = createDefaultSettingsPrefs()
  if (forcedRange && (SETTINGS_USAGE_RANGES as readonly string[]).includes(forcedRange)) {
    prefs.usageRange = forcedRange as typeof prefs.usageRange
  }
  if (forcedMetric && (SETTINGS_USAGE_METRICS as readonly string[]).includes(forcedMetric)) {
    prefs.usageMetric = forcedMetric as typeof prefs.usageMetric
  }
  saveSettingsLocal(window.localStorage, prefs)
}
const snapshot = usageSnapshot()
const device = devices[0]

const ui = {
  prefs: { ui: style, mobileNav, theme: "dark" },
  view: "settings",
  sheet: null,
  dialog: null,
} as unknown as PiUi

let navValue = mobileNav

const act = {
  openSession: () => undefined,
  openSheet: () => undefined,
  openDialog: () => undefined,
  closeSheet: () => undefined,
  closeDialog: () => undefined,
  openSettings: () => undefined,
  setUiVariant: (variant: SettingsStyle) => {
    ui.prefs.ui = variant
  },
  setPref: (key: string, value: unknown) => {
    if (key === "mobileNav") navValue = value as PiMobileNavMode
    ui.prefs.mobileNav = navValue
    document.documentElement.dataset.smHarnessNav = navValue
  },
} as unknown as PiUiActions

const p = {
  variant: "phone",
  keyboardOpen: false,
  ui,
  act,
  relay: {
    authed: true,
    browserOnline: true,
    online: true,
    roomId: "r-demo",
    devices,
    selectedDeviceId: device.id,
    selectedDevice: device,
    serverName: "上海中转",
    serverProto: 4,
    serverCaps: ["usage.activity.v1"],
    model: "step-5-preview",
    modelMeta: { provider: "stepfun", modelId: "step-5-preview", name: "step-5-preview" },
    thinkingLevel: "max",
    lazySession: null,
    runCommand: async (name: string) => {
      if (name in HARNESS_RESPONSES) return HARNESS_RESPONSES[name]
      if (name === "set_active_tools") return { ok: true, tools: ["read", "bash", "edit", "write", "grep", "ls"] }
      return {}
    },
    getUsage: async (deviceId: string) => ({ type: "usage_snapshot", deviceId, available: true, snapshot }),
    notify: () => undefined,
    reconnectNow: () => undefined,
    createPairCode: async () => ({ code: "123456", expiresAt: Date.now() + 60_000 }),
    revokeDevice: async () => undefined,
  },
} as unknown as PiContainerProps

const root = document.getElementById("root")
if (!root) throw new Error("缺少 #root")
createRoot(root).render(
  <MobileSettingsPage p={p} style={style} theme={theme} initialPage={page} />,
)
document.documentElement.dataset.smHarnessPage = page
document.documentElement.dataset.smHarnessStyle = style
document.documentElement.dataset.smHarnessTheme = theme
