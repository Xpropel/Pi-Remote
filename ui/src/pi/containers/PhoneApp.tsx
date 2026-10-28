import { useMemo } from "react"
import type { PiTheme } from "@/components/pi/shared/viewport"
import { MobileNavShell, useMobileSidebarData } from "@/pi/mobile"
import type { PiSidebarActions } from "@/pi/sidebar"
import { PiButton, PiCenteredState, PiPhonePage, PiTopBar, usePiStatic } from "@/components/pi/shared"
import { usePiPhoneNav, type PiPhoneNav } from "@/pi/hooks/usePiPhoneNav"
import { bootInputOf, bootViewOf } from "@/pi/model/boot"
import { phonePageOf, type PiPhonePageKey } from "@/pi/model/phoneRoute"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { CommandPaletteContainer } from "./CommandPaletteContainer"
import { ComposerContainer, ComposerSheets } from "./ComposerContainer"
import { useDeviceOfflineExtras } from "./DeviceOfflineContainer"
import { DialogsContainer } from "./DialogsContainer"
import { DisplayOptionsSheet } from "./DisplayOptionsContainer"
import { LinkStatusContainer } from "./LinkStatusContainer"
import { NewSessionContainer } from "./NewSessionContainer"
import { NoticeContainer } from "./NoticeContainer"
import { PairingContainer } from "./PairingContainer"
import { PaneContainer } from "./PaneContainer"
import { SessionInfoContainer, SessionInfoSheet } from "./SessionInfoContainer"
import { SessionMenuContainer } from "./SessionMenuContainer"
import { SettingsRoute } from "./SettingsRoute"
import { TaskPanelContainer } from "./TaskPanelContainer"
import { TranscriptContainer } from "./TranscriptContainer"
import type { PiAppProps, PiContainerProps, PiSessionExtras, Relay } from "./types"

/**
 * 手机外壳（plan P5.3，a 线；平板 768–1023 也走这里，P6.1）。页面照 #/play 的外壳分（R2/p5-lanes.md §3），哪一页由 model/phoneRoute.ts 的 phonePageOf 算：
 *   推入页   新建 NewSessionContainer（c）| 设置 SettingsRoute（c，手机独立设置系统）| 终端 / 改动 / 文件 PaneContainer（b）
 *   列表/会话页 P11：由共享 MobileNavShell 托管（列表默认/抽屉双模式；P4 锚点保留在 CursorMobileShell 包装）；
 *            设置/新建/面板仍走 PiPhonePage 推入页；旧 SidebarContainer 手机分支/PhoneAccountFooter 已随 P11 删除
 *   对话页   PiPhonePage：顶栏 SessionInfoContainer（a，返回钮"返回会话列表，N 个会话需要处理"）、状态行 LinkStatusContainer（a）、
 *            通知 NoticeContainer（a）、正文 TranscriptContainer（b）、dock ComposerContainer（c）
 *   sheet 槽（两页共用）：a 的 SessionMenuContainer、SessionInfoSheet、PairingContainer · b 的 TaskPanelContainer ·
 *            c 的 ComposerSheets、DisplayOptionsSheet、CommandPaletteContainer、DialogsContainer
 * 首次连接、没有设备、还没打开会话、或 ui.phonePage === "list" 时是列表页。
 * P6.1（p6-base）：两页标 page="list" / "chat"（平板 ≥ 768 时只有对话页的对话列和 dock 限宽 768 居中，pi-theme.css）。
 * P6.2（a 线）：可交互时（产品、#/live 的 interactive / vp=device）由 usePiPhoneNav 管历史栈（列表 ↔ 对话 ↔ 推入页、弹层哨兵、
 * 深链 5 秒"会话不可用"、240ms 转场）；静态态（画廊、#/live 对图）不调它，渲染和 P5 一样，不碰 history。
 * b / c 线不改本文件，要加槽位写 R2/lane-requests/p6-<线>.md（P6 起本文件归 a 线，R2/p6-lanes.md）。
 */
export function PhoneApp(props: PiAppProps & { theme?: PiTheme }) {
  return usePiStatic() ? <PhoneShell {...props} /> : <PhoneNavShell {...props} />
}

function useBootKind(relay: Relay) {
  const sessionCount = useMemo(
    () => sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).length,
    [relay.devices, relay.rooms, relay.sessionsByDevice],
  )
  return bootViewOf(bootInputOf(relay, sessionCount)).kind
}

/**
 * 可交互的手机外壳：导航 + 转场。页面后面跟一个隐藏的标记（data-pi-phone-nav = 当前页），转场动画放在它前一个兄弟 = 页面根节点上；
 * 不包外层：页面根节点还是 PiRoot 里的直接子元素（灯箱等浮层给"背后的兄弟"加 inert 时落在 [data-pi-shell] 上）。
 */
function PhoneNavShell(props: PiAppProps & { theme?: PiTheme }) {
  const { anchorRef, ...nav } = usePiPhoneNav(props, useBootKind(props.relay))
  return (
    <>
      <PhoneShell {...props} nav={nav} />
      <span ref={anchorRef} hidden data-pi-phone-nav={nav.page} />
    </>
  )
}

function CursorMobileShell({
  p,
  page,
  nav,
  sheets,
  extras,
}: {
  p: PiContainerProps
  page: "list" | "chat"
  nav?: Omit<PiPhoneNav, "anchorRef">
  sheets: React.ReactNode
  extras: PiSessionExtras | undefined
}) {
  const { relay, ui, act } = p
  const htmlTheme = typeof document !== "undefined" && document.documentElement.getAttribute("data-pi-theme") === "light" ? "light" : "dark"
  const mobileSide = useMobileSidebarData(p as unknown as Parameters<typeof useMobileSidebarData>[0], {
    style: "cursor",
    theme: htmlTheme,
    search: { open: ui.search != null, query: ui.search ?? "" },
  })
  const selectSession = (key: string) => {
    const at = key.indexOf("::")
    if (at < 0) return
    const deviceId = key.slice(0, at)
    const id = key.slice(at + 2)
    const listed = sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).find((session) => session.id === id && session.deviceId === deviceId)
    if (deviceId && deviceId !== relay.selectedDeviceId) relay.selectDevice(deviceId)
    const openable = relay.rooms.some((room) => room.id === id && room.online)
    if (openable) relay.selectRoom(id)
    else if (listed) relay.selectListedSession(listed)
    act.openSession()
    act.setPhonePage("chat")
  }
  const mobileActions: PiSidebarActions = {
    selectSession,
    newSession: act.newSession,
    selectDevice: (deviceId) => relay.selectDevice(deviceId),
    addDevice: () => act.openSheet({ id: "a:pairing" }),
    togglePin: (key) => {
      mobileSide.togglePin(key)
      relay.notify("仅本机记忆，尚未写入 pi", "warn")
    },
    toggleArchive: (key) => {
      mobileSide.toggleArchive(key)
      relay.notify("归档仅本机记忆，不会删除会话", "warn")
    },
    toggleGroup: mobileSide.toggleGroup,
    togglePlainRow: (row) => {
      if (row === "workspace") mobileSide.data.groups.forEach((group) => mobileSide.toggleGroup(group.id))
      else relay.notify("本机归档列表：暂无归档", "warn")
    },
    openSearch: () => act.setSearch(""),
    closeSearch: () => act.setSearch(null),
    setSearchQuery: (query) => act.setSearch(query),
    openSettings: act.openSettings,
    resize: () => undefined,
    toggleCollapse: () => undefined,
  }
  const chatBody =
    page === "chat" ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <LinkStatusContainer {...p} />
        {relay.notices.length > 0 ? <NoticeContainer {...p} /> : null}
        <div className="min-h-0 flex-1">
          <TranscriptContainer {...p} extras={extras} />
        </div>
        <div className="px-4 pt-2">
          <ComposerContainer {...p} extras={extras} />
        </div>
      </div>
    ) : null
  return (
    <>
      <div data-p4-surface={page === "list" ? "CX-PHONE-LIST" : "CX-PHONE-CHAT"} data-p4-ready="">
        <MobileNavShell
          mode={ui.prefs.mobileNav}
          data={mobileSide.data}
          actions={mobileActions}
          page={page === "chat" ? "session" : "list"}
          onOpenSession={selectSession}
          onBackToList={() => (nav?.back ? nav.back() : act.setPhonePage("list"))}
        >
          {chatBody}
        </MobileNavShell>
      </div>
      {sheets}
    </>
  )
}

function PhoneShell({ nav, theme, ...app }: PiAppProps & { nav?: Omit<PiPhoneNav, "anchorRef">; theme?: PiTheme }) {
  const { relay, ui, keyboardOpen } = app
  const p: PiContainerProps = { ...app, variant: "phone" }
  const extras = useDeviceOfflineExtras(p) ?? undefined
  const boot = useBootKind(relay)
  const page: PiPhonePageKey =
    nav?.page ?? phonePageOf({ boot, view: ui.view, pane: ui.pane, phonePage: ui.phonePage, search: ui.search, roomId: relay.roomId })
  if (page === "new") return <NewSessionContainer {...p} />
  if (page === "settings") return <SettingsRoute p={p} theme={theme} />
  if (page === "pane") return <PaneContainer {...p} />
  const sheets = (
    <>
      <SessionMenuContainer {...p} />
      <SessionInfoSheet {...p} />
      <PairingContainer {...p} />
      <TaskPanelContainer {...p} />
      <ComposerSheets {...p} />
      <DisplayOptionsSheet {...p} />
      <CommandPaletteContainer {...p} />
      <DialogsContainer {...p} />
    </>
  )
  // P11 B3：列表/会话页接共享移动框架（子组件保证 hooks 无条件调用）
  if (page === "list" || page === "chat") {
    return <CursorMobileShell p={p} page={page} nav={nav} sheets={sheets} extras={extras} />
  }
  if (nav?.opening) {
    // 深链 / 前进到的会话还没找到（design J08）：先"正在打开会话…"，5 秒没找到"会话不可用"
    const lost = nav.opening.unavailable
    return (
      <PiPhonePage
        page="chat"
        topBar={<PiTopBar variant="phone-chat" title="" onBack={nav.back} actions={<></>} />}
        statusLine={<LinkStatusContainer {...p} />}
        sheet={sheets}
        contentClassName="flex min-h-full items-center justify-center pb-16"
      >
        <div data-pi-opening={lost ? "unavailable" : "loading"} className="w-full">
          {lost ? (
            <PiCenteredState
              title="会话不可用"
              body="会话不存在或设备已离线"
              actions={
                <PiButton variant="phone" onClick={nav.back}>
                  返回会话列表
                </PiButton>
              }
            />
          ) : (
            <PiCenteredState spinner title={<span className="font-normal text-(--cw-pi-text-secondary)">正在打开会话…</span>} />
          )}
        </div>
      </PiPhonePage>
    )
  }
  return (
    <PiPhonePage
      page="chat"
      topBar={<SessionInfoContainer {...p} />}
      statusLine={<LinkStatusContainer {...p} />}
      notice={relay.notices.length > 0 ? <NoticeContainer {...p} /> : undefined}
      dock={
        <div className="px-4 pt-2">
          <ComposerContainer {...p} extras={extras} />
        </div>
      }
      keyboardOpen={keyboardOpen}
      sheet={sheets}
      scrollTop="bottom"
    >
      <TranscriptContainer {...p} extras={extras} />
    </PiPhonePage>
  )
}
