/** S6 r5：pi-remote 组在线 5 行之后还有待处理行——r-s20 等你确认（确认框 2.5 小时前打开，排第 6）、离线的 s12 回合出错；两行越过 5 行上限照样露出，其余收进「更多 6」。 */
import type { RoomInfo, SessionEntry } from "../../../../relay/devices.ts"
import type { InboxEntry } from "../../../../relay/inbox.ts"
import { BASE, PI_REMOTE, ROOM_TURN_ENDS, ROOMS, SESSIONS_BY_DEVICE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const M = 60_000
const H = 60 * M
const TITLE = "发版前跑一遍 npm publish --dry-run"
const OPENED = MOCK_NOW - 150 * M

const session: SessionEntry = {
  id: "r-s20",
  name: "",
  firstMessage: TITLE,
  path: "/Users/dev/.pi/agent/sessions/r-s20.jsonl",
  cwd: PI_REMOTE,
  messageCount: 11,
  sizeBytes: 0,
  updatedAt: OPENED,
  active: true,
  online: true,
  parentSession: null,
}

const room: RoomInfo = {
  id: "r-s20",
  label: null,
  name: TITLE,
  firstMessage: TITLE,
  cwd: PI_REMOTE,
  online: true,
  busy: true,
  viewers: 0,
  lastActivity: OPENED,
  accountId: "acct-dev",
  deviceId: "d-mbp",
  waiting: [{ dialogId: "dlg-s6-r20", kind: "confirm", title: "允许运行 npm publish --dry-run？", startedAt: OPENED, answerable: true }],
}

// 别房的「等你回答」只从收件箱账本计（attentionItemsOf），room.waiting 只管状态行：两处都要有
const ledger: InboxEntry = {
  key: "dialog:r-s20:dlg-s6-r20",
  accountId: "acct-dev",
  roomId: "r-s20",
  deviceId: "d-mbp",
  kind: "waiting",
  subkind: "dialog",
  dialogKind: "confirm",
  title: "允许运行 npm publish --dry-run？",
  answerable: true,
  at: OPENED,
}

const fixture: PiLiveFixture = {
  id: "s6-pending-past-cap",
  now: MOCK_NOW,
  note: "组内排序在线优先、再按最近活动，每组 5 行：r-s20 在线但最旧（第 6），s12 离线（第 7）。待处理（等你确认 / 出错）的行不受 5 行上限，「更多」只收其余 6 行。",
  relay: {
    ...BASE,
    rooms: [...ROOMS, room],
    sessionsByDevice: { ...SESSIONS_BY_DEVICE, "d-mbp": [...SESSIONS_BY_DEVICE["d-mbp"], session] },
    roomTurnEnds: [...ROOM_TURN_ENDS, { seq: 15, at: MOCK_NOW - 6 * H, roomId: "s12", error: true }],
    inbox: [ledger],
  },
}
export default fixture
