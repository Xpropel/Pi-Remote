import { useEffect, useRef, useState } from "react"
import type { PiSidebarSession } from "../sidebar/types.ts"
import { IconChevronDown, IconFolder, IconMonitor, IconSearch, IconSend, IconSettings } from "./icons"
import { LongPressCard } from "./LongPressCard"
import type { PiMobileNavProps } from "./types.ts"

/**
 * P11-MOB-02/03 抽屉式侧栏：宽 clamp(屏宽−68, 288, 340)、全高贴左、遮罩 z20<抽屉 z30。
 * 内部：设备行 48 / 新会话 48（左对齐）/ 朴素行 44 / 分区 26 / 工作区 40 / 会话 48 / 身份行 48+安全段 30。
 */
export function MobileDrawerNav({
  mode,
  data,
  actions,
  open,
  onClose,
  onOpenSession,
}: PiMobileNavProps & { open: boolean; onClose: () => void }) {
  const [deviceMenu, setDeviceMenu] = useState(false)
  const [preview, setPreview] = useState<PiSidebarSession | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  // a11y：打开时焦点入内 + Tab 循环 + Esc 关闭并恢复聚焦；遮罩点击关闭由按钮承担
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = asideRef.current
    const focusables = () => [...(root?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
    focusables()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== "Tab") return
      const items = focusables()
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      previous?.focus?.()
    }
  }, [open, onClose])
  const activeDevice = data.devices.find((device) => device.id === data.selectedDeviceId) ?? data.devices.find((device) => device.current) ?? data.devices[0]
  const pinnedGroup = data.groups.find((group) => group.kind === "pinned")
  const workspaceGroups = data.groups.filter((group) => group.kind !== "pinned" && group.kind !== "archive")
  const pick = (sessionKey: string) => {
    onOpenSession(sessionKey)
    onClose()
  }
  if (!open) return null
  return (
    <div className="pm-drawer-layer" data-pi-mobile-mode={mode} data-pi-mobile-surface="P11-MOB-02">
      <button type="button" className="pm-drawer-mask" aria-label="关闭侧栏" onClick={onClose} />
      <aside ref={asideRef} className="pm-drawer" role="dialog" aria-modal="true" aria-label="侧栏" data-pi-mobile-surface="P11-MOB-03">
        <div className="pm-drawer-scroll">
          <div className="pm-drawer-device-wrap">
            <button
              type="button"
              className="pm-drawer-device"
              aria-expanded={deviceMenu}
              aria-haspopup="menu"
              aria-label={`切换设备：当前 ${activeDevice?.name ?? "本机"}`}
              onClick={() => setDeviceMenu((value) => !value)}
            >
              <IconMonitor size={19} />
              <span className="pm-device-name">{activeDevice?.name ?? "本机"}</span>
              <span className="pm-online-dot" data-online={activeDevice?.online ? "" : undefined} aria-label={activeDevice?.online ? "在线" : "离线"} />
              <IconChevronDown size={15} className="pm-device-chevron" />
            </button>
            {deviceMenu ? (
              <div className="pm-device-menu pm-drawer-device-menu" role="menu" aria-label="选择设备">
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
                      setDeviceMenu(false)
                    }}
                  >
                    <IconMonitor size={17} />
                    <span className="pm-device-name">{device.name}</span>
                    <span className="pm-device-state">{device.statusLabel ?? (device.online ? "在线" : "离线")}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className="pm-drawer-new" onClick={() => { actions.newSession(); onClose() }}>
            <IconSend size={17} />
            {data.newSessionLabel ?? "新会话"}
          </button>
          <nav className="pm-drawer-naive" aria-label="侧栏导航">
            <button type="button" className="pm-drawer-naive-row" onClick={() => actions.togglePlainRow?.("workspace")}>
              <IconFolder size={17} open />
              工作区
            </button>
            <button type="button" className="pm-drawer-naive-row" onClick={() => actions.togglePlainRow?.("archive")}>
              <IconFolder size={17} />
              归档
            </button>
            {(data.localPages ?? []).map((page) => (
              <button
                key={page.id}
                type="button"
                className="pm-drawer-naive-row"
                data-active={page.active ? "" : undefined}
                onClick={() => {
                  actions.selectLocalPage?.(page.id)
                  onClose()
                }}
              >
                {page.icon ?? <IconFolder size={17} />}
                {page.label}
              </button>
            ))}
          </nav>
          {pinnedGroup && pinnedGroup.sessions.length > 0 ? (
            <section className="pm-drawer-section" aria-label={pinnedGroup.label}>
              <div className="pm-drawer-section-head">
                <span>{pinnedGroup.label}</span>
              </div>
              {pinnedGroup.sessions.map((session) => (
                <DrawerSessionRow key={session.key} session={session} selected={session.selected} onOpen={pick} onLongPress={setPreview} />
              ))}
            </section>
          ) : null}
          <section className="pm-drawer-section" aria-label="工作区">
            <div className="pm-drawer-section-head">
              <span>工作区</span>
              <span className="pm-drawer-section-tools" aria-hidden>
                <IconSearch size={16} />
                <IconFolder size={16} open />
              </span>
            </div>
            {workspaceGroups.map((group) => (
              <div className="pm-drawer-group" key={group.id}>
                <button type="button" className="pm-drawer-workspace" aria-expanded={!group.collapsed} onClick={() => actions.toggleGroup(group.id)}>
                  <span className="pm-workspace-icon">
                    <IconFolder size={17} open={!group.collapsed} />
                  </span>
                  <span className="pm-workspace-name">{group.label}</span>
                </button>
                {!group.collapsed
                  ? group.sessions.map((session) => (
                      <DrawerSessionRow key={session.key} session={session} selected={session.selected} onOpen={pick} onLongPress={setPreview} />
                    ))
                  : null}
              </div>
            ))}
          </section>
          <div className="pm-drawer-gap" aria-hidden />
        </div>
        <div className="pm-drawer-identity">
          <span className="pm-identity-tile" aria-hidden>
            <IconMonitor size={14} />
          </span>
          <span className="pm-identity-text" title={data.serverUrl ?? data.serverName}>
            <span className="pm-identity-name">{data.serverName || "Pi-Remote"}</span>
          </span>
          <button type="button" className="pm-icon-btn" aria-label="设置" onClick={() => { actions.openSettings(); onClose() }}>
            <IconSettings size={20} />
          </button>
        </div>
        <div className="pm-safe-bottom" aria-hidden />
      </aside>
      {preview ? <LongPressCard session={preview} onPin={actions.togglePin} onArchive={actions.toggleArchive} onClose={() => setPreview(null)} /> : null}
    </div>
  )
}

function DrawerSessionRow({
  session,
  selected,
  onOpen,
  onLongPress,
}: {
  session: PiSidebarSession
  selected: boolean
  onOpen: (sessionKey: string) => void
  onLongPress: (session: PiSidebarSession) => void
}) {
  return (
    <div className="pm-drawer-session">
      <button
        type="button"
        className="pm-drawer-session-btn"
        data-selected={selected ? "" : undefined}
        aria-haspopup="dialog"
        aria-label={`${session.title}（Shift+F10 打开操作卡）`}
        onClick={() => onOpen(session.key)}
        onContextMenu={(event) => {
          event.preventDefault()
          onLongPress(session)
        }}
        onKeyDown={(event) => {
          if (event.key === "F10" && event.shiftKey) {
            event.preventDefault()
            onLongPress(session)
          }
        }}
      >
        <span className="pm-drawer-slot" aria-hidden>
          <span className="pm-row-dot" data-marker={session.status.tone}>
            <span className="pm-dot-core" />
          </span>
        </span>
        <span className="pm-drawer-session-title">{session.title}</span>
        {session.timeLabel ? <span className="pm-drawer-session-time">{session.timeLabel}</span> : null}
      </button>
    </div>
  )
}

/** spec 7.1 建议名别名 */
export const DrawerNav = MobileDrawerNav
