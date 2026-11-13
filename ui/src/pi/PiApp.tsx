import { useEffect, useRef, useState } from "react"
import { PiSettingsHost } from "@/pi/hooks/PiSettingsHost"
import { usePiDevice } from "@/pi/hooks/usePiDevice"
import { usePiTheme } from "@/pi/hooks/usePiTheme"
import { usePiUiState } from "@/pi/hooks/usePiUiState"
import type { PiMobileNavMode } from "@/pi/mobile/types"
import type { PiApprovalGateTier } from "@/pi/model/prefs"
import { PI_UI_IDS } from "@/pi/containers/types"
import { PairLinkLanding } from "@/pi/PairLinkLanding"
import { PiVariantBoundary } from "@/pi/PiVariantBoundary"
import { CursorApp } from "@/pi/variants/cursor/CursorApp"
import type { VariantAppProps } from "@/pi/variants/types"
import { TUNNEL_COPY } from "@/relay/devices"
import { takePairLinkFromLocation } from "@/relay/pairLink"
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
 * 展示树只有一套：CursorApp（PiRoot + PiAppBody），外面包 PiVariantBoundary 兜住渲染异常（不白屏）。
 */
export default function PiApp() {
  const relay = useRelay()
  const device = usePiDevice()
  const [ui, act] = usePiUiState()
  // 二维码设备链接落地（qr-pairing §3.2）：启动时命中 #pair= 就先进落地视图（hash 在取码时已清掉，
  // 码只留在内存里），退出后才进下面的界面树。
  const [pairEntry, setPairEntry] = useState(() => takePairLinkFromLocation())
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
  // E5: device-report adoption dual-write. useRelay rewrites the legacy
  // key (pi_remote_style) itself when a report is adopted; the PiPrefs
  // copy belongs to usePiUiState, so the adopted values are applied
  // here through act.setPref -- the same owner channel as the mobileNav
  // adoption above. A raw localStorage write from the relay side would
  // be clobbered by the next whole-object prefs write-back and would
  // never reach direct readers of ui.prefs. Fields absent from an
  // adoption (their fold protected an in-flight push) are left alone.
  const adoptedSwitches = relay.adoptedSwitches
  const localSwitchPrefsRef = useRef({
    dialogRemoteAnswer: ui.prefs.dialogRemoteAnswer,
    askUserEnabled: ui.prefs.askUserEnabled,
    approvalGateEnabled: ui.prefs.approvalGateEnabled,
    approvalGateTier: ui.prefs.approvalGateTier,
  })
  localSwitchPrefsRef.current = {
    dialogRemoteAnswer: ui.prefs.dialogRemoteAnswer,
    askUserEnabled: ui.prefs.askUserEnabled,
    approvalGateEnabled: ui.prefs.approvalGateEnabled,
    approvalGateTier: ui.prefs.approvalGateTier,
  }
  useEffect(() => {
    if (!adoptedSwitches) return
    const local = localSwitchPrefsRef.current
    if (adoptedSwitches.dialogRemoteAnswer !== undefined && adoptedSwitches.dialogRemoteAnswer !== local.dialogRemoteAnswer) {
      act.setPref("dialogRemoteAnswer", adoptedSwitches.dialogRemoteAnswer)
    }
    if (adoptedSwitches.askUserEnabled !== undefined && adoptedSwitches.askUserEnabled !== local.askUserEnabled) {
      act.setPref("askUserEnabled", adoptedSwitches.askUserEnabled)
    }
    if (adoptedSwitches.approvalGateEnabled !== undefined && adoptedSwitches.approvalGateEnabled !== local.approvalGateEnabled) {
      act.setPref("approvalGateEnabled", adoptedSwitches.approvalGateEnabled)
    }
    if (adoptedSwitches.approvalGateTier !== undefined && adoptedSwitches.approvalGateTier !== local.approvalGateTier) {
      act.setPref("approvalGateTier", adoptedSwitches.approvalGateTier as PiApprovalGateTier)
    }
  }, [adoptedSwitches, act])
  // Room-scoped notices (e.g. the encrypted-room notice) describe the room
  // on screen. Leaving the session view ends that context on desktop and
  // phone alike, so retract them here at the app root: the current room's
  // scope, plus any room-scoped notice that landed late (a crypto_required frame from a
  // background room restore) — swept whenever the visible notice list
  // changes while off the session view. Unscoped (global) notices are
  // untouched.
  useEffect(() => {
    if (ui.view === "session") return
    if (relay.roomId) relay.retractNoticeScope(`room:${relay.roomId}`)
    for (const n of relay.notices ?? []) {
      if (n.scope && n.scope.startsWith("room:")) relay.retractNoticeScope(n.scope)
    }
  }, [ui.view, relay.roomId, relay.notices, relay])
  const theme = usePiTheme(ui.prefs.theme, act)
  const app: VariantAppProps = {
    relay,
    ui,
    act,
    keyboardOpen: device.frame.keyboard,
    theme,
    layout: device.viewport,
    device: device.frame,
  }
  // 免服务器模式 §4.3：页面经 Cloudflare quick tunnel 打开时，顶部居中一条小徽标说明连接方式。
  // 纯前端判定（relay.isViaTunnel 看页面源 hostname），只提示不拦截操作；
  // 落地页（扫隧道二维码链接新设备时先到这里）与主界面都出示。
  const tunnelBadge = relay.isViaTunnel ? (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[90] flex justify-center px-4">
      <span className="rounded-full border border-solid border-(--cw-border) bg-(--cw-surface) px-3 py-1 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary) shadow-lg">
        {TUNNEL_COPY.badge}
      </span>
    </div>
  ) : null
  if (pairEntry) {
    // 成功后「查看设备列表」：先把配对对话框的开态写进 ui 状态，再退落地页——界面树挂载时它就是开的
    const showDevices = () => {
      const overlay = { id: PI_UI_IDS.pairing }
      if (device.viewport === "phone") act.openSheet(overlay)
      else act.openDialog(overlay)
      setPairEntry(null)
    }
    return (
      <>
        {tunnelBadge}
        <PairLinkLanding
          relay={relay}
          initialCode={pairEntry.code}
          onExit={() => setPairEntry(null)}
          onShowDevices={showDevices}
        />
      </>
    )
  }
  return (
    <PiSettingsHost relay={relay} ui={ui} act={act} keyboardOpen={device.frame.keyboard}>
      {tunnelBadge}
      <PiVariantBoundary>
        <CursorApp {...app} />
      </PiVariantBoundary>
    </PiSettingsHost>
  )
}
