import { useEffect, useState } from "react"
import { ChevronLeft } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { MobileSettingsPage } from "@/pi/settings/mobile"
import { claudeSettingsHostProps } from "./settingsHost"
import { MobileNavShell, useMobileSidebarData } from "@/pi/mobile"
import type { PiSidebarActions } from "@/pi/sidebar"
import { usePiFrame } from "@/pi/headless"
import { usePiPhoneNav } from "@/pi/hooks/usePiPhoneNav"
import { phonePageOf, type PiPhonePageKey } from "@/pi/model/phoneRoute"
import { ClaudePhoneList } from "../phone/ClaudePhoneList"
import { ClaudePhoneChat } from "../phone/ClaudePhoneChat"
import { ClaudeNewSession } from "../pages/ClaudeNewSession"
import { ClaudeInboxPage } from "../pages/ClaudeInboxPage"
import { ClaudePaneColumn } from "../panels/ClaudeStatusRail"
import { ClaudeOverlayHost } from "../overlays/ClaudeOverlayHost"
import { ClaudeIconButton } from "../primitives/ClaudePrimitives"
import { ClaudeModeSwitch } from "../chrome/ClaudeModeSwitch"
import { setClaudeWorkspaceMode } from "../model/uiMemory"
import { bootViewOfRelay } from "../model/view"
import { ClaudeCoworkPage } from "../pages/ClaudeCoworkPage"
import { ClaudeCodePage } from "../pages/ClaudeCodePage"
import { useClaudeWorkspaceMode } from "../model/uiMemory"

/**
 * Claude 手机外壳（§1.6，1024 断点语义由 PiApp 的 layout 决定）。
 * - 画廊舞台（frame.mode === "stage"）：按界面状态直接推导页面，不碰 history（截图/对图稳定）。
 * - 产品模式：接白名单 hook `usePiPhoneNav`（架构线 headless 审计通过、无样式依赖）——列表 ↔ 对话的历史栈、
 *   系统返回、推入页（新建/设置/右栏）、深链 `?device=&session=`、"正在打开会话…/会话不可用" 都由它管；
 *   页面内容仍是本变体自有的 ClaudePhoneList / ClaudePhoneChat / 自有推入页，不 import 任何 cursor 壳。
 */
export function ClaudePhoneShell({ p }: { p: PiContainerProps }) {
  const frame = usePiFrame()
  return frame.mode === "stage" ? <PhoneStageShell p={p} /> : <PhoneLiveShell p={p} />
}

function usePhoneEsc(p: PiContainerProps) {
  const { relay, ui, act } = p
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (ui.paletteOpen) act.setPaletteOpen(false)
      else if (ui.dialog) act.closeDialog()
      else if (ui.sheet) act.closeSheet()
      else if (ui.pane) act.setPane(null)
      else if (ui.view !== "session") act.openSession()
      else if (relay.roomId && ui.phonePage === "chat") act.setPhonePage("list")
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [act, relay.roomId, ui.paletteOpen, ui.dialog, ui.sheet, ui.pane, ui.view, ui.phonePage])
}

/** 画廊 / 截图：按界面状态推导（不接 history） */
function PhoneStageShell({ p }: { p: PiContainerProps }) {
  const { relay, ui } = p
  usePhoneEsc(p)
  const boot = bootViewOfRelay(relay).kind
  const page = phonePageOf({ boot, view: ui.view, pane: ui.pane, phonePage: ui.phonePage, search: ui.search, roomId: relay.roomId })
  return (
    <>
      <PhonePages p={p} page={page} />
      <ClaudeOverlayHost p={p} />
    </>
  )
}

/** 产品模式：历史栈 / 深链交给白名单 hook；页面与样式全部自有 */
function PhoneLiveShell({ p }: { p: PiContainerProps }) {
  const { ui, act } = p
  usePhoneEsc(p)
  const boot = bootViewOfRelay(p.relay).kind
  const { anchorRef, ...nav } = usePiPhoneNav(p, boot)
  void ui
  void act
  return (
    <>
      <PhonePages p={p} page={nav.page} back={nav.back} opening={nav.opening} />
      <ClaudeOverlayHost p={p} />
      <span ref={anchorRef} hidden data-claude-phone-nav={nav.page} />
    </>
  )
}

function PhonePages({
  p,
  page,
  back,
  opening,
}: {
  p: PiContainerProps
  page: PiPhonePageKey
  back?: () => void
  opening?: { sessionId: string; unavailable: boolean } | null
}) {
  const { relay, ui, act } = p
  const workspace = useClaudeWorkspaceMode()
  // A 案最小侵入：适配层窄化到 VariantAppProps（运行时 relay/ui/act 同构），只改 LiveShell 的 list/chat；
  // mobile 抽屉/列表/左滑/长按卡/双模式全部交给共享 MobileNavShell，Claude 仅保留正文/composer/推入页视觉。
  const [drawerOpen, setDrawerOpen] = useState(false)
  const sidebarTheme = typeof document !== "undefined" && document.documentElement.dataset.piTheme === "light" ? "light" : "dark"
  const mobileSide = useMobileSidebarData(p as unknown as Parameters<typeof useMobileSidebarData>[0], {
    style: "claude",
    theme: sidebarTheme,
    search: { open: ui?.search != null, query: ui?.search ?? "" },
  })
  const mobileActions: PiSidebarActions = {
    selectSession: (key) => {
      const at = key.indexOf("::")
      const deviceId = at >= 0 ? key.slice(0, at) : ""
      const id = at >= 0 ? key.slice(at + 2) : key
      const room = relay.rooms.find((item) => item.id === id)
      if (room) relay.selectRoom(id)
      else {
        const hit = relay.sessionsByDevice[deviceId]?.find((item) => item.id === id)
        if (hit) relay.selectListedSession(hit as never)
      }
      act.openSession()
      act.setPhonePage("chat")
    },
    newSession: () => act.newSession(),
    selectDevice: (deviceId) => relay.selectDevice?.(deviceId),
    addDevice: () => act.openDialog?.({ id: "claude:pairing" as never }),
    togglePin: (key) => {
      mobileSide.togglePin(key)
      relay.notify?.("仅本机记忆，尚未写入 pi", "warn")
    },
    toggleArchive: (key) => {
      mobileSide.toggleArchive(key)
      relay.notify?.("归档仅本机记忆，不会删除会话", "warn")
    },
    toggleGroup: (groupId) => mobileSide.toggleGroup(groupId),
    togglePlainRow: (row) => {
      if (row === "workspace") mobileSide.data.groups.forEach((group) => mobileSide.toggleGroup(group.id))
      else relay.notify?.("本机归档列表：暂无归档", "warn")
    },
    openSearch: () => act.setSearch?.(""),
    closeSearch: () => act.setSearch?.(null),
    setSearchQuery: (query) => act.setSearch?.(query),
    openSettings: act.openSettings,
    openInbox: act.openInbox,
    resize: () => {},
    toggleCollapse: () => {},
  }
  // 设置/新建同样是全局 push 页：先于工作区 tab 渲染，避免任务/工作台模式下点设置无反应。
  // 设置页 v2 是独立系统（自己的顶栏 + 返回），不再套 PushPage；默认返回即回原会话。
  if (page === "settings") return <MobileSettingsPage p={claudeSettingsHostProps(p)} />
  if (page === "new") return <PushPage p={p} title="新建会话" onBack={() => act.openSession()} content={<ClaudeNewSession p={p} phone />} />
  if (page === "inbox") return <PushPage p={p} title="待答" onBack={() => act.openSession()} content={<ClaudeInboxPage p={p} />} />
  if (workspace !== "chat") return <PhoneModePage p={p} mode={workspace} />
  if (page === "pane")
    return (
      <PushPage
        p={p}
        title={uiPaneTitle(relay)}
        onBack={() => act.setPane(null)}
        content={<ClaudePaneColumn p={p} onClose={() => act.setPane(null)} />}
      />
    )
  if (opening)
    return (
      <div className="claude-phone claude-phone-push" data-pi-ui-part="page">
        <div className="claude-phone-topbar" data-pi-ui-part="titlebar">
          <ClaudeIconButton label="返回会话列表" icon={<ChevronLeft size={20} strokeWidth={2} />} className="claude-iconbtn" onClick={back ?? (() => act.setPhonePage("list"))} />
          <span className="claude-phone-page-title">会话</span>
        </div>
        <div className="claude-phone-opening">
          {opening.unavailable ? (
            <>
              <h1 className="claude-boot-title">会话不可用</h1>
              <p className="claude-boot-note">会话不存在或设备已离线</p>
              <button type="button" className="claude-btn claude-btn-outline" onClick={back}>
                返回会话列表
              </button>
            </>
          ) : (
            <p className="claude-boot-sentence">
              <span aria-hidden className="claude-breath-dot" />
              正在打开会话…
            </p>
          )}
        </div>
      </div>
    )
  if (page === "list" || page === "chat") {
    return (
      <MobileNavShell
        mode={ui.prefs.mobileNav ?? "list"}
        data={mobileSide.data}
        actions={mobileActions}
        page={page === "chat" ? "session" : "list"}
        onOpenSession={mobileActions.selectSession}
        onBackToList={() => act.setPhonePage("list")}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
      >
        {page === "chat" ? <ClaudePhoneChat p={p} onBack={back ?? (() => act.setPhonePage("list"))} /> : null}
      </MobileNavShell>
    )
  }
  return <ClaudePhoneList p={p} />
}

function uiPaneTitle(relay: PiContainerProps["relay"]): string {
  void relay
  return "面板"
}

function PushPage({ p, title, onBack, content }: { p: PiContainerProps; title: string; onBack: () => void; content: React.ReactNode }) {
  const { ui, act } = p
  usePhoneEsc(p)
  void ui
  void act
  return (
    <div className="claude-phone claude-phone-push" data-pi-ui-part="page">
      <div className="claude-phone-topbar" data-pi-ui-part="titlebar">
        <ClaudeIconButton label="返回" icon={<ChevronLeft size={20} strokeWidth={2} />} className="claude-iconbtn" onClick={onBack} />
        <span className="claude-phone-page-title">{title}</span>
      </div>
      <div className="claude-phone-scroll">{content}</div>
    </div>
  )
}

/** 手机侧的任务 / 工作台页：自有 44 顶栏（‹ 返回会话）+ 模式切换 + 与桌面同一份 Cowork/Code 正文 */
function PhoneModePage({ p, mode }: { p: PiContainerProps; mode: "tasks" | "code" }) {
  const { act } = p
  const workspace = useClaudeWorkspaceMode()
  return (
    <div className="claude-phone claude-phone-push claude-phone-modepage" data-pi-ui-part="page">
      <div className="claude-phone-topbar" data-pi-ui-part="titlebar">
        <ClaudeIconButton label="返回会话列表" icon={<ChevronLeft size={20} strokeWidth={2} />} className="claude-iconbtn" onClick={() => act.setPhonePage("list")} />
        <span className="claude-phone-page-title">{mode === "tasks" ? "任务" : "代码工作台"}</span>
      </div>
      <div className="claude-phone-modewrap">
        <ClaudeModeSwitch mode={workspace} onChange={setClaudeWorkspaceMode} />
      </div>
      <div className="claude-phone-scroll">
        {mode === "tasks" ? <ClaudeCoworkPage p={p} /> : <ClaudeCodePage p={p} />}
      </div>
    </div>
  )
}
