// 定时排期 UI 侧（设计 D §3.7）：schedule.ts 纯函数——入站清洗、名册快照组装、
// cid 来源标注、状态行文案（一次/心跳/终态三式）。
import test from "node:test"
import assert from "node:assert/strict"
import { parseScheduleCid, parseScheduleEntries, scheduleMapOfRooms, scheduleSourceLabel, scheduleStatusLine } from "../ui/src/relay/schedule.ts"

const NOW = new Date(2026, 9, 29, 14, 0, 0).getTime() // 本地 2026-10-29 14:00

function entry(extra = {}) {
  return {
    id: "sch_0123456789abcdef",
    accountId: "admin",
    roomId: "room-a",
    deviceId: "dev-1",
    text: "记得交周报",
    segment: "steer",
    kind: "once",
    at: NOW + 60 * 60 * 1000,
    nextAt: NOW + 60 * 60 * 1000,
    firedCount: 0,
    expireAt: NOW + 24 * 60 * 60 * 1000,
    state: "armed",
    createdAt: NOW,
    stateAt: NOW,
    ...extra,
  }
}

test("清洗：合法条目过、坏形状整条丢、once/every 必备字段缺失丢", () => {
  const ok = parseScheduleEntries([entry()])
  assert.equal(ok.length, 1)
  assert.equal(ok[0].text, "记得交周报")
  assert.deepEqual(parseScheduleEntries([entry({ id: "bad-id" })]), [])
  assert.deepEqual(parseScheduleEntries([entry({ state: "flying" })]), [])
  assert.deepEqual(parseScheduleEntries([entry({ at: undefined })]), [], "once 缺 at 丢")
  assert.deepEqual(parseScheduleEntries([entry({ kind: "every", at: undefined, intervalMs: undefined })]), [], "every 缺 intervalMs 丢")
  const every = parseScheduleEntries([entry({ kind: "every", at: undefined, intervalMs: 1200000 })])
  assert.equal(every.length, 1)
  assert.deepEqual(parseScheduleEntries("nope"), [])
  assert.deepEqual(parseScheduleEntries(null), [])
})

test("名册快照：带 schedules 的房进桶；整批无字段 seen=false（旧 relay 不动副本）", () => {
  const rooms = [
    { id: "room-a", schedules: [entry()] },
    { id: "room-b", schedules: [] },
    { id: "room-c" },
  ]
  const { map, seen } = scheduleMapOfRooms(rooms)
  assert.equal(seen, true)
  assert.equal(map["room-a"].length, 1)
  assert.deepEqual(map["room-b"], [])
  assert.equal("room-c" in map, false)
  assert.equal(scheduleMapOfRooms([{ id: "room-c" }]).seen, false)
  assert.equal(scheduleMapOfRooms(null).seen, false)
})

test("cid 标注：sch_<id>_<拍号> 解出「来自定时 · 第 N 次」，普通 cid 不标注", () => {
  assert.deepEqual(parseScheduleCid("sch_0123456789abcdef_3"), { scheduleId: "sch_0123456789abcdef", fireNo: 3 })
  assert.equal(scheduleSourceLabel("sch_0123456789abcdef_3"), "来自定时 · 第 3 次")
  assert.equal(scheduleSourceLabel("q1_abc"), null)
  assert.equal(scheduleSourceLabel(undefined), null)
  assert.equal(parseScheduleCid("sch_0123456789abcdef_0"), null)
})

test("状态行：once 报时刻一次、心跳报节律/已触发/下次、终态报结局", () => {
  const at = new Date(2026, 9, 29, 21, 30).getTime()
  assert.equal(scheduleStatusLine(entry({ at, nextAt: at }), NOW), "⏰ 今天 21:30 · 一次 · 插入当前回合")
  const tomorrow = new Date(2026, 9, 30, 9, 0).getTime()
  assert.match(scheduleStatusLine(entry({ at: tomorrow, nextAt: tomorrow, segment: "follow_up" }), NOW), /^⏰ 明天 09:00 · 一次 · 回合结束后发送$/)
  const beat = entry({ kind: "every", at: undefined, intervalMs: 20 * 60000, firedCount: 3, nextAt: new Date(2026, 9, 29, 14, 25).getTime() })
  assert.equal(scheduleStatusLine(beat, NOW), "🔁 每 20 分钟 · 已触发 3 次 · 下次 今天 14:25")
  const fresh = entry({ kind: "every", at: undefined, intervalMs: 3600000, firedCount: 0, nextAt: NOW + 3600000 })
  assert.match(scheduleStatusLine(fresh, NOW), /每 1 小时 · 未触发/)
  assert.equal(scheduleStatusLine(entry({ state: "retired", retireReason: "canceled" }), NOW), "已取消")
  assert.equal(scheduleStatusLine(entry({ state: "retired", retireReason: "missed" }), NOW), "已作废 · 错过投递窗口")
  assert.equal(scheduleStatusLine(entry({ state: "failed", retireReason: "delivery_failed", lastError: "队列已满" }), NOW), "投递失败 · 队列已满")
  assert.equal(
    scheduleStatusLine(entry({ kind: "every", at: undefined, intervalMs: 600000, state: "retired", retireReason: "max_fires", firedCount: 5 }), NOW),
    "已达触发上限 · 共 5 次",
  )
})
