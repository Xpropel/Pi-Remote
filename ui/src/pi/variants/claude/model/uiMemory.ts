import { useSyncExternalStore } from "react"

/**
 * P4 W1：工作区模式（会话 / 任务 / 工作台，台账 §3.5）的变体内存态（不碰浏览器存储）。
 * TODO(task-18 后续)：契约暂无 `uiWorkspaceMode` pref 字段；arch 增加后改为 prefs 持久化（act.setPref），
 * 平台标签本身已走契约 prefs（`uiPlatformTab` / `deviceByPlatform`）。
 */
export type ClaudeWorkspaceMode = "chat" | "tasks" | "code"

export const CLAUDE_WORKSPACE_LABEL: Record<ClaudeWorkspaceMode, string> = { chat: "会话", tasks: "任务", code: "工作台" }

let workspace: ClaudeWorkspaceMode = "chat"
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ClaudeWorkspaceMode {
  return workspace
}

export function setClaudeWorkspaceMode(next: ClaudeWorkspaceMode): void {
  if (workspace === next) return
  workspace = next
  for (const listener of [...listeners]) listener()
}

export function useClaudeWorkspaceMode(): ClaudeWorkspaceMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
