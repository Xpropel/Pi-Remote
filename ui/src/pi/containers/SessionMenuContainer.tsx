import { useMemo } from "react"
import { AAnchored, PiDeleteDialog, PiRenameDialog, PiSessionMenu, type PiSessionMenuAction, type PiSessionMenuSession } from "@/components/pi/shell"
import { PiSheet, piBaseName, usePiStatic, type PiReturnFocus } from "@/components/pi/shared"
import { mobileRouteUrl } from "@/mobile/model"
import { sessionDeleteErrorText, sessionDeleteRouteOf, sessionMenuOf, type PiSessionDeleteRoute, type PiSessionMenuModel } from "@/pi/model/sessionMenu"
import { openSessionRow, sidebarDataOf, type PiDeviceListedSession, type PiSidebarData } from "@/pi/model/sidebarSource"
import { deviceErrorText, type Device } from "@/relay/devices"
import { closePiDialog, openPiDialog, PI_UI_IDS, piDialogOf, piLayoutOf, type PiContainerProps } from "./types"

/** 手机长按 / 对话页顶栏 … 的会话菜单 sheet（ui.sheet）；桌面静态态（#/live 对图）摆右键菜单（ui.menu）。arg = 会话 id */
export const A_SESSION_MENU = "a:session-menu"

interface MenuTarget {
  row: PiDeviceListedSession
  device: Device | undefined
  model: PiSessionMenuModel
  session: PiSessionMenuSession
  /** 删除路由（P9 B）：目标正在运行 / 发设备（session.purge + session.files）/ 发同目录在线房间 / 都不可用带原因 */
  deleteRoute: PiSessionDeleteRoute
}

/** 菜单作用的那一行 → PiSessionMenu 的 session / state（规则在 model/sessionMenu.ts，照 chat/sessionMenu.tsx） */
function targetOf(p: PiContainerProps, data: PiSidebarData, rowId: string | undefined): MenuTarget | null {
  const { relay } = p
  const row = rowId ? data.sessions.find((x) => x.id === rowId) : undefined
  if (!row) return null
  const device = data.devices.find((d) => d.id === row.deviceId)
  // P9 B：relay 声明了 session.purge 才能走设备级删除（服务器会清副本并广播 session_removed）
  const serverPurge = relay.serverCaps.includes("session.purge")
  const deleteRoute = sessionDeleteRouteOf(row, relay.rooms, relay.roomId, device, serverPurge)
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
    deleteRoute,
  })
  return {
    row,
    device,
    model,
    deleteRoute,
    session: {
      title: row.title,
      messageCount: row.messageCount,
      // relay 里房间 id 就是会话 id（"复制会话 ID" 复制的就是它）
      sessionId: row.id,
      openable: row.openable,
      current: model.current,
      busy: model.active ? relay.busy : row.busy,
    },
  }
}

/** 侧栏那一片数据（只跟这几个字段走） */
function useMenuData(p: PiContainerProps): PiSidebarData {
  const { devices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice } = p.relay
  return useMemo(
    () => sidebarDataOf({ devices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice }),
    [devices, rooms, sessionsByDevice, roomId, dialogs, uiPrompt, turnEnd, roomTurnEnds, selectedDevice],
  )
}

function copyText(p: PiContainerProps, text: string, done: string) {
  const fail = () => p.relay.pushNotice({ level: "error", title: "复制失败：浏览器不允许读写剪贴板" })
  if (!navigator.clipboard) {
    fail()
    return
  }
  navigator.clipboard.writeText(text).then(() => p.relay.pushNotice({ level: "success", title: done }), fail)
}

/** 关闭弹窗 / sheet 后焦点回到菜单作用的那一行（行没了就回手机顶栏 …，再没有由 PiOverlay 兜底回顶栏标题） */
function returnTo(rowId: string): PiReturnFocus {
  return () => {
    const key = typeof CSS !== "undefined" ? CSS.escape(rowId) : rowId
    return (
      document.querySelector<HTMLElement>(`[data-pi-sidebar] [data-pi-row-key="${key}"]`) ??
      document.querySelector<HTMLElement>(`[data-pi-sidebar] [data-pi-row-key="attention:${key}"]`) ??
      document.querySelector<HTMLElement>("[data-pi-session-more]")
    )
  }
}

const FAMILY: Partial<Record<PiSessionMenuAction, string>> = {
  fork: PI_UI_IDS.fork,
  clone: PI_UI_IDS.clone,
  export: PI_UI_IDS.export,
  tree: PI_UI_IDS.tree,
  compact: PI_UI_IDS.compact,
  rename: PI_UI_IDS.rename,
  delete: PI_UI_IDS.delete,
}

/**
 * 选中一项。改名 / 删除开 a 自己的弹窗；分叉 / 克隆 / 导出 / 会话树 / 压缩开 c 的弹窗家族（arg = 会话 id）；
 * 手机上 openPiDialog 换掉 sheet 槽，会话菜单 sheet 随之关上。
 */
function runAction(p: PiContainerProps, t: MenuTarget, action: PiSessionMenuAction) {
  const { relay, act } = p
  const { row } = t
  if (p.variant === "phone" && p.ui.sheet?.id === A_SESSION_MENU) act.closeSheet()
  const dialog = FAMILY[action]
  if (dialog) {
    openPiDialog(p, { id: dialog, arg: row.id })
    return
  }
  switch (action) {
    case "open":
      if (row.openable) openSessionRow(relay, row, act.openSession)
      else {
        // "启用会话"：同旧界面，直接让本机起 pi（harness_start）；行在别的设备上先换过去
        if (row.deviceId !== relay.selectedDeviceId) relay.selectDevice(row.deviceId)
        void relay.enableSession(row.id)
        act.openSession()
      }
      return
    case "tab":
      // 深链 ?device=&session=（同旧手机界面 mobile/model.ts）；新入口按深链打开会话归 P6.2
      window.open(mobileRouteUrl(location.pathname, location.search, location.hash, { screen: "conversation", sessionId: row.id, deviceId: row.deviceId }), "_blank", "noopener")
      return
    case "copy-id":
      copyText(p, row.id, "已复制会话 ID")
      return
    case "copy-cwd":
      if (row.cwd) copyText(p, row.cwd, "已复制工作目录")
      return
  }
}

/** 桌面：一行的会话菜单内容（PiSidebar 的 rowMenu：右键 = context、行尾 … = dropdown）；也是顶栏 … 的内容（copyCwd） */
export function SessionRowMenu(props: PiContainerProps & { rowId: string; copyCwd?: boolean }) {
  const { rowId, copyCwd, ...p } = props
  const data = useMenuData(p)
  const t = targetOf(p, data, rowId)
  if (!t) return null
  return <PiSessionMenu variant="desktop" session={t.session} state={t.model.items} copyCwd={copyCwd} onSelect={(action) => runAction(p, t, action)} />
}

/**
 * 会话菜单（plan §7.1 session-menu，a 线）：行尾 "…" / 右键 / 手机长按、桌面顶栏 "…"（B04，含"复制工作目录"，见 SessionInfoContainer）。
 * 菜单项和禁用规则照 chat/sessionMenu.tsx 抽成 model/sessionMenu.ts（不改原文件）：当前会话不能删；忙时禁用并写原因（aria-describedby）。
 * 改名 / 删除用 a 的 PiRenameDialog / PiDeleteDialog（PI_UI_IDS.rename / delete）；分叉 / 克隆 / 导出 / 会话树 / 压缩开 c 的弹窗家族。
 * 放在桌面 overlay 槽和手机 sheet 槽：没有开着的菜单 / 弹窗 / sheet 时什么都不画。
 * 桌面的行菜单是 PiSidebar 里的 Radix 菜单（SessionRowMenu）；这里在静态态（#/live 对图）按画廊屏的摆法把它画在目标行旁边。
 */
export function SessionMenuContainer(props: PiContainerProps) {
  const { relay, ui, act, variant } = props
  const phone = variant === "phone"
  const isStatic = usePiStatic()
  const data = useMenuData(props)
  const viewport = piLayoutOf(variant)
  const dialog = piDialogOf(props)
  const close = () => closePiDialog(props)

  if (dialog?.id === PI_UI_IDS.rename) {
    const t = targetOf(props, data, dialog.arg)
    if (!t) return null
    const active = t.model.active
    return (
      <PiRenameDialog
        key={t.row.id}
        viewport={viewport}
        title={t.row.title}
        note={active ? undefined : "直接写入这个会话文件，不需要先载入、也不会切换当前会话。"}
        returnFocus={returnTo(t.row.id)}
        onOpenChange={(open) => {
          if (!open) close()
        }}
        onSave={async (name) => {
          try {
            if (active) await relay.runCommand("set_session_name", { name })
            else if (t.row.path) await relay.renameSessionFile(t.row.path, name)
            else throw new Error("这个会话没有文件路径")
          } catch (error) {
            throw new Error(deviceErrorText(error))
          }
          relay.pushNotice({ level: "success", title: "已修改会话名" })
          close()
        }}
      />
    )
  }
  if (dialog?.id === PI_UI_IDS.delete) {
    const t = targetOf(props, data, dialog.arg)
    if (!t) return null
    const serverPurge = relay.serverCaps.includes("session.purge")
    const deleteDeviceName = t.device?.name || "这台设备"
    return (
      <PiDeleteDialog
        key={t.row.id}
        viewport={viewport}
        title={t.row.title}
        deviceName={t.device?.name}
        serverPurge={serverPurge}
        trash={!!t.device?.trash}
        returnFocus={returnTo(t.row.id)}
        onOpenChange={(open) => {
          if (!open) close()
        }}
        onConfirm={async () => {
          const route = t.deleteRoute
          if (t.model.items.delete.disabled || !t.row.path || !route.via) throw new Error(t.model.items.delete.reason ?? "这个会话现在不能删除")
          let data: { status?: string; method?: string | null } | null = null
          try {
            // P9 B：一处入口。relay 有 session.purge 时发设备级 delete_session——设备确认删除后
            // relay 清掉全部副本并广播 session_removed（本页的清单/名册由那个帧改，不刷新）；
            // 旧 relay 在 deleteSession 内部退回 R25 的 deleteSessionFile（同目录在线房间 + 本地隐藏表）。
            data = await relay.deleteSession({ deviceId: t.row.deviceId, sessionId: t.row.id, sessionPath: t.row.path, roomId: route.roomId ?? "" })
          } catch (error) {
            throw new Error(sessionDeleteErrorText(error))
          }
          relay.pushNotice({
            level: "success",
            title: data?.method === "trash" ? `已移到 ${deleteDeviceName} 的废纸篓` : `已从 ${deleteDeviceName} 上删除`,
          })
          close()
        }}
      />
    )
  }

  if (phone && ui.sheet?.id === A_SESSION_MENU) {
    const t = targetOf(props, data, ui.sheet.arg)
    if (!t) return null
    const where = [t.device?.name, t.row.cwd ? piBaseName(t.row.cwd) : ""].filter(Boolean).join("/")
    const count = t.row.messageCount > 0 ? `${t.row.messageCount} 条` : ""
    return (
      <PiSheet
        title={t.session.title}
        subtitle={[where, count].filter(Boolean).join(" · ") || undefined}
        returnFocus={returnTo(t.row.id)}
        onOpenChange={(open) => {
          if (!open) act.closeSheet()
        }}
      >
        <PiSessionMenu variant="phone" session={t.session} state={t.model.items} onSelect={(action) => runAction(props, t, action)} />
      </PiSheet>
    )
  }

  // 桌面静态态：按画廊屏 a/session-menu 的摆法，菜单从目标行（保持选中底）旁边展开
  if (!phone && isStatic && ui.menu?.id === A_SESSION_MENU) {
    const t = targetOf(props, data, ui.menu.arg)
    if (!t) return null
    return (
      <AAnchored selector={`[data-pi-row="${t.row.id}"][data-context-target]`} place={(r) => ({ left: r.left + 128, top: r.top + 17 })}>
        <PiSessionMenu static variant="desktop" session={t.session} state={t.model.items} />
      </AAnchored>
    )
  }
  return null
}
