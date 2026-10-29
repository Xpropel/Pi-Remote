import { useMemo, useState } from "react"
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
    for (const device of relay.devices) {
      const rooms = relay.rooms.filter((room) => room.deviceId === device.id)
      const roomIds = new Set(rooms.map((room) => room.id))
      const sessions: PiSidebarSession[] = rooms.map((room) => {
        const key = `${device.id}::${room.id}`
        const waiting = relay.roomId === room.id && (relay.dialogs?.length ?? 0) > 0
        return {
          key,
          id: room.id,
          title: room.name || room.label || room.firstMessage || room.id,
          status: statusOf(!!device.online, waiting, relay.roomId === room.id),
          timeLabel: relativeTimeLabel(now, typeof room.lastActivity === "number" ? room.lastActivity : (room as { updatedAt?: number }).updatedAt),
          cwd: room.cwd ?? "",
          repo: (room as { repo?: string }).repo,
          deviceName: device.name,
          selected: relay.roomId === room.id,
          pinned: scope.pins.includes(key),
          archived: scope.archives.includes(key),
          groupId: `ws:${device.id}:${room.cwd ?? ""}`,
          enc: room.enc,
        }
      })
      // listed sessions（未开房间的历史会话）
      const listed = (relay.sessionsByDevice[device.id] ?? []) as Array<{ id: string; title?: string; firstMessage?: string; cwd?: string; updatedAt?: number; repo?: string }>
      for (const session of listed) {
        if (roomIds.has(session.id) || !session.id) continue
        const key = `${device.id}::${session.id}`
        sessions.push({
          key,
          id: session.id,
          title: session.title || session.firstMessage || session.id,
          status: statusOf(!!device.online, false, false),
          timeLabel: relativeTimeLabel(now, session.updatedAt),
          cwd: session.cwd ?? "",
          repo: session.repo,
          deviceName: device.name,
          selected: false,
          pinned: scope.pins.includes(key),
          archived: scope.archives.includes(key),
          groupId: `ws:${device.id}:${session.cwd ?? ""}`,
        })
      }
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
    return {
      style: "claude",
      theme: document.documentElement.dataset.piTheme === "light" ? "light" : "dark",
      serverName: sidebarIdentityNameOf(relay.serverName as string | undefined, typeof window !== "undefined" ? window.location.hostname : undefined),
      online: !!relay.online,
      devices,
      selectedDeviceId: relay.selectedDeviceId ?? null,
      deviceMenuOpen,
      groups: sidebarGroupsWithOverlay({ groups, pins: scope.pins, archives: scope.archives, archiveView }),
      width,
      collapsed,
      search: { open: searchOpen, query: ui.search ?? "" },
    }
  }, [relay, scope, deviceMenuOpen, searchOpen, archiveView, width, collapsed, ui.search, now])

  const actions: PiSidebarActions = {
    selectSession: (key) => {
      const id = key.includes("::") ? key.split("::")[1] : key
      const room = relay.rooms.find((item) => item.id === id)
      if (room) relay.selectRoom(id)
      else relay.selectListedSession?.(id as never)
      act.openSession()
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
    setSearchQuery: (query) => act.setSearch?.(query),
    openSettings: act.openSettings,
    resize: (next) => act.setPref("sidebarWidth", next),
    toggleCollapse: () => act.setPref("sidebarCollapsed", !collapsed),
  }

  return (
    <div data-p4-surface="CL-CHAT-01" data-p4-ready="" className="claude-sidebar-host">
      <UnifiedSidebar data={data} actions={actions} />
    </div>
  )
}
