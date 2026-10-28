import type { ReactNode } from "react"

/** 手机底部 sheet 壳（推导：16 圆角 + 把手 + 遮罩；渲染在变体根内部）。内容由 dialogs/menus 复用本壳 */
export function CodexPhoneSheet({ title, children, onClose }: { title?: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="cx-sheet-layer" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="cx-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <span className="cx-sheet-handle" aria-hidden />
        {title ? <div className="cx-sheet-title">{title}</div> : null}
        <div className="cx-sheet-body">{children}</div>
      </div>
    </div>
  )
}
