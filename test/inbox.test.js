// 收件箱账本 InboxStore 单元（设计 D §1）：状态机迁移、墓碑防复活与原因回填、
// 淘汰纪律（waiting 永不淘汰）、整房 turn 替换、恢复标记与 stale 清扫、落盘往返。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { InboxStore, INBOX_PENDING_MAX } = require("../relay/inbox.js");
const { safeKey } = require("../relay/index.js");

const ACCT = "admin";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-inbox-"));
}

function store(dir) {
  return new InboxStore(dir || tmpDir());
}

/** 账本文件路径：账号目录名是 safeKey(accountId)（带 hash 后缀），扫描定位唯一子目录。 */
function inboxFile(dir) {
  const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  assert.equal(subs.length, 1);
  return path.join(dir, subs[0].name, "inbox.json");
}

const dialogEntry = (over = {}) => ({
  key: "dialog:d1",
  accountId: ACCT,
  roomId: "room-1",
  deviceId: "dev-1",
  kind: "waiting",
  subkind: "dialog",
  dialogKind: "confirm",
  title: "允许执行？",
  answerable: true,
  at: 1000,
  ...over,
});

const turnEntry = (over = {}) => ({
  key: "turn:room-1:2000",
  accountId: ACCT,
  roomId: "room-1",
  deviceId: "dev-1",
  kind: "done",
  subkind: "turn",
  at: 2000,
  ...over,
});

test("upsert → snapshot：只出元数据白名单，正文字段（options/message）进不来", () => {
  const s = store();
  const r = s.upsert({ ...dialogEntry(), options: ["是", "否"], message: "正文不许进账本", prefill: "x" });
  assert.equal(r.created, true);
  const snap = s.snapshot();
  assert.equal(snap.length, 1);
  assert.deepEqual(Object.keys(snap[0]).sort(), ["accountId", "answerable", "at", "deviceId", "dialogKind", "key", "kind", "roomId", "subkind", "title"].sort());
  assert.equal(snap[0].title, "允许执行？");
});

test("同字段重复 upsert 幂等：返回 null、不产生第二次变更（对账高频调用不许刷盘刷帧）", () => {
  const s = store();
  s.upsert(dialogEntry());
  assert.equal(s.drainChanges().upserts.length, 1);
  assert.equal(s.upsert(dialogEntry()), null);
  assert.equal(s.drainChanges(), null);
  // 字段变了（answerable 翻转）才算更新
  const r = s.upsert(dialogEntry({ answerable: false }));
  assert.equal(r.created, false);
  assert.equal(s.drainChanges().upserts[0].answerable, false);
});

test("标题截断 120 码点、坏形状整条拒绝", () => {
  const s = store();
  const r = s.upsert(dialogEntry({ title: "题".repeat(200) }));
  assert.equal(Array.from(r.entry.title).length, 120);
  assert.equal(s.upsert({ key: "", accountId: ACCT, roomId: "r", kind: "waiting", subkind: "dialog", at: 1 }), null);
  assert.equal(s.upsert(dialogEntry({ kind: "bogus" })), null);
  assert.equal(s.upsert(dialogEntry({ at: NaN })), null);
});

test("remove 写墓碑；墓碑原因可回填（dialog_close 的 reason 晚到一步）", () => {
  const dir = tmpDir();
  const s = store(dir);
  s.upsert(dialogEntry());
  assert.equal(s.remove(ACCT, "dialog:d1", "resolved", 5000), true);
  assert.equal(s.snapshot().length, 0);
  assert.equal(s.remove(ACCT, "dialog:d1", "resolved", 5001), false, "重复消项幂等");
  assert.equal(s.amendTombReason(ACCT, "dialog:d1", "answered"), true);
  // 落盘文件里墓碑原因已回填
  const file = inboxFile(dir);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.tombs["dialog:d1"].goneReason, "answered");
  assert.equal(raw.tombs["dialog:d1"].goneAt, 5000, "回填只改原因不动时刻");
  // 条目复活后墓碑消失，amend 不再命中
  s.upsert(dialogEntry());
  assert.equal(s.amendTombReason(ACCT, "dialog:d1", "timeout"), false);
});

test("墓碑防复活只针对恢复：落盘往返后已消条目不回来，活槽重报则以槽为准重建", () => {
  const dir = tmpDir();
  const s1 = store(dir);
  s1.upsert(dialogEntry());
  s1.upsert(turnEntry());
  s1.remove(ACCT, "dialog:d1", "answered", 5000);
  // 重启：新 store 读同一目录
  const s2 = store(dir);
  s2.prime(ACCT);
  const snap = s2.snapshot();
  assert.deepEqual(snap.map((e) => e.key), ["turn:room-1:2000"], "已消的 dialog 不复活、未读 turn 还在");
  // 活槽重报同一 dialogId：以槽为准重建（墓碑只防幽灵恢复，不挡真实重现）
  const r = s2.upsert(dialogEntry({ at: 6000 }));
  assert.equal(r.created, true);
  assert.equal(s2.snapshot().length, 2);
});

test("重启恢复标记：waiting 恢复为未确认（_restored），turn 原样；sweepRestored 只清未确认 waiting", () => {
  const dir = tmpDir();
  const s1 = store(dir);
  s1.upsert(dialogEntry());
  s1.upsert(turnEntry());
  const s2 = store(dir);
  s2.prime(ACCT);
  assert.deepEqual([...s2.restoredWaitingKeys(ACCT, "room-1")], ["dialog:d1"]);
  // 补发确认（同 key upsert）后不再是未确认
  s2.upsert(dialogEntry());
  assert.equal(s2.restoredWaitingKeys(ACCT, "room-1").size, 0);
  // 再恢复一轮 + 不确认 → sweep 判 stale
  const s3 = store(dir);
  s3.prime(ACCT);
  assert.equal(s3.sweepRestored("room-1"), 1);
  const snap = s3.snapshot();
  assert.deepEqual(snap.map((e) => e.key), ["turn:room-1:2000"], "turn 不受清扫影响");
  const raw = JSON.parse(fs.readFileSync(inboxFile(dir), "utf8"));
  assert.equal(raw.tombs["dialog:d1"].goneReason, "stale");
});

test("dismiss 只许 done/error：waiting 拒清（防假清零），清后墓碑 reason=dismissed", () => {
  const s = store();
  s.upsert(dialogEntry());
  s.upsert(turnEntry());
  assert.equal(s.dismiss("dialog:d1"), null);
  assert.equal(s.snapshot().length, 2, "waiting 还在");
  const gone = s.dismiss("turn:room-1:2000");
  assert.equal(gone.kind, "done");
  assert.deepEqual(s.snapshot().map((e) => e.key), ["dialog:d1"]);
  assert.equal(s.dismiss("turn:room-1:2000"), null, "已清的再清是空操作");
});

test("淘汰纪律：超上限先淘最老 done、再淘最老 error，waiting 永不淘汰", () => {
  const s = store();
  for (let i = 0; i < INBOX_PENDING_MAX; i++) {
    s.upsert(turnEntry({ key: `turn:room-1:${2000 + i}`, at: 2000 + i, roomId: "room-1" }));
  }
  // 注意 replaceRoomTurn 才会整房替换；直接 upsert 是逐条进账（不同 key 共存于此测试构造）
  s.upsert(dialogEntry({ key: "dialog:w1", at: 9000 }));
  let snap = s.snapshot();
  assert.equal(snap.length, INBOX_PENDING_MAX, "溢出一件：最老的 done 被淘");
  assert.equal(snap.some((e) => e.key === "turn:room-1:2000"), false);
  assert.equal(snap.some((e) => e.key === "dialog:w1"), true);
  // 全是 waiting 时允许超限——waiting 一条都不许淘
  const s2 = store();
  for (let i = 0; i < INBOX_PENDING_MAX + 5; i++) {
    s2.upsert(dialogEntry({ key: `dialog:x${i}`, at: 1000 + i }));
  }
  assert.equal(s2.snapshot().length, INBOX_PENDING_MAX + 5);
});

test("replaceRoomTurn 整房替换：同房只留最新一份落定，旧份墓碑 reason=resolved", () => {
  const dir = tmpDir();
  const s = store(dir);
  s.replaceRoomTurn(turnEntry());
  s.replaceRoomTurn(turnEntry({ key: "turn:room-1:3000", at: 3000, kind: "error" }));
  const snap = s.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].kind, "error");
  const raw = JSON.parse(fs.readFileSync(inboxFile(dir), "utf8"));
  assert.equal(raw.tombs["turn:room-1:2000"].goneReason, "resolved");
  // 别房的 turn 不受影响
  s.replaceRoomTurn(turnEntry({ key: "turn:room-2:2500", roomId: "room-2", at: 2500 }));
  assert.equal(s.snapshot().length, 2);
});

test("clearRoomTurns 只清 turn 条目（进房即已读），waiting 不动", () => {
  const s = store();
  s.upsert(dialogEntry());
  s.upsert(turnEntry());
  assert.equal(s.clearRoomTurns(ACCT, "room-1"), 1);
  assert.deepEqual(s.snapshot().map((e) => e.key), ["dialog:d1"]);
  assert.equal(s.clearRoomTurns(ACCT, "room-1"), 0);
});

test("坏账本文件不炸：当空账本起，写新条目后自愈", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, safeKey(ACCT)), { recursive: true });
  fs.writeFileSync(path.join(dir, safeKey(ACCT), "inbox.json"), "{不是 json");
  const s = store(dir);
  s.prime(ACCT);
  assert.deepEqual(s.snapshot(), []);
  s.upsert(turnEntry());
  assert.equal(s.snapshot().length, 1);
});

test("过期墓碑（>24h）在加载时清掉，新墓碑保留", () => {
  const dir = tmpDir();
  const now = Date.now();
  fs.mkdirSync(path.join(dir, safeKey(ACCT)), { recursive: true });
  fs.writeFileSync(path.join(dir, safeKey(ACCT), "inbox.json"), JSON.stringify({
    v: 1,
    entries: [],
    tombs: {
      "dialog:old": { goneAt: now - 25 * 3600 * 1000, goneReason: "answered" },
      "dialog:new": { goneAt: now - 1000, goneReason: "timeout" },
    },
  }));
  const s = store(dir);
  s.prime(ACCT);
  // 触发一次落盘后看文件：老墓碑没了、新墓碑还在
  s.upsert(turnEntry());
  const raw = JSON.parse(fs.readFileSync(inboxFile(dir), "utf8"));
  assert.equal("dialog:old" in raw.tombs, false);
  assert.equal(raw.tombs["dialog:new"].goneReason, "timeout");
});

test("迁移事件（§1.6 推送接口面）：created/removed 带 key 与 reason", () => {
  const s = store();
  const events = [];
  s.onTransition((e) => events.push(e));
  s.upsert(dialogEntry());
  s.upsert(dialogEntry({ title: "改了标题" }));
  s.remove(ACCT, "dialog:d1", "answered");
  assert.deepEqual(events.map((e) => e.type), ["created", "updated", "removed"]);
  assert.equal(events[2].key, "dialog:d1");
  assert.equal(events[2].reason, "answered");
});

test("§3/§B 预留面：schedule error 与 ask 条目可进出账本", () => {
  const s = store();
  s.upsertScheduleError({ key: "sched:sch-1", accountId: ACCT, roomId: "room-1", title: "定时消息发送失败", at: 7000 });
  s.upsertAsk({ key: "ask:a1", accountId: ACCT, roomId: "room-1", title: "选哪个方案？", at: 8000 });
  const snap = s.snapshot();
  assert.deepEqual(snap.map((e) => [e.subkind, e.kind]), [["schedule", "error"], ["ask", "waiting"]]);
  // ask 是 waiting：不许 dismiss；答完经 removeAsk 消项
  assert.equal(s.dismiss("ask:a1"), null);
  assert.equal(s.removeAsk(ACCT, "a1", true), true);
  assert.equal(s.snapshot().length, 1);
  // schedule error 是 error：可 dismiss
  assert.ok(s.dismiss("sched:sch-1"));
  assert.equal(s.snapshot().length, 0);
});

test("drainChanges：upsert 与 remove 在同一窗口内对冲，只出净结果", () => {
  const s = store();
  s.upsert(dialogEntry());
  s.remove(ACCT, "dialog:d1", "resolved");
  const changes = s.drainChanges();
  assert.deepEqual(changes.upserts, []);
  assert.deepEqual(changes.removed, ["dialog:d1"]);
  assert.equal(s.drainChanges(), null);
});
