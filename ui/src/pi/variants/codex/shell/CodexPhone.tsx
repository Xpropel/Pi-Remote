import { useMemo, useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { MobileSettingsPage } from "@/pi/settings/mobile"
import { codexSettingsHostProps } from "./settingsHost"
import { bootInputOf, bootViewOf } from "@/pi/model/boot"
import { phonePageOf } from "@/pi/model/phoneRoute"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { CodexPhoneChat } from "../phone/CodexPhoneChat"
import { CodexPhonePanel } from "../phone/CodexPhonePanel"
import { CodexPhoneComposer } from "../phone/CodexPhoneComposer"
import { CodexPhoneBar } from "../chrome/CodexTitleBar"
import { CodexNewSession } from "../pages/CodexNewSession"
import { CodexInboxPage } from "../pages/CodexInboxPage"
import { CodexPlugins } from "../pages/CodexPlugins"
import { CodexAutomations } from "../pages/CodexAutomations"
import { CodexPullRequests } from "../pages/CodexPullRequests"
import { CodexSkills } from "../pages/CodexSkills"
import { CodexConnectors } from "../pages/CodexConnectors"
import { CodexOverlayHost, type CodexOverlayState } from "../overlays/CodexOverlayHost"
import { MobileNavShell, useMobileSidebarData } from "@/pi/mobile"
import type { PiSidebarActions } from "@/pi/sidebar"
import type { CodexLocalPage, CodexSidebarActions } from "../sidebar/types"
import type { CodexRow } from "../sidebar/types"

function sessionEntryOf(relay: VariantAppProps["relay"], id: string): { session: unknown; deviceId: string } | null {
  for (const [deviceId, list] of Object.entries(relay.sessionsByDevice)) {
    const hit = (list ?? []).find((x) => x.id === id)
    if (hit) return { session: hit, deviceId }
  }
  return null
}

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
  act.setPhonePage("chat")
}

/** Codex 手机外壳（§2.5 / X-03 / X-04）：列表页 / 对话页 / 新建 / 设置 / 右栏整页推入；浮层渲染在变体根内 */
export function CodexPhone(props: VariantAppProps) {
  const { relay, ui, act } = props
  const [overlay, setOverlay] = useState<CodexOverlayState>({ sessionMenu: null, dialog: null, pairing: false, displayOptions: false })
  const [localPage, setLocalPage] = useState<CodexLocalPage | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const patchOverlay = (next: Partial<CodexOverlayState>) => setOverlay((cur) => ({ ...cur, ...next }))
  const sessionCount = useMemo(() => sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).length, [relay.devices, relay.rooms, relay.sessionsByDevice])
  const boot = bootViewOf(bootInputOf(relay, sessionCount)).kind
  const page = phonePageOf({ boot, view: ui.view, pane: ui.pane, phonePage: ui.phonePage, search: ui.search, roomId: relay.roomId })
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
      const first = relay.rooms.find((room) => room.busy) ?? relay.rooms[0]
      if (first) openRow(props, { id: first.id, title: first.label ?? "", marker: "running" } as CodexRow)
    },
    onClearFilter: () => act.setPref("deviceFilter", null),
    onOpenSession: (id, deviceId) => {
      act.setSearch(null)
      const hit = sessionEntryOf(relay, id)
      if (!hit) return
      if (deviceId && deviceId !== relay.selectedDeviceId) relay.selectDevice(deviceId)
      const openable = relay.rooms.some((room) => room.id === id && room.online)
      if (openable) relay.selectRoom(id)
      else relay.selectListedSession(hit.session as Parameters<typeof relay.selectListedSession>[0])
      act.openSession()
      act.setPhonePage("chat")
    },
  }
  const mobileSide = useMobileSidebarData(props, {
    style: "codex",
    theme: props.theme,
    search: { open: ui.search != null, query: ui.search ?? "" },
    localPages: [
      { id: "plugins", label: "扩展", active: localPage === "plugins" },
      { id: "prs", label: "代码审查", active: localPage === "prs" },
      { id: "automations", label: "计划任务", active: localPage === "automations" },
      { id: "skills", label: "技能", active: localPage === "skills" },
      { id: "connectors", label: "连接", active: localPage === "connectors" },
    ],
  })
  const mobileActions: PiSidebarActions = {
    selectSession: (key) => {
      const at = key.indexOf("::")
      if (at < 0) return
      actions.onOpenSession(key.slice(at + 2), key.slice(0, at))
    },
    newSession: actions.onNewSession,
    selectDevice: (deviceId) => relay.selectDevice(deviceId),
    addDevice: actions.onOpenPairing,
    togglePin: (key) => {
      mobileSide.togglePin(key)
      relay.notify("仅本机记忆，尚未写入 pi", "warn")
    },
    toggleArchive: (key) => {
      mobileSide.toggleArchive(key)
      relay.notify("归档仅本机记忆，不会删除会话", "warn")
    },
    toggleGroup: (groupId) => mobileSide.toggleGroup(groupId),
    togglePlainRow: (row) => {
      if (row === "workspace") mobileSide.data.groups.forEach((group) => mobileSide.toggleGroup(group.id))
      else relay.notify("本机归档列表：暂无归档", "warn")
    },
    openSearch: actions.onSearch,
    closeSearch: () => act.setSearch(null),
    setSearchQuery: (query) => act.setSearch(query),
    openSettings: actions.onOpenSettings,
    openInbox: act.openInbox,
    resize: () => undefined,
    toggleCollapse: () => undefined,
    selectLocalPage: (pageId) => setLocalPage(pageId as CodexLocalPage),
    openArchiveView: () => relay.notify("本机归档列表：暂无归档", "warn"),
  }
  if (localPage) {
    const label = localPage === "plugins" ? "扩展" : localPage === "skills" ? "技能" : localPage === "connectors" ? "连接" : localPage === "prs" ? "代码审查" : "计划任务"
    return (
      <div className="cx-phone" data-variant="phone" data-page={page}>
        <CodexPhoneBar title={label} onBack={() => setLocalPage(null)} />
        <div className="cx-phone-scroll">
          {localPage === "plugins" ? <CodexPlugins p={props} /> : null}
          {localPage === "skills" ? <CodexSkills p={props} /> : null}
          {localPage === "connectors" ? <CodexConnectors p={props} /> : null}
          {localPage === "automations" ? <CodexAutomations p={props} /> : null}
          {localPage === "prs" ? (
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
                act.setPhonePage("chat")
              }}
            />
          ) : null}
        </div>
        <CodexOverlayHost p={props} state={overlay} onChange={patchOverlay} />
      </div>
    )
  }
  return (
    <div className="cx-phone" data-variant="phone" data-page={page}>
      {page === "list" || page === "chat" ? (
        <MobileNavShell
          mode={ui.prefs.mobileNav}
          data={mobileSide.data}
          actions={mobileActions}
          page={page === "chat" ? "session" : "list"}
          onOpenSession={mobileActions.selectSession}
          onBackToList={() => act.setPhonePage("list")}
          drawerOpen={drawerOpen}
          onDrawerOpenChange={setDrawerOpen}
        >
          {page === "chat" ? (
            <CodexPhoneChat
              p={props}
              chrome={false}
              onSessionMenu={(at) => relay.roomId && patchOverlay({ sessionMenu: { rowId: relay.roomId, at } })}
            />
          ) : null}
        </MobileNavShell>
      ) : null}
      {page === "new" ? (
        <>
          <CodexPhoneBar title="新会话" onBack={() => act.openSession()} />
          <div className="cx-phone-scroll" data-p4-surface="CX-PHONE-NEW" data-p4-ready="">
            <CodexNewSession p={props} phone onOpenPairing={() => patchOverlay({ pairing: true })} />
          </div>
          <CodexPhoneComposer p={props} />
        </>
      ) : null}
      {page === "settings" ? (
        <div data-p4-surface="CX-PHONE-SETTINGS" data-p4-ready="">
          <MobileSettingsPage p={codexSettingsHostProps(props, "phone", () => patchOverlay({ pairing: true }))} />
        </div>
      ) : null}
      {page === "inbox" ? (
        <>
          <CodexPhoneBar title="待答" onBack={() => act.openSession()} />
          <div className="cx-phone-scroll">
            <CodexInboxPage p={props} phone />
          </div>
        </>
      ) : null}
      {page === "pane" ? <CodexPhonePanel p={props} onBack={() => act.setPane(null)} /> : null}
      <CodexOverlayHost p={props} state={overlay} onChange={patchOverlay} />
    </div>
  )
}
