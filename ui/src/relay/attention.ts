/**
 * 注意力聚合（P3-6 / 第 2 轮 R2-4）：把"需要用户处理"的信号聚成一份待处理清单。
 *
 * 分工（同源不同面，不另立第二套计数）：
 *  - 标题 / favicon 角标（chat/composer/faviconBadge）与完成提示音（sound）消费的是
 *    relay.turnEnd 这个瞬时信号：只管当前房间、只在页面不在场时出声 / 上标；
 *  - Toast（notices）是瞬时消息面，来了又走——它自己就是一个呈现面，不进清单，
 *    免得同一件事在两个地方各挂一份；
 *  - 本模块是"待处理清单"：只收还挂着没处理完的状态（未决 dialog、别房回合结果、
 *    选中设备掉线）。纯派生、无自有状态：信号消失，条目自动不在清单里。
 *
 * 数据只消费 useRelay 已经暴露的状态切片（dialogs / uiPrompt / turnEnd /
 * roomTurnEnds / rooms / selectedDevice），不新增轮询。跨房回合结果有两个
 * 同源信号：当前房的 turnEnd（与角标 / 提示音同一个信号源）与
 * roomTurnEnds——useRelay 用本文件末尾的 RoomTurnTracker 在帧被房间过滤丢弃
 * 之前，从 room_list 的各房 busy 边沿与别房事件帧里记下的 per-room 落定记录
 * （B-1 补链：否则别房帧整帧被丢、turnEnd 又只由当前房产生，别房 done/error
 * 在真实链路里永远到不了这里）。追踪器是纯内存的实时边沿引擎，刷新即失；
 * 第 3 轮 R3-1 起另有 relay 回合摘要作恢复通道：room_list 条目的 lastTurnEnd
 * 与 room_attention 帧经本文件末尾的 seedRoomTurnEnds 种回追踪器（只补空缺、
 * 先到为准），刷新/重连后别房落定条目得以恢复。
 *
 * 本文件全部是纯函数：输入状态快照 → 条目列表。UI 只渲染，点击只做导航
 * （selectRoom / selectDevice），导航本身就是"已处理"的表达：done / error 条目
 * 只对非当前房间生成（P3-6 口径"当前房间的变化不产生未读"），切进房间即消失；
 * waiting 条目随 dialog_close 收缩 dialogs 自动消失；设备条目随设备恢复在线消失。
 */
// test/*.test.mjs 用 node 直接跑 .ts 源文件，相对导入必须带扩展名
import { baseName, roomDeviceId, type Device, type RoomInfo } from "./devices.ts"
import { cleanSessionTitleText } from "./titleText.ts"
import type { InboxEntry } from "./inbox.ts"

/** 未决 dialog 的最小形状（与 PromptWaiting 的 DialogCard 结构兼容，只取聚合用到的字段）。 */
export type AttentionDialog = {
  dialogId: string
  kind: string
  title?: string
  startedAt: number
  /** O2 应答面：true = 这个网页能直接答；false / 缺失 = 只能在电脑上答（旧 relay / 未接管）。 */
  answerable?: boolean
}

/** 旧 ui_prompt 等待信号的最小形状（与 useRelay 的 uiPrompt 结构兼容）。 */
export type AttentionUiPrompt = { kind: string; title: string; startedAt: number }

/** 回合结束信号的最小形状（与 useRelay 的 TurnEnd 结构兼容，与角标 / 提示音同源）。 */
export type AttentionTurnEnd = { seq: number; at: number; roomId: string; error: boolean }

export type AttentionSnapshot = {
  /** 当前打开的房间 id；未选会话时为 "" */
  currentRoomId: string
  /** 房间名册（relay.rooms）：条目标题与设备归属的来源 */
  rooms: readonly RoomInfo[]
  /** 当前房间的未决 dialog（relay.dialogs）；关掉一个就少一个 */
  dialogs: readonly AttentionDialog[]
  /** 旧等待信号（relay.uiPrompt）；dialogs 非空时与 dialog 条目是同一件事，不再单独成条 */
  uiPrompt: AttentionUiPrompt | null
  /** 最近一次回合结束（relay.turnEnd）；只对非当前房间成条 */
  turnEnd: AttentionTurnEnd | null
  /** 别房回合结束记录（relay.roomTurnEnds，per-room 边沿追踪的落定结果）；只对非当前房间成条 */
  roomTurnEnds?: readonly AttentionTurnEnd[]
  /**
   * 收件箱账本切片（设计 D §1，relay.inbox）：给了就以账本为别房 waiting 的唯一来源
   * （取代 1b 的 room.waiting 摘要拼装）；turn 条目不在这里成条——它们经 useRelay 的
   * inboxTurnSeedsOf 种回 RoomTurnTracker 后走第 3 段同一出口，保证计数恒等。
   * 缺省（旧 relay / 未声明 room.inbox）时 1b 走原摘要路径，行为与账本落地前一致。
   */
  inbox?: readonly InboxEntry[]
  /** 选中设备（relay.selectedDevice）；未连接时成一条设备待处理 */
  selectedDevice: Pick<Device, "id" | "name" | "online"> | null
}

export type AttentionKind = "waiting" | "error" | "done" | "device-offline"

export type AttentionItem = {
  /** 稳定键：同一信号源永远同一个键（dialog:<id> / prompt:<roomId> / turn:<roomId>:<seq> / device:<id>） */
  key: string
  kind: AttentionKind
  /** 点击跳转的目标房间；没有房间归属时为 "" */
  roomId: string
  /** 归属设备（房间的 deviceId 或掉线设备本身）；未知时为 null */
  deviceId: string | null
  /** dialog 条目带 dialogId，供定位对应卡片；其余为 null */
  dialogId: string | null
  /** 一行标题：会话名或设备名 */
  title: string
  /** 一行说明：等什么 / 出了什么事 */
  detail: string
  /** 信号时刻：同级排序（先来先排）与相对时间展示用；设备条目没有时刻语义，恒 0 */
  at: number
  /**
   * P9 A：这个网页能不能直接答这条 waiting（其它房间的 room.dialogs 摘要按 relay 的
   * dialog.respond cap 给）。false = 只能在电脑上答；缺失 = 旧 relay / 无应答面信息。
   */
  answerable?: boolean
}

/** 清单排序：等应答的最急，其次出错、设备掉线，最后完成未读；同级按信号时刻先后。 */
const KIND_PRIORITY: Record<AttentionKind, number> = { waiting: 0, error: 1, "device-offline": 2, done: 3 }

/** 会话标题：与 useRelay.roomTitle 同一优先级（改名 label → 会话名 → 首条消息 → label → 目录名 → id 前缀）。 */
export function attentionRoomTitle(room: RoomInfo | null | undefined): string {
  if (!room) return "会话"
  const folder = room.cwd ? baseName(room.cwd) : ""
  if (room.label && room.label !== folder && room.label !== room.id) return room.label
  if (room.name) return room.name
  // 首条消息作标题要过清洗规则（设计 D §2.1：折叠/去控制字符/80 码点截）；清洗后为空顺延下一档
  const first = cleanSessionTitleText(room.firstMessage)
  if (first) return first
  if (room.label) return room.label
  if (room.cwd) return baseName(room.cwd)
  return room.id.slice(0, 8)
}

/** dialog 没有标题时的等待文案（按种类给一句人话；未知种类回落通用句）。 */
function dialogWaitingText(kind: string): string {
  switch (kind) {
    case "select":
      return "等你选择"
    case "confirm":
      return "等你确认"
    case "input":
    case "editor":
      return "等你输入"
    default:
      return "有弹窗等你处理"
  }
}

/** 状态快照 → 待处理清单。这是全 UI 唯一的注意力派生出口，计数只数它的长度。 */
export function attentionItemsOf(snapshot: AttentionSnapshot): AttentionItem[] {
  const items: AttentionItem[] = []
  const roomsById = new Map(snapshot.rooms.map((room) => [room.id, room]))
  const currentRoom = snapshot.currentRoomId ? roomsById.get(snapshot.currentRoomId) : undefined
  const currentDeviceId = currentRoom?.deviceId ?? snapshot.selectedDevice?.id ?? null

  // 1) 未决 dialog（当前房间，O1 多槽）：一个 dialog 一条；dialog_close 后 dialogs
  //    收缩，条目自动消失（任意 reason 关闭都一样，归约层只留未决的）。
  for (const dialog of snapshot.dialogs) {
    if (!dialog.dialogId) continue
    items.push({
      key: `dialog:${dialog.dialogId}`,
      kind: "waiting",
      roomId: snapshot.currentRoomId,
      deviceId: currentDeviceId,
      dialogId: dialog.dialogId,
      title: attentionRoomTitle(currentRoom),
      detail: dialog.title ? `等你处理：${dialog.title}` : dialogWaitingText(dialog.kind),
      at: dialog.startedAt,
      ...(typeof dialog.answerable === "boolean" ? { answerable: dialog.answerable } : {}),
    })
  }

  // 2) 旧 ui_prompt 等待信号：只在没有 dialog 条目时兜底——两者说的是同一件
  //    "本机有弹窗在等"，双计会把一件待处理显示成两件。
  if (snapshot.dialogs.length === 0 && snapshot.uiPrompt && snapshot.currentRoomId) {
    items.push({
      key: `prompt:${snapshot.currentRoomId}`,
      kind: "waiting",
      roomId: snapshot.currentRoomId,
      deviceId: currentDeviceId,
      dialogId: null,
      title: attentionRoomTitle(currentRoom),
      detail: snapshot.uiPrompt.title || "有弹窗等你处理",
      at: snapshot.uiPrompt.startedAt,
    })
  }

  // 1b) 其它房间的未决 dialog。当前房间只用实时的 dialogs，避免同一件事被实时面和
  //     摘要/账本面各记一次（与第 2 步 uiPrompt 去重同一条纪律）。
  //     设计 D §1 起：快照带 inbox 切片时，别房 waiting 只从账本取（账本是 relay 侧唯一
  //     事实源，跨刷新/重启都在）；当前房的账本条目跳过（实时 dialogs 已成条，硬规则）。
  //     无切片（旧 relay）回落 P9 A 的 room.waiting 摘要拼装，行为与账本落地前一致。
  const seen = new Set(items.map((item) => item.key))
  if (snapshot.inbox !== undefined) {
    for (const entry of snapshot.inbox) {
      if (entry.kind !== "waiting" || entry.roomId === snapshot.currentRoomId) continue
      const room = roomsById.get(entry.roomId)
      const deviceId = entry.deviceId ?? (room ? roomDeviceId(room) : null)
      if (entry.subkind === "dialog" || entry.subkind === "ask") {
        if (seen.has(entry.key)) continue
        seen.add(entry.key)
        items.push({
          key: entry.key,
          kind: "waiting",
          roomId: entry.roomId,
          deviceId,
          dialogId: entry.subkind === "dialog" ? entry.key.slice("dialog:".length) : null,
          title: attentionRoomTitle(room),
          detail: entry.title || dialogWaitingText(entry.dialogKind ?? ""),
          at: entry.at,
          answerable: entry.answerable === true,
        })
      } else if (entry.subkind === "prompt") {
        const key = `prompt:${entry.roomId}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          key,
          kind: "waiting",
          roomId: entry.roomId,
          deviceId,
          dialogId: null,
          title: attentionRoomTitle(room),
          detail: entry.title || "有弹窗等你处理",
          at: entry.at,
          answerable: false,
        })
      }
    }
  } else for (const room of snapshot.rooms) {
    if (!room.online || room.id === snapshot.currentRoomId) continue
    const deviceId = roomDeviceId(room)
    for (const waiting of room.waiting ?? []) {
      const key = `dialog:${waiting.dialogId}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        key,
        kind: "waiting",
        roomId: room.id,
        deviceId,
        dialogId: waiting.dialogId,
        title: attentionRoomTitle(room),
        detail: waiting.title || "有弹窗等你处理",
        at: waiting.startedAt,
        answerable: waiting.answerable === true,
      })
    }
    // 旧的单槽 ui_prompt 兜底只在 waiting 为空时有意义（协议字段规则）。
    if (!(room.waiting?.length) && room.waitingPrompt) {
      items.push({
        key: `prompt:${room.id}`,
        kind: "waiting",
        roomId: room.id,
        deviceId,
        dialogId: null,
        title: attentionRoomTitle(room),
        detail: room.waitingPrompt.title || "有弹窗等你处理",
        at: room.waitingPrompt.at,
        answerable: false,
      })
    }
  }

  // 3) 别房回合结果：当前房间不产生未读（回合就在眼前，P3-6 口径）；切进目标
  //    房间后 roomId 与 currentRoomId 相同，条目自动消失——"进房即清"在这里是
  //    纯派生的等价式（归约层进房时另有 forgetRoomTurnEnd 防离开后旧记录复活）。
  //    两个来源按房间合并：per-room 边沿记录 roomTurnEnds 是别房的主来源；
  //    turnEnd 与角标 / 提示音同源、只由当前房产生，落到这里时至多是同房残留，
  //    同房冲突时以它为准（它带当前房的权威错误判定）。
  const otherEnds = new Map<string, AttentionTurnEnd>()
  for (const end of snapshot.roomTurnEnds ?? []) {
    if (end && end.roomId) otherEnds.set(end.roomId, end)
  }
  if (snapshot.turnEnd && snapshot.turnEnd.roomId) otherEnds.set(snapshot.turnEnd.roomId, snapshot.turnEnd)
  for (const end of otherEnds.values()) {
    if (end.roomId === snapshot.currentRoomId) continue
    const room = roomsById.get(end.roomId)
    items.push({
      key: `turn:${end.roomId}:${end.seq}`,
      kind: end.error ? "error" : "done",
      roomId: end.roomId,
      deviceId: room?.deviceId ?? null,
      dialogId: null,
      title: attentionRoomTitle(room),
      detail: end.error ? "回合出错了，还没看" : "回合已完成，还没看",
      at: end.at,
    })
  }

  // 4) 选中设备掉线：整台设备失联，要回电脑打开 attach 才恢复，属于"需要用户
  //    动手"的待处理；恢复在线即自动消失。会话个体的结束不进清单——那是常态
  //    （侧栏状态点与状态文案已呈现），进清单会把正常结束误报成待处理。
  const device = snapshot.selectedDevice
  if (device && !device.online) {
    items.push({
      key: `device:${device.id}`,
      kind: "device-offline",
      roomId: snapshot.currentRoomId,
      deviceId: device.id,
      dialogId: null,
      title: device.name || "设备",
      detail: "设备未连接，回电脑打开 attach 后恢复",
      at: 0,
    })
  }

  return items.sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

/** 待处理总数：计数只此一个出口（清单长度），任何表面都不要再自算一份。 */
export function attentionCountOf(items: readonly AttentionItem[]): number {
  return items.length
}

/**
 * 等你回答的条数（P9 修复线 W，review-1 P2-2）：标签页标题「? 」与 favicon 蓝色问号圈的输入。
 * 与清单同一派生出口（attentionItemsOf），含当前房 dialog、别房 waiting / waitingPrompt。
 */
export function attentionWaitingCountOf(items: readonly AttentionItem[]): number {
  return items.filter((item) => item.kind === "waiting").length
}

/** 按设备聚合待处理数（通用口径 helper）；deviceId 未知的条目不计入任何设备。呈现层计数统一走 attentionCountOf（B-3）。 */
export function attentionCountByDevice(items: readonly AttentionItem[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (!item.deviceId) continue
    counts.set(item.deviceId, (counts.get(item.deviceId) ?? 0) + 1)
  }
  return counts
}

/**
 * 某房间最要紧的一条（侧栏会话行状态点用）：清单已按优先级排序，取首个命中即可。
 * 设备掉线条目不落行（它的 roomId 只是顺带指向当前房，设备状态在分组头呈现）。
 */
export function attentionForRoom(items: readonly AttentionItem[], roomId: string): AttentionItem | null {
  if (!roomId) return null
  return items.find((item) => item.roomId === roomId && item.kind !== "device-offline") ?? null
}

/* ── 别房回合边沿追踪（B-1 补链） ──────────────────────────────────────────
 * 别房回合结束在真实链路里原本无路可走：别房事件帧在 useRelay 的房间过滤处
 * 整帧丢弃，turnEnd 又只由当前房的 finishTurn 产生。本追踪器由 useRelay 在
 * 帧被丢弃之前喂养，信号只有两个，都不需要新协议帧：
 *  - room_list 的各房 busy 边沿（侧栏本来就靠它显示别房运行点， relay 在
 *    busy 变化时会广播新名册）：busy true→false 即一回合落定；
 *  - 别房 room_event 帧（若到达）：agent_start 记升沿、message_end 的终局
 *    stopReason / message_update 的 error 先行记下错误，agent_settled 记落沿。
 * 落定记录只进 ends 表；错误判定与当前房同口径（终局 error / errorMessage /
 * 流错误算 error；aborted 是本机主动中断，不算完成、不产记录）。
 * 记录生命周期：新回合开始（升沿）作废旧记录；进房（subscribe）由归约层
 * forgetRoomTurnEnd 清掉，防离开后复活；房间下线不伪造完成、连记录一并撤；
 * 纯内存——刷新即失这一条自第 3 轮 R3-1 起由 relay 回合摘要收口：刷新后
 * useRelay 拿 room_list / room_attention 的摘要经 seedRoomTurnEnds 把落定
 * 记录种回来（见文件末尾种子一节），R2-4 申报的"刷新不恢复"边界正式关闭。
 */
export type RoomTurnTracker = {
  /** 各房最近一次观察到的 busy（边沿基准）；从没见过的房间不在表里 */
  busy: ReadonlyMap<string, boolean>
  /** 正在跑的回合里先行观察到的错误（等落沿时并入记录） */
  errored: ReadonlySet<string>
  /** 正在跑的回合被中断（落沿不产记录） */
  aborted: ReadonlySet<string>
  /** 已落定的别房回合结束记录（roomId → 记录） */
  ends: ReadonlyMap<string, AttentionTurnEnd>
  seq: number
}

type RoomTurnDraft = {
  busy: Map<string, boolean>
  errored: Set<string>
  aborted: Set<string>
  ends: Map<string, AttentionTurnEnd>
  seq: number
}

export function emptyRoomTurnTracker(): RoomTurnTracker {
  return { busy: new Map(), errored: new Set(), aborted: new Set(), ends: new Map(), seq: 0 }
}

/** 追踪器当前的落定记录列表（喂 AttentionSnapshot.roomTurnEnds 用）。 */
export function roomTurnEndsOf(tracker: RoomTurnTracker): AttentionTurnEnd[] {
  return [...tracker.ends.values()]
}

function draftOf(tracker: RoomTurnTracker): RoomTurnDraft {
  return {
    busy: new Map(tracker.busy),
    errored: new Set(tracker.errored),
    aborted: new Set(tracker.aborted),
    ends: new Map(tracker.ends),
    seq: tracker.seq,
  }
}

/** 升沿：新回合开始——旧落定记录与上一回合的错误/中断标记一并作废。 */
function rise(draft: RoomTurnDraft, roomId: string) {
  draft.busy.set(roomId, true)
  draft.errored.delete(roomId)
  draft.aborted.delete(roomId)
  draft.ends.delete(roomId)
}

/** 落沿：一回合结束——当前房的回合不归这里管（finishTurn/turnEnd 负责），中断不产记录。 */
function settle(draft: RoomTurnDraft, roomId: string, currentRoomId: string, now: number) {
  draft.busy.set(roomId, false)
  const error = draft.errored.has(roomId)
  const aborted = draft.aborted.has(roomId)
  draft.errored.delete(roomId)
  draft.aborted.delete(roomId)
  if (!roomId || roomId === currentRoomId || aborted) return
  draft.seq += 1
  draft.ends.set(roomId, { seq: draft.seq, at: now, roomId, error })
}

/**
 * 喂一份新的房间名册（room_list / auth_result 的全量列表）：逐房比对 busy 边沿。
 * 第一次见到的房间只立基准、不伪造边沿（"刚打开页面时它就是闲的"不等于"刚跑完")；
 * 名册里消失的房间连基准与记录一并清掉。
 */
export function trackRoomListEdges(
  tracker: RoomTurnTracker,
  rooms: readonly { id: string; busy: boolean }[],
  currentRoomId: string,
  now = Date.now(),
): RoomTurnTracker {
  const draft = draftOf(tracker)
  const seen = new Set<string>()
  for (const room of rooms) {
    if (!room || !room.id) continue
    seen.add(room.id)
    const prev = draft.busy.get(room.id)
    if (prev === undefined) draft.busy.set(room.id, room.busy)
    else if (prev && !room.busy) settle(draft, room.id, currentRoomId, now)
    else if (!prev && room.busy) rise(draft, room.id)
  }
  for (const roomId of [...draft.busy.keys()]) {
    if (seen.has(roomId)) continue
    draft.busy.delete(roomId)
    draft.errored.delete(roomId)
    draft.aborted.delete(roomId)
    draft.ends.delete(roomId)
  }
  return draft
}

/** 别房事件帧的最小形状（与 useRelay 的 room_event.event 兼容，只取边沿判定用到的字段）。 */
export type RoomTurnEvent = {
  type?: string
  message?: { role?: string; stopReason?: string; errorMessage?: string }
  assistantMessageEvent?: { type?: string }
}

/**
 * 喂一帧别房事件（useRelay 在房间过滤丢弃整帧之前调用）：只记边沿与错误，
 * 不消费内容。当前房的事件不走这里（调用方已按 roomId 分流）。
 */
export function trackRoomEventEdge(
  tracker: RoomTurnTracker,
  roomId: string,
  event: RoomTurnEvent,
  currentRoomId: string,
  now = Date.now(),
): RoomTurnTracker {
  if (!roomId || roomId === currentRoomId || !event || typeof event !== "object") return tracker
  switch (event.type) {
    case "agent_start":
    case "turn_start": {
      if (tracker.busy.get(roomId) === true && !tracker.ends.has(roomId)) return tracker
      const draft = draftOf(tracker)
      rise(draft, roomId)
      return draft
    }
    case "message_update": {
      if (event.assistantMessageEvent?.type !== "error" || tracker.errored.has(roomId)) return tracker
      const draft = draftOf(tracker)
      draft.errored.add(roomId)
      return draft
    }
    case "message_end": {
      const message = event.message
      if (!message || message.role !== "assistant") return tracker
      const stop = message.stopReason
      if (!stop || stop === "toolUse" || stop === "pending" || stop === "deferred") return tracker
      if (stop === "aborted") {
        if (tracker.aborted.has(roomId)) return tracker
        const draft = draftOf(tracker)
        draft.aborted.add(roomId)
        return draft
      }
      if (stop === "error" || !!message.errorMessage) {
        if (tracker.errored.has(roomId)) return tracker
        const draft = draftOf(tracker)
        draft.errored.add(roomId)
        return draft
      }
      return tracker
    }
    case "agent_settled": {
      if (tracker.busy.get(roomId) !== true) return tracker
      const draft = draftOf(tracker)
      settle(draft, roomId, currentRoomId, now)
      return draft
    }
    default:
      return tracker
  }
}

/** 房间下线：不伪造完成（下线不是跑完），基准落回 false、未决标记与旧记录一并撤掉。 */
export function trackRoomOfflineEdge(tracker: RoomTurnTracker, roomId: string): RoomTurnTracker {
  if (!roomId) return tracker
  if (tracker.busy.get(roomId) === undefined && !tracker.ends.has(roomId) && !tracker.errored.has(roomId) && !tracker.aborted.has(roomId)) {
    return tracker
  }
  const draft = draftOf(tracker)
  draft.busy.set(roomId, false)
  draft.errored.delete(roomId)
  draft.aborted.delete(roomId)
  draft.ends.delete(roomId)
  return draft
}

/** 进房即清：用户已经走进这个房间，它的"还没看"记录没有存在意义（防离开后复活）。 */
export function forgetRoomTurnEnd(tracker: RoomTurnTracker, roomId: string): RoomTurnTracker {
  if (!roomId || !tracker.ends.has(roomId)) return tracker
  const draft = draftOf(tracker)
  draft.ends.delete(roomId)
  return draft
}

/* ── relay 回合摘要种子（R3-1 恢复通道） ────────────────────────────────────
 * 追踪器只记"在场时"的边沿；页面刷新/重连后它一片空白，别房在离场期间落定
 * 的回合无从补记。relay 侧按房维护同一份落定摘要（lastTurnEnd，随 room_list
 * 条目下发、变化时另有 room_attention 帧广播），useRelay 在名册归约与帧到达
 * 时把摘要经这里种回追踪器。合并规则（UI·relay 中-3 修正「先到为准」）：
 *  - 按 roomId 与既有记录合并，**按时刻比新旧**：同一回合经实时边沿与种子两路
 *    到达时保留先到者（at 相同不翻案）；种子时刻更晚（断线期间同一房又跑完一
 *    回合）时覆盖旧记录——否则新回合的出错会被旧的「已完成」永久盖住；
 *  - 追踪器为空（刚刷新）时种子直接落定——这正是恢复的主场景；
 *  - 当前房间不种：与 settle 的当前房口径一致（身处该房不算"还没看"，也防
 *    离开该房后陈旧种子复活成条）；
 *  - 摘要被清（进房已读 / 新回合活动）的传播不走种子：清理由 relay 广播的
 *    room_attention{null} 经 forgetRoomTurnEnd 落地、本地进房同路，名册种子
 *    里缺席只是"无可种"，不作删除依据（名册可能比追踪器旧一拍）。 */

/** relay 回合摘要种子的最小形状（room_list 条目 lastTurnEnd / room_attention 帧的载荷）。 */
export type RoomTurnSeed = { roomId: string; kind: "done" | "error"; at: number }

/** 一条原始摘要的清洗：kind 只认 done/error；at 不是有限数时记 0（relay 恒发真实时刻，0 只兜坏帧）。 */
function cleanSeed(roomId: unknown, rec: unknown): RoomTurnSeed | null {
  if (typeof roomId !== "string" || !roomId || !rec || typeof rec !== "object") return null
  const kind = (rec as { kind?: unknown }).kind
  if (kind !== "done" && kind !== "error") return null
  const at = (rec as { at?: unknown }).at
  return { roomId, kind, at: typeof at === "number" && Number.isFinite(at) ? at : 0 }
}

/**
 * 从 room_list 的原始房间条目里提炼种子（条目形状 {id, lastTurnEnd}）。
 * 旧 relay 无 lastTurnEnd 字段时返回空数组——行为退回第 2 轮的纯边沿记账。
 */
export function roomTurnSeedsOf(rawRooms: unknown): RoomTurnSeed[] {
  if (!Array.isArray(rawRooms)) return []
  const seeds: RoomTurnSeed[] = []
  for (const raw of rawRooms) {
    if (!raw || typeof raw !== "object") continue
    const seed = cleanSeed((raw as { id?: unknown }).id, (raw as { lastTurnEnd?: unknown }).lastTurnEnd)
    if (seed) seeds.push(seed)
  }
  return seeds
}

/** 单帧 room_attention 的载荷提炼：lastTurnEnd 为 null 是"已清"信号（种子为空、由调用方走 forget 路径）；形状不合法返回 null 表示整帧不认。 */
export function roomAttentionSeedOf(roomId: unknown, lastTurnEnd: unknown): { roomId: string; seed: RoomTurnSeed | null } | null {
  if (typeof roomId !== "string" || !roomId) return null
  if (lastTurnEnd === null) return { roomId, seed: null }
  const seed = cleanSeed(roomId, lastTurnEnd)
  return seed ? { roomId, seed } : null
}

/**
 * 把一批种子并入追踪器：按 roomId 合并、**按时刻比新旧**（种子更晚时覆盖旧记录；相同或更旧不翻案），
 * 当前房跳过；一条都没改到追踪器时原样返回入参（引用不变，归约层不会无谓触发渲染）。
 */
export function seedRoomTurnEnds(
  tracker: RoomTurnTracker,
  seeds: readonly RoomTurnSeed[],
  currentRoomId: string,
): RoomTurnTracker {
  let draft: RoomTurnDraft | null = null
  for (const seed of seeds) {
    if (!seed || !seed.roomId || seed.roomId === currentRoomId) continue
    if (seed.kind !== "done" && seed.kind !== "error") continue
    const prev = (draft ?? tracker).ends.get(seed.roomId)
    // 先到者/相同时刻胜出；只有 relay 明确给了更晚的落定时刻才覆盖（断线期间的第二回合）。
    if (prev && prev.at >= seed.at) continue
    if (!draft) draft = draftOf(tracker)
    draft.seq += 1
    draft.ends.set(seed.roomId, { seq: draft.seq, at: seed.at, roomId: seed.roomId, error: seed.kind === "error" })
  }
  return draft ?? tracker
}
