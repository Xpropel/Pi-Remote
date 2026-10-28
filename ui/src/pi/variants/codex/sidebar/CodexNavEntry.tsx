import type { ReactNode } from "react"

/** 一级入口行（[X-图6①]）：32 高、图标 16 + 13px 文本 + 可选数字角标 */
export function CodexNavEntry({ icon, label, count, hint, active, p4Action, onClick }: { icon: ReactNode; label: string; count?: number; hint?: string; active?: boolean; p4Action?: string; onClick: () => void }) {
  return (
    <button type="button" className="cx-nav-row" onClick={onClick} data-has-count={count ? "" : undefined} data-active={active ? "" : undefined} data-p4-action={p4Action}>
      {icon}
      <span>{label}</span>
      {hint ? <span className="cx-nav-hint">{hint}</span> : null}
      {count ? <span className="cx-nav-count">{count}</span> : null}
    </button>
  )
}
