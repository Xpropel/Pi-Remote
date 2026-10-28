/**
 * UI 扩展能力层出口（P4.1）：能力元数据 / 扩展 provider 注册与解析 / 禁用态契约 / 变体 hook。
 *
 * 本出口**不导出 mock**：mock 只在 dev 入口按需动态 import（见 `./mock/index.ts`），保证生产包不含 mock 数据与逻辑。
 * 变体 import 边界：`@/pi/extensions` 已加入 `@/pi/headless/allowlist.ts` 的变体允许前缀（只依赖本层契约，不碰 cursor UI）。
 */
export * from "./types"
export * from "./capabilities"
export * from "./disabled"
export * from "./registry"
export * from "./selectors"
export * from "./inventory-map"
export * from "./platform-prefs"
export { usePiUiCapabilities } from "./usePiUiCapabilities"
