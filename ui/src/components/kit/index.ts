// kit 总出口（ui/ 版，实施计划 §4.1、P2.2）：最初由 R2/tools/import-replica.mjs 生成，从 replica 的 kit/index.ts 过滤而来，
// 只留搬进 ui/ 的文件的出口；replica 里不搬的（stage、SplitPaneLayout、AgentRow、Composer 等）去掉了。
// P9 C（2026-10-26）起 import-replica.mjs 已冻结：Submenu 是手搬进来的（按设备选文件夹的两级菜单），这一行出口也手加。
// 提升进 kit 的 5 个章节件不从这里出，一律按直接路径引用（§4.3）：ModelExplainerCard、SuggestionPills 自己 import 本文件，放进来会循环引用。
// 图标不从这里出（lucide 有 Pill / Code / Sidebar 等同名图标），一律 import … from "@/components/kit/icons"。
// 各 family 的内部辅助（shared.ts / styles.ts / util.ts）不对外导出。
// chrome
export * from "./chrome/SidebarHeader"
export * from "./chrome/TitleBar"
export * from "./chrome/PaneTabBar"
// sidebar
export * from "./sidebar/Sidebar"
export * from "./sidebar/SidebarNavRow"
export * from "./sidebar/SidebarGroupHeader"
export * from "./sidebar/AgentStatusMarker"
// menu
export * from "./menu/MenuSurface"
export * from "./menu/MenuItem"
export * from "./menu/MenuLabel"
export * from "./menu/MenuSeparator"
export * from "./menu/MenuSearch"
export * from "./menu/Submenu"
// controls
export * from "./controls/Pill"
export * from "./controls/DiffStat"
export * from "./controls/RoundIconButton"
export * from "./controls/Button"
export * from "./controls/GhostIconButton"
export * from "./controls/KbdHint"
export * from "./controls/Switch"
export * from "./controls/Checkbox"
export * from "./controls/Spinner"
// stream
export * from "./stream/ChatColumn"
export * from "./stream/UserMessage"
export * from "./stream/AgentProse"
export * from "./stream/CodeChip"
export * from "./stream/FileChip"
export * from "./stream/InlineLink"
export * from "./stream/ReceiptLine"
export * from "./stream/ToolLine"
export * from "./stream/ThinkingBlock"
export * from "./stream/MediaImage"
// diff
export * from "./diff/SyntaxHighlight"
export type { SyntaxLang, SyntaxKind, SyntaxToken, SyntaxLine, TokenizeOptions } from "./diff/syntax"
export type * from "./diff/types"
export * from "./diff/UnifiedDiff"
export * from "./diff/InlineDiffCard"
export * from "./diff/UnmodifiedLinesBar"
export * from "./diff/ChangesSummaryRow"
export * from "./diff/DiffFileRow"
export * from "./diff/DiffFileSection"
export * from "./diff/FileTypeIcon"
// composer
export * from "./composer/TextSelector"
