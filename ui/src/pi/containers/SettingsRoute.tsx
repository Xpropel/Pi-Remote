import { SettingsPage, settingsStyleOf, settingsThemeOf, type SettingsTheme } from "@/pi/settings"
import { MobileSettingsPage } from "@/pi/settings/mobile"
import type { PiContainerProps } from "./types"
import { HostDiagContainer } from "./HostDiagContainer"
import { PairingContainer } from "./PairingContainer"

/**
 * Cursor 宿主的统一设置页 v2 路由（桌面 / 手机共用）。
 *
 * - 桌面：整页覆盖层 SettingsPage（左栏 260 + 11 页），style 跟随 prefs.ui，theme 由 CursorApp 传入；
 * - 手机：独立系统 MobileSettingsPage（13 页，单列触控），主题 / 皮肤由 mobile 壳自己解析
 *   （读 <html data-pi-theme> 与 prefs.ui），这里补挂配对 / 主机诊断浮层——
 *   设置页是整页推入，手机外壳的 sheet 槽不在这一页，旧 SettingsContainer 也是把这两个容器
 *   放在自己的 PiPhonePage sheet 槽里的（行为对齐，避免「配对新设备」点了没反应）。
 *
 * 设置页内部实现不改；本文件只做宿主接线。旧 SettingsContainer / PiSettingsPage 保留给未迁移入口与回归测试。
 */
export function SettingsRoute({ p, theme }: { p: PiContainerProps; theme?: SettingsTheme }) {
  if (p.variant === "phone") {
    return (
      <>
        <MobileSettingsPage p={p} />
        <PairingContainer {...p} />
        <HostDiagContainer {...p} />
      </>
    )
  }
  return <SettingsPage p={p} style={settingsStyleOf(p.ui.prefs.ui)} theme={theme ?? themeFromDocument()} />
}

/** 产品入口由 CursorApp 显式传 theme；开发画廊 / 静态预览没传时读宿主写在 <html> 上的主题，再退系统偏好。 */
function themeFromDocument(): SettingsTheme {
  try {
    return (
      settingsThemeOf(document.documentElement.dataset.piTheme) ??
      (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    )
  } catch {
    return "light"
  }
}
