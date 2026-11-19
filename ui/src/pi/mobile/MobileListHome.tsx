import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { PI_SIDEBAR_COPY, type PiSidebarActions, type PiSidebarData, type PiSidebarGroup, type PiSidebarSession } from "../sidebar/types.ts"
import { MOBILE_GROUP_TONE_LABEL, mobileGroupToneOf } from "./groupTone.ts"
import { IconArchive, IconChevronDown, IconChevronRight, IconFolder, IconInbox, IconMonitor, IconPin, IconSend } from "./icons"
import { LongPressCard } from "./LongPressCard"
import { MobileTopBar } from "./MobileTopBar"
import { SwipeRow } from "./SwipeRow"
import type { PiMobileNavProps } from "./types.ts"

function IconPlus() {
  return (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** 移动端设备切换器状态与浮层关闭（点触发钮/菜单外或按 Escape 自动收起并归还焦点）。 */
export function useMobileDeviceMenu(
  data: Pick<PiSidebarData, "devices" | "selectedDeviceId" | "deviceMenuOpen" | "online">,
  actions: Pick<PiSidebarActions, "toggleDeviceMenu">,
  enabled = true,
) {
  const [internalOpen, setInternalOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const activeDevice = data.devices.find((device) => device.id === data.selectedDeviceId) ?? data.devices.find((device) => device.current) ?? data.devices[0]
  const online = Boolean(data.online) && Boolean(activeDevice?.online ?? true)
  const open = data.deviceMenuOpen ?? internalOpen
  const toggle = (next: boolean) => {
    if (data.deviceMenuOpen === undefined) setInternalOpen(next)
    actions.toggleDeviceMenu?.(next)
  }
  const toggleRef = useRef(toggle)
  const openRef = useRef(open)
  useLayoutEffect(() => {
    toggleRef.current = toggle
    openRef.current = open
  })
  const closeIfOpen = useCallback(() => {
    if (openRef.current) toggleRef.current(false)
  }, [])
  useEffect(() => {
    if (!enabled || !open) return
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return
      toggleRef.current(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      toggleRef.current(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    document.addEventListener("mousedown", onPointerDown, true)
    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true)
      document.removeEventListener("mousedown", onPointerDown, true)
      document.removeEventListener("keydown", onKeyDown, true)
    }
  }, [enabled, open])
  return { wrapRef, triggerRef, activeDevice, online, open, toggle, closeIfOpen }
}

/** 移动端设备下拉菜单（列表首页与抽屉共用）：设备单选列表 + 分隔线 + 「设备中心… / 添加设备…」主动作行。 */
export function MobileDeviceMenu({
  data,
  actions,
  activeDeviceId,
  menuClassName,
  onClose,
  onLeave,
}: {
  data: Pick<PiSidebarData, "devices" | "online">
  actions: Pick<PiSidebarActions, "selectDevice" | "openDeviceHub" | "addDevice">
  activeDeviceId: string | undefined
  menuClassName?: string
  onClose: () => void
  onLeave?: () => void
}) {
  return (
    <div className={menuClassName ? `pm-device-menu ${menuClassName}` : "pm-device-menu"} role="menu" aria-label="选择设备">
      {data.devices.map((device) => {
        const rowOnline = Boolean(data.online) && Boolean(device.online)
        return (
          <button
            key={device.id}
            type="button"
            role="menuitemradio"
            aria-checked={device.id === activeDeviceId}
            className="pm-device-menu-row"
            data-active={device.id === activeDeviceId ? "" : undefined}
            onClick={() => {
              actions.selectDevice(device.id)
              onClose()
            }}
          >
            <IconMonitor size={17} />
            <span className="pm-device-name">{device.name}</span>
            <span className="pm-device-state">{device.statusLabel ?? (rowOnline ? "在线" : "离线")}</span>
          </button>
        )
      })}
      {data.devices.length > 0 && (actions.openDeviceHub || actions.addDevice) ? <div className="pm-device-menu-sep" role="separator" /> : null}
      {actions.openDeviceHub ? (
        <button
          type="button"
          role="menuitem"
          className="pm-device-menu-row pm-device-menu-act"
          onClick={() => {
            actions.openDeviceHub?.()
            onClose()
            onLeave?.()
          }}
        >
          <IconMonitor size={17} />
          <span className="pm-device-name">设备中心…</span>
        </button>
      ) : null}
      {actions.addDevice ? (
        <button
          type="button"
          role="menuitem"
          className="pm-device-menu-row pm-device-menu-act"
          onClick={() => {
            actions.addDevice?.()
            onClose()
            onLeave?.()
          }}
        >
          <IconPlus />
          <span className="pm-device-name">添加设备…</span>
        </button>
      ) : null}
    </div>
  )
}

/**
 * P11-MOB-04/05/06/07 列表式首页（默认）：54 顶栏 + 设备切换条 48 + 新会话 46 + 分组/会话行 60 两行
 * + 左滑 148 + 长按卡 + 底部安全段 30。数据/动作全部来自 arch PiSidebarData/Actions。
 * 待答行（有待处理时）在分组上方；归档入口（本机有归档时）在分组下方，点开就地换成归档视图。
 */
export function MobileListHome({ mode, data, actions, onOpenSession, onRowMenu, archiveView = false, archivedCount = 0 }: PiMobileNavProps) {
  const [preview, setPreview] = useState<PiSidebarSession | null>(null)
  const dev = useMobileDeviceMenu(data, actions)
  const groups = useMemo(() => data.groups.filter((group) => group.kind !== "archive"), [data.groups])
  const visibleCount = useMemo(() => groups.reduce((count, group) => count + group.count, 0), [groups])
  const inboxCount = data.inboxCount ?? 0
  return (
    <div className="pm-list-page" data-pi-mobile-mode={mode} data-pi-mobile-surface="P11-MOB-04">
      <MobileTopBar variant="home" onSearch={actions.openSearch} onOpenSettings={actions.openSettings} />
      <div className="pm-list-body">
        <div ref={dev.wrapRef} className="pm-device-strip-wrap" data-pi-mobile-surface="P11-MOB-05">
          <button
            ref={dev.triggerRef}
            type="button"
            className="pm-device-strip"
            aria-expanded={dev.open}
            aria-haspopup="menu"
            aria-label={`切换设备：当前 ${dev.activeDevice?.name ?? "本机"}`}
            onClick={() => dev.toggle(!dev.open)}
          >
            <IconMonitor size={19} />
            <span className="pm-device-name">{dev.activeDevice?.name ?? "本机"}</span>
            <span className="pm-online-dot" data-online={dev.online ? "" : undefined} aria-label={dev.online ? "在线" : "离线"} />
            <IconChevronDown size={15} className="pm-device-chevron" />
          </button>
          {dev.open ? <MobileDeviceMenu data={data} actions={actions} activeDeviceId={dev.activeDevice?.id} onClose={() => dev.toggle(false)} /> : null}
        </div>
        <button type="button" className="pm-new-pill" data-pi-mobile-surface="P11-MOB-06" onClick={actions.newSession}>
          <IconSend size={17} />
          {data.newSessionLabel ?? "新会话"}
        </button>
        <div className="pm-home-scroll">
          {archiveView ? (
            <div className="pm-section-head">
              <span className="pm-section-title">已归档</span>
              <button type="button" className="pm-section-action" onClick={() => actions.openArchiveView?.()}>
                返回
              </button>
            </div>
          ) : inboxCount > 0 && actions.openInbox ? (
            <button type="button" className="pm-nav-row" aria-label={`待答，${inboxCount} 项待处理`} onClick={() => actions.openInbox?.()}>
              <IconInbox size={17} />
              <span className="pm-nav-row-label">待答</span>
              <span className="pm-nav-badge" aria-hidden>
                {inboxCount > 99 ? "99+" : inboxCount}
              </span>
              <IconChevronRight size={15} className="pm-nav-row-chevron" />
            </button>
          ) : null}
          {archiveView && groups.length === 0 ? (
            <div className="pm-empty">
              <p className="pm-empty-title">{PI_SIDEBAR_COPY.archiveEmpty}</p>
              <p className="pm-empty-hint">{PI_SIDEBAR_COPY.archiveHint}</p>
            </div>
          ) : null}
          {!archiveView && !data.groups.length ? <p className="pm-home-note">{visibleCount === 0 ? "还没有会话" : "正在载入会话…"}</p> : null}
          {groups.map((group) => (
            <ListGroup key={group.id} group={group} actions={actions} onOpen={onOpenSession} onLongPress={setPreview} />
          ))}
          {!archiveView && archivedCount > 0 && actions.openArchiveView ? (
            <button type="button" className="pm-nav-row pm-nav-row-quiet" title={PI_SIDEBAR_COPY.archiveTitle} onClick={() => actions.openArchiveView?.()}>
              <IconArchive size={17} />
              <span className="pm-nav-row-label">归档</span>
              <span className="pm-nav-row-meta">{archivedCount}</span>
              <IconChevronRight size={15} className="pm-nav-row-chevron" />
            </button>
          ) : null}
        </div>
      </div>
      {preview ? (
        <LongPressCard
          session={preview}
          onPin={actions.togglePin}
          onArchive={actions.toggleArchive}
          onMore={onRowMenu ? () => onRowMenu(preview) : undefined}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  )
}

function ListGroup({
  group,
  actions,
  onOpen,
  onLongPress,
}: {
  group: PiSidebarGroup
  actions: PiMobileNavProps["actions"]
  onOpen: (sessionKey: string) => void
  onLongPress: (session: PiSidebarSession) => void
}) {
  const pinned = group.kind === "pinned"
  const collapsed = !pinned && group.collapsed
  const tone = collapsed ? mobileGroupToneOf(group) : "idle"
  return (
    <section className="pm-group" data-pi-mobile-surface="P11-MOB-07" data-kind={group.kind}>
      {pinned ? (
        <div className="pm-group-head pm-group-static">
          <IconPin size={16} />
          <span className="pm-group-name">{group.label}</span>
        </div>
      ) : (
        <button type="button" className="pm-group-head pm-group-toggle" aria-expanded={!collapsed} title={group.cwd || undefined} onClick={() => actions.toggleGroup(group.id)}>
          <IconFolder size={16} open={!collapsed} />
          <span className="pm-group-name">{group.label}</span>
          {tone !== "idle" ? <span className="pm-group-tone" data-tone={tone} role="img" aria-label={MOBILE_GROUP_TONE_LABEL[tone]} /> : null}
        </button>
      )}
      {!collapsed
        ? group.sessions.map((session) => (
            <SwipeRow
              key={session.key}
              session={session}
              onOpen={onOpen}
              onPin={actions.togglePin}
              onArchive={actions.toggleArchive}
              onLongPress={onLongPress}
            />
          ))
        : null}
      {/* D-3: rows past the per-group cap need a visible way in on mobile too. */}
      {!collapsed && actions.toggleExpanded && group.more != null && group.more > 0 ? (
        <button type="button" className="pm-group-more" onClick={() => actions.toggleExpanded?.(group.id)}>
          更多 {group.more}
        </button>
      ) : null}
      {!collapsed && actions.toggleExpanded && group.expanded ? (
        <button type="button" className="pm-group-more" onClick={() => actions.toggleExpanded?.(group.id)}>
          收起
        </button>
      ) : null}
    </section>
  )
}

/** spec 7.1 建议名别名 */
export const ListHome = MobileListHome
