import { useEffect, useState } from "react"
import { PiSettingsPage, type PiSettingsAction } from "@/components/pi/composer"
import { PiPhonePage, PiTopBar } from "@/components/pi/shared"
import { playTestSound } from "@/chat/composer/sound"
import { useNow } from "@/pi/hooks/useNow"
import { usePrefsWriter, useSettingsPrefs } from "./cShared"
import { HostDiagContainer } from "./HostDiagContainer"
import { PairingContainer } from "./PairingContainer"
import { openPiDialog, PI_UI_IDS, type PiContainerProps } from "./types"

/**
 * 设置（plan §7.3 settings，c 线）：devices / logout / reconnectNow / serverProto；sound.ts（试听，默认关）、设备行"窗口剩余"（piDuration 整点，部件里）。
 * 偏好走 ui.prefs / act.setPref（model/prefs.ts）；提示音 / 网页回答确认框 / 立即发送的打断方式同时写旧键（style/prefs），
 * 因为 useCompletionSound、useRelay 的 dialog_answer_switch、排队"立即发送"现读的是旧键（model/settingsView.ts）。忙时默认投递 = relay.sendMode（决定 10）。
 * 退出登录要点两次（A02）；页面外通知只写一段说明、不放开关（K13，部件里）；"配对新设备…" / "接入说明与快捷键"开 a 的配对（PI_UI_IDS.pairing）。
 * 设备行 = 设置 › 设备 › 某台 › 诊断（design B07，P5 第 2 轮）：开这台的主机诊断（PI_UI_IDS.hostDiag，arg = 设备 id，./HostDiagContainer.tsx）。
 * 桌面放在外壳正文（ui.view === "settings"），手机是整页（自己的 PiPhonePage，配对、主机诊断的 sheet 也放在这一页）。
 */

/** 服务器地址：网页和 relay 同源（构建时另配 VITE_RELAY_URL 的除外）；拿不到就写"—" */
function relayHostOf(): string {
  try {
    return typeof window !== "undefined" && window.location.host ? window.location.host : "—"
  } catch {
    return "—"
  }
}

/** 退出登录点第一次之后，3 秒内再点才退出 */
const LOGOUT_ARM_MS = 3000

export function SettingsContainer(props: PiContainerProps) {
  const { relay, act, ui, variant } = props
  const now = useNow(1000)
  const prefs = useSettingsPrefs(props)
  const write = usePrefsWriter(props)
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), LOGOUT_ARM_MS)
    return () => window.clearTimeout(timer)
  }, [armed])
  const onAction = (action: PiSettingsAction) => {
    if (action === "logout") {
      if (!armed) setArmed(true)
      else {
        setArmed(false)
        relay.logout()
      }
      return
    }
    if (action === "reconnect") relay.reconnectNow()
    else if (action === "sound-done") playTestSound("done")
    else if (action === "sound-fail") playTestSound("error")
    // "配对新设备…"、"接入说明与快捷键"：都在 a 的配对弹窗里（接入三步、attach 命令、设备管理与撤销）
    else if (action === "pair" || action === "help") openPiDialog(props, { id: PI_UI_IDS.pairing })
    // 设备行：这台的主机诊断（design B07「设置 › 设备 › 某台 › 诊断」）
    else if (action.startsWith("device:")) openPiDialog(props, { id: PI_UI_IDS.hostDiag, arg: action.slice("device:".length) })
  }
  const page = (
    <PiSettingsPage
      variant={variant}
      prefs={prefs}
      devices={relay.devices}
      relayHost={relayHostOf()}
      now={now}
      proto={relay.serverProto ?? null}
      // 网页端没有版本号来源（构建没注入），不写示例值（§1.9）
      version={null}
      deviceId={relay.selectedDeviceId ?? undefined}
      usageRelay={relay}
      mobileNav={ui.prefs.mobileNav}
      onMobileNavChange={(mode) => act.setPref("mobileNav", mode)}
      // 新界面的偏好只存在这个浏览器里（pi_remote_pi_prefs 不走 prefs_set 同步）
      aboutNote="这些设置只保存在这个浏览器里。"
      logoutArmed={armed}
      onPrefsChange={write}
      onAction={onAction}
    />
  )
  if (variant === "phone") {
    return (
      <PiPhonePage
        topBar={<PiTopBar variant="phone-page" title="设置" onBack={() => act.openSession()} />}
        scrollTop={0}
        sheet={
          <>
            <PairingContainer {...props} />
            <HostDiagContainer {...props} />
          </>
        }
      >
        {page}
      </PiPhonePage>
    )
  }
  return page
}
