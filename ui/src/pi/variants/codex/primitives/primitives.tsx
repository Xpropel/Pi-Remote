import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react"
import { cx } from "../root/context"

/** 品牌占位图标（中性圆角方块 + 斜切；不搬运参考 app 的 logo） */
export function CodexMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="cx-mark" aria-hidden>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
      <path d="M8.5 15.5 15.5 8.5" strokeLinecap="round" />
    </svg>
  )
}

export function CodexButton({ kind = "outline", className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "outline" | "ghost" | "danger" }) {
  return (
    <button type="button" className={cx("cx-btn", `cx-btn-${kind}`, className)} {...rest}>
      {children}
    </button>
  )
}

export function CodexIconButton({ label, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" className={cx("cx-icon-btn", className)} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  )
}

export function CodexPill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("cx-pill", className)}>{children}</span>
}

export function CodexKbd({ children }: { children: ReactNode }) {
  return <kbd className="cx-kbd">{children}</kbd>
}

export function CodexSpinner({ size = 14 }: { size?: number }) {
  return (
    <span className="cx-spinner" style={{ width: size, height: size }} role="status" aria-label="加载中">
      <span className="cx-spinner-arc" />
    </span>
  )
}

export function CodexSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="cx-skeleton" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div className="cx-skeleton-row" key={i} />
      ))}
    </div>
  )
}

export function CodexCentered({ spinner, title, body, action }: { spinner?: boolean; title: ReactNode; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="cx-centered">
      {spinner ? <CodexSpinner size={18} /> : null}
      <div className="cx-centered-title">{title}</div>
      {body != null ? <div className="cx-centered-body">{body}</div> : null}
      {action != null ? <div className="cx-centered-action">{action}</div> : null}
    </div>
  )
}

/** 变体自己的对话框壳（桌面居中卡 / 手机底部 sheet；渲染在变体根内部，不 portal 到 body） */
export function CodexDialog({
  title,
  subtitle,
  danger,
  onClose,
  footer,
  children,
  phone,
  width = 420,
  labelledBy,
}: {
  title: ReactNode
  subtitle?: ReactNode
  danger?: boolean
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
  phone?: boolean
  width?: number
  labelledBy?: string
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  // a11y：Esc 在任意焦点位置都能关闭（不要求焦点在对话框内）；打开时把焦点移入对话框
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      onClose()
    }
    document.addEventListener("keydown", onKey)
    dialogRef.current?.focus()
    return () => document.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div
      className="cx-dialog-layer"
      role="presentation"
      data-pi-ui-part="dialog"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className={cx("cx-dialog", phone && "cx-dialog-phone")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : typeof title === "string" ? title : "对话框"}
        tabIndex={-1}
        style={phone ? undefined : { width }}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose()
          if (event.key !== "Tab") return
          const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )
          if (!focusables || focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header className="cx-dialog-head">
          <h2 className={cx("cx-dialog-title", danger && "cx-dialog-title-danger")} id={labelledBy}>
            {title}
          </h2>
          <button type="button" className="cx-icon-btn" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {subtitle != null ? <div className="cx-dialog-subtitle">{subtitle}</div> : null}
        <div className="cx-dialog-body">{children}</div>
        {footer != null ? <footer className="cx-dialog-foot">{footer}</footer> : null}
      </div>
    </div>
  )
}
