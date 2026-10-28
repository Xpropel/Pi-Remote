import { useEffect, useRef } from "react"
import { cx } from "../root/context"

export interface CodexMenuItem {
  key: string
  label: string
  disabled?: boolean
  reason?: string
  danger?: boolean
  kbd?: string
}

/** 12 圆角菜单浮层（[X-图9]：0.5px 边 + 柔影；深色底 #282828）；锚点坐标渲染在变体根内，不 portal 到 body */
export function CodexMenu({
  at,
  items,
  onPick,
  onClose,
  label,
}: {
  at: { x: number; y: number } | null
  items: readonly CodexMenuItem[]
  onPick: (key: string) => void
  onClose: () => void
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("pointerdown", onDown, true)
      document.removeEventListener("keydown", onKey)
    }
  }, [onClose])
  if (!at) return null
  return (
    <div ref={ref} className="cx-menu" role="menu" aria-label={label ?? "菜单"} style={{ left: at.x, top: at.y }}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          className={cx("cx-menu-row", item.danger && "cx-menu-row-danger")}
          disabled={item.disabled}
          title={item.disabled ? item.reason : undefined}
          onClick={() => {
            if (item.disabled) return
            onPick(item.key)
          }}
        >
          <span className="cx-menu-label">{item.label}</span>
          {item.kbd ? <span className="cx-menu-kbd">{item.kbd}</span> : null}
          {item.disabled && item.reason ? <span className="cx-menu-reason">{item.reason}</span> : null}
        </button>
      ))}
    </div>
  )
}
