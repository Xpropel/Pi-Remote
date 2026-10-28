import { useEffect, useMemo, useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { SettingsPage, settingsStyleOf } from "@/pi/settings"
import { codexSettingsHostProps } from "./settingsHost"
import { bootInputOf, bootViewOf } from "@/pi/model/boot"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { attentionItemsOf } from "@/relay/attention"
import { CodexTitleBar } from "../chrome/CodexTitleBar"
import type { CodexLocalPage, CodexSidebarActions } from "../sidebar/types"
import { CodexUnifiedSidebar } from "../sidebar/CodexUnifiedSidebar"
import { CodexThread } from "../thread/CodexThread"
import { CodexComposer } from "../composer/CodexComposer"
import { changesViewOf } from "@/pi/model/changesView"
import { useCodexCapability } from "../logic/capability"
import { CodexTerminalView } from "../panels/CodexTerminalView"
import { CodexCommitDialog } from "../overlays/CodexCommitDialog"
import { Square, X } from "../icons/CodexIcons"
import { CodexPanel } from "../panels/CodexPanel"
import { CodexEnvironmentCard } from "../panels/CodexEnvironmentCard"
import { CodexNewSession } from "../pages/CodexNewSession"
import { CodexPlugins } from "../pages/CodexPlugins"
import { CodexAutomations } from "../pages/CodexAutomations"
import { CodexPullRequests } from "../pages/CodexPullRequests"
import { CodexSkills } from "../pages/CodexSkills"
import { CodexConnectors } from "../pages/CodexConnectors"
import { CodexBoot } from "../pages/CodexBoot"
import { CodexOverlayHost, type CodexOverlayState } from "../overlays/CodexOverlayHost"
import { CodexStatusLine } from "../overlays/CodexStatusLine"
import { CodexNoticeStack } from "../overlays/CodexNotice"
import { codexRoomDevice, codexRoomTitle } from "../logic/view"
import type { CodexRow } from "../sidebar/types"

function platformLabelOf(platform: string): string {
  const key = platform.trim().toLowerCase()
  return key === "macos" || key === "darwin" ? "macOS" : key === "windows" || key === "win32" ? "Windows" : key === "linux" ? "Linux" : platform
}

function sessionEntryOf(relay: VariantAppProps["relay"], id: string): { session: unknown; deviceId: string } | null {
  for (const [deviceId, list] of Object.entries(relay.sessionsByDevice)) {
    const hit = (list ?? []).find((x) => x.id === id)
    if (hit) return { session: hit, deviceId }
  }
  return null
}

/** 打开一行会话（口径同 model/sidebarSource.openSessionRow：先切设备，再订阅房间或本地选择） */
function openRow(p: VariantAppProps, row: CodexRow) {
  const { relay, act } = p
  if (row.platform != null) {
    if (row.deviceId) relay.selectDevice(row.deviceId)
    return
  }
  const hit = sessionEntryOf(relay, row.id)
  if (!hit) return
  const openable = relay.rooms.some((room) => room.id === row.id && room.online)
  if (row.id !== relay.roomId) {
    const deviceId = row.deviceId ?? hit.deviceId
    if (deviceId && deviceId !== relay.selectedDeviceId) relay.selectDevice(deviceId)
    if (openable) relay.selectRoom(row.id)
    else relay.selectListedSession(hit.session as Parameters<typeof relay.selectListedSession>[0])
  }
  act.openSession()
}

/**
 * Codex 桌面外壳（[X-§1][X-图7] / X-01）：46 标题栏贯通 ｜ 274 侧栏 ｜ 768 居中正文（上 33/左右 24/下 32）｜ 右栏 min(667,44vw)。
 * 全部 DOM/样式自写；数据与状态经 VariantAppProps（relay/ui/act）；浮层渲染在变体根内部（CodexOverlayHost）。
 */
export function CodexDesktop(props: VariantAppProps) {
  const { relay, ui, act } = props
  const [overlay, setOverlay] = useState<CodexOverlayState>({ sessionMenu: null, dialog: null, pairing: false, displayOptions: false })
  const [localPage, setLocalPage] = useState<CodexLocalPage | null>(null)
  const [bottomTerminal, setBottomTerminal] = useState(false)
  const [commitOpen, setCommitOpen] = useState(false)
  const multiTab = useCodexCapability("multi-tab")
  const fileEditor = useCodexCapability("file-editor")
  const gitCommit = useCodexCapability("git-commit")
  const changesStats = useMemo(() => {
    if (!relay.roomId) return null
    const view = changesViewOf(relay.transcript.items)
    return view ? { added: view.added, removed: view.removed } : null
  }, [relay.roomId, relay.transcript.items])
  const patchOverlay = (next: Partial<CodexOverlayState>) => setOverlay((cur) => ({ ...cur, ...next }))
  const sessionCount = useMemo(() => sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).length, [relay.devices, relay.rooms, relay.sessionsByDevice])
  const boot = bootViewOf(bootInputOf(relay, sessionCount)).kind
  const session = ui.view === "session"
  const ready = boot === "ready"
  // P12：设置/新建是全局视图；任何入口进入时清掉本地页，避免本地页压住设置/新建
  const openSettings = () => {
    setLocalPage(null)
    act.openSettings()
  }
  const startNewSession = () => {
    setLocalPage(null)
    act.newSession()
  }
  const paneOpen = session && ready && ui.pane != null
  useEffect(() => {
    if (typeof window === "undefined") return
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault()
        act.setPaletteOpen(!ui.paletteOpen)
        return
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault()
        startNewSession()
        return
      }
      if (meta && event.key === ",") {
        event.preventDefault()
        openSettings()
        return
      }
      if (meta && event.key === ".") {
        event.preventDefault()
        act.togglePane()
        return
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault()
        act.setPane("changes")
        return
      }
      if (meta && event.key.toLowerCase() === "p") {
        event.preventDefault()
        act.setPane("file")
        return
      }
      if (meta && event.key.toLowerCase() === "j") {
        event.preventDefault()
        setBottomTerminal((open) => !open)
        return
      }
      if (meta && event.key.toLowerCase() === "t") {
        event.preventDefault()
        setBottomTerminal((open) => !open)
        return
      }
      if (event.key === "Escape") {
        // Esc 优先级：底部终端 → 命令面板 → 变体浮层 → 停止运行
        if (bottomTerminal) {
          event.preventDefault()
          setBottomTerminal(false)
          return
        }
        if (ui.paletteOpen) {
          event.preventDefault()
          act.setPaletteOpen(false)
          return
        }
        if (commitOpen) {
          event.preventDefault()
          setCommitOpen(false)
          return
        }
        if (overlay.sessionMenu || overlay.dialog || overlay.pairing || overlay.displayOptions) {
          event.preventDefault()
          patchOverlay({ sessionMenu: null, dialog: null, pairing: false, displayOptions: false })
          return
        }
        if (relay.busy) void relay.abort()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [act, relay, ui.paletteOpen, overlay, bottomTerminal, commitOpen])
  const actions: CodexSidebarActions = {
    onNewSession: () => {
      setLocalPage(null)
      act.newSession()
    },
    onSearch: () => {
      setLocalPage(null)
      act.setSearch(ui.search ?? "")
    },
    onOpenSettings: () => {
      setLocalPage(null)
      act.openSettings()
    },
    onOpenLocalPage: (page) => {
      act.setSearch(null)
      setLocalPage(page)
    },
    onOpenPairing: () => patchOverlay({ pairing: true }),
    localPage,
    onOpenRow: (row) => {
      setLocalPage(null)
      openRow(props, row)
    },
    onOpenRowMenu: (row, at) => patchOverlay({ sessionMenu: { rowId: row.id, at } }),
    onToggleMore: act.toggleExpanded,
    onOpenAttention: () => {
      const items = attentionItemsOf({
        currentRoomId: relay.roomId,
        rooms: relay.rooms,
        dialogs: relay.dialogs,
        uiPrompt: relay.uiPrompt,
        turnEnd: relay.turnEnd,
        roomTurnEnds: relay.roomTurnEnds,
        selectedDevice: relay.selectedDevice,
      })
      const first = items.find((item) => item.kind === "waiting" || item.kind === "error" || item.kind === "done")
      if (first && "roomId" in first && first.roomId) openRow(props, { id: first.roomId, title: first.title ?? "", marker: "waiting" } as CodexRow)
    },
    onClearFilter: () => act.setPref("deviceFilter", null),
    onOpenSession: (id, deviceId) => {
      setLocalPage(null)
      act.setSearch(null)
      const hit = sessionEntryOf(relay, id)
      if (!hit) return
      if (deviceId && deviceId !== relay.selectedDeviceId) relay.selectDevice(deviceId)
      const openable = relay.rooms.some((room) => room.id === id && room.online)
      if (openable) relay.selectRoom(id)
      else relay.selectListedSession(hit.session as Parameters<typeof relay.selectListedSession>[0])
      act.openSession()
    },
  }
  // 设置页 v2：六套皮肤由 style/theme 显式传入（style 跟随 prefs.ui，theme 由 CodexApp 的 usePiTheme 解析）。
  // 设置页内的「配对 / 重新配对」经 codexSettingsHostProps 转到 Codex 自己的配对浮层。
  const settings = (
    <SettingsPage
      p={codexSettingsHostProps(props, "desktop", () => patchOverlay({ pairing: true }))}
      style={settingsStyleOf(props.ui.prefs.ui)}
      theme={props.theme}
    />
  )
  // P12：设置/新建优先于本地页；本地页只在设置/新建以外的视图显示
  const main =
    ui.view === "new" ? (
      <CodexNewSession p={props} onOpenPairing={() => patchOverlay({ pairing: true })} />
    ) : ui.view === "settings" && !localPage ? (
      settings
    ) : localPage === "plugins" ? (
      <CodexPlugins p={props} />
    ) : localPage === "skills" ? (
      <CodexSkills p={props} />
    ) : localPage === "connectors" ? (
      <CodexConnectors p={props} />
    ) : localPage === "automations" ? (
      <CodexAutomations p={props} />
    ) : localPage === "prs" ? (
      <CodexPullRequests
        p={props}
        onOpenSession={(id) => {
          setLocalPage(null)
          const hit = sessionEntryOf(relay, id)
          if (!hit) return
          const openable = relay.rooms.some((room) => room.id === id && room.online)
          if (openable) relay.selectRoom(id)
          else relay.selectListedSession(hit.session as Parameters<typeof relay.selectListedSession>[0])
          act.openSession()
        }}
      />
    ) : boot === "connecting" || (session && !ready) ? (
      <CodexBoot p={props} onPair={() => patchOverlay({ pairing: true })} />
    ) : session ? (
      <CodexThread p={props} phone={false} />
    ) : (
      settings
    )
  return (
    <div className="cx-app" data-variant="desktop">
      <CodexTitleBar
        title={localPage === "plugins" ? "扩展" : localPage === "skills" ? "技能" : localPage === "connectors" ? "连接" : localPage === "prs" ? "代码审查" : localPage === "automations" ? "计划任务" : codexRoomTitle(relay)}
        device={relay.selectedDevice ? `${relay.selectedDevice.name}${relay.selectedDevice.platform ? ` · ${platformLabelOf(relay.selectedDevice.platform)}` : ""}` : codexRoomDevice(relay)}
        paneOpen={paneOpen}
        onNewSession={startNewSession}
        onCommand={() => act.setPaletteOpen(true)}
        onTogglePane={act.togglePane}
        onOpenSettings={openSettings}
        changes={changesStats}
        onOpenChanges={() => act.setPane("changes")}
        openEnabled={fileEditor.interactive}
        openTitle={fileEditor.interactive ? "在设备上打开（扩展）" : (fileEditor.view?.reason ?? "在设备上打开（需扩展）")}
        onOpenEditor={() => relay.notify(fileEditor.interactive ? "已交给扩展打开（模拟演示）" : `在设备上打开：${fileEditor.view?.reason ?? "需要扩展接入"}${fileEditor.view ? `（见 ${fileEditor.view.docsPath}）` : ""}`, "warn")}
        commitEnabled={gitCommit.interactive}
        commitTitle={gitCommit.interactive ? "在设备上提交（扩展）" : (gitCommit.view?.reason ?? "在设备上提交（需扩展）")}
        onCommit={() => setCommitOpen(true)}
        tabs={{
          enabled: multiTab.interactive,
          title: multiTab.interactive ? "新建会话标签" : (multiTab.view?.reason ?? "本机 pi 未提供多标签能力"),
          onAdd: () => relay.notify(multiTab.interactive ? "已交给多标签扩展（模拟演示）" : `多标签：${multiTab.view?.reason ?? "需要多标签扩展接入"}${multiTab.view ? `（见 ${multiTab.view.docsPath}）` : ""}`, "warn"),
          list: multiTab.interactive
            ? (multiTab.data?.tabs ?? []).map((tab) => ({ id: tab.id, title: tab.title, active: tab.id === multiTab.data?.activeTabId }))
            : undefined,
          onSelect: (id) => multiTab.actions?.selectTab?.(id),
          onClose: (id) => multiTab.actions?.closeTab?.(id),
        }}
      />
      <div className="cx-body" data-p4-surface="CX-SHELL-01" data-p4-ready="">
        <div data-pi-ui-part="sidebar" className="cx-sidebar-host">
          <CodexUnifiedSidebar p={props} actions={actions} localPage={localPage} />
        </div>
        <main className="cx-main">
          <CodexStatusLine p={props} />
          <CodexNoticeStack p={props} />
          <div className="cx-main-body">
            {main}
            {session && ready && !paneOpen && !localPage ? (
              <div className="cx-env-float">
                <CodexEnvironmentCard p={props} onOpenPanel={() => act.setPane("changes")} />
              </div>
            ) : null}
          </div>
          {session && ready && !localPage ? (
            <div className="cx-dock" data-pi-ui-part="composer">
              <CodexComposer p={props} phone={false} />
            </div>
          ) : null}
        </main>
        {paneOpen ? <CodexPanel p={props} onClose={() => act.setPane(null)} onOpenTerminal={() => setBottomTerminal(true)} /> : null}
        {bottomTerminal ? (
          <div className="cx-bottom-terminal" data-p4-surface="CX-PANEL-10" data-p4-ready="">
            <div className="cx-bottom-terminal-head">
              <Square aria-hidden size={12} strokeWidth={1.75} />
              <span>Terminal</span>
              <span className="cx-bottom-terminal-note">设备端终端 · 只读输出</span>
              <button type="button" className="cx-ghost-icon" aria-label="收起终端" onClick={() => setBottomTerminal(false)}>
                <X aria-hidden size={13} strokeWidth={1.5} />
              </button>
            </div>
            <div className="cx-bottom-terminal-body">
              <CodexTerminalView p={props} />
            </div>
          </div>
        ) : null}
      </div>
      <CodexOverlayHost p={props} state={overlay} onChange={patchOverlay} />
      {commitOpen ? <CodexCommitDialog p={props} onClose={() => setCommitOpen(false)} /> : null}
    </div>
  )
}
