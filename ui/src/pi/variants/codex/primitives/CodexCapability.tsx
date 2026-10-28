import type { ReactNode } from "react"
import type { PiUiDisabledStateView } from "@/pi/extensions"
import { CircleHelp, Puzzle } from "../icons/CodexIcons"

/**
 * P4 能力层的最小呈现件（Wave1）：
 * Pi-Remote 没有的参考能力也把 UI 做完整，但运行时禁用并解释「本机 pi 未提供此能力，可接入扩展」。
 * 这些件只做视觉/语义，能力状态由上层（能力注册表 / 台账）决定，Wave1 先用于静态禁用态。
 */

/** 小徽标（中性） */
export function CodexBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" }) {
  return (
    <span className="cx-badge" data-tone={tone}>
      {children}
    </span>
  )
}

/** 「可接入 / 模拟演示」徽标：tooltip 直接取契约 disabled view 的 title（与 CodexExtensionNotice 同源，不硬编码文案） */
export function CodexCapabilityBadge({ label = "可接入", view }: { label?: string; view?: PiUiDisabledStateView | null }) {
  const title = view?.title ?? label
  return (
    <span className="cx-cap-badge" title={title}>
      <Puzzle aria-hidden size={10} strokeWidth={1.75} />
      {label}
    </span>
  )
}

/** 禁用原因行（内联；不给 title 也能读） */
export function CodexDisabledNote({ children, icon = true }: { children: ReactNode; icon?: boolean }) {
  return (
    <p className="cx-disabled-note" role="note">
      {icon ? <CircleHelp aria-hidden size={12} strokeWidth={1.75} /> : null}
      <span>{children}</span>
    </p>
  )
}

/**
 * 整页能力缺失说明卡（契约禁用/模拟态视图渲染）：标题/原因/提示/文档锚点全部来自 `@/pi/extensions`，
 * 变体只负责视觉；`view == null`（available）时不渲染。
 */
export function CodexExtensionNotice({ view, mock = false }: { view: PiUiDisabledStateView | null; mock?: boolean }) {
  if (!view) return null
  const title = view.simulated ? "模拟演示（未接入真实扩展）" : `${view.label}能力未接入`
  return (
    <section className="cx-ext-notice" aria-label={title} data-capability-state={view.status} data-p4-surface={`CAP-${view.capability}`}>
      <div className="cx-ext-notice-head">
        <Puzzle aria-hidden size={14} strokeWidth={1.75} />
        <span className="cx-ext-notice-title">{title}</span>
        <CodexCapabilityBadge label={view.simulated ? "模拟演示" : "可接入"} view={view} />
      </div>
      <p className="cx-ext-notice-body">
        {view.reason}
        {view.hint ? ` ${view.hint}` : ""}
      </p>
      <p className="cx-ext-notice-doc">
        {view.howToConnectLabel}：实现能力 provider 并在设置里启用 · 见 <code>{view.docsPath}</code>
        {mock ? <span className="cx-ext-notice-mock"> · dev mock 已注入（仅开发/验收）</span> : null}
      </p>
    </section>
  )
}
