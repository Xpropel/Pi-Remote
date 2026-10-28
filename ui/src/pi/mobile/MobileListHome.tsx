import { useMemo, useState } from "react"
import type { PiSidebarGroup, PiSidebarSession } from "../sidebar/types.ts"
import { IconChevronDown, IconFolder, IconMonitor, IconSend } from "./icons"
import { LongPressCard } from "./LongPressCard"
import { MobileTopBar } from "./MobileTopBar"
import { SwipeRow } from "./SwipeRow"
import type { PiMobileNavProps } from "./types.ts"

/**
 * P11-MOB-04/05/06/07 列表式首页（默认）：54 顶栏 + 设备切换条 48 + 新会话 46 + 分组/会话行 60 两行
 * + 左滑 148 + 长按卡 + 底部安全段 30。数据/动作全部来自 arch PiSidebarData/Actions。
 */
export function MobileListHome({ mode, data, actions, onOpenSession }: PiMobileNavProps) {
  const [deviceMenu, setDeviceMenu] = useState(false)
  const [preview, setPreview] = useState<PiSidebarSession | null>(null)
  const activeDevice = data.devices.find((device) => device.id === data.selectedDeviceId) ?? data.devices.find((device) => device.current) ?? data.devices[0]
  const groups = useMemo(() => data.groups.filter((group) => group.kind !== "archive"), [data.groups])
  const visibleCount = useMemo(() => groups.reduce((count, group) => count + group.count, 0), [groups])
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
          {!data.groups.length ? <p className="pm-home-note">{visibleCount === 0 ? "还没有会话" : "正在载入会话…"}</p> : null}
          {groups.map((group) => (
            <ListGroup key={group.id} group={group} actions={actions} onOpen={onOpenSession} onLongPress={setPreview} />
          ))}
        </div>
        <div className="pm-safe-bottom" aria-hidden />
      </div>
      {preview ? <LongPressCard session={preview} onPin={actions.togglePin} onArchive={actions.toggleArchive} onClose={() => setPreview(null)} /> : null}
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
  const collapsed = group.collapsed
  return (
    <section className="pm-group" data-pi-mobile-surface="P11-MOB-07">
      <button type="button" className="pm-group-head pm-group-toggle" aria-expanded={!collapsed} onClick={() => actions.toggleGroup(group.id)}>
        <IconFolder size={16} open={!collapsed} />
        <span className="pm-group-name">{group.label}</span>
      </button>
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
    </section>
  )
}

/** spec 7.1 建议名别名 */
export const ListHome = MobileListHome
