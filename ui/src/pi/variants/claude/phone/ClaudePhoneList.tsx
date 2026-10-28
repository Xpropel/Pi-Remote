import { useState } from "react"
import { SlidersHorizontal, Settings, Archive } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { ClaudeIconButton, ClaudeMark } from "../primitives/ClaudePrimitives"
import { useNow } from "../primitives/useClaude"
import { ClaudeHubRail } from "../chrome/ClaudeHubRail"
import { ClaudePhoneListTopBar } from "../chrome/ClaudeTitleBar"
import { ClaudeSearchBar } from "../chrome/ClaudeSearchBar"
import { ClaudePlatformTabs } from "../chrome/ClaudePlatformTabs"
import { ClaudeArtifactsPanel } from "../overlays/ClaudeArtifactsPanel"
import { ClaudeSessionRow } from "../sidebar/ClaudeSessionRow"
import { ClaudeSessionGroup } from "../sidebar/ClaudeSessionGroup"
import { ClaudeSidebarSkeleton } from "../sidebar/ClaudeSidebarSkeleton"
import { linkSummaryOf, openSessionRowFor, useSidebarModel } from "../model/view"
import { setClaudeWorkspaceMode, useClaudeWorkspaceMode } from "../model/uiMemory"
import { CLAUDE_OVERLAY } from "../overlays/ids"
import { ClaudeBoot } from "../pages/ClaudeBoot"

/**
 * 手机列表页（C-03 / §1.6 推导；P4 W1 台账 §3.2 手机适配）：
 * 44 顶栏（衬线字标 + 陶土＋）→ 第二行平台胶囊（全部/macOS/Windows/Linux 横滚）→ 搜索条 →
 * Hub Rail（会话/任务/工作台）→ 36 行会话列表 → 56 账户栏 → 底部安全区。
 * 模式切换 = Hub Rail 二级（台账 §3.5）；平台标签在顶栏第二行（台账 §3.2）。
 */
export function ClaudePhoneList({ p }: { p: PiContainerProps }) {
  const { relay, ui, act } = p
  const workspace = useClaudeWorkspaceMode()
  const model = useSidebarModel(p, p.ui.prefs.uiPlatformTab)
  useNow(30_000)
  const density: "compact" | "comfortable" = ui.prefs.density === "compact" ? "compact" : "comfortable"
  const empty = relay.devices.length === 0
  const searching = ui.search != null
  const [artifactsOpen, setArtifactsOpen] = useState(false)
  return (
    <div data-pi-ui-part="page" className="claude-phone claude-phone-list" data-p4-surface="CL-CHAT-01" data-p4-ready="">
      <ClaudePhoneListTopBar p={p} />
      <div className="claude-phone-platbar">
        <ClaudePlatformTabs p={p} />
      </div>
      {searching ? (
        <div className="claude-phone-searchstate">
          <input className="claude-input" autoFocus placeholder="搜索会话…" aria-label="搜索会话" value={ui.search ?? ""} onChange={(e) => act.setSearch(e.target.value)} />
          <button type="button" className="claude-link-btn" onClick={() => act.setSearch(null)}>
            取消
          </button>
        </div>
      ) : (
        <>
          <ClaudeSearchBar p={p} mobile />
          <ClaudeHubRail mode={workspace} onChange={setClaudeWorkspaceMode} attentionCount={model.attentionRows.length} />
        </>
      )}
      <div className="claude-phone-scroll">
        {empty ? (
          <ClaudeBoot p={p} />
        ) : relay.sessionsLoading && model.data.sessions.length === 0 ? (
          <ClaudeSidebarSkeleton />
        ) : (
          <>
            {model.attentionRows.length > 0 ? (
              <section className="claude-group">
                <header className="claude-group-head">
                  <span className="claude-group-label">需要处理</span>
                  <span className="claude-group-count">{model.attentionRows.length}</span>
                </header>
                {model.attentionRows.map((row) => (
                  <ClaudeSessionRow key={row.id} p={p} row={row} density={density} onOpen={() => openSessionRowFor(relay, act, row)} />
                ))}
              </section>
            ) : null}
            {model.groups.map((group) => (
              <ClaudeSessionGroup key={group.key} p={p} group={group} density={density} onOpenRow={(row) => openSessionRowFor(relay, act, row)} />
            ))}
            {model.groups.length === 0 && model.attentionRows.length === 0 ? <p className="claude-list-empty">还没有会话</p> : null}
          </>
        )}
      </div>
      {searching ? null : (
        <div className="claude-phone-account" data-pi-ui-part="statusline">
          <ClaudeMark size={14} />
          <span className="claude-account-text">
            <span className="claude-account-title">Pi-Remote</span>
            <span className="claude-account-link" data-link={linkSummaryOf(relay).kind}>
              {linkSummaryOf(relay).text}
            </span>
          </span>
          <ClaudeIconButton label="Artifacts" icon={<Archive size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={() => setArtifactsOpen(true)} />
          <ClaudeIconButton label="Artifacts" icon={<Archive size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={() => setArtifactsOpen(true)} />
          <ClaudeIconButton label="显示选项" icon={<SlidersHorizontal size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={() => act.openSheet({ id: CLAUDE_OVERLAY.displayOptions })} />
          <ClaudeIconButton label="设置" icon={<Settings size={15} strokeWidth={1.5} />} className="claude-iconbtn" onClick={act.openSettings} />
        </div>
      )}
      {artifactsOpen ? <ClaudeArtifactsPanel onClose={() => setArtifactsOpen(false)} /> : null}
    </div>
  )
}
