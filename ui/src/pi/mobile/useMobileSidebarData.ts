import { useCallback, useEffect, useMemo, useState } from "react"
import { sidebarDataOf } from "@/pi/model/sidebarSource"
import { sidebarGroups } from "@/pi/model/sidebarGroups"
import type { VariantAppProps } from "@/pi/variants/types"
import {
  clearSidebarScope,
  emptySidebarLocalState,
  parseSidebarLocalState,
  PI_SIDEBAR_LOCAL_STORAGE_KEY,
  serializeSidebarLocalState,
  setSidebarFolderCollapsed,
  sidebarScopeStateOf,
  sidebarStorageScope,
  toggleSidebarArchive,
  toggleSidebarPin,
  clampSidebarWidth,
  type PiSidebarLocalState,
} from "../sidebar/storage.ts"
import {
  relativeTimeLabel,
  sidebarDeviceRows,
  sidebarGroupsWithOverlay,
  sidebarIdentityNameOf,
  sidebarSessionKeyOf,
  sidebarStatusOf,
  sidebarWorkspaceGroupId,
  sidebarWorkspaceLabel,
} from "../sidebar/model.ts"
import type {
  PiSidebarGroup,
  PiSidebarLocalPage,
  PiSidebarSession,
  PiSidebarStyle,
  PiSidebarTheme,
  PiSidebarSearchState,
} from "../sidebar/types.ts"
import type { PiSidebarData, PiSidebarDevice } from "../sidebar/types.ts"
import { useNow } from "@/pi/hooks/useNow"

export interface MobileSidebarDataInput {
  style: PiSidebarStyle
  theme: PiSidebarTheme
  search?: PiSidebarSearchState
  localPages?: PiSidebarLocalPage[]
  deviceMenuOpen?: boolean
}

type GroupBuild = {
  key: string
  label: string
  deviceId: string
  cwd: string
  rows: { id: string; title: string; marker: string; at?: number; deviceId?: string; subtitle?: string; trailingText?: string }[]
}

function markerStatus(marker: string) {
  return sidebarStatusOf({
    running: marker === "running",
    waiting: marker === "waiting",
    error: marker === "error",
  })
}

/**
 * B3 宿主适配：relay（VariantAppProps，纯读字段）→ arch PiSidebarData。
 * 数据行仍走既有 sidebarSource/sidebarGroups 纯函数（不另写数据层），pin/archive/文件夹折叠走 arch storage 本机状态。
 * 账号维度用 relay 服务器名（不是用户名）；scope = 服务器::设备，换设备/清缓存不同步，诚实提示由 action 弹。
 */
export function useMobileSidebarData(p: VariantAppProps, input: MobileSidebarDataInput) {
  const { relay } = p
  const now = useNow(30_000)
  const [local, setLocal] = useState<PiSidebarLocalState>(() => {
    if (typeof window === "undefined") return emptySidebarLocalState()
    try {
      return parseSidebarLocalState(window.localStorage.getItem(PI_SIDEBAR_LOCAL_STORAGE_KEY))
    } catch {
      return emptySidebarLocalState()
    }
  })
  const account = relay.serverName || "local"
  const deviceId = relay.selectedDeviceId ?? ""
  const scope = sidebarStorageScope(account, deviceId)
  const scopeState = sidebarScopeStateOf(local, scope)
  const persist = useCallback((next: PiSidebarLocalState) => {
    setLocal(next)
    try {
      window.localStorage.setItem(PI_SIDEBAR_LOCAL_STORAGE_KEY, serializeSidebarLocalState(next))
    } catch {
      // 存量/隐私模式失败：本会话内仍可用（不假装已持久化）
    }
  }, [])
  const data = useMemo(() => {
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
    const sortedDevices = sidebarDeviceRows(
      [...base.devices].map((device) => ({ id: device.id, name: device.name, online: device.online, platform: device.platform, current: device.id === relay.selectedDeviceId })),
      relay.selectedDeviceId ?? null,
    )
    const legacy = sidebarGroups(base.sessions, base.devices, base.attention, { grouping: p.ui.prefs.grouping, expanded: p.ui.expanded })
    const sessionOf = new Map(base.sessions.map((session) => [session.id, session]))
    const groups: PiSidebarGroup[] = (legacy.groups as unknown as GroupBuild[]).map((group: GroupBuild) => {
      const cwd = group.cwd ?? ""
      const folderCollapsed = scopeState.folders[group.key] !== false
      const sessions: PiSidebarSession[] = group.rows.map((row) => {
        const listed = sessionOf.get(row.id)
        const dev = base.devices.find((d) => d.id === (row.deviceId ?? deviceId))
        const key = sidebarSessionKeyOf(row.deviceId ?? deviceId, row.id)
        return {
          key,
          id: row.id,
          title: row.title,
          status: markerStatus(row.marker),
          eventAt: row.at,
          timeLabel: row.trailingText ?? relativeTimeLabel(now, row.at),
          summary: row.subtitle ?? "",
          cwd: listed?.cwd ?? cwd,
          deviceName: dev?.name ?? "",
          selected: relay.roomId === row.id,
          pinned: scopeState.pins.includes(key),
          archived: scopeState.archives.includes(key),
          groupId: sidebarWorkspaceGroupId(cwd || listed?.cwd),
        }
      })
      return {
        id: group.key,
        kind: "workspace",
        label: group.label || sidebarWorkspaceLabel(cwd),
        cwd,
        collapsed: folderCollapsed,
        sessions,
        count: sessions.length,
      }
    })
    const overlaid = sidebarGroupsWithOverlay({ groups, pins: scopeState.pins, archives: scopeState.archives })
    return {
      style: input.style,
      theme: input.theme,
      serverName: sidebarIdentityNameOf(relay.serverName, typeof location === "undefined" ? "" : location.host),
      serverUrl: undefined,
      online: relay.online,
      devices: sortedDevices.map((device: PiSidebarDevice) => ({ ...device, current: device.id === relay.selectedDeviceId })),
      selectedDeviceId: relay.selectedDeviceId ?? null,
      deviceMenuOpen: input.deviceMenuOpen,
      groups: overlaid.filter((group) => group.sessions.length > 0 || group.kind === "pinned"),
      localPages: input.localPages,
      newSessionLabel: "新会话",
      width: clampSidebarWidth(p.ui.prefs.sidebarWidth),
      collapsed: p.ui.prefs.sidebarCollapsed,
      search: input.search ?? { open: false, query: "" },
      now,
    } satisfies PiSidebarData
  }, [relay, p.ui.prefs, input, scopeState, now])
  const togglePin = useCallback((key: string) => persist(toggleSidebarPin(local, scope, key)), [local, persist, scope])
  const toggleArchive = useCallback((key: string) => persist(toggleSidebarArchive(local, scope, key)), [local, persist, scope])
  const toggleGroup = useCallback((groupId: string) => {
    const current = sidebarScopeStateOf(local, scope)
    const next = setSidebarFolderCollapsed(local, scope, groupId, !(current.folders[groupId] ?? true))
    persist(next)
  }, [local, persist, scope])
  const clearLocal = useCallback(() => persist(clearSidebarScope(local, scope)), [local, persist, scope])
  useEffect(() => {
    // 首次进入时把旧版本坏数据落成空（parse 已处理，这里只保证存储 key 存在）
    if (typeof window === "undefined") return
    try {
      if (window.localStorage.getItem(PI_SIDEBAR_LOCAL_STORAGE_KEY) == null) {
        window.localStorage.setItem(PI_SIDEBAR_LOCAL_STORAGE_KEY, serializeSidebarLocalState(emptySidebarLocalState()))
      }
    } catch {
      // 忽略
    }
  }, [])
  return { data, togglePin, toggleArchive, toggleGroup, clearLocal }
}
