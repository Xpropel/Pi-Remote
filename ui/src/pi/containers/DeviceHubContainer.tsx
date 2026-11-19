import { useMemo } from "react"
import { PiPhonePage } from "@/components/pi/shared"
import { PiDeviceHub } from "@/components/pi/shell"
import type { PiTheme } from "@/components/pi/shared/viewport"
import { bootInputOf, bootViewOf, relayHostOf } from "@/pi/model/boot"
import { deviceHubCardsOf, writeDeviceHubPicked } from "@/pi/model/deviceHub"
import { sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { sidebarIdentityNameOf } from "@/pi/sidebar"
import { NoticeContainer } from "./NoticeContainer"
import { presetNewSession } from "./NewSessionContainer"
import { PairingContainer } from "./PairingContainer"
import { openPiDialog, PI_UI_IDS, type PiAppProps, type PiContainerProps, type PiVariant } from "./types"

/**
 * 登录后设备选择中心容器：
 * - 展示中转服务在线态与每台已接入设备的状态卡；
 * - 选中某台设备后记录本标签页已选择（sessionStorage），若该设备已有活跃房间则直入对话，
 *   否则桌面切至新建会话视图（侧栏保留历史会话列表）、手机切至该设备的会话列表页；
 * - 挂载 PairingContainer 与 NoticeContainer，允许在选设备前直接配对新设备或进设置/退出登录。
 */
export function DeviceHubContainer(props: PiAppProps & { variant: PiVariant; theme?: PiTheme }) {
  const { variant, ...app } = props
  const { relay, act } = app
  const p: PiContainerProps = { ...app, variant }
  const host = relayHostOf(import.meta.env.VITE_RELAY_URL, location)
  const serverName = sidebarIdentityNameOf(relay.serverName, typeof location === "undefined" ? "" : location.hostname)

  const allSessions = useMemo(
    () => sidebarSessionsOf(relay.devices, relay.rooms, relay.sessionsByDevice),
    [relay.devices, relay.rooms, relay.sessionsByDevice],
  )
  const boot = bootViewOf(bootInputOf(relay, allSessions.length))
  const cards = useMemo(
    () =>
      deviceHubCardsOf({
        devices: relay.devices,
        rooms: relay.rooms,
        sessionsByDevice: relay.sessionsByDevice,
        selectedDeviceId: relay.selectedDeviceId ?? null,
      }),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.selectedDeviceId],
  )

  const markPicked = () => writeDeviceHubPicked(true, typeof sessionStorage === "undefined" ? null : sessionStorage)

  const selectDevice = (deviceId: string) => {
    markPicked()
    relay.selectDevice(deviceId)
    if (variant === "phone") {
      const currentOnDevice = Boolean(relay.roomId) && relay.rooms.some((r) => r.id === relay.roomId && r.deviceId === deviceId)
      if (currentOnDevice) {
        act.openSession()
      } else {
        act.setView("session")
        act.setPhonePage("list")
        act.closeDeviceHub()
      }
      return
    }
    const currentOnDevice = Boolean(relay.roomId) && relay.rooms.some((r) => r.id === relay.roomId && r.deviceId === deviceId)
    if (currentOnDevice) {
      act.openSession()
      return
    }
    const liveRoom = relay.rooms.find((r) => r.deviceId === deviceId && r.online && r.id !== relay.lazySession?.id)
    if (liveRoom) {
      relay.selectRoom(liveRoom.id)
      act.openSession()
      return
    }
    const dev = relay.devices.find((d) => d.id === deviceId)
    const devSessions = allSessions.filter((s) => s.deviceId === deviceId)
    if (dev?.online) {
      const folder = dev.projects[0] ?? devSessions[0]?.cwd ?? dev.browseRoots[0] ?? ""
      if (folder) presetNewSession(deviceId, folder)
      act.newSession()
      return
    }
    if (devSessions.length > 0) {
      relay.selectListedSession(devSessions[0])
      act.openSession()
      return
    }
    act.openSession()
  }

  const enterWorkspace = () => {
    markPicked()
    if (variant === "phone") {
      act.setView("session")
      act.setPhonePage(relay.roomId ? "chat" : "list")
      act.closeDeviceHub()
      return
    }
    if (relay.roomId) {
      act.openSession()
      return
    }
    const targetId = relay.selectedDeviceId ?? cards[0]?.id
    if (targetId) {
      selectDevice(targetId)
      return
    }
    act.openSession()
  }

  const hubNode = (
    <PiDeviceHub
      variant={variant}
      relayHost={host}
      serverName={serverName}
      relayOnline={relay.status === "已连接"}
      bootKind={boot.kind}
      pairingSupported={relay.canManageDevices}
      cards={cards}
      onSelectDevice={selectDevice}
      onPairDevice={() => openPiDialog(p, { id: PI_UI_IDS.pairing })}
      onOpenSettings={() => {
        act.openSettings()
      }}
      onEnterWorkspace={cards.length > 0 ? enterWorkspace : undefined}
      onLogout={() => {
        writeDeviceHubPicked(false, typeof sessionStorage === "undefined" ? null : sessionStorage)
        act.closeDeviceHub()
        relay.logout()
      }}
    />
  )

  if (variant === "phone") {
    return (
      <PiPhonePage
        className="pi-hub-surface"
        contentClassName="px-4 pt-5 pb-10"
        notice={relay.notices.length > 0 ? <NoticeContainer {...p} /> : undefined}
        sheet={<PairingContainer {...p} />}
      >
        {hubNode}
      </PiPhonePage>
    )
  }

  return (
    <div className="pi-hub-surface absolute inset-0 overflow-y-auto overscroll-contain">
      {relay.notices.length > 0 && (
        <div
          data-pi-notice-slot=""
          className="pointer-events-none fixed inset-x-0 top-3 z-(--cw-pi-z-raised) flex justify-center px-6"
        >
          <div className="pointer-events-auto max-w-full">
            <NoticeContainer {...p} />
          </div>
        </div>
      )}
      <div className="flex min-h-full items-center justify-center">{hubNode}</div>
      <PairingContainer {...p} />
    </div>
  )
}
