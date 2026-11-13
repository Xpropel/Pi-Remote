import { useEffect, useRef, useState, type ReactNode } from "react"
import "./tokens.css"
import "./sidebar.css"
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, type PiSidebarProps, type PiSidebarSession } from "./types"
import { SidebarToolRow } from "./components/SidebarToolRow"
import { SidebarDeviceMenu } from "./components/SidebarDeviceMenu"
import { NewSessionPill } from "./components/NewSessionPill"
import { SidebarSections } from "./components/SidebarSections"
import { SidebarIdentity } from "./components/SidebarIdentity"
import { SidebarSearchOverlay } from "./components/SidebarSearchOverlay"
import { InboxIcon, SendIcon } from "./components/icons"

const clampWidth = (width: number) => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))

/** 宿主可选的视图状态（不进 PiSidebarData：只有桌面 Cursor 宿主用） */
export interface UnifiedSidebarView {
  /** 归档视图开着（宿主本地状态；朴素行「归档」再点一次回到工作区） */
  archiveView?: boolean
  /** 主区正在显示待答页 */
  inboxActive?: boolean
  /** 会话行的会话菜单内容（右键整行 / 行尾 …）；不给就没有会话菜单 */
  rowMenu?: (session: PiSidebarSession) => ReactNode
  /** 静态态（画廊对图）会话菜单作用的那一行 id：保证它可见并作为菜单锚点 */
  menuTargetId?: string
  /** 快捷键显示串（只进提示与行尾 kbd） */
  shortcuts?: { newSession?: string; toggleSidebar?: string; settings?: string }
  /** 身份行「显示选项」菜单内容（设备筛选 / 分组 / 主题）；不给就不出这颗钮 */
  displayOptions?: ReactNode
  /** 静态对图：显示选项菜单开着（钮呈按下态） */
  displayOptionsOpen?: boolean
}

/**
 * P11 统一桌面左侧边栏（三套宿主共享，只换 `data.style × theme` 六套 token）：
 * 工具行 → 设备选择器(+菜单) → 新会话 → 导航行/分区标题/工作区组/会话行（悬停图钉归档…+悬停卡）
 * → 身份行；拖宽 220–360（双击复位）/ 折叠 56（窄栏只留图标）由宿主 actions 持久化。颜色只消费 `--sb-*`。
 */
export function UnifiedSidebar({ data, actions, slots, className, onHoverSession, view }: PiSidebarProps & { view?: UnifiedSidebarView }) {
  const widthRef = useRef(data.width)
  const wasSearchOpen = useRef(data.search.open)
  const [dragging, setDragging] = useState(false)
  widthRef.current = data.width
  const collapsed = data.collapsed
  const newLabel = data.newSessionLabel ?? "新会话"
  const shortcuts = view?.shortcuts
  // a11y：搜索关闭后把焦点还给工具行搜索按钮（portal/浮层关闭不丢焦点）
  useEffect(() => {
    if (wasSearchOpen.current && !data.search.open) {
      const button = document.querySelector<HTMLButtonElement>('[data-pi-sidebar] [aria-label="搜索会话"]')
      button?.focus()
    }
    wasSearchOpen.current = data.search.open
  }, [data.search.open])
  const style = { "--sb-width": `${collapsed ? 56 : data.width}px` } as React.CSSProperties
  const onResizeStart = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    setDragging(true)
    const body = document.body.style
    const restore = { cursor: body.cursor, userSelect: body.userSelect }
    body.cursor = "col-resize"
    body.userSelect = "none"
    const move = (moveEvent: PointerEvent) => {
      widthRef.current = clampWidth(startWidth + (moveEvent.clientX - startX))
      actions.resize(widthRef.current)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      body.cursor = restore.cursor
      body.userSelect = restore.userSelect
      setDragging(false)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }
  const showInbox = typeof data.inboxCount === "number" && !!actions.openInbox
  const inboxCount = data.inboxCount ?? 0
  return (
    <aside
      className={className ? `sb-root ${className}` : "sb-root"}
      data-pi-sidebar=""
      data-pi-sidebar-style={data.style}
      data-pi-theme={data.theme}
      data-sb-collapsed={collapsed ? "" : undefined}
      style={style}
      aria-label="会话与工作区导航"
    >
      <SidebarToolRow
        collapsed={collapsed}
        collapseShortcut={shortcuts?.toggleSidebar}
        onCollapse={actions.toggleCollapse}
        onSearch={actions.openSearch}
        onBack={actions.back}
        onForward={actions.forward}
        endSlot={slots?.toolbarEnd}
      />
      {collapsed ? (
        <nav className="sb-rail" aria-label="快捷入口">
          <button
            type="button"
            className="sb-iconbtn"
            aria-label={newLabel}
            title={shortcuts?.newSession ? `${newLabel}（${shortcuts.newSession}）` : newLabel}
            onClick={actions.newSession}
          >
            <SendIcon size={16} />
          </button>
          {showInbox ? (
            <button
              type="button"
              className="sb-iconbtn sb-rail-inbox"
              data-active={view?.inboxActive ? "" : undefined}
              aria-current={view?.inboxActive ? "page" : undefined}
              aria-label={inboxCount > 0 ? `待答，${inboxCount} 项待处理` : "待答"}
              title="待答"
              onClick={() => actions.openInbox?.()}
            >
              <InboxIcon size={16} />
              {inboxCount > 0 ? <span className="sb-rail-badge" aria-hidden>{inboxCount > 9 ? "9+" : inboxCount}</span> : null}
            </button>
          ) : null}
        </nav>
      ) : (
        <div className="sb-body">
          {slots?.beforePlainRows}
          <SidebarDeviceMenu data={data} actions={actions} />
          <NewSessionPill label={newLabel} shortcut={shortcuts?.newSession} onClick={actions.newSession} />
          <div className="sb-scroll">
            <SidebarSections
              data={data}
              actions={actions}
              onHover={onHoverSession}
              archiveView={view?.archiveView}
              inboxActive={view?.inboxActive}
              rowMenu={view?.rowMenu}
              menuTargetId={view?.menuTargetId}
            />
            {slots?.beforeGroups}
            {slots?.afterGroups}
          </div>
        </div>
      )}
      <SidebarIdentity
        serverName={data.serverName}
        serverUrl={data.serverUrl}
        online={data.online}
        settingsShortcut={shortcuts?.settings}
        onSettings={actions.openSettings}
        optionsMenu={view?.displayOptions}
        optionsPressed={view?.displayOptionsOpen}
      />
      <SidebarSearchOverlay data={data} actions={actions} />
      {collapsed ? null : (
        <span
          className="sb-resize"
          role="separator"
          tabIndex={0}
          aria-label="调整侧栏宽度（方向键，双击复位）"
          aria-orientation="vertical"
          aria-valuemin={SIDEBAR_WIDTH_MIN}
          aria-valuemax={SIDEBAR_WIDTH_MAX}
          aria-valuenow={Math.round(data.width)}
          data-dragging={dragging ? "" : undefined}
          data-p11-surface="P11-SIDE-12"
          onPointerDown={onResizeStart}
          onDoubleClick={() => actions.resize(SIDEBAR_WIDTH_DEFAULT)}
          onKeyDown={(event) => {
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault()
              actions.resize(event.key === "Home" ? SIDEBAR_WIDTH_MIN : SIDEBAR_WIDTH_MAX)
              return
            }
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
            event.preventDefault()
            const step = event.shiftKey ? 32 : 8
            actions.resize(clampWidth(data.width + (event.key === "ArrowRight" ? step : -step)))
          }}
        />
      )}
    </aside>
  )
}
