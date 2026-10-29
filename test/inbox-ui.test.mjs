// 收件箱账本 UI 侧（设计 D §1.5）：inbox.ts 纯函数（清洗/增量并入/种子提炼）+
// attention 归约的账本切片（别房 waiting 只从账本取、当前房硬去重、无切片回落旧面、
// 计数恒等：清单 waiting+error+done 之和 == 账本 pending 数）。
import test from "node:test"
import assert from "node:assert/strict"
import { attentionCountOf, attentionItemsOf } from "../ui/src/relay/attention.ts"
import { applyInboxUpdate, inboxDialogIdOf, inboxTurnSeedsOf, parseInboxEntries } from "../ui/src/relay/inbox.ts"

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
    rooms: [room("room-a", { name: "会话甲" }), room("room-b", { name: "会话乙" }), room("room-c", { name: "会话丙" })],
    dialogs: [],
    uiPrompt: null,
    turnEnd: null,
    selectedDevice: { id: "dev-1", name: "我的电脑", online: true },
    ...extra,
  }
}

const entry = (over = {}) => ({
  key: "dialog:d-9",
  accountId: "admin",
  roomId: "room-b",
  deviceId: "dev-1",
  kind: "waiting",
  subkind: "dialog",
  dialogKind: "confirm",
  title: "允许执行？",
  answerable: true,
  at: 500,
  ...over,
})

test("parseInboxEntries：坏形状丢弃、缺省字段补齐、正文面不透传", () => {
  const out = parseInboxEntries([
    entry(),
    { key: "x" },
    null,
    "nope",
    entry({ key: "turn:room-b:900", subkind: "turn", kind: "done", at: 900, options: ["不许带"] }),
    entry({ key: "dialog:bad", at: "不是数字" }),
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].key, "dialog:d-9")
  assert.equal("options" in out[1], false)
  assert.deepEqual(parseInboxEntries(undefined), [])
  assert.deepEqual(parseInboxEntries({}), [])
})

test("applyInboxUpdate：覆盖/删除/无变化引用不变", () => {
  const base = parseInboxEntries([entry(), entry({ key: "dialog:d-10", at: 600 })])
  const same = applyInboxUpdate(base, [entry()], [])
  assert.equal(same, base, "同内容 upsert 不换引用")
  const changed = applyInboxUpdate(base, [entry({ title: "新标题" })], [])
  assert.notEqual(changed, base)
  assert.equal(changed.find((e) => e.key === "dialog:d-9").title, "新标题")
  const removed = applyInboxUpdate(changed, [], ["dialog:d-9", "dialog:不存在"])
  assert.deepEqual(removed.map((e) => e.key), ["dialog:d-10"])
  assert.equal(applyInboxUpdate(base, [], []), base)
})

test("inboxTurnSeedsOf：只提 turn 的 done/error；inboxDialogIdOf 只认 dialog 条目", () => {
  const seeds = inboxTurnSeedsOf([
    entry(),
    entry({ key: "turn:room-b:900", subkind: "turn", kind: "done", at: 900 }),
    entry({ key: "turn:room-c:950", subkind: "turn", kind: "error", roomId: "room-c", at: 950 }),
    entry({ key: "turn:room-c:990", subkind: "turn", kind: "waiting", roomId: "room-c", at: 990 }),
  ])
  assert.deepEqual(seeds, [
    { roomId: "room-b", kind: "done", at: 900 },
    { roomId: "room-c", kind: "error", at: 950 },
  ])
  assert.equal(inboxDialogIdOf(entry()), "d-9")
  assert.equal(inboxDialogIdOf(entry({ key: "ask:a1", subkind: "ask" })), null)
})

test("账本切片：别房 dialog/prompt/ask 条目成 waiting 条，键与既有纪律同格式", () => {
  const items = attentionItemsOf(snapshot({
    inbox: [
      entry(),
      entry({ key: "prompt:room-c:700", subkind: "prompt", roomId: "room-c", dialogKind: undefined, title: "", answerable: undefined, at: 700 }),
      entry({ key: "ask:a1", subkind: "ask", roomId: "room-c", dialogKind: undefined, title: "选哪个方案？", at: 800 }),
    ],
  }))
  const waiting = items.filter((i) => i.kind === "waiting")
  assert.deepEqual(waiting.map((i) => i.key), ["dialog:d-9", "prompt:room-c", "ask:a1"])
  assert.equal(waiting[0].answerable, true)
  assert.equal(waiting[0].dialogId, "d-9")
  assert.equal(waiting[0].title, "会话乙")
  assert.equal(waiting[2].dialogId, null, "ask 条目暂不带 dialogId（设计 B 落地时细化）")
})

test("当前房硬规则：账本里当前房的条目跳过，实时 dialogs 说了算（不双计）", () => {
  const items = attentionItemsOf(snapshot({
    dialogs: [{ dialogId: "d-9", kind: "confirm", title: "允许执行？", startedAt: 500, answerable: true }],
    inbox: [entry({ roomId: "room-a" })],
  }))
  const waiting = items.filter((i) => i.kind === "waiting")
  assert.equal(waiting.length, 1)
  assert.equal(waiting[0].roomId, "room-a")
})

test("切片在场即唯一来源：inbox 为空时 room.waiting 摘要不再拼装（防双源）", () => {
  const items = attentionItemsOf(snapshot({
    inbox: [],
    rooms: [
      room("room-a", { name: "会话甲" }),
      room("room-b", { name: "会话乙", waiting: [{ dialogId: "ghost", kind: "confirm", startedAt: 1 }] }),
    ],
  }))
  assert.deepEqual(items, [])
})

test("无切片回落旧面：room.waiting 摘要照常成条（旧 relay 行为不变）", () => {
  const items = attentionItemsOf(snapshot({
    rooms: [
      room("room-a", { name: "会话甲" }),
      room("room-b", { name: "会话乙", waiting: [{ dialogId: "d-1", kind: "confirm", title: "删文件？", startedAt: 100, answerable: true }] }),
    ],
  }))
  assert.equal(items.length, 1)
  assert.equal(items[0].key, "dialog:d-1")
})

test("计数恒等：清单 waiting+error+done 之和 == 账本 pending 数（turn 经种子进追踪器后）", () => {
  const inbox = [
    entry(),
    entry({ key: "prompt:room-c:700", subkind: "prompt", roomId: "room-c", dialogKind: undefined, title: "", answerable: undefined, at: 700 }),
    entry({ key: "turn:room-b:900", subkind: "turn", kind: "done", at: 900 }),
    entry({ key: "turn:room-c:950", subkind: "turn", kind: "error", roomId: "room-c", at: 950 }),
  ]
  // useRelay 的口径：账本 turn 条目作种子种回追踪器，roomTurnEnds 是追踪器出口
  const roomTurnEnds = inboxTurnSeedsOf(inbox).map((seed, i) => ({ seq: i + 1, at: seed.at, roomId: seed.roomId, error: seed.kind === "error" }))
  const items = attentionItemsOf(snapshot({ inbox, roomTurnEnds }))
  const counted = items.filter((i) => i.kind === "waiting" || i.kind === "error" || i.kind === "done")
  assert.equal(attentionCountOf(items), items.length, "本快照无设备掉线条，清单全量即三类之和")
  assert.equal(counted.length, inbox.length, "清单三类之和与账本 pending 数恒等")
  assert.deepEqual(counted.map((i) => i.kind).sort(), ["done", "error", "waiting", "waiting"])
})
