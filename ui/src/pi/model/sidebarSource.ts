/**
 * 侧栏的数据源（plan §7.1 session-list、P5.3；brief 16:45 的 G2 与"侧栏跨设备"）。纯函数，node --test 直接加载。
 * - sidebarSessionsOf：所有设备的会话，逐台 mergeDeviceSessions 并带上 deviceId（不加宽 useRelay；relay.listedSessions 只有选中设备）。
 *   注意：useRelay 只给选中设备拉 get_sessions，别的设备的 sessionsByDevice 多半是空的，那几台只出在线房间（真实数据就这么多）。
 * - attentionWithOfflineDevices（G2）：attentionItemsOf 只对选中设备出"设备未连接"；这里给每台非选中的离线设备各补一条，
 *   排序口径同 relay/attention.ts（等你回答 → 出错 → 设备未连接 → 完成未读，同级按时刻、再按 key）。attention.ts 本身不改。
 */
import { attentionItemsOf, type AttentionItem, type AttentionKind, type AttentionSnapshot, type AttentionTurnEnd } from "../../relay/attention.ts"
import { mergeDeviceSessions, UNREGISTERED_DEVICE_ID, type Device, type ListedSession, type RoomInfo, type SessionEntry } from "../../relay/devices.ts"
import { roomStatusLine, type RoomStatusLine } from "../../relay/roomStatus.ts"
import { sortShellDevices } from "../../shell/deviceStripModel.ts"

/** 侧栏用的会话行：ListedSession + 所在设备 */
export type PiDeviceListedSession = ListedSession & { deviceId: string }

/** 每台设备的会话合在一起（设备照传入顺序；每台内部的顺序照 mergeDeviceSessions） */
export function sidebarSessionsOf(
  devices: readonly Device[],
  rooms: readonly RoomInfo[],
  sessionsByDevice: Readonly<Record<string, readonly SessionEntry[] | undefined>>,
): PiDeviceListedSession[] {
  return devices.flatMap((device) =>
    mergeDeviceSessions(device, [...rooms], [...(sessionsByDevice[device.id] ?? [])]).map((row) => ({ ...row, deviceId: device.id })),
  )
}

/** 每台设备的会话数（显示选项的设备行用） */
export function sessionCountsOf(sessions: readonly Pick<PiDeviceListedSession, "deviceId">[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const s of sessions) out[s.deviceId] = (out[s.deviceId] ?? 0) + 1
  return out
}

/** 同 relay/attention.ts 的 KIND_PRIORITY（那边没有导出） */
const PRIORITY: Record<AttentionKind, number> = { waiting: 0, error: 1, "device-offline": 2, done: 3 }

/** 设备掉线条目的说明（同 attention.ts） */
const OFFLINE_DETAIL = "设备未连接，回电脑打开 attach 后恢复"

/**
 * G2：给每台离线设备各补一条 device-offline（已经有 `device:<id>` 的不重复；未登记设备没有身份，不补）。
 * 非选中设备的条目没有房间归属：roomId 为 ""（选中设备那条照 attention.ts，roomId = 当前房间）。
 */
export function attentionWithOfflineDevices(
  items: readonly AttentionItem[],
  devices: readonly Pick<Device, "id" | "name" | "online">[],
): AttentionItem[] {
  const have = new Set(items.map((item) => item.key))
  const extra: AttentionItem[] = []
  for (const device of devices) {
    if (device.online || device.id === UNREGISTERED_DEVICE_ID) continue
    const key = `device:${device.id}`
    if (have.has(key)) continue
    have.add(key)
    extra.push({ key, kind: "device-offline", roomId: "", deviceId: device.id, dialogId: null, title: device.name || "设备", detail: OFFLINE_DETAIL, at: 0 })
  }
  if (!extra.length) return [...items]
  return [...items, ...extra].sort(
    (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

/**
 * 手机对话页返回键的计数（同 shared/adapters.ts 的 piOtherAttentionCount 口径）：不含当前会话的条目，
 * 也不含当前会话所在设备的"设备未连接"（页面里已经写着它离线）。
 */
export function otherAttentionCount(items: readonly AttentionItem[], currentRoomId: string, currentDeviceId: string | null): number {
  return items.filter((a) => a.roomId !== currentRoomId && !(a.kind === "device-offline" && currentDeviceId != null && a.deviceId === currentDeviceId)).length
}

/** sidebarDataOf 要的 relay 切片（字段名同 useRelay 的返回值） */
export type PiSidebarSourceInput = {
  devices: readonly Device[]
  rooms: readonly RoomInfo[]
  sessionsByDevice: Readonly<Record<string, readonly SessionEntry[] | undefined>>
  roomId: string
  dialogs: AttentionSnapshot["dialogs"]
  uiPrompt: AttentionSnapshot["uiPrompt"]
  turnEnd: AttentionSnapshot["turnEnd"]
  roomTurnEnds: AttentionSnapshot["roomTurnEnds"]
  /** 收件箱账本切片（D-§1）：可选——给了 attention 就走账本面，没给（旧装配）回落摘要面 */
  inbox?: AttentionSnapshot["inbox"]
  selectedDevice: AttentionSnapshot["selectedDevice"]
}

export type PiSidebarData = {
  /** 设备，照 sortShellDevices（在线在前，再按首次连接从早到晚） */
  devices: Device[]
  /** 所有设备的会话（sidebarSessionsOf） */
  sessions: PiDeviceListedSession[]
  /** 注意力：attentionItemsOf（入参照 shell/Sidebar.tsx）+ G2 */
  attention: AttentionItem[]
}

/** 侧栏、搜索、会话菜单、顶栏共用的那一片：设备、所有设备的会话、注意力 */
export function sidebarDataOf(r: PiSidebarSourceInput): PiSidebarData {
  const devices = sortShellDevices(r.devices)
  const sessions = sidebarSessionsOf(devices, r.rooms, r.sessionsByDevice)
  const attention = attentionWithOfflineDevices(
    attentionItemsOf({
      currentRoomId: r.roomId,
      rooms: r.rooms,
      dialogs: r.dialogs,
      uiPrompt: r.uiPrompt,
      turnEnd: r.turnEnd,
      roomTurnEnds: r.roomTurnEnds,
      inbox: r.inbox,
      selectedDevice: r.selectedDevice,
    }),
    devices,
  )
  return { devices, sessions, attention }
}

/** openSessionRow 要的 relay 动作（同 useRelay） */
export type PiOpenSessionRelay = {
  roomId: string
  selectedDeviceId: string | null
  selectDevice: (id: string) => void
  selectRoom: (id: string) => void
  selectListedSession: (row: ListedSession) => void
}

/**
 * 打开一行会话（侧栏、需要处理组、搜索结果、会话菜单"打开会话"共用）：
 * 行在别的设备上先 selectDevice（同步改 relay 的选中设备）；能直接打开的订阅房间（selectRoom），
 * 未载入的只本地选择（selectListedSession，发第一条时才载入）；已经是当前会话就不动 relay。最后 onOpened（切到会话视图）。
 */
export function openSessionRow(relay: PiOpenSessionRelay, row: PiDeviceListedSession, onOpened: () => void): void {
  if (row.id !== relay.roomId) {
    if (row.deviceId && row.deviceId !== relay.selectedDeviceId) relay.selectDevice(row.deviceId)
    if (row.openable) relay.selectRoom(row.id)
    else relay.selectListedSession(row)
  }
  onOpened()
}

/**
 * 一行状态的输入装配（设计 D §2.2/§2.4）：桌面侧栏与移动列表共用——
 * 房间事实（online/busy/waiting/waitingPrompt/lastEvent）优先取 RoomInfo，
 * 没有房间（仅清单会话）时回落 ListedSession 的 online/busy/updatedAt；
 * 未读落定取别房追踪器的 AttentionTurnEnd（在场房间追踪器里没有，自然为 null=已读）。
 * 纯函数 roomStatusLine 本体在 relay/roomStatus.ts，这里只做字段拼装。
 */
export function sessionStatusLineOf(input: {
  room?: RoomInfo | null
  session?: Pick<ListedSession, "online" | "busy" | "updatedAt"> | null
  turnEnd?: AttentionTurnEnd | null
  now: number
}): RoomStatusLine {
  const { room, session, turnEnd, now } = input
  return roomStatusLine(
    {
      online: room ? room.online : (session?.online ?? false),
      busy: room ? room.busy : (session?.busy ?? false),
      waiting: room?.waiting ?? null,
      waitingPrompt: room?.waitingPrompt ?? null,
      lastTurnEnd: turnEnd ? { kind: turnEnd.error ? "error" : "done", at: turnEnd.at } : null,
      lastEvent: room?.lastEvent ?? null,
      lastActivity: room?.lastActivity ?? session?.updatedAt ?? 0,
    },
    now,
  )
}
