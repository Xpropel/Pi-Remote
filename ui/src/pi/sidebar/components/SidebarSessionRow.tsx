import { useEffect, useRef, useState } from "react"
import { encBadgeLabelOf } from "../../../relay/devices.ts"
import { ArchiveIcon, PinIcon } from "./icons"
import { SidebarHoverCard } from "./SidebarHoverCard"
import type { PiSidebarSession, PiSidebarStyle } from "../types"

/** P11-SIDE-08/09/10：28px 行、左 padding 34 + 状态字形 transform 归位对齐线 29.5、悬停图钉/归档 + 230 气泡。 */
export function SidebarSessionRow({
  session,
  style,
  selected,
  onOpen,
  onPin,
  onArchive,
  onHover,
}: {
  session: PiSidebarSession
  style: PiSidebarStyle
  selected?: string
  onOpen: () => void
  onPin: () => void
  onArchive: () => void
  onHover?: (sessionKey: string | null) => void
}) {
  const [hover, setHover] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [anchor, setAnchor] = useState<{ rowTop: number; rowBottom: number; sidebarRight: number } | null>(null)
  const isSelected = session.selected || selected === session.key
  const open = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    const row = wrapRef.current?.getBoundingClientRect()
    const sidebar = wrapRef.current?.closest("[data-pi-sidebar]")?.getBoundingClientRect()
    if (row && sidebar) setAnchor({ rowTop: row.top, rowBottom: row.bottom, sidebarRight: sidebar.right })
    setHover(true)
  }
  const scheduleClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setHover(false), 120)
  }
  useEffect(() => {
    if (!hover) return
    const close = () => {
      setHover(false)
      setAnchor(null)
    }
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [hover])
  useEffect(() => () => { if (closeTimer.current) window.clearTimeout(closeTimer.current) }, [])
  // Phase 4 T-1: the badge names the plaintext reason when the relay derived
  // one; null keeps the row badge-free (relay never stated the enc state).
  const encBadge = encBadgeLabelOf(session.enc, session.encReason)
  return (
    <div
      ref={wrapRef}
      className="sb-rowwrap"
      onMouseEnter={() => {
        open()
        onHover?.(session.key)
      }}
      onMouseLeave={() => {
        scheduleClose()
        onHover?.(null)
      }}
      onFocus={open}
      onBlur={scheduleClose}
    >
      <div className="sb-row" data-row="" data-style={style} data-active={isSelected ? "" : undefined} data-tone={session.status.tone} data-p11-surface="P11-SIDE-08">
        <button type="button" className="sb-row-main" onClick={onOpen} aria-label={session.title}>
          <span className="sb-marker" aria-hidden data-tone={session.status.tone} />
          <span className="sb-row-title" title={session.status.label}>{session.title}</span>
          {encBadge ? <span className="sb-row-enc">{encBadge}</span> : null}
        </button>
        <span className="sb-row-right">
          <span className="sb-row-actions" data-p11-surface="P11-SIDE-09">
            <button type="button" className="sb-row-action" aria-label="置顶" title={session.pinned ? "取消置顶" : "置顶"} onClick={onPin}>
              <PinIcon size={19} />
            </button>
            <button type="button" className="sb-row-action" data-action="archive" aria-label="归档" title="归档" onClick={onArchive}>
              <ArchiveIcon size={14} />
            </button>
          </span>
          {session.timeLabel ? <span className="sb-row-time">{session.timeLabel}</span> : null}
        </span>
      </div>
      {hover && anchor ? <SidebarHoverCard session={session} style={style} anchor={anchor} onMouseEnter={open} onMouseLeave={scheduleClose} /> : null}
    </div>
  )
}
