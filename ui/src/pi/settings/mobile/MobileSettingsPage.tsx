/**
 * 手机端设置 · 独立系统外壳。
 *
 * 结构（board-mobile.png）：
 *   顶栏（返回 + 页标题，安全区内）→ 单列全宽滚动内容 → 底部安全区。
 * 13 个界面 = 设置首页 + 11 页与桌面同名内容 + 「交互」。
 * 首页 → 内容页 / 内容页 → 首页用本地 page state；首页返回 = 退出设置并回原会话。
 *
 * 六套皮肤：根属性同时挂 data-pi-settings / data-pi-settings-style / data-pi-theme，
 * 复用 tokens.css 的 --st-*；Claude 的衬线只作用于顶栏标题与分组标题。
 * 桌面外壳 SettingsPage 与共享 model / context / ui 原子都不改。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react"
import { ChevronLeft } from "lucide-react"
import { openPiDialog, PI_UI_IDS, piDialogOf, type PiContainerProps } from "@/pi/containers/types"
import { useSettingsDialogFocus } from "../dialogFocus.ts"
import { SettingsProvider, useSettingsLocalState } from "../SettingsContext.tsx"
import {
  settingsStyleOf,
  settingsThemeOf,
  type SettingsActions,
  type SettingsPageId,
  type SettingsStyle,
  type SettingsTheme,
  type SettingsThemePref,
} from "../types.ts"
import { MOBILE_SETTINGS_COPY, MOBILE_SETTINGS_PAGE_LABELS, mobileContentPageOf, mobilePageIdOf, type MobileSettingsPageId } from "./types.ts"
import { MobileIndexPage } from "./pages/IndexPage.tsx"
import { GeneralPage } from "./pages/GeneralPage.tsx"
import { ModelPage } from "./pages/ModelPage.tsx"
import { ApprovalPage } from "./pages/ApprovalPage.tsx"
import { ExtensionsPage } from "./pages/ExtensionsPage.tsx"
import { AppearancePage } from "./pages/AppearancePage.tsx"
import { DevicesPage } from "./pages/DevicesPage.tsx"
import { NotificationsPage } from "./pages/NotificationsPage.tsx"
import { ShortcutsPage } from "./pages/ShortcutsPage.tsx"
import { PrivacyPage } from "./pages/PrivacyPage.tsx"
import { UsagePage } from "./pages/UsagePage.tsx"
import { AboutPage } from "./pages/AboutPage.tsx"
import { InteractionPage } from "./pages/InteractionPage.tsx"
import "../tokens.css"
import "../settings.css"
import "./mobile.css"

const CONTENT_COMPONENTS: Record<SettingsPageId | "interaction", ComponentType<{ onPreviewStyle?: (style: SettingsStyle) => void; onPreviewTheme?: (theme: SettingsThemePref) => void }>> = {
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
  interaction: InteractionPage,
}

function systemTheme(): SettingsTheme {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch {
    return "dark"
  }
}

function documentTheme(): SettingsTheme | null {
  try {
    return settingsThemeOf(document.documentElement.dataset.piTheme)
  } catch {
    return null
  }
}

/** 文档主题（宿主会写 <html data-pi-theme>）优先；没有就跟随系统。 */
function useResolvedTheme(): SettingsTheme {
  const [theme, setTheme] = useState<SettingsTheme>(() => documentTheme() ?? systemTheme())
  useEffect(() => {
    const read = () => setTheme(documentTheme() ?? systemTheme())
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-pi-theme"] })
    const media = window.matchMedia?.("(prefers-color-scheme: dark)")
    media?.addEventListener("change", read)
    read()
    return () => {
      observer.disconnect()
      media?.removeEventListener("change", read)
    }
  }, [])
  return theme
}

export interface MobileSettingsPageProps {
  p: PiContainerProps
  /** 六套皮肤之一；不传跟随当前变体（cursor / claude / codex）。 */
  style?: SettingsStyle
  /** 实际明暗；不传读 <html data-pi-theme>，再退系统偏好。 */
  theme?: SettingsTheme
  /** 受控当前页；不传用内部 page state。 */
  page?: MobileSettingsPageId
  /** 初次打开的页（仅非受控时使用），默认首页。 */
  initialPage?: MobileSettingsPageId
  /** 切页通知（受控 / 非受控都会调用）。 */
  onPageChange?: (page: MobileSettingsPageId) => void
  /** 首页返回；默认 p.act.openSession()（回原会话，不新建）。 */
  onExit?: () => void
}

/**
 * Last active mobile settings page, kept at module level for the same
 * reason as the desktop SettingsPage (F1): a UI style switch swaps the
 * whole variant shell and remounts this page, which used to reset it to
 * the index. An explicit `page` / `initialPage` still wins.
 */
let lastMobileSettingsPage: MobileSettingsPageId | null = null

export function MobileSettingsPage({ p, style, theme, page, initialPage, onPageChange, onExit }: MobileSettingsPageProps) {
  const [innerPage, setInnerPage] = useState<MobileSettingsPageId>(() => mobilePageIdOf(page ?? initialPage ?? lastMobileSettingsPage ?? "index"))
  const [previewStyle, setPreviewStyle] = useState<SettingsStyle | null>(null)
  const [previewTheme, setPreviewTheme] = useState<SettingsThemePref | null>(null)
  const [prefs, prefActions] = useSettingsLocalState()
  const documentOrSystemTheme = useResolvedTheme()
  const mainRef = useRef<HTMLElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const activePage = mobilePageIdOf(page ?? innerPage)
  const activeStyle = style ?? previewStyle ?? settingsStyleOf(p.ui.prefs.ui)
  const activeTheme =
    theme ??
    (previewTheme === null
      ? documentOrSystemTheme
      : previewTheme === "system"
        ? systemTheme()
        : previewTheme)
  const contentPage = mobileContentPageOf(activePage)
  const providerPage: SettingsPageId = contentPage ?? "general"

  const navigate = useCallback(
    (next: MobileSettingsPageId) => {
      // Remember the page so a variant-shell remount restores it (F1).
      lastMobileSettingsPage = next
      if (page === undefined) setInnerPage(next)
      onPageChange?.(next)
    },
    [page, onPageChange],
  )

  const exit = useCallback(() => {
    if (onExit) onExit()
    else p.act.openSession()
  }, [onExit, p.act])

  const back = useCallback(() => {
    if (activePage === "index") {
      exit()
      return
    }
    navigate("index")
  }, [activePage, exit, navigate])

  const act = useMemo<SettingsActions>(
    () => ({
      ...prefActions,
      back,
      notify: (text, tone) => p.relay.notify(text, tone),
      openPairing: () => openPiDialog(p, { id: PI_UI_IDS.pairing }),
      openHostDiag: (deviceId) => openPiDialog(p, { id: PI_UI_IDS.hostDiag, arg: deviceId }),
      reconnect: () => p.relay.reconnectNow(),
    }),
    [prefActions, back, p],
  )

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [activePage])

  // 对话框语义（A11Y-01）：打开聚焦返回键、Tab 在本页循环、关闭还焦点给入口。
  // 页面内再开的配对 / 诊断 sheet 更高一层：它们开着时 Esc 交给 sheet，不连关两层。
  useSettingsDialogFocus({
    rootRef,
    initialFocusSelector: ".sm-back",
    onEscape: back,
    escapeBlocked: () => piDialogOf(p) != null || p.ui.paletteOpen || p.ui.menu != null,
  })

  const renderPage = () => {
    if (activePage === "index") return <MobileIndexPage onNavigate={navigate} />
    const Component = CONTENT_COMPONENTS[activePage === "interaction" ? "interaction" : activePage]
    if (activePage === "appearance") {
      return <AppearancePage onPreviewStyle={setPreviewStyle} onPreviewTheme={setPreviewTheme} />
    }
    return <Component />
  }

  return (
    <SettingsProvider p={p} style={activeStyle} theme={activeTheme} page={providerPage} setPage={(next) => navigate(next)} prefs={prefs} act={act}>
      <div
        ref={rootRef}
        className="settings-mobile"
        data-pi-settings=""
        data-pi-settings-mobile=""
        data-pi-settings-style={activeStyle}
        data-pi-theme={activeTheme}
        data-pi-settings-page={activePage}
        data-sm-reduced-motion={prefs.reducedMotion ? "true" : undefined}
        aria-label="设置"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <header className="sm-topbar">
          <button
            type="button"
            className="sm-back"
            aria-label={activePage === "index" ? MOBILE_SETTINGS_COPY.exit : MOBILE_SETTINGS_COPY.back}
            onClick={back}
          >
            <ChevronLeft size={22} strokeWidth={2} aria-hidden="true" />
          </button>
          <h1 className="sm-topbar-title">{MOBILE_SETTINGS_PAGE_LABELS[activePage]}</h1>
        </header>
        <main ref={mainRef} className="sm-main" data-sm-scroll="">
          {renderPage()}
        </main>
      </div>
    </SettingsProvider>
  )
}

export default MobileSettingsPage
