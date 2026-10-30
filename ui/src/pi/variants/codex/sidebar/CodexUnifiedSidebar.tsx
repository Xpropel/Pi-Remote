/**
 * Codex 宿主 → P11 统一侧栏适配（B2 收口；arch 联调落地）：
 * - 数据：relay → PiSidebarData；扩展位 localPages（扩展/代码审查/计划任务/技能/连接）+ RunLocation 走 slots；
 * - 宽度/折叠走 PiPrefs（272 / 220–360 / 56），pin/archive/文件夹折叠走 arch storage（account::device）；
 * - 视觉由 UnifiedSidebar 按 style="codex" × data-pi-theme 六套 --sb-* 渲染；旧 CodexSidebar 不再由 shell 引用。
 */
import { useMemo, useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { useNow } from "@/pi/hooks/useNow"
import { sidebarDataOf } from "@/pi/model/sidebarSource"
import { sidebarGroups } from "@/pi/model/sidebarGroups"
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
  type PiSidebarLocalPage,
  type PiSidebarSession,
} from "@/pi/sidebar"
import { CodexRunLocation, type CodexRunLocationValue } from "./CodexRunLocation"
import type { CodexLocalPage, CodexSidebarActions } from "./types"

const TICK_MS = 30_000

const LOCAL_PAGES: { id: CodexLocalPage; label: string }[] = [
  { id: "plugins", label: "扩展" },
  { id: "prs", label: "代码审查" },
  { id: "automations", label: "计划任务" },
  { id: "skills", label: "技能" },
  { id: "connectors", label: "连接" },
]

function themeOf(): "dark" | "light" {
  return typeof document !== "undefined" && document.documentElement.dataset.piTheme === "light" ? "light" : "dark"
}

export function CodexUnifiedSidebar({ p, actions: codexActions, localPage }: { p: VariantAppProps; actions: CodexSidebarActions; localPage: CodexLocalPage | null }) {
  const { relay, ui, act } = p
  const now = useNow(TICK_MS)
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [runLocation, setRunLocation] = useState<CodexRunLocationValue>({ mode: "local", deviceId: null, folder: null })
  const account = relay.serverName || "local"
  const deviceId = relay.selectedDeviceId ?? ""
  const localStore = useSidebarLocalState(account, deviceId)
  const scopeState = localStore.scopeState

  const data = useMemo<PiSidebarData>(() => {
    const base = sidebarDataOf({
      devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, roomId: relay.roomId,
      dialogs: relay.dialogs, uiPrompt: relay.uiPrompt, turnEnd: relay.turnEnd, roomTurnEnds: relay.roomTurnEnds, inbox: relay.inbox, selectedDevice: relay.selectedDevice,
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
          enc: session?.enc,
          encReason: session?.encReason,
        }
      })
      return { id: group.key, kind: "workspace" as const, label: group.label || sidebarWorkspaceLabel(cwd), cwd, collapsed, sessions, count: sessions.length }
    })
    const overlaid = sidebarGroupsWithOverlay({ groups, pins: scopeState.pins, archives: scopeState.archives })
    const localPages: PiSidebarLocalPage[] = LOCAL_PAGES.map((page) => ({ id: page.id, label: page.label, active: localPage === page.id }))
    return {
      style: "codex", theme: themeOf(),
      serverName: sidebarIdentityNameOf(relay.serverName, typeof location === "undefined" ? "" : location.hostname),
      online: relay.online,
      devices,
      selectedDeviceId: relay.selectedDeviceId ?? null,
      deviceMenuOpen,
      groups: overlaid.filter((g) => g.sessions.length > 0 || g.kind === "pinned"),
      localPages,
      // Pending-answer count (design D section 1): attention waiting +
      // error + done, the same single counting exit as the other shells.
      // Without it the shared sidebar never renders the inbox row here.
      inboxCount: base.attention.filter((item) => item.kind === "waiting" || item.kind === "error" || item.kind === "done").length,
      newSessionLabel: "新会话",
      width: clampSidebarWidth(ui.prefs.sidebarWidth),
      collapsed: ui.prefs.sidebarCollapsed,
      search: { open: ui.search != null, query: ui.search ?? "" },
      now,
    }
  }, [relay, ui.prefs.grouping, ui.prefs.sidebarWidth, ui.prefs.sidebarCollapsed, ui.expanded, ui.search, scopeState, now, deviceMenuOpen, account, deviceId, localPage])

  const actions: PiSidebarActions = {
    selectSession: (key) => {
      const id = key.includes("::") ? key.split("::").slice(1).join("::") : key
      const device = key.includes("::") ? key.split("::")[0] : relay.selectedDeviceId
      if (device) codexActions.onOpenSession(id, device)
      else codexActions.onOpenSession(id, "")
    },
    newSession: () => codexActions.onNewSession(),
    selectDevice: (id) => { relay.selectDevice(id); act.openSession() },
    toggleDeviceMenu: (open) => setDeviceMenuOpen(open ?? !deviceMenuOpen),
    addDevice: () => codexActions.onOpenPairing(),
    togglePin: (key) => { localStore.togglePin(key); relay.notify(PI_SIDEBAR_COPY.pinHint) },
    toggleArchive: (key) => { localStore.toggleArchive(key); relay.notify(PI_SIDEBAR_COPY.archiveHint) },
    toggleGroup: (groupId) => localStore.toggleFolder(groupId),
    openSearch: () => codexActions.onSearch(),
    closeSearch: () => act.setSearch(null),
    setSearchQuery: (query) => act.setSearch(query),
    openSettings: () => codexActions.onOpenSettings(),
    openInbox: act.openInbox,
    resize: (width) => act.setPref("sidebarWidth", clampSidebarWidth(width)),
    toggleCollapse: () => act.setPref("sidebarCollapsed", !ui.prefs.sidebarCollapsed),
    selectLocalPage: (id) => codexActions.onOpenLocalPage(id as CodexLocalPage),
    back: () => act.openSession(),
    forward: () => act.openSession(),
  }
  const slots = {
    beforeGroups: <CodexRunLocation p={p} value={runLocation} onChange={setRunLocation} onPair={() => codexActions.onOpenPairing()} compact surface="CX-SIDE-02" />,
  }
  return <UnifiedSidebar data={data} actions={actions} slots={slots} />
}
