import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { PI_SIDEBAR_COPY, type PiSidebarSession } from "../sidebar/types.ts"
import { IconArchive, IconDot, IconPin } from "./icons"

const SWIPE_WIDTH = 148
const OPEN = -SWIPE_WIDTH
const LONG_PRESS_MS = 480

/**
 * P11-MOB-07/08 列表会话行（60 两行）+ 左滑操作层（148 = 两钮各 74×60）。
 * 数据/动作来自 PiSidebarData/Actions；pin/archive 由宿主 action 处理（arch storage 本机状态）。
 */
export function SwipeRow({
  session,
  onOpen,
  onPin,
  onArchive,
  onLongPress,
}: {
  session: PiSidebarSession
  onOpen: (sessionKey: string) => void
  onPin: (sessionKey: string) => void
  onArchive: (sessionKey: string) => void
  onLongPress: (session: PiSidebarSession) => void
}) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ id: number; startX: number; startY: number; base: number; moved: boolean } | null>(null)
  const longPress = useRef<number | null>(null)
  const clickSuppress = useRef(false)
  const open = offset <= OPEN / 2
  const tone = session.status.tone

  useEffect(() => () => {
    if (longPress.current != null) window.clearTimeout(longPress.current)
  }, [])

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current) return
    drag.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture?.(current.id)
    if (!current.moved) return
    setOffset((value) => (value < OPEN / 2 ? OPEN : 0))
  }
  const startLongPress = () => {
    if (longPress.current != null) window.clearTimeout(longPress.current)
    longPress.current = window.setTimeout(() => {
      longPress.current = null
      clickSuppress.current = true
      onLongPress(session)
    }, LONG_PRESS_MS)
  }
  const cancelLongPress = () => {
    if (longPress.current != null) {
      window.clearTimeout(longPress.current)
      longPress.current = null
    }
  }

  return (
    <div className="pm-swipe" data-open={open ? "" : undefined} data-dragging={dragging ? "" : undefined} data-pi-mobile-surface="P11-MOB-08">
      <div className="pm-swipe-actions" aria-hidden={!open}>
        <button
          type="button"
          className="pm-swipe-btn pm-swipe-pin"
          aria-label={`置顶：${session.title}`}
          title={PI_SIDEBAR_COPY.pinTitle}
          tabIndex={open ? 0 : -1}
          onClick={() => {
            setOffset(0)
            onPin(session.key)
          }}
        >
          <IconPin size={19} />
          <span>置顶</span>
        </button>
        <button
          type="button"
          className="pm-swipe-btn pm-swipe-archive"
          aria-label={`归档：${session.title}`}
          title={PI_SIDEBAR_COPY.archiveTitle}
          tabIndex={open ? 0 : -1}
          onClick={() => {
            setOffset(0)
            onArchive(session.key)
          }}
        >
          <IconArchive size={19} />
          <span>归档</span>
        </button>
      </div>
      <div
        className="pm-swipe-row"
        data-dragging={dragging ? "" : undefined}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return
          drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, base: offset, moved: false }
          startLongPress()
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (!current) return
          const dx = event.clientX - current.startX
          const dy = event.clientY - current.startY
          if (!current.moved && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
            if (Math.abs(dy) > Math.abs(dx)) {
              drag.current = null
              cancelLongPress()
              setDragging(false)
              return
            }
            current.moved = true
            cancelLongPress()
            setDragging(true)
            event.currentTarget.setPointerCapture?.(current.id)
          }
          if (!current.moved) return
          setOffset(Math.max(OPEN, Math.min(0, current.base + dx)))
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          cancelLongPress()
          if (clickSuppress.current) {
            clickSuppress.current = false
            return
          }
          if (open) {
            setOffset(0)
            return
          }
          onOpen(session.key)
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          cancelLongPress()
          onLongPress(session)
        }}
        role="button"
        tabIndex={0}
        aria-label={`${session.title}${session.summary ? `：${session.summary}` : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            if (open) setOffset(0)
            else onOpen(session.key)
          }
          if (event.key === "F10" && event.shiftKey) {
            event.preventDefault()
            onLongPress(session)
          }
        }}
      >
        <span className="pm-row-dot" data-marker={tone} aria-hidden>
          <IconDot size={8} />
        </span>
        <span className="pm-row-main">
          <span className="pm-row-line1">
            <span className="pm-row-title">{session.title}</span>
            {session.timeLabel ? <span className="pm-row-time">{session.timeLabel}</span> : null}
          </span>
          <span className="pm-row-line2">{session.summary || "\u00a0"}</span>
        </span>
      </div>
    </div>
  )
}
