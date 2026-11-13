import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import type { PiTheme } from "@/components/pi/shared/viewport"
import { PiDesktopShell, usePiFrame, usePiLayer, usePiLayerState } from "@/components/pi/shared"
import { composerBlockOf } from "@/pi/model/composerButton"
import { usePiShellShortcuts } from "@/pi/hooks/usePiShellShortcuts"
import { usePiAddressSync } from "@/pi/hooks/usePiAddressSync"
import {
  isTabletWidth,
  setSidebarDrawerActive,
  setSidebarDrawerOpen,
  toggleSidebarOrDrawer,
  useSidebarDrawer,
  type SidebarDrawerControl,
} from "@/pi/hooks/useSidebarDrawer"
import { useWidthValue } from "@/shell/breakpoints"
import { bootInputOf, bootViewOf } from "@/pi/model/boot"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { BootContainer } from "./BootContainer"
import { CommandPaletteContainer } from "./CommandPaletteContainer"
import { ComposerContainer } from "./ComposerContainer"
import { useDeviceOfflineExtras } from "./DeviceOfflineContainer"
import { DialogsContainer } from "./DialogsContainer"
import { LinkStatusContainer } from "./LinkStatusContainer"
import { NewSessionContainer } from "./NewSessionContainer"
import { InboxContainer } from "./InboxContainer"
import { NoticeContainer } from "./NoticeContainer"
import { PairingContainer } from "./PairingContainer"
import { PaneContainer } from "./PaneContainer"
import { SessionInfoContainer } from "./SessionInfoContainer"
import { SessionMenuContainer } from "./SessionMenuContainer"
import { SettingsRoute } from "./SettingsRoute"
import { SidebarContainer } from "./SidebarContainer"
import { TranscriptContainer } from "./TranscriptContainer"
import type { PiAppProps, PiContainerProps } from "./types"

/**
 * 桌面外壳（plan P5.3，a 线）：PiDesktopShell 的槽位照 #/play 的外壳摆，内容换成三条线的容器（R2/p5-lanes.md §3）。
 *   sidebar   SidebarContainer（a；搜索态 SearchContainer、账户区滑杆的显示选项菜单 = c 的 DisplayOptionsContainer）
 *   topBar    SessionInfoContainer（a；顶栏 + 标题悬停卡；"…" = 当前会话的会话菜单 + 复制工作目录；没有会话时是空顶栏）
 *   statusLine LinkStatusContainer（a）  notice NoticeContainer（a，relay.notices 非空时）
 *   正文      启动分支 BootContainer（a：首次连接 / 没有设备 / 都未连接，model/boot.ts）| 会话 TranscriptContainer（b）| 新建 NewSessionContainer（c）| 设置 SettingsRoute（c，统一设置页 v2）
 *   dock      ComposerContainer（c；里面放 b 的 ApprovalContainer、TaskPanelContainer，读 b 的 useTranscriptStick）
 *   pane      PaneContainer（b）
 *   overlay   SessionMenuContainer、PairingContainer（a）· CommandPaletteContainer、DialogsContainer（c）
 *             · 静态态（#/live 对图）时显示选项的静态菜单由 DialogsContainer 里 c 的 DisplayOptionsOverlay 画（ui.menu = PI_UI_IDS.displayOptions），这里不再另画一份
 * 首次连接时不管在哪个视图，正文都是 BootContainer；没有设备 / 都未连接只占会话视图（设置页照常能进去配对）。
 * 平板档（视口 768–1023，只在产品模式）：侧栏收成窄栏、展开是浮层（useSidebarDrawer），右 pane 浮在正文上，
 * 最多盖住正文一半，点正文空处 / Esc 收起，收起后焦点回顶栏的「右侧面板」钮；
 * 「切换侧栏」经 toggleSidebarOrDrawer 分流，桌面档的展开 / 收起偏好在平板档上不读不写。
 * b / c 线不改本文件，要加槽位写 R2/lane-requests/p5-<线>.md。
 */
export function DesktopApp(props: PiAppProps & { theme?: PiTheme }) {
  const { relay, ui, theme } = props
  const frame = usePiFrame()
  usePiAddressSync(relay)
  const tabletWidth = useWidthValue(isTabletWidth)
  const tablet = tabletWidth && frame.mode === "product"
  useLayoutEffect(() => {
    setSidebarDrawerActive(tablet)
    return () => setSidebarDrawerActive(false)
  }, [tablet])
  const drawerOpen = useSidebarDrawer().open && tablet
  const closeDrawer = useCallback(() => {
    const focused = document.activeElement
    const focusInside = focused instanceof HTMLElement && focused.closest("[data-pi-sidebar-float]") != null
    setSidebarDrawerOpen(false)
    // 焦点在浮层里（键盘 Esc / 回车打开会话）时，收起后回到窄栏的展开钮，不掉到 body
    if (focusInside) requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-pi-sidebar-float] [data-sb-collapse]")?.focus())
  }, [])
  usePiLayer(drawerOpen, "overlay", closeDrawer)
  // 换会话 / 换视图（命令面板、快捷键、侧栏里点选）后浮层收起，正文露出来
  useEffect(() => {
    setSidebarDrawerOpen(false)
  }, [relay.roomId, ui.view])
  const act = useMemo(() => ({ ...props.act, toggleSidebar: () => toggleSidebarOrDrawer(props.act.toggleSidebar) }), [props.act])
  const drawer = useMemo<SidebarDrawerControl | undefined>(
    () => (tablet ? { open: drawerOpen, toggle: act.toggleSidebar, close: closeDrawer } : undefined),
    [tablet, drawerOpen, act, closeDrawer],
  )
  const p: PiContainerProps = { relay, ui, act, variant: "desktop", keyboardOpen: false }
  const extras = useDeviceOfflineExtras(p) ?? undefined
  const sessionCount = useMemo(
    () => sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).length,
    [relay.devices, relay.rooms, relay.sessionsByDevice],
  )
  const boot = bootViewOf(bootInputOf(relay, sessionCount)).kind
  const session = ui.view === "session"
  const ready = boot === "ready"
  const block = composerBlockOf(relay.composer.state, ui.blockedBy)
  const paneFloating = tablet && session && ready && !!ui.pane
  const closePane = useCallback(() => act.setPane(null), [act])
  const layers = usePiLayerState()
  const layerOpen = layers.menuOpen || layers.overlayOpen
  // 浮着的 pane 不登记成 overlay 层：那样它开着时 ⌘K / ⌘. 等快捷键全被挡住。
  // 菜单 / 浮层开着时 Esc 先关它们；document 冒泡早于外壳快捷键（window），收面板这一下不会再落到「停止生成」
  useEffect(() => {
    if (!paneFloating || layerOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return
      event.preventDefault()
      closePane()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [paneFloating, layerOpen, closePane])
  // 焦点在 pane 里时收起（Esc、×、⌘.）会掉到 body：回到顶栏的「右侧面板」钮
  const paneWasFloating = useRef(false)
  useLayoutEffect(() => {
    const was = paneWasFloating.current
    paneWasFloating.current = paneFloating
    if (!was || paneFloating || (document.activeElement ?? document.body) !== document.body) return
    document.querySelector<HTMLElement>("[data-pi-pane-toggle]")?.focus()
  }, [paneFloating])
  // 快捷键与 Esc 分层（P4 契约 §3，照 #/play 的 PlayApp）：Esc 第 3 层停止生成只在 canStop
  usePiShellShortcuts({
    enabled: true,
    canStop: session && ready && (block.button.variant === "stop" || block.button.ghostStop),
    onStop: () => void relay.abort(),
    onNewSession: act.newSession,
    onCommandPalette: () => act.setPaletteOpen(true),
    onToggleSidebar: act.toggleSidebar,
    onTogglePane: act.togglePane,
    onOpenSettings: act.openSettings,
  })
  // P12：设置/新建优先于 connecting 门（connecting 只压会话视图）
  const main =
    !session && ui.view === "new" ? (
      <NewSessionContainer {...p} />
    ) : !session && ui.view === "inbox" ? (
      <InboxContainer {...p} />
    ) : !session && ui.view === "settings" ? (
      <SettingsRoute p={p} theme={theme} />
    ) : boot === "connecting" || (session && !ready) ? (
      <BootContainer {...p} />
    ) : session ? (
      <TranscriptContainer {...p} extras={extras} />
    ) : ui.view === "new" ? (
      <NewSessionContainer {...p} />
    ) : (
      <SettingsRoute p={p} theme={theme} />
    )
  return (
    <PiDesktopShell
      tablet={tablet}
      sidebarOverlay={drawerOpen}
      onSidebarOverlayClose={closeDrawer}
      onPaneDismiss={closePane}
      sidebar={<SidebarContainer {...p} theme={theme} drawer={drawer} />}
      topBar={session || boot === "connecting" ? <SessionInfoContainer {...p} /> : undefined}
      statusLine={<LinkStatusContainer {...p} />}
      notice={relay.notices.length > 0 ? <NoticeContainer {...p} /> : undefined}
      dock={session && ready ? <ComposerContainer {...p} extras={extras} /> : undefined}
      pane={session && ready && ui.pane ? <PaneContainer {...p} /> : undefined}
      overlay={
        <>
          <SessionMenuContainer {...p} />
          <PairingContainer {...p} />
          <CommandPaletteContainer {...p} />
          <DialogsContainer {...p} />
        </>
      }
    >
      {main}
    </PiDesktopShell>
  )
}
