import { useCallback, useEffect, useMemo, useState } from "react"
import { sessionStatusLineOf, sidebarDataOf } from "@/pi/model/sidebarSource"
import { sidebarGroups } from "@/pi/model/sidebarGroups"
import { sidebarSearchSessionsOf } from "@/pi/model/sidebarSearch"
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
  fullTimeLabel,
  relativeTimeLabel,
  sidebarDeviceRows,
  sidebarGroupsWithOverlay,
  sidebarIdentityNameOf,
  sidebarSessionKeyOf,
  sidebarStatusOf,
  storedTimeLabel,
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
  /** 归档视图：列表只剩本机归档的行，组全部展开（同桌面侧栏） */
  archiveView?: boolean
}

type GroupBuild = {
  key: string
  label: string
  deviceId: string
  cwd: string
  more?: number
  expanded?: boolean
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
  const scopeState = useMemo(() => sidebarScopeStateOf(local, scope), [local, scope])
  const persist = useCallback((next: PiSidebarLocalState) => {
    setLocal(next)
    try {
      window.localStorage.setItem(PI_SIDEBAR_LOCAL_STORAGE_KEY, serializeSidebarLocalState(next))
    } catch {
      // 存量/隐私模式失败：本会话内仍可用（不假装已持久化）
    }
  }, [])
  const archiveView = input.archiveView === true
  const { data, archivedCount } = useMemo(() => {
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
    const sortedDevices = sidebarDeviceRows(
      [...base.devices].map((device) => ({ id: device.id, name: device.name, online: device.online, platform: device.platform, current: device.id === relay.selectedDeviceId })),
      relay.selectedDeviceId ?? null,
    )
    // 搜索页按这份数据筛：开着时不截行，「更多 N」里收起的会话也搜得到（列表 / 抽屉这时被搜索页盖住）
    const uncapped = input.search?.open ? { maxRows: Number.POSITIVE_INFINITY } : {}
    const legacy = sidebarGroups(base.sessions, base.devices, base.attention, { grouping: p.ui.prefs.grouping, expanded: p.ui.expanded, ...uncapped })
    const sessionOf = new Map(base.sessions.map((session) => [session.id, session]))
    // 设计 D §2.2：一行实时状态（roomStatusLine）的输入面——房间事实按 id 索引、未读落定按 roomId 索引
    const roomById = new Map(relay.rooms.map((r) => [r.id, r]))
    const turnEndByRoom = new Map(relay.roomTurnEnds.map((t) => [t.roomId, t]))
    const groups: PiSidebarGroup[] = (legacy.groups as unknown as GroupBuild[]).map((group: GroupBuild) => {
      const cwd = group.cwd ?? ""
      const folderCollapsed = scopeState.folders[group.key] !== false
      const sessions: PiSidebarSession[] = group.rows.map((row) => {
        const listed = sessionOf.get(row.id)
        const dev = base.devices.find((d) => d.id === (row.deviceId ?? deviceId))
        const key = sidebarSessionKeyOf(row.deviceId ?? deviceId, row.id)
        // 状态行随本容器的 30 秒 tick（useNow）与名册广播一起重算（设计 D §2.2 不加新计时器）
        const status = sessionStatusLineOf({ room: roomById.get(row.id), session: listed, turnEnd: turnEndByRoom.get(row.id), now })
        return {
          key,
          id: row.id,
          title: row.title,
          status: markerStatus(row.marker),
          eventAt: row.at,
          // D-3: stored (not live) rows get date+time once past an hour;
          // live rows keep the relative label.
          timeLabel: row.trailingText ?? (listed && !listed.online ? storedTimeLabel(now, row.at) : relativeTimeLabel(now, row.at)),
          dateTimeLabel: fullTimeLabel(row.at),
          // 设计 D §2.4 第四层：两行制第二行承载状态全句（waiting/running/error/done/offline）；
          // 空闲态让位给原来的副标题（路径/设备），不拿"空闲"挤掉信息——状态优先只对有信息量的态生效；
          // 没有副标题时才写「空闲 · N 分钟前」，第二行不留空
          summary: status.tone === "idle" ? (row.subtitle || status.text) : status.text,
          statusLine: status.text,
          cwd: listed?.cwd ?? cwd,
          deviceName: dev?.name ?? "",
          selected: relay.roomId === row.id,
          pinned: scopeState.pins.includes(key),
          archived: scopeState.archives.includes(key),
          groupId: sidebarWorkspaceGroupId(cwd || listed?.cwd),
          enc: listed?.enc,
          encReason: listed?.encReason,
        }
      })
      return {
        id: group.key,
        kind: "workspace",
        label: group.label || sidebarWorkspaceLabel(cwd),
        cwd,
        collapsed: !archiveView && folderCollapsed,
        sessions,
        count: sessions.length,
        more: group.more,
        expanded: group.expanded,
      }
    })
    // 只数名册里还在的会话：已删掉的会话留在归档表里不算，免得入口写着有、点进去是空的
    const archivedCount = groups.reduce((count, group) => count + group.sessions.filter((session) => session.archived).length, 0)
    const overlaid = sidebarGroupsWithOverlay({ groups, pins: scopeState.pins, archives: scopeState.archives, archiveView, folders: scopeState.folders })
    const shownGroups = overlaid.filter((group) => group.sessions.length > 0 || group.kind === "pinned")
    const search = input.search ?? { open: false, query: "" }
    const data = {
      style: input.style,
      theme: input.theme,
      serverName: sidebarIdentityNameOf(relay.serverName, typeof location === "undefined" ? "" : location.host),
      serverUrl: undefined,
      online: relay.online,
      devices: sortedDevices.map((device: PiSidebarDevice) => ({ ...device, current: device.id === relay.selectedDeviceId })),
      selectedDeviceId: relay.selectedDeviceId ?? null,
      deviceMenuOpen: input.deviceMenuOpen,
      groups: shownGroups,
      // Pending-answer count (design D section 1): without it the drawer
      // never renders the inbox row on any phone shell.
      inboxCount: base.attention.filter((item) => item.kind === "waiting" || item.kind === "error" || item.kind === "done").length,
      localPages: input.localPages,
      newSessionLabel: "新会话",
      width: clampSidebarWidth(p.ui.prefs.sidebarWidth),
      collapsed: p.ui.prefs.sidebarCollapsed,
      // 搜索结果同桌面一份规则（sidebarSearchSessionsOf：searchSessions 命中、分组区顺序）
      search: search.open && search.query.trim() ? { ...search, results: sidebarSearchSessionsOf(shownGroups, search.query, (session) => sessionOf.get(session.id)?.firstMessage) } : search,
      now,
    } satisfies PiSidebarData
    return { data, archivedCount }
  }, [relay, p.ui.prefs, p.ui.expanded, input, scopeState, now, archiveView, deviceId])
  const togglePin = useCallback((key: string) => persist(toggleSidebarPin(local, scope, key)), [local, persist, scope])
  const toggleArchive = useCallback((key: string) => persist(toggleSidebarArchive(local, scope, key)), [local, persist, scope])
  const toggleGroup = useCallback((groupId: string) => {
    const current = sidebarScopeStateOf(local, scope)
    // 按界面上的折叠态翻（待处理自动展开的组没存过值）；归档视图里组总是展开，仍按存的值翻
    const shown = archiveView ? undefined : data.groups.find((group) => group.id === groupId && group.kind === "workspace")
    const next = setSidebarFolderCollapsed(local, scope, groupId, shown ? !shown.collapsed : !(current.folders[groupId] ?? true))
    persist(next)
  }, [archiveView, data.groups, local, persist, scope])
  /** 一次写多组（各写各的会互相覆盖，只剩最后一组生效） */
  const setGroupsCollapsed = useCallback((groupIds: readonly string[], collapsed: boolean) => {
    persist(groupIds.reduce((state, groupId) => setSidebarFolderCollapsed(state, scope, groupId, collapsed), local))
  }, [local, persist, scope])
  // 新会话常落在默认折叠的组里：当前会话所在的组没手动开合过就记成展开（同桌面 useSidebarLocalState.revealFolder），开合过的不动
  const revealFolder = useCallback((groupId: string) => {
    if (sidebarScopeStateOf(local, scope).folders[groupId] !== undefined) return
    persist(setSidebarFolderCollapsed(local, scope, groupId, false))
  }, [local, persist, scope])
  // Group row-cap expansion lives in the shared UI state (same key space as
  // the desktop shells: sidebarGroups group key), not in this local store.
  const toggleExpanded = useCallback((groupId: string) => p.act.toggleExpanded(groupId), [p.act])
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
  return {
    data,
    archivedCount,
    pins: scopeState.pins,
    archives: scopeState.archives,
    togglePin,
    toggleArchive,
    toggleGroup,
    setGroupsCollapsed,
    toggleExpanded,
    revealFolder,
    clearLocal,
  }
}
