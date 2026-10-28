/**
 * 设置页 v2 统一入口。
 *
 * 第一阶段冻结：
 *   - 页面 id / 元数据 / 偏好类型 / 状态口径 → types.ts
 *   - 本机存储与纯函数 → model.ts
 *   - Provider / useSettings / 本地 store → SettingsContext.tsx
 *   - 共享原子组件 → ui.tsx
 *   - 桌面外壳 → SettingsPage.tsx
 * 第二阶段页面从各自 pages/*.tsx 实现，不修改外壳与接口。
 */
export * from "./types.ts"
export * from "./model.ts"
export * from "./ui.tsx"
export { SettingsPage, SettingsPage as default } from "./SettingsPage.tsx"
export type { SettingsPageProps } from "./SettingsPage.tsx"
export { SettingsProvider, useSettings, useSettingsLocalState } from "./SettingsContext.tsx"
export type { SettingsProviderProps, UseSettingsLocalStateOptions } from "./SettingsContext.tsx"
export { GeneralPage } from "./pages/GeneralPage.tsx"
export { ModelPage } from "./pages/ModelPage.tsx"
export { ApprovalPage } from "./pages/ApprovalPage.tsx"
export { ExtensionsPage } from "./pages/ExtensionsPage.tsx"
export { AppearancePage } from "./pages/AppearancePage.tsx"
export { DevicesPage } from "./pages/DevicesPage.tsx"
export { NotificationsPage } from "./pages/NotificationsPage.tsx"
export { ShortcutsPage } from "./pages/ShortcutsPage.tsx"
export { PrivacyPage } from "./pages/PrivacyPage.tsx"
export { UsagePage } from "./pages/UsagePage.tsx"
export { AboutPage } from "./pages/AboutPage.tsx"
