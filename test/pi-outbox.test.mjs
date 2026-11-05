// P5.6 离线 outbox：outboxReducer、持久化与 useRelay 接线（不启动浏览器、不依赖 React）。
// Node ≥ 22.18 原生剥离 TS 类型，直接 import .ts 源文件（与 ui-relay-fixes.test.mjs 同一套做法）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  EMPTY_OUTBOX,
  OUTBOX_DELIVERY_CONFIRM_MS,
  OUTBOX_ROOM_MAX,
  OUTBOX_STORAGE_KEY,
  loadOutbox,
  nextReplay,
  outboxOf,
  outboxReducer,
  outboxSize,
  parseOutbox,
  saveOutbox,
  serializeOutbox,
} from "../ui/src/pi/model/outbox.ts"
import { CommandChannel } from "../ui/src/relay/commands.ts"

const reduce = (state, ...actions) => actions.reduce(outboxReducer, state)
const enq = (roomId, n, extra = {}) => ({ type: "enqueue", roomId, cid: `c${n}`, dedupeKey: `k${n}`, text: `消息 ${n}`, at: 1000 + n, ...extra })
const statuses = (state, roomId) => outboxOf(state, roomId).map((e) => `${e.cid}:${e.status}`)

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
  }
}

/** 照 useRelay.replayOutbox 的循环：取下一条 → 认领 → 发 → sent / fail / requeue */
async function drain(state, roomId, send) {
  for (;;) {
    const entry = nextReplay(state, roomId)
    if (!entry) return state
    state = outboxReducer(state, { type: "replay", roomId, cid: entry.cid })
    try {
      await send(entry)
      state = outboxReducer(state, { type: "sent", roomId, cid: entry.cid })
    } catch (error) {
      if (error.code === "offline") return outboxReducer(state, { type: "requeue", roomId, cid: entry.cid })
      state = outboxReducer(state, { type: "fail", roomId, cid: entry.cid, error: error.message, unknown: error.code === "result_unknown" })
    }
  }
}

test("入队：按顺序排在会话下，带 cid + dedupeKey，状态 queued；正文去首尾空白", () => {
  const s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2, { text: "  第二条  " }))
  const list = outboxOf(s, "r1")
  assert.deepEqual(list.map((e) => e.cid), ["c1", "c2"])
  assert.deepEqual(list[0], { cid: "c1", dedupeKey: "k1", roomId: "r1", text: "消息 1", at: 1001, status: "queued" })
  assert.equal(list[1].text, "第二条")
  assert.equal(outboxSize(s), 2)
})

test("入队拒绝：空正文、坏 cid、坏 dedupeKey、没有会话、会话排满时状态不变", () => {
  const base = reduce(EMPTY_OUTBOX, enq("r1", 1))
  for (const bad of [
    enq("r1", 9, { text: "   " }),
    enq("r1", 9, { cid: "有空格 的 cid" }),
    enq("r1", 9, { dedupeKey: "" }),
    enq("r1", 9, { dedupeKey: "x".repeat(129) }),
    enq("", 9),
  ]) {
    assert.equal(outboxReducer(base, bad), base, JSON.stringify(bad))
  }
  let full = EMPTY_OUTBOX
  for (let n = 0; n < OUTBOX_ROOM_MAX; n += 1) full = outboxReducer(full, enq("r1", n))
  assert.equal(outboxOf(full, "r1").length, OUTBOX_ROOM_MAX)
  assert.equal(outboxReducer(full, enq("r1", 999)), full, "排满后不再入队（调用方把消息留在输入框）")
})

test("重复 cid / dedupeKey：任一会话里已有就不入队，同一条消息不会进两次", () => {
  const s = reduce(EMPTY_OUTBOX, enq("r1", 1))
  assert.equal(outboxReducer(s, enq("r1", 1)), s, "同 cid 同会话")
  assert.equal(outboxReducer(s, enq("r2", 1)), s, "同 cid 别的会话也不行")
  assert.equal(outboxReducer(s, { ...enq("r1", 2), dedupeKey: "k1" }), s, "dedupeKey 撞了")
  assert.equal(outboxReducer(s, { ...enq("r1", 2), cid: "c1" }), s)
  // 重试换的新 id 也不能撞已有条目
  const failed = reduce(s, enq("r1", 2), { type: "replay", roomId: "r1", cid: "c1" }, { type: "fail", roomId: "r1", cid: "c1", error: "x" })
  assert.equal(outboxReducer(failed, { type: "retry", roomId: "r1", cid: "c1", nextCid: "c2", nextDedupeKey: "kn" }), failed)
  assert.equal(outboxReducer(failed, { type: "retry", roomId: "r1", cid: "c1", nextCid: "cn", nextDedupeKey: "k2" }), failed)
})

test("顺序回放：只认领队首、同一会话一次只有一条在飞，发完一条才轮到下一条", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2), enq("r1", 3))
  assert.equal(nextReplay(s, "r1").cid, "c1")
  assert.equal(outboxReducer(s, { type: "replay", roomId: "r1", cid: "c2" }), s, "不能越过队首认领")
  s = outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1" })
  assert.deepEqual(statuses(s, "r1"), ["c1:replaying", "c2:queued", "c3:queued"])
  assert.equal(nextReplay(s, "r1"), null, "c1 在飞时不给下一条")
  assert.equal(outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1" }), s, "已认领的不能再认领（同一 cid 只发一次）")
  s = outboxReducer(s, { type: "sent", roomId: "r1", cid: "c1" })
  assert.equal(nextReplay(s, "r1").cid, "c2")
})

test("回放循环：两条按入队顺序各发一次，发完 outbox 清空、会话键也删掉", async () => {
  const s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2))
  const sent = []
  const done = await drain(s, "r1", async (entry) => void sent.push([entry.cid, entry.dedupeKey, entry.text]))
  assert.deepEqual(sent, [["c1", "k1", "消息 1"], ["c2", "k2", "消息 2"]])
  assert.deepEqual(done.byRoom, {})
  assert.equal(outboxSize(done), 0)
})

test("回放失败：留在原位标 failed（带原因 / 结果未知），后面的照常发；replaying 之外不能 fail", async () => {
  const s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2), enq("r1", 3))
  const sent = []
  const done = await drain(s, "r1", async (entry) => {
    sent.push(entry.cid)
    if (entry.cid === "c1") throw Object.assign(new Error("会话已不存在"), { code: "no_room" })
    if (entry.cid === "c3") throw Object.assign(new Error("没有回应"), { code: "result_unknown" })
  })
  assert.deepEqual(sent, ["c1", "c2", "c3"], "每条只发了一次")
  const list = outboxOf(done, "r1")
  assert.deepEqual(list.map((e) => [e.cid, e.status, e.error, e.unknown]), [
    ["c1", "failed", "会话已不存在", undefined],
    ["c3", "failed", "没有回应", true],
  ])
  assert.equal(nextReplay(done, "r1"), null, "failed 不会被自动回放")
  assert.equal(outboxReducer(done, { type: "fail", roomId: "r1", cid: "c1", error: "again" }), done)
})

test("没发出去（offline）：原样放回队首、cid 不变，下次回放仍从它开始", async () => {
  const s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2))
  const done = await drain(s, "r1", async () => {
    throw Object.assign(new Error("连接不可用"), { code: "offline" })
  })
  assert.deepEqual(statuses(done, "r1"), ["c1:queued", "c2:queued"])
  assert.equal(nextReplay(done, "r1").cid, "c1")
})

test("重试：failed → queued，换新 cid + dedupeKey，位置不变；queued / replaying 不能重试", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2), { type: "replay", roomId: "r1", cid: "c1" }, { type: "fail", roomId: "r1", cid: "c1", error: "x", unknown: true })
  assert.equal(outboxReducer(s, { type: "retry", roomId: "r1", cid: "c2", nextCid: "n2", nextDedupeKey: "nk2" }), s, "queued 不能重试")
  s = outboxReducer(s, { type: "retry", roomId: "r1", cid: "c1", nextCid: "n1", nextDedupeKey: "nk1" })
  const [first] = outboxOf(s, "r1")
  assert.deepEqual(first, { cid: "n1", dedupeKey: "nk1", roomId: "r1", text: "消息 1", at: 1001, status: "queued" }, "错误标记清掉、旧 cid 不再出现")
  assert.equal(nextReplay(s, "r1").cid, "n1")
})

test("取消：queued / failed 可以取消，正在发的不能；取消最后一条后会话键删掉", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2), enq("r1", 3), { type: "replay", roomId: "r1", cid: "c1" })
  assert.equal(outboxReducer(s, { type: "cancel", roomId: "r1", cid: "c1" }), s, "replaying 不能取消")
  s = outboxReducer(s, { type: "cancel", roomId: "r1", cid: "c2" })
  assert.deepEqual(statuses(s, "r1"), ["c1:replaying", "c3:queued"])
  s = reduce(s, { type: "fail", roomId: "r1", cid: "c1", error: "x" }, { type: "cancel", roomId: "r1", cid: "c1" }, { type: "cancel", roomId: "r1", cid: "c3" })
  assert.deepEqual(s.byRoom, {})
  assert.equal(outboxReducer(s, { type: "cancel", roomId: "r1", cid: "nope" }), s)
})

test("按会话隔离：动作只认本会话的条目，各会话各自排队、各自回放", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r2", 2), enq("r1", 3))
  assert.deepEqual(outboxOf(s, "r1").map((e) => e.cid), ["c1", "c3"])
  assert.deepEqual(outboxOf(s, "r2").map((e) => e.cid), ["c2"])
  assert.deepEqual(outboxOf(s, "r3"), [])
  assert.deepEqual(outboxOf(s, null), [])
  assert.equal(outboxReducer(s, { type: "cancel", roomId: "r1", cid: "c2" }), s, "别的会话的 cid 取消不了")
  assert.equal(outboxReducer(s, { type: "replay", roomId: "r2", cid: "c1" }), s)
  s = outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1" })
  assert.equal(nextReplay(s, "r2").cid, "c2", "r1 在飞不挡 r2")
})

test("持久化：serialize → parse 往返不变；空 outbox 删键；存储写失败返回 false", () => {
  const s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r2", 2), { type: "replay", roomId: "r1", cid: "c1" }, { type: "fail", roomId: "r1", cid: "c1", error: "x", unknown: true })
  assert.deepEqual(parseOutbox(serializeOutbox(s)), s)
  const storage = memoryStorage()
  assert.equal(saveOutbox(storage, s), true)
  assert.ok(storage.data.has(OUTBOX_STORAGE_KEY))
  assert.deepEqual(loadOutbox(storage), s)
  assert.equal(saveOutbox(storage, EMPTY_OUTBOX), true)
  assert.equal(storage.data.has(OUTBOX_STORAGE_KEY), false)
  const full = { getItem: () => null, removeItem() {}, setItem() { throw new Error("QuotaExceededError") } }
  assert.equal(saveOutbox(full, s), false)
  assert.equal(saveOutbox(null, s), false)
  assert.deepEqual(loadOutbox(null), EMPTY_OUTBOX)
  assert.deepEqual(loadOutbox({ getItem() { throw new Error("SecurityError") } }), EMPTY_OUTBOX)
})

test("恢复：页面关在回放途中的条目转 failed（结果未知），不会自动再发同一个 cid", () => {
  const s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2), { type: "replay", roomId: "r1", cid: "c1" })
  const restored = parseOutbox(serializeOutbox(s))
  assert.equal(outboxOf(restored, "r1")[0].status, "replaying", "解析本身不改状态（别的标签页可能正在发）")
  const recovered = outboxReducer(restored, { type: "recover", error: "结果未知" })
  assert.deepEqual(outboxOf(recovered, "r1").map((e) => [e.cid, e.status, e.unknown]), [["c1", "failed", true], ["c2", "queued", undefined]])
  assert.equal(nextReplay(recovered, "r1").cid, "c2")
  assert.equal(outboxReducer(recovered, { type: "recover", error: "x" }), recovered, "没有在飞条目时不变")
})

test("异常数据：坏 JSON、错版本、错类型、坏条目、重复 cid 一律丢弃，不抛", () => {
  for (const raw of [null, "", "{", "[]", "123", '"x"', '{"v":2,"rooms":{}}', '{"v":1}', '{"v":1,"rooms":[]}', '{"v":1,"rooms":{"r1":"x"}}']) {
    assert.deepEqual(parseOutbox(raw), EMPTY_OUTBOX, String(raw))
  }
  const good = { cid: "c1", dedupeKey: "k1", text: "好的", at: 1, status: "queued" }
  const raw = JSON.stringify({
    v: 1,
    rooms: {
      r1: [
        good,
        { ...good, dedupeKey: "k9" }, // 重复 cid
        { ...good, cid: "c9" }, // 重复 dedupeKey
        { ...good, cid: "c2", dedupeKey: "k2", status: "sent" },
        { ...good, cid: "c3", dedupeKey: "k3", text: "   " },
        { ...good, cid: "c4", dedupeKey: "k4", at: "1" },
        { ...good, cid: "bad cid", dedupeKey: "k5" },
        { ...good, cid: "c6", dedupeKey: "k6", text: "x".repeat(100_001) },
        null,
        "str",
        { ...good, cid: "c7", dedupeKey: "k7", status: "failed" }, // 缺 error 时补默认
      ],
      r2: [],
      "": [good],
    },
  })
  const s = parseOutbox(raw)
  assert.deepEqual(Object.keys(s.byRoom), ["r1"])
  assert.deepEqual(outboxOf(s, "r1").map((e) => [e.cid, e.status, e.error]), [["c1", "queued", undefined], ["c7", "failed", "发送失败"]])
  assert.equal(outboxOf(s, "r1")[0].roomId, "r1")
})

test("命令通道：outbox 回放带自己的 dedupeKey，channel 重发同一帧时 key 不变", () => {
  const frames = []
  const channel = new CommandChannel({ acceptTimeoutMs: 60_000 })
  channel.attach({ readyState: 1, send: (data) => frames.push(JSON.parse(data)) })
  void channel.command("r1", "prompt", { message: "hi", cid: "c1" }, "lost", "ob_k1").catch(() => {})
  void channel.command("r1", "prompt", { message: "hi" }).catch(() => {})
  assert.equal(frames[0].dedupeKey, "ob_k1")
  assert.equal(frames[0].args.cid, "c1")
  assert.equal(frames[1].dedupeKey, frames[1].id, "不传时仍用帧 id（在线发送路径不变）")
  channel.disconnected()
  channel.connected("")
  channel.dispose()
})

test("B-3 交出不等于送达：handoff 后条目留 awaiting，nextReplay 被它挡住（保序单飞）", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2))
  s = outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1", owner: "w1" })
  s = outboxReducer(s, { type: "handoff", roomId: "r1", cid: "c1", at: 5000, owner: "w1" })
  const [first, second] = outboxOf(s, "r1")
  assert.equal(first.status, "awaiting")
  assert.equal(first.handedAt, 5000)
  assert.equal(second.status, "queued")
  assert.equal(nextReplay(s, "r1"), null, "上一条没拿到设备确认前，下一条不发")
  // handoff 只认 replaying：对 queued 条目直接 handoff 不生效
  const untouched = outboxReducer(s, { type: "handoff", roomId: "r1", cid: "c2", at: 6000 })
  assert.equal(outboxOf(untouched, "r1")[1].status, "queued")
})

test("B-3 设备确认才清条目：delivered 移出（awaiting / replaying 竞态 / 超时后迟到都认）", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2))
  s = outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1" })
  s = outboxReducer(s, { type: "handoff", roomId: "r1", cid: "c1", at: 5000 })
  s = outboxReducer(s, { type: "delivered", roomId: "r1", cid: "c1" })
  assert.deepEqual(statuses(s, "r1"), ["c2:queued"])
  assert.equal(nextReplay(s, "r1")?.cid, "c2", "确认后下一条才能回放")
  // 竞态：确认帧先于 handoff 落定到达（条目还在 replaying）也要清
  let race = reduce(EMPTY_OUTBOX, enq("r1", 1))
  race = outboxReducer(race, { type: "replay", roomId: "r1", cid: "c1" })
  race = outboxReducer(race, { type: "delivered", roomId: "r1", cid: "c1" })
  assert.equal(outboxSize(race), 0)
  // 迟到：巡查已标 failed（未知），设备确认随后到——以设备事实为准，移出
  let late = reduce(EMPTY_OUTBOX, enq("r1", 1))
  late = outboxReducer(late, { type: "replay", roomId: "r1", cid: "c1" })
  late = outboxReducer(late, { type: "handoff", roomId: "r1", cid: "c1", at: 5000 })
  late = outboxReducer(late, { type: "confirm-timeout", roomId: "r1", cid: "c1", error: "设备长时间没有确认收到" })
  assert.equal(outboxOf(late, "r1")[0].status, "failed")
  late = outboxReducer(late, { type: "delivered", roomId: "r1", cid: "c1" })
  assert.equal(outboxSize(late), 0)
  // 对不上 cid 的确认不动别人的条目
  const other = outboxReducer(s, { type: "delivered", roomId: "r1", cid: "nope" })
  assert.equal(other, s)
})

test("B-3 设备报失败：delivery-failed 转 failed（留正文、可重试），不是 unknown", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1))
  s = outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1" })
  s = outboxReducer(s, { type: "handoff", roomId: "r1", cid: "c1", at: 5000 })
  s = outboxReducer(s, { type: "delivery-failed", roomId: "r1", cid: "c1", error: "pi 没有接收这条消息" })
  const entry = outboxOf(s, "r1")[0]
  assert.equal(entry.status, "failed")
  assert.equal(entry.error, "pi 没有接收这条消息")
  assert.equal(entry.unknown, undefined, "设备明确报的失败不是结果未知")
  assert.equal(entry.text, "消息 1", "正文保留")
  // 已是 failed 时迟到的失败帧不覆盖先到的失败原因
  const again = outboxReducer(s, { type: "delivery-failed", roomId: "r1", cid: "c1", error: "别的错" })
  assert.equal(again, s)
  // 失败后可按老口径重试（换新 cid）
  const retried = outboxReducer(s, { type: "retry", roomId: "r1", cid: "c1", nextCid: "c9", nextDedupeKey: "k9" })
  assert.deepEqual(statuses(retried, "r1"), ["c9:queued"])
})

test("B-3 确认超时与恢复：confirm-timeout 只动 awaiting；recover 把 awaiting 也转 failed（未知）", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1), enq("r1", 2))
  s = outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1" })
  s = outboxReducer(s, { type: "handoff", roomId: "r1", cid: "c1", at: 5000 })
  const timed = outboxReducer(s, { type: "confirm-timeout", roomId: "r1", cid: "c1", error: "设备长时间没有确认收到这条消息" })
  const entry = outboxOf(timed, "r1")[0]
  assert.equal(entry.status, "failed")
  assert.equal(entry.unknown, true)
  assert.equal(entry.handedAt, undefined, "落定后清掉交出时刻")
  // confirm-timeout 对 queued 条目不生效
  const noop = outboxReducer(timed, { type: "confirm-timeout", roomId: "r1", cid: "c2", error: "x" })
  assert.equal(noop, timed)
  // 页面重开：awaiting 与 replaying 一样按结果未知收
  const recovered = outboxReducer(s, { type: "recover", error: "上次发送途中页面关闭，结果未知；请看会话再决定是否重试" })
  assert.equal(outboxOf(recovered, "r1")[0].status, "failed")
  assert.equal(outboxOf(recovered, "r1")[0].unknown, true)
  assert.ok(OUTBOX_DELIVERY_CONFIRM_MS >= 60_000, "确认上限是分钟级，不是秒级误杀")
})

test("B-3 awaiting 不可取消（已在设备手里）、可持久化往返（handedAt 保留，坏值回落入队时刻）", () => {
  let s = reduce(EMPTY_OUTBOX, enq("r1", 1))
  s = outboxReducer(s, { type: "replay", roomId: "r1", cid: "c1" })
  s = outboxReducer(s, { type: "handoff", roomId: "r1", cid: "c1", at: 5000 })
  assert.equal(outboxReducer(s, { type: "cancel", roomId: "r1", cid: "c1" }), s, "awaiting 点取消不动（去设备待发队列里取消）")
  const storage = memoryStorage()
  assert.equal(saveOutbox(storage, s), true)
  const back = loadOutbox(storage)
  assert.deepEqual(outboxOf(back, "r1").map((e) => [e.status, e.handedAt]), [["awaiting", 5000]])
  const bad = parseOutbox(JSON.stringify({ v: 1, rooms: { r1: [{ cid: "c1", dedupeKey: "k1", text: "消息 1", at: 1001, status: "awaiting", handedAt: "x" }] } }))
  assert.equal(outboxOf(bad, "r1")[0].handedAt, 1001)
})

test("B-3 useRelay 接线：回放落 handoff、delivered/failed 事件落 outbox 终局、有确认巡查", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  const replay = relay.slice(relay.indexOf("const replayOutbox = useCallback"), relay.indexOf("const outboxCancel = useCallback"))
  assert.match(replay, /type: "handoff"/, "命令成功先转 awaiting，不直接清条目")
  assert.match(replay, /confirmable \? commitOutbox\(\{ type: "handoff"|commitOutbox\(\{ type: "handoff"/, "带 cid 才等确认")
  assert.match(relay, /case "remote_message_delivered":[\s\S]{0,400}type: "delivered"/, "设备确认帧落 outbox")
  assert.match(relay, /case "remote_message_failed":[\s\S]{0,600}type: "delivery-failed"/, "设备失败帧落 outbox")
  assert.match(relay, /type: "confirm-timeout"/, "有确认超时巡查")
  assert.match(relay, /OUTBOX_DELIVERY_CONFIRM_MS/, "巡查用模型层的确认上限")
})

test("useRelay 接线：离线入队、恢复后回放、失败标失败、可取消 / 重试；在线且 outbox 为空时走原路径", () => {
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  const sendText = relay.slice(relay.indexOf("const sendText = useCallback"), relay.indexOf("const replayOutbox = useCallback"))
  const replay = relay.slice(relay.indexOf("const replayOutbox = useCallback"), relay.indexOf("const outboxCancel = useCallback"))
  assert.match(sendText, /if \(offline \|\| backlog\) \{[\s\S]*type: "enqueue"/, "离线或 outbox 还有待发时入队")
  assert.match(sendText, /OFFLINE_SEND_COPY/, "存不进 outbox 时退回旧口径，消息留在输入框")
  assert.ok(sendText.indexOf('type: "enqueue"') < sendText.indexOf("sendLock.current.acquire(cid)"), "入队分支在在线发送之前返回")
  assert.match(replay, /nextReplay\(/)
  assert.match(replay, /type: "replay"[\s\S]*channel\.command\(roomId, plan\.command, args, lostMessageFor\(plan\.command\), entry\.dedupeKey\)/, "先认领再发，带条目的 dedupeKey")
  assert.match(replay, /type: "fail"/)
  assert.match(replay, /type: "requeue"/)
  assert.match(relay, /type: "recover"/, "载入时把在飞条目转失败")
  assert.match(relay, /outbox,\n\s*outboxCancel,\n\s*outboxRetry,/, "对外暴露 outbox / 取消 / 重试")
})

test("回放投递计划：同一轮里 prompt 开过回合，后面的条目按忙时走 steer / follow_up（L3 L19）", async () => {
  const { deliveryPlan } = await import("../ui/src/chat/composerTools.ts")
  // 照 replayOutbox：busy 要等 pi 的事件回来才变，startedTurn 补上同一轮里的这个空档
  const commands = (mode, busy) => {
    let startedTurn = false
    return [1, 2, 3].map(() => {
      const plan = deliveryPlan(mode, busy || startedTurn)
      if (plan.command === "prompt") startedTurn = true
      return plan.command
    })
  }
  assert.deepEqual(commands("auto", false), ["prompt", "steer", "steer"], "第 2 条起不再按空闲发 prompt（扩展忙时拒收）")
  assert.deepEqual(commands("follow_up", false), ["prompt", "follow_up", "follow_up"])
  assert.deepEqual(commands("steer", false), ["prompt", "steer", "steer"])
  assert.deepEqual(commands("auto", true), ["steer", "steer", "steer"], "本来就忙：一条 prompt 都不发")
  const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  const replay = relay.slice(relay.indexOf("const replayOutbox = useCallback"), relay.indexOf("const outboxCancel = useCallback"))
  assert.match(replay, /let startedTurn = false/, "每一轮回放重新计")
  assert.match(replay, /const plan = deliveryPlan\(sendModeRef\.current, busyRef\.current \|\| startedTurn\)/)
  assert.match(replay, /await channel\.command\([^\n]*\)\n\s*if \(plan\.command === "prompt"\) startedTurn = true/, "送达以后才记开过回合")
})
