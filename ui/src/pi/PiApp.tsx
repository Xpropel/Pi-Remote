import { Suspense, useEffect, useRef } from "react"
import { PiSettingsHost } from "@/pi/hooks/PiSettingsHost"
import { usePiDevice } from "@/pi/hooks/usePiDevice"
import { usePiTheme } from "@/pi/hooks/usePiTheme"
import { usePiUiState } from "@/pi/hooks/usePiUiState"
import type { PiMobileNavMode } from "@/pi/mobile/types"
import { PiVariantBoundary } from "@/pi/PiVariantBoundary"
import { PiVariantLoading, piVariantDefOf, type VariantAppProps } from "@/pi/variants"
import { useRelay } from "@/relay/useRelay"
import "@/pi/styles/privacy.css"

/**
 * 新界面入口（index.html，P7 B1 起；plan §7.0、P5.3、P5.7）：useRelay() 只在这里调用一次；界面状态 usePiUiState 也在这里（桌面 / 手机切换时不丢）。
 * 没有 token → 登录，否则按 1024 断点进桌面 / 手机外壳（PiAppBody，开发画廊的 #/live 用同一个）。
 * 注意力外显（P5.7）：标题前缀、完成角标、提示音仍复用旧界面的三个 hook，但改由 PiSettingsHost 统一接线：
 * 它读设置页 v2 的本机偏好（pi_remote_pi_settings_v2），按通知开关 / 仅页面外 / 总是 / 角标 / 提示音 / 隐私模式
 * 决定发不发；同时消费默认设备、快捷键与隐私模式。P9 的「等你回答」派生仍在 host 里（attentionItemsOf 唯一出口）。
 * P6.1（p6-base）：PiRoot 走产品模式（device = usePiDevice()：1024 断点 + useMobileViewport 的键盘与可视视口；
 * 安全区取 env()、根高 100dvh，见 PiRoot / pi-theme.css）；keyboardOpen 交给容器树。
 * P6.4（a 线）：主题 = usePiTheme(prefs.theme)：首帧由 index.html 的脚本按同一条规则写好，这里接手（设置里改了立刻生效，跟随系统时跟 matchMedia）。
 *
 * P1 架构线（PI-UI-REFS，`.agents/tasks/pi-ui-refs-2026-10-26/brief.md` §架构契约 3）：在 useRelay / usePiUiState / usePiTheme
 * 之后按 prefs.ui 选入口。`useRelay` 只调这一次，切换变体只换下面的展示树 —— 连接、room、草稿等 relay 状态都保留，不重连、不丢数据。
 * cursor 走现有 PiRoot + PiAppBody（variants/cursor/CursorApp.tsx，静态 import、不过 lazy，外观/行为不变）；
 * claude / codex 用 React.lazy（variants/index.ts），首次切到时才拉 chunk，加载期由 PiVariantLoading 占位。
 * 根元素 data-pi-ui="<id>" 由各变体根节点（PiRoot 的 ui 参数）写，见 brief §架构契约 6。
 */
export default function PiApp() {
  const relay = useRelay()
  const device = usePiDevice()
  const [ui, act] = usePiUiState()
  // P11 prefs-sync（additive）：mobileNav 跨设备跟随账号。
  // 1) 采用服务端值（旧 relay = null 不覆盖本地）；采用后记入 lastPushed，避免回声回发。
  // 2) 本地值变化且已认证 → 上行 {mobileNav}；首连无服务端记录时以本地值 seed。
  const lastPushedNav = useRef<PiMobileNavMode | null>(null)
  /** 已采用过的服务端值：只在服务端值变化时采用，避免把用户刚改的本地值又打回旧服务端值。 */
  const lastAdoptedNav = useRef<PiMobileNavMode | null>(null)
  const localNavRef = useRef<PiMobileNavMode>(ui.prefs.mobileNav)
  localNavRef.current = ui.prefs.mobileNav
  const syncedNav = relay.syncedMobileNav
  useEffect(() => {
    if (!syncedNav || syncedNav === lastAdoptedNav.current) return
    lastAdoptedNav.current = syncedNav
    if (localNavRef.current === syncedNav) {
      lastPushedNav.current = syncedNav
      return
    }
    lastPushedNav.current = syncedNav
    act.setPref("mobileNav", syncedNav)
  }, [syncedNav, act])
  useEffect(() => {
    if (!relay.authed) return
    const value = ui.prefs.mobileNav
    if (lastPushedNav.current === value) return
    lastPushedNav.current = value
    relay.pushMobileNav(value)
  }, [relay.authed, relay.pushMobileNav, ui.prefs.mobileNav])
  const theme = usePiTheme(ui.prefs.theme, act)
  // 首帧脚本（index.html）为避免闪 cursor，按 pi_remote_pi_prefs.ui 预写了 <html data-pi-ui> 和该变体的 S0 临时底色（Lead 裁决 Q2）。
  // React 接管后以偏好为准：__PI_UI_READY__ 让首帧脚本不再写；data-pi-ui 跟着 prefs.ui 走（<html> 上也留一份，portal 的浮层能被
  // 变体 CSS 作用域命中）；临时底色交给变体 CSS / PiRoot（主题变了也清一次，避免首帧脚本在系统主题切换时又写回来）。
  useEffect(() => {
    const root = document.documentElement
    const scope = window as Window & { __PI_UI_READY__?: boolean }
    scope.__PI_UI_READY__ = true
    root.setAttribute("data-pi-ui", ui.prefs.ui)
    root.style.removeProperty("background-color")
  }, [ui.prefs.ui, theme])
  // 变体注册表：id → 入口组件（cursor 同步、claude/codex 惰性）；非法 / 缺失的 prefs.ui 已在迁移时回落 cursor
  const variant = piVariantDefOf(ui.prefs.ui)
  const Variant = variant.Component
  const app: VariantAppProps = {
    relay,
    ui,
    act,
    keyboardOpen: device.frame.keyboard,
    theme,
    layout: device.viewport,
    device: device.frame,
  }
  return (
    <PiSettingsHost relay={relay} ui={ui} act={act} keyboardOpen={device.frame.keyboard}>
      <PiVariantBoundary variant={variant.id} onFallback={() => act.setUiVariant("cursor")}>
        <Suspense fallback={<PiVariantLoading variant={variant.id} />}>
          <Variant {...app} />
        </Suspense>
      </PiVariantBoundary>
    </PiSettingsHost>
  )
}
