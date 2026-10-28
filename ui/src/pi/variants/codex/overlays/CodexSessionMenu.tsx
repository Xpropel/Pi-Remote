import { useMemo } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { sidebarDataOf } from "@/pi/model/sidebarSource"
import { sessionDeleteRouteOf, sessionMenuOf } from "@/pi/model/sessionMenu"
import { copyToClipboard } from "../logic/view"
import { CX_OVERLAY, copyText } from "../hooks/useCodex"
import { useCodexCapability } from "../logic/capability"
import { CodexMenu, type CodexMenuItem } from "./CodexMenu"

/**
 * 会话菜单（[X-图9] / 推导）：打开 / 重命名 / 复制会话 ID / 复制工作目录 / 删除（置灰原因来自 @/pi/model/sessionMenu）。
 * 呈现自写（不 import SessionMenuContainer / PiSessionMenu）。
 */
export function CodexSessionMenu({
  p,
  rowId,
  at,
  onClose,
  onRename,
  onDelete,
}: {
  p: VariantAppProps
  rowId: string
  at: { x: number; y: number }
  onClose: () => void
  onRename: (rowId: string) => void
  onDelete: (rowId: string) => void
}) {
  const { relay, act } = p
  const pinCap = useCodexCapability("session-pin")
  const pinned = (pinCap.data?.pinned ?? []).some((pin) => pin.sessionId === rowId)
  const row = useMemo(
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
      }).sessions.find((x) => x.id === rowId),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.roomId, relay.dialogs, relay.uiPrompt, relay.turnEnd, relay.roomTurnEnds, relay.selectedDevice, rowId],
  )
  if (!row) return null
  const device = relay.devices.find((d) => d.id === row.deviceId)
  const serverPurge = relay.serverCaps.includes("session.purge")
  const route = sessionDeleteRouteOf(row, relay.rooms, relay.roomId, device, serverPurge)
  const model = sessionMenuOf({
    row: { id: row.id, openable: row.openable, path: row.path, cwd: row.cwd },
    currentRoomId: relay.roomId,
    lazySessionId: relay.lazySession?.id ?? null,
    authed: relay.authed,
    online: relay.online,
    busy: relay.busy,
    deviceMode: relay.deviceMode,
    deviceOnline: !!device?.online,
    onSelectedDevice: row.deviceId === relay.selectedDeviceId,
    deleteRoute: route,
  })
  const items: CodexMenuItem[] = [
    { key: "open", label: row.openable ? "打开会话" : "启用会话" },
    { key: "rename", label: "重命名…", disabled: model.items.rename.disabled, reason: model.items.rename.reason },
    { key: "copy-id", label: "复制会话 ID" },
    { key: "copy-cwd", label: "复制工作目录", disabled: !row.cwd, reason: model.items["copy-cwd"]?.reason },
    {
      key: "pin",
      label: pinned ? "取消置顶" : "置顶会话",
      disabled: !pinCap.interactive,
      reason: pinCap.view?.reason,
    },
    { key: "delete", label: "删除…", danger: true, disabled: model.items.delete.disabled, reason: model.items.delete.reason },
  ]
  const pick = (key: string, event: { shiftKey?: boolean } = {}) => {
    const k = (event as { key?: string }).key
    void k
    onClose()
    switch (key) {
      case "open": {
        if (row.id !== relay.roomId) {
          if (row.deviceId && row.deviceId !== relay.selectedDeviceId) relay.selectDevice(row.deviceId)
          if (row.openable) relay.selectRoom(row.id)
          else relay.selectListedSession(row)
        }
        act.openSession()
        return
      }
      case "rename":
        onRename(row.id)
        return
      case "delete":
        onDelete(row.id)
        return
      case "copy-id":
        void copyToClipboard(relay, row.id, "已复制会话 ID")
        return
      case "copy-cwd":
        if (row.cwd) void copyToClipboard(relay, row.cwd, "已复制工作目录")
        return
      case "pin":
        if (pinCap.actions?.togglePin) {
          pinCap.actions.togglePin(row.id)
          relay.notify(pinned ? "已取消置顶（模拟演示）" : "已置顶（模拟演示）")
        }
        return
    }
  }
  return <CodexMenu at={at} items={items} label="会话菜单" onPick={(key) => pick(key)} onClose={onClose} />
}

export { CX_OVERLAY, copyText }
