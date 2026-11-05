import { useEffect, useMemo, useState } from "react"
import { PiCommandPalette, type PiPaletteBodySection, type PiPaletteRun } from "@/components/pi/composer"
import { paletteBodyHitsOf, PALETTE_RECENT, PI_PALETTE_COMMANDS, paletteOfflineReasonOf, paletteSessionsOf } from "@/pi/model/palette"
import { paletteMatches } from "@/pi/model/composerInput"
import { bodySearchNoteOf, openBodySearchHit, useBodySearch } from "@/pi/hooks/useBodySearch"
import { attentionItemsOf } from "@/relay/attention"
import { sessionLoaded } from "./cShared"
import { openPiDialog, PI_UI_IDS, type PiContainerProps } from "./types"

/**
 * 命令面板（plan §7.3 command-palette，c 线）：所有设备的会话（逐台 mergeDeviceSessions，最多 50 条，没有查询时列最近 4 个）、runCommand、online。
 * 开关在 ui.paletteOpen（⌘K 由外壳的 usePiShellShortcuts 打开，只开这里，D-01；斜杠 /commands、/resume 也开它）；
 * 离线时命令项禁用并写明原因（设置、切换侧栏、开关右 pane 照常可用）；↑↓ 用 aria-activedescendant（部件里）。
 * 桌面放在外壳 overlay 槽（PiOverlay），手机放在 sheet 槽（全高 PiSheet）；关着时什么都不画。
 * 正文匹配（A-3）：查询经 onQueryChange 镜像到本容器，useBodySearch 在选中设备上搜正文
 * （防抖、按 (词, 设备) 作废），命中去掉标题组已列的会话后进「正文匹配 · 设备名」组；
 * 加密房间由中继在命令出口拦下，合并层以部分结果 / 出错文案明示，面板不搜密文。
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
  const [paletteQuery, setPaletteQuery] = useState("")
  useEffect(() => {
    if (!open) setPaletteQuery("")
  }, [open ])
  const bodySearch = useBodySearch(relay, paletteQuery, open)
  const sessions = useMemo(() => {
    if (!open) return []
    const attention = attentionItemsOf({
      currentRoomId: relay.roomId,
      rooms: relay.rooms,
      dialogs: relay.dialogs,
      uiPrompt: relay.uiPrompt,
      turnEnd: relay.turnEnd,
      roomTurnEnds: relay.roomTurnEnds,
      inbox: relay.inbox,
      selectedDevice: relay.selectedDevice,
    })
    return paletteSessionsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, attention, currentRoomId: relay.roomId })
  }, [open, relay.roomId, relay.rooms, relay.dialogs, relay.uiPrompt, relay.turnEnd, relay.roomTurnEnds, relay.inbox, relay.selectedDevice, relay.devices, relay.sessionsByDevice])
  const bodyFullHits = useMemo(() => {
    const { state, deviceId, deviceName } = bodySearch
    if (!open || state.phase !== "done" || deviceId == null) return []
    const titleMatched = sessions.filter((s) => paletteMatches(paletteQuery, s.title, s.group))
    return paletteBodyHitsOf(state.page, { id: deviceId, name: deviceName }, titleMatched.map((s) => ({ id: s.id, path: s.row.path })))
  }, [open, bodySearch, sessions, paletteQuery])
  const body: PiPaletteBodySection | undefined = useMemo(() => {
    const { state, deviceId, deviceName } = bodySearch
    if (!open || state.phase === "idle" || deviceId == null) return undefined
    const label = `正文匹配${deviceName ? ` · ${deviceName}` : ""}`
    if (state.phase === "searching") return { label, hits: [], note: deviceName ? `正在 ${deviceName} 上搜索正文…` : "正在搜索正文…" }
    if (state.phase === "error") return { label, hits: [], note: state.text }
    return { label, hits: bodyFullHits, note: bodySearchNoteOf(state, bodyFullHits.length) ?? undefined }
  }, [open, bodySearch, bodyFullHits])
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
    if (row.kind === "bodyHit") {
      const hit = bodyFullHits.find((h) => h.id === row.id)
      if (hit) openBodySearchHit(relay, hit, () => act.openSession())
      return
    }
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
      body={body}
      onQueryChange={setPaletteQuery}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      onRun={run}
    />
  )
}
