import { useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { BranchIcon, FolderTinyIcon } from "./icons"
import type { PiSidebarSession, PiSidebarStyle } from "../types"

/** P11-SIDE-10：悬停信息气泡（230 宽、圆角 10）。
 * 浮层方案：createPortal 到 body + position:fixed + z-index 1000，锚定悬停行：
 * 默认气泡左边 = 侧栏右缘 + 8px、顶边与行顶对齐；视口右侧/底部不足时向左/向上收，避免被主区或裁剪祖先裁掉。
 */
export function SidebarHoverCard({
  session,
  style,
  anchor,
  onMouseEnter,
  onMouseLeave,
}: {
  session: PiSidebarSession
  style: PiSidebarStyle
  anchor: { rowTop: number; rowBottom: number; sidebarRight: number } | null
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor) return
    const bubble = ref.current
    const height = bubble?.offsetHeight ?? 120
    const width = bubble?.offsetWidth ?? 230
    const margin = 8
    let left = anchor.sidebarRight + margin
    if (left + width + margin > window.innerWidth) left = Math.max(margin, anchor.sidebarRight - width - margin)
    let top = anchor.rowTop
    if (top + height + margin > window.innerHeight) top = Math.max(margin, anchor.rowBottom - height)
    setPos({ left, top })
  }, [anchor])
  if (typeof document === "undefined") return null
  // 浮层挂到 .sb-root 内（而非 body）：避免 .sb-scroll 横向裁剪，同时继承六套 --sb-* token/衬线变量
  const container = document.querySelector("[data-pi-sidebar]") ?? document.body
  return createPortal(
    <div
      ref={ref}
      className="sb-bubble"
      data-pi-sidebar=""
      data-pi-sidebar-style={style}
      data-pi-theme={(typeof document !== "undefined" && document.documentElement.dataset.piTheme) || "dark"}
      data-p11-surface="P11-SIDE-10"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="sb-bubble-title">{session.title}</p>
      <p className="sb-bubble-line"><BranchIcon size={12} />{session.repo || "—"}</p>
      <p className="sb-bubble-line"><FolderTinyIcon size={12} />{session.cwd || "—"}</p>
      <p className="sb-bubble-sub">{[session.deviceName, "本地"].filter(Boolean).join(" · ")}</p>
      {/* 设计 D §2.4 第三层：气泡加一行状态全句（roomStatusLine 输出，宿主按会话填；没填就不加行，零布局冲突） */}
      {session.statusLine ? <p className="sb-bubble-status">{session.statusLine}</p> : null}
    </div>,
    container,
  )
}
