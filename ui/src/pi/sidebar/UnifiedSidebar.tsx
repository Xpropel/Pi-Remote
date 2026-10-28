import { useEffect, useRef } from "react"
import "./tokens.css"
import "./sidebar.css"
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, type PiSidebarProps } from "./types"
import { SidebarToolRow } from "./components/SidebarToolRow"
import { SidebarDeviceMenu } from "./components/SidebarDeviceMenu"
import { NewSessionPill } from "./components/NewSessionPill"
import { SidebarSections } from "./components/SidebarSections"
import { SidebarIdentity } from "./components/SidebarIdentity"
import { SidebarSearchOverlay } from "./components/SidebarSearchOverlay"

const clampWidth = (width: number) => Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(width)))

/**
 * P11 统一桌面左侧边栏（三套宿主共享，只换 `data.style × theme` 六套 token）：
 * 工具行 → 设备选择器(+菜单) → 新会话 → 朴素行/分区标题/工作区组/会话行（悬停图钉归档+气泡）
 * → 身份行；拖宽 220–360 / 折叠 56 由宿主 actions 持久化。颜色只消费 `--sb-*`。
 */
export function UnifiedSidebar({ data, actions, slots, className, onHoverSession }: PiSidebarProps) {
  const widthRef = useRef(data.width)
  const wasSearchOpen = useRef(data.search.open)
  widthRef.current = data.width
  const collapsed = data.collapsed
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
    event.preventDefault()
    const startX = event.clientX
    const startWidth = widthRef.current
    const target = event.currentTarget
    target.setPointerCapture?.(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      widthRef.current = clampWidth(startWidth + (moveEvent.clientX - startX))
      actions.resize(widthRef.current)
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
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
        onCollapse={actions.toggleCollapse}
        onSearch={actions.openSearch}
        onBack={actions.back}
        onForward={actions.forward}
        endSlot={slots?.toolbarEnd}
      />
      {collapsed ? null : (
        <>
          <div className="sb-body">
            {slots?.beforePlainRows}
            <SidebarDeviceMenu data={data} actions={actions} />
            <NewSessionPill label={data.newSessionLabel ?? "新会话"} onClick={actions.newSession} />
            <div className="sb-scroll">
              <SidebarSections data={data} actions={actions} onHover={onHoverSession} />
              {slots?.beforeGroups}
              {slots?.afterGroups}
            </div>
          </div>
        </>
      )}
      <SidebarIdentity serverName={data.serverName} online={data.online} onSettings={actions.openSettings} />
      <SidebarSearchOverlay data={data} actions={actions} />
      <span
        className="sb-resize"
        role="separator"
        tabIndex={0}
        aria-label="调整侧栏宽度（方向键）"
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_WIDTH_MIN}
        aria-valuemax={SIDEBAR_WIDTH_MAX}
        aria-valuenow={Math.round(data.width)}
        data-p11-surface="P11-SIDE-12"
        onPointerDown={onResizeStart}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          const step = event.shiftKey ? 32 : 8
          actions.resize(clampWidth(data.width + (event.key === "ArrowRight" ? step : -step)))
        }}
      />
    </aside>
  )
}
