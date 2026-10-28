/**
 * 变体 v2 的公共类型出口（P2.5，`independence-checklist.md` D3）。
 *
 * 背景：`PiItem` / `PiTopLine` / `PiDialogCardView` 这类数据类型定义在 cursor 模块（`@/components/pi/shared/types`、
 * `@/pi/containers/types` 等）里；v2 若直接 import 会命中「禁止 import cursor UI」的守卫。这里把它们**只以类型形式**
 * re-export 出来：本文件编译后为空（所有 import 都是 `import type`、所有 export 都是 `export type`），
 * 不会把 cursor 的组件 / 样式 / 运行时模块带进变体 chunk。
 *
 * 变体用法：
 * ```ts
 * import type { PiItem, PiTopLine, Relay, RoomInfo } from "@/pi/headless"
 * ```
 * 只允许从 `@/pi/headless` import 这些类型（allowlist：`PI_VARIANT_TYPE_EXPORT_SOURCES`）。
 */

/* transcript / 会话模型：item、block、prose、工具、终端、usage、dialog 卡、队列、会话行 */
export type {
  PiBlock,
  PiImageAddress,
  PiImagePart,
  PiInline,
  PiAssistantItem,
  PiItem,
  PiProseNode,
  PiUserItem,
  PiSendStatus,
  PiToolBlock,
  PiToolState,
  PiToolTaskEntry,
  PiToolDetailEntry,
  PiToolOutcome,
  PiTerminalEntryState,
  PiTerminalItem,
  PiDialogCard,
  PiTaskListItem,
  PiTaskStatus,
  PiUsage,
  PiUsageState,
  PiRemoteQueueSegment,
  PiRemoteQueueStatus,
  PiRemoteQueueImage,
  PiRemoteQueueItem,
  PiRemoteQueueState,
  PiRoom,
  PiDevice,
  PiListedSession,
  PiDeviceSession,
  PiSessionRowData,
  PiSessionGroup,
  PiGrouping,
  PiDensity,
  PiRowMarkerKind,
  PiAttentionKind,
  PiAttentionItem,
  PiModelMeta,
  PiLinkView,
  PiLinkSummary,
} from "@/components/pi/shared/types"

/* App 契约：VariantAppProps 已由 @/pi/variants/types 提供；这里补 PiAppProps / 外壳附加内容 / 布局 */
export type { PiAppProps, PiSessionExtras, PiVariant } from "@/pi/containers/types"

/* relay 数据层类型（值/纯函数直接从 @/relay/** import，类型从这里取也行） */
export type { Device, ListedSession, PendingStart, Relay, RoomInfo, SessionEntry } from "@/relay/useRelay"
export type {
  AgentMessage,
  AssistantEvent,
  Block,
  DividerKind,
  ImagePart,
  Item,
  ItemGroup,
  ItemGroupRole,
  SendImage,
  ToolDisplayFields,
  ToolDisplayState,
  Transcript,
} from "@/relay/transcript"
export type { AttentionDialog, AttentionItem, AttentionKind, AttentionSnapshot, AttentionTurnEnd, AttentionUiPrompt } from "@/relay/attention"

/* pi/model 的视图模型类型（纯函数） */
export type { HistoryLike, PiArchiveLike, PiExpandInput, PiOutboxStreamEntry, PiThinkingClock, PiTopLine } from "@/pi/model/transcriptView"
export type { PiTranscriptWindow } from "@/pi/model/transcriptWindow"
export type { PiDiffLine, PiDiffRows, PiPatchSource } from "@/pi/model/diffRows"
export type { PiChangesView, PiChangedFileView, PiPaneDiffRow, PiFoldRow } from "@/pi/model/changesView"
export type { PiBlockedBy, PiComposerBlock, PiComposerButton, PiComposerButtonVariant } from "@/pi/model/composerButton"
export type { PiComposerStatus, PiComposerViewInput } from "@/pi/model/composerView"
export type { PiLegacyStylePrefs, PiSettingsPrefs, PiSettingsWrite } from "@/pi/model/settingsView"
export type { PiOutboxItemView, PiLocalQueue, PiQueueSection, PiTrayInput, PiTrayItem, PiTrayKind } from "@/pi/model/tray"
export type { PiDialogCardStatus, PiDialogCardView, PiDialogLike, PiDialogReceiptView } from "@/pi/model/dialogCard"
export type { PiLocalAnswer } from "@/pi/model/approvalReceipt"
export type { PiSidebarGroup, PiSidebarModel, PiSidebarRow, PiSidebarSession } from "@/pi/model/sidebarGroups"
export type { HighlightLine, HighlightRoute, HighlightToken } from "@/pi/model/highlight"
export type { PiModelRow } from "@/pi/model/models"
export type { PiRowMarkerShape } from "@/pi/model/rowMarker"
