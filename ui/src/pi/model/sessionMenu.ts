/**
 * 会话菜单的可用性与原因（plan §7.1 session-menu、P5.3；照旧界面 chat/sessionMenu.tsx 的规则抽出来，原文件不改）。纯函数，node --test 直接加载。
 * 规则要点（与 chat/sessionMenu.tsx 相同）：
 *   - 当前会话不能删；
 *   - 已载入的当前会话（active）走房间命令：改名 / 分叉 / 克隆 / 导出 / 会话树 / 压缩都要 pi 在线；
 *   - 未载入会话（不是 active、也不可直接打开）走文件级命令：要有文件路径、设备名册、设备在线；
 *   - 可以直接打开、但还不是当前会话的：先打开它，再做房间级操作。
 * 新界面多出的几条：
 *   - 忙时（当前会话 pi 正忙）改名 / 分叉 / 克隆 / 压缩禁用，原因"pi 正忙，等这一轮结束"（design session-menu states）；
 *   - 侧栏合了所有设备：文件级命令走选中设备（useRelay.requireFileDevice），别的设备上的行要先打开那台设备上的会话。
 * 删除（P8 R25，编排 10-26 00:19）：扩展的 delete_session 只删回答它的 pi 自己会话目录里的文件，pi 的会话目录按 cwd 分
 *   （extension cmdDeleteSession / jailSessionPath）。所以删除发给这台设备上和目标同目录的在线房间（sessionDeleteRouteOf：
 *   当前房间在这个目录就用它，否则取最近活动的那个），不再要求先打开当前设备上的会话；目标自己有在线房间（正在运行）时不能删，
/**
 * 删除（P8 R25 → P9 B，编排 10-26）：设备确认删除成功后服务器也清副本（session.purge），
 * 所以删除有三条路，按顺序判：
 *   1. 目标自己有在线房间（id 就是会话 id）→ 正在运行，不能删；
 *   2. relay 有 session.purge 且设备在线、attach 声明了 session.files → 发给设备（attach 在整个
 *      会话根目录里删，三端一致，扩展到旧版都不用绕同目录房间）；
 *   3. 这台设备上和目标同目录的在线房间 → 走 R25 的旧路（扩展删它自己会话目录里的文件）；
 *   4. 设备不在线 → 「设备未连接，连上后才能删除」；
 *   5. 其余：relay 有 session.purge（说明新 relay 但 attach 旧）→「这台设备的连接窗口（attach）需要更新」，
 *      否则维持 R25 的「这个项目里没有在运行的 pi，暂时删不了」。
 * 扩展 / attach / relay 仍然拒绝时，报错改写成中文、原文放在括号里（sessionDeleteErrorText）。
 * 禁用项的原因给读屏用（aria-describedby），见 PiSessionMenu 的 state。
 */
import { cwdInProjects, deviceErrorText, errorCode, roomDeviceId, type Device, type RoomInfo } from "../../relay/devices.ts"

export type PiSessionMenuKey = "open" | "rename" | "fork" | "clone" | "export" | "tab" | "tree" | "compact" | "copy-cwd" | "copy-id" | "delete"

export type PiSessionMenuItemState = { disabled: boolean; reason?: string }

export type PiSessionMenuInput = {
  row: { id: string; openable: boolean; path?: string; cwd?: string }
  /** relay.roomId（未选会话时为 ""） */
  currentRoomId: string
  /** relay.lazySession?.id：当前选中的是未载入会话 */
  lazySessionId: string | null
  authed: boolean
  /** 当前房间的 pi 在线（relay.online） */
  online: boolean
  /** 当前会话的 pi 正忙（relay.busy） */
  busy: boolean
  /** relay.deviceMode（有设备名册） */
  deviceMode: boolean
  /** 这一行所在的设备在线 */
  deviceOnline: boolean
  /** 这一行在选中设备上 */
  onSelectedDevice: boolean
  /** 删除发给谁（sessionDeleteRouteOf 的结果） */
  deleteRoute: PiSessionDeleteRoute
}

/**
 * 删除的路由（P9 B）：
 * - running：有 id 和目标相同的在线房间（房间 id 就是会话 id），也就是有 pi 正开着这个会话；
 * - via："device" = 发设备级 delete_session（relay 有 session.purge、设备在线且 attach 有 session.files）；
 *   "room" = 发给同目录的在线房间（R25 旧路）；null = 删不了，原因在 reason；
 * - roomId：via="room" 时发给哪个房间（同 R25 的选法：当前房间优先，否则最近活动的）；
 * - reason：via=null 时给菜单置灰的原因（running 时由 sessionMenuOf 用 deleteRunning 覆盖）。
 */
export type PiSessionDeleteRoute = { running: boolean; via: "device" | "room" | null; roomId: string | null; reason?: string }

/** sessionDeleteRouteOf 用到的房间字段 */
export type PiSessionDeleteRoom = Pick<RoomInfo, "id" | "online" | "deviceId" | "cwd" | "lastActivity">

/** sessionDeleteRouteOf 用到的设备字段（看在线与 attach 声明的文件能力） */
export type PiSessionDeleteDevice = Pick<Device, "online" | "features"> | null | undefined

export type PiSessionMenuModel = {
  /** 菜单作用的是当前选中的会话 */
  current: boolean
  /** 当前会话且已载入（真实房间） */
  active: boolean
  items: Record<PiSessionMenuKey, PiSessionMenuItemState>
}

export const PI_MENU_REASON = {
  linkDown: "服务器未连接",
  busy: "pi 正忙，等这一轮结束",
  hostDown: "本机 pi 没在运行",
  openFirst: "先打开这个会话",
  noPath: "这个会话没有文件路径",
  noRoster: "当前服务端不支持未载入会话的操作",
  deviceOffline: "设备未连接",
  otherDevice: "先打开这台设备上的会话",
  current: "已经是当前会话",
  deleteCurrent: "当前会话不能删除，先切换到别的会话",
  deleteRunning: "会话正在运行，不能删除",
  deleteNoRoom: "这个项目里没有在运行的 pi，暂时删不了",
  deleteDeviceOffline: "设备未连接，连上后才能删除",
  deleteNeedsUpdate: "这台设备的连接窗口（attach）需要更新",
  noCwd: "这个会话没有工作目录",
} as const

const ok: PiSessionMenuItemState = { disabled: false }
const off = (reason: string): PiSessionMenuItemState => ({ disabled: true, reason })

/**
 * 删除的路由（P9 B，判序见文件头）：
 * 1. 目标正在运行（有 id 相同的在线房间）→ running；
 * 2. relay 有 session.purge 且设备在线、features 含 session.files → via "device"；
 * 3. 这台设备（roomDeviceId，同侧栏的归属口径）上和目标同目录（cwdInProjects）的在线房间 →
 *    via "room"（当前房间优先，否则最近活动的；同 R25）；
 * 4. 设备不在线 → 原因 deleteDeviceOffline；
 * 5. 其余：serverPurge 为真 → deleteNeedsUpdate，否则维持 deleteNoRoom。
 */
export function sessionDeleteRouteOf(
  row: { id: string; deviceId: string; cwd?: string },
  rooms: readonly PiSessionDeleteRoom[],
  currentRoomId: string,
  device: PiSessionDeleteDevice,
  serverPurge: boolean,
): PiSessionDeleteRoute {
  if (rooms.some((room) => room.id === row.id && room.online)) return { running: true, via: null, roomId: null }
  const features = device?.features ?? []
  if (serverPurge && device?.online && features.includes("session.files")) return { running: false, via: "device", roomId: null }
  const cwd = row.cwd ?? ""
  const candidates = cwd
    ? rooms.filter((room) => room.online && room.id !== row.id && !!room.cwd && roomDeviceId(room) === row.deviceId && cwdInProjects([room.cwd], cwd))
    : []
  const current = currentRoomId ? candidates.find((room) => room.id === currentRoomId) : undefined
  const pick = current ?? candidates.reduce<PiSessionDeleteRoom | null>((best, room) => (!best || (room.lastActivity || 0) >= (best.lastActivity || 0) ? room : best), null)
  if (pick) return { running: false, via: "room", roomId: pick.id }
  if (!device?.online) return { running: false, via: null, roomId: null, reason: PI_MENU_REASON.deleteDeviceOffline }
  return { running: false, via: null, roomId: null, reason: serverPurge ? PI_MENU_REASON.deleteNeedsUpdate : PI_MENU_REASON.deleteNoRoom }
}

/**
 * 删除失败的文案（R25 (c)）：扩展拒绝时把原文改写成看得懂的中文，原文放在括号里；连接 / 超时这类照 deviceErrorText，前面加「删除失败：」。
 * 扩展的报错见 extension/pi-remote-sync.ts 的 cmdDeleteSession、jailSessionPath、sessionFileError。
 */
export function sessionDeleteErrorText(error: unknown): string {
  const code = errorCode(error)
  // P9 B：设备级删除的三个新码（relay routeDeleteSession / attach），文案按 §4.1 的表写
  if (code === "session_running") return "删除失败：会话正在运行，不能删除"
  if (code === "device_update_required") return "删除失败：这台设备的连接窗口（attach）需要更新"
  if (code === "device_offline") return "删除失败：设备未连接，连上后才能删除"
  // 扩展的 internal 原文自己就以「删除失败：」开头（cmdDeleteSession），括号里不再重复
  const raw = (error instanceof Error ? error.message : "").replace(/^删除失败[:：]\s*/, "")
  let what: string | null = null
  if (code === "bad_args") {
    if (/越界/.test(raw)) what = "会话不在可删范围内"
    else if (/不能删除当前会话/.test(raw)) what = "会话正在运行，不能删除"
    else if (/\.jsonl|不是普通会话文件|目标是目录/.test(raw)) what = "这不是会话文件"
    else what = "电脑上的 pi 拒绝了这次删除"
  } else if (code === "not_found") what = "会话文件已经不在了"
  else if (code === "not_ready") what = "这个项目的 pi 还没准备好"
  else if (code === "internal") what = /没有权限|EACCES|EPERM/.test(raw) ? "没有权限删除这个文件" : "电脑上删除文件时出错"
  if (what) return raw ? `删除失败：${what}（${raw}）` : `删除失败：${what}`
  const text = deviceErrorText(error)
  return text.startsWith("删除失败") ? text : `删除失败：${text}`
}

export function sessionMenuOf(input: PiSessionMenuInput): PiSessionMenuModel {
  const { row } = input
  const current = row.id === input.currentRoomId && !!input.currentRoomId
  const active = current && !input.lazySessionId
  const busyOps = active && input.busy

  /** 未载入会话的文件级命令为什么不能用（null = 能用） */
  const fileBlock = (): string | null => {
    if (!input.authed) return PI_MENU_REASON.linkDown
    if (row.openable) return PI_MENU_REASON.openFirst
    if (!row.path) return PI_MENU_REASON.noPath
    if (!input.deviceMode) return PI_MENU_REASON.noRoster
    if (!input.deviceOnline) return PI_MENU_REASON.deviceOffline
    if (!input.onSelectedDevice) return PI_MENU_REASON.otherDevice
    return null
  }
  /** 当前会话的房间命令为什么不能用（null = 能用） */
  const roomBlock = (): string | null => {
    if (!input.authed) return PI_MENU_REASON.linkDown
    if (!input.online) return PI_MENU_REASON.hostDown
    return null
  }
  /** active 走房间命令，否则走文件级命令（改名 / 分叉 / 导出） */
  const either = (withBusy: boolean): PiSessionMenuItemState => {
    if (withBusy && busyOps) return off(PI_MENU_REASON.busy)
    const why = active ? roomBlock() : fileBlock()
    return why ? off(why) : ok
  }
  /** 只有已载入的当前会话能做（克隆 / 会话树 / 压缩） */
  const roomOnly = (withBusy: boolean): PiSessionMenuItemState => {
    if (withBusy && busyOps) return off(PI_MENU_REASON.busy)
    if (!active) return off(PI_MENU_REASON.openFirst)
    const why = roomBlock()
    return why ? off(why) : ok
  }

  const open: PiSessionMenuItemState = current
    ? off(PI_MENU_REASON.current)
    : row.openable || input.deviceOnline
      ? ok
      : off(PI_MENU_REASON.deviceOffline)

  // P9 第 1 轮审查 B3：先判「会话正在运行」再判「没有文件路径」。运行中的会话是活动房间，
  // 列表行可能没有 path（正文在房间里），顺序反了会把「会话正在运行，不能删除」显示成「没有文件路径」。
  // 连接断开（linkDown）仍排在运行中之前：断线时「服务器未连接」更准确。
  const del: PiSessionMenuItemState = current
    ? off(PI_MENU_REASON.deleteCurrent)
    : !input.authed
      ? off(PI_MENU_REASON.linkDown)
      : input.deleteRoute.running
        ? off(PI_MENU_REASON.deleteRunning)
        : !row.path
          ? off(PI_MENU_REASON.noPath)
          : !input.deleteRoute.via
            ? off(input.deleteRoute.reason ?? PI_MENU_REASON.deleteNoRoom)
            : ok

  return {
    current,
    active,
    items: {
      open,
      rename: either(true),
      fork: either(true),
      clone: roomOnly(true),
      export: either(false),
      tab: ok,
      tree: roomOnly(false),
      compact: roomOnly(true),
      "copy-cwd": row.cwd ? ok : off(PI_MENU_REASON.noCwd),
      "copy-id": ok,
      delete: del,
    },
  }
}

/** 菜单头 / sheet 副标题里的条数："31 条"；清单里没有条数（0）就不写 */
export function sessionMenuCountText(messageCount: number | null | undefined): string | null {
  return typeof messageCount === "number" && messageCount > 0 ? `${messageCount} 条` : null
}
