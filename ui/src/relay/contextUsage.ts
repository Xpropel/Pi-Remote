/** 上下文条的展示口径。不依赖 React，测试可直接引用。
 * pi 的 contextUsage.percent 是百分点（100 = 满），不是 0~1 的比例。
 * 1561 token、100 万窗口时它是 0.1561，表示 0.16%。再乘 100 会显示成 15.6%。
 * 有 tokens 和 contextWindow 时以两者相除为准。窗口缺失或过小时不报百分比。
 */

/** 小于这个值的 contextWindow 不当成真实容量（常见误配远小于 8k）。 */
export const MIN_CONTEXT_WINDOW = 8192

export type ContextUsageLike = {
  tokens?: unknown
  contextWindow?: unknown
  percent?: unknown
}

export type ContextReadout = {
  /** none：没有用量；untrusted：窗口缺失或过小；ok：窗口可信，percent 按原口径 */
  state: "none" | "untrusted" | "ok"
  /** 0~1 的占用比例，给进度条用。超过 1 表示已经超出窗口。不可信时为 null。 */
  percent: number | null
  /** 短文案。没有用量时是空串。 */
  label: string
  /** label 的结构化拆分（R4-3②）：恒有 label === before + (percent ?? "") + after。
   * 只有 ok 且有可信比例时 percent 非 null（即 percentText 的原文），呈现层据此
   * 把百分比数字段单独以 700 渲染（DESIGN-V3 字重口径：700 只许关键数字）；
   * 其余状态 percent 为 null、before 即整串 label，呈现与拆分前逐字一致。 */
  labelParts: { before: string; percent: string | null; after: string }
  title: string
}

export function formatCount(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? "-" : ""
  if (abs >= 1_000_000) {
    const n = abs / 1_000_000
    const text = n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, "")
    return `${sign}${text}M`
  }
  if (abs >= 1000) {
    const n = abs / 1000
    const text = n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, "")
    return `${sign}${text}k`
  }
  return value.toLocaleString("zh-CN")
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function percentText(fraction: number): string {
  const pct = fraction * 100
  const digits = pct !== 0 && Math.abs(pct) < 1 ? 2 : 1
  const text = pct.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1")
  return `${text}%`
}

/** 窗口缺失或小于 8192 时不可信。可信时占用 = tokens / contextWindow；只有 pi 的百分点时再除以 100。 */
export function contextReadout(ctx: ContextUsageLike | null | undefined): ContextReadout {
  const tokens = finite(ctx?.tokens) ? ctx.tokens : null
  const window = finite(ctx?.contextWindow) ? ctx.contextWindow : null
  const percentPoints = finite(ctx?.percent) ? ctx.percent : null
  if (tokens == null && window == null && percentPoints == null) {
    return { state: "none", percent: null, label: "", labelParts: { before: "", percent: null, after: "" }, title: "还没有上下文占用" }
  }
  if (window == null || window < MIN_CONTEXT_WINDOW) {
    const label = tokens == null ? "窗口未知" : `上下文 ${tokens.toLocaleString("zh-CN")} · 窗口未知`
    const title = tokens == null ? "窗口未知" : `${tokens.toLocaleString("zh-CN")} tokens · 窗口未知`
    return { state: "untrusted", percent: null, label, labelParts: { before: label, percent: null, after: "" }, title }
  }
  const fraction = tokens != null ? tokens / window : percentPoints != null ? percentPoints / 100 : null
  if (fraction == null) {
    const shown = `窗口 ${window.toLocaleString("zh-CN")}`
    return { state: "ok", percent: null, label: shown, labelParts: { before: shown, percent: null, after: "" }, title: shown }
  }
  const shown = percentText(fraction)
  const ratio = tokens != null
    ? `${tokens.toLocaleString("zh-CN")} / ${window.toLocaleString("zh-CN")}`
    : `窗口 ${window.toLocaleString("zh-CN")}`
  return { state: "ok", percent: fraction, label: `上下文 ${shown}`, labelParts: { before: "上下文 ", percent: shown, after: "" }, title: `上下文 ${shown} · ${ratio}` }
}

export type ContextRingSpec = {
  /** 钳到 0~1 的占用比例：超 100% 满格（真实百分比仍由 readout 的 label 文案保留）。 */
  fraction: number
  tone: "ok" | "warn" | "bad"
}

/** 状态行圆环的呈现决策（R3-6）：没有可信比例时返回 null——readout 为 none /
 * untrusted、或窗口可信但无用量（percent 为 null）时状态行只呈诚实文本，
 * 不上环、不编造百分比。有比例时色调阈值：≥70% 警告、≥90% 危险。 */
export function contextRingOf(percent: number | null | undefined): ContextRingSpec | null {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null
  const fraction = Math.max(0, Math.min(1, percent))
  const tone = fraction >= 0.9 ? "bad" : fraction >= 0.7 ? "warn" : "ok"
  return { fraction, tone }
}
