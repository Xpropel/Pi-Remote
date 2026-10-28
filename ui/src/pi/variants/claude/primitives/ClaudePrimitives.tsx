import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react"
import { MARK_TEXT, MenuCloseContext, useEscClose, useMenuClose } from "./useClaude"
import { cx } from "../model/cx"

/**
 * Claude v2 · 自有基础原语（完全自包含：不 import @/components/pi、@/components/kit、@/pi/containers；
 * 图标用第三方 headless SVG 库 lucide-react，样式全部走 --claude-* 与自有类名）。
 */

/* ---------------------------------------------------------------- 图标 / 标记 */

export function ClaudeMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <span aria-hidden className={cx("claude-mark", className)} style={{ fontSize: size }}>
      {MARK_TEXT}
    </span>
  )
}

export function ClaudeDot({ kind }: { kind: "waiting" | "running" | "idle" | "offline" | "error" | "unread" }) {
  return <span aria-hidden className="claude-dot" data-dot={kind} />
}

/* ---------------------------------------------------------------- 按钮 / 输入 */

type ButtonKind = "primary" | "secondary" | "ghost" | "danger" | "outline"

export function ClaudeButton({
  kind = "primary",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: ButtonKind }) {
  return (
    <button type="button" className={cx("claude-btn", `claude-btn-${kind}`, className)} {...rest}>
      {children}
    </button>
  )
}

export function ClaudeIconButton({
  label,
  icon,
  className,
  pressed,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cx("claude-icon-btn", className)}
      data-pressed={pressed ? "" : undefined}
      {...rest}
    >
      {icon}
    </button>
  )
}

export function ClaudeKbd({ children }: { children: ReactNode }) {
  return <span className="claude-kbd">{children}</span>
}

export function ClaudeField({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  return (
    <label className={cx("claude-field", className)}>
      {label ? <span className="claude-field-label">{label}</span> : null}
      <input className="claude-input" {...rest} />
    </label>
  )
}

export function ClaudeTextArea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx("claude-textarea", className)} {...rest} />
}

export function ClaudeSwitch({ checked, onChange, label }: { checked: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="claude-switch"
      data-on={checked ? "" : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className="claude-switch-thumb" />
    </button>
  )
}

export function ClaudeSegment<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  label?: string
}) {
  return (
    <div className="claude-segment" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="claude-segment-item"
          data-active={option.value === value ? "" : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ClaudeSpinner({ size = 14, label }: { size?: number; label?: string }) {
  return <span className="claude-spinner" style={{ width: size, height: size }} role="status" aria-label={label ?? "加载中"} />
}

export function ClaudeBadge({ children, tone }: { children: ReactNode; tone?: "clay" | "muted" }) {
  return (
    <span className="claude-badge" data-tone={tone}>
      {children}
    </span>
  )
}

export function ClaudeCopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="claude-copyfield">
      <code className="claude-copyfield-value">{value}</code>
      <button
        type="button"
        className="claude-btn claude-btn-outline claude-btn-sm"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        {copied ? "已复制" : label}
      </button>
    </div>
  )
}

/* ---------------------------------------------------------------- 上下文圆环 */

export function ClaudeContextRing({ percent, size = 28 }: { percent: number | null; size?: number }) {
  const r = (size - 4) / 2
  const c = 2 * Math.PI * r
  const pct = percent == null ? 0 : Math.max(0, Math.min(1, percent))
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="claude-ring-svg" role="img" aria-label={percent == null ? "上下文用量未知" : `上下文 ${Math.round(pct * 100)}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={2.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

/* ---------------------------------------------------------------- 菜单（自有，不 portal） */

export function ClaudeMenu({
  trigger,
  children,
  align = "start",
  side = "bottom",
  width = 220,
}: {
  trigger: ReactElement
  children: ReactNode
  align?: "start" | "center" | "end"
  side?: "bottom" | "top"
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const close = useCallback(() => setOpen(false), [])
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("pointerdown", onDown, true)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [open])
  return (
    <span className="claude-menu-anchor" ref={rootRef}>
      <span className="claude-menu-trigger" onClick={() => setOpen((v) => !v)} data-open={open ? "" : undefined}>
        {trigger}
      </span>
      {open ? (
        <div className="claude-menu" data-side={side} data-align={align} style={{ width }}>
          <MenuCloseContext.Provider value={close}>{children}</MenuCloseContext.Provider>
        </div>
      ) : null}
    </span>
  )
}

export function ClaudeMenuItem({
  children,
  onClick,
  disabled,
  hint,
  danger,
  shortcut,
  title,
  ...rest
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  hint?: string
  danger?: boolean
  shortcut?: string
  title?: string
} & Omit<import("react").ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled" | "title" | "danger" | "children">) {
  const close = useMenuClose()
  return (
    <button
      type="button"
      role="menuitem"
      className="claude-menu-item"
      data-danger={danger ? "" : undefined}
      disabled={disabled}
      title={title ?? hint}
      {...rest}
      onClick={() => {
        if (disabled) return
        close()
        onClick?.()
      }}
    >
      <span className="claude-menu-item-label">{children}</span>
      {shortcut ? <span className="claude-menu-item-shortcut">{shortcut}</span> : null}
    </button>
  )
}

export function ClaudeMenuSeparator() {
  return <div className="claude-menu-sep" role="separator" />
}

export function ClaudeMenuLabel({ children }: { children: ReactNode }) {
  return <div className="claude-menu-label">{children}</div>
}

/* ---------------------------------------------------------------- 对话框 / sheet */

export function ClaudeDialog({
  title,
  subtitle,
  children,
  footer,
  onClose,
  width = 400,
  danger,
}: {
  title: ReactNode
  subtitle?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: number
  danger?: boolean
}) {
  useEscClose(true, onClose)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>("[data-autofocus], input, textarea, button")
    el?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="claude-overlay-layer claude-dialog-layer" role="presentation">
      <button type="button" aria-label="关闭" className="claude-overlay-backdrop" onClick={onClose} />
      <div className="claude-dialog" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "对话框"} style={{ width }} data-danger={danger ? "" : undefined} ref={ref}>
        <header className="claude-dialog-head">
          <h2 className="claude-dialog-title">{title}</h2>
          {subtitle ? <p className="claude-dialog-subtitle">{subtitle}</p> : null}
        </header>
        <div className="claude-dialog-body">{children}</div>
        {footer ? <footer className="claude-dialog-footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function ClaudeSheet({
  title,
  subtitle,
  children,
  footer,
  onClose,
}: {
  title: ReactNode
  subtitle?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  onClose: () => void
}) {
  useEscClose(true, onClose)
  return (
    <div className="claude-overlay-layer claude-sheet-layer" role="presentation">
      <button type="button" aria-label="关闭" className="claude-overlay-backdrop" onClick={onClose} />
      <div className="claude-sheet" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "面板"}>
        <div className="claude-sheet-grabber" aria-hidden />
        <header className="claude-sheet-head">
          <div className="claude-sheet-head-text">
            <h2 className="claude-sheet-title">{title}</h2>
            {subtitle ? <p className="claude-sheet-subtitle">{subtitle}</p> : null}
          </div>
          <ClaudeButton kind="ghost" className="claude-btn-sm" onClick={onClose}>
            关闭
          </ClaudeButton>
        </header>
        <div className="claude-sheet-body">{children}</div>
        {footer ? <footer className="claude-sheet-footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- 空态 / 区块 */

export function ClaudeEmptyState({ title, body, action }: { title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="claude-empty-state">
      <ClaudeMark size={28} />
      <p className="claude-empty-title">{title}</p>
      {body ? <p className="claude-empty-body">{body}</p> : null}
      {action}
    </div>
  )
}

export function ClaudeCard({ title, children, action, className }: { title?: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={cx("claude-card", className)}>
      {title ? (
        <header className="claude-card-head">
          <h2 className="claude-card-title">{title}</h2>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  )
}

/** 行样式：设置页 / 详情页的行（Claude 纸面语言：1px 分隔、8–10 圆角） */
export function ClaudeRow({ label, hint, control, onClick, tone }: { label: ReactNode; hint?: ReactNode; control?: ReactNode; onClick?: () => void; tone?: "danger" }) {
  const content = (
    <>
      <span className="claude-row-body">
        <span className="claude-row-label" data-tone={tone}>
          {label}
        </span>
        {hint ? <span className="claude-row-hint">{hint}</span> : null}
      </span>
      {control ? <span className="claude-row-control">{control}</span> : null}
    </>
  )
  if (onClick) {
    return (
      <button type="button" className="claude-list-row claude-list-row-click" onClick={onClick}>
        {content}
      </button>
    )
  }
  return <div className="claude-list-row">{content}</div>
}

export function ClaudeSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="claude-skeleton">
      {Array.from({ length: lines }).map((_, i) => (
        <span key={i} style={{ width: `${[92, 78, 56][i % 3]}%` } as CSSProperties} />
      ))}
    </div>
  )
}

