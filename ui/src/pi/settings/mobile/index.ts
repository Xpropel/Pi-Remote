/**
 * 手机端设置 · 统一入口（独立系统）。
 *
 * 宿主（手机外壳 / 设置容器）只挂 <MobileSettingsPage p={p} />，例如：
 *   if (ui.view === "settings") return <MobileSettingsPage p={p} />;
 * 需要固定皮肤时传 style / theme；需要深链时传 page / onPageChange。
 * 首页返回默认调用 p.act.openSession()，回到原会话（不新建）。
 *
 * 本阶段按任务边界只新增 mobile/**，没有改 PhoneApp / SettingsContainer / 桌面 SettingsPage；
 * 宿主接线由 Lead 在手机设置路由处完成。
 */
import "./mobile.css"

export { MobileSettingsPage, MobileSettingsPage as default } from "./MobileSettingsPage.tsx"
export type { MobileSettingsPageProps } from "./MobileSettingsPage.tsx"
export * from "./types.ts"
export * from "./model.ts"
export { MobileIndexPage } from "./pages/IndexPage.tsx"
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
export { InteractionPage } from "./pages/InteractionPage.tsx"
