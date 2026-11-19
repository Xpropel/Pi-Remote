/**
 * Cursor 宿主 → P11 统一侧栏适配（B2 收口；arch 联调落地）：
 * relay → PiSidebarData/Actions；宽度/折叠走 PiPrefs（272 / 220–360 / 56），pin/archive/文件夹折叠走 arch storage；
 * 视觉由 UnifiedSidebar 按 style="cursor" × data-pi-theme 的六套 --sb-* 渲染。旧 PiSidebar 仅保留给手机列表/静态态。
 */
import { useEffect, useMemo, useState } from "react"
import { MenuItem, MenuSeparator, MenuSurface } from "@/components/kit"
import { piCopyText } from "@/components/pi/conversation/clipboard"
import { PiButton, PiDialog, PiMenu, usePiMenuSurface, usePiStatic } from "@/components/pi/shared"
import type { PiTheme } from "@/components/pi/shared/viewport"
import {
  clampSidebarWidth,
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
  UnifiedSidebar,
  useSidebarLocalState,
  type PiSidebarActions,
  type PiSidebarData,
  type PiSidebarDevice,
  type PiSidebarGroup,
  type PiSidebarSession,
} from "@/pi/sidebar"
import { MoreVerticalIcon } from "@/pi/sidebar/components/icons"
import { presetNewSession, resetNewSessionSelection, syncActiveRelayRoom } from "./NewSessionContainer"
import { useNow } from "@/pi/hooks/useNow"
import { usePiSettingsPrefs } from "@/pi/hooks/usePiSettingsPrefs"
import { bodySearchNoteOf, openBodySearchHit, useBodySearch } from "@/pi/hooks/useBodySearch"
import type { SidebarDrawerControl } from "@/pi/hooks/useSidebarDrawer"
import { paletteBodyHitsOf } from "@/pi/model/palette"
import { effectiveSidebarArchivesOf, filterSessionsByRetention } from "@/pi/model/settingsHost"
import { sessionStatusLineOf, sidebarDataOf, openSessionRow } from "@/pi/model/sidebarSource"
import { sidebarGroups } from "@/pi/model/sidebarGroups"
import { PI_SHORTCUT_KEYS, piPlatformOf } from "@/pi/model/shortcuts"
import { searchSessions } from "@/shell/searchModel"
import { DisplayOptionsContainer } from "./DisplayOptionsContainer"
import { A_SESSION_MENU, SessionRowMenu } from "./SessionMenuContainer"
import { PI_UI_IDS, type PiContainerProps } from "./types"

const TICK_MS = 30_000
const RENAME_FIELD_CLASS =
  "h-(--cw-pi-field-h) w-full min-w-0 rounded-(--cw-radius-input) border border-solid border-(--cw-border-strong) bg-(--cw-surface) px-2.5 text-(length:--cw-text-md) text-(--cw-text) outline-none focus-visible:border-(--cw-pi-field-focus-border)"

function WorkspaceMenuSurface({
  group,
  onNewSession,
  onRename,
  onResetName,
  onCopyCwd,
}: {
  group: PiSidebarGroup
  onNewSession: (group: PiSidebarGroup) => void
  onRename: (group: PiSidebarGroup) => void
  onResetName: (group: PiSidebarGroup) => void
  onCopyCwd: (group: PiSidebarGroup) => void
}) {
  const surface = usePiMenuSurface()
  return (
    <MenuSurface {...surface} aria-label={`${group.label} 工作区操作`} elevation="menu" className="w-[184px]">
      <MenuItem onSelect={() => onNewSession(group)}>在此目录新建会话</MenuItem>
      <MenuItem onSelect={() => onRename(group)}>重命名工作区…</MenuItem>
      {group.customLabel ? <MenuItem onSelect={() => onResetName(group)}>恢复默认名称</MenuItem> : null}
      {group.cwd ? (
        <>
          <MenuSeparator />
          <MenuItem onSelect={() => onCopyCwd(group)}>复制目录路径</MenuItem>
        </>
      ) : null}
    </MenuSurface>
  )
}

/** 宿主没传主题时的兜底：读 <html data-pi-theme>（根节点在 layout effect 里才写，所以优先用宿主传下来的值） */
function themeOf(): "dark" | "light" {
  return typeof document !== "undefined" && document.documentElement.dataset.piTheme === "light" ? "light" : "dark"
}

function formatShortcutLabel(keys: readonly string[] | undefined, fallback: string): string {
  if (!keys || keys.length === 0) return fallback
  let out = ""
  for (const raw of keys) {
    const token = raw.trim()
    if (!token) continue
    if (!out) {
      out = token
    } else {
      const prevWord = /[A-Za-z0-9]$/.test(out)
      const nextWord = token.length > 1
      out += prevWord || nextWord ? `+${token}` : token
    }
  }
  return out || fallback
}

export function CursorUnifiedSidebar({ p, theme, drawer }: { p: PiContainerProps; theme?: PiTheme; drawer?: SidebarDrawerControl }) {
  const { relay, ui, act } = p
  // 平板档：窄栏 / 展开只跟浮层走（drawer），桌面偏好 sidebarCollapsed 不读不写
  const collapsed = drawer ? !drawer.open : ui.prefs.sidebarCollapsed
  const now = useNow(TICK_MS)
  const isStatic = usePiStatic()
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false)
  const [renameGroup, setRenameGroup] = useState<PiSidebarGroup | null>(null)
  const [renameDraft, setRenameDraft] = useState("")
  // 归档视图只是侧栏自己的列表切换（本机归档），不进路由
  const [archiveView, setArchiveView] = useState(false)
  // 静态态（#/live 对图）摆出来的会话菜单作用在哪一行：那一行所在的组要展开，行作为菜单锚点
  const menuTargetId = isStatic && ui.menu?.id === A_SESSION_MENU ? ui.menu.arg : undefined
  const resolvedTheme = theme ?? themeOf()
  const account = relay.serverName || "local"
  const deviceId = relay.selectedDeviceId ?? ""
  const localStore = useSidebarLocalState(account, deviceId)
  const scopeState = localStore.scopeState
  const settingsPrefs = usePiSettingsPrefs()
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
    const sessions = filterSessionsByRetention(base.sessions, settingsPrefs.retention, now, relay.roomId)
    const effectiveArchives = effectiveSidebarArchivesOf({
      manualArchives: scopeState.archives,
      autoArchive: settingsPrefs.autoArchive,
      now,
      sessions: sessions
        .filter((s) => !relay.selectedDeviceId || !s.deviceId || s.deviceId === relay.selectedDeviceId)
        .map((s) => ({
          key: sidebarSessionKeyOf(s.deviceId ?? deviceId, s.id),
          updatedAt: s.updatedAt,
          active: s.id === relay.roomId,
          online: s.online,
        })),
      pins: scopeState.pins,
    })
    const effectiveArchiveSet = new Set(effectiveArchives)
    const devices: PiSidebarDevice[] = sidebarDeviceRows(
      base.devices.map((d) => ({ id: d.id, name: d.name, online: d.online, platform: d.platform, current: d.id === relay.selectedDeviceId })),
      relay.selectedDeviceId ?? null,
    )
    const sessionIds = new Map(sessions.map((s) => [s.id, s]))
    // 设计 D §2.2：一行实时状态（roomStatusLine）的输入面——房间事实按 id 索引、未读落定按 roomId 索引
    const roomById = new Map(relay.rooms.map((r) => [r.id, r]))
    const turnEndByRoom = new Map(relay.roomTurnEnds.map((t) => [t.roomId, t]))
    // 搜索时不截行：收在「更多 N」里的会话也要能被搜到
    const uncapped = ui.search != null ? { maxRows: Number.POSITIVE_INFINITY } : {}
    // The sidebar belongs to the selected device: only its folders are
    // listed, and group headers drop the device-name prefix (the device
    // is already named at the top of the sidebar). No selection yet ->
    // no filter, so every device shows until one is picked.
    const legacy = sidebarGroups(sessions, base.devices, base.attention, { grouping: ui.prefs.grouping, expanded: ui.expanded, filter: relay.selectedDeviceId ?? null, ...uncapped })
    const groups: PiSidebarGroup[] = legacy.groups.map((group) => {
      const cwd = group.cwd ?? ""
      const isFlat = group.flat === true
      const defaultLabel = isFlat ? "" : group.label || sidebarWorkspaceLabel(cwd)
      const customName = !isFlat ? localStore.workspaceName(group.key) : undefined
      // 归档视图里组全部展开（归档列表通常很短）；静态菜单的目标行所在组也展开
      const collapsed = !isFlat && !archiveView && scopeState.folders[group.key] !== false && !group.rows.some((row) => row.id === menuTargetId)
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
          archived: effectiveArchiveSet.has(key),
          groupId: sidebarWorkspaceGroupId(cwd || session?.cwd),
          enc: session?.enc,
          encReason: session?.encReason,
        }
      })
      return {
        id: group.key,
        kind: isFlat ? ("flat" as const) : ("workspace" as const),
        label: isFlat ? "" : (customName || defaultLabel),
        defaultLabel: isFlat ? undefined : defaultLabel,
        customLabel: Boolean(customName),
        deviceId: group.deviceId || relay.selectedDeviceId || undefined,
        cwd,
        collapsed,
        sessions,
        count: sessions.length,
        more: group.more,
        expanded: group.expanded,
      }
    })
    const overlaid = sidebarGroupsWithOverlay({ groups, pins: scopeState.pins, archives: effectiveArchives, archiveView, folders: scopeState.folders })
    // 正文匹配块（A-3）：标题已命中的会话不重复列；状态行照 searchModel 诚实文案
    const bodyBlock = ((): PiSidebarData["search"]["body"] => {
      const { state, deviceId: bodyDeviceId, deviceName } = bodySearch
      if (state.phase === "idle" || bodyDeviceId == null) return undefined
      if (state.phase === "searching") {
        return { deviceName, phase: "searching", hits: [], note: deviceName ? `正在 ${deviceName} 上搜索正文…` : "正在搜索正文…" }
      }
      if (state.phase === "error") return { deviceName, phase: "error", hits: [], note: state.text }
      const query = (ui.search ?? "").trim()
      const titleMatched = searchSessions(sessions, query)
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
      groups: overlaid.filter((g) => g.sessions.length > 0 || g.kind === "pinned" || (!archiveView && g.kind === "workspace" && Boolean(g.cwd))),
      newSessionLabel: "新会话",
      width: clampSidebarWidth(ui.prefs.sidebarWidth),
      collapsed,
      search: { open: ui.search != null, query: ui.search ?? "", body: bodyBlock },
      // 待答角标（设计 D §1）：只数 attention 清单里的 waiting+error+done——与账本 pending
      // 数恒等，计数唯一出口仍是 attentionItemsOf，设备掉线条不入此数。
      inboxCount: base.attention.filter((item) => item.kind === "waiting" || item.kind === "error" || item.kind === "done").length,
      now,
    }
  }, [relay, ui.prefs.grouping, ui.prefs.sidebarWidth, collapsed, ui.expanded, ui.search, scopeState, localStore.workspaceName, settingsPrefs.autoArchive, settingsPrefs.retention, now, deviceMenuOpen, account, deviceId, bodySearch, resolvedTheme, archiveView, menuTargetId])

  // 新会话常落在默认折叠的组里，选中行看不见：当前会话所在的组没手动开合过就展开它
  const currentGroupId = data.groups.find((g) => g.kind === "workspace" && g.sessions.some((s) => s.selected))?.id
  const revealFolder = localStore.revealFolder
  useEffect(() => {
    syncActiveRelayRoom(relay.roomId)
  }, [relay.roomId])
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
    if (session) {
      act.setSearch(null)
      openSessionRow(relay, session, act.openSession)
    }
  }

  const openBodyHitById = (hitId: string) => {
    const { state, deviceId: bodyDeviceId, deviceName } = bodySearch
    if (state.phase !== "done" || bodyDeviceId == null) return
    const base = sidebarDataOf({
      devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, roomId: relay.roomId,
      dialogs: relay.dialogs, uiPrompt: relay.uiPrompt, turnEnd: relay.turnEnd, roomTurnEnds: relay.roomTurnEnds, inbox: relay.inbox, selectedDevice: relay.selectedDevice,
    })
    const query = (ui.search ?? "").trim()
    const titleMatched = searchSessions(filterSessionsByRetention(base.sessions, settingsPrefs.retention, now, relay.roomId), query)
    const hits = paletteBodyHitsOf(state.page, { id: bodyDeviceId, name: deviceName }, titleMatched.map((s) => ({ id: s.id, path: s.path })))
    const hit = hits.find((h) => h.id === hitId)
    if (hit) {
      act.setSearch(null)
      openBodySearchHit(relay, hit, () => act.openSession())
    }
  }

  // 平板档浮层里点了去处（会话、新会话、设置、待答）就先收起浮层
  const leave =
    <A extends unknown[]>(run: (...args: A) => void) =>
    (...args: A) => {
      drawer?.close()
      run(...args)
    }
  const newSessionInGroup = leave((group: PiSidebarGroup) => {
    if (group.deviceId && group.cwd) presetNewSession(group.deviceId, group.cwd)
    act.newSession()
  })
  const actions: PiSidebarActions = {
    selectSession: leave(openRowByKey),
    selectBodyHit: leave(openBodyHitById),
    newSession: leave(() => {
      resetNewSessionSelection()
      act.newSession()
    }),
    newSessionInGroup,
    selectDevice: (id) => { relay.selectDevice(id); act.openSession() },
    toggleDeviceMenu: (open) => setDeviceMenuOpen(open ?? !deviceMenuOpen),
    addDevice: () => act.openDialog({ id: PI_UI_IDS.pairing }),
    openDeviceHub: leave(() => act.openDeviceHub()),
    togglePin: localStore.togglePin,
    toggleArchive: localStore.toggleArchive,
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
      search: formatShortcutLabel(settingsPrefs.shortcuts.globalSearch, PI_SHORTCUT_KEYS["command-palette"][platform]),
      newSession: formatShortcutLabel(settingsPrefs.shortcuts.newSession, PI_SHORTCUT_KEYS["new-session"][platform]),
      toggleSidebar: formatShortcutLabel(settingsPrefs.shortcuts.toggleSidebar, PI_SHORTCUT_KEYS["toggle-sidebar"][platform]),
      settings: formatShortcutLabel(settingsPrefs.shortcuts.openSettings, PI_SHORTCUT_KEYS.settings[platform]),
    }
  }, [settingsPrefs.shortcuts])
  const saveWorkspaceRename = () => {
    if (!renameGroup) return
    const next = renameDraft.trim()
    if (!next) return
    localStore.renameWorkspace(renameGroup.id, next)
    setRenameGroup(null)
  }
  const renderWorkspaceMenu = (group: PiSidebarGroup) => (
    <PiMenu
      side="bottom"
      align="end"
      trigger={
        <button
          type="button"
          className="sb-iconbtn sb-wsact"
          aria-label={`${group.label} 工作区菜单`}
          title="工作区操作"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreVerticalIcon />
        </button>
      }
    >
      <WorkspaceMenuSurface
        group={group}
        onNewSession={newSessionInGroup}
        onRename={(g) => {
          setRenameDraft(g.label)
          setRenameGroup(g)
        }}
        onResetName={(g) => localStore.renameWorkspace(g.id, "")}
        onCopyCwd={(g) => {
          if (!g.cwd) return
          void piCopyText(g.cwd).then((ok) => {
            if (ok) relay.pushNotice({ level: "info", title: "已复制目录路径", dedupeKey: "sidebar.copy-cwd" })
          })
        }}
      />
    </PiMenu>
  )
  return (
    <>
      <UnifiedSidebar
        className={drawer ? "sb-tablet" : undefined}
        data={data}
        actions={actions}
        view={{
          archiveView,
          inboxActive: ui.view === "inbox",
          persistentSearch: settingsPrefs.sidebarPersistentSearch,
          rowMenu: isStatic ? undefined : (session) => <SessionRowMenu {...p} rowId={session.id} />,
          workspaceMenu: isStatic ? undefined : renderWorkspaceMenu,
          menuTargetId,
          shortcuts,
          displayOptions: <DisplayOptionsContainer {...p} />,
          displayOptionsOpen: isStatic && ui.menu?.id === PI_UI_IDS.displayOptions,
        }}
      />
      {renameGroup ? (
        <PiDialog
          key={renameGroup.id}
          title="重命名工作区"
          viewport="desktop"
          width={360}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setRenameGroup(null)
          }}
          footer={
            <>
              <PiButton kind="outline" variant="desktop" onClick={() => setRenameGroup(null)}>
                取消
              </PiButton>
              <PiButton variant="desktop" disabled={!renameDraft.trim()} onClick={saveWorkspaceRename}>
                保存
              </PiButton>
            </>
          }
        >
          <input
            aria-label="工作区名称"
            autoFocus
            value={renameDraft}
            placeholder={renameGroup.defaultLabel || renameGroup.label}
            maxLength={80}
            spellCheck={false}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return
              event.preventDefault()
              saveWorkspaceRename()
            }}
            onFocus={(event) => event.currentTarget.select()}
            className={RENAME_FIELD_CLASS}
          />
        </PiDialog>
      ) : null}
    </>
  )
}
