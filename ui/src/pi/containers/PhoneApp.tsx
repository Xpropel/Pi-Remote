import { useEffect, useMemo, useState, type CSSProperties } from "react"
import type { PiTheme } from "@/components/pi/shared/viewport"
import { MobileInboxPage, MobileNavShell, PI_MOBILE_METRICS, useMobileSidebarData, type MobileInboxGroup } from "@/pi/mobile"
import { PI_SIDEBAR_COPY, type PiSidebarActions } from "@/pi/sidebar"
import { useNow } from "@/pi/hooks/useNow"
import { inboxViewOf, openInboxEntry, type InboxViewRow } from "@/pi/model/inboxView"
import {
  PiButton,
  PiCenteredState,
  PiHomeIndicator,
  PiPhonePage,
  PiStatusBarPlaceholder,
  PiTopBar,
  usePiFrame,
  usePiStatic,
} from "@/components/pi/shared"
import { usePiPhoneNav, type PiPhoneNav } from "@/pi/hooks/usePiPhoneNav"
import { bodySearchNoteOf, openBodySearchHit, useBodySearch } from "@/pi/hooks/useBodySearch"
import { bootInputOf, bootViewOf } from "@/pi/model/boot"
import { paletteBodyHitsOf } from "@/pi/model/palette"
import { phonePageOf, type PiPhonePageKey } from "@/pi/model/phoneRoute"
import { otherAttentionCount, sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { searchSessions } from "@/shell/searchModel"
import type { PiSidebarSearchBody } from "@/pi/sidebar"
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
import { A_SESSION_INFO, SessionInfoSheet, useSessionHead } from "./SessionInfoContainer"
import { A_SESSION_MENU, SessionMenuContainer } from "./SessionMenuContainer"
import { SettingsRoute } from "./SettingsRoute"
import { TaskPanelContainer } from "./TaskPanelContainer"
import { TranscriptContainer } from "./TranscriptContainer"
import type { PiAppProps, PiContainerProps, PiSessionExtras, Relay } from "./types"

/**
 * 手机外壳（plan P5.3，a 线；P11 起只服务 ≤767，平板 ≥768 走桌面壳，见 shell/breakpoints.ts）。页面照 #/play 的外壳分（R2/p5-lanes.md §3），哪一页由 model/phoneRoute.ts 的 phonePageOf 算：
 *   推入页   新建 NewSessionContainer（c）| 设置 SettingsRoute（c，手机独立设置系统）| 终端 / 改动 / 文件 PaneContainer（b）|
 *            待答 PhoneInboxPage（手机版式 MobileInboxPage，数据同桌面 InboxContainer）
 *   列表/会话页 P11：由共享 MobileNavShell 托管（列表默认/抽屉双模式；P4 锚点保留在 CursorMobileShell 包装）；
 *            设置/新建/面板仍走 PiPhonePage 推入页；旧 SidebarContainer 手机分支/PhoneAccountFooter 已随 P11 删除
 *   会话页正文 内嵌 PiPhonePage：状态行 LinkStatusContainer（a）、正文 TranscriptContainer（b）、dock ComposerContainer（c）
 *   通知     所有页面共用一个出口 PhoneNoticeOutlet（跟在页面后面），页面里不再各放通知槽
 *   sheet 槽（两页共用）：a 的 SessionMenuContainer、SessionInfoSheet、PairingContainer · b 的 TaskPanelContainer ·
 *            c 的 ComposerSheets、DisplayOptionsSheet、CommandPaletteContainer、DialogsContainer
 * 首次连接、没有设备、还没打开会话、或 ui.phonePage === "list" 时是列表页。
 * P6.1（p6-base）：两页标 page="list" / "chat"（pi-theme.css 里平板 ≥768 的限宽居中，P11 改断点后本壳已用不到）。
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
 * 可交互的手机外壳：导航 + 转场。页面后面跟一个隐藏的标记（data-pi-phone-nav = 当前页），转场动画放在它前面的页面根节点上
 * （中间可能隔着通知出口，usePiPhoneNav 会跳过）；
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

/**
 * 移动壳自包含、不读 --cw-*：安全区（舞台 47/34、产品 env()）和整页底色（同会话正文 --cw-bg）由这里桥接成 --pm-host-*，
 * 顶栏 / 抽屉头 / 列表底部据此让位；设置 › 外观的字号档位按手机正文（pi-theme.css 手机尺寸 15 / 行高 20）差几 px 桥接
 */
const MOBILE_HOST_VARS = {
  "--pm-host-safe-top": "var(--cw-pi-safe-top, 0px)",
  "--pm-host-safe-bottom": "var(--cw-pi-safe-bottom, 0px)",
  "--pm-host-safe-left": "var(--cw-pi-safe-left, 0px)",
  "--pm-host-safe-right": "var(--cw-pi-safe-right, 0px)",
  "--pm-host-bg": "var(--cw-bg)",
  "--pm-host-font-step": "calc(var(--cw-text-base, 15px) - 15px)",
  "--pm-host-lead-step": "calc(var(--cw-leading-tight, 20px) - 20px)",
} as CSSProperties

/** 移动壳的皮肤：宿主给了用宿主的，否则跟文档根（首帧脚本已写好 data-pi-theme） */
function mobileThemeOf(theme: PiTheme | undefined): "light" | "dark" {
  return theme ?? (typeof document !== "undefined" && document.documentElement.getAttribute("data-pi-theme") === "light" ? "light" : "dark")
}

function CursorMobileShell({
  p,
  page,
  nav,
  sheets,
  extras,
  theme,
}: {
  p: PiContainerProps
  page: "list" | "chat"
  nav?: Omit<PiPhoneNav, "anchorRef">
  sheets: React.ReactNode
  extras: PiSessionExtras | undefined
  theme?: PiTheme
}) {
  const { relay, ui, act } = p
  const head = useSessionHead(p)
  const isStatic = usePiStatic()
  const stage = usePiFrame().mode !== "product"
  // 归档视图只是列表自己的切换（本机归档），不进路由；同桌面侧栏
  const [archiveView, setArchiveView] = useState(false)
  const shellTheme = mobileThemeOf(theme)
  // 正文搜索（A-3）：手机搜索页打开时在选中设备上搜正文，结果进 search.body
  const bodySearch = useBodySearch(relay, ui.search ?? "", ui.search != null)
  const bodyBlock = ((): PiSidebarSearchBody | undefined => {
    const { state, deviceId: bodyDeviceId, deviceName } = bodySearch
    if (state.phase === "idle" || bodyDeviceId == null) return undefined
    if (state.phase === "searching") {
      return { deviceName, phase: "searching", hits: [], note: deviceName ? `正在 ${deviceName} 上搜索正文…` : "正在搜索正文…" }
    }
    if (state.phase === "error") return { deviceName, phase: "error", hits: [], note: state.text }
    const query = (ui.search ?? "").trim()
    const titleMatched = searchSessions(sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice), query)
    const hits = paletteBodyHitsOf(state.page, { id: bodyDeviceId, name: deviceName }, titleMatched.map((s) => ({ id: s.id, path: s.path })))
    return {
      deviceName,
      phase: "done",
      hits: hits.map((hit) => ({ id: hit.id, label: hit.title, snippet: hit.snippet, matchCount: hit.matchCount })),
      note: bodySearchNoteOf(state, hits.length) ?? undefined,
    }
  })()
  const mobileSide = useMobileSidebarData(p as unknown as Parameters<typeof useMobileSidebarData>[0], {
    style: "cursor",
    theme: shellTheme,
    search: { open: ui.search != null, query: ui.search ?? "", body: bodyBlock },
    archiveView,
  })
  const currentGroupId = mobileSide.data.groups.find((group) => group.kind === "workspace" && group.sessions.some((session) => session.selected))?.id
  const revealFolder = mobileSide.revealFolder
  useEffect(() => {
    if (!isStatic && !archiveView && currentGroupId) revealFolder(currentGroupId)
  }, [isStatic, archiveView, currentGroupId, revealFolder])
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
  const selectBodyHit = (hitId: string) => {
    const { state, deviceId: bodyDeviceId, deviceName } = bodySearch
    if (state.phase !== "done" || bodyDeviceId == null) return
    const query = (ui.search ?? "").trim()
    const titleMatched = searchSessions(sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice), query)
    const hits = paletteBodyHitsOf(state.page, { id: bodyDeviceId, name: deviceName }, titleMatched.map((s) => ({ id: s.id, path: s.path })))
    const hit = hits.find((h) => h.id === hitId)
    if (hit) {
      openBodySearchHit(relay, hit, () => {
        act.openSession()
        act.setPhonePage("chat")
      })
    }
  }
  const mobileActions: PiSidebarActions = {
    selectSession,
    selectBodyHit,
    newSession: act.newSession,
    selectDevice: (deviceId) => relay.selectDevice(deviceId),
    addDevice: () => act.openSheet({ id: "a:pairing" }),
    // 同桌面侧栏：置顶 / 归档只记在这台浏览器里，放上去时给一条普通通知卡，取消时不提示
    togglePin: (key) => {
      const pinning = !mobileSide.pins.includes(key)
      mobileSide.togglePin(key)
      if (pinning) relay.pushNotice({ level: "info", title: PI_SIDEBAR_COPY.pinHint, dedupeKey: "sidebar.pin-local" })
    },
    toggleArchive: (key) => {
      const archiving = !mobileSide.archives.includes(key)
      mobileSide.toggleArchive(key)
      if (archiving) relay.pushNotice({ level: "info", title: PI_SIDEBAR_COPY.archiveHint, dedupeKey: "sidebar.archive-local" })
    },
    toggleGroup: mobileSide.toggleGroup,
    toggleExpanded: mobileSide.toggleExpanded,
    togglePlainRow: (row) => {
      if (row === "archive") return setArchiveView((open) => !open)
      // 朴素行「工作区」：归档视图里回到工作区；否则有展开的组就全收起，没有就全展开
      if (archiveView) return setArchiveView(false)
      const workspaces = mobileSide.data.groups.filter((group) => group.kind === "workspace")
      mobileSide.setGroupsCollapsed(workspaces.map((group) => group.id), workspaces.some((group) => !group.collapsed))
    },
    openArchiveView: () => setArchiveView((open) => !open),
    openSearch: () => act.setSearch(""),
    closeSearch: () => act.setSearch(null),
    setSearchQuery: (query) => act.setSearch(query),
    openSettings: act.openSettings,
    openInbox: act.openInbox,
    resize: () => undefined,
    toggleCollapse: () => undefined,
  }
  // 会话区复用 PiPhonePage（唯一滚动区 [data-pi-scroller]、贴底、键盘让位、dock 高度上限、底部安全区）；顶栏由 MobileNavShell 给
  const chatBody =
    page === "chat" ? (
      <div className="relative min-h-0 flex-1">
        <PiPhonePage
          page="chat"
          embedded
          statusLine={<LinkStatusContainer {...p} />}
          dock={
            <div className="px-4 pt-2">
              <ComposerContainer {...p} extras={extras} />
            </div>
          }
          keyboardOpen={p.keyboardOpen}
          scrollTop="bottom"
        >
          <TranscriptContainer {...p} extras={extras} />
        </PiPhonePage>
      </div>
    ) : null
  const roomId = relay.roomId
  return (
    <>
      <div className="relative h-full" style={MOBILE_HOST_VARS}>
        <MobileNavShell
          mode={ui.prefs.mobileNav}
          data={mobileSide.data}
          actions={mobileActions}
          page={page === "chat" ? "session" : "list"}
          onOpenSession={selectSession}
          onBackToList={() => (nav?.back ? nav.back() : act.setPhonePage("list"))}
          sessionTitle={head.title}
          sessionSubtitle={head.device?.name}
          sessionAttentionCount={otherAttentionCount(head.data.attention, roomId, head.device?.id ?? null)}
          onSessionInfo={roomId ? () => act.openSheet({ id: A_SESSION_INFO }) : undefined}
          onSessionMenu={roomId && head.row ? () => act.openSheet({ id: A_SESSION_MENU, arg: roomId }) : undefined}
          onRowMenu={isStatic ? undefined : (session) => act.openSheet({ id: A_SESSION_MENU, arg: session.id })}
          archiveView={archiveView}
          archivedCount={mobileSide.archivedCount}
        >
          {chatBody}
        </MobileNavShell>
        {/* 舞台（画廊对图）才画状态栏 / Home 指示条占位；会话页的 Home 指示条由内嵌的 PiPhonePage 画 */}
        {stage ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-(--cw-pi-z-chrome)">
            <PiStatusBarPlaceholder />
          </div>
        ) : null}
        {stage && page === "list" && !p.keyboardOpen ? <PiHomeIndicator /> : null}
      </div>
      {sheets}
    </>
  )
}

function PhoneShell({ nav, theme, ...app }: PiAppProps & { nav?: Omit<PiPhoneNav, "anchorRef">; theme?: PiTheme }) {
  const { relay, ui } = app
  const p: PiContainerProps = { ...app, variant: "phone" }
  const boot = useBootKind(relay)
  const page: PiPhonePageKey =
    nav?.page ?? phonePageOf({ boot, view: ui.view, pane: ui.pane, phonePage: ui.phonePage, search: ui.search, roomId: relay.roomId })
  const opening = page === "chat" ? (nav?.opening ?? null) : null
  return (
    <>
      <PhonePage p={p} page={page} nav={nav} opening={opening} theme={theme} />
      <PhoneNoticeOutlet p={p} page={page} piTopBar={page === "new" || page === "pane" || opening != null} />
    </>
  )
}

/**
 * 手机唯一的通知出口：所有页面共用，页面里不再各放通知槽（同一时刻只此一处，不会重复）。
 * 顶栏下 8（移动壳 / 设置页 / 待答的顶栏 54，PiTopBar 的推入页 52）、左右 max(16, 安全区)，宽屏手机布局时随内容列限宽居中。
 * 层级 raised：盖正文，抽屉 / 菜单 / sheet / 弹窗都在它上面。设置页的根是 fixed + popover 层（独立设置系统），
 * 只在这一页抬到同层、靠排在它后面盖住它，仍低于配对 / 诊断 sheet。
 */
function PhoneNoticeOutlet({ p, page, piTopBar }: { p: PiContainerProps; page: PiPhonePageKey; piTopBar: boolean }) {
  if (p.relay.notices.length === 0) return null
  const bar = piTopBar ? "var(--cw-pi-topbar-h-phone)" : `${PI_MOBILE_METRICS.topBarH}px`
  return (
    <div
      data-pi-notice-slot=""
      className={
        page === "settings"
          ? "pointer-events-none absolute z-(--cw-pi-z-popover) flex justify-center"
          : "pointer-events-none absolute z-(--cw-pi-z-raised) flex justify-center"
      }
      style={{
        top: `calc(var(--cw-pi-safe-top, 0px) + ${bar} + 8px)`,
        left: "max(16px, var(--cw-pi-safe-left, 0px))",
        right: "max(16px, var(--cw-pi-safe-right, 0px))",
      }}
    >
      <div className="pointer-events-auto w-full" style={{ maxWidth: PI_MOBILE_METRICS.columnMaxW }}>
        <NoticeContainer {...p} />
      </div>
    </div>
  )
}

/**
 * 待答推入页的手机版式。分组、标题、状态行、可答 / 可清除与点行进房都走共享模型 inboxView（同桌面 InboxContainer），
 * 这里只接手机的动作；‹ 同新会话 / 设置：关推入页，回到进来前那一页。
 */
function PhoneInboxPage({ p, theme }: { p: PiContainerProps; theme?: PiTheme }) {
  const { relay, act } = p
  const [answering, setAnswering] = useState<string | null>(null)
  const now = useNow(30_000)
  const stage = usePiFrame().mode !== "product"
  const sections = inboxViewOf({
    entries: relay.inbox,
    rooms: relay.rooms,
    sessions: sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice),
    devices: relay.devices,
    now,
  })
  const answer = (row: InboxViewRow, action: "allow" | "deny") => {
    if (!row.confirm || answering) return
    setAnswering(row.key)
    void relay.sendDialogAnswerTo(row.entry.roomId, row.confirm.dialogId, { action }).finally(() => setAnswering(null))
  }
  const groups: MobileInboxGroup[] = sections.map((section) => ({
    kind: section.kind,
    label: section.label,
    rows: section.rows.map((row) => ({
      key: row.key,
      title: row.title,
      detail: row.detail,
      timeLabel: row.timeLabel,
      onOpen: () => {
        openInboxEntry(relay, row.entry)
        act.openSession()
      },
      confirm: row.confirm
        ? { ...row.confirm, busy: answering === row.key, onAllow: () => answer(row, "allow"), onDeny: () => answer(row, "deny") }
        : undefined,
      onDismiss: row.dismissible ? () => relay.dismissInbox(row.key) : undefined,
    })),
  }))
  return (
    <div className="relative h-full" style={MOBILE_HOST_VARS}>
      <MobileInboxPage style="cursor" theme={mobileThemeOf(theme)} groups={groups} onBack={() => act.openSession()} />
      {stage ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-(--cw-pi-z-chrome)">
          <PiStatusBarPlaceholder />
        </div>
      ) : null}
      {stage && !p.keyboardOpen ? <PiHomeIndicator /> : null}
    </div>
  )
}

function PhonePage({
  p,
  page,
  nav,
  opening,
  theme,
}: {
  p: PiContainerProps
  page: PiPhonePageKey
  nav?: Omit<PiPhoneNav, "anchorRef">
  opening: { unavailable: boolean } | null
  theme?: PiTheme
}) {
  const extras = useDeviceOfflineExtras(p) ?? undefined
  if (page === "new") return <NewSessionContainer {...p} />
  if (page === "settings") return <SettingsRoute p={p} theme={theme} />
  if (page === "inbox") return <PhoneInboxPage p={p} theme={theme} />
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
  if (opening && nav) {
    // 深链 / 前进到的会话还没找到（design J08）：先"正在打开会话…"，5 秒没找到"会话不可用"。
    // 要在列表/会话页之前判：那边画的是 relay 里还开着的上一个会话
    const lost = opening.unavailable
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
  // P11 B3：列表/会话页接共享移动框架（子组件保证 hooks 无条件调用）
  return <CursorMobileShell p={p} page={page} nav={nav} sheets={sheets} extras={extras} theme={theme} />
}
