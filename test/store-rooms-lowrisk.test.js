"use strict";
/**
 * relay 存储/房间核心的低危修复回归（61 条低危明细里本模块负责的 1/2/3/4/6/8/15/16/17）。
 *
 * 每条用例对准一个"静默降级/耐久中断/订阅者干等"的失败路径：
 *   1. 目录 fsync 失败一次就永久标成已同步 → 落盘耐久没有后续重试；
 *   2. 索引只装了一部分（病态文件/扫描抛错）仍当正常房交付部分历史、不报错；
 *   3. 超限归档被拒后旧版本滞留 → 后开的网页重放上一版正文；
 *   4. 检查点临时文件孤儿无人清理 + 房文件本体没有大小上限；
 *   6. 正文重发兜底读快照出错时退回 rev:null（注释里明说要避免的错误形态）；
 *   8. 离线房间的 busy 残留出现在房间列表（快照口径是 online && busy）；
 *  15. 快照装配抛错时重发已被取消 → 订阅者永远等首帧（store/rooms 侧的兜底）；
 *  16. 索引重写 rename 后没 fsync 父目录 → 掉电后已删除的会话行可能复活；
 *  17. 名册/令牌写入的整文件重写挡在消息线程的写返回上。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RoomStore } = require("../relay/store.js");
const { storeSessionArchive, ARCHIVE_MAX_BYTES } = require("../relay/sessionArchive.js");
const { Rooms, resendFallbackBody } = require("../relay/rooms.js");
const { AccountIndex, safeKey } = require("../relay/index.js");

function tmpDir(prefix = "pi-remote-lowrisk-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const user = (text, ts = 1) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const asst = (text, ts = 2) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts, stopReason: "stop" });
const end = (message) => ({ type: "message_end", message });
const sessionFile = (dir, account = "admin", device = "dev-1") =>
  path.join(dir, safeKey(account), "sessions", safeKey(device) + ".jsonl");

/* ---------------- 低危 1：目录 fsync 失败不再"一次就永久算已同步" ---------------- */

test("低危 1：目录 fsync 失败保持未同步并按退避重试，成功后标记已同步", () => {
  const dir = tmpDir();
  let clock = 1_000;
  const s = new RoomStore(dir, { persist: true, prewarm: false, now: () => clock });
  const realFsyncDir = s._fsyncDir.bind(s);
  let calls = 0;
  let fail = true;
  s._fsyncDir = () => {
    calls += 1;
    return fail ? false : realFsyncDir();
  };

  s.record("r1", end(user("a")));
  s.flushAll();
  const r = s.rooms.get("r1");
  assert.equal(r.dirSynced, false, "第一次目录 fsync 失败绝不能标成已同步（否则耐久没有下文）");
  assert.equal(calls, 1);

  s.record("r1", end(asst("b", 2)));
  s.flushAll();
  assert.equal(calls, 1, "退避窗口内不重复 syscall（不支持目录 fsync 的平台不能每次 flush 都打）");
  assert.equal(r.dirSynced, false);

  fail = false;
  clock += 60_000;
  s.record("r1", end(asst("c", 3)));
  s.flushAll();
  assert.equal(calls, 2, "退避到期后必须重试目录 fsync");
  assert.equal(r.dirSynced, true, "重试成功后才标记已同步");

  // reset 也会尝试目录 fsync：失败同样不能标成已同步，且后续 flush 还能补
  fail = true;
  clock += 60_000;
  assert.equal(s.reset("r1"), true);
  assert.equal(s.rooms.get("r1").dirSynced, false, "reset 的目录 fsync 失败不能被当成已同步");
  fail = false;
  clock += 60_000;
  s.record("r1", end(user("after-reset", 4)));
  s.flushAll();
  assert.equal(s.rooms.get("r1").dirSynced, true);
});

/* ---------------- 低危 2：索引不完整不再当正常房交付 ---------------- */

test("低危 2：病态房文件（整段没有换行）不再当空房交付，快照标 truncated 且 info 可见", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "bad.jsonl"),
    JSON.stringify({ k: "msg", seq: 1, m: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    "utf8",
  );
  const s = new RoomStore(dir, { persist: true, prewarm: false });
  const snap = s.snapshot("bad", {});
  assert.equal(snap.truncated, true, "只装出空/半份索引时必须报 truncated（旧实现报 false）");
  assert.deepEqual(snap.items, []);
  assert.equal(s.info("bad").indexFailed, true, "info.indexFailed 让调用方/诊断看到索引不完整");
});

test("低危 2：索引扫描抛错时快照标 truncated、不走增量，正常房间不受影响", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "r2.jsonl"),
    [
      JSON.stringify({ k: "meta", seq: 0, rev: "rev-a" }),
      JSON.stringify({ k: "msg", seq: 1, m: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    ].join("\n") + "\n",
    "utf8",
  );
  const s = new RoomStore(dir, { persist: true, prewarm: false });
  s._scanChunksSync = () => {
    throw new Error("EIO simulated");
  };
  const snap = s.snapshot("r2", { since: { rev: "rev-a", seq: 0 } });
  assert.equal(snap.delta, false, "索引没装全时增量不可信，不能按 since 只交付一段");
  assert.equal(snap.truncated, true);
  assert.equal(s.info("r2").indexFailed, true);

  const ok = new RoomStore(tmpDir(), { persist: true, prewarm: false });
  ok.seedOrMerge("fine", [user("hello")]);
  assert.equal(ok.snapshot("fine", {}).truncated, false, "正常房间不能被误标");
  assert.equal(ok.info("fine").indexFailed, false);
});

/* ---------------- 低危 3：超限归档被拒后不留旧版本 ---------------- */

test("低危 3：新正文超 200KB 被拒时，同 id 的旧归档必须一起丢掉（不能重放旧版正文）", () => {
  const dev = {};
  const small = storeSessionArchive(dev, { id: "s1", messages: [{ role: "user", text: "旧正文" }] });
  assert.ok(small, "小正文正常入缓存");
  assert.equal(dev.archives.has("s1"), true);

  // 单条正文会被 sanitize 截到 8000 字符，用多条把整份顶过 200KB 上限
  const bigMessages = Array.from({ length: 40 }, (_, i) => ({ role: "user", text: String(i) + "x".repeat(7900) }));
  const big = storeSessionArchive(dev, { id: "s1", messages: bigMessages });
  assert.equal(big, null, "超限正文仍然被拒");
  assert.equal(dev.archives.has("s1"), false, "旧版本必须一起清掉，后开的网页才不会拿到过时正文");
  assert.ok(ARCHIVE_MAX_BYTES > 0);

  // 其它 id 不误伤；非法 session 不抛错
  storeSessionArchive(dev, { id: "s2", messages: [{ role: "user", text: "keep" }] });
  assert.equal(storeSessionArchive(dev, null), null);
  assert.equal(storeSessionArchive(dev, { id: "x".repeat(300) }), null);
  assert.equal(dev.archives.has("s2"), true);
});

/* ---------------- 低危 4：检查点临时文件孤儿 + 房文件大小上限 ---------------- */

test("低危 4a：启动清理一小时前的检查点临时文件孤儿；新鲜临时文件与无关文件不动", async () => {
  const dir = tmpDir();
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  const orphan = path.join(dir, "r1.ckpt.json.1234.deadbeef.tmp");
  const fresh = path.join(dir, "r2.ckpt.json.9999.cafebabe.tmp");
  const unrelated = path.join(dir, "notes.tmp");
  fs.writeFileSync(orphan, "{}");
  fs.utimesSync(orphan, old, old);
  fs.writeFileSync(fresh, "{}");
  fs.writeFileSync(unrelated, "x");
  fs.utimesSync(unrelated, old, old);

  const s = new RoomStore(dir, { persist: true, prewarm: false });
  await tick(); // 构造器把清理排在 setImmediate
  assert.equal(fs.existsSync(orphan), false, "上次异常退出的检查点临时文件要被清掉");
  assert.equal(fs.existsSync(fresh), true, "一小时内的临时文件可能另一个进程正在写，不能误删");
  assert.equal(fs.existsSync(unrelated), true, "非检查点临时文件不归 store 管");
  assert.equal(s.rooms.size, 0);
});

test("低危 4b：房文件到上限后停止落盘（内存继续服务），reset 后可重新落盘", () => {
  const maxRoomFileBytes = 4096;
  const s = new RoomStore(tmpDir(), { persist: true, prewarm: false, maxRoomFileBytes });
  const file = path.join(s.dir, "r1.jsonl");
  for (let i = 0; i < 40; i++) {
    s.record("r1", end(user(`m${i}-${"x".repeat(60)}`, i + 1)));
    if (i % 4 === 3) s.flushAll(); // 分成小批，先写进去一部分再到顶
  }
  s.flushAll();
  const r = s.rooms.get("r1");
  assert.equal(r.fileCapped, true, "越过上限后房间进入停止落盘状态");
  assert.ok(r.dropped > 0, "被拒的记录要计入 dropped（info 暴露）");
  assert.ok(fs.statSync(file).size <= maxRoomFileBytes, `文件不能越过上限（实际 ${fs.statSync(file).size}）`);
  assert.ok(fs.statSync(file).size > 0, "上限不是不落盘：到顶前的内容仍然保留");
  assert.equal(s.info("r1").dropped, r.dropped);

  // 到顶后仍能读：内存热缓存里有全部消息（快照不因停盘而丢实时内容）
  const snap = s.snapshot("r1", {});
  assert.equal(snap.items.length, 40);

  const sizeBefore = fs.statSync(file).size;
  s.record("r1", end(user("later")));
  s.flushAll();
  assert.equal(fs.statSync(file).size, sizeBefore, "到顶后不再增长（重试没有意义）");

  // 换代/reset 清掉上限状态，重新 seed 能继续落盘
  assert.equal(s.reset("r1"), true);
  s.seedOrMerge("r1", [user("fresh")]);
  s.flushAll();
  assert.equal(s.rooms.get("r1").fileCapped, false);
  assert.ok(fs.statSync(file).size > 0, "reset 后新世代重新落盘");
});

/* ---------------- 低危 6：重发兜底出错不再退回 rev:null ---------------- */

test("低危 6：重发兜底读快照抛错时仍拿真实 rev/seq（不再退注释里明说避免的 rev:null）", () => {
  const room = { id: "r1" };
  const cfg = { maxSnapshotRecords: 100, maxSnapshotBytes: 1024 * 1024 };
  const store = {
    snapshot() {
      throw new Error("boom");
    },
    info() {
      return { rev: "rev-real", seq: 7 };
    },
  };
  const body = resendFallbackBody(cfg, store, room);
  assert.match(body, /"rev":"rev-real"/, "快照失败不能连带把锚点也丢成 null");
  assert.match(body, /"seq":7/);
  assert.match(body, /"snapshotPending":true/);

  // 快照读失败但 info 也失败：保持可发帧（不能抛），并降级为 rev:null
  const broken = {
    snapshot() {
      throw new Error("boom");
    },
    info() {
      throw new Error("nope");
    },
  };
  let fallback;
  assert.doesNotThrow(() => {
    fallback = resendFallbackBody(cfg, broken, room);
  });
  assert.match(fallback, /"rev":null/);

  // 空快照（无记录）仍走锚点帧：rev/seq 由 info 提供
  const empty = {
    snapshot() {
      return { rev: "rev-a", seq: 3, truncated: false, items: [] };
    },
    info() {
      return { rev: "rev-a", seq: 3 };
    },
  };
  const emptyBody = resendFallbackBody(cfg, empty, room);
  assert.match(emptyBody, /"rev":"rev-a"/);
  assert.match(emptyBody, /"seq":3/);
});

/* ---------------- 低危 8：房间列表的 busy 与快照同口径 ---------------- */

test("低危 8：离线房间的 busy 残留不出现在房间列表（online && busy 口径）", () => {
  const rooms = new Rooms({ roomIdleEvictMs: 10 * 60_000, snapshotCacheTtlMs: 5_000 });
  const r = rooms.get("a");
  r.busy = true;
  r.online = false;
  r.lastActivity = Date.now();
  assert.equal(rooms.list()[0].busy, false, "离线房间不能报正在输出（与 snapshotFrame 的 online && busy 一致）");

  r.online = true;
  assert.equal(rooms.list()[0].busy, true);

  r.busy = false;
  assert.equal(rooms.list()[0].busy, false);
});

/* ---------------- 低危 15：快照装配抛错时订阅者不再干等 ---------------- */

test("低危 15：store.snapshot 内部抛错时不向上抛，退回带真锚点的 truncated 快照", () => {
  const s = new RoomStore(tmpDir(), { persist: true, prewarm: false });
  s.seedOrMerge("r1", [user("x")]);
  const before = s.info("r1");
  s._collect = () => {
    throw new Error("boom");
  };
  let snap;
  assert.doesNotThrow(() => {
    snap = s.snapshot("r1", {});
  }, "快照发布路径拿到异常就发不出帧，重发已被取消的订阅者会一直等首帧");
  assert.equal(snap.truncated, true);
  assert.equal(snap.delta, false);
  assert.equal(snap.rev, before.rev);
  assert.equal(snap.seq, before.seq);
  assert.deepEqual(snap.items, []);
});

test("低危 15：快照装配抛错时退回带真锚点的 truncated 空快照，且不缓存失败结果", () => {
  const rooms = new Rooms({ roomIdleEvictMs: 10 * 60_000, snapshotCacheTtlMs: 5_000 });
  rooms.bindStore({
    info() {
      return { rev: "rev-x", seq: 9 };
    },
  });
  let body;
  assert.doesNotThrow(() => {
    body = rooms.snapshotBody("r1", () => {
      throw new Error("boom");
    });
  }, "装配异常不能抛给订阅路径，否则已经加入 viewers 的连接收不到任何帧");
  assert.match(body, /"rev":"rev-x"/);
  assert.match(body, /"seq":9/);
  assert.match(body, /"truncated":true/, "让 UI 明确看到不完整，而不是把空正文当完整快照");
  assert.equal(rooms.peek("r1").snap, null, "失败结果不写快照缓存，下一次订阅会重试");

  const ok = rooms.snapshotBody("r1", () => `"rev":"rev-x","seq":9,"truncated":false,"messages":[]`);
  assert.match(ok, /"truncated":false/);
});

/* ---------------- 低危 16：索引重写 rename 后 fsync 父目录 ---------------- */

test("低危 16：forgetSession 的整文件重写后 fsync 父目录（掉电后删除的行不能复活）", () => {
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  idx.applyManifest("admin", "dev-1", { full: true, updatedAt: 1, sessions: [{ id: "s1", path: "/x/s1", updatedAt: 1 }] }, 1);
  const sessionsDir = path.join(dir, safeKey("admin"), "sessions");

  const opened = [];
  const synced = [];
  const origOpen = fs.openSync;
  const origClose = fs.closeSync;
  const origFsync = fs.fsyncSync;
  fs.openSync = function patchedOpen(p, ...args) {
    const fd = origOpen.call(fs, p, ...args);
    if (typeof p === "string") opened.push({ path: p, fd });
    return fd;
  };
  // fd 会被复用：close 时把记录摘掉，否则 fsync 的 fd 会被错配到上一个已关闭的文件
  fs.closeSync = function patchedClose(fd) {
    for (let i = opened.length - 1; i >= 0; i--) {
      if (opened[i].fd === fd) {
        opened.splice(i, 1);
        break;
      }
    }
    return origClose.call(fs, fd);
  };
  fs.fsyncSync = function patchedFsync(fd) {
    const hit = opened.find((o) => o.fd === fd);
    if (hit) synced.push(hit.path);
    return origFsync.call(fs, fd);
  };
  try {
    assert.equal(idx.forgetSession("admin", "dev-1", "s1", 10), true);
  } finally {
    fs.openSync = origOpen;
    fs.closeSync = origClose;
    fs.fsyncSync = origFsync;
  }
  assert.ok(
    synced.includes(sessionsDir),
    `rename 之后必须 fsync 父目录 ${sessionsDir}（实际 fsync: ${synced.join(", ")}）`,
  );
});

/* ---------------- 低危 17：整文件重写挪出写路径 ---------------- */

test("低危 17：索引压缩在写调用返回后才做，且合并期间的新行不丢", async () => {
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  idx.applyManifest("admin", "dev-1", { full: true, updatedAt: 1, sessions: [{ id: "s1", path: "/x/s1", updatedAt: 1 }] }, 1);
  const file = sessionFile(dir);
  // 历史遗留垃圾把文件撑过 256KB 压缩阈值（解析时跳过，不影响合并结果）
  fs.appendFileSync(file, "x".repeat(300 * 1024) + "\n", "utf8");
  const before = fs.statSync(file).size;

  idx.applyManifest("admin", "dev-1", { full: false, updatedAt: 2, sessions: [{ id: "s2", path: "/x/s2", updatedAt: 2 }] }, 2);
  // 排队期间又追加一行：压缩执行时必须用最新缓存，不能拿排队前的旧表把这一行抹掉
  idx.applyManifest("admin", "dev-1", { full: false, updatedAt: 3, sessions: [{ id: "s3", path: "/x/s3", updatedAt: 3 }] }, 3);
  assert.ok(fs.statSync(file).size >= before, "写调用返回时还没整文件重写（不挡消息线程）");

  await tick();
  assert.ok(fs.statSync(file).size < 64 * 1024, "本轮事件循环之后压缩完成，体积降下来");
  const fresh = new AccountIndex(dir);
  assert.ok(fresh.getSession("admin", "dev-1", "s1"), "旧行不能因为压缩丢失");
  assert.ok(fresh.getSession("admin", "dev-1", "s2"), "排队后的新行必须写进压缩结果");
  assert.ok(fresh.getSession("admin", "dev-1", "s3"), "排队期间追加的行也不能被旧表抹掉");
});

test("低危 17：令牌追加+fsync 仍在写返回前完成，整文件压缩只排到下一轮", async () => {
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  const now = Date.now();
  idx.issueDeviceToken("admin", "d1", "h1", now);
  const file = path.join(dir, safeKey("admin"), "device-tokens.jsonl");
  fs.appendFileSync(file, ("x".repeat(1024) + "\n").repeat(300), "utf8");
  const before = fs.statSync(file).size;
  assert.ok(before > 256 * 1024);

  idx.issueDeviceToken("admin", "d2", "h2", now);
  assert.ok(fs.statSync(file).size > before, "新令牌行同步追加落盘（撤销/签发不能延后）");
  assert.equal(idx.hasDeviceToken("admin", "d2"), true, "内存表立即生效");
  assert.ok(fs.statSync(file).size > 256 * 1024, "压缩还没在写路径里发生");

  await tick();
  assert.ok(fs.statSync(file).size < 64 * 1024, "下一轮完成压缩");
  assert.equal(idx.hasDeviceToken("admin", "d1"), true);
  assert.equal(idx.hasDeviceToken("admin", "d2"), true);
  const reopened = new AccountIndex(dir);
  assert.equal(reopened.hasDeviceToken("admin", "d1"), true);
  assert.equal(reopened.hasDeviceToken("admin", "d2"), true);
});
