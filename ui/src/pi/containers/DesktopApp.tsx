import { useMemo } from "react"
import type { PiTheme } from "@/components/pi/shared/viewport"
import { PiDesktopShell } from "@/components/pi/shared"
import { composerBlockOf } from "@/pi/model/composerButton"
import { usePiShellShortcuts } from "@/pi/hooks/usePiShellShortcuts"
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
 * b / c 线不改本文件，要加槽位写 R2/lane-requests/p5-<线>.md。
 */
export function DesktopApp(props: PiAppProps & { theme?: PiTheme }) {
  const { relay, ui, act, theme } = props
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
      sidebar={<SidebarContainer {...p} />}
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
