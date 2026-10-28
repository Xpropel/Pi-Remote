/** P11 使用活动（sidebar）共享出口：契约 + 纯数据适配 + 本机持久化 + gallery 预设。 */
export * from "./types.ts"
export * from "./model.ts"
export * from "./storage.ts"
export * from "./useSidebarLocal.ts"
export * from "./gallery.ts"
// B1 共享核组件出口（claude-dev 实现）；三套宿主统一从 `@/pi/sidebar` 接入。
export { UnifiedSidebar } from "./UnifiedSidebar"
export type { UnifiedSidebarProps } from "./types.ts"
