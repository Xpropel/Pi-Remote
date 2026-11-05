import { useMemo, useState } from "react"
import { attentionItemsOf } from "@/relay/attention"
import { bodyHitOf, openBodySearchHit, sidebarBodyBlockOf, useBodySearch } from "@/pi/hooks/useBodySearch"
import { paletteMatches } from "@/pi/model/composerInput"
import { openSessionRow, sidebarRowForKey, sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { useNow } from "../primitives/useClaude"
import { CLAUDE_OVERLAY } from "../overlays/ids"
import type { PiContainerProps } from "@/pi/containers/types"
import { UnifiedSidebar } from "@/pi/sidebar/UnifiedSidebar"
import {
  PI_SIDEBAR_COPY,
  relativeTimeLabel,
  sidebarGroupsWithOverlay,
  sidebarIdentityNameOf,
  type PiSidebarActions,
  type PiSidebarData,
  type PiSidebarDevice,
  type PiSidebarGroup,
  type PiSidebarPlainRow,
  type PiSidebarSession,
  type PiSidebarStatus,
  useSidebarLocalState,
  clampSidebarWidth,
} from "@/pi/sidebar"

/**
 * Claude 宿主 → P11 统一侧栏适配（B1）：
 * - 数据：relay devices/rooms/sessionsByDevice/attention/时间标签/serverName，经 model 纯函数整理；
 * - 本机状态：pin/archive/分组折叠走 arch storage（account::device 隔离）+ 诚实提示；
 * - 宽度/折叠走 PiPrefs（sidebarWidth 220–360 clamp / sidebarCollapsed），设备本地持久化；
 * - 视觉由共享核按 `style=claude × data-pi-theme` 消费 tokens.css 六套 `--sb-*`。
 */

const statusOf = (online: boolean, waiting: boolean, active: boolean): PiSidebarStatus => {
  const tone = !online ? "idle" : waiting ? "waiting" : active ? "running" : "idle"
  return { tone, showChip: tone === "running", label: tone }
}

const workspaceLabel = (cwd: string): string => {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? "未分组"
}

export function ClaudeUnifiedSidebar({ p }: { p: PiContainerProps }) {
  const { relay, act, ui } = p
  const account = relay.serverName || "local"
  const deviceId = relay.selectedDeviceId ?? ""
  const localStore = useSidebarLocalState(account, deviceId)
  const scope = localStore.scopeState
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [archiveView, setArchiveView] = useState(false)
  const now = useNow(30_000)
  // Body search (A-3): while the search overlay is open, search the
  // selected device's session bodies; the block lands in data.search.body
  // and the shared overlay renders it under the local title results.
  // (Round 1 wired only the Cursor sidebar; this container built its
  // search data without a body field, so body hits never showed here.)
  const bodySearch = useBodySearch(relay, ui.search ?? "", searchOpen)
  const width = clampSidebarWidth(ui.prefs.sidebarWidth)
  const collapsed = ui.prefs.sidebarCollapsed ?? false
  const notify = (text: string) => {
    const target = relay as unknown as { notify?: (message: string, tone?: string) => void }
    target.notify?.(text, "warn")
  }

  const data = useMemo<PiSidebarData>(() => {
    const devices: PiSidebarDevice[] = relay.devices.map((device) => ({
      id: device.id,
      name: device.name,
      online: !!device.online,
      platform: device.platform,
      current: device.id === relay.selectedDeviceId,
    }))
    const groups: PiSidebarGroup[] = []
    // Rows come from the shared merge (mergeDeviceSessions via
    // sidebarSessionsOf), exactly like the Cursor/Codex shells: a live
    // room absorbs its stored-session entry (one session = one row, the
    // live row wins; the entry alone carries the row while the room is
    // offline), and every title arrives pre-resolved with the shared
    // fallback chain (name -> cleaned first message -> workspace label),
    // so an undecryptable title can never surface as a raw session id.
    const merged = sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice)
    for (const device of relay.devices) {
      const sessions: PiSidebarSession[] = merged
        .filter((row) => row.deviceId === device.id)
        .map((row) => {
          const key = `${device.id}::${row.id}`
          const waiting = relay.roomId === row.id && (relay.dialogs?.length ?? 0) > 0
          return {
            key,
            id: row.id,
            title: row.title,
            status: statusOf(!!device.online, waiting, relay.roomId === row.id && row.openable),
            timeLabel: relativeTimeLabel(now, row.updatedAt),
            cwd: row.cwd ?? "",
            deviceName: device.name,
            selected: relay.roomId === row.id,
            pinned: scope.pins.includes(key),
            archived: scope.archives.includes(key),
            groupId: `ws:${device.id}:${row.cwd ?? ""}`,
            enc: row.enc,
            encReason: row.encReason,
          }
        })
      const byCwd = new Map<string, PiSidebarSession[]>()
      for (const session of sessions) {
        const list = byCwd.get(session.groupId) ?? []
        list.push(session)
        byCwd.set(session.groupId, list)
      }
      for (const [groupId, list] of byCwd) {
        groups.push({
          id: groupId,
          kind: "workspace",
          label: workspaceLabel(list[0]?.cwd ?? ""),
          cwd: list[0]?.cwd,
          collapsed: scope.folders[groupId] !== false,
          sessions: list,
          count: list.length,
        })
      }
    }
    // Pending-answer count (design D section 1): the same single counting
    // exit as the other shells -- attention items of kind waiting / error /
    // done. Without it the shared sidebar never renders the inbox row here.
    const inboxCount = attentionItemsOf({
      currentRoomId: relay.roomId,
      rooms: relay.rooms,
      dialogs: relay.dialogs,
      uiPrompt: relay.uiPrompt,
      turnEnd: relay.turnEnd,
      roomTurnEnds: relay.roomTurnEnds,
      inbox: relay.inbox,
      selectedDevice: relay.selectedDevice,
    }).filter((item) => item.kind === "waiting" || item.kind === "error" || item.kind === "done").length
    // Body-match block (A-3): sessions the local title match already
    // lists are excluded, so a session never appears twice.
    const bodyBlock = sidebarBodyBlockOf(
      bodySearch,
      merged.filter((s) => paletteMatches(ui.search ?? "", s.title, s.cwd, s.firstMessage)).map((s) => ({ id: s.id, path: s.path })),
    )
    return {
      style: "claude",
      theme: document.documentElement.dataset.piTheme === "light" ? "light" : "dark",
      serverName: sidebarIdentityNameOf(relay.serverName as string | undefined, typeof window !== "undefined" ? window.location.hostname : undefined),
      online: !!relay.online,
      devices,
      selectedDeviceId: relay.selectedDeviceId ?? null,
      deviceMenuOpen,
      groups: sidebarGroupsWithOverlay({ groups, pins: scope.pins, archives: scope.archives, archiveView }),
      inboxCount,
      width,
      collapsed,
      search: { open: searchOpen, query: ui.search ?? "", body: bodyBlock },
    }
  }, [relay, scope, deviceMenuOpen, searchOpen, archiveView, width, collapsed, ui.search, now, bodySearch])

  const actions: PiSidebarActions = {
    selectSession: (key) => {
      // Resolve the merged row first: selectListedSession requires the
      // listed-session row object. Passing the bare id string made its
      // already-selected guard read .deviceId off a null lazy selection
      // (both sides of the ?. comparison were undefined), throwing a
      // TypeError on every listed-session click -- most visibly on
      // sessions left behind by a superseded device registration.
      const row = sidebarRowForKey(relay.devices, relay.rooms, relay.sessionsByDevice, key)
      if (row) openSessionRow(relay, row, act.openSession)
      else act.openSession()
    },
    newSession: () => act.newSession(),
    selectDevice: (deviceId) => {
      relay.selectDevice?.(deviceId)
      act.openSession()
    },
    toggleDeviceMenu: (open) => setDeviceMenuOpen(open ?? !deviceMenuOpen),
    addDevice: () => act.openDialog({ id: CLAUDE_OVERLAY.pairing }),
    back: () => act.openSession(),
    forward: () => act.openSession(),
    togglePin: (key) => {
      localStore.togglePin(key)
      notify(PI_SIDEBAR_COPY.pinHint)
    },
    toggleArchive: (key) => {
      localStore.toggleArchive(key)
      notify(PI_SIDEBAR_COPY.archiveHint)
    },
    toggleGroup: (groupId) => localStore.toggleFolder(groupId),
    togglePlainRow: (row: PiSidebarPlainRow) => {
      if (row === "archive") setArchiveView((value) => !value)
    },
    openSearch: () => setSearchOpen(true),
    closeSearch: () => setSearchOpen(false),
    selectBodyHit: (hitId) => {
      const mergedRows = sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice)
      const hit = bodyHitOf(
        bodySearch,
        mergedRows.filter((s) => paletteMatches(ui.search ?? "", s.title, s.cwd, s.firstMessage)).map((s) => ({ id: s.id, path: s.path })),
        hitId,
      )
      if (hit) openBodySearchHit(relay, hit, act.openSession)
    },
    setSearchQuery: (query) => act.setSearch?.(query),
    openSettings: act.openSettings,
    openInbox: act.openInbox,
    resize: (next) => act.setPref("sidebarWidth", next),
    toggleCollapse: () => act.setPref("sidebarCollapsed", !collapsed),
  }

  return (
    <div data-p4-surface="CL-CHAT-01" data-p4-ready="" className="claude-sidebar-host">
      <UnifiedSidebar data={data} actions={actions} />
    </div>
  )
}
