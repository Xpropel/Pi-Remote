/** Codex 宿主侧栏的视图/动作类型（旧自写 CodexSidebar 退场后仍由 CodexDesktop/CodexPhone/CodexUnifiedSidebar 共用）。 */

export type CodexLocalPage = "plugins" | "prs" | "automations" | "skills" | "connectors"

export type CodexRowMarker = "waiting" | "error" | "unread" | "running" | "idle" | "unloaded"

export interface CodexRow {
  id: string
  title: string
  marker: CodexRowMarker
  at?: number
  deviceId?: string
  dimmed?: boolean
  subtitle?: string
  trailingText?: string
  trailingTone?: "attention"
  platform?: string
  /** 所属工作目录（分组/项目菜单用；来自 PiSidebarSession.cwd） */
  cwd?: string
}

export type CodexSidebarActions = {
  onNewSession: () => void
  onSearch: () => void
  onOpenSettings: () => void
  onOpenLocalPage: (page: CodexLocalPage) => void
  localPage?: CodexLocalPage | null
  onOpenPairing: () => void
  onOpenRow: (row: CodexRow) => void
  onOpenRowMenu: (row: CodexRow, at: { x: number; y: number }) => void
  onToggleMore: (groupKey: string) => void
  onOpenAttention: () => void
  onClearFilter: () => void
  onOpenSession: (id: string, deviceId: string) => void
}
