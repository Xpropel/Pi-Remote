/**
 * 桌面设置页 v2 外壳。
 *
 * 结构照设计册第 1 节：
 *   左栏 260（「设置」标题 / 返回会话 / 11 页签，行高 30、图标 15）
 *   → 内容列 692 水平居中（使用活动 880）
 *   → 右上为页面内容；无窗口控制按钮。
 *
 * 入口：宿主渲染 <SettingsPage p={...} />（设置是全页覆盖层，关闭/返回 = p.act.openSession()）。
 * theme 可由宿主显式传入；不传时跟随当前文档主题。
 * 第二阶段页面不要改这个文件：改对应 pages/*.tsx 即可。
 */
import { useCallback, useMemo, useRef, useState, type ComponentType } from "react"
import { ArrowUpCircle, RotateCw } from "lucide-react"
import { openPiDialog, PI_UI_IDS, piDialogOf, type PiContainerProps } from "@/pi/containers/types"
import { useNow } from "@/pi/hooks/useNow"
import { useSettingsDialogFocus } from "./dialogFocus"
import { SettingsProvider, useSettings, useSettingsLocalState } from "./SettingsContext"
import { settingsPiRestartBannerOf } from "./pages/settingsPiRestart.ts"
import { settingsPiUpdateRowOf } from "./pages/settingsPiUpdate.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "./pages/useSettingsPiRestart.tsx"
import { SettingsPiUpdateDialog, useSettingsPiUpdate } from "./pages/useSettingsPiUpdate.tsx"
import {
  SETTINGS_PAGES,
  settingsPageIdOf,
  settingsThemeOf,
  type SettingsActions,
  type SettingsPageId,
  type SettingsTheme,
} from "./types"
import { SettingsToast } from "./toast"
import { useSettingsToast } from "./useSettingsToast"
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

/**
 * Last active settings tab, kept at module level so a remount of this page
 * restores it instead of bouncing back to "general" (F1). An explicit
 * `page` / `initialPage` from a host still wins over the remembered tab.
 */
let lastSettingsPage: SettingsPageId | null = null

/**
 * Deep-link entry for other surfaces: preselect the tab the settings
 * page opens on at its next mount (e.g. the encrypted-room guidance in
 * the transcript jumps straight to the devices tab, where the viewer
 * identity is enabled). It only seeds the initial tab -- once the page
 * is open, the user's own navigation takes over as usual.
 */
export function rememberSettingsPage(page: SettingsPageId): void {
  lastSettingsPage = settingsPageIdOf(page)
}

export function SettingsPage({ p, theme, page, initialPage, onPageChange, onBack }: SettingsPageProps) {
  const [innerPage, setInnerPage] = useState<SettingsPageId>(() => settingsPageIdOf(page ?? initialPage ?? lastSettingsPage ?? "general"))
  const [documentTheme] = useState<SettingsTheme>(themeFromDocument)
  const activePage = settingsPageIdOf(page ?? innerPage)
  const activeTheme = theme ?? documentTheme
  const [prefs, prefActions] = useSettingsLocalState()
  const { toast, show: showToast } = useSettingsToast()

  const setPage = useCallback(
    (next: SettingsPageId) => {
      // Remember every tab the user lands on so a remount restores it.
      lastSettingsPage = next
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
      notify: showToast,
      openPairing: () => openPiDialog(p, { id: PI_UI_IDS.pairing }),
      openHostDiag: (deviceId) => openPiDialog(p, { id: PI_UI_IDS.hostDiag, arg: deviceId }),
      reconnect: () => p.relay.reconnectNow(),
    }),
    [prefActions, p, onBack, showToast],
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
        // 恒为 cursor：tokens.css 的颜色块与 settings.css 的焦点环选择器按这个属性命中（去掉会改变优先级）
        data-pi-settings-style="cursor"
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
          <SettingsRailRestart />
        </aside>
        <main className="settings-main">
          <div className={wide ? "settings-column settings-column--wide" : "settings-column"}>
            <ActivePage />
          </div>
        </main>
        <SettingsToast toast={toast} prefix="settings-toast" />
      </div>
    </SettingsProvider>
  )
}

function SettingsRailRestart() {
  const { p, act } = useSettings()
  const restart = useSettingsPiRestart(p.relay, act.notify)
  const piUpdate = useSettingsPiUpdate(p.relay, act.notify, { autoCheck: false })
  const now = useNow(piUpdate.running ? 1000 : 60_000)

  const updateFailed = piUpdate.status.state === "failed" && piUpdate.status.kind === "update_pi"
  const updateAvailable = Boolean(piUpdate.update?.canUpdate && piUpdate.update.latestVersion)
  const showUpdateCard = piUpdate.running || updateFailed || updateAvailable
  const showRestartCard = (restart.pendingRestart || restart.phase === "running" || restart.phase === "failed") && !piUpdate.running

  if (!showUpdateCard && !showRestartCard && !restart.confirmOpen && !piUpdate.confirmOpen) return null

  const updateRow = settingsPiUpdateRowOf({
    target: piUpdate.target,
    checking: piUpdate.checking,
    update: piUpdate.update,
    checkError: piUpdate.checkError,
    status: piUpdate.status,
    otherRunning: restart.running,
    now,
  })
  const updateTone = updateFailed ? "bad" : "warn"
  const updateTitle = piUpdate.running
    ? "正在更新 Pi…"
    : updateFailed
      ? "更新 Pi 失败"
      : `发现 Pi 新版本 ${piUpdate.update?.latestVersion ?? ""}`

  const banner = settingsPiRestartBannerOf({
    pendingRestart: restart.pendingRestart,
    phase: restart.phase,
    error: restart.error,
    canRestart: restart.target.canRestart,
    unsupportedReason: restart.target.reason,
  })
  return (
    <>
      {showUpdateCard ? (
        <div className="settings-rail-restart" data-restart-tone={updateTone} role="status">
          <div className="settings-rail-restart-head">
            <ArrowUpCircle size={13} strokeWidth={2} aria-hidden="true" />
            <span>{updateTitle}</span>
          </div>
          <p className="settings-rail-restart-desc">{updateRow.description}</p>
          <button
            type="button"
            className="settings-rail-restart-btn"
            data-settings-rail-update-btn=""
            disabled={updateRow.disabled}
            title={!piUpdate.target.canRestart ? piUpdate.target.reason : undefined}
            onClick={() => piUpdate.triggerPrimaryAction(restart.running)}
          >
            {updateRow.actionLabel}
          </button>
        </div>
      ) : null}
      {showRestartCard ? (
        <div className="settings-rail-restart" data-restart-tone={banner.tone} role="status">
          <div className="settings-rail-restart-head">
            <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
            <span>{banner.title}</span>
          </div>
          <p className="settings-rail-restart-desc">{banner.description}</p>
          <button
            type="button"
            className="settings-rail-restart-btn"
            data-settings-rail-restart-btn=""
            disabled={banner.buttonDisabled}
            title={!restart.target.canRestart ? restart.target.reason : undefined}
            onClick={restart.requestRestart}
          >
            {banner.buttonLabel}
          </button>
        </div>
      ) : null}
      <SettingsPiUpdateDialog viewport="desktop" piUpdate={piUpdate} />
      <SettingsPiRestartDialog viewport="desktop" restart={restart} />
    </>
  )
}

export default SettingsPage
