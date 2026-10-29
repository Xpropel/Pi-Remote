// 定时/心跳排期（设计 D §3）单测：校验口径、cid 对号、ScheduleStore 落盘/恢复、
// ScheduleEngine 的 tick 状态机（到点投递幂等、心跳不追赶、离线顺延/跳过、失败停机
// 写账本、总到期静默、会话结束退休、重启恢复）。引擎用假时钟 + 假宿主，不起真 relay。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ScheduleStore, ScheduleEngine, validateScheduleInput, scheduleCid, parseScheduleCid } = require("../relay/schedule");
const { InboxStore } = require("../relay/inbox");

const ACCT = "acct-test";
const T0 = 1_700_000_000_000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-schedule-"));
}

/** 假世界：可控时钟 + 房间表 + 投递记录；InboxStore 用真的（顺带验账本接口面）。 */
function makeWorld(engineOpts = {}) {
  const accountsDir = path.join(tmpDir(), "accounts");
  let now = T0;
  const clock = () => now;
  const store = new ScheduleStore(accountsDir, { now: clock });
  const inbox = new InboxStore(accountsDir, { now: clock });
  const rooms = new Map();
  const deliveries = [];
  const engine = new ScheduleEngine({
    store, inbox, now: clock, graceMs: 15 * 60 * 1000, startGraceMs: 0, ...engineOpts,
  });
  engine.bindHost({
    peekRoom: (id) => rooms.get(id) || null,
    deliver: (room, entry, fireNo, done) => { deliveries.push({ room, entry, fireNo, done }); },
    flushInbox: () => {},
    onDirty: () => {},
  });
  return {
    accountsDir, store, inbox, engine, rooms, deliveries,
    now: clock,
    setNow(v) { now = v; },
    advance(ms) { now += ms; },
    addRoom(id, online = true) {
      const room = { id, online, deviceId: "dev-1" };
      rooms.set(id, room);
      return room;
    },
    inboxEntries() { return inbox.snapshot(); },
  };
}

function createOnce(w, roomId, at, extra = {}) {
  const res = w.engine.create(ACCT, { roomId, text: "开会提醒", segment: "steer", kind: "once", at, ...extra });
  assert.ok(res.entry, JSON.stringify(res));
  return res.entry;
}
function createEvery(w, roomId, intervalMs, extra = {}) {
  const res = w.engine.create(ACCT, { roomId, text: "心跳巡检", segment: "follow_up", kind: "every", intervalMs, ...extra });
  assert.ok(res.entry, JSON.stringify(res));
  return res.entry;
}

test("校验：间隔下限/时刻/纯文本/枚举/缺省到期", () => {
  const now = T0;
  const base = { roomId: "r1", text: "hi", segment: "steer" };
  assert.equal(validateScheduleInput({ ...base, kind: "every", intervalMs: 59999 }, now).code, "bad_args");
  assert.ok(validateScheduleInput({ ...base, kind: "every", intervalMs: 60000 }, now).fields);
  assert.equal(validateScheduleInput({ ...base, kind: "once", at: now - 20000 }, now).code, "bad_args", "过时时刻拒绝");
  assert.ok(validateScheduleInput({ ...base, kind: "once", at: now - 5000 }, now).fields, "10 秒容差内放行");
  assert.equal(validateScheduleInput({ ...base, kind: "once", at: now + 1000, images: [{ type: "image", data: "x" }] }, now).code, "bad_args", "一期纯文本：带图拒绝");
  assert.equal(validateScheduleInput({ ...base, kind: "once", at: now + 1000, text: "  " }, now).code, "bad_args");
  assert.equal(validateScheduleInput({ ...base, kind: "once", at: now + 1000, segment: "now" }, now).code, "bad_args");
  assert.equal(validateScheduleInput({ ...base, kind: "daily" }, now).code, "bad_args");
  const f = validateScheduleInput({ ...base, kind: "every", intervalMs: 60000 }, now).fields;
  assert.equal(f.expireAt, now + 24 * 60 * 60 * 1000, "缺省总到期 = 创建 +24h");
  assert.equal(f.nextAt, now + 60000, "every 首拍 = 创建 + 间隔");
  const big = validateScheduleInput({ ...base, kind: "once", at: now + 1000, text: "x".repeat(1024 * 1024 + 1) }, now);
  assert.equal(big.code, "payload_too_large");
});

test("cid：sch_<id>_<拍号> 往返；非排期 cid 一律不认", () => {
  const entry = { id: "sch_0123456789abcdef" };
  assert.equal(scheduleCid(entry, 3), "sch_0123456789abcdef_3");
  assert.deepEqual(parseScheduleCid("sch_0123456789abcdef_3"), { scheduleId: "sch_0123456789abcdef", fireNo: 3 });
  assert.equal(parseScheduleCid("viewer-cid-1"), null);
  assert.equal(parseScheduleCid("sch_0123456789abcdef"), null);
  assert.equal(parseScheduleCid("sch_0123456789abcdef_0"), null);
  assert.equal(parseScheduleCid(null), null);
});

test("落盘与恢复：primeAll 读回全部 armed；终态过期条目加载时清掉", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const a = createOnce(w, "r1", T0 + 60000);
  const b = createEvery(w, "r1", 120000);
  // 落盘文件形状
  const acctDir = path.join(w.accountsDir, fs.readdirSync(w.accountsDir)[0]);
  const raw = JSON.parse(fs.readFileSync(path.join(acctDir, "schedules.json"), "utf8"));
  assert.equal(raw.entries.length, 2);
  // 新 store 恢复
  const store2 = new ScheduleStore(w.accountsDir, { now: w.now });
  store2.primeAll();
  const armed = store2.armedEntries().sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(armed.map((e) => e.id), [a.id, b.id].sort());
  assert.equal(store2.get(ACCT, b.id).nextAt, T0 + 120000);
  // 终态条目 stateAt 超 24h：写一条老退休项进文件，加载后消失
  raw.entries.push({ ...JSON.parse(JSON.stringify(raw.entries[0])), id: "sch_deadbeefdeadbeef", state: "retired", retireReason: "canceled", stateAt: T0 - 25 * 60 * 60 * 1000 });
  fs.writeFileSync(path.join(acctDir, "schedules.json"), JSON.stringify(raw));
  const store3 = new ScheduleStore(w.accountsDir, { now: w.now });
  store3.primeAll();
  assert.equal(store3.get(ACCT, "sch_deadbeefdeadbeef"), null);
});

test("once 到点投递：成功即退休；同拍不重投（done 重复回调/后续 tick 都无效）", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const e = createOnce(w, "r1", T0 + 5000);
  w.setNow(T0 + 4999); w.engine.tick();
  assert.equal(w.deliveries.length, 0);
  w.setNow(T0 + 5000); w.engine.tick();
  assert.equal(w.deliveries.length, 1);
  assert.equal(w.deliveries[0].fireNo, 1);
  assert.equal(w.deliveries[0].entry, e);
  // 在飞期间再 tick 不重投
  w.setNow(T0 + 6000); w.engine.tick();
  assert.equal(w.deliveries.length, 1);
  w.deliveries[0].done({ ok: true });
  const after = w.store.get(ACCT, e.id);
  assert.equal(after.state, "retired");
  assert.equal(after.retireReason, "max_fires");
  assert.equal(after.firedCount, 1);
  assert.equal(after.lastFiredAt, T0 + 6000, "lastFiredAt 记回执时刻（在飞复查 tick 之后的时钟）");
  // 迟到的第二次 done 与后续 tick 都不能让它复活/重投
  w.deliveries[0].done({ ok: true });
  w.setNow(T0 + 999999);
  w.engine.tick();
  assert.equal(w.deliveries.length, 1);
  assert.equal(w.store.get(ACCT, e.id).firedCount, 1);
});

test("every 节律：按计划推进 nextAt，落后多拍只补一拍不追赶", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const e = createEvery(w, "r1", 60000); // nextAt = T0+60s
  w.setNow(T0 + 60000); w.engine.tick();
  assert.equal(w.deliveries.length, 1);
  // 投递回执晚了 5 分钟（期间错过 5 拍）：nextAt = max(now, 上拍)+间隔，不是逐拍补齐
  w.setNow(T0 + 360000);
  w.deliveries[0].done({ ok: true });
  assert.equal(w.store.get(ACCT, e.id).nextAt, T0 + 420000);
  w.setNow(T0 + 360000); w.engine.tick();
  assert.equal(w.deliveries.length, 1, "不追赶：恢复后不立刻补拍");
  w.setNow(T0 + 420000); w.engine.tick();
  assert.equal(w.deliveries.length, 2);
  assert.equal(w.deliveries[1].fireNo, 2);
});

test("投递失败：once/every 都停机（failed）+ 写账本 error 条目 + 不再触发", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const e = createEvery(w, "r1", 60000);
  w.setNow(T0 + 60000); w.engine.tick();
  w.deliveries[0].done({ ok: false, error: "队列已满" });
  const after = w.store.get(ACCT, e.id);
  assert.equal(after.state, "failed");
  assert.equal(after.retireReason, "delivery_failed");
  assert.match(after.lastError, /队列已满/);
  const errs = w.inboxEntries().filter((x) => x.key === `sched:${e.id}`);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].kind, "error");
  assert.equal(errs[0].subkind, "schedule");
  assert.equal(errs[0].roomId, "r1");
  w.setNow(T0 + 3600000);
  w.engine.tick();
  assert.equal(w.deliveries.length, 1, "失败后不再触发");
});

test("离线 once：宽限内顺延补投；超宽限作废（missed）+ 账本提示", () => {
  const w = makeWorld();
  const room = w.addRoom("r1", false); // 离线
  const e = createOnce(w, "r1", T0 + 1000);
  w.setNow(T0 + 1000); w.engine.tick();
  assert.equal(w.deliveries.length, 0, "离线不投递");
  assert.equal(w.store.get(ACCT, e.id).state, "armed", "宽限内保持 armed");
  room.online = true; // 宽限内回来
  w.setNow(T0 + 2000); w.engine.tick();
  assert.equal(w.deliveries.length, 1, "回来即补投");
  w.deliveries[0].done({ ok: true });

  const e2 = createOnce(w, "r1", T0 + 3000);
  room.online = false;
  w.setNow(T0 + 3000 + 15 * 60 * 1000 + 1); // 超过 at+15min 宽限
  w.engine.tick();
  const after = w.store.get(ACCT, e2.id);
  assert.equal(after.state, "retired");
  assert.equal(after.retireReason, "missed");
  assert.equal(w.deliveries.length, 1, "作废不投递");
  assert.ok(w.inboxEntries().some((x) => x.key === `sched:${e2.id}` && x.kind === "error"), "作废写账本");
});

test("离线 every：错过的拍跳过不积压，恢复后从恢复时刻重新起算", () => {
  const w = makeWorld();
  const room = w.addRoom("r1", false);
  const e = createEvery(w, "r1", 60000);
  w.setNow(T0 + 60000 * 5); // 离线期间错过 5 拍
  w.engine.tick();
  assert.equal(w.deliveries.length, 0);
  room.online = true;
  w.engine.tick(); // 恢复拍：只重排 nextAt，不补投
  assert.equal(w.deliveries.length, 0, "恢复不补投错过的拍");
  assert.equal(w.store.get(ACCT, e.id).nextAt, T0 + 60000 * 5 + 60000);
  w.setNow(T0 + 60000 * 6); w.engine.tick();
  assert.equal(w.deliveries.length, 1);
  assert.equal(w.deliveries[0].fireNo, 1, "拍号从 1 起，错过的拍不占号");
});

test("送达确认判失败（remote_message_failed 按 cid 对号）：已计数拍与在飞拍都停机", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const e = createEvery(w, "r1", 60000);
  w.setNow(T0 + 60000); w.engine.tick();
  w.deliveries[0].done({ ok: true }); // 回执成功、已进队列
  assert.equal(w.store.get(ACCT, e.id).firedCount, 1);
  // 之后队列释放时注入失败
  assert.equal(w.engine.noteRemoteFailed(scheduleCid(e, 1), "会话已结束"), true);
  assert.equal(w.store.get(ACCT, e.id).state, "failed");
  assert.ok(w.inboxEntries().some((x) => x.key === `sched:${e.id}`));

  // 在飞拍：done 还没回，失败事件先到 → 停机；随后迟到的 ok 回执被忽略
  const e2 = createEvery(w, "r1", 60000);
  w.setNow(T0 + 120000);
  w.engine.tick();
  const d2 = w.deliveries.find((d) => d.entry === e2);
  assert.ok(d2);
  assert.equal(w.engine.noteRemoteFailed(scheduleCid(e2, 1), "注入失败"), true);
  assert.equal(w.store.get(ACCT, e2.id).state, "failed");
  d2.done({ ok: true });
  assert.equal(w.store.get(ACCT, e2.id).state, "failed", "迟到回执不复活");
  assert.equal(w.store.get(ACCT, e2.id).firedCount, 0);
  // 无关 cid 不误伤
  assert.equal(w.engine.noteRemoteFailed("plain-cid", "x"), false);
});

test("maxFires 与 expireAt：次数到顶退休；到期静默退休不进账本", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const e = createEvery(w, "r1", 60000, { maxFires: 2 });
  w.setNow(T0 + 60000); w.engine.tick();
  w.deliveries[0].done({ ok: true });
  assert.equal(w.store.get(ACCT, e.id).state, "armed");
  w.setNow(T0 + 120000);
  w.engine.tick();
  w.deliveries[1].done({ ok: true });
  const after = w.store.get(ACCT, e.id);
  assert.equal(after.state, "retired");
  assert.equal(after.retireReason, "max_fires");
  assert.equal(after.firedCount, 2);

  const e2 = createOnce(w, "r1", w.now() + 3600000, { expireAt: w.now() + 10000 });
  w.setNow(w.now() + 10001);
  w.engine.tick();
  assert.equal(w.store.get(ACCT, e2.id).retireReason, "expired");
  assert.equal(w.inboxEntries().some((x) => x.key === `sched:${e2.id}`), false, "预期内到期不进账本");
});

test("取消与会话结束：cancel 只停 armed；retireRoom 全房退休 + 账本提示", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const e = createOnce(w, "r1", T0 + 60000);
  const canceled = w.engine.cancel(ACCT, e.id);
  assert.equal(canceled.retireReason, "canceled");
  assert.equal(w.engine.cancel(ACCT, e.id), null, "终态再取消返回 null");
  w.setNow(T0 + 60000);
  w.engine.tick();
  assert.equal(w.deliveries.length, 0, "取消后不触发");

  const a = createOnce(w, "r1", T0 + 120000);
  const b = createEvery(w, "r1", 60000);
  assert.equal(w.engine.retireRoom("r1"), 2);
  for (const x of [a, b]) {
    assert.equal(w.store.get(ACCT, x.id).state, "retired");
    assert.equal(w.store.get(ACCT, x.id).retireReason, "session_ended");
    assert.ok(w.inboxEntries().some((en) => en.key === `sched:${x.id}`), "会话结束写账本提示");
  }
});

test("上限：每房 10 条 / 每账号 30 条 armed", () => {
  const w = makeWorld();
  w.addRoom("r1");
  w.addRoom("r2");
  for (let i = 0; i < 10; i++) createOnce(w, "r1", T0 + 60000 + i);
  const over = w.engine.create(ACCT, { roomId: "r1", text: "x", segment: "steer", kind: "once", at: T0 + 999999 });
  assert.equal(over.code, "queue_locked");
  w.addRoom("r3");
  for (let i = 0; i < 10; i++) createOnce(w, "r2", T0 + 60000 + i);
  for (let i = 0; i < 10; i++) createOnce(w, "r3", T0 + 60000 + i);
  const overAcct = w.engine.create(ACCT, { roomId: "r2", text: "x", segment: "steer", kind: "once", at: T0 + 999999 });
  assert.equal(overAcct.code, "queue_locked", "账号总量 30 到顶");
});

test("房间消失（不在内存表）：超启动宽限后按会话结束退休", () => {
  const w = makeWorld(); // startGraceMs: 0，不 addRoom
  const e = createOnce(w, "ghost", T0 + 60000);
  w.setNow(T0 + 1000); w.engine.tick();
  assert.equal(w.store.get(ACCT, e.id).state, "retired");
  assert.equal(w.store.get(ACCT, e.id).retireReason, "session_ended");
  assert.ok(w.inboxEntries().some((x) => x.key === `sched:${e.id}`));
});

test("引擎重启恢复：新引擎读回排期表，到点照常触发", () => {
  const w = makeWorld();
  w.addRoom("r1");
  const e = createOnce(w, "r1", T0 + 30000);
  // 模拟 relay 重启：新 store/engine 绑同一目录与房间表
  const store2 = new ScheduleStore(w.accountsDir, { now: w.now });
  store2.primeAll();
  const deliveries2 = [];
  const engine2 = new ScheduleEngine({ store: store2, inbox: w.inbox, now: w.now, startGraceMs: 0 });
  engine2.bindHost({
    peekRoom: (id) => w.rooms.get(id) || null,
    deliver: (room, entry, fireNo, done) => deliveries2.push({ entry, fireNo, done }),
    flushInbox: () => {}, onDirty: () => {},
  });
  engine2.tick(T0 + 29999);
  assert.equal(deliveries2.length, 0);
  engine2.tick(T0 + 30000);
  assert.equal(deliveries2.length, 1);
  assert.equal(deliveries2[0].entry.id, e.id);
  deliveries2[0].done({ ok: true });
  assert.equal(store2.get(ACCT, e.id).state, "retired");
});
