import type { ClaudeWorkspaceMode } from "../model/uiMemory"
import { usePiUiCapabilities } from "@/pi/extensions"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"
import { CLAUDE_WORKSPACE_LABEL } from "../model/uiMemory"

/**
 * P4 Wave1（台账 §3.5 / CL-SHELL-03）：Claude Hub Rail 槽位改为**次级工作区模式切换**
 * 会话 / 任务 / 工作台（Claude Chat / Cowork / Code 的适配）。⌘1/⌘2/⌘3 切换（外壳里注册）。
 * 「工作台」的窗格能力（pane-workspace）生产默认 unavailable：标签可点但带 capability 禁用标记，
 * 正文用统一禁用态展示可接入信息（台账 §6.2/§6.3）。
 */
const HUB_MODES: readonly ClaudeWorkspaceMode[] = ["chat", "tasks", "code"]

export function ClaudeHubRail({
  mode,
  onChange,
  attentionCount,
}: {
  mode: ClaudeWorkspaceMode
  onChange: (mode: ClaudeWorkspaceMode) => void
  attentionCount: number
}) {
  const caps = usePiUiCapabilities()
  const codeStatus = caps.statusOf("pane-workspace")
  const codeDisabled = caps.disabledOf("pane-workspace")
  return (
    <div className="claude-hub" role="tablist" aria-label="工作区模式" data-p4-surface="CL-SHELL-03">
      {HUB_MODES.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={mode === id}
          className="claude-hub-seg"
          data-active={mode === id ? "" : undefined}
          data-p4-action="mode-tab"
          data-p4-mode={id}
          {...(id === "code" ? claudeCapabilityAttrs("pane-workspace", codeStatus) : {})}
          title={id === "chat" ? "会话模式 ⌘1" : id === "tasks" ? "任务模式 ⌘2" : codeDisabled ? `${codeDisabled.title}：${codeDisabled.reason}（${codeDisabled.docsPath}）` : "工作台模式 ⌘3"}
          onClick={() => onChange(id)}
        >
          {CLAUDE_WORKSPACE_LABEL[id]}
          {id === "chat" && attentionCount > 0 ? <span className="claude-hub-badge">{attentionCount}</span> : null}
        </button>
      ))}
    </div>
  )
}
