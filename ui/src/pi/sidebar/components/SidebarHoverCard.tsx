import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { BranchIcon, ClockIcon, FolderTinyIcon, MonitorIcon } from "./icons"
import type { PiSidebarSession, PiSidebarStyle, PiSidebarTheme } from "../types"

export type SidebarHoverAnchor = { rowTop: number; rowBottom: number; sidebarRight: number }

/** P11-SIDE-10：悬停信息卡（264 宽、圆角 10）。
 * 浮层方案：createPortal 到 body + position:fixed + z-index 1000，锚定悬停行：
 * 默认卡片左边 = 侧栏右缘 + 8px、顶边与行顶对齐；视口右侧/底部不足时向左/向上收，避免被主区或裁剪祖先裁掉。
 */
export function SidebarHoverCard({
  session,
  style,
  theme,
  anchor,
  onMouseEnter,
  onMouseLeave,
}: {
  session: PiSidebarSession
  style: PiSidebarStyle
  theme?: PiSidebarTheme
  anchor: SidebarHoverAnchor | null
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const bubble = ref.current
    const height = bubble?.offsetHeight ?? 120
    const width = bubble?.offsetWidth ?? 264
    const margin = 8
    let left = anchor.sidebarRight + margin
    if (left + width + margin > window.innerWidth) left = Math.max(margin, anchor.sidebarRight - width - margin)
    let top = anchor.rowTop - 4
    if (top + height + margin > window.innerHeight) top = Math.max(margin, anchor.rowBottom - height)
    setPos({ left, top })
  }, [anchor])
  if (typeof document === "undefined") return null
  // 浮层挂到 .sb-root 内（而非 body）：避免 .sb-scroll 横向裁剪，同时继承 --sb-* token
  const container = document.querySelector("[data-pi-sidebar]") ?? document.body
  const tone = session.status.tone
  return createPortal(
    <div
      ref={ref}
      className="sb-bubble"
      data-pi-sidebar=""
      data-pi-sidebar-style={style}
      data-pi-theme={theme ?? document.documentElement.dataset.piTheme ?? "dark"}
      data-p11-surface="P11-SIDE-10"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="sb-bubble-title">{session.title}</p>
      {/* 设计 D §2.4 第三层：状态全句（roomStatusLine 输出，宿主按会话填）；没填时非空闲会话退回状态短句 */}
      {session.statusLine || tone !== "idle" ? (
        <p className="sb-bubble-status" data-tone={tone}>
          <span className="sb-bubble-dot" aria-hidden />
          <span>{session.statusLine || session.status.label}</span>
        </p>
      ) : null}
      <div className="sb-bubble-meta">
        {session.repo ? <p className="sb-bubble-line"><BranchIcon /><span>{session.repo}</span></p> : null}
        {session.cwd ? <p className="sb-bubble-line"><FolderTinyIcon /><span>{session.cwd}</span></p> : null}
        {/* D-3: full timestamp line — same-title stored rows are told apart by it. */}
        {session.dateTimeLabel ? <p className="sb-bubble-sub"><ClockIcon /><span>{session.dateTimeLabel}</span></p> : null}
        {session.deviceName ? <p className="sb-bubble-sub"><MonitorIcon size={12} /><span>{session.deviceName}</span></p> : null}
      </div>
    </div>,
    container,
  )
}
