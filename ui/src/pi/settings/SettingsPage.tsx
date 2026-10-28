/**
 * 桌面设置页 v2 外壳。
 *
 * 结构照设计册第 1 节：
 *   左栏 260（「设置」标题 / 返回会话 / 11 页签，行高 30、图标 15）
 *   → 内容列 692 水平居中（使用活动 880）
 *   → 右上为页面内容；无窗口控制按钮。
 *
 * 入口：宿主渲染 <SettingsPage p={...} />（设置是全页覆盖层，关闭/返回 = p.act.openSession()）。
 * style / theme 可由宿主显式传入；不传时分别跟随 p.ui.prefs.ui 与当前文档主题。
 * 第二阶段页面不要改这个文件：改对应 pages/*.tsx 即可。
 */
import { useCallback, useMemo, useRef, useState, type ComponentType } from "react"
import { openPiDialog, PI_UI_IDS, piDialogOf, type PiContainerProps } from "@/pi/containers/types"
import { useSettingsDialogFocus } from "./dialogFocus"
import { SettingsProvider, useSettingsLocalState } from "./SettingsContext"
import {
  SETTINGS_PAGES,
  settingsPageIdOf,
  settingsStyleOf,
  settingsThemeOf,
  type SettingsActions,
  type SettingsPageId,
  type SettingsStyle,
  type SettingsTheme,
} from "./types"
import { SettingsBackButton, SettingsIcon } from "./ui"
import { AboutPage } from "./pages/AboutPage"
import { AppearancePage } from "./pages/AppearancePage"
import { ApprovalPage } from "./pages/ApprovalPage"
import { DevicesPage } from "./pages/DevicesPage"
import { ExtensionsPage } from "./pages/ExtensionsPage"
import { GeneralPage } from "./pages/GeneralPage"
import { ModelPage } from "./pages/ModelPage"
import { NotificationsPage } from "./pages/NotificationsPage"
import { PrivacyPage } from "./pages/PrivacyPage"
import { ShortcutsPage } from "./pages/ShortcutsPage"
import { UsagePage } from "./pages/UsagePage"
import "./tokens.css"
import "./settings.css"

const PAGE_COMPONENTS: Record<SettingsPageId, ComponentType> = {
  general: GeneralPage,
  model: ModelPage,
  approval: ApprovalPage,
  extensions: ExtensionsPage,
  appearance: AppearancePage,
  devices: DevicesPage,
  notifications: NotificationsPage,
  shortcuts: ShortcutsPage,
  privacy: PrivacyPage,
  usage: UsagePage,
  about: AboutPage,
}

function themeFromDocument(): SettingsTheme {
  try {
    const attr = document.documentElement.dataset.piTheme
    const theme = settingsThemeOf(attr)
    if (theme) return theme
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch {
    return "light"
  }
}

export interface SettingsPageProps {
  p: PiContainerProps
  /** 六套皮肤之一；不传跟随当前变体（cursor / claude / codex）。 */
  style?: SettingsStyle
  /** 实际明暗；不传读 <html data-pi-theme>，再退系统偏好。 */
  theme?: SettingsTheme
  /** 受控当前页；不传用内部状态。 */
  page?: SettingsPageId
  /** 初次打开的页（仅非受控时使用），默认「通用」。 */
  initialPage?: SettingsPageId
  /** 切页通知（受控 / 非受控都会调用）。 */
  onPageChange?: (page: SettingsPageId) => void
  /** 自定义返回；默认 p.act.openSession()（回原会话，不新建）。 */
  onBack?: () => void
}

export function SettingsPage({ p, style, theme, page, initialPage, onPageChange, onBack }: SettingsPageProps) {
  const [innerPage, setInnerPage] = useState<SettingsPageId>(() => settingsPageIdOf(page ?? initialPage ?? "general"))
  const [documentTheme] = useState<SettingsTheme>(themeFromDocument)
  const activePage = settingsPageIdOf(page ?? innerPage)
  const activeStyle = settingsStyleOf(style ?? p.ui.prefs.ui)
  const activeTheme = theme ?? documentTheme
  const [prefs, prefActions] = useSettingsLocalState()

  const setPage = useCallback(
    (next: SettingsPageId) => {
      if (page === undefined) setInnerPage(next)
      onPageChange?.(next)
    },
    [page, onPageChange],
  )

  const act = useMemo<SettingsActions>(
    () => ({
      ...prefActions,
      back: () => {
        if (onBack) onBack()
        else p.act.openSession()
      },
      notify: (text, tone) => p.relay.notify(text, tone),
      openPairing: () => openPiDialog(p, { id: PI_UI_IDS.pairing }),
      openHostDiag: (deviceId) => openPiDialog(p, { id: PI_UI_IDS.hostDiag, arg: deviceId }),
      reconnect: () => p.relay.reconnectNow(),
    }),
    [prefActions, p, onBack],
  )

  const rootRef = useRef<HTMLDivElement | null>(null)
  // 对话框语义（A11Y-01）：打开聚焦导航首项、Tab 在设置内循环、Esc 回原会话、关闭还焦点给触发器。
  // 设置里再开的配对 / 诊断 / 菜单更高一层：piDialogOf / DOM 检测到它们时不抢 Esc。
  useSettingsDialogFocus({
    rootRef,
    initialFocusSelector: ".settings-nav-item",
    onEscape: act.back,
    escapeBlocked: () => piDialogOf(p) != null || p.ui.paletteOpen || p.ui.menu != null,
  })

  const ActivePage = PAGE_COMPONENTS[activePage]
  const wide = SETTINGS_PAGES.find((entry) => entry.id === activePage)?.wide === true

  return (
    <SettingsProvider
      p={p}
      style={activeStyle}
      theme={activeTheme}
      page={activePage}
      setPage={setPage}
      prefs={prefs}
      act={act}
    >
      <div
        ref={rootRef}
        className="settings-root"
        data-pi-settings=""
        data-pi-settings-style={activeStyle}
        data-pi-theme={activeTheme}
        data-pi-settings-page={activePage}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
      >
        <aside className="settings-rail" aria-label="设置导航">
          <div className="settings-rail-title">设置</div>
          <SettingsBackButton onClick={act.back} />
          <nav className="settings-nav" aria-label="设置页面">
            {SETTINGS_PAGES.map((entry) => {
              const current = entry.id === activePage
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="settings-nav-item"
                  data-settings-page-id={entry.id}
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    if (!current) setPage(entry.id)
                  }}
                >
                  <SettingsIcon name={entry.icon} />
                  <span>{entry.label}</span>
                </button>
              )
            })}
          </nav>
        </aside>
        <main className="settings-main">
          <div className={wide ? "settings-column settings-column--wide" : "settings-column"}>
            <ActivePage />
          </div>
        </main>
      </div>
    </SettingsProvider>
  )
}

export default SettingsPage
