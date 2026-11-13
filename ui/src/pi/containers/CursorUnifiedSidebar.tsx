/**
 * Cursor 宿主 → P11 统一侧栏适配（B2 收口；arch 联调落地）：
 * relay → PiSidebarData/Actions；宽度/折叠走 PiPrefs（272 / 220–360 / 56），pin/archive/文件夹折叠走 arch storage；
 * 视觉由 UnifiedSidebar 按 style="cursor" × data-pi-theme 的六套 --sb-* 渲染。旧 PiSidebar 仅保留给手机列表/静态态。
 */
import { useEffect, useMemo, useState } from "react"
import { usePiStatic } from "@/components/pi/shared"
import type { PiTheme } from "@/components/pi/shared/viewport"
import {
  clampSidebarWidth,
  fullTimeLabel,
  PI_SIDEBAR_COPY,
  relativeTimeLabel,
  sidebarDeviceRows,
  sidebarGroupsWithOverlay,
  sidebarIdentityNameOf,
  sidebarSessionKeyOf,
  sidebarStatusOf,
  storedTimeLabel,
  sidebarWorkspaceGroupId,
  sidebarWorkspaceLabel,
  UnifiedSidebar,
  useSidebarLocalState,
  type PiSidebarActions,
  type PiSidebarData,
  type PiSidebarDevice,
  type PiSidebarGroup,
  type PiSidebarSession,
} from "@/pi/sidebar"
import { useNow } from "@/pi/hooks/useNow"
import { bodySearchNoteOf, openBodySearchHit, useBodySearch } from "@/pi/hooks/useBodySearch"
import type { SidebarDrawerControl } from "@/pi/hooks/useSidebarDrawer"
import { paletteBodyHitsOf } from "@/pi/model/palette"
import { sessionStatusLineOf, sidebarDataOf, openSessionRow } from "@/pi/model/sidebarSource"
import { sidebarGroups } from "@/pi/model/sidebarGroups"
import { PI_SHORTCUT_KEYS, piPlatformOf } from "@/pi/model/shortcuts"
import { searchSessions } from "@/shell/searchModel"
import { DisplayOptionsContainer } from "./DisplayOptionsContainer"
import { A_SESSION_MENU, SessionRowMenu } from "./SessionMenuContainer"
import { PI_UI_IDS, type PiContainerProps } from "./types"

const TICK_MS = 30_000

/** 宿主没传主题时的兜底：读 <html data-pi-theme>（根节点在 layout effect 里才写，所以优先用宿主传下来的值） */
function themeOf(): "dark" | "light" {
  return typeof document !== "undefined" && document.documentElement.dataset.piTheme === "light" ? "light" : "dark"
}

export function CursorUnifiedSidebar({ p, theme, drawer }: { p: PiContainerProps; theme?: PiTheme; drawer?: SidebarDrawerControl }) {
  const { relay, ui, act } = p
  // 平板档：窄栏 / 展开只跟浮层走（drawer），桌面偏好 sidebarCollapsed 不读不写
  const collapsed = drawer ? !drawer.open : ui.prefs.sidebarCollapsed
  const now = useNow(TICK_MS)
  const isStatic = usePiStatic()
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  // 归档视图只是侧栏自己的列表切换（本机归档），不进路由
  const [archiveView, setArchiveView] = useState(false)
  // 静态态（#/live 对图）摆出来的会话菜单作用在哪一行：那一行所在的组要展开，行作为菜单锚点
  const menuTargetId = isStatic && ui.menu?.id === A_SESSION_MENU ? ui.menu.arg : undefined
  const resolvedTheme = theme ?? themeOf()
  const account = relay.serverName || "local"
  const deviceId = relay.selectedDeviceId ?? ""
  const localStore = useSidebarLocalState(account, deviceId)
  const scopeState = localStore.scopeState
  // 正文搜索（A-3）：侧栏搜索打开时在选中设备上搜正文，结果进 data.search.body
  const bodySearch = useBodySearch(relay, ui.search ?? "", ui.search != null)

  const data = useMemo<PiSidebarData>(() => {
    const base = sidebarDataOf({
      devices: relay.devices,
      rooms: relay.rooms,
      sessionsByDevice: relay.sessionsByDevice,
      roomId: relay.roomId,
      dialogs: relay.dialogs,
      uiPrompt: relay.uiPrompt,
      turnEnd: relay.turnEnd,
      roomTurnEnds: relay.roomTurnEnds,
      inbox: relay.inbox,
      selectedDevice: relay.selectedDevice,
    })
    const devices: PiSidebarDevice[] = sidebarDeviceRows(
      base.devices.map((d) => ({ id: d.id, name: d.name, online: d.online, platform: d.platform, current: d.id === relay.selectedDeviceId })),
      relay.selectedDeviceId ?? null,
    )
    const sessionIds = new Map(base.sessions.map((s) => [s.id, s]))
    // 设计 D §2.2：一行实时状态（roomStatusLine）的输入面——房间事实按 id 索引、未读落定按 roomId 索引
    const roomById = new Map(relay.rooms.map((r) => [r.id, r]))
    const turnEndByRoom = new Map(relay.roomTurnEnds.map((t) => [t.roomId, t]))
    // 搜索时不截行：收在「更多 N」里的会话也要能被搜到
    const uncapped = ui.search != null ? { maxRows: Number.POSITIVE_INFINITY } : {}
    const legacy = sidebarGroups(base.sessions, base.devices, base.attention, { grouping: ui.prefs.grouping, expanded: ui.expanded, ...uncapped })
    const groups: PiSidebarGroup[] = legacy.groups.map((group) => {
      const cwd = group.cwd ?? ""
      // 归档视图里组全部展开（归档列表通常很短）；静态菜单的目标行所在组也展开
      const collapsed = !archiveView && scopeState.folders[group.key] !== false && !group.rows.some((row) => row.id === menuTargetId)
      const sessions: PiSidebarSession[] = group.rows.map((row) => {
        const session = sessionIds.get(row.id)
        const devId = row.deviceId ?? deviceId
        const key = sidebarSessionKeyOf(devId, row.id)
        // 状态行随本容器的 30 秒 tick（useNow）与名册广播一起重算（设计 D §2.2 不加新计时器）
        const status = sessionStatusLineOf({ room: roomById.get(row.id), session, turnEnd: turnEndByRoom.get(row.id), now })
        return {
          key, id: row.id, title: row.title,
          status: sidebarStatusOf({ running: row.marker === "running", waiting: row.marker === "waiting", error: row.marker === "error" }),
          eventAt: row.at,
          // D-3: stored (not live) rows get date+time once past an hour so
          // same-title rows stay tellable apart; live rows keep relative.
          timeLabel: row.trailingText ?? (session && !session.online ? storedTimeLabel(now, row.at) : relativeTimeLabel(now, row.at)),
          dateTimeLabel: fullTimeLabel(row.at),
          summary: row.subtitle ?? "",
          // 悬停气泡加行用状态全句（设计 D §2.4 第三层）
          statusLine: status.text,
          cwd: session?.cwd ?? cwd,
          deviceName: base.devices.find((d) => d.id === devId)?.name ?? "",
          selected: relay.roomId === row.id,
          pinned: scopeState.pins.includes(key),
          archived: scopeState.archives.includes(key),
          groupId: sidebarWorkspaceGroupId(cwd || session?.cwd),
          enc: session?.enc,
          encReason: session?.encReason,
        }
      })
      return { id: group.key, kind: "workspace" as const, label: group.label || sidebarWorkspaceLabel(cwd), cwd, collapsed, sessions, count: sessions.length, more: group.more, expanded: group.expanded }
    })
    const overlaid = sidebarGroupsWithOverlay({ groups, pins: scopeState.pins, archives: scopeState.archives, archiveView, folders: scopeState.folders })
    // 正文匹配块（A-3）：标题已命中的会话不重复列；状态行照 searchModel 诚实文案
    const bodyBlock = ((): PiSidebarData["search"]["body"] => {
      const { state, deviceId: bodyDeviceId, deviceName } = bodySearch
      if (state.phase === "idle" || bodyDeviceId == null) return undefined
      if (state.phase === "searching") {
        return { deviceName, phase: "searching", hits: [], note: deviceName ? `正在 ${deviceName} 上搜索正文…` : "正在搜索正文…" }
      }
      if (state.phase === "error") return { deviceName, phase: "error", hits: [], note: state.text }
      const query = (ui.search ?? "").trim()
      const titleMatched = searchSessions(base.sessions, query)
      const hits = paletteBodyHitsOf(state.page, { id: bodyDeviceId, name: deviceName }, titleMatched.map((s) => ({ id: s.id, path: s.path })))
      return {
        deviceName,
        phase: "done",
        hits: hits.map((hit) => ({ id: hit.id, label: hit.title, snippet: hit.snippet, matchCount: hit.matchCount })),
        note: bodySearchNoteOf(state, hits.length) ?? undefined,
      }
    })()
    return {
      style: "cursor", theme: resolvedTheme,
      serverName: sidebarIdentityNameOf(relay.serverName, typeof location === "undefined" ? "" : location.hostname),
      // 服务器连接态（relay.online 是当前会话的 pi 在线，不是这个）
      online: relay.status === "已连接",
      devices,
      selectedDeviceId: relay.selectedDeviceId ?? null,
      deviceMenuOpen,
      groups: overlaid.filter((g) => g.sessions.length > 0 || g.kind === "pinned"),
      newSessionLabel: "新会话",
      width: clampSidebarWidth(ui.prefs.sidebarWidth),
      collapsed,
      search: { open: ui.search != null, query: ui.search ?? "", body: bodyBlock },
      // 待答角标（设计 D §1）：只数 attention 清单里的 waiting+error+done——与账本 pending
      // 数恒等，计数唯一出口仍是 attentionItemsOf，设备掉线条不入此数。
      inboxCount: base.attention.filter((item) => item.kind === "waiting" || item.kind === "error" || item.kind === "done").length,
      now,
    }
  }, [relay, ui.prefs.grouping, ui.prefs.sidebarWidth, collapsed, ui.expanded, ui.search, scopeState, now, deviceMenuOpen, account, deviceId, bodySearch, resolvedTheme, archiveView, menuTargetId])

  // 新会话常落在默认折叠的组里，选中行看不见：当前会话所在的组没手动开合过就展开它
  const currentGroupId = data.groups.find((g) => g.kind === "workspace" && g.sessions.some((s) => s.selected))?.id
  const revealFolder = localStore.revealFolder
  useEffect(() => {
    if (!isStatic && !archiveView && currentGroupId) revealFolder(currentGroupId)
  }, [isStatic, archiveView, currentGroupId, revealFolder])

  const openRowByKey = (key: string) => {
    const id = key.includes("::") ? key.split("::").slice(1).join("::") : key
    const base = sidebarDataOf({
      devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, roomId: relay.roomId,
      dialogs: relay.dialogs, uiPrompt: relay.uiPrompt, turnEnd: relay.turnEnd, roomTurnEnds: relay.roomTurnEnds, inbox: relay.inbox, selectedDevice: relay.selectedDevice,
    })
    const session = base.sessions.find((s) => s.id === id)
    if (session) openSessionRow(relay, session, act.openSession)
  }

  const openBodyHitById = (hitId: string) => {
    const { state, deviceId: bodyDeviceId, deviceName } = bodySearch
    if (state.phase !== "done" || bodyDeviceId == null) return
    const base = sidebarDataOf({
      devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, roomId: relay.roomId,
      dialogs: relay.dialogs, uiPrompt: relay.uiPrompt, turnEnd: relay.turnEnd, roomTurnEnds: relay.roomTurnEnds, inbox: relay.inbox, selectedDevice: relay.selectedDevice,
    })
    const query = (ui.search ?? "").trim()
    const titleMatched = searchSessions(base.sessions, query)
    const hits = paletteBodyHitsOf(state.page, { id: bodyDeviceId, name: deviceName }, titleMatched.map((s) => ({ id: s.id, path: s.path })))
    const hit = hits.find((h) => h.id === hitId)
    if (hit) openBodySearchHit(relay, hit, () => act.openSession())
  }

  // 平板档浮层里点了去处（会话、新会话、设置、待答）就先收起浮层
  const leave =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A) => {
      drawer?.close()
      run(...args)
    }
  const actions: PiSidebarActions = {
    selectSession: leave(openRowByKey),
    selectBodyHit: leave(openBodyHitById),
    newSession: leave(act.newSession),
    selectDevice: (id) => { relay.selectDevice(id); act.openSession() },
    toggleDeviceMenu: (open) => setDeviceMenuOpen(open ?? !deviceMenuOpen),
    addDevice: () => act.openDialog({ id: PI_UI_IDS.pairing }),
    // 置顶 / 归档只记在这台浏览器里：放上去时给一条普通提示（不是警告），取消时不提示
    togglePin: (key) => {
      const pinning = !scopeState.pins.includes(key)
      localStore.togglePin(key)
      if (pinning) relay.pushNotice({ level: "info", title: PI_SIDEBAR_COPY.pinHint, dedupeKey: "sidebar.pin-local" })
    },
    toggleArchive: (key) => {
      const archiving = !scopeState.archives.includes(key)
      localStore.toggleArchive(key)
      if (archiving) relay.pushNotice({ level: "info", title: PI_SIDEBAR_COPY.archiveHint, dedupeKey: "sidebar.archive-local" })
    },
    // 按界面上的折叠态翻：待处理自动展开的组没存过值
    toggleGroup: (groupId) => localStore.toggleFolder(groupId, archiveView ? undefined : data.groups.find((g) => g.id === groupId && g.kind === "workspace")?.collapsed),
    toggleExpanded: (groupId) => act.toggleExpanded(groupId),
    openSearch: () => act.setSearch(ui.search ?? ""),
    closeSearch: () => act.setSearch(null),
    setSearchQuery: (query) => act.setSearch(query),
    openSettings: leave(act.openSettings),
    openInbox: leave(act.openInbox),
    openArchiveView: () => setArchiveView((open) => !open),
    resize: (width) => act.setPref("sidebarWidth", clampSidebarWidth(width)),
    toggleCollapse: drawer ? drawer.toggle : () => act.setPref("sidebarCollapsed", !ui.prefs.sidebarCollapsed),
    // 没有浏览历史：只在离开会话视图时给一个「返回」回到当前会话；不画做同一件事的前进键
    back: ui.view === "session" ? undefined : leave(() => act.openSession()),
  }
  const shortcuts = useMemo(() => {
    const platform = piPlatformOf(typeof navigator === "undefined" ? null : navigator)
    return {
      newSession: PI_SHORTCUT_KEYS["new-session"][platform],
      toggleSidebar: PI_SHORTCUT_KEYS["toggle-sidebar"][platform],
      settings: PI_SHORTCUT_KEYS.settings[platform],
    }
  }, [])
  return (
    <UnifiedSidebar
      data={data}
      actions={actions}
      view={{
        archiveView,
        inboxActive: ui.view === "inbox",
        rowMenu: isStatic ? undefined : (session) => <SessionRowMenu {...p} rowId={session.id} />,
        menuTargetId,
        shortcuts,
        displayOptions: <DisplayOptionsContainer {...p} />,
        displayOptionsOpen: isStatic && ui.menu?.id === PI_UI_IDS.displayOptions,
      }}
    />
  )
}
