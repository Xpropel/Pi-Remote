/**
 * P10 dev-only「使用活动」预览壳（不进生产构建）。
 *
 * URL 参数（search 或 gallery hash 均可）：
 * - `fixture=design|realistic|short|empty|longtail`（数据源；A 组对图用 design，B–F 用 realistic）
 * - `usage=normal|short|empty|error|unavailable|loading`（页面数据态；`normal/short/empty` 映射对应快照；
 *   `error/unavailable/loading` 待 UI 的 `previewState` prop 合入后接，当前先渲染真实 hook 的降级/加载态）
 * - `theme=light|dark`、`host=claude|codex|cursor`（宿主标记）、`vp=1440x900|420x844`
 * - `metric=tokens|messages|sessions`、`view=daily|weekly|cumulative`（页面内部 useState，这里挂载后按文案点选）
 * - `overrides=0`：强制不传 displayOverrides（验证生产路径与对图路径的差异；默认 design 传）
 *
 * **design → displayOverrides 映射**（仅 dev 对图；生产挂载不传）：
 * 页面 overrides 是「整段文本替换」，为与 hybrid 稿逐字一致，这里补全展示后缀：
 * - `tokenDeltaText`: "↑38% 较前 30 天"（页面原逻辑会自己加「较前 30 天」）
 * - `yearTokensText`: "18.9M"（页面渲染「本机累计 18.9M」）
 * - `monthShareText`: "67%"
 * - `peakTokensText`: "214K · 10月19日 · 周一"（页面原逻辑为「值 · 日期」）
 */
import { useEffect, useMemo, type CSSProperties } from "react"
import { UsageActivityPage, formatTokenCount, type UsageActivityPageProps } from "@/pi/usage"
import { PI_UI_USAGE_FIXTURES, PI_UI_USAGE_FIXTURE_IDS, piUiUsageFixtureMeta, type PiUiUsageFixtureId } from "./index.ts"

export type UsagePreviewHost = "claude" | "codex" | "cursor"
export type UsagePreviewMode = "normal" | "short" | "empty" | "error" | "unavailable" | "loading"
export type UsagePreviewReason = "no_data" | "device_offline" | "unsupported" | "timeout" | "stale"
export type UsagePreviewMetric = "tokens" | "messages" | "sessions"
export type UsagePreviewView = "daily" | "weekly" | "cumulative"

export interface UsagePreviewParams {
  fixture: PiUiUsageFixtureId
  mode: UsagePreviewMode
  theme: "light" | "dark"
  host: UsagePreviewHost
  metric: UsagePreviewMetric
  view: UsagePreviewView
  vp: string
  overrides: boolean
  /** 三态 reason（previewState=unavailable 时用；默认 unsupported） */
  reason: UsagePreviewReason
}

const FIXTURE_ALIASES: Record<string, PiUiUsageFixtureId> = {
  design: "design",
  realistic: "realistic",
  normal: "realistic",
  short: "short",
  sparse: "short",
  empty: "empty",
  longtail: "longtail",
}
const MODE_ALIASES: Record<string, UsagePreviewMode> = {
  normal: "normal",
  short: "short",
  empty: "empty",
  error: "error",
  unavailable: "unavailable",
  loading: "loading",
}
const HOSTS = ["claude", "codex", "cursor"] as const
const REASONS = ["no_data", "device_offline", "unsupported", "timeout", "stale"] as const
const METRICS = ["tokens", "messages", "sessions"] as const
const VIEWS = ["daily", "weekly", "cumulative"] as const

export function usagePreviewParamsOf(params: URLSearchParams): UsagePreviewParams {
  const mode = MODE_ALIASES[params.get("usage") ?? ""] ?? "normal"
  const fixtureRaw = params.get("fixture") ?? ""
  const fallbackFixture: PiUiUsageFixtureId = mode === "short" ? "short" : mode === "empty" ? "empty" : "design"
  const fixture = FIXTURE_ALIASES[fixtureRaw] ?? fallbackFixture
  const theme = params.get("theme") === "light" ? "light" : "dark"
  const host = (HOSTS as readonly string[]).includes(params.get("host") ?? "") ? (params.get("host") as UsagePreviewHost) : "claude"
  const metric = (METRICS as readonly string[]).includes(params.get("metric") ?? "") ? (params.get("metric") as UsagePreviewMetric) : "tokens"
  const view = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as UsagePreviewView) : "daily"
  const vp = /^\d{3,4}x\d{3,4}$/.test(params.get("vp") ?? "") ? (params.get("vp") as string) : "1440x900"
  const reason = (REASONS as readonly string[]).includes(params.get("reason") ?? "") ? (params.get("reason") as UsagePreviewReason) : "unsupported"
  return { fixture, mode, theme, host, metric, view, vp, overrides: params.get("overrides") !== "0", reason }
}

/** design fixture 的对图覆盖（presentation 补全，见文件头）；其他 fixture 一律 undefined */
export function usagePreviewOverridesOf(params: UsagePreviewParams): UsageActivityPageProps["displayOverrides"] {
  if (params.fixture !== "design") return undefined
  const targets = piUiUsageFixtureMeta().design.designTargets
  if (!targets) return undefined
  return {
    tokenDeltaText: `${targets.tokenDeltaText} 较前 30 天`,
    yearTokensText: formatTokenCount(targets.yearTokens),
    monthShareText: targets.monthShareText,
    peakTokensText: `${targets.peakTokensText} · 10月19日 · 周一`,
  }
}

export interface UsagePreviewPageInput {
  snapshot?: UsageActivityPageProps["snapshot"]
  displayOverrides?: UsageActivityPageProps["displayOverrides"]
  previewState?: UsageActivityPageProps["previewState"]
  previewReason?: UsageActivityPageProps["previewReason"]
}

export function usagePreviewPageInputOf(params: UsagePreviewParams): UsagePreviewPageInput {
  if (params.mode === "loading") return { previewState: "loading" }
  if (params.mode === "error") return { previewState: "error", previewReason: params.reason === "unsupported" ? "timeout" : params.reason }
  if (params.mode === "unavailable") return { previewState: "unavailable", previewReason: params.reason }
  return {
    snapshot: PI_UI_USAGE_FIXTURES[params.fixture],
    displayOverrides: params.overrides ? usagePreviewOverridesOf(params) : undefined,
  }
}

const METRIC_LABEL: Record<UsagePreviewMetric, string> = { tokens: "Token", messages: "消息", sessions: "会话" }
const VIEW_LABEL: Record<UsagePreviewView, string> = { daily: "每天", weekly: "每周", cumulative: "累计总量" }

/** 挂载后按文案点选指标/查看方式（dev 预览；页面内是 useState，没有对应 props） */
function useAutoSwitch(params: UsagePreviewParams): void {
  useEffect(() => {
    if (typeof document === "undefined") return
    const timers: number[] = []
    let tries = 0
    const clickByText = (groupIndex: number, label: string): boolean => {
      const groups = document.querySelectorAll(".pi-usage-seg")
      const group = groups[groupIndex]
      if (!group) return false
      for (const button of [...group.querySelectorAll("button")]) {
        if ((button.textContent ?? "").trim() === label) {
          if (!button.hasAttribute("data-active")) (button as HTMLButtonElement).click()
          return true
        }
      }
      return false
    }
    const apply = (): void => {
      tries += 1
      const metricOk = params.metric === "tokens" || clickByText(0, METRIC_LABEL[params.metric])
      const viewOk = params.view === "daily" || clickByText(1, VIEW_LABEL[params.view])
      if (metricOk && viewOk) return
      if (tries < 20) timers.push(window.setTimeout(apply, 60))
    }
    const raf = window.requestAnimationFrame(apply)
    return () => {
      window.cancelAnimationFrame(raf)
      for (const timer of timers) window.clearTimeout(timer)
    }
  }, [params.metric, params.view, params.mode, params.fixture])
}

export function sizeOfVp(vp: string): { width: number; height: number } {
  const [width, height] = vp.split("x").map(Number)
  return { width: Number.isFinite(width) && width > 0 ? width : 1440, height: Number.isFinite(height) && height > 0 ? height : 900 }
}

export interface UsagePreviewProps {
  params: UsagePreviewParams
  fill?: boolean
}

/** dev 预览主体（devPreview.tsx 与 PiStage usage 路由共用） */
export function UsagePreview({ params, fill = true }: UsagePreviewProps) {
  const input = useMemo(() => usagePreviewPageInputOf(params), [params])
  const size = sizeOfVp(params.vp)
  useAutoSwitch(params)
  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.dataset.piTheme = params.theme
  }, [params.theme])
  const outerStyle: CSSProperties = fill
    ? { width: size.width, height: size.height, overflow: "hidden", background: params.theme === "light" ? "#f6f4f1" : "#0e0e10" }
    : { width: "100%", height: "100%", overflow: "auto" }
  return (
    <div
      className="pi-usage-preview"
      data-pi-usage="preview"
      data-pi-usage-host={params.host}
      data-pi-usage-fixture={params.fixture}
      data-pi-usage-mode={params.mode}
      data-pi-usage-metric={params.metric}
      data-pi-usage-view={params.view}
      data-pi-usage-preview=""
      data-pi-ready=""
      style={outerStyle}
    >
      <UsageActivityPage theme={params.theme} snapshot={input.snapshot} displayOverrides={input.displayOverrides} previewState={input.previewState} previewReason={input.previewReason} />
    </div>
  )
}

export { PI_UI_USAGE_FIXTURES, PI_UI_USAGE_FIXTURE_IDS }
