import { Ellipsis, PanelRight, Search } from "../icons/CodexIcons"
import { CodexIconButton } from "../primitives/primitives"
import { CodexTabStrip } from "./CodexTabStrip"

/** Codex 标题栏（X-01-1 / §2.7：46px 贯通；左侧品牌位起头（网页不是原生窗口，无 macOS 三色钮）；中间会话标签页；右侧动作按钮） */
export function CodexTitleBar({
  title,
  device,
  paneOpen,
  onNewSession,
  onCommand,
  onTogglePane,
  onOpenSettings,
  changes,
  onOpenChanges,
  openEnabled,
  openTitle,
  onOpenEditor,
  commitEnabled,
  commitTitle,
  onCommit,
  tabs,
}: {
  title: string
  device: string | null
  paneOpen: boolean
  onNewSession: () => void
  onCommand: () => void
  onTogglePane: () => void
  onOpenSettings: () => void
  changes: { added: number; removed: number } | null
  onOpenChanges: () => void
  openEnabled: boolean
  openTitle: string
  onOpenEditor: () => void
  commitEnabled: boolean
  commitTitle: string
  onCommit: () => void
  tabs: {
    enabled: boolean
    title: string
    onAdd: () => void
    list?: readonly { id: string; title: string; active: boolean }[]
    onSelect?: (id: string) => void
    onClose?: (id: string) => void
  }
}) {
  return (
    <header className="cx-titlebar" data-pi-ui-part="titlebar" data-pane-open={paneOpen ? "" : undefined} data-p4-surface="CX-SHELL-02" data-p4-ready="">
      <div className="cx-titlebar-left">
        <button type="button" className="cx-titlebar-brand" onClick={onNewSession} aria-label="新建会话">
          Pi-Remote
        </button>
      </div>
      <CodexTabStrip title={title} device={device} onNewSession={onNewSession} tabs={tabs} />
      <div className="cx-titlebar-actions">
        {changes ? (
          <button type="button" className="cx-titlebar-stats" data-p4-surface="CX-SHELL-04" data-p4-action="open-changes" title="打开右栏改动" onClick={onOpenChanges}>
            <span className="cx-add">+{changes.added}</span> <span className="cx-del">−{changes.removed}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="cx-ghost-text"
          data-p4-surface="CX-SHELL-03"
          data-p4-action="open-editor"
          data-pi-capability-disabled={openEnabled ? undefined : ""}
          disabled={!openEnabled}
          title={openTitle}
          onClick={onOpenEditor}
        >
          Open
        </button>
        <button
          type="button"
          className="cx-ghost-text"
          data-p4-surface="CX-SHELL-03"
          data-p4-action="commit"
          data-pi-capability-disabled={commitEnabled ? undefined : ""}
          title={commitTitle}
          onClick={onCommit}
        >
          Commit
        </button>
        <CodexIconButton label="命令面板 ⌘K" onClick={onCommand}>
          <Search aria-hidden size={15} strokeWidth={1.5} />
        </CodexIconButton>
        <CodexIconButton label={paneOpen ? "关闭审查面板" : "打开审查面板"} aria-pressed={paneOpen} onClick={onTogglePane} data-codex-id="toggle-pane">
          <PanelRight aria-hidden size={15} strokeWidth={1.5} />
        </CodexIconButton>
        <CodexIconButton label="设置" onClick={onOpenSettings}>
          <Ellipsis aria-hidden size={15} strokeWidth={1.5} />
        </CodexIconButton>
      </div>
    </header>
  )
}

/** 手机顶栏（46px；§2.5 推导）：‹ 返回 / 标题 + 副标题 / 动作 */
export function CodexPhoneBar({ title, subtitle, onBack, actions }: { title: React.ReactNode; subtitle?: string; onBack?: () => void; actions?: React.ReactNode }) {
  return (
    <header className="cx-phone-bar" data-pi-ui-part="titlebar">
      {onBack ? (
        <button type="button" className="cx-icon-btn cx-phone-back" onClick={onBack} aria-label="返回">
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
            <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <span className="cx-phone-back-space" aria-hidden />
      )}
      <div className="cx-phone-title">
        <span className="cx-phone-title-text">{title}</span>
        {subtitle ? <span className="cx-phone-title-sub">{subtitle}</span> : null}
      </div>
      <div className="cx-phone-actions">{actions}</div>
    </header>
  )
}
