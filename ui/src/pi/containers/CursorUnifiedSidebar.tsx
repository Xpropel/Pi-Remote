/**
 * Cursor 宿主 → P11 统一侧栏适配（B2 收口；arch 联调落地）：
 * relay → PiSidebarData/Actions；宽度/折叠走 PiPrefs（272 / 220–360 / 56），pin/archive/文件夹折叠走 arch storage；
 * 视觉由 UnifiedSidebar 按 style="cursor" × data-pi-theme 的六套 --sb-* 渲染。旧 PiSidebar 仅保留给手机列表/静态态。
 */
import { useMemo, useState } from "react"
import {
  clampSidebarWidth,
  PI_SIDEBAR_COPY,
  relativeTimeLabel,
  sidebarDeviceRows,
  sidebarGroupsWithOverlay,
  sidebarIdentityNameOf,
  sidebarSessionKeyOf,
  sidebarStatusOf,
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
import { sidebarDataOf, openSessionRow } from "@/pi/model/sidebarSource"
import { sidebarGroups } from "@/pi/model/sidebarGroups"
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
      selectedDevice: relay.selectedDevice,
    })
    const devices: PiSidebarDevice[] = sidebarDeviceRows(
      base.devices.map((d) => ({ id: d.id, name: d.name, online: d.online, platform: d.platform, current: d.id === relay.selectedDeviceId })),
      relay.selectedDeviceId ?? null,
    )
    const sessionIds = new Map(base.sessions.map((s) => [s.id, s]))
    const legacy = sidebarGroups(base.sessions, base.devices, base.attention, { grouping: ui.prefs.grouping, expanded: ui.expanded })
    const groups: PiSidebarGroup[] = legacy.groups.map((group) => {
      const cwd = group.cwd ?? ""
      const collapsed = scopeState.folders[group.key] !== false
      const sessions: PiSidebarSession[] = group.rows.map((row) => {
        const session = sessionIds.get(row.id)
        const devId = row.deviceId ?? deviceId
        const key = sidebarSessionKeyOf(devId, row.id)
        return {
          key, id: row.id, title: row.title,
          status: sidebarStatusOf({ running: row.marker === "running", waiting: row.marker === "waiting", error: row.marker === "error" }),
          eventAt: row.at,
          timeLabel: row.trailingText ?? relativeTimeLabel(now, row.at),
          summary: row.subtitle ?? "",
          cwd: session?.cwd ?? cwd,
          deviceName: base.devices.find((d) => d.id === devId)?.name ?? "",
          selected: relay.roomId === row.id,
          pinned: scopeState.pins.includes(key),
          archived: scopeState.archives.includes(key),
          groupId: sidebarWorkspaceGroupId(cwd || session?.cwd),
        }
      })
      return { id: group.key, kind: "workspace" as const, label: group.label || sidebarWorkspaceLabel(cwd), cwd, collapsed, sessions, count: sessions.length }
    })
    const overlaid = sidebarGroupsWithOverlay({ groups, pins: scopeState.pins, archives: scopeState.archives })
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
      search: { open: ui.search != null, query: ui.search ?? "" },
      now,
    }
  }, [relay, ui.prefs.grouping, ui.prefs.sidebarWidth, ui.prefs.sidebarCollapsed, ui.expanded, ui.search, scopeState, now, deviceMenuOpen, account, deviceId])

  const openRowByKey = (key: string) => {
    const id = key.includes("::") ? key.split("::").slice(1).join("::") : key
    const base = sidebarDataOf({
      devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, roomId: relay.roomId,
      dialogs: relay.dialogs, uiPrompt: relay.uiPrompt, turnEnd: relay.turnEnd, roomTurnEnds: relay.roomTurnEnds, selectedDevice: relay.selectedDevice,
    })
    const session = base.sessions.find((s) => s.id === id)
    if (session) openSessionRow(relay, session, act.openSession)
  }

  const actions: PiSidebarActions = {
    selectSession: openRowByKey,
    newSession: act.newSession,
    selectDevice: (id) => { relay.selectDevice(id); act.openSession() },
    toggleDeviceMenu: (open) => setDeviceMenuOpen(open ?? !deviceMenuOpen),
    addDevice: () => act.openDialog({ id: PI_UI_IDS.pairing }),
    togglePin: (key) => { localStore.togglePin(key); relay.notify(PI_SIDEBAR_COPY.pinHint) },
    toggleArchive: (key) => { localStore.toggleArchive(key); relay.notify(PI_SIDEBAR_COPY.archiveHint) },
    toggleGroup: (groupId) => localStore.toggleFolder(groupId),
    openSearch: () => act.setSearch(ui.search ?? ""),
    closeSearch: () => act.setSearch(null),
    setSearchQuery: (query) => act.setSearch(query),
    openSettings: act.openSettings,
    resize: (width) => act.setPref("sidebarWidth", clampSidebarWidth(width)),
    toggleCollapse: () => act.setPref("sidebarCollapsed", !ui.prefs.sidebarCollapsed),
    back: () => act.openSession(),
    forward: () => act.openSession(),
  }
  return <UnifiedSidebar data={data} actions={actions} />
}
