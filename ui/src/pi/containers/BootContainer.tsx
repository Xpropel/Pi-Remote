import { useMemo } from "react"
import { PiNoDevices } from "@/components/pi/shell"
import { PiCenteredState, PiMark } from "@/components/pi/shared"
import { bootInputOf, bootViewOf, connectingText, relayHostOf } from "@/pi/model/boot"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { openPiDialog, PI_UI_IDS, type PiContainerProps } from "./types"

/**
 * 首次加载与空态（plan §7.1 boot-loading / no-devices，a 线）：authed / everConnected / sessionsLoading / devices / rooms / roomId，
 * 口径照旧界面 shell/Shell.tsx 的 firstDataReady（model/boot.ts）：还没连上过时主区只有 Spinner"正在连接 <host>…"，
 * 快照确认前不出现空会话卡（修 U-12）；名册生效而没有设备时是 no-devices（"配对新设备"开 a 的配对弹窗，relay 没声明 device.token 时只写接入说明）；
 * 有设备但都未连接、也没打开会话时写"N 台设备都未连接"。
 * 桌面放在外壳正文；手机放在列表页的正文（首次连接时手机列表页只画骨架行，这里什么都不画）。正常态返回 null。
 * host 口径同 useRelay 的 wsUrl。深链 5 秒规则（mobile/model.ts）归 P6.2。
 */
export function BootContainer(props: PiContainerProps) {
  const { relay, variant } = props
  const phone = variant === "phone"
  const sessionCount = useMemo(
    () => sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice).length,
    [relay.devices, relay.rooms, relay.sessionsByDevice],
  )
  const view = bootViewOf(bootInputOf(relay, sessionCount))
  const pair = () => openPiDialog(props, { id: PI_UI_IDS.pairing })
  switch (view.kind) {
    case "connecting":
      if (phone) return null
      return (
        <div data-pi-boot="connecting" className="flex h-full items-center justify-center pb-16">
          <PiCenteredState
            spinner
            title={<span className="font-normal text-(--cw-pi-text-secondary)">{connectingText(relayHostOf(import.meta.env.VITE_RELAY_URL, location))}</span>}
          />
        </div>
      )
    case "no-devices":
      return phone ? (
        <PiNoDevices variant="phone" pairingSupported={view.pairing} onPair={pair} onGuide={pair} className="w-full px-0" />
      ) : (
        <div data-pi-boot="no-devices" className="flex h-full items-center justify-center pb-16">
          <PiNoDevices variant="desktop" pairingSupported={view.pairing} onPair={pair} onGuide={pair} />
        </div>
      )
    case "all-offline":
      return (
        <div data-pi-boot="all-offline" className={phone ? "w-full" : "flex h-full items-center justify-center pb-16"}>
          <PiCenteredState
            icon={<PiMark size={32} />}
            title={`${view.count} 台设备都未连接`}
            body="在电脑上运行 deploy/attach.sh（Windows：deploy\attach.cmd）打开连接窗口后，会话会出现在这里。"
          />
        </div>
      )
    case "ready":
      return null
  }
}
