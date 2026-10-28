// P3-6 / R2-4 注意力聚合：纯函数派生（多信号并存 / 信号消失自动摘除 / 当前房不
// 产生未读 / uiPrompt 兜底去重 / 跳转目标 / 按设备聚合）+ presence 状态点语义表。
// 纯 Node 测试（attention.ts 与 presence.ts 均无 DOM 依赖）。
import test from "node:test"
import assert from "node:assert/strict"
import {
  attentionCountByDevice,
  attentionCountOf,
  attentionForRoom,
  attentionItemsOf,
  attentionRoomTitle,
  emptyRoomTurnTracker,
  forgetRoomTurnEnd,
  roomAttentionSeedOf,
  roomTurnEndsOf,
  roomTurnSeedsOf,
  seedRoomTurnEnds,
  trackRoomEventEdge,
  trackRoomListEdges,
  trackRoomOfflineEdge,
} from "../ui/src/relay/attention.ts"
import { attentionDotOf } from "../ui/src/relay/presence.ts"
import { parseRooms } from "../ui/src/relay/devices.ts"

function room(id, extra = {}) {
  return {
    id,
    label: null,
    name: null,
    firstMessage: null,
    cwd: `/work/${id}`,
    online: true,
    busy: false,
    viewers: 1,
    lastActivity: 0,
    deviceId: "dev-1",
    ...extra,
  }
}

function snapshot(extra = {}) {
  return {
    currentRoomId: "room-a",
    rooms: [room("room-a", { name: "会话甲" }), room("room-b", { name: "会话乙" })],
    dialogs: [],
    uiPrompt: null,
    turnEnd: null,
    selectedDevice: { id: "dev-1", name: "我的电脑", online: true },
    ...extra,
  }
}

const DIALOGS = [
  { dialogId: "d-2", kind: "input", startedAt: 200 },
  { dialogId: "d-1", kind: "confirm", title: "要删除这个文件吗？", startedAt: 100 },
]

test("多信号并存：dialog + 别房出错 + 设备掉线同时成条，优先级排序稳定", () => {
  const items = attentionItemsOf(
    snapshot({
      dialogs: DIALOGS,
      turnEnd: { seq: 7, at: 300, roomId: "room-b", error: true },
      selectedDevice: { id: "dev-1", name: "我的电脑", online: false },
    }),
  )
  assert.equal(attentionCountOf(items), 4)
  assert.deepEqual(
    items.map((item) => item.kind),
    ["waiting", "waiting", "error", "device-offline"],
  )
  // waiting 同级按信号时刻先后（先弹的先排）
  assert.deepEqual(
    items.slice(0, 2).map((item) => item.dialogId),
    ["d-1", "d-2"],
  )
  // 有标题的 dialog 用标题，没标题的按种类给文案
  assert.equal(items[0].detail, "等你处理：要删除这个文件吗？")
  assert.equal(items[1].detail, "等你输入")
  assert.equal(items[2].title, "会话乙")
  assert.equal(items[3].title, "我的电脑")
})

test("信号消失自动摘除：dialog 关 / 设备恢复 / 回合信号清掉后清单为空", () => {
  const full = snapshot({
    dialogs: DIALOGS,
    turnEnd: { seq: 7, at: 300, roomId: "room-b", error: true },
    selectedDevice: { id: "dev-1", name: "我的电脑", online: false },
  })
  assert.equal(attentionItemsOf(full).length, 4)
  assert.deepEqual(attentionItemsOf(snapshot()), [])
  // 只关一个 dialog：剩下的还在
  const oneClosed = attentionItemsOf(snapshot({ dialogs: [DIALOGS[0]] }))
  assert.deepEqual(oneClosed.map((item) => item.dialogId), ["d-2"])
  // 设备恢复在线：设备条目消失，其余不变
  const backOnline = attentionItemsOf(snapshot({ dialogs: DIALOGS, selectedDevice: { id: "dev-1", name: "我的电脑", online: true } }))
  assert.equal(backOnline.some((item) => item.kind === "device-offline"), false)
  assert.equal(backOnline.length, 2)
})

test("当前房间的回合结束不产生未读；别房完成 / 出错各成一条", () => {
  const ownDone = attentionItemsOf(snapshot({ turnEnd: { seq: 1, at: 10, roomId: "room-a", error: false } }))
  assert.equal(ownDone.some((item) => item.key.startsWith("turn:")), false)
  const ownError = attentionItemsOf(snapshot({ turnEnd: { seq: 1, at: 10, roomId: "room-a", error: true } }))
  assert.equal(ownError.some((item) => item.key.startsWith("turn:")), false)

  const otherDone = attentionItemsOf(snapshot({ turnEnd: { seq: 2, at: 20, roomId: "room-b", error: false } }))
  assert.equal(otherDone.length, 1)
  assert.equal(otherDone[0].kind, "done")
  assert.equal(otherDone[0].detail, "回合已完成，还没看")
  const otherError = attentionItemsOf(snapshot({ turnEnd: { seq: 3, at: 30, roomId: "room-b", error: true } }))
  assert.equal(otherError[0].kind, "error")
  assert.equal(otherError[0].detail, "回合出错了，还没看")
})

test("跳转目标正确：dialog 指向当前房并带 dialogId，别房回合指向其房间，设备条目带 deviceId", () => {
  const items = attentionItemsOf(
    snapshot({
      dialogs: DIALOGS,
      turnEnd: { seq: 7, at: 300, roomId: "room-b", error: false },
      selectedDevice: { id: "dev-1", name: "我的电脑", online: false },
    }),
  )
  const dialog = items.find((item) => item.dialogId === "d-1")
  assert.equal(dialog.roomId, "room-a")
  assert.equal(dialog.deviceId, "dev-1")
  const turn = items.find((item) => item.kind === "done")
  assert.equal(turn.roomId, "room-b")
  assert.equal(turn.deviceId, "dev-1")
  assert.equal(turn.key, "turn:room-b:7")
  const device = items.find((item) => item.kind === "device-offline")
  assert.equal(device.deviceId, "dev-1")
  assert.equal(device.dialogId, null)
})

test("uiPrompt 只在没有 dialog 条目时兜底，不与 dialog 双计", () => {
  const fallback = attentionItemsOf(snapshot({ uiPrompt: { kind: "confirm", title: "继续吗？", startedAt: 50 } }))
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0].kind, "waiting")
  assert.equal(fallback[0].key, "prompt:room-a")
  assert.equal(fallback[0].detail, "继续吗？")

  const withDialogs = attentionItemsOf(
    snapshot({ dialogs: DIALOGS, uiPrompt: { kind: "confirm", title: "继续吗？", startedAt: 50 } }),
  )
  assert.equal(withDialogs.some((item) => item.key.startsWith("prompt:")), false)
  assert.equal(withDialogs.length, 2)
})

test("attentionForRoom 取最要紧的一条；设备条目不落行；未知房间为 null", () => {
  const items = attentionItemsOf(
    snapshot({
      dialogs: DIALOGS,
      turnEnd: { seq: 7, at: 300, roomId: "room-b", error: false },
      selectedDevice: { id: "dev-1", name: "我的电脑", online: false },
    }),
  )
  assert.equal(attentionForRoom(items, "room-a")?.kind, "waiting")
  assert.equal(attentionForRoom(items, "room-b")?.kind, "done")
  assert.equal(attentionForRoom(items, "room-zzz"), null)
  assert.equal(attentionForRoom(items, ""), null)
  // 只有设备条目时，当前房不因它亮点（设备状态在分组头呈现）
  const deviceOnly = attentionItemsOf(snapshot({ selectedDevice: { id: "dev-1", name: "我的电脑", online: false } }))
  assert.equal(attentionForRoom(deviceOnly, "room-a"), null)
})

test("attentionCountByDevice 按房间归属聚合，设备条目计入自身设备", () => {
  const items = attentionItemsOf(
    snapshot({
      dialogs: DIALOGS,
      turnEnd: { seq: 7, at: 300, roomId: "room-b", error: true },
      selectedDevice: { id: "dev-1", name: "我的电脑", online: false },
    }),
  )
  const counts = attentionCountByDevice(items)
  assert.equal(counts.get("dev-1"), 4)
  assert.equal(counts.size, 1)
})

test("attentionRoomTitle 与 roomTitle 同一优先级", () => {
  assert.equal(attentionRoomTitle(room("r1", { label: "改名", name: "会话名" })), "改名")
  assert.equal(attentionRoomTitle(room("r2", { name: "会话名", firstMessage: "首条" })), "会话名")
  assert.equal(attentionRoomTitle(room("r3", { firstMessage: "首条" })), "首条")
  assert.equal(attentionRoomTitle(room("r4", { cwd: "/work/project-x" })), "project-x")
  assert.equal(attentionRoomTitle(null), "会话")
})

/* ── B-1 集成链路：帧序列 → 追踪器 → 快照 → 清单 ──────────────────────────
 * 旧实现里别房 done/error 只有纯函数单测：快照里的 turnEnd 是手造的，真实链路
 * （别房帧被房间过滤整帧丢弃、turnEnd 只由当前房产生）永远喂不进来。下面按
 * useRelay 的真实喂养顺序模拟帧序列：room_list 名册（含各房 busy）与别房
 * room_event 帧（在被丢弃之前先过追踪器），终点断言清单里真的出现条目。 */

const roomsWith = (bBusy, aBusy = false) => [room("room-a", { busy: aBusy }), room("room-b", { busy: bBusy })]
const itemsFromTracker = (tracker, extra = {}) => attentionItemsOf(snapshot({ roomTurnEnds: roomTurnEndsOf(tracker), ...extra }))

test("集成 B-1：别房 busy 边沿（room_list 序列）→ 清单出现别房 done", () => {
  let tracker = emptyRoomTurnTracker()
  // 第一份名册只立基准：B 本来就闲着，不伪造"刚跑完"
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1000)
  assert.deepEqual(itemsFromTracker(tracker), [])
  // B 开跑（升沿）→ B 跑完（落沿）：落定记录进清单
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1100)
  assert.deepEqual(itemsFromTracker(tracker), [])
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1200)
  const items = itemsFromTracker(tracker)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "done")
  assert.equal(items[0].roomId, "room-b")
  assert.equal(items[0].title, "会话乙")
  assert.equal(items[0].at, 1200)
  // 同一份名册重复到达不重复产记录（无新边沿）
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1300)
  assert.equal(roomTurnEndsOf(tracker).length, 1)
})

test("集成 B-1：别房事件帧先行记错 + 名册落沿 → 清单出现别房 error", () => {
  let tracker = emptyRoomTurnTracker()
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1000)
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1100)
  // 别房 room_event 在被房间过滤丢弃之前过追踪器：终局消息出错
  tracker = trackRoomEventEdge(
    tracker,
    "room-b",
    { type: "message_end", message: { role: "assistant", stopReason: "error" } },
    "room-a",
    1150,
  )
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1200)
  const items = itemsFromTracker(tracker)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "error")
  assert.equal(items[0].detail, "回合出错了，还没看")
})

test("集成 B-1：别房 agent_settled 落沿（不经名册）+ 流错误 → error 成条", () => {
  let tracker = emptyRoomTurnTracker()
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1000)
  tracker = trackRoomEventEdge(tracker, "room-b", { type: "message_update", assistantMessageEvent: { type: "error" } }, "room-a", 1100)
  tracker = trackRoomEventEdge(tracker, "room-b", { type: "agent_settled" }, "room-a", 1200)
  const items = itemsFromTracker(tracker)
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, "error")
  // settled 重复到达不产第二条（busy 基准已落回 false）
  tracker = trackRoomEventEdge(tracker, "room-b", { type: "agent_settled" }, "room-a", 1300)
  assert.equal(roomTurnEndsOf(tracker).length, 1)
})

test("集成 B-1：当前房边沿不产记录，别房中断（aborted）不算完成", () => {
  let tracker = emptyRoomTurnTracker()
  tracker = trackRoomListEdges(tracker, roomsWith(false, false), "room-a", 1000)
  // 当前房 A 自己跑完：追踪器不落记录（当前房归 turnEnd / 角标那条线）
  tracker = trackRoomListEdges(tracker, roomsWith(false, true), "room-a", 1100)
  tracker = trackRoomListEdges(tracker, roomsWith(false, false), "room-a", 1200)
  assert.deepEqual(roomTurnEndsOf(tracker), [])
  // B 跑起来后被本机中断：终局 aborted + 落沿 → 不产"完成"记录
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1300)
  tracker = trackRoomEventEdge(
    tracker,
    "room-b",
    { type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
    "room-a",
    1400,
  )
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1500)
  assert.deepEqual(roomTurnEndsOf(tracker), [])
})

test("集成 B-1：进房即清、新回合覆盖旧记录、下线不伪造完成", () => {
  let tracker = emptyRoomTurnTracker()
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1000)
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1100)
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1200)
  assert.equal(itemsFromTracker(tracker).length, 1)
  // 进房即清：forget 后清单消失；且即便记录还在，身处该房时派生层也排除当前房
  assert.equal(itemsFromTracker(tracker, { currentRoomId: "room-b" }).length, 0)
  tracker = forgetRoomTurnEnd(tracker, "room-b")
  assert.deepEqual(roomTurnEndsOf(tracker), [])
  // B 又跑完一轮 → 记录回来；再开新回合（升沿）→ 旧记录作废
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1300)
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1400)
  assert.equal(roomTurnEndsOf(tracker).length, 1)
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1500)
  assert.deepEqual(roomTurnEndsOf(tracker), [])
  // 跑到一半下线：不产完成记录，之后的闲置名册也不补产
  tracker = trackRoomOfflineEdge(tracker, "room-b")
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1600)
  assert.deepEqual(roomTurnEndsOf(tracker), [])
})

test("集成 B-1：turnEnd 与 roomTurnEnds 同房同在时只出一条（turnEnd 优先）", () => {
  const items = attentionItemsOf(
    snapshot({
      turnEnd: { seq: 9, at: 500, roomId: "room-b", error: true },
      roomTurnEnds: [{ seq: 3, at: 400, roomId: "room-b", error: false }],
    }),
  )
  const turns = items.filter((item) => item.key.startsWith("turn:"))
  assert.equal(turns.length, 1)
  assert.equal(turns[0].kind, "error")
  assert.equal(turns[0].key, "turn:room-b:9")
})

/* ── R3-1 恢复通道：relay 回合摘要种子 ─────────────────────────────────────
 * 第 2 轮的追踪器只记在场边沿，刷新即失（R2-4 申报边界）。下面按 useRelay 的
 * 真实喂养顺序模拟"刷新"：新追踪器先过名册边沿、再吃 roomTurnSeedsOf 从原始
 * 名册条目提炼的种子，终点断言清单里条目真的回来；双路到达与进房清除也按
 * relay 的新语义（进房即 relay 清摘要、广播 null）验。 */

test("集成 R3-1：刷新模拟——空追踪器靠名册种子恢复别房 done/error", () => {
  // 刷新前 B 落定 done、C 落定 error，都只活在 relay 摘要里（原始名册条目）
  const rawRoster = [
    { id: "room-a", busy: false, lastTurnEnd: null },
    { id: "room-b", busy: false, lastTurnEnd: { kind: "done", at: 2000 } },
    { id: "room-c", busy: false, lastTurnEnd: { kind: "error", at: 2100 } },
  ]
  // 刷新后：新追踪器先过名册边沿（只立基准、不产记录），再吃种子
  let tracker = emptyRoomTurnTracker()
  tracker = trackRoomListEdges(tracker, [room("room-a"), room("room-b"), room("room-c")], "room-a", 3000)
  assert.deepEqual(roomTurnEndsOf(tracker), [])
  tracker = seedRoomTurnEnds(tracker, roomTurnSeedsOf(rawRoster), "room-a")
  const items = attentionItemsOf(
    snapshot({
      rooms: [room("room-a", { name: "会话甲" }), room("room-b", { name: "会话乙" }), room("room-c", { name: "会话丙" })],
      roomTurnEnds: roomTurnEndsOf(tracker),
    }),
  )
  assert.equal(items.length, 2)
  const done = items.find((i) => i.roomId === "room-b")
  const err = items.find((i) => i.roomId === "room-c")
  assert.equal(done.kind, "done")
  assert.equal(done.at, 2000)
  assert.equal(err.kind, "error")
  assert.equal(err.detail, "回合出错了，还没看")
})

test("集成 R3-1：双路到达只出一条——先到为准，后到不改写", () => {
  // 实时边沿先记账（at=1200），同一落定的 relay 摘要（relay 时刻 1150）经种子后到
  let tracker = emptyRoomTurnTracker()
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1000)
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 1100)
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1200)
  tracker = seedRoomTurnEnds(tracker, [{ roomId: "room-b", kind: "done", at: 1150 }], "room-a")
  const ends = roomTurnEndsOf(tracker)
  assert.equal(ends.length, 1)
  assert.equal(ends[0].at, 1200, "先到者为准：实时边沿的记录不被后到的种子改写")
  assert.equal(itemsFromTracker(tracker).length, 1)
  // 反向：种子先落（刚刷新种下），其后到达的名册无边沿可落，不重记不改写
  let t2 = seedRoomTurnEnds(emptyRoomTurnTracker(), [{ roomId: "room-b", kind: "error", at: 2000 }], "room-a")
  t2 = trackRoomListEdges(t2, roomsWith(false), "room-a", 2100)
  assert.equal(roomTurnEndsOf(t2).length, 1)
  assert.equal(roomTurnEndsOf(t2)[0].error, true)
  assert.equal(roomTurnEndsOf(t2)[0].at, 2000)
})

test("集成 R3-1：room_attention 帧语义——null 清记录、清后不复活、当前房不种、坏帧不认", () => {
  let tracker = seedRoomTurnEnds(emptyRoomTurnTracker(), [{ roomId: "room-b", kind: "done", at: 2000 }], "room-a")
  assert.equal(roomTurnEndsOf(tracker).length, 1)
  // 别端进房已读 → relay 广播 null → 本地经 forget 清掉（useRelay 的帧处理路径）
  const cleared = roomAttentionSeedOf("room-b", null)
  assert.deepEqual(cleared, { roomId: "room-b", seed: null })
  tracker = forgetRoomTurnEnd(tracker, cleared.roomId)
  assert.deepEqual(roomTurnEndsOf(tracker), [])
  // 清后再来一份摘要已空的名册：种子为空，不复活（验收 2 的 UI 半边）
  tracker = seedRoomTurnEnds(tracker, roomTurnSeedsOf([{ id: "room-b", busy: false, lastTurnEnd: null }]), "room-a")
  assert.deepEqual(roomTurnEndsOf(tracker), [])
  // 当前房的摘要不种（身处该房不算未看，也防离开后复活）
  const t2 = seedRoomTurnEnds(emptyRoomTurnTracker(), [{ roomId: "room-a", kind: "done", at: 2000 }], "room-a")
  assert.deepEqual(roomTurnEndsOf(t2), [])
  // 坏帧不认：kind 非法 / 房间为空 / 名册里的坏条目一律跳过
  assert.equal(roomAttentionSeedOf("room-b", { kind: "weird", at: 1 }), null)
  assert.equal(roomAttentionSeedOf("", { kind: "done", at: 1 }), null)
  assert.deepEqual(roomTurnSeedsOf([{ id: "room-b", lastTurnEnd: { kind: "weird", at: 1 } }, null, { id: "room-c" }]), [])
  // 带记录的帧经 roomAttentionSeedOf 提炼后与种子同路落定
  const withRec = roomAttentionSeedOf("room-b", { kind: "error", at: 2200 })
  const t3 = seedRoomTurnEnds(emptyRoomTurnTracker(), [withRec.seed], "room-a")
  assert.equal(roomTurnEndsOf(t3)[0].error, true)
})

test("集成 R3-1：新回合升沿作废种子记录（陈旧『已完成』不复活）", () => {
  // 按 useRelay 的真实喂养顺序：名册先过边沿立基准（B 闲），种子随后落定
  let tracker = emptyRoomTurnTracker()
  tracker = trackRoomListEdges(tracker, roomsWith(false), "room-a", 1900)
  tracker = seedRoomTurnEnds(tracker, [{ roomId: "room-b", kind: "done", at: 2000 }], "room-a")
  assert.equal(roomTurnEndsOf(tracker).length, 1)
  // B 开新回合：名册 busy 升沿作废旧记录；同帧名册的种子已随 relay 活动清为空
  tracker = trackRoomListEdges(tracker, roomsWith(true), "room-a", 2100)
  assert.deepEqual(roomTurnEndsOf(tracker), [])
  tracker = seedRoomTurnEnds(tracker, roomTurnSeedsOf([{ id: "room-b", busy: true, lastTurnEnd: null }]), "room-a")
  assert.deepEqual(roomTurnEndsOf(tracker), [])
})

test("presence 状态点语义表：注意力优先于运行 / 在线", () => {
  assert.deepEqual(attentionDotOf({ item: { kind: "waiting" }, busy: true, online: true }), {
    tone: "warning",
    pulse: true,
    label: "等你处理",
  })
  assert.deepEqual(attentionDotOf({ item: { kind: "error" }, busy: false, online: true }), {
    tone: "danger",
    pulse: false,
    label: "回合出错了",
  })
  assert.deepEqual(attentionDotOf({ item: { kind: "done" }, busy: false, online: true }), {
    tone: "success",
    pulse: false,
    label: "已完成，还没看",
  })
  assert.deepEqual(attentionDotOf({ item: { kind: "device-offline" }, busy: false, online: false }), {
    tone: "danger",
    pulse: false,
    label: "设备未连接",
  })
  assert.deepEqual(attentionDotOf({ item: null, busy: true, online: true }), { tone: "success", pulse: true, label: "运行中" })
  assert.deepEqual(attentionDotOf({ item: null, busy: false, online: false }), { tone: "muted", pulse: false, label: "已结束" })
  assert.deepEqual(attentionDotOf({ item: null, busy: false, online: true }), { tone: "success", pulse: false, label: "在线" })
})

/* ── P9 A：room.dialogs 房间等待摘要（spec §3.5）────────────────────────────
 * relay 给别的房间的未决 dialog 发摘要（room_list 条目 / room_waiting 帧）。这里验
 * attentionItemsOf 的第 1b 步：成条、当前房不重复、离线不出、waitingPrompt 兜底只在
 * waiting 空时生效、旧字段不带时结果不变；顺带验 parseRooms 的校验规则（与 relay 同
 * 口径：最多 8 条、dialogId 必须是非空字符串、非法项丢掉）。 */

const WAITING = [
  { dialogId: "dlg-1", kind: "confirm", title: "允许执行 npm test？", startedAt: 900, answerable: true },
  { dialogId: "dlg-2", kind: "input", startedAt: 950 },
]

test("P9 A：别的房间的 waiting 成条（标题用会话名、answerable 透传、排在回合结果前）", () => {
  const items = attentionItemsOf(
    snapshot({
      rooms: [room("room-a", { name: "会话甲" }), room("room-b", { name: "会话乙", waiting: WAITING })],
      roomTurnEnds: [{ seq: 1, at: 800, roomId: "room-b", error: false }],
    }),
  )
  const waiting = items.filter((i) => i.kind === "waiting")
  assert.deepEqual(
    waiting.map((i) => [i.key, i.roomId, i.deviceId, i.title]),
    [
      ["dialog:dlg-1", "room-b", "dev-1", "会话乙"],
      ["dialog:dlg-2", "room-b", "dev-1", "会话乙"],
    ],
  )
  assert.equal(waiting[0].detail, "允许执行 npm test？", "waiting 自带标题当说明")
  assert.equal(waiting[1].detail, "有弹窗等你处理", "没标题回落通用句")
  assert.equal(waiting[0].answerable, true)
  assert.equal(waiting[1].answerable, false)
  assert.equal(waiting[0].at, 900)
  assert.deepEqual(items.map((i) => i.kind), ["waiting", "waiting", "done"], "waiting 优先级最高，别房回合结果仍在")
})

test("P9 A：当前房间不重复计数（只用实时 dialogs；房间摘要里的同房条目不进清单）", () => {
  const items = attentionItemsOf(
    snapshot({
      dialogs: DIALOGS,
      rooms: [room("room-a", { name: "会话甲", waiting: WAITING }), room("room-b", { name: "会话乙" })],
    }),
  )
  assert.equal(items.filter((i) => i.kind === "waiting").length, 2, "只数实时 dialogs 的 2 条")
  assert.ok(items.every((i) => i.roomId === "room-a"))
})

test("P9 A：离线房间不出条目（即使坏数据带着 waiting）", () => {
  const items = attentionItemsOf(
    snapshot({
      rooms: [room("room-a", { name: "会话甲" }), room("room-b", { name: "会话乙", online: false, waiting: WAITING })],
    }),
  )
  assert.deepEqual(items, [])
})

test("P9 A：waitingPrompt 兜底只在 waiting 为空时生效（同一件事不双计）", () => {
  const prompt = { kind: "confirm", title: "电脑上有一个确认框在等待", at: 700 }
  const withWaiting = attentionItemsOf(
    snapshot({
      rooms: [room("room-a", { name: "会话甲" }), room("room-b", { name: "会话乙", waiting: WAITING, waitingPrompt: prompt })],
    }),
  )
  assert.equal(withWaiting.filter((i) => i.kind === "waiting").length, 2, "waiting 非空：不要 waitingPrompt")
  const fallback = attentionItemsOf(
    snapshot({
      rooms: [room("room-a", { name: "会话甲" }), room("room-b", { name: "会话乙", waiting: [], waitingPrompt: prompt })],
    }),
  )
  assert.equal(fallback.length, 1)
  assert.deepEqual([fallback[0].key, fallback[0].detail, fallback[0].at, fallback[0].answerable], [
    "prompt:room-b",
    "电脑上有一个确认框在等待",
    700,
    false,
  ])
})

test("P9 A：不传新字段时旧用例结果不变（旧 relay 兼容）", () => {
  const base = snapshot({ turnEnd: { seq: 3, at: 300, roomId: "room-b", error: true } })
  const cloned = { ...base, rooms: base.rooms.map((r) => ({ ...r })) }
  assert.deepEqual(attentionItemsOf(base), attentionItemsOf(cloned))
})

test("P9 A：room_list 的 waiting/waitingPrompt 校验（最多 8 条、dialogId 必须非空、非法项丢掉）", () => {
  const [parsed] = parseRooms([
    {
      id: "room-b",
      online: true,
      waiting: [
        ...Array.from({ length: 10 }, (_, k) => ({ dialogId: `d${k}`, kind: "confirm", startedAt: k })),
        { dialogId: "", kind: "confirm" },
        { kind: "input" },
        "not-a-record",
      ],
      waitingPrompt: { kind: "", title: "旧信号", at: 5 },
    },
  ])
  assert.equal(parsed.waiting.length, 8, "上限 8 条（协议 limits.dialogSlotsMax）")
  assert.deepEqual(parsed.waiting.map((w) => w.dialogId), ["d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"])
  assert.deepEqual(parsed.waitingPrompt, { kind: "", title: "旧信号", at: 5 })
  const [empty] = parseRooms([{ id: "room-c", online: true, waiting: [], waitingPrompt: null }])
  assert.deepEqual(empty.waiting, [])
  assert.equal(empty.waitingPrompt, null)
  const [legacy] = parseRooms([{ id: "room-d", online: true }])
  assert.equal(legacy.waiting, undefined, "旧 relay 不带字段：保持 undefined（与明确为空区分）")
  assert.equal(legacy.waitingPrompt, undefined)
  const [badPrompt] = parseRooms([{ id: "room-e", waitingPrompt: "oops" }])
  assert.equal(badPrompt.waitingPrompt, null)
})
