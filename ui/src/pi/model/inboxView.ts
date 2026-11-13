/**
 * Pending-answer inbox view model (design D section 1.5): the grouping /
 * labelling logic lives here as pure functions over the relay ledger
 * (metadata only -- the ledger deliberately carries no question options
 * or message bodies).
 *
 * Answering: only confirm-kind waiting entries can be answered in place
 * (they need no payload). Ask / select / input entries jump into their
 * room, where the live dialog card carries the payload.
 *
 * 桌面 InboxContainer 与手机 MobileInboxPage 的数据规则只有这一份（inboxViewOf / openInboxEntry）；
 * 两个外壳只管版式、图标和「正在答」的状态。
 */
import { attentionRoomTitle } from "../../relay/attention.ts"
import type { Device, ListedSession, RoomInfo } from "../../relay/devices.ts"
import { inboxDialogIdOf, type InboxEntry } from "../../relay/inbox.ts"
import { relativeTimeLabel, sidebarWorkspaceLabel } from "../sidebar/model.ts"

export type InboxViewGroup = { kind: InboxEntry["kind"]; label: string; entries: InboxEntry[] }

/**
 * Row title for a ledger entry: the merged sidebar row for the same
 * session id comes first, so the inbox shows exactly the sidebar's title
 * (same chain -- session name, first message, workspace -- plus the
 * same-folder start-time suffix). A live room missing from the listing
 * resolves through attentionRoomTitle; with neither (turn entries whose
 * room has left room_list on a device whose sessions are not loaded) the
 * owning device's name is the last informative fallback.
 */
export function inboxEntryTitleOf(
  entry: InboxEntry,
  roomsById: ReadonlyMap<string, RoomInfo>,
  sessionsById: ReadonlyMap<string, ListedSession>,
  devicesById: ReadonlyMap<string, Device>,
): string {
  const session = sessionsById.get(entry.roomId)
  if (session?.title) return session.title
  const room = roomsById.get(entry.roomId)
  if (room) return attentionRoomTitle(room)
  const device = entry.deviceId ? devicesById.get(entry.deviceId) : undefined
  if (device?.name) return device.name
  return "会话"
}

const GROUP_LABELS: { kind: InboxEntry["kind"]; label: string }[] = [
  { kind: "waiting", label: "等你回答" },
  { kind: "error", label: "出错了" },
  { kind: "done", label: "已完成未读" },
]

/** Non-empty groups in display order: waiting, error, done-unread. */
export function inboxGroupsOf(entries: readonly InboxEntry[]): InboxViewGroup[] {
  return GROUP_LABELS.map((group) => ({ ...group, entries: entries.filter((entry) => entry.kind === group.kind) })).filter((group) => group.entries.length > 0)
}

/** One-line status text for a ledger row (same wording as the Cursor inbox). */
export function inboxDetailOf(entry: InboxEntry): string {
  if (entry.kind === "error") return entry.subkind === "schedule" ? entry.title || "定时消息发送失败" : "回合出错了，还没看"
  if (entry.kind === "done") return "回合已完成，还没看"
  if (entry.subkind === "ask") return entry.title || "等你回答"
  if (entry.subkind === "prompt") return entry.title || "有弹窗等你回答"
  if (entry.title) return `等你回答：${entry.title}`
  switch (entry.dialogKind) {
    case "confirm":
      return "等你确认"
    case "select":
      return "等你选择"
    case "input":
    case "editor":
      return "等你输入"
    default:
      return "有弹窗等你回答"
  }
}

/** In-place answer affordance for a row: only live confirm dialogs qualify
 *  (same gate as the Cursor inbox: waiting + dialog subkind + confirm kind
 *  + relay says answerable + a dialog id to answer). */
export function inboxConfirmAnswerOf(entry: InboxEntry): { dialogId: string; allowLabel: string; denyLabel: string } | null {
  if (entry.kind !== "waiting" || entry.subkind !== "dialog" || entry.dialogKind !== "confirm" || entry.answerable !== true) return null
  const dialogId = inboxDialogIdOf(entry)
  if (!dialogId) return null
  return { dialogId, allowLabel: "允许", denyLabel: "拒绝" }
}

export type InboxViewRow = {
  entry: InboxEntry
  key: string
  title: string
  /** 工作区名 · 状态行（未命名会话的标题常常一样，带上工作区名才分得清）；取不到目录只写状态行 */
  detail: string
  timeLabel: string
  /** 只有 confirm 类且可答的等待才有：原地允许 / 拒绝 */
  confirm: { dialogId: string; allowLabel: string; denyLabel: string } | null
  /** 出错 / 已完成未读可清除；等你回答的不给（relay 账本也会拒，防假清零） */
  dismissible: boolean
}
export type InboxViewSection = { kind: InboxEntry["kind"]; label: string; rows: InboxViewRow[] }

/** 待答整页的数据：非空组按 等你回答 / 出错了 / 已完成未读 排，每行标题、状态行、时间与可用动作都在这里定。 */
export function inboxViewOf(input: {
  entries: readonly InboxEntry[]
  rooms: readonly RoomInfo[]
  /** 侧栏合并后的会话清单（sidebarSessionsOf），标题与侧栏同一条链 */
  sessions: readonly ListedSession[]
  devices: readonly Device[]
  now: number
}): InboxViewSection[] {
  const roomsById = new Map(input.rooms.map((room) => [room.id, room]))
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]))
  const devicesById = new Map(input.devices.map((device) => [device.id, device]))
  return inboxGroupsOf(input.entries).map((group) => ({
    kind: group.kind,
    label: group.label,
    rows: group.entries.map((entry) => {
      const cwd = roomsById.get(entry.roomId)?.cwd || sessionsById.get(entry.roomId)?.cwd
      const status = inboxDetailOf(entry)
      return {
        entry,
        key: entry.key,
        title: inboxEntryTitleOf(entry, roomsById, sessionsById, devicesById),
        detail: cwd ? `${sidebarWorkspaceLabel(cwd)} · ${status}` : status,
        timeLabel: relativeTimeLabel(input.now, entry.at),
        confirm: inboxConfirmAnswerOf(entry),
        dismissible: entry.kind !== "waiting",
      }
    }),
  }))
}

/** 点行进会话要动的 relay 切换面（结构类型，模型不依赖 useRelay） */
export type InboxOpenTarget = {
  selectedDeviceId: string | null
  roomId: string
  selectDevice: (deviceId: string) => void
  selectRoom: (roomId: string) => void
}

/** 点行：别的设备上的先切设备，再切房间；回会话视图由宿主接着做（桌面 / 手机各自的导航）。 */
export function openInboxEntry(relay: InboxOpenTarget, entry: InboxEntry): void {
  if (entry.deviceId && entry.deviceId !== relay.selectedDeviceId) relay.selectDevice(entry.deviceId)
  if (entry.roomId !== relay.roomId) relay.selectRoom(entry.roomId)
}
