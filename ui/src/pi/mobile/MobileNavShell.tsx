import { useRef, useState, type ReactNode } from "react"
import { IconMore } from "./icons"
import { MobileDrawerNav } from "./MobileDrawerNav"
import { MobileListHome } from "./MobileListHome"
import { MobileSearchPage } from "./MobileSearchPage"
import { MobileTopBar } from "./MobileTopBar"
import type { PiMobileNavProps } from "./types.ts"

/**
 * P11 共享移动壳装配（宿主接入点，MobileNavShell）：
 * - 根元素同时挂 data-pi-sidebar / data-pi-mobile / data-pi-sidebar-style / data-pi-theme，--sb-* token 命中；
 * - list 模式：page=list → 列表式首页；page=session → 顶栏（返回列表）+ children 会话页；
 * - drawer 模式：page=session → 顶栏（侧栏钮）+ children 会话页 + 抽屉；左缘右滑唤出、选中自动关；
 * - 会话页顶栏的标题 / 设备 / 待处理计数 / 会话信息 / 会话菜单由宿主映射当前会话后传入；
 * - 搜索由 shell 托管（data.search.open，两种模式都换成全屏搜索页；入口：列表首页顶栏、抽屉头）；不直接碰 relay。
 */
export function MobileNavShell({
  mode,
  data,
  actions,
  page,
  onOpenSession,
  onBackToList,
  drawerOpen,
  onDrawerOpenChange,
  sessionTitle,
  sessionSubtitle,
  sessionAttentionCount,
  onSessionInfo,
  onSessionMenu,
  onRowMenu,
  archiveView,
  archivedCount,
  children,
}: PiMobileNavProps & { children?: ReactNode }) {
  const [innerDrawer, setInnerDrawer] = useState(false)
  const open = drawerOpen ?? innerDrawer
  const setOpen = (next: boolean) => {
    if (drawerOpen === undefined) setInnerDrawer(next)
    onDrawerOpenChange?.(next)
  }
  const edge = useRef<{ x: number; y: number } | null>(null)
  const rootProps = {
    className: "pi-mobile pm-mobile-shell",
    "data-pi-sidebar": "",
    "data-pi-mobile": "",
    "data-pi-sidebar-style": data.style,
    "data-pi-theme": data.theme,
    "data-pi-mobile-mode": mode,
    "data-pi-mobile-surface": "P11-MOB-12",
  } as const
  if (data.search.open) {
    return (
      <div {...rootProps}>
        <MobileSearchPage mode={mode} data={data} actions={actions} page={page} onOpenSession={onOpenSession} onBackToList={onBackToList} />
      </div>
    )
  }
  if (page === "list") {
    return (
      <div {...rootProps}>
        <MobileListHome
          mode={mode}
          data={data}
          actions={actions}
          page={page}
          onOpenSession={onOpenSession}
          onBackToList={onBackToList}
          onRowMenu={onRowMenu}
          archiveView={archiveView}
          archivedCount={archivedCount}
        />
      </div>
    )
  }
  return (
    <div
      {...rootProps}
      onPointerDown={(event) => {
        if (mode !== "drawer" || open || event.clientX > 24) return
        edge.current = { x: event.clientX, y: event.clientY }
      }}
      onPointerUp={(event) => {
        const start = edge.current
        edge.current = null
        if (!start || open || mode !== "drawer") return
        if (event.clientX - start.x > 44 && Math.abs(event.clientY - start.y) < 40) setOpen(true)
      }}
    >
      <MobileTopBar
        variant="chat"
        title={sessionTitle || data.serverName}
        subtitle={sessionTitle ? sessionSubtitle : undefined}
        attentionCount={sessionAttentionCount}
        onTitleClick={onSessionInfo}
        onOpenDrawer={mode === "drawer" ? () => setOpen(true) : undefined}
        onBack={mode === "list" ? onBackToList : undefined}
        actions={
          onSessionMenu ? (
            <button type="button" className="pm-icon-btn" aria-label="会话菜单" aria-haspopup="dialog" data-pi-session-more="" onClick={onSessionMenu}>
              <IconMore size={20} />
            </button>
          ) : null
        }
      />
      <div className="pm-session-host">{children ?? null}</div>
      {mode === "drawer" ? (
        <MobileDrawerNav
          mode={mode}
          data={data}
          actions={actions}
          page={page}
          open={open}
          onClose={() => setOpen(false)}
          onSearch={() => {
            setOpen(false)
            actions.openSearch()
          }}
          onOpenSession={onOpenSession}
          onBackToList={onBackToList}
          onRowMenu={onRowMenu}
          archiveView={archiveView}
        />
      ) : null}
    </div>
  )
}

/** spec 7.1 建议名别名（会话页顶栏 + 现有会话页由宿主组合） */
export const MobileSessionPage = MobileTopBar
