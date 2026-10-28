import { ListChecks, MessageSquare, SquareTerminal } from "lucide-react"
import type { ClaudeWorkspaceMode } from "../model/uiMemory"
import { CLAUDE_WORKSPACE_LABEL } from "../model/uiMemory"

/**
 * P4 Wave1：Claude 三态模式切换（Chat / Cowork / Code → 会话 / 任务 / 代码工作台）。
 * 会话 / 任务（Cowork）/ 工作台（Code）三态；正文分别由会话流、Cowork 页、Code 工作台页实现，
 * 能力未接入时按契约禁用态（原因 + docsPath）呈现。
 */
const MODE_ICON: Record<ClaudeWorkspaceMode, typeof MessageSquare> = { chat: MessageSquare, tasks: ListChecks, code: SquareTerminal }

export function ClaudeModeSwitch({ mode, onChange }: { mode: ClaudeWorkspaceMode; onChange: (mode: ClaudeWorkspaceMode) => void }) {
  return (
    <div className="claude-mode-switch" role="tablist" aria-label="工作台模式">
      {(Object.keys(CLAUDE_WORKSPACE_LABEL) as ClaudeWorkspaceMode[]).map((id) => {
        const Icon = MODE_ICON[id]
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            data-active={mode === id ? "" : undefined}
            className="claude-mode-tab"
            title={id === "chat" ? "会话模式" : `${CLAUDE_WORKSPACE_LABEL[id]}模式`}
            onClick={() => onChange(id)}
          >
            <Icon size={13} strokeWidth={1.75} aria-hidden />
            <span>{CLAUDE_WORKSPACE_LABEL[id]}</span>
          </button>
        )
      })}
    </div>
  )
}
