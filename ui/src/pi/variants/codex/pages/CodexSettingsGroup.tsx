import type { ReactNode } from "react"

/** 设置分组（[X-图15①]）：分组标题 12px 灰 + 行 44 + 卡片 S2 底 */
export function CodexSettingsGroup({ title, note, id, registerRef, children }: { title: string; note?: string; id: string; registerRef: (id: string, el: HTMLElement | null) => void; children: ReactNode }) {
  return (
    <section className="cx-set-group" data-settings-section={id} aria-label={title} ref={(el) => registerRef(id, el)}>
      <h2 className="cx-set-group-title">{title}</h2>
      <div className="cx-set-card">{children}</div>
      {note ? <p className="cx-set-note">{note}</p> : null}
    </section>
  )
}

/** 设置行（[X-图15④⑤⑥⑦]：行高 ≥44、右侧控件水平对齐） */
export function CodexSettingsRow({ label, hint, danger, children }: { label: string; hint?: string; danger?: boolean; children?: React.ReactNode }) {
  return (
    <div className="cx-set-row">
      <span className="cx-set-row-main">
        <span className={danger ? "cx-set-row-label cx-set-row-label-danger" : "cx-set-row-label"}>{label}</span>
        {hint ? <span className="cx-set-row-hint">{hint}</span> : null}
      </span>
      {children ? <span className="cx-set-row-ctrl">{children}</span> : null}
    </div>
  )
}

/** 分段（当前项白底） */
export function CodexSegmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: string }[]; onChange: (next: T) => void; label: string }) {
  return (
    <div className="cx-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} className="cx-seg-btn" data-active={value === option.value ? "" : undefined} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 开关（整行可点由调用方包 label；这里只画控件） */
export function CodexSwitch({ on, onToggle, label, stage }: { on: boolean; onToggle: () => void; label: string; stage: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="cx-switch" data-on={on ? "" : undefined} disabled={stage} onClick={stage ? undefined : onToggle}>
      <span className="cx-switch-thumb" aria-hidden />
    </button>
  )
}
