import { useMemo, useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { sidebarDataOf } from "@/pi/model/sidebarSource"
import { sessionDeleteErrorText, sessionDeleteRouteOf } from "@/pi/model/sessionMenu"
import { CodexButton, CodexDialog } from "../primitives/primitives"

/**
 * 删除会话对话框（X-08 / P9 B）：三档文案按能力选择（废纸篓可恢复 / 没有废纸篓直接删不可恢复 / 旧 relay 只删设备文件）；
 * 主按钮黑底白字，危险动作焦点默认在「取消」；失败时弹窗不关、按钮行上方红字。逻辑复用 @/pi/model/sessionMenu。
 */
export function CodexDeleteDialog({ p, rowId, onClose }: { p: VariantAppProps; rowId: string; onClose: () => void }) {
  const { relay } = p
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const data = useMemo(
    () =>
      sidebarDataOf({
        devices: relay.devices,
        rooms: relay.rooms,
        sessionsByDevice: relay.sessionsByDevice,
        roomId: relay.roomId,
        dialogs: relay.dialogs,
        uiPrompt: relay.uiPrompt,
        turnEnd: relay.turnEnd,
        roomTurnEnds: relay.roomTurnEnds,
        selectedDevice: relay.selectedDevice,
      }),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.roomId, relay.dialogs, relay.uiPrompt, relay.turnEnd, relay.roomTurnEnds, relay.selectedDevice],
  )
  const row = data.sessions.find((x) => x.id === rowId)
  if (!row) return null
  const device = data.devices.find((d) => d.id === row.deviceId)
  const serverPurge = relay.serverCaps.includes("session.purge")
  const route = sessionDeleteRouteOf(row, relay.rooms, relay.roomId, device, serverPurge)
  const deviceName = device?.name || "这台设备"
  const body = !serverPurge
    ? `「${row.title}」的会话文件会从 ${deviceName} 上删除，没有回收站。服务器上缓存的副本不会跟着删除。`
    : device?.trash
      ? `「${row.title}」会移到 ${deviceName} 的废纸篓，和在 pi 里删除一样。服务器上的记录和副本会一起清除。`
      : `「${row.title}」的会话文件会从 ${deviceName} 上删除，这台设备没有废纸篓，删除后不能恢复。服务器上的记录和副本会一起清除。`
  const confirm = async () => {
    if (pending) return
    setPending(true)
    setError("")
    try {
      if (!row.path || !route.via) throw new Error(route.reason ?? "这个会话现在不能删除")
      await relay.deleteSession({ deviceId: row.deviceId, sessionId: row.id, sessionPath: row.path, roomId: route.roomId ?? "" })
      relay.pushNotice({ level: "success", title: `已从 ${deviceName} 上删除` })
      onClose()
    } catch (e) {
      setError(sessionDeleteErrorText(e))
      setPending(false)
    }
  }
  return (
    <CodexDialog
      title="删除会话"
      danger
      onClose={onClose}
      width={380}
      footer={
        <>
          <CodexButton kind="outline" data-codex-autofocus="" onClick={onClose}>
            取消
          </CodexButton>
          <CodexButton kind="primary" disabled={pending} onClick={() => void confirm()}>
            {pending ? "删除中…" : "删除"}
          </CodexButton>
        </>
      }
    >
      <p className="cx-dialog-text">{body}</p>
      {error ? (
        <p role="alert" className="cx-dialog-error">
          {error}
        </p>
      ) : null}
    </CodexDialog>
  )
}
