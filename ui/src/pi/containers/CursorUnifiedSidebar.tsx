/**
 * Cursor 宿主 → P11 统一侧栏适配（B2 收口；arch 联调落地）：
 * relay → PiSidebarData/Actions；宽度/折叠走 PiPrefs（272 / 220–360 / 56），pin/archive/文件夹折叠走 arch storage；
 * 视觉由 UnifiedSidebar 按 style="cursor" × data-pi-theme 的六套 --sb-* 渲染。旧 PiSidebar 仅保留给手机列表/静态态。
 */
import { useMemo, useState } from "react"
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
import { paletteBodyHitsOf } from "@/pi/model/palette"
import { sessionStatusLineOf, sidebarDataOf, openSessionRow } from "@/pi/model/sidebarSource"
import { sidebarGroups } from "@/pi/model/sidebarGroups"
import { searchSessions } from "@/shell/searchModel"
import { PI_UI_IDS, type PiContainerProps } from "./types"

const TICK_MS = 30_000

function themeOf(): "dark" | "light" {
  return typeof document !== "undefined" && document.documentElement.dataset.piTheme === "light" ? "light" : "dark"
}

export function CursorUnifiedSidebar({ p }: { p: PiContainerProps }) {
  const { relay, ui, act } = p
  const now = useNow(TICK_MS)
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
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
    const legacy = sidebarGroups(base.sessions, base.devices, base.attention, { grouping: ui.prefs.grouping, expanded: ui.expanded })
    const groups: PiSidebarGroup[] = legacy.groups.map((group) => {
      const cwd = group.cwd ?? ""
      const collapsed = scopeState.folders[group.key] !== false
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
    const overlaid = sidebarGroupsWithOverlay({ groups, pins: scopeState.pins, archives: scopeState.archives })
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
      style: "cursor", theme: themeOf(),
      serverName: sidebarIdentityNameOf(relay.serverName, typeof location === "undefined" ? "" : location.hostname),
      online: relay.online,
      devices,
      selectedDeviceId: relay.selectedDeviceId ?? null,
      deviceMenuOpen,
      groups: overlaid.filter((g) => g.sessions.length > 0 || g.kind === "pinned"),
      newSessionLabel: "新会话",
      width: clampSidebarWidth(ui.prefs.sidebarWidth),
      collapsed: ui.prefs.sidebarCollapsed,
      search: { open: ui.search != null, query: ui.search ?? "", body: bodyBlock },
      // 待答角标（设计 D §1）：只数 attention 清单里的 waiting+error+done——与账本 pending
      // 数恒等，计数唯一出口仍是 attentionItemsOf，设备掉线条不入此数。
      inboxCount: base.attention.filter((item) => item.kind === "waiting" || item.kind === "error" || item.kind === "done").length,
      now,
    }
  }, [relay, ui.prefs.grouping, ui.prefs.sidebarWidth, ui.prefs.sidebarCollapsed, ui.expanded, ui.search, scopeState, now, deviceMenuOpen, account, deviceId, bodySearch])

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

  const actions: PiSidebarActions = {
    selectSession: openRowByKey,
    selectBodyHit: openBodyHitById,
    newSession: act.newSession,
    selectDevice: (id) => { relay.selectDevice(id); act.openSession() },
    toggleDeviceMenu: (open) => setDeviceMenuOpen(open ?? !deviceMenuOpen),
    addDevice: () => act.openDialog({ id: PI_UI_IDS.pairing }),
    togglePin: (key) => { localStore.togglePin(key); relay.notify(PI_SIDEBAR_COPY.pinHint) },
    toggleArchive: (key) => { localStore.toggleArchive(key); relay.notify(PI_SIDEBAR_COPY.archiveHint) },
    toggleGroup: (groupId) => localStore.toggleFolder(groupId),
    toggleExpanded: (groupId) => act.toggleExpanded(groupId),
    openSearch: () => act.setSearch(ui.search ?? ""),
    closeSearch: () => act.setSearch(null),
    setSearchQuery: (query) => act.setSearch(query),
    openSettings: act.openSettings,
    openInbox: act.openInbox,
    resize: (width) => act.setPref("sidebarWidth", clampSidebarWidth(width)),
    toggleCollapse: () => act.setPref("sidebarCollapsed", !ui.prefs.sidebarCollapsed),
    back: () => act.openSession(),
    forward: () => act.openSession(),
  }
  return <UnifiedSidebar data={data} actions={actions} />
}
