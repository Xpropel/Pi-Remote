"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RoomStore, hashOf, cleanCid } = require("../relay/store.js");
const { Rooms } = require("../relay/rooms.js");

const LIMITS = { limit: 10000, maxBytes: 64 * 1024 * 1024 };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-store-"));
}
/** 这些用例断言磁盘上的正文；默认关闭落盘，这里显式打开。 */
function openStore(dir = tmpDir()) {
  return new RoomStore(dir, { persist: true });
}
const user = (text, ts = 1) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const asst = (text, ts = 2) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts, stopReason: "stop" });
const end = (message) => ({ type: "message_end", message });
const toolEnd = (toolCallId, extra = {}) => ({
  type: "tool_execution_end",
  toolCallId,
  toolName: "bash",
  isError: true,
  exit_code: 2,
  wall_time_seconds: 1.5,
  termStatus: "timeout",
  ...extra,
});
const texts = (snap) => snap.items.map((s) => {
  const m = JSON.parse(s);
  return `${m.role}${m.remote ? "(remote)" : ""}:${m.content[0].text}`;
});

test("record 为落盘记录分配递增 seq，非落盘事件返回 0", () => {
  const s = openStore();
  assert.equal(s.record("r1", end(user("hi", 1))), 1);
  assert.equal(s.record("r1", end(asst("yo", 2))), 2);
  assert.equal(s.record("r1", { type: "message_update" }), 0);
  assert.equal(s.record("r1", end({ role: "system", content: "sys" })), 0);
  assert.equal(s.record("r1", { type: "remote_message", text: "x" }), 3);
});

test("快照：全量带 rev/seq；since 命中同一 rev 时只交付其后的记录", () => {
  const s = openStore();
  s.record("r1", end(user("a", 1)));
  s.record("r1", end(asst("b", 2)));
  s.record("r1", end(user("c", 3)));
  const full = s.snapshot("r1", LIMITS);
  assert.equal(full.delta, false);
  assert.equal(full.seq, 3);
  assert.deepEqual(texts(full), ["user:a", "assistant:b", "user:c"]);

  const delta = s.snapshot("r1", { ...LIMITS, since: { rev: full.rev, seq: 1 } });
  assert.equal(delta.delta, true);
  assert.equal(delta.baseSeq, 1);
  assert.deepEqual(texts(delta), ["assistant:b", "user:c"]);

  const empty = s.snapshot("r1", { ...LIMITS, since: { rev: full.rev, seq: 3 } });
  assert.equal(empty.delta, true);
  assert.equal(empty.items.length, 0);

  const stale = s.snapshot("r1", { ...LIMITS, since: { rev: "other", seq: 1 } });
  assert.equal(stale.delta, false, "rev 不同必须退回全量");
  const ahead = s.snapshot("r1", { ...LIMITS, since: { rev: full.rev, seq: 99 } });
  assert.equal(ahead.delta, false, "seq 超过存储上限必须退回全量");
});

test("rev 与 seq 持久化：重开存储后增量重连仍能命中", () => {
  const dir = tmpDir();
  const a = openStore(dir);
  a.record("r1", end(user("a", 1)));
  a.record("r1", end(asst("b", 2)));
  a.flushAll();
  const before = a.info("r1");

  const b = openStore(dir);
  const after = b.info("r1");
  assert.equal(after.rev, before.rev);
  assert.equal(after.seq, 2);
  assert.equal(after.msgCount, 2);
  assert.equal(after.lastHash, hashOf(asst("b", 2)));
  const delta = b.snapshot("r1", { ...LIMITS, since: { rev: before.rev, seq: 1 } });
  assert.equal(delta.delta, true);
  assert.deepEqual(texts(delta), ["assistant:b"]);
});

test("message_end 的图片 entryId/blockIndex 原样落库、快照与重启后仍可定位", () => {
  const dir = tmpDir();
  const message = {
    role: "user",
    content: [
      { type: "text", text: "看图" },
      { type: "image", mimeType: "image/png", data: "", omitted: true, omittedBytes: 3, entryId: "e1", blockIndex: 1 },
    ],
    timestamp: 1,
  };
  const s = openStore(dir);
  s.record("r1", end(message));
  s.flushAll();
  const one = JSON.parse(s.snapshot("r1", LIMITS).items[0]);
  assert.deepEqual([one.content[1].entryId, one.content[1].blockIndex], ["e1", 1], "快照保留地址");
  const again = JSON.parse(openStore(dir).snapshot("r1", LIMITS).items[0]);
  assert.deepEqual([again.content[1].entryId, again.content[1].blockIndex], ["e1", 1], "重开存储后回放仍保留地址");
  assert.equal(again.content[1].data, "", "不把原图数据带回历史");
});

test("reset 换新 rev、seq 归零，磁盘旧记录不会在重开后复活", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.record("r1", end(user("old", 1)));
  s.flushAll();
  const rev = s.info("r1").rev;
  s.reset("r1");
  const info = s.info("r1");
  assert.notEqual(info.rev, rev);
  assert.equal(info.seq, 0);
  assert.equal(info.msgCount, 0);
  s.record("r1", end(user("new", 2)));
  s.flushAll();
  assert.deepEqual(texts(openStore(dir).snapshot("r1", LIMITS)), ["user:new"]);
});

test("remote 回显被同文本 user 消息取代；注入失败的回显从回放中摘除（重开后仍生效）", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.record("r1", { type: "remote_message", text: "hello" });
  s.record("r1", end(user("hello", 5)));
  s.record("r1", { type: "remote_message", text: "lost" });
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:hello", "user(remote):lost"]);
  assert.equal(s.markRemoteFailed("r1", "lost"), true);
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:hello"]);
  s.flushAll();
  assert.deepEqual(texts(openStore(dir).snapshot("r1", LIMITS)), ["user:hello"]);
});

test("seedOrMerge：空库 seed；延续只追加；头锚点不符 reset 后重新 seed", () => {
  const s = openStore();
  const u1 = user("u1", 1), a1 = asst("a1", 2), u2 = user("u2", 3);
  assert.equal(s.seedOrMerge("r1", [u1, a1]).seeded, 2);
  const merged = s.seedOrMerge("r1", [u1, a1, u2]);
  assert.equal(merged.merged, 1);
  assert.equal(merged.baseSeq, 2);
  assert.equal(merged.items.length, 1);
  const rev = s.info("r1").rev;
  const other = s.seedOrMerge("r1", [user("x", 9), asst("y", 10)]);
  assert.equal(other.reset, true);
  assert.notEqual(s.info("r1").rev, rev);
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:x", "assistant:y"]);
});

test("appendMessages：锚点对上才追加；期间多落的实时消息按 hash 跳过", () => {
  const s = openStore();
  const u1 = user("u1", 1), a1 = asst("a1", 2), u2 = user("u2", 3), a2 = asst("a2", 4), u3 = user("u3", 5);
  s.seedOrMerge("r1", [u1, a1]);
  assert.equal(s.appendMessages("r1", { count: 2, hash: "nope" }, [u2]).ok, false);
  assert.equal(s.appendMessages("r1", { count: 3, hash: hashOf(a1) }, [u2]).ok, false, "count 超过存储条数");
  const ok = s.appendMessages("r1", { count: 2, hash: hashOf(a1) }, [u2]);
  assert.equal(ok.ok, true);
  assert.equal(ok.merged, 1);
  // 扩展问询（count=3）之后又实时落了 a2：上传的 [a2, u3] 里 a2 已存在，只追加 u3
  s.record("r1", end(a2));
  const overlap = s.appendMessages("r1", { count: 3, hash: hashOf(u2) }, [a2, u3]);
  assert.equal(overlap.ok, true);
  assert.equal(overlap.merged, 1);
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:u1", "assistant:a1", "user:u2", "assistant:a2", "user:u3"]);
});

test("截断快照按消息尾窗对齐：同内容 custom 重复时不跳过中间消息", () => {
  const s = openStore();
  const bash = (ts) => ({ role: "custom", customType: "remote-bash", content: "Ran `ls`", timestamp: ts });
  const head = user("u", 1);
  const first = bash(2);
  const mid = asst("between", 3);
  const second = bash(4);
  const after = user("after", 5);
  assert.equal(hashOf(first), hashOf(second), "同内容 custom 的 hash 不含时间戳");
  s.seedOrMerge("r1", [head, first]);
  const r = s.seedOrMerge("r1", [head, first, mid, second, after], { truncated: true });
  assert.equal(r.reset, false);
  assert.equal(r.merged, 3);
  assert.deepEqual(
    s.snapshot("r1", LIMITS).items.map((x) => JSON.parse(x).role),
    ["user", "custom", "assistant", "custom", "user"],
  );
});

test("remote 回显带 cid：快照带 cid；失败按 cid 摘那一条，同文本的另一条不受影响（重开后仍生效）", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.record("r1", { type: "remote_message", text: "继续", at: 1, cid: "c-1" });
  s.record("r1", { type: "remote_message", text: "继续", at: 2, cid: "c-2" });
  const cids = (snap) => snap.items.map((x) => JSON.parse(x)).filter((m) => m.remote).map((m) => m.cid);
  assert.deepEqual(cids(s.snapshot("r1", LIMITS)), ["c-1", "c-2"]);
  assert.equal(s.markRemoteFailed("r1", "继续", "c-1"), true, "按 cid 摘的是先发的那条，不是最近一条");
  assert.deepEqual(cids(s.snapshot("r1", LIMITS)), ["c-2"]);
  assert.equal(s.markRemoteFailed("r1", "继续", "c-9"), false, "cid 对不上就什么都不摘");
  assert.deepEqual(cids(s.snapshot("r1", LIMITS)), ["c-2"]);
  s.flushAll();
  assert.deepEqual(cids(openStore(dir).snapshot("r1", LIMITS)), ["c-2"], "cid 和 drop 行都落了盘");
});

test("同文本多条回显：user 消息先进先出取代最早一条，没有 drop 行时重开索引也一样；无 cid 的失败摘最近一条", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.record("r1", { type: "remote_message", text: "好", at: 1, cid: "a" });
  s.record("r1", { type: "remote_message", text: "好", at: 2, cid: "b" });
  s.record("r1", end(user("好", 3)));
  const remotes = (snap) => snap.items.map((x) => JSON.parse(x)).filter((m) => m.remote).map((m) => m.cid);
  assert.deepEqual(remotes(s.snapshot("r1", LIMITS)), ["b"], "先发的 a 已进 pi，还在排队的 b 留着");
  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  const noDrops = fs.readFileSync(file, "utf8").split("\n").filter((line) => line && !line.includes('"k":"drop"'));
  fs.writeFileSync(file, noDrops.join("\n") + "\n");
  assert.deepEqual(remotes(openStore(dir).snapshot("r1", LIMITS)), ["b"]);

  const s2 = openStore();
  s2.record("r2", { type: "remote_message", text: "x", at: 1 });
  s2.record("r2", { type: "remote_message", text: "x", at: 2 });
  assert.equal(s2.markRemoteFailed("r2", "x"), true);
  assert.deepEqual(s2.snapshot("r2", LIMITS).items.map((j) => JSON.parse(j).timestamp), [1], "旧扩展的失败（没有 cid）摘最近一条");
});

test("cleanCid 与协议的 cidMax 一致：字符集 [A-Za-z0-9_-]，最长 cidMax", () => {
  const { cidMax } = require("../relay/protocol.json").limits;
  assert.equal(cleanCid("a".repeat(cidMax)), "a".repeat(cidMax));
  assert.equal(cleanCid("a".repeat(cidMax + 1)), null);
  assert.equal(cleanCid("abc_DEF-123"), "abc_DEF-123");
  for (const bad of ["", "a b", "a/b", "中文", 12, null, undefined]) assert.equal(cleanCid(bad), null, String(bad));
});

test("remote 回显隔开超过旧的 200 条窗口后仍被同文本 user 消息取代，重开后也过滤", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.record("r1", { type: "remote_message", text: "late", at: 1 });
  for (let i = 0; i < 250; i++) s.record("r1", end(asst("x" + i, 1000 + i)));
  s.record("r1", end(user("late", 9000)));
  const remoteCount = (snap) => snap.items.map((x) => JSON.parse(x)).filter((m) => m.remote).length;
  assert.equal(remoteCount(s.snapshot("r1", LIMITS)), 0);
  s.flushAll();
  assert.equal(remoteCount(openStore(dir).snapshot("r1", LIMITS)), 0);
});

test("带图片提示的 user 消息取代 remote 回显；更长的普通文本不会", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  const hinted = "ok\n\n[Image: original 10x10, displayed at 5x5.]";
  s.record("r1", { type: "remote_message", text: "ok", at: 1 });
  s.record("r1", end(user("ok, 我来处理", 2)));
  assert.equal(texts(s.snapshot("r1", LIMITS)).some((t) => t.includes("(remote)")), true, "普通更长文本不能取代");
  s.record("r1", end(user(hinted, 3)));
  assert.equal(texts(s.snapshot("r1", LIMITS)).some((t) => t.includes("(remote)")), false);
  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  const kept = fs.readFileSync(file, "utf8").split("\n").filter((line) => line && !line.includes('"k":"drop"'));
  fs.writeFileSync(file, kept.join("\n") + "\n");
  assert.equal(texts(openStore(dir).snapshot("r1", LIMITS)).some((t) => t.includes("(remote)")), false, "没有 drop 行时，重开索引也要认出图片提示");
});

test("appendMessages 按整段尾窗核对重叠，不能只看最后一条 hash", () => {
  const s = openStore();
  const u1 = user("u1", 1);
  const c1 = { role: "custom", customType: "remote-bash", content: [{ type: "text", text: "Ran `ls`" }], timestamp: 2 };
  const u2 = user("u2", 3);
  const cWrong = { role: "custom", customType: "remote-bash", content: [{ type: "text", text: "Ran `pwd`" }], timestamp: 4 };
  const u3 = user("u3", 5);
  s.seedOrMerge("r1", [u1, c1, u2]);
  const bad = s.appendMessages("r1", { count: 1, hash: hashOf(u1) }, [cWrong, u2, u3]);
  assert.equal(bad.ok, false);
  const good = s.appendMessages("r1", { count: 1, hash: hashOf(u1) }, [c1, u2, u3]);
  assert.equal(good.ok, true);
  assert.equal(good.merged, 1);
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:u1", "custom:Ran `ls`", "user:u2", "user:u3"]);
});

test("tailHashes 是最近消息的 hash，remote 不占位", () => {
  const s = openStore();
  const u1 = user("u1", 1);
  const a1 = asst("a1", 2);
  s.record("r1", end(u1));
  s.record("r1", { type: "remote_message", text: "x", at: 3 });
  s.record("r1", end(a1));
  assert.deepEqual(s.tailHashes("r1"), [hashOf(u1), hashOf(a1)]);
  assert.deepEqual(s.tailHashes("missing"), []);
});

test("默认不把对话正文写入磁盘，同一进程内仍可从内存读出", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir);
  assert.equal(s.record("r1", end(user("hi", 1))), 1);
  assert.equal(fs.existsSync(path.join(dir, "r1.jsonl")), false);
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:hi"]);
  assert.equal(new RoomStore(dir).snapshot("r1", LIMITS), null);
});

test("hashOf：custom/摘要类消息不受 timestamp 影响，user/assistant 受影响", () => {
  const c = (ts) => ({ role: "custom", customType: "x", content: "abc", timestamp: ts });
  assert.equal(hashOf(c(1)), hashOf(c(2)));
  const cs = (ts) => ({ role: "compactionSummary", summary: "S", timestamp: ts });
  assert.equal(hashOf(cs(1)), hashOf(cs(2)));
  assert.notEqual(hashOf(cs(1)), hashOf({ role: "compactionSummary", summary: "T", timestamp: 1 }));
  assert.notEqual(hashOf(user("a", 1)), hashOf(user("a", 2)));
  const long = "x".repeat(5000);
  assert.equal(hashOf(user(long, 1)), hashOf(user(long + "tail", 1)), "只取前 2048 字符");
});

// ---------- 默认 persist=false（生产默认不落对话正文）----------

test("persist=false：记录/快照/seedOrMerge 只走内存，flush 后数据目录里没有任何正文文件", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, { persist: false });
  assert.equal(s.record("r1", end(user("a", 1))), 1);
  assert.equal(s.record("r1", end(asst("b", 2))), 2);
  s.record("r1", { type: "remote_message", text: "远程" });
  s.seedOrMerge("r2", [user("x", 1), asst("y", 2)]);
  s.flushAll();
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:a", "assistant:b", "user(remote):远程"]);
  assert.deepEqual(texts(s.snapshot("r2", LIMITS)), ["user:x", "assistant:y"]);
  assert.equal(s.exists("r1"), true, "内存里有就算存在");
  assert.deepEqual(fs.readdirSync(dir), [], "不落盘：数据目录里不能出现任何文件");
});

test("persist=false：旧版留下的正文文件不被装配，房间移出内存后不再算存在；reset 把旧文件截断", () => {
  const dir = tmpDir();
  const old = openStore(dir);
  old.record("r1", end(user("旧正文", 1)));
  old.flushAll();
  const file = path.join(dir, "r1.jsonl");
  assert.ok(fs.statSync(file).size > 0);

  const s = new RoomStore(dir, { persist: false });
  assert.equal(s.exists("r1"), false, "只有磁盘文件、内存没有：不落盘模式下不算存在（防幻影房）");
  assert.equal(s.snapshot("r1", LIMITS), null, "不能把旧磁盘正文装配回来");
  s.record("r1", end(user("新", 2)));
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:新"]);
  s.reset("r1");
  assert.equal(fs.statSync(file).size, 0, "reset 要截断旧文件，防止以后打开落盘时旧分支复活");
  s.drop("r1");
  assert.equal(s.exists("r1"), false, "移出内存后不再存在");
});

test("flushAll 在追加落盘后 fsync 数据与目录项：确认过的尾部记录在关闭点进入稳定存储", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, { persist: true, prewarm: false });
  s.record("r1", end(user("durable", 1)));
  s.record("r1", { type: "remote_message", text: "回显", at: 2 });
  const orig = fs.fsyncSync;
  const seen = [];
  fs.fsyncSync = function (fd) {
    // fsync 必须发生在 append 之后：此时文件里应已能看到这两条记录
    const text = fs.readFileSync(path.join(dir, "r1.jsonl"), "utf8");
    seen.push({ dir: fs.fstatSync(fd).isDirectory(), appended: text.includes('"durable"') && text.includes("回显") });
    return orig.call(fs, fd);
  };
  try {
    s.flushAll();
  } finally {
    fs.fsyncSync = orig;
  }
  assert.deepEqual(seen[0], { dir: false, appended: true }, "flushAll 必须先对已追加内容调用 fsync");
  assert.ok(seen.every((c) => c.appended), "每次 fsync 时记录都必须已在文件里");
  if (process.platform !== "win32") {
    assert.ok(seen.some((c) => c.dir), "新建房文件首次落盘后必须 fsync 数据目录（目录项）");
  }
  assert.deepEqual(texts(openStore(dir).snapshot("r1", LIMITS)), ["user:durable", "user(remote):回显"]);
});

test("fsync 失败只告警：已追加的记录不重复写，缓冲也不会无限重试", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.record("r1", end(user("once", 1)));
  // 先落一个检查点：fsync 失败时不仅要保住消息不重写，也不能推进/重写检查点指针
  assert.equal(s._writeCheckpoint(s.rooms.get("r1")), true);
  const orig = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw new Error("EIO");
  };
  try {
    s.record("r1", end(user("after-ckpt", 2)));
    assert.doesNotThrow(() => s.flushAll(), "fsync 失败不能打断关闭流程");
    assert.doesNotThrow(() => s.flushAll(), "缓冲已清空，重试 flush 不会重复追加");
  } finally {
    fs.fsyncSync = orig;
  }
  const records = fs.readFileSync(path.join(dir, "r1.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((rec) => rec.k !== "ckpt"); // 检查点行不是消息，不能算进"没有重复写"的行数
  assert.deepEqual(records.map((rec) => rec.k), ["meta", "msg", "msg"], "meta + 两条 msg，不能重复");
  assert.deepEqual(records.filter((rec) => rec.k === "msg").map((rec) => rec.seq), [1, 2]);
});

test("toolmeta 写入立即 flush+fsync：掉电不丢最后一条结束元数据，fsync 失败也不重复写", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, { persist: true, prewarm: false });
  s.record("r1", end(user("u1", 1)));
  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  const toolRows = () =>
    fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((rec) => rec.k === "toolmeta");

  const orig = fs.fsyncSync;
  const seen = [];
  fs.fsyncSync = function (fd) {
    const text = fs.readFileSync(file, "utf8");
    seen.push({
      dir: fs.fstatSync(fd).isDirectory(),
      toolmeta: text.includes('"k":"toolmeta"') && text.includes('"call_9"'),
    });
    return orig.call(fs, fd);
  };
  try {
    assert.equal(s.record("r1", toolEnd("call_9", { isError: false, exit_code: 0 })), 0);
  } finally {
    fs.fsyncSync = orig;
  }
  const fileCalls = seen.filter((c) => !c.dir);
  assert.equal(fileCalls.length, 1, "toolmeta 不能等 200ms 定时器，必须立即 flush 一次");
  assert.equal(fileCalls[0].toolmeta, true, "fsync 时 toolmeta 行必须已经在文件里");
  assert.equal(toolRows().length, 1);

  // fsync 失败：不抛、不重复写；记录已交给页缓存，重启仍能读回
  fs.fsyncSync = () => {
    throw new Error("EIO");
  };
  try {
    assert.doesNotThrow(() => s.record("r1", toolEnd("call_10")), "fsync 失败不能打断工具结束事件");
  } finally {
    fs.fsyncSync = orig;
  }
  s.flushAll();
  assert.deepEqual(toolRows().map((rec) => rec.toolCallId), ["call_9", "call_10"], "失败的 fsync 不能重写/重复 toolmeta");
  assert.deepEqual(openStore(dir).toolEnds("r1").map((m) => m.toolCallId), ["call_9", "call_10"]);
});

test("检查点指针：临时文件 fsync → rename → 目录 fsync，指针在 rename 前不可见", () => {
  const dir = tmpDir();
  const s = ckptStore(dir);
  s.record("r1", end(user("u1", 1)));
  s.flushAll();
  const ptrFile = path.join(dir, "r1.ckpt.json");
  const origFsync = fs.fsyncSync;
  const origRename = fs.renameSync;
  const events = [];
  fs.fsyncSync = function (fd) {
    events.push({ op: "fsync", dir: fs.fstatSync(fd).isDirectory(), ptr: fs.existsSync(ptrFile) });
    return origFsync.call(fs, fd);
  };
  fs.renameSync = function (from, to) {
    events.push({ op: "rename", ptrBefore: fs.existsSync(to) });
    return origRename.call(fs, from, to);
  };
  try {
    assert.equal(s._writeCheckpoint(s.rooms.get("r1")), true);
  } finally {
    fs.fsyncSync = origFsync;
    fs.renameSync = origRename;
  }
  const renameAt = events.findIndex((e) => e.op === "rename");
  assert.ok(renameAt > 0, "必须先写完并 fsync 指针临时文件再 rename");
  const before = events.slice(0, renameAt).filter((e) => e.op === "fsync");
  assert.ok(before.length >= 2, "rename 前要 fsync 房文件里的 ckpt 行与指针临时文件");
  assert.equal(before.at(-1).dir, false);
  assert.equal(before.at(-1).ptr, false, "rename 前指针文件不能可见");
  assert.equal(events[renameAt].ptrBefore, false);
  if (process.platform !== "win32") {
    assert.ok(events.slice(renameAt + 1).some((e) => e.op === "fsync" && e.dir), "rename 后必须 fsync 目录项");
  }
  assert.deepEqual(texts(ckptStore(dir).snapshot("r1", LIMITS)), ["user:u1"]);
});

test("检查点指针 fsync 失败：保留旧指针、清理临时文件，重启回退后数据完整", () => {
  const dir = tmpDir();
  const s = ckptStore(dir);
  s.record("r1", end(user("u1", 1)));
  s.record("r1", end(asst("a1", 2)));
  s.flushAll();
  forceCheckpoint(s);
  const ptrFile = path.join(dir, "r1.ckpt.json");
  const oldPtr = fs.readFileSync(ptrFile, "utf8");

  s.record("r1", end(user("u2", 3)));
  s.flushAll();
  const orig = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = function (fd) {
    calls += 1;
    if (calls === 2) throw new Error("EIO"); // 1 = ckpt 行，2 = 指针临时文件
    return orig.call(fs, fd);
  };
  let ok;
  try {
    ok = s._writeCheckpoint(s.rooms.get("r1"));
  } finally {
    fs.fsyncSync = orig;
  }
  assert.equal(calls, 2);
  assert.equal(ok, false, "指针 fsync 失败不能报告检查点成功");
  assert.equal(fs.readFileSync(ptrFile, "utf8"), oldPtr, "失败时必须保留旧指针，不能半截写坏");
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "临时指针文件必须清理");
  const ckptRows = fs.readFileSync(path.join(dir, "r1.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((rec) => rec.k === "ckpt");
  assert.equal(ckptRows.length, 2, "失败尝试的 ckpt 行可以留在文件里，但指针不能指向它");

  // 重启：旧指针仍指向上一个检查点，之后的尾巴（含失败尝试留下的 ckpt 行）被安全跳过
  const resumed = ckptStore(dir);
  assert.deepEqual(texts(resumed.snapshot("r1", LIMITS)), ["user:u1", "assistant:a1", "user:u2"]);
  assert.equal(resumed.info("r1").seq, 3);
  assert.equal(resumed.info("r1").msgCount, 3);
  assert.equal(resumed.rooms.get("r1").ckpt.off, JSON.parse(oldPtr).off, "重启必须继续使用旧指针而不是全量扫描");
});

// ---------- 检查点（长房间首次打开不再同步全量扫描） ----------

const CKPT_OPTS = {
  persist: true,
  prewarm: false,
  ckptMinBytes: 1024 * 1024 * 1024, // 测试里默认靠 forceCheckpoint 精确控制写入点
  ckptIntervalBytes: 1024 * 1024 * 1024,
};

function ckptStore(dir = tmpDir(), extra = {}) {
  return new RoomStore(dir, { ...CKPT_OPTS, ...extra });
}

function forceCheckpoint(s, id = "r1") {
  s.flushAll();
  const r = s.rooms.get(id);
  assert.ok(r, "房间必须已在内存");
  assert.equal(s._writeCheckpoint(r), true, "强制写检查点失败");
  return JSON.parse(fs.readFileSync(path.join(s.dir, `${id}.ckpt.json`), "utf8"));
}

function readPointer(dir, id = "r1") {
  return JSON.parse(fs.readFileSync(path.join(dir, `${id}.ckpt.json`), "utf8"));
}

/** 手工追加一行合法 ckpt（含偏移指针 + sha1），用于构造边界检查点而不必真的制造海量记录。 */
function writeRawCheckpoint(dir, id, rec) {
  const file = path.join(dir, `${id}.jsonl`);
  const payload = JSON.stringify(rec);
  const line = payload + "\n";
  const off = fs.statSync(file).size;
  fs.appendFileSync(file, line);
  const sum = crypto.createHash("sha1").update(payload).digest("hex");
  fs.writeFileSync(
    path.join(dir, `${id}.ckpt.json`),
    JSON.stringify({ v: 2, room: id, rev: rec.rev, off, len: Buffer.byteLength(line), sum }),
  );
}

/** 复制房文件但不带指针：让另一个 store 走一次真正的全量扫描，作为一致性基准。 */
function copyJsonl(srcDir, id, dstDir = tmpDir()) {
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(path.join(srcDir, `${id}.jsonl`), path.join(dstDir, `${id}.jsonl`));
  return dstDir;
}

function view(s, id = "r1") {
  const info = s.info(id);
  const r = s.rooms.get(id);
  return {
    info,
    snapshot: s.snapshot(id, LIMITS),
    delta: s.snapshot(id, { ...LIMITS, since: { rev: info.rev, seq: Math.max(0, info.seq - 3) } }),
    tail: s.tailHashes(id),
    pending: r ? r.pendingRemotes : null,
  };
}

/** 400 条前缀消息 + 一个待取代 remote + 一条注入失败（drop），写检查点，再追加 3 条尾巴。 */
function seedCheckpointRoom(dir, { count = 400 } = {}) {
  const s = ckptStore(dir);
  for (let i = 0; i < count; i++) {
    s.record("r1", end(i % 2 ? asst(`a${i}`, 100 + i) : user(`u${i}`, 100 + i)));
  }
  s.record("r1", { type: "remote_message", text: "pre-r", at: 1, cid: "c1" });
  s.record("r1", { type: "remote_message", text: "pre-drop", at: 3, cid: "cd" });
  assert.equal(s.markRemoteFailed("r1", "pre-drop", "cd"), true);
  s.flushAll();
  const ptr = forceCheckpoint(s);
  s.record("r1", end(user("tail-u", 900)));
  s.record("r1", { type: "remote_message", text: "tail-r", at: 2, cid: "c2" });
  s.record("r1", end(asst("tail-a", 901)));
  s.flushAll();
  return { s, ptr };
}

test("检查点：旧文件首次全量扫描后补检查点（运行时小房间不写，避免写放大）", () => {
  const dir = tmpDir();
  const a = openStore(dir);
  a.record("r1", end(user("old", 1)));
  a.flushAll();
  assert.equal(fs.existsSync(path.join(dir, "r1.ckpt.json")), false, "运行时小文件不该每 200ms 写检查点");

  // 重开 = 旧文件首次全量扫描：即使不大也补一个检查点，下次重启走尾读
  const b = openStore(dir);
  assert.equal(b.info("r1").msgCount, 1);
  assert.ok(readPointer(dir).off > 0, "全量扫描后必须补检查点");

  const c = openStore(dir);
  assert.deepEqual(texts(c.snapshot("r1", LIMITS)), ["user:old"]);
  assert.deepEqual(c.info("r1"), b.info("r1"));
});

test("检查点：重启只读尾部，info/snapshot/tailHashes/pendingRemotes 与全量扫描一致", () => {
  const dir = tmpDir();
  const { s, ptr } = seedCheckpointRoom(dir);
  const live = view(s);

  // 不带指针的副本：旧路径，真正全量扫描（ckpt 行仍存在，必须被忽略）
  const full = ckptStore(copyJsonl(dir, "r1"));
  assert.deepEqual(view(full), live, "检查点恢复与全量扫描的结果必须完全一致");

  // 重启时记录所有 readSync 的位置：不能碰检查点之前的字节
  const reads = [];
  const orig = fs.readSync;
  fs.readSync = function (fd, buf, off, len, pos) {
    if (typeof pos === "number") reads.push({ pos, len });
    return orig.call(fs, fd, buf, off, len, pos);
  };
  let resumed;
  try {
    resumed = ckptStore(dir);
    assert.equal(resumed.info("r1").seq, live.info.seq);
    assert.equal(resumed.tailHashes("r1").length, 8);
  } finally {
    fs.readSync = orig;
  }
  const total = reads.reduce((n, r) => n + r.len, 0);
  assert.ok(reads.length > 0, "恢复路径必须读取检查点行");
  assert.ok(Math.min(...reads.map((r) => r.pos)) >= ptr.off, "重启读取不能碰检查点之前的字节");
  assert.ok(total < ptr.off, `只读尾部：读取 ${total} 字节，检查点前有 ${ptr.off} 字节`);

  assert.deepEqual(view(resumed), live, "恢复后的快照/增量/尾哈希/pending 必须与重启前一致");
  assert.deepEqual(resumed.info("r1"), live.info);
  assert.deepEqual(
    resumed.snapshot("r1", { ...LIMITS, since: { rev: live.info.rev, seq: 7 } }),
    s.snapshot("r1", { ...LIMITS, since: { rev: live.info.rev, seq: 7 } }),
    "since 落在检查点之前时，磁盘补读也不能有缺口",
  );
});

test("检查点：空文件、坏行与未知记录都安全回退，不产生幽灵消息", () => {
  const dir = tmpDir();
  const file = path.join(dir, "r1.jsonl");
  fs.writeFileSync(file, "");
  // 指向不存在偏移的旧指针：必须被判无效并删掉，而不是把空文件当坏文件
  fs.writeFileSync(
    path.join(dir, "r1.ckpt.json"),
    JSON.stringify({ v: 2, room: "r1", rev: "dead", off: 999, len: 5, sum: "0".repeat(40) }),
  );
  const s = ckptStore(dir);
  const info = s.info("r1");
  assert.equal(info.exists, true);
  assert.equal(info.seq, 0);
  assert.equal(info.msgCount, 0);
  assert.equal(typeof info.rev, "string");
  assert.deepEqual(s.snapshot("r1", LIMITS).items, []);
  assert.deepEqual(s.tailHashes("r1"), []);
  assert.equal(fs.existsSync(path.join(dir, "r1.ckpt.json")), false, "无效指针应被清掉");

  assert.equal(s.record("r1", end(user("after-empty", 1))), 1);
  s.flushAll();
  assert.deepEqual(texts(ckptStore(dir).snapshot("r1", LIMITS)), ["user:after-empty"]);

  // 坏行 + 未知记录：全量扫描与检查点尾扫描都必须只跳过、不中断
  const dir2 = tmpDir();
  const { s: a } = seedCheckpointRoom(dir2, { count: 20 });
  fs.appendFileSync(
    path.join(dir2, "r1.jsonl"),
    'not json\n{"k":"msg","seq":"not-a-number"}\n{"k":"future","seq":9000,"x":1}\n',
  );
  const fullView = view(ckptStore(copyJsonl(dir2, "r1")));
  assert.deepEqual(view(ckptStore(dir2)), fullView, "坏行/未知记录在两条路径下结果一致");
});

test("检查点：指针缺失/损坏/校验和不符时回退全量扫描并修复", () => {
  // 缺失：ckpt 行仍在，但只能靠全量扫描重建
  {
    const dir = tmpDir();
    seedCheckpointRoom(dir);
    fs.unlinkSync(path.join(dir, "r1.ckpt.json"));
    assert.deepEqual(view(ckptStore(dir)), view(ckptStore(copyJsonl(dir, "r1"))));
    assert.ok(readPointer(dir).off > 0, "缺失指针在全量扫描后必须补回来");
  }

  // 半截 JSON
  {
    const dir = tmpDir();
    seedCheckpointRoom(dir);
    fs.writeFileSync(path.join(dir, "r1.ckpt.json"), "{");
    assert.deepEqual(view(ckptStore(dir)), view(ckptStore(copyJsonl(dir, "r1"))));
    assert.ok(readPointer(dir).off > 0, "损坏指针必须被重写");
  }

  // 字段合法但校验和不匹配（文件被改写）
  {
    const dir = tmpDir();
    seedCheckpointRoom(dir);
    const ptr = readPointer(dir);
    fs.writeFileSync(path.join(dir, "r1.ckpt.json"), JSON.stringify({ ...ptr, sum: "f".repeat(40) }));
    assert.deepEqual(view(ckptStore(dir)), view(ckptStore(copyJsonl(dir, "r1"))));
    assert.ok(readPointer(dir).off > 0, "校验和不符的指针必须被重写");
  }
});

test("检查点：文件截断（尾巴被切/切到检查点之前）与轮转都回退全量扫描", () => {
  // 切进检查点之后的尾巴：指针仍有效，只修复残行后读尾巴
  {
    const dir = tmpDir();
    const { ptr } = seedCheckpointRoom(dir);
    const file = path.join(dir, "r1.jsonl");
    const size = fs.statSync(file).size;
    const cut = ptr.off + ptr.len + Math.floor((size - ptr.off - ptr.len) / 2);
    fs.truncateSync(file, cut);
    const a = view(ckptStore(dir));
    const b = view(ckptStore(copyJsonl(dir, "r1")));
    assert.deepEqual(a, b);
  }

  // 切到检查点行之前：指针失效，全量扫描截断后的文件
  {
    const dir = tmpDir();
    const { ptr } = seedCheckpointRoom(dir);
    const file = path.join(dir, "r1.jsonl");
    fs.truncateSync(file, Math.max(0, ptr.off - 5));
    const a = view(ckptStore(dir));
    const b = view(ckptStore(copyJsonl(dir, "r1")));
    assert.deepEqual(a, b);
    const repaired = readPointer(dir);
    assert.ok(repaired.off > 0 && repaired.off !== ptr.off, "截断后的旧指针必须被新检查点替换");
  }

  // 轮转：同一路径换成另一份更长/更短的文件，旧指针不能把旧历史装回来
  {
    const dir = tmpDir();
    seedCheckpointRoom(dir);
    const otherDir = tmpDir();
    const other = ckptStore(otherDir);
    other.record("r1", end(user("rotated", 1)));
    other.record("r1", end(asst("new-era", 2)));
    other.flushAll();
    fs.copyFileSync(path.join(otherDir, "r1.jsonl"), path.join(dir, "r1.jsonl"));

    const s = ckptStore(dir, { ckptMinBytes: 1 }); // 全量扫描后允许补新检查点
    assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:rotated", "assistant:new-era"]);
    const ptr2 = readPointer(dir);
    assert.ok(ptr2.off > 0);
    assert.deepEqual(texts(ckptStore(dir).snapshot("r1", LIMITS)), ["user:rotated", "assistant:new-era"]);
  }
});

test("检查点：superseded 区间超过 unpack 上限时按校验失败回退全量扫描", () => {
  const dir = tmpDir();
  const base = ckptStore(dir);
  base.record("r1", end(user("kept", 1)));
  base.flushAll();
  const kept = user("kept", 1);
  writeRawCheckpoint(dir, "r1", {
    k: "ckpt",
    v: 2,
    seq: 0,
    maxSeq: 2_000_000,
    rev: base.info("r1").rev,
    msgCount: 1,
    firstHash: hashOf(kept),
    lastHash: hashOf(kept),
    headTruncated: false,
    metaWritten: true,
    recent: [],
    pending: [],
    toolMetas: [],
    superseded: [[1, 1_000_001]], // 超过 unpack 的单区间上限
    at: 1,
  });

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  let s;
  try {
    s = ckptStore(dir);
    assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:kept"], "回退全量扫描后历史必须完整");
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warns.some((w) => w.includes("superseded 区间非法或超限")),
    "超限必须明确判坏并回退，不能静默丢一部分 superseded",
  );
  const ptr = readPointer(dir); // 全量扫描后已补写合法的新检查点
  assert.ok(ptr.off > 0);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, "r1.jsonl"), "utf8").split("\n").filter(Boolean).at(-1));
  assert.deepEqual(rec.superseded, [], "新检查点不能再带超限区间");
});

test("检查点：reset/drop 删指针，换代后的新消息不会带出旧历史", () => {
  const dir = tmpDir();
  const { s } = seedCheckpointRoom(dir);
  s.reset("r1");
  assert.equal(fs.existsSync(path.join(dir, "r1.ckpt.json")), false, "reset 必须删检查点指针");
  s.record("r1", end(user("new-era", 1)));
  s.flushAll();
  assert.deepEqual(texts(ckptStore(dir).snapshot("r1", LIMITS)), ["user:new-era"]);

  const { s: s2 } = seedCheckpointRoom(tmpDir());
  s2.drop("r1");
  assert.equal(fs.existsSync(path.join(s2.dir, "r1.ckpt.json")), false, "drop 必须删检查点指针");
});

test("检查点过大：60s 冷却内不重试/不刷日志，冷却结束后恢复写入", () => {
  const dir = tmpDir();
  let now = 1_000_000;
  const s = new RoomStore(dir, {
    ...CKPT_OPTS,
    ckptPayloadMaxBytes: 512, // 上限可注入只为测试快；生产默认仍是 16MB
    now: () => now,
  });
  s.record("r1", end(user("x".repeat(1200), 1)));
  s.flushAll();
  const r = s.rooms.get("r1");
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  const rejectWarns = () => warns.filter((w) => w.includes("检查点过大")).length;
  try {
    assert.equal(s._writeCheckpoint(r), false);
    assert.ok(r._ckptReject, "拒绝时必须记录时间和大小");
    assert.equal(r._ckptReject.at, now);
    assert.ok(r._ckptReject.bytes > 512);
    assert.equal(rejectWarns(), 1);
    assert.equal(fs.existsSync(path.join(dir, "r1.ckpt.json")), false);

    // 忙房间每条新消息都会走到 _maybeCheckpoint：冷却期内必须直接跳过，不重复序列化/不刷日志
    for (let i = 0; i < 5; i++) {
      now += 1000;
      s.record("r1", end(user(`small-${i}`, 10 + i)));
      assert.equal(s._maybeCheckpoint(r, { minBytes: 0 }), false);
    }
    assert.equal(rejectWarns(), 1, "冷却期内不能每条消息都刷一行日志");

    // 即使 payload 已经变小，冷却期内也不写：挡住的是时间，不是大小
    r.recent = [{ k: "msg", seq: r.seq, json: JSON.stringify(user("small-final", 99)) }];
    r.recentBytes = r.recent[0].json.length;
    assert.equal(s._writeCheckpoint(r), false);
    assert.equal(fs.existsSync(path.join(dir, "r1.ckpt.json")), false);

    now += 60 * 1000;
    assert.equal(s._maybeCheckpoint(r, { minBytes: 0 }), true, "冷却结束后应恢复写检查点（同一条 seq 也要能重试）");
    assert.equal(r._ckptReject, null);
    assert.ok(fs.existsSync(path.join(dir, "r1.ckpt.json")));
    assert.equal(rejectWarns(), 1, "恢复写入不应再补打旧日志");
  } finally {
    console.warn = origWarn;
  }
});

test("ckpt 行对旧版扫描透明：seq 是数字 0、k 未知、无 m，不计坏行也不多算消息", () => {
  const dir = tmpDir();
  seedCheckpointRoom(dir, { count: 20 });
  const file = path.join(dir, "r1.jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const ckpt = lines.map((line) => JSON.parse(line)).find((rec) => rec.k === "ckpt");
  assert.ok(ckpt, "文件里必须有 ckpt 行");
  assert.equal(typeof ckpt.seq, "number");
  assert.equal(ckpt.seq, 0);
  assert.equal("m" in ckpt, false);

  // 直接复刻旧版 _indexFile 的记录分支：没有 seq 数字才算坏行；只认 meta/drop/msg/remote。
  let seq = 0;
  let msgCount = 0;
  let skipped = 0;
  let seenCkpt = 0;
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (!rec || typeof rec.seq !== "number") { skipped++; continue; }
    if (rec.k === "ckpt") { seenCkpt++; continue; } // 旧版实际是落到最后的 else 分支：什么都不做
    if (rec.k === "meta" || rec.k === "drop") continue;
    if (rec.seq > seq) seq = rec.seq;
    if (rec.k === "msg" && rec.m && rec.m.role !== "system") msgCount++;
  }
  const info = ckptStore(dir).info("r1");
  assert.equal(seenCkpt, 1);
  assert.equal(skipped, 0, "旧版不能把 ckpt 行算成坏记录");
  assert.equal(seq, info.seq);
  assert.equal(msgCount, info.msgCount);
});

/* ---------------- ended-tool 元数据（终端胶囊历史重建） ---------------- */

test("toolmeta：结束元数据独立落盘，不占 seq/不进消息快照；重启只读检查点尾巴也能补", () => {
  const dir = tmpDir();
  const s = ckptStore(dir);
  s.record("r1", end(user("u1", 1)));
  const before = Date.now();
  assert.equal(s.record("r1", toolEnd("call_1")), 0, "元数据不占 seq");
  assert.equal(s.info("r1").seq, 1);
  assert.equal(s.info("r1").msgCount, 1);
  const snap = s.snapshot("r1", LIMITS);
  assert.equal(snap.items.length, 1, "toolmeta 不能出现在消息快照里");
  assert.equal(JSON.parse(snap.items[0]).role, "user");

  const first = s.toolEnds("r1");
  assert.equal(first.length, 1);
  assert.equal(first[0].toolCallId, "call_1");
  assert.equal(first[0].isError, true);
  assert.equal(first[0].exit_code, 2);
  assert.equal(first[0].wall_time_seconds, 1.5);
  assert.equal(first[0].termStatus, "timeout");
  assert.ok(first[0].endedAt >= before, "没有显式 endedAt 时用 relay 收到 end 的时刻");

  // 重复 end 幂等：不新增条目、不改第一次的 endedAt；缺字段不抹掉已有字段
  const dup = s.recordToolEnd("r1", toolEnd("call_1"));
  assert.equal(dup.changed, false);
  assert.deepEqual(s.toolEnds("r1"), first);
  const older = s.recordToolEnd("r1", { type: "tool_execution_end", toolCallId: "call_1", exit_code: 9, endedAt: first[0].endedAt - 1000 });
  assert.equal(older.changed, true, "新字段仍可补");
  const merged = s.toolEnds("r1")[0];
  assert.equal(merged.exit_code, 9);
  assert.equal(merged.endedAt, first[0].endedAt, "乱序的旧 endedAt 不能把结束时刻改早");
  assert.equal(merged.termStatus, "timeout", "缺字段不抹掉已有 termStatus");

  // 检查点后追加的第二条：重启只读 ckpt 之后的尾巴，但两条都要在
  forceCheckpoint(s);
  s.record("r1", toolEnd("call_2", { isError: false, exit_code: 0, termStatus: undefined }));
  s.flushAll();

  const resumed = ckptStore(dir);
  assert.equal(resumed.info("r1").seq, 1, "元数据不影响消息 seq");
  assert.deepEqual(resumed.toolEnds("r1").map((m) => m.toolCallId), ["call_1", "call_2"]);
  assert.equal(resumed.toolEnds("r1")[1].exit_code, 0);

  // 全量扫描路径必须和检查点恢复路径一致
  const full = ckptStore(copyJsonl(dir, "r1"));
  assert.deepEqual(full.toolEnds("r1"), resumed.toolEnds("r1"));
});

test("toolmeta：每房上限裁最旧；裁剪不影响消息索引，重启后仍只剩保留窗", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, { ...CKPT_OPTS, toolMetaMax: 2 });
  s.record("r1", end(user("u1", 1)));
  s.record("r1", toolEnd("call_1", { exit_code: 1 }));
  s.record("r1", toolEnd("call_2", { exit_code: 2 }));
  s.record("r1", toolEnd("call_3", { exit_code: 3 }));
  s.record("r1", end(asst("a1", 2)));
  assert.deepEqual(s.toolEnds("r1").map((m) => m.toolCallId), ["call_2", "call_3"], "超出上限丢最旧");
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:u1", "assistant:a1"], "裁剪不能动消息/seq");
  assert.equal(s.info("r1").seq, 2);

  forceCheckpoint(s);
  s.flushAll();
  const resumed = new RoomStore(dir, { ...CKPT_OPTS, toolMetaMax: 2 });
  assert.deepEqual(resumed.toolEnds("r1").map((m) => m.toolCallId), ["call_2", "call_3"]);
  assert.deepEqual(texts(resumed.snapshot("r1", LIMITS)), ["user:u1", "assistant:a1"]);

  // 全量扫描同样裁到上限（磁盘上仍有三条 toolmeta 行，旧的可丢）
  const full = new RoomStore(copyJsonl(dir, "r1"), { ...CKPT_OPTS, toolMetaMax: 2 });
  assert.deepEqual(full.toolEnds("r1").map((m) => m.toolCallId), ["call_2", "call_3"]);
  assert.deepEqual(texts(full.snapshot("r1", LIMITS)), ["user:u1", "assistant:a1"]);
});

test("toolmeta：默认上限至少 2000，旧实现 200 条上限不会把长会话早期历史滚出", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, { ...CKPT_OPTS });
  assert.ok(s.toolMetaMax >= 2000, "默认每房至少保留 2000 条");
  s.record("r1", end(user("u1", 1)));
  for (let i = 1; i <= 205; i += 1) s.recordToolEnd("r1", toolEnd(`call_${i}`, { exit_code: i, termStatus: undefined }));
  const live = s.toolEnds("r1");
  assert.equal(live.length, 205, "205 条都在：200 上限会丢掉最早的 5 条");
  assert.equal(live[0].toolCallId, "call_1");
  assert.equal(live.at(-1).toolCallId, "call_205");

  forceCheckpoint(s);
  s.flushAll();
  const ptr = readPointer(dir);
  assert.ok(ptr.len < 2 * 1024 * 1024, `检查点尺寸可控（${ptr.len} 字节）`);
  const resumed = new RoomStore(dir, { ...CKPT_OPTS });
  assert.equal(resumed.toolEnds("r1").length, 205, "检查点恢复路径保留全部 205 条");
  assert.equal(resumed.toolEnds("r1")[0].toolCallId, "call_1");
  assert.deepEqual(texts(resumed.snapshot("r1", LIMITS)), ["user:u1"], "toolmeta 不占消息 seq");

  // 全量扫描路径与检查点恢复路径一致
  const full = new RoomStore(copyJsonl(dir, "r1"), { ...CKPT_OPTS });
  assert.equal(full.toolEnds("r1").length, 205);
  assert.equal(full.toolEnds("r1")[0].toolCallId, "call_1");
});

test("toolmeta：v1 检查点升级回退一次全量扫描，并装回旧文件里的元数据", () => {
  const dir = tmpDir();
  const id = "r1";
  const file = path.join(dir, `${id}.jsonl`);
  const m = user("old", 1);
  const meta = { toolCallId: "t-old", isError: true, exit_code: 124, wall_time_seconds: 30, termStatus: "timeout", endedAt: 12345 };
  const lines = [
    JSON.stringify({ k: "meta", seq: 0, rev: "oldrev" }),
    `{"k":"msg","seq":1,"m":${JSON.stringify(m)}}`,
    JSON.stringify({ k: "toolmeta", seq: 0, ...meta }),
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const rec = {
    k: "ckpt",
    v: 1, // 旧版检查点：不认识 toolMetas
    seq: 0,
    maxSeq: 1,
    rev: "oldrev",
    msgCount: 1,
    firstHash: hashOf(m),
    lastHash: hashOf(m),
    headTruncated: false,
    metaWritten: true,
    recent: [],
    pending: [],
    superseded: [],
    at: 1,
  };
  const payload = JSON.stringify(rec);
  fs.appendFileSync(file, payload + "\n");
  const off = fs.statSync(file).size - Buffer.byteLength(payload + "\n");
  fs.writeFileSync(
    path.join(dir, `${id}.ckpt.json`),
    JSON.stringify({ v: 1, room: id, rev: "oldrev", off, len: Buffer.byteLength(payload + "\n"), sum: crypto.createHash("sha1").update(payload).digest("hex") }),
  );

  const s = ckptStore(dir);
  assert.deepEqual(s.toolEnds(id), [meta], "v1 指针无效 → 全量扫描装载 toolmeta");
  assert.deepEqual(texts(s.snapshot(id, LIMITS)), ["user:old"]);
  const ptr = readPointer(dir, id);
  assert.equal(ptr.v, 2, "回退后补写 v2 检查点");
  assert.ok(ptr.off > 0);
  assert.deepEqual(ckptStore(dir).toolEnds(id), [meta], "新检查点带 toolMetas，重启只读尾巴仍然有");
});

test("toolmeta：坏元数据行只跳过；检查点 toolMetas 非法时回退全量扫描", () => {
  const dir = tmpDir();
  const base = ckptStore(dir);
  base.record("r1", end(user("kept", 1)));
  base.record("r1", toolEnd("t-keep"));
  base.flushAll();
  fs.appendFileSync(path.join(dir, "r1.jsonl"), '{"k":"toolmeta","seq":0}\n{"k":"toolmeta","seq":0,"toolCallId":""}\n');
  assert.deepEqual(ckptStore(dir).toolEnds("r1").map((m) => m.toolCallId), ["t-keep"], "坏行不能破坏索引");

  // 手工写一个 v2 检查点，但 toolMetas 里是坏条目：必须判坏 → 全量扫描仍然保留有效元数据
  writeRawCheckpoint(dir, "r1", {
    k: "ckpt",
    v: 2,
    seq: 0,
    maxSeq: 2,
    rev: base.info("r1").rev,
    msgCount: 1,
    firstHash: hashOf(user("kept", 1)),
    lastHash: hashOf(user("kept", 1)),
    headTruncated: false,
    metaWritten: true,
    recent: [],
    pending: [],
    toolMetas: [{}],
    superseded: [],
    at: 1,
  });
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  let s;
  let ends;
  try {
    s = ckptStore(dir);
    // 读 API 是同步的：第一次访问房间才读检查点/全量扫描，告警必须在这段窗口内发生
    ends = s.toolEnds("r1");
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warns.some((w) => w.includes("toolMetas 条目非法")), "坏检查点必须明确回退");
  assert.deepEqual(ends.map((m) => m.toolCallId), ["t-keep"]);
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:kept"]);
});

test("toolmeta：reset 换代清空；persist=false 只在内存补发", () => {
  const dir = tmpDir();
  const s = ckptStore(dir);
  s.record("r1", toolEnd("call_1"));
  assert.equal(s.toolEnds("r1").length, 1);
  s.reset("r1");
  assert.deepEqual(s.toolEnds("r1"), [], "换代后旧 end 元数据不能复活");

  const memDir = tmpDir();
  const mem = new RoomStore(memDir, { persist: false });
  mem.record("r1", toolEnd("call_mem"));
  assert.deepEqual(mem.toolEnds("r1").map((m) => m.toolCallId), ["call_mem"]);
  assert.equal(fs.existsSync(path.join(memDir, "r1.jsonl")), false, "persist=false 不写盘");
});

function writeBigRoom(dir, count, id = "big") {  const file = path.join(dir, `${id}.jsonl`);
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, JSON.stringify({ k: "meta", seq: 0, rev: "rev-big" }) + "\n");
    const text = "z".repeat(400);
    let batch = [];
    for (let i = 1; i <= count; i++) {
      const m = { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `${text}${i}` }], timestamp: i };
      batch.push(`{"k":"msg","seq":${i},"m":${JSON.stringify(m)}}`);
      if (batch.length >= 2000) {
        fs.writeSync(fd, batch.join("\n") + "\n");
        batch = [];
      }
    }
    if (batch.length) fs.writeSync(fd, batch.join("\n") + "\n");
  } finally {
    fs.closeSync(fd);
  }
  return fs.statSync(file).size;
}

test("预热索引：超过房间上限时只保留最近活跃的 N 个，其余首次打开同步扫描", async () => {
  const dir = tmpDir();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [i, id] of ["a", "b", "c"].entries()) {
    writeBigRoom(dir, 800, id);
    const t = nowSec - (3 - i) * 10; // a 最旧、c 最新
    fs.utimesSync(path.join(dir, `${id}.jsonl`), t, t);
  }
  const s = new RoomStore(dir, {
    persist: true,
    prewarm: true,
    prewarmMinBytes: 1,
    prewarmMaxRooms: 2,
    prewarmTtlMs: 60_000,
    ckptMinBytes: 1024 * 1024 * 1024,
    ckptIntervalBytes: 1024 * 1024 * 1024,
  });
  await s.prewarmReady();
  assert.deepEqual([...s._prewarmed.keys()], ["c", "b"], "只预热 mtime 最新的两个房间");
  assert.equal(s.info("a").seq, 800, "超限未预热的房间首次打开仍能同步建立索引");
  assert.equal(s.info("b").seq, 800);
  assert.equal(s.info("c").seq, 800);
});

test("预热索引：TTL 到期未被打开就丢弃，首次打开回退同步扫描", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tmpDir();
  writeBigRoom(dir, 800, "big");
  const s = new RoomStore(dir, {
    persist: true,
    prewarm: true,
    prewarmMinBytes: 1,
    prewarmMaxRooms: 8,
    prewarmTtlMs: 25,
    ckptMinBytes: 1024 * 1024 * 1024,
    ckptIntervalBytes: 1024 * 1024 * 1024,
  });
  await s.prewarmReady();
  assert.equal(s._prewarmed.size, 1);
  t.mock.timers.tick(30);
  assert.equal(s._prewarmed.size, 0, "超过 TTL 没被首次打开就释放");
  assert.equal(s.info("big").seq, 800, "丢弃后首次打开仍能同步扫描");
});

test("检查点：构造器异步预热大文件，预热期间事件循环可调度；重启只读尾巴", { timeout: 120000 }, async () => {
  const dir = tmpDir();
  const count = 20000;
  const size = writeBigRoom(dir, count);
  assert.ok(size > 5 * 1024 * 1024, "测试文件要够大（>5MB）");
  const opts = {
    persist: true,
    prewarmMinBytes: 1024 * 1024,
    ckptMinBytes: 1024 * 1024,
    ckptIntervalBytes: 1024 * 1024,
  };

  // 5ms 心跳：同步全量扫描会让它长时间停摆；分块预热期间应持续触发
  let ticks = 0;
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap > maxGap) maxGap = gap;
    ticks++;
  }, 5);
  const t0 = Date.now();
  const s = new RoomStore(dir, opts);
  await s.prewarmReady();
  const prewarmMs = Date.now() - t0;
  clearInterval(timer);

  assert.ok(ticks >= 3, `预热期间事件循环应被调度（ticks=${ticks}）`);
  assert.ok(maxGap < 250, `预热单次占住事件循环不能太久（maxGap=${maxGap}ms）`);

  // 预热完成后首次打开必须零读盘：把 readSync 变成炸弹也能拿到完整 info/tailHashes
  const orig = fs.readSync;
  let info;
  let tail;
  try {
    fs.readSync = () => {
      throw new Error("预热完成后首次打开不应再读盘");
    };
    info = s.info("big");
    tail = s.tailHashes("big");
  } finally {
    fs.readSync = orig;
  }
  assert.equal(info.seq, count);
  assert.equal(info.msgCount, count);
  assert.equal(tail.length, 8);
  const ptr = readPointer(dir, "big");
  assert.ok(ptr.off > 0, "预热完成后应补上检查点");

  // 再重启：只读检查点行 + 尾巴，不能碰前缀
  const reads = [];
  fs.readSync = function (fd, buf, off, len, pos) {
    if (typeof pos === "number") reads.push({ pos, len });
    return orig.call(fs, fd, buf, off, len, pos);
  };
  let s2;
  let info2;
  let tail2;
  const reopenStart = Date.now();
  try {
    s2 = new RoomStore(dir, opts);
    info2 = s2.info("big");
    tail2 = s2.tailHashes("big");
  } finally {
    fs.readSync = orig;
  }
  const reopenMs = Date.now() - reopenStart;
  const totalBytes = reads.reduce((n, r) => n + r.len, 0);
  assert.equal(info2.seq, count);
  assert.equal(info2.msgCount, count);
  assert.deepEqual(tail2, tail);
  assert.ok(Math.min(...reads.map((r) => r.pos)) >= ptr.off, "重启不能读检查点之前的字节");
  assert.ok(totalBytes < size / 2, `重启只读尾巴（读了 ${totalBytes}/${size} 字节）`);
  assert.ok(reopenMs < 500, `重启打开不能长阻塞（${reopenMs}ms）`);

  // 有有效检查点的大文件不再预热；小文件也不预热
  const s3 = new RoomStore(dir, opts);
  await s3.prewarmReady();
  assert.equal(s3._prewarmed.size, 0, "有检查点的大文件不应重复预热");
  const smallDir = tmpDir();
  const small = ckptStore(smallDir);
  small.record("s1", end(user("small", 1)));
  small.flushAll();
  const s4 = new RoomStore(smallDir, { ...opts, prewarm: true });
  await s4.prewarmReady();
  assert.equal(s4._prewarmed.size, 0, "小文件不应预热");

  console.log(
    `[perf] 大小=${(size / 1048576).toFixed(1)}MB 预热=${prewarmMs}ms 心跳=${ticks}次 最大间隔=${maxGap}ms ` +
      `重启=${reopenMs}ms 读取=${totalBytes}B (${((totalBytes / size) * 100).toFixed(2)}%)`,
  );
});

// ---------- 房间表删除路径（evictIdle / 保留期清理）----------

test("rooms：evictIdle 与保留期 map.delete 都清理 resend/快照定时器，与 close 路径一致", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rooms = new Rooms({ roomIdleEvictMs: 1000, snapshotCacheTtlMs: 1000 });
  function makeRoom(id, { online = false, fired }) {
    const room = rooms.get(id);
    room.lastActivity = 0;
    room.online = online;
    room.resendTimer = setTimeout(() => { fired.resend++; }, 500);
    room.resendTimer.unref();
    room.resendWaiters = [{ ws: id }];
    room.snap = {
      at: 0,
      body: `snapshot-${id}`,
      timer: setTimeout(() => { fired.snap++; }, 500),
    };
    room.snap.timer.unref();
    return room;
  }

  const firedA = { resend: 0, snap: 0 };
  const firedB = { resend: 0, snap: 0 };
  const a = makeRoom("a", { fired: firedA });
  const b = makeRoom("b", { online: true, fired: firedB });

  assert.equal(rooms.evictIdle(), 1, "只淘汰离线且无观众的 a");
  assert.equal(rooms.peek("a"), null);
  assert.equal(a.resendTimer, null);
  assert.deepEqual(a.resendWaiters, []);
  assert.equal(a.snap, null);

  // server.js 的保留期清理直接调 rooms.map.delete(id)：也必须走同一套清理
  rooms.map.delete("b");
  assert.equal(rooms.peek("b"), null);
  assert.equal(b.resendTimer, null);
  assert.deepEqual(b.resendWaiters, []);
  assert.equal(b.snap, null);

  t.mock.timers.tick(5_000);
  assert.deepEqual(firedA, { resend: 0, snap: 0 }, "evictIdle 删除后不能有悬挂定时器回调");
  assert.deepEqual(firedB, { resend: 0, snap: 0 }, "保留期删除后不能有悬挂定时器回调");
});
