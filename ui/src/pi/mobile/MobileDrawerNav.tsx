import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { PI_SIDEBAR_COPY, type PiSidebarSession } from "../sidebar/types.ts"
import { usePiMotion } from "../hooks/useReducedMotion.ts"
import { MOBILE_GROUP_TONE_LABEL, mobileGroupToneOf } from "./groupTone.ts"
import { IconArchive, IconChevronDown, IconFolder, IconInbox, IconMonitor, IconPin, IconSearch, IconSend, IconSettings } from "./icons"
import { LongPressCard } from "./LongPressCard"
import type { PiMobileNavProps } from "./types.ts"

/** Exit duration of the drawer closing phase; the enter in mobile.css
 * (.pm-drawer / .pm-drawer-mask) runs the same 240ms on --pi-ease-sheet. */
const DRAWER_CLOSE_MS = 240

/**
 * P11-MOB-02/03 抽屉式侧栏：宽 clamp(屏宽−68, 288, 340)、全高贴左、遮罩 z20<抽屉 z30。
 * 内部：头 54（Pi-Remote + 搜索）/ 设备行 48 / 新会话 48（左对齐）/ 朴素行 44 / 分区 26 / 工作区 40 / 会话 48 / 身份行 48+安全段 30。
 * onSearch 由外壳给：它要先把抽屉直接关掉再开搜索页（搜索页替换整页，抽屉的关闭动画来不及回报）。
 */
export function MobileDrawerNav({
  mode,
  data,
  actions,
  open,
  onClose,
  onSearch,
  onOpenSession,
  onRowMenu,
  archiveView = false,
}: PiMobileNavProps & { open: boolean; onClose: () => void; onSearch?: () => void }) {
  const [deviceMenu, setDeviceMenu] = useState(false)
  const [preview, setPreview] = useState<PiSidebarSession | null>(null)
  const asideRef = useRef<HTMLElement>(null)
  const { sheetSlide } = usePiMotion()
  /*
   * Closing phase (anim audit B2b): a close request no longer unmounts the
   * drawer on the spot. The layer stays mounted while the phase is
   * "closing" (mobile.css plays the slide/fade out under [data-closing]),
   * and only when the phase ends is the parent's onClose reported and the
   * layer unmounted. It mirrors the PiSheet closing phase in PiOverlay.tsx,
   * including the reduced-motion gate: sheetSlide === false skips the phase
   * entirely, so closes are immediate in both directions.
   */
  const [phase, setPhase] = useState<"open" | "closing" | "closed">(open ? "open" : "closed")
  const phaseRef = useRef(phase)
  const onCloseRef = useRef(onClose)
  const slideRef = useRef(sheetSlide)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
    slideRef.current = sheetSlide
  })
  const closeTimerRef = useRef<number | null>(null)
  const finishClose = useCallback(() => {
    closeTimerRef.current = null
    phaseRef.current = "closed"
    setPhase("closed")
    onCloseRef.current?.()
  }, [])
  const beginClose = useCallback(() => {
    if (phaseRef.current !== "open") return
    if (!slideRef.current) {
      finishClose()
      return
    }
    phaseRef.current = "closing"
    setPhase("closing")
    closeTimerRef.current = window.setTimeout(finishClose, DRAWER_CLOSE_MS)
  }, [finishClose])
  const beginCloseRef = useRef(beginClose)
  useLayoutEffect(() => {
    beginCloseRef.current = beginClose
  })
  /*
   * Parent-driven changes ride the same phase machine: open=false is a
   * close request too (a no-op when the flip is the parent answering
   * finishClose, which already moved the phase past "open"), and open=true
   * (re)opens, cancelling a pending close.
   */
  useEffect(() => {
    if (open && phaseRef.current !== "open") {
      if (closeTimerRef.current != null) {
        clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
      phaseRef.current = "open"
      setPhase("open")
    } else if (!open && phaseRef.current === "open") {
      beginClose()
    }
  }, [open, beginClose])
  useEffect(
    () => () => {
      if (closeTimerRef.current != null) clearTimeout(closeTimerRef.current)
    },
    [],
  )
  const interactive = phase === "open"
  // a11y：打开时焦点入内 + Tab 循环 + Esc 关闭并恢复聚焦；遮罩点击关闭由按钮承担
  // （焦点在关闭开始时即归还，和旧行为一致：旧版在父级 open 翻 false 的同一刻清理）
  useEffect(() => {
    if (!interactive) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const root = asideRef.current
    const focusables = () => [...(root?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
    focusables()[0]?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        beginCloseRef.current()
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
  }, [interactive])
  const activeDevice = data.devices.find((device) => device.id === data.selectedDeviceId) ?? data.devices.find((device) => device.current) ?? data.devices[0]
  const pinnedGroup = data.groups.find((group) => group.kind === "pinned")
  const workspaceGroups = data.groups.filter((group) => group.kind !== "pinned" && group.kind !== "archive")
  const showInbox = typeof data.inboxCount === "number" && !!actions.openInbox
  const inboxCount = data.inboxCount ?? 0
  const pick = (sessionKey: string) => {
    onOpenSession(sessionKey)
    beginClose()
  }
  if (phase === "closed") return null
  return (
    <div className="pm-drawer-layer" data-pi-mobile-mode={mode} data-pi-mobile-surface="P11-MOB-02" data-closing={phase === "closing" ? "" : undefined}>
      <button type="button" className="pm-drawer-mask" aria-label="关闭侧栏" onClick={beginClose} />
      <aside ref={asideRef} className="pm-drawer" role="dialog" aria-modal="true" aria-label="侧栏" data-pi-mobile-surface="P11-MOB-03">
        <div className="pm-drawer-head">
          <span className="pm-topbar-title">Pi-Remote</span>
          {onSearch ? (
            <button type="button" className="pm-icon-btn" aria-label="搜索" onClick={onSearch}>
              <IconSearch size={20} />
            </button>
          ) : null}
        </div>
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
          <button type="button" className="pm-drawer-new" onClick={() => { actions.newSession(); beginClose() }}>
            <IconSend size={17} />
            {data.newSessionLabel ?? "新会话"}
          </button>
          <nav className="pm-drawer-naive" aria-label="侧栏导航">
            {showInbox ? (
              <button
                type="button"
                className="pm-drawer-naive-row"
                aria-label={inboxCount > 0 ? `待答，${inboxCount} 项待处理` : undefined}
                onClick={() => {
                  actions.openInbox?.()
                  beginClose()
                }}
              >
                <IconInbox size={17} />
                待答
                {inboxCount > 0 ? (
                  <span className="pm-nav-badge" aria-hidden>
                    {inboxCount > 99 ? "99+" : inboxCount}
                  </span>
                ) : null}
              </button>
            ) : null}
            <button type="button" className="pm-drawer-naive-row" onClick={() => actions.togglePlainRow?.("workspace")}>
              <IconFolder size={17} open />
              工作区
            </button>
            <button
              type="button"
              className="pm-drawer-naive-row"
              data-active={archiveView ? "" : undefined}
              aria-pressed={archiveView}
              title={PI_SIDEBAR_COPY.archiveTitle}
              onClick={() => actions.togglePlainRow?.("archive")}
            >
              <IconArchive size={17} />
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
                  beginClose()
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
                <IconPin size={14} />
                <span>{pinnedGroup.label}</span>
              </div>
              {pinnedGroup.sessions.map((session) => (
                <DrawerSessionRow key={session.key} session={session} selected={session.selected} onOpen={pick} onLongPress={setPreview} />
              ))}
            </section>
          ) : null}
          <section className="pm-drawer-section" aria-label={archiveView ? "已归档" : "工作区"}>
            <div className="pm-drawer-section-head">
              <span>{archiveView ? "已归档" : "工作区"}</span>
              {archiveView ? (
                <button type="button" className="pm-section-action" onClick={() => actions.togglePlainRow?.("archive")}>
                  返回
                </button>
              ) : null}
            </div>
            {archiveView && workspaceGroups.length === 0 ? (
              <div className="pm-empty">
                <p className="pm-empty-title">{PI_SIDEBAR_COPY.archiveEmpty}</p>
                <p className="pm-empty-hint">{PI_SIDEBAR_COPY.archiveHint}</p>
              </div>
            ) : null}
            {workspaceGroups.map((group) => {
              const tone = group.collapsed ? mobileGroupToneOf(group) : "idle"
              return (
                <div className="pm-drawer-group" key={group.id}>
                  <button type="button" className="pm-drawer-workspace" aria-expanded={!group.collapsed} title={group.cwd || undefined} onClick={() => actions.toggleGroup(group.id)}>
                    <span className="pm-workspace-icon">
                      <IconFolder size={17} open={!group.collapsed} />
                    </span>
                    <span className="pm-workspace-name">{group.label}</span>
                    {tone !== "idle" ? <span className="pm-group-tone" data-tone={tone} role="img" aria-label={MOBILE_GROUP_TONE_LABEL[tone]} /> : null}
                  </button>
                  {!group.collapsed
                    ? group.sessions.map((session) => (
                        <DrawerSessionRow key={session.key} session={session} selected={session.selected} onOpen={pick} onLongPress={setPreview} />
                      ))
                    : null}
                  {/* D-3: rows past the per-group cap need a visible way in. */}
                  {!group.collapsed && actions.toggleExpanded && group.more != null && group.more > 0 ? (
                    <button type="button" className="pm-group-more" onClick={() => actions.toggleExpanded?.(group.id)}>
                      更多 {group.more}
                    </button>
                  ) : null}
                  {!group.collapsed && actions.toggleExpanded && group.expanded ? (
                    <button type="button" className="pm-group-more" onClick={() => actions.toggleExpanded?.(group.id)}>
                      收起
                    </button>
                  ) : null}
                </div>
              )
            })}
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
          <button type="button" className="pm-icon-btn" aria-label="设置" onClick={() => { actions.openSettings(); beginClose() }}>
            <IconSettings size={20} />
          </button>
        </div>
        <div className="pm-safe-bottom" aria-hidden />
      </aside>
      {preview ? (
        <LongPressCard
          session={preview}
          onPin={actions.togglePin}
          onArchive={actions.toggleArchive}
          onMore={
            onRowMenu
              ? () => {
                  onRowMenu(preview)
                  beginClose()
                }
              : undefined
          }
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  )
}

/** Touch long-press threshold for drawer rows; matches the list rows
 * (SwipeRow LONG_PRESS_MS) so both mobile shells answer a hold the same way. */
const DRAWER_LONG_PRESS_MS = 480
/** A hold that travels further than this is a drawer scroll, not a long-press. */
const DRAWER_LONG_PRESS_SLOP = 10

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
  /*
   * Touch long-press: before this, the row only answered contextmenu and
   * Shift+F10, so a touch user had no way to reach the action card in
   * drawer mode (verified on the live rig: a 1.3s touch hold produced no
   * card and no contextmenu). The timer mirrors the list-row behaviour:
   * touch/pen only (the mouse keeps the contextmenu path), movement past
   * the slop cancels (drawer scroll), and the click the browser fires on
   * release is swallowed so the session does not also open.
   */
  const timerRef = useRef<number | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  const suppressClickRef = useRef(false)
  const clearTimer = () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    originRef.current = null
  }
  useEffect(() => clearTimer, [])
  return (
    <div className="pm-drawer-session">
      <button
        type="button"
        className="pm-drawer-session-btn"
        data-pi-row-key={session.id}
        data-selected={selected ? "" : undefined}
        aria-haspopup="dialog"
        aria-label={`${session.title}${session.dateTimeLabel ? ` · ${session.dateTimeLabel}` : ""}（长按或 Shift+F10 打开操作卡）`}
        onClick={() => onOpen(session.key)}
        onClickCapture={(event) => {
          if (!suppressClickRef.current) return
          suppressClickRef.current = false
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "mouse") return
          clearTimer()
          suppressClickRef.current = false
          originRef.current = { x: event.clientX, y: event.clientY }
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null
            originRef.current = null
            suppressClickRef.current = true
            onLongPress(session)
          }, DRAWER_LONG_PRESS_MS)
        }}
        onPointerMove={(event) => {
          const origin = originRef.current
          if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > DRAWER_LONG_PRESS_SLOP) clearTimer()
        }}
        onPointerUp={clearTimer}
        onPointerCancel={clearTimer}
        onPointerLeave={clearTimer}
        onContextMenu={(event) => {
          event.preventDefault()
          // A platform contextmenu delivered after our own timer fired
          // (Android long-press) must not reopen the card a second time.
          if (suppressClickRef.current) return
          clearTimer()
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
        {session.timeLabel ? <span className="pm-drawer-session-time" title={session.dateTimeLabel}>{session.timeLabel}</span> : null}
      </button>
    </div>
  )
}

/** spec 7.1 建议名别名 */
export const DrawerNav = MobileDrawerNav
