import { useEffect, useState } from "react"
import type { PiContainerProps } from "@/pi/containers/types"
import { ClaudeInboxPage } from "../pages/ClaudeInboxPage"
import { SettingsPage, settingsStyleOf, type SettingsTheme } from "@/pi/settings"
import { claudeSettingsHostProps } from "./settingsHost"
import { bootViewOfRelay } from "../model/view"
import { ClaudeTitleBar } from "../chrome/ClaudeTitleBar"
import { ClaudeUnifiedSidebar } from "../sidebar/ClaudeUnifiedSidebar"
import { ClaudeThread } from "../thread/ClaudeThread"
import { ClaudeComposer } from "../composer/ClaudeComposer"
import { ClaudeApprovalCard } from "../approval/ClaudeApprovalCard"
import { ClaudeStatusRail, ClaudePaneColumn } from "../panels/ClaudeStatusRail"
import { ClaudeNewSession } from "../pages/ClaudeNewSession"
import { ClaudeBoot } from "../pages/ClaudeBoot"
import { ClaudeCoworkPage } from "../pages/ClaudeCoworkPage"
import { ClaudeCodePage } from "../pages/ClaudeCodePage"

const MODE_KEYS = ["chat", "tasks", "code"] as const
import { setClaudeWorkspaceMode, useClaudeWorkspaceMode } from "../model/uiMemory"
import { PLATFORM_TAB_KEYS, selectPlatformTab } from "../model/platformUi"
import { ClaudeStatusLine } from "../overlays/ClaudeStatusLine"
import { ClaudeNotice } from "../overlays/ClaudeNotice"
import { ClaudeOverlayHost } from "../overlays/ClaudeOverlayHost"

/**
 * Claude 桌面外壳（C-01 / §1.5）：46 标题栏 → 288 侧栏 | 680 版心对话列 + composer dock | 320 rail（或右栏面板）。
 * 行为全部自有：视图分支（会话 / 新建 / 设置 / 启动）、快捷键、rail 开关。
 */
export function ClaudeDesktopShell({ p, theme }: { p: PiContainerProps; theme?: SettingsTheme }) {
  const { relay, ui, act } = p
  const [railOpen, setRailOpen] = useState(true)
  const boot = bootViewOfRelay(relay)
  const session = ui.view === "session"
  const ready = boot.kind === "ready"
  const paneOpen = session && ready && ui.pane != null
  const showRail = session && ready && !paneOpen && railOpen
  const showSidebar = ui.sidebar !== "rail"

  // 快捷键（自有实现）：⌘K 命令面板 / ⌘, 设置 / ⌘B 侧栏 / ⌘. 右栏 / Esc 关最上层
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault()
        act.setPaletteOpen(true)
      } else if (meta && event.key === ",") {
        event.preventDefault()
        act.openSettings()
      } else if (meta && event.key.toLowerCase() === "b") {
        event.preventDefault()
        act.toggleSidebar()
      } else if (meta && event.key === ".") {
        event.preventDefault()
        act.togglePane()
      } else if (event.key === "Escape") {
        if (ui.paletteOpen) act.setPaletteOpen(false)
        else if (ui.dialog) act.closeDialog()
        else if (ui.sheet) act.closeSheet()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [act, ui.paletteOpen, ui.dialog, ui.sheet])

  const workspace = useClaudeWorkspaceMode()
  const chatMode = workspace === "chat"
  // P4 W1（台账 §3.2 键盘）：⌘⌥1–4 切平台（全部/macOS/Windows/Linux），⌘1–3 切会话/任务/工作台
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const index = Number(event.key)
      if (!Number.isInteger(index)) return
      if (event.altKey && index >= 1 && index <= 4) {
        event.preventDefault()
        selectPlatformTab(p, PLATFORM_TAB_KEYS[index - 1])
        return
      }
      if (!event.altKey && index >= 1 && index <= 3) {
        event.preventDefault()
        setClaudeWorkspaceMode(MODE_KEYS[index - 1])
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [p])
  // 「设置 / 新建」是全局视图：
  // 1) 必须先于 !ready 的 Boot 页——设备全离线时用户仍要能进设置配对设备（否则死锁）；
  // 2) 也必须先于工作区 tab（任务/工作台），否则点设置无任何视觉响应。
  // 设置页 v2：六套皮肤由 style/theme 显式传入（style 跟随 prefs.ui，theme 由 ClaudeApp 的 usePiTheme 解析）。
  const settings = (
    <SettingsPage p={claudeSettingsHostProps(p)} style={settingsStyleOf(p.ui.prefs.ui)} theme={theme} />
  )
  const page = ui.view === "settings" ? (
    settings
  ) : ui.view === "new" ? (
    <ClaudeNewSession p={p} />
  ) : ui.view === "inbox" ? (
    // Pending-answer inbox (design D section 1): this shell used to have no
    // route for the inbox view at all, so the surface was unreachable here.
    // The variant is self-contained, so it renders its own inbox page.
    <ClaudeInboxPage p={p} />
  ) : !ready ? (
    <ClaudeBoot p={p} />
  ) : !chatMode ? (
    workspace === "tasks" ? <ClaudeCoworkPage p={p} /> : <ClaudeCodePage p={p} />
  ) : session ? (
    <div className="claude-thread-column">
      <ClaudeThread relay={relay} />
    </div>
  ) : (
    settings
  )

  const notices = relay.notices?.length ? <ClaudeNotice p={p} /> : null
  return (
    <div className="claude-desktop" data-claude-layout="desktop" data-p4-surface="CL-SHELL-01" data-p4-ready="">
      <ClaudeTitleBar p={p} />
      <div className="claude-desktop-body">
        {showSidebar ? <ClaudeUnifiedSidebar p={p} /> : null}
        <main className="claude-main" data-pi-ui-part="thread">
          <ClaudeStatusLine p={p} />
          <div className="claude-main-content">{page}</div>
          {session && ready && chatMode ? (
            <div className="claude-dock" data-pi-ui-part="composer">
              <div className="claude-dock-approval">
                <ClaudeApprovalCard p={p} />
              </div>
              <div className="claude-dock-column">
                <ClaudeComposer p={p} />
              </div>
            </div>
          ) : null}
          {notices ? <div className="claude-notice-slot">{notices}</div> : null}
          <span hidden data-p4-surface="CL-XCUT-01" data-p4-ready="" data-capability-state="available" />
        </main>
        {!chatMode || !session || !ready ? null : paneOpen ? (
          <ClaudePaneColumn p={p} onClose={() => act.setPane(null)} />
        ) : showRail ? (
          <ClaudeStatusRail p={p} onClose={() => setRailOpen(false)} />
        ) : (
          <button type="button" className="claude-rail-reopen" aria-label="显示会话状态" onClick={() => setRailOpen(true)}>
            ✳
          </button>
        )}
      </div>
      <ClaudeOverlayHost p={p} />
    </div>
  )
}

