import { useEffect, useRef } from "react"
import { PI_SIDEBAR_COPY, type PiSidebarSession } from "../sidebar/types.ts"
import { IconArchive, IconClose, IconMore, IconPin, IconUnarchive } from "./icons"

/**
 * P11-MOB-09 长按预览卡（两模式通用）：宽 min(320,屏宽−48)，标题/仓库/路径/时间·设备 + 置顶/归档（已置顶/已归档时为取消）
 * + 宿主给了 onMore 时的「更多」（完整会话菜单）。
 */
export function LongPressCard({
  session,
  onPin,
  onArchive,
  onMore,
  onClose,
}: {
  session: PiSidebarSession
  onPin: (sessionKey: string) => void
  onArchive: (sessionKey: string) => void
  onMore?: () => void
  onClose: () => void
}) {
  const firstRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    firstRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      previous?.focus?.()
    }
  }, [onClose])
  const where = [session.dateTimeLabel, `${session.deviceName || "本机"} · 本地`].filter(Boolean).join(" · ")
  return (
    <div className="pm-card-layer" role="presentation" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="pm-longpress-card" role="dialog" aria-modal="true" aria-label={`${session.title} 会话操作`} data-pi-mobile-surface="P11-MOB-09">
        <div className="pm-longpress-head">
          <span className="pm-longpress-title">{session.title}</span>
          <button type="button" className="pm-icon-btn pm-icon-btn-sm" aria-label="关闭" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        {session.repo ? (
          <p className="pm-longpress-line">
            <span className="pm-longpress-key">仓库</span>
            <span className="pm-longpress-value">{session.repo}</span>
          </p>
        ) : null}
        {session.cwd ? (
          <p className="pm-longpress-line">
            <span className="pm-longpress-key">路径</span>
            <span className="pm-longpress-value pm-mono">{session.cwd}</span>
          </p>
        ) : null}
        {/* D-3: full timestamp (session.dateTimeLabel) so same-title stored rows can be told apart here too. */}
        <p className="pm-longpress-sub">{where}</p>
        <p className="pm-longpress-hint">{PI_SIDEBAR_COPY.pinHint}</p>
        <div className="pm-longpress-actions">
          <button ref={firstRef} type="button" className="pm-longpress-action" onClick={() => { onPin(session.key); onClose() }}>
            <IconPin size={18} />
            {session.pinned ? "取消置顶" : "置顶"}
          </button>
          <button type="button" className="pm-longpress-action pm-longpress-archive" onClick={() => { onArchive(session.key); onClose() }}>
            {session.archived ? <IconUnarchive size={18} /> : <IconArchive size={18} />}
            {session.archived ? "取消归档" : "归档"}
          </button>
          {onMore ? (
            <button
              type="button"
              className="pm-longpress-action"
              aria-haspopup="dialog"
              onClick={() => {
                onClose()
                onMore()
              }}
            >
              <IconMore size={18} />
              更多
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
