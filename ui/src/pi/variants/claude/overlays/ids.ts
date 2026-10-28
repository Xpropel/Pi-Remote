/** Claude v2 自己的浮层 id（写进 usePiUiState 的 dialog/sheet；不 import cursor 的 PI_UI_IDS） */
export const CLAUDE_OVERLAY = {
  sessionMenu: "claude:session-menu",
  sessionInfo: "claude:session-info",
  delete: "claude:delete",
  rename: "claude:rename",
  pairing: "claude:pairing",
  displayOptions: "claude:display-options",
} as const

export type ClaudeOverlayId = (typeof CLAUDE_OVERLAY)[keyof typeof CLAUDE_OVERLAY]
