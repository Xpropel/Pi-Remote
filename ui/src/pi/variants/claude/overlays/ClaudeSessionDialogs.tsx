import { useMemo, useState } from "react"
import type { PiContainerProps } from "@/pi/containers/types"
import { sessionDeleteErrorText, sessionDeleteRouteOf, sessionMenuOf, type PiSessionMenuKey } from "@/pi/model/sessionMenu"
import { deviceErrorText } from "@/relay/devices"
import { sidebarDataFor } from "../model/view"
import { copyText } from "../model/logic"
import { ClaudeButton, ClaudeDialog, ClaudeField, ClaudeMenu, ClaudeMenuItem, ClaudeMenuSeparator, ClaudeSheet } from "../primitives/ClaudePrimitives"
import { useMenuClose } from "../primitives/useClaude"
import { CLAUDE_OVERLAY } from "./ids"

/**
 * Claude v2 自有会话菜单 / 删除 / 改名（P9 B 功能锚点）：
 * 菜单项可用性与删除路由此刻由 @/pi/model/sessionMenu 纯函数计算（允许复用逻辑），渲染与交互全部自有。
 * 删除三档文案（可恢复 / 直接删 / 旧 relay 只删设备）按能力选择，逐字口径同产品（P9 B）。
 */

function useMenuTarget(p: PiContainerProps, rowId: string | undefined) {
  return useMemo(() => {
    const data = sidebarDataFor(p.relay)
    const row = rowId ? data.sessions.find((s) => s.id === rowId) : undefined
    if (!row) return null
    const device = data.devices.find((d) => d.id === row.deviceId)
    const serverPurge = p.relay.serverCaps.includes("session.purge")
    const deleteRoute = sessionDeleteRouteOf(row, p.relay.rooms, p.relay.roomId, device, serverPurge)
    const model = sessionMenuOf({
      row: { id: row.id, openable: row.openable, path: row.path, cwd: row.cwd },
      currentRoomId: p.relay.roomId,
      lazySessionId: p.relay.lazySession?.id ?? null,
      authed: p.relay.authed,
      online: p.relay.online,
      busy: p.relay.busy,
      deviceMode: p.relay.deviceMode,
      deviceOnline: !!device?.online,
      onSelectedDevice: row.deviceId === p.relay.selectedDeviceId,
      deleteRoute,
    })
    return { row, device, model, deleteRoute, serverPurge }
  }, [p, rowId])
}

/** 桌面：行尾「…」下拉里的会话菜单（在行的 ClaudeMenu 里用） */
export function ClaudeSessionMenuItems({ p, rowId, phone = false }: { p: PiContainerProps; rowId: string; phone?: boolean }) {
  const target = useMenuTarget(p, rowId)
  const close = useMenuClose()
  const { act, relay } = p
  if (!target) return null
  const items = target.model.items
  const open = (id: string) => () => {
    close()
    if (phone) act.openSheet({ id, arg: rowId })
    else act.openDialog({ id, arg: rowId })
  }
  const run = (key: PiSessionMenuKey) => {
    close()
    if (key === "open") {
      if (target.row.openable) relay.selectRoom(target.row.id)
      else {
        if (target.row.deviceId !== relay.selectedDeviceId) relay.selectDevice(target.row.deviceId)
        relay.selectListedSession(target.row)
      }
      act.openSession()
    } else if (key === "copy-id") copyText(relay, target.row.id, "已复制会话 ID")
    else if (key === "copy-cwd" && target.row.cwd) copyText(relay, target.row.cwd, "已复制工作目录")
    else if (key === "rename") open(CLAUDE_OVERLAY.rename)()
    else if (key === "delete") open(CLAUDE_OVERLAY.delete)()
  }
  return (
    <>
      <ClaudeMenuItem disabled={items.open.disabled} hint={items.open.reason} onClick={() => run("open")}>
        打开会话
      </ClaudeMenuItem>
      <ClaudeMenuItem disabled={items.rename.disabled} hint={items.rename.reason} onClick={() => run("rename")}>
        重命名…
      </ClaudeMenuItem>
      <ClaudeMenuSeparator />
      <ClaudeMenuItem onClick={() => run("copy-id")}>复制会话 ID</ClaudeMenuItem>
      <ClaudeMenuItem disabled={items["copy-cwd"].disabled} hint={items["copy-cwd"].reason} onClick={() => run("copy-cwd")}>
        复制工作目录
      </ClaudeMenuItem>
      <ClaudeMenuSeparator />
      <ClaudeMenuItem danger disabled={items.delete.disabled} hint={items.delete.reason} onClick={() => run("delete")}>
        删除…
      </ClaudeMenuItem>
    </>
  )
}

/** 桌面会话菜单（标题栏胶囊点开；锚定在胶囊下方） */
export function ClaudeSessionMenuTrigger({ p, children }: { p: PiContainerProps; children: Parameters<typeof ClaudeMenu>[0]["trigger"] }) {
  const { relay } = p
  const head = useMemo(() => sidebarDataFor(relay).sessions.find((s) => s.id === relay.roomId), [relay])
  return (
    <ClaudeMenu trigger={children} width={230} align="center">
      {relay.roomId ? <ClaudeSessionMenuItems p={p} rowId={relay.roomId} /> : <p className="claude-menu-note">还没有打开的会话</p>}
      {head ? <p className="claude-menu-note">{head.messageCount > 0 ? `${head.messageCount} 条消息` : ""}</p> : null}
    </ClaudeMenu>
  )
}

/** 手机：会话菜单 sheet（ui.sheet?.id === sessionMenu） */
export function ClaudeSessionMenuSheet({ p }: { p: PiContainerProps }) {
  const { ui, act } = p
  const rowId = ui.sheet?.id === CLAUDE_OVERLAY.sessionMenu ? ui.sheet.arg : undefined
  if (!rowId) return null
  return (
    <ClaudeSheet title="会话" onClose={() => act.closeSheet()}>
      <div className="claude-sheet-menu">
        <ClaudeSessionMenuItems p={p} rowId={rowId} phone />
      </div>
    </ClaudeSheet>
  )
}

/** 删除确认（桌面 ui.dialog / 手机 ui.sheet 都可能） */
export function ClaudeDeleteDialog({ p }: { p: PiContainerProps }) {
  const { ui, act } = p
  const dialogId = ui.dialog?.id === CLAUDE_OVERLAY.delete ? ui.dialog.arg : ui.sheet?.id === CLAUDE_OVERLAY.delete ? ui.sheet.arg : undefined
  const target = useMenuTarget(p, dialogId)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  if (!dialogId || !target) return null
  const close = () => {
    if (ui.sheet?.id === CLAUDE_OVERLAY.delete) act.closeSheet()
    else act.closeDialog()
  }
  const deviceName = target.device?.name || "这台设备"
  const title = target.row.title
  const trash = !!target.device?.trash
  const body = !target.serverPurge
    ? `「${title}」的会话文件会从 ${deviceName} 上删除，没有回收站。服务器上缓存的副本不会跟着删除。`
    : trash
      ? `「${title}」会移到 ${deviceName} 的废纸篓，和在 pi 里删除一样。服务器上的记录和副本会一起清除。`
      : `「${title}」的会话文件会从 ${deviceName} 上删除，这台设备没有废纸篓，删除后不能恢复。服务器上的记录和副本会一起清除。`
  const confirm = async () => {
    if (pending) return
    if (target.model.items.delete.disabled || !target.row.path || !target.deleteRoute.via) {
      setError(target.model.items.delete.reason ?? "这个会话现在不能删除")
      return
    }
    setPending(true)
    setError("")
    try {
      const data = await p.relay.deleteSession({ deviceId: target.row.deviceId, sessionId: target.row.id, sessionPath: target.row.path, roomId: target.deleteRoute.roomId ?? "" })
      p.relay.pushNotice({ level: "success", title: data?.method === "trash" ? `已移到 ${deviceName} 的废纸篓` : `已从 ${deviceName} 上删除` })
      close()
    } catch (e) {
      setError(sessionDeleteErrorText(e))
      setPending(false)
    }
  }
  const footer = (
    <>
      <ClaudeButton kind="outline" onClick={close} data-autofocus="">
        取消
      </ClaudeButton>
      <ClaudeButton kind="danger" disabled={pending} onClick={() => void confirm()}>
        {pending ? "删除中…" : "删除"}
      </ClaudeButton>
    </>
  )
  const content = (
    <>
      <p className="claude-dialog-text">{body}</p>
      {error ? (
        <p className="claude-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
  if (ui.sheet?.id === CLAUDE_OVERLAY.delete) {
    return (
      <ClaudeSheet title="删除会话" onClose={close} footer={footer}>
        {content}
      </ClaudeSheet>
    )
  }
  return (
    <ClaudeDialog title="删除会话" danger onClose={close} footer={footer} width={380}>
      {content}
    </ClaudeDialog>
  )
}

/** 改名（桌面 ui.dialog / 手机 ui.sheet） */
export function ClaudeRenameDialog({ p }: { p: PiContainerProps }) {
  const { ui, act } = p
  const dialogId = ui.dialog?.id === CLAUDE_OVERLAY.rename ? ui.dialog.arg : ui.sheet?.id === CLAUDE_OVERLAY.rename ? ui.sheet.arg : undefined
  const target = useMenuTarget(p, dialogId)
  const [value, setValue] = useState(target?.row.title ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  if (!dialogId || !target) return null
  const close = () => {
    if (ui.sheet?.id === CLAUDE_OVERLAY.rename) act.closeSheet()
    else act.closeDialog()
  }
  const save = async () => {
    const name = value.trim()
    if (!name || saving) return
    setSaving(true)
    setError("")
    try {
      if (target.model.active) await p.relay.runCommand("set_session_name", { name })
      else if (target.row.path) await p.relay.renameSessionFile(target.row.path, name)
      else throw new Error("这个会话没有文件路径")
      p.relay.pushNotice({ level: "success", title: "已修改会话名" })
      close()
    } catch (e) {
      setError(deviceErrorText(e))
      setSaving(false)
    }
  }
  const quick = ["", "前端修复", "文档整理", "数据处理"]
  const footer = (
    <>
      <ClaudeButton kind="outline" onClick={close}>
        取消
      </ClaudeButton>
      <ClaudeButton kind="primary" disabled={!value.trim() || saving} onClick={() => void save()}>
        {saving ? "保存中…" : "保存"}
      </ClaudeButton>
    </>
  )
  const content = (
    <>
      {!target.model.active ? <p className="claude-dialog-hint">直接写入这个会话文件，不需要先载入、也不会切换当前会话。</p> : null}
      <ClaudeField
        label="会话名称"
        value={value}
        autoFocus
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) void save()
        }}
      />
      <div className="claude-quicknames">
        {quick
          .filter((v) => v && v !== value)
          .map((v) => (
            <button key={v} type="button" className="claude-chip" onClick={() => setValue(v)}>
              {v}
            </button>
          ))}
      </div>
      {error ? (
        <p className="claude-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
  if (ui.sheet?.id === CLAUDE_OVERLAY.rename) {
    return (
      <ClaudeSheet title="重命名会话" onClose={close} footer={footer}>
        {content}
      </ClaudeSheet>
    )
  }
  return (
    <ClaudeDialog title="重命名会话" onClose={close} footer={footer} width={380}>
      {content}
    </ClaudeDialog>
  )
}
