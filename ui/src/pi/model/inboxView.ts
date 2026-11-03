/**
 * Pending-answer inbox view model (design D section 1.5), shared by the
 * variant shells that render their own inbox page: the Claude and Codex
 * variants are self-contained and cannot import the Cursor containers, so
 * the grouping / labelling logic lives here as pure functions over the
 * relay ledger (metadata only -- the ledger deliberately carries no
 * question options or message bodies).
 *
 * Answering: only confirm-kind waiting entries can be answered in place
 * (they need no payload). Ask / select / input entries jump into their
 * room, where the live dialog card carries the payload.
 */
import { attentionRoomTitle } from "../../relay/attention.ts"
import type { Device, ListedSession, RoomInfo } from "../../relay/devices.ts"
import { inboxDialogIdOf, type InboxEntry } from "../../relay/inbox.ts"

export type InboxViewGroup = { kind: InboxEntry["kind"]; label: string; entries: InboxEntry[] }

/**
 * Row title for a ledger entry. Live rooms resolve exactly like waiting
 * rows always have (attentionRoomTitle). Turn (done / error) entries never
 * carry a title of their own and their rooms are usually gone from the
 * current room_list by the time they are read, so fall back to the merged
 * stored-session listing for the same session id (its title follows the
 * same naming priority: custom name, first message, workspace folder),
 * then to the owning device's name -- never the bare fallback while
 * better data exists anywhere in the entry's device data.
 */
export function inboxEntryTitleOf(
  entry: InboxEntry,
  roomsById: ReadonlyMap<string, RoomInfo>,
  sessionsById: ReadonlyMap<string, ListedSession>,
  devicesById: ReadonlyMap<string, Device>,
): string {
  const room = roomsById.get(entry.roomId)
  if (room) return attentionRoomTitle(room)
  const session = sessionsById.get(entry.roomId)
  if (session?.title) return session.title
  const device = entry.deviceId ? devicesById.get(entry.deviceId) : undefined
  if (device?.name) return device.name
  return "会话"
}

const GROUP_LABELS: { kind: InboxEntry["kind"]; label: string }[] = [
  { kind: "waiting", label: "等你答" },
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
  if (entry.subkind === "prompt") return entry.title || "有弹窗等你处理"
  if (entry.title) return `等你处理：${entry.title}`
  switch (entry.dialogKind) {
    case "confirm":
      return "等你确认"
    case "select":
      return "等你选择"
    case "input":
    case "editor":
      return "等你输入"
    default:
      return "有弹窗等你处理"
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
