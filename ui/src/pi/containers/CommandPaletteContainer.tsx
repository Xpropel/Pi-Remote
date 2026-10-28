import { useMemo } from "react"
import { PiCommandPalette, type PiPaletteRun } from "@/components/pi/composer"
import { PALETTE_RECENT, PI_PALETTE_COMMANDS, paletteOfflineReasonOf, paletteSessionsOf } from "@/pi/model/palette"
import { attentionItemsOf } from "@/relay/attention"
import { sessionLoaded } from "./cShared"
import { openPiDialog, PI_UI_IDS, type PiContainerProps } from "./types"

/**
 * 命令面板（plan §7.3 command-palette，c 线）：所有设备的会话（逐台 mergeDeviceSessions，最多 50 条，没有查询时列最近 4 个）、runCommand、online。
 * 开关在 ui.paletteOpen（⌘K 由外壳的 usePiShellShortcuts 打开，只开这里，D-01；斜杠 /commands、/resume 也开它）；
 * 离线时命令项禁用并写明原因（设置、切换侧栏、开关右 pane 照常可用）；↑↓ 用 aria-activedescendant（部件里）。
 * 桌面放在外壳 overlay 槽（PiOverlay），手机放在 sheet 槽（全高 PiSheet）；关着时什么都不画。
 */

/** 命令 → 弹窗家族 */
const COMMAND_DIALOG: Record<string, string> = {
  compact: PI_UI_IDS.compact,
  regenerate: PI_UI_IDS.regenerate,
  tree: PI_UI_IDS.tree,
  usage: PI_UI_IDS.usage,
  inspect: PI_UI_IDS.inspect,
}

export function CommandPaletteContainer(props: PiContainerProps) {
  const { relay, ui, act, variant } = props
  const open = ui.paletteOpen
  const sessions = useMemo(() => {
    if (!open) return []
    const attention = attentionItemsOf({
      currentRoomId: relay.roomId,
      rooms: relay.rooms,
      dialogs: relay.dialogs,
      uiPrompt: relay.uiPrompt,
      turnEnd: relay.turnEnd,
      roomTurnEnds: relay.roomTurnEnds,
      selectedDevice: relay.selectedDevice,
    })
    return paletteSessionsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, attention, currentRoomId: relay.roomId })
  }, [open, relay.roomId, relay.rooms, relay.dialogs, relay.uiPrompt, relay.turnEnd, relay.roomTurnEnds, relay.selectedDevice, relay.devices, relay.sessionsByDevice])
  if (!open) return null
  const reason = paletteOfflineReasonOf({
    authed: relay.authed,
    browserOnline: relay.browserOnline,
    roomId: relay.roomId,
    online: relay.online,
    loaded: sessionLoaded(relay),
    deviceName: relay.selectedDevice?.name,
  })
  const close = () => act.setPaletteOpen(false)
  const run = (row: PiPaletteRun) => {
    close()
    if (row.kind === "session") {
      const hit = sessions.find((s) => s.id === row.id)
      if (!hit) return
      if (hit.row.openable) relay.selectRoom(hit.id)
      else {
        // 未载入 / 别的设备上的会话：先切到它的设备，再按列表行打开（不启动，发第一条时载入）
        if (relay.selectedDeviceId !== hit.deviceId) relay.selectDevice(hit.deviceId)
        relay.selectListedSession(hit.row)
      }
      act.openSession()
      return
    }
    const dialog = COMMAND_DIALOG[row.key]
    if (dialog) openPiDialog(props, { id: dialog, arg: relay.roomId })
    else if (row.key === "new") act.newSession()
    else if (row.key === "sidebar") act.toggleSidebar()
    else if (row.key === "pane") act.togglePane()
    else if (row.key === "settings") act.openSettings()
  }
  return (
    <PiCommandPalette
      variant={variant}
      commands={[...PI_PALETTE_COMMANDS]}
      sessions={sessions}
      recentLimit={PALETTE_RECENT}
      offline={reason != null}
      offlineReason={reason ?? undefined}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      onRun={run}
    />
  )
}
