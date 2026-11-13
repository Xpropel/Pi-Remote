import { useMemo, useState } from "react"
import { PI_SIDEBAR_COPY, type PiSidebarGroup, type PiSidebarSession } from "../sidebar/types.ts"
import { MOBILE_GROUP_TONE_LABEL, mobileGroupToneOf } from "./groupTone.ts"
import { IconArchive, IconChevronDown, IconChevronRight, IconFolder, IconInbox, IconMonitor, IconPin, IconSend } from "./icons"
import { LongPressCard } from "./LongPressCard"
import { MobileTopBar } from "./MobileTopBar"
import { SwipeRow } from "./SwipeRow"
import type { PiMobileNavProps } from "./types.ts"

/**
 * P11-MOB-04/05/06/07 列表式首页（默认）：54 顶栏 + 设备切换条 48 + 新会话 46 + 分组/会话行 60 两行
 * + 左滑 148 + 长按卡 + 底部安全段 30。数据/动作全部来自 arch PiSidebarData/Actions。
 * 待答行（有待处理时）在分组上方；归档入口（本机有归档时）在分组下方，点开就地换成归档视图。
 */
export function MobileListHome({ mode, data, actions, onOpenSession, onRowMenu, archiveView = false, archivedCount = 0 }: PiMobileNavProps) {
  const [deviceMenu, setDeviceMenu] = useState(false)
  const [preview, setPreview] = useState<PiSidebarSession | null>(null)
  const activeDevice = data.devices.find((device) => device.id === data.selectedDeviceId) ?? data.devices.find((device) => device.current) ?? data.devices[0]
  const groups = useMemo(() => data.groups.filter((group) => group.kind !== "archive"), [data.groups])
  const visibleCount = useMemo(() => groups.reduce((count, group) => count + group.count, 0), [groups])
  const inboxCount = data.inboxCount ?? 0
  const toggleDeviceMenu = (open: boolean) => {
    setDeviceMenu(open)
    actions.toggleDeviceMenu?.(open)
  }
  return (
    <div className="pm-list-page" data-pi-mobile-mode={mode} data-pi-mobile-surface="P11-MOB-04">
      <MobileTopBar variant="home" onSearch={actions.openSearch} onOpenSettings={actions.openSettings} />
      <div className="pm-list-body">
        <div className="pm-device-strip-wrap" data-pi-mobile-surface="P11-MOB-05">
          <button
            type="button"
            className="pm-device-strip"
            aria-expanded={deviceMenu || !!data.deviceMenuOpen}
            aria-haspopup="menu"
            aria-label={`切换设备：当前 ${activeDevice?.name ?? "本机"}`}
            onClick={() => toggleDeviceMenu(!(deviceMenu || !!data.deviceMenuOpen))}
          >
            <IconMonitor size={19} />
            <span className="pm-device-name">{activeDevice?.name ?? "本机"}</span>
            <span className="pm-online-dot" data-online={activeDevice?.online ? "" : undefined} aria-label={activeDevice?.online ? "在线" : "离线"} />
            <IconChevronDown size={15} className="pm-device-chevron" />
          </button>
          {deviceMenu || data.deviceMenuOpen ? (
            <div className="pm-device-menu" role="menu" aria-label="选择设备">
              {data.devices.map((device) => (
                <button
                  key={device.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={device.id === activeDevice?.id}
                  className="pm-device-menu-row"
                  data-active={device.id === activeDevice?.id ? "" : undefined}
                  onClick={() => {
                    actions.selectDevice(device.id)
                    toggleDeviceMenu(false)
                  }}
                >
                  <IconMonitor size={17} />
                  <span className="pm-device-name">{device.name}</span>
                  <span className="pm-device-state">{device.statusLabel ?? (device.online ? "在线" : "离线")}</span>
                </button>
              ))}
              {actions.addDevice ? (
                <button type="button" className="pm-device-menu-row" onClick={() => { actions.addDevice?.(); toggleDeviceMenu(false) }}>
                  <span className="pm-device-state">添加设备…</span>
                </button>
              ) : null}
            </div>
          ) : null}
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
