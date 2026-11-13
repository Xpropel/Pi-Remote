import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react"
import { PiMenu } from "@/components/pi/shared/PiOverlay"
import { encBadgeLabelOf } from "../../../relay/devices.ts"
import { ArchiveIcon, MoreIcon, PinIcon, UnarchiveIcon } from "./icons"
import { SidebarHoverCard, type SidebarHoverAnchor } from "./SidebarHoverCard"
import type { PiSidebarSession, PiSidebarStyle, PiSidebarTheme } from "../types"

/** 悬停卡：指针停稳 400ms 才出；刚看过一张卡的 600ms 内移到别的行直接出 */
const HOVER_OPEN_MS = 400
const HOVER_WARM_MS = 600
let hoverWarmUntil = 0

/**
 * P11-SIDE-08/09/10：30px 行、左 padding 34，状态点居中在文件夹图标列、标题与工作区名同一条线；
 * 悬停 / 键盘聚焦时行尾时间换成 图钉 · 归档 · …（会话菜单），右键整行 = 同一份会话菜单；悬停卡延时出现。
 */
export function SidebarSessionRow({
  session,
  style,
  theme,
  selected,
  archiveView = false,
  menu,
  menuTarget = false,
  onOpen,
  onPin,
  onArchive,
  onHover,
}: {
  session: PiSidebarSession
  style: PiSidebarStyle
  theme?: PiSidebarTheme
  selected?: string
  /** 归档视图：行尾只剩「取消归档」 */
  archiveView?: boolean
  /** 会话菜单内容（只在菜单打开时调用）；不给 = 没有右键菜单和 … */
  menu?: () => ReactNode
  /** 静态态：这一行是会话菜单的作用对象（画廊对图时菜单锚在它旁边） */
  menuTarget?: boolean
  onOpen: () => void
  onPin: () => void
  onArchive: () => void
  onHover?: (sessionKey: string | null) => void
}) {
  const [hover, setHover] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  // 菜单内容第一次打开时才挂（每行都挂会让每次名册更新都重算一遍菜单数据），挂上后保留，关闭动画才放得完
  const [menuMounted, setMenuMounted] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const shown = useRef(false)
  const [anchor, setAnchor] = useState<SidebarHoverAnchor | null>(null)
  const isSelected = session.selected || selected === session.key
  const menuOpen = contextOpen || dropdownOpen
  const clearTimers = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }
  const show = () => {
    clearTimers()
    const row = wrapRef.current?.getBoundingClientRect()
    const sidebar = wrapRef.current?.closest("[data-pi-sidebar]")?.getBoundingClientRect()
    if (row && sidebar) setAnchor({ rowTop: row.top, rowBottom: row.bottom, sidebarRight: sidebar.right })
    shown.current = true
    setHover(true)
  }
  const scheduleOpen = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
    if (shown.current || openTimer.current) return
    if (Date.now() < hoverWarmUntil) show()
    else openTimer.current = window.setTimeout(show, HOVER_OPEN_MS)
  }
  const hide = () => {
    clearTimers()
    if (shown.current) hoverWarmUntil = Date.now() + HOVER_WARM_MS
    shown.current = false
    setHover(false)
  }
  const scheduleClose = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current)
    openTimer.current = null
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(hide, 120)
  }
  useEffect(() => {
    if (!hover) return
    const close = () => {
      hide()
      setAnchor(null)
    }
    window.addEventListener("scroll", close, true)
    window.addEventListener("resize", close)
    return () => {
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("resize", close)
    }
  }, [hover])
  useEffect(() => () => {
    if (openTimer.current) window.clearTimeout(openTimer.current)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
  }, [])
  // 键盘聚焦才出卡；鼠标点行时按钮也会拿到焦点，那时不出
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLElement && event.target.matches(":focus-visible")) show()
  }
  // Phase 4 T-1: the badge names the plaintext reason when the relay derived
  // one; null keeps the row badge-free (relay never stated the enc state).
  const encBadge = encBadgeLabelOf(session.enc, session.encReason)
  const pinLabel = session.pinned ? "取消置顶" : "置顶"
  const archiveLabel = archiveView ? "取消归档" : "归档"
  const row = (
    <div
      className="sb-row"
      data-row=""
      data-pi-row={session.id}
      data-context-target={menuTarget ? "" : undefined}
      data-menu-open={menuOpen ? "" : undefined}
      data-style={style}
      data-active={isSelected ? "" : undefined}
      data-tone={session.status.tone}
      data-p11-surface="P11-SIDE-08"
    >
      <button
        type="button"
        className="sb-row-main"
        data-pi-row-key={session.id}
        aria-current={isSelected ? "page" : undefined}
        onClick={onOpen}
        aria-label={session.dateTimeLabel ? `${session.title} · ${session.dateTimeLabel}` : session.title}
        aria-description={session.status.tone === "idle" ? undefined : session.status.label}
      >
        <span className="sb-marker" aria-hidden data-tone={session.status.tone} />
        <span className="sb-row-title">{session.title}</span>
        {encBadge ? <span className="sb-row-enc">{encBadge}</span> : null}
      </button>
      <span className="sb-row-right">
        <span className="sb-row-actions" data-p11-surface="P11-SIDE-09">
          {archiveView ? null : (
            <button type="button" className="sb-row-action" aria-label={pinLabel} title={pinLabel} onClick={onPin}>
              <PinIcon size={15} />
            </button>
          )}
          <button type="button" className="sb-row-action" data-action="archive" aria-label={archiveLabel} title={archiveLabel} onClick={onArchive}>
            {archiveView ? <UnarchiveIcon size={15} /> : <ArchiveIcon size={15} />}
          </button>
          {menu ? (
            <PiMenu
              kind="dropdown"
              side="bottom"
              align="end"
              open={dropdownOpen}
              onOpenChange={(next) => {
                setDropdownOpen(next)
                if (next) {
                  setMenuMounted(true)
                  hide()
                }
              }}
              trigger={
                <button type="button" className="sb-row-action" data-action="more" aria-label="更多操作" title="更多操作">
                  <MoreIcon size={15} />
                </button>
              }
            >
              {menuMounted ? menu() : null}
            </PiMenu>
          ) : null}
        </span>
        {session.timeLabel ? <span className="sb-row-time" title={session.dateTimeLabel}>{session.timeLabel}</span> : null}
      </span>
    </div>
  )
  return (
    <div
      ref={wrapRef}
      className="sb-rowwrap"
      onMouseEnter={() => {
        scheduleOpen()
        onHover?.(session.key)
      }}
      onMouseLeave={() => {
        scheduleClose()
        onHover?.(null)
      }}
      onMouseDown={hide}
      onFocus={onFocus}
      onBlur={scheduleClose}
    >
      {menu ? (
        <PiMenu
          kind="context"
          onOpenChange={(next) => {
            setContextOpen(next)
            if (next) {
              setMenuMounted(true)
              hide()
            }
          }}
          trigger={row}
        >
          {menuMounted ? menu() : null}
        </PiMenu>
      ) : (
        row
      )}
      {hover && anchor && !menuOpen ? (
        <SidebarHoverCard session={session} style={style} theme={theme} anchor={anchor} onMouseEnter={scheduleOpen} onMouseLeave={scheduleClose} />
      ) : null}
    </div>
  )
}
