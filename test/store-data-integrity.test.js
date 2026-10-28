"use strict";
/**
 * relay 数据正确性回归（评审报告 relay 高-1 / 高-2 / 中-1 / 中-2 / 中-3 / 中-5）。
 *
 * 每个用例都直接针对一个会让“历史悄悄变脏”的失败路径：
 *   - 截断快照的兜底对齐只由一条 hash 判定 → 异分支历史被当成已对齐静默合并；
 *   - 落盘写一半失败后整批重试 → 重复记录 + 半截行与下一行粘成一条；
 *   - 落盘持续失败削批时把 meta 行丢掉 → 重启 rev 漂移；
 *   - 缺口判定数条数不数 distinct seq → 缺一条重一条仍报“完整”；
 *   - superseded 集合无上限 → 检查点 eventually 超限被永久拒绝；
 *   - reset 截断失败无信号 → 新世代 seed 进旧文件，重启后新旧混写。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RoomStore, hashOf } = require("../relay/store.js");

const LIMITS = { limit: 10000, maxBytes: 64 * 1024 * 1024 };
const FAST = { persist: true, prewarm: false, ckptMinBytes: 1024 * 1024 * 1024, ckptIntervalBytes: 1024 * 1024 * 1024 };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-store-integrity-"));
}
const user = (text, ts = 1) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const asst = (text, ts = 2) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts, stopReason: "stop" });
const custom = (text, ts) => ({ role: "custom", customType: "remote-bash", content: `Ran \`${text}\``, timestamp: ts });
const end = (message) => ({ type: "message_end", message });
const texts = (snap) => snap.items.map((s) => {
  const m = JSON.parse(s);
  return `${m.role}:${typeof m.content === "string" ? m.content : m.content[0].text}`;
});
const readLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
const parseLines = (file) => readLines(file).map((line) => JSON.parse(line));

/* ---------------- 高-1：截断快照兜底对齐的最小门槛 ---------------- */

test("高-1 截断快照兜底对齐：只重叠 1 条 / 无时间戳锚点一律 reset，不静默合并异分支", () => {
  // 单条重叠：内存最后一条与快照首条是同内容 custom（hash 不含 timestamp），旧实现判“已对齐”，
  // 跳过这条后直接把快照其余消息追加到旧分支上。
  const s = new RoomStore(tmpDir(), { persist: false });
  s.seedOrMerge("r1", [user("u", 1), asst("a", 2), custom("ls", 3)]);
  const sameContent = custom("ls", 99);
  assert.equal(hashOf(sameContent), hashOf(custom("ls", 3)), "custom 的 hash 必须与 timestamp 无关（复现前提）");
  const one = s.seedOrMerge("r1", [sameContent], { truncated: true });
  assert.equal(one.reset, true, "只重叠 1 条时必须换代，不能把异分支当成已对齐");
  assert.equal(one.seeded, 1);
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["custom:Ran `ls`"], "旧分支必须整体换掉");

  // 重叠 2 条且全部是没有时间戳锚点的 custom：也不足以下结论。
  const s2 = new RoomStore(tmpDir(), { persist: false });
  s2.seedOrMerge("r1", [custom("a", 1), custom("b", 2), custom("c", 3)]);
  const two = s2.seedOrMerge("r1", [custom("b", 4), custom("c", 5)], { truncated: true });
  assert.equal(two.reset, true, "重叠 2 条且无时间戳锚点必须换代");
  assert.deepEqual(texts(s2.snapshot("r1", LIMITS)), ["custom:Ran `b`", "custom:Ran `c`"]);

  // 门槛满足：重叠 3 条且含带 timestamp 的 assistant → 继续按“内存后缀 == 快照前缀”对齐，不换代。
  const s3 = new RoomStore(tmpDir(), { persist: false });
  s3.seedOrMerge("r1", [user("u", 10), asst("a", 11), custom("c", 12), custom("d", 13)]);
  const aligned = s3.seedOrMerge("r1", [asst("a", 11), custom("c", 12), custom("d", 13)], { truncated: true });
  assert.equal(aligned.reset, false, "重叠 ≥3 且带时间戳锚点时应继续对齐");
  assert.equal(aligned.merged, 0, "快照全在内存里，没有新消息要追加");
  assert.deepEqual(
    texts(s3.snapshot("r1", LIMITS)),
    ["user:u", "assistant:a", "custom:Ran `c`", "custom:Ran `d`"],
    "被截掉的头部留在内存里",
  );
});

/* ---------------- 高-2：半失败落盘 / 检查点的残行与重试 ---------------- */

/** 包装 fs.writeSync：第一次调用只写一部分就抛错（模拟磁盘满/IO 错误写到一半）。 */
function withPartialWrite(mode, fn) {
  const orig = fs.writeSync;
  let armed = true;
  const raw = (fd, buf, off, len) => orig.call(fs, fd, buf, off, len);
  fs.writeSync = function (fd, buf, off, len) {
    if (!armed) return raw(fd, buf, off, len);
    armed = false;
    let n;
    if (mode === "first-line") {
      const idx = buf.subarray(off, off + len).indexOf(0x0a);
      n = idx >= 0 ? idx + 1 : Math.max(1, len >> 1);
    } else {
      n = Math.max(1, Math.floor(len / 2));
    }
    raw(fd, buf, off, n);
    throw new Error("ENOSPC（测试模拟半写失败）");
  };
  try {
    return fn();
  } finally {
    fs.writeSync = orig;
  }
}

function assertCleanJsonl(file, seqs) {
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("\n"), "文件必须以换行结尾（不能留半截行）");
  const recs = parseLines(file);
  const got = recs.filter((rec) => rec.k === "msg").map((rec) => rec.seq);
  if (seqs) assert.deepEqual(got, seqs, "重试后不能有重复或缺口");
  return recs;
}

test("高-2 落盘半失败：截掉残行并从实际写入位置续写，不重复、不粘行", () => {
  for (const mode of ["half-line", "first-line"]) {
    const dir = tmpDir();
    const s = new RoomStore(dir, FAST);
    for (let i = 1; i <= 5; i++) s.record("r1", end(user(`u${i}`, i)));
    s.flushAll();
    const file = path.join(dir, "r1.jsonl");
    const before = fs.readFileSync(file, "utf8");

    for (let i = 6; i <= 9; i++) s.record("r1", end(user(`u${i}`, i)));
    const r = s.rooms.get("r1");
    withPartialWrite(mode, () => s._flush(r));

    const afterFail = fs.readFileSync(file, "utf8");
    assert.ok(afterFail.startsWith(before), "失败不能让已确认的历史变样");
    assert.ok(afterFail.endsWith("\n"), `${mode}：失败后必须立刻截掉残行`);
    for (const line of afterFail.split("\n").filter(Boolean)) JSON.parse(line);

    s.flushAll();
    assertCleanJsonl(file, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const reopened = new RoomStore(dir, FAST);
    assert.deepEqual(
      texts(reopened.snapshot("r1", LIMITS)),
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `user:u${i}`),
      `${mode}：重开后不能出现重复消息`,
    );
    assert.equal(reopened.info("r1").dropped, 0, "重试成功不应计丢弃");
  }
});

test("高-2 崩溃残留半截行：下一次追加前先截掉，不能与新记录粘成一行", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, FAST);
  s.record("r1", end(user("u1", 1)));
  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  fs.appendFileSync(file, '{"k":"msg","seq":2,"m":{"role":"user"'); // 上次进程崩溃留下的半截行
  s.record("r1", end(user("u2", 2)));
  s.flushAll();
  const recs = assertCleanJsonl(file, [1, 2]);
  assert.equal(recs.filter((rec) => rec.k === "meta").length, 1, "meta 行不能被重复写");
  assert.deepEqual(texts(new RoomStore(dir, FAST).snapshot("r1", LIMITS)), ["user:u1", "user:u2"]);
});

test("高-2 检查点半失败：不留下半截 ckpt 行、不写指针，下一次检查点正常", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, FAST);
  s.record("r1", end(user("u1", 1)));
  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  const ptrFile = path.join(dir, "r1.ckpt.json");
  const r = s.rooms.get("r1");

  let ok;
  withPartialWrite("half-line", () => { ok = s._writeCheckpoint(r); });
  assert.equal(ok, false, "半截检查点行必须报告失败");
  assert.equal(fs.existsSync(ptrFile), false, "失败时不能落指针");
  assert.ok(fs.readFileSync(file, "utf8").endsWith("\n"));
  assert.equal(parseLines(file).filter((rec) => rec.k === "ckpt").length, 0, "残行必须被截掉，不能留下半截 ckpt");

  assert.equal(s._writeCheckpoint(r), true, "下一次检查点必须能正常写入");
  const recs = parseLines(file);
  assert.equal(recs.filter((rec) => rec.k === "ckpt").length, 1);
  assert.deepEqual(texts(new RoomStore(dir, FAST).snapshot("r1", LIMITS)), ["user:u1"]);
});

/* ---------------- 中-1：削批不能丢 meta ---------------- */

test("中-1 落盘持续失败削批钉住 meta：重启 rev 不漂移，丢弃计数经 info() 暴露", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, FAST);
  // 只为攒够缓冲：暂停自动 flush，最后手动触发一次半失败（真实写路径仍是原实现）。
  const origSchedule = s._scheduleFlush;
  s._scheduleFlush = () => {};
  try {
    for (let i = 1; i <= 5100; i++) s.record("r1", end(user(`m${i}`, i)));
  } finally {
    s._scheduleFlush = origSchedule;
  }
  const r = s.rooms.get("r1");
  const before = s.info("r1");
  assert.equal(r.buf.length, 5101, "meta + 5100 条消息都在缓冲里");

  const origWrite = fs.writeSync;
  fs.writeSync = () => { throw new Error("ENOSPC（测试模拟持续失败）"); };
  const origWarn = console.warn;
  const origErr = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    s._flush(r);
  } finally {
    fs.writeSync = origWrite;
    console.warn = origWarn;
    console.error = origErr;
  }

  assert.ok(r.metaLine, "meta 行必须被钉在缓冲里");
  assert.equal(r.buf[0], r.metaLine, "meta 行必须仍在缓冲最前面");
  assert.ok(r.buf.length <= 5001, `削批后缓冲应受限（${r.buf.length}）`);
  assert.ok(r.dropped > 0, "削批必须计数");
  assert.equal(s.info("r1").dropped, r.dropped, "丢弃计数要经 info() 暴露");
  assert.equal(s.info("r1").rev, before.rev);

  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  assert.equal(parseLines(file)[0].k, "meta", "落盘文件第一行必须是 meta");
  const reopened = new RoomStore(dir, FAST);
  assert.equal(reopened.info("r1").rev, before.rev, "重开后 rev 必须与内存一致（meta 没丢）");
  assert.equal(reopened.info("r1").dropped, 0, "新进程没有丢弃");
});

/* ---------------- 中-2：缺口判定按 distinct seq ---------------- */

test("中-2 缺口判定数 distinct seq：缺一条 + 重一条仍报不完整（缓存与磁盘补读两条路径）", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, FAST);
  for (let i = 1; i <= 5; i++) s.record("r1", end(user(`u${i}`, i)));
  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  const recs = parseLines(file);
  const seq2 = recs.find((rec) => rec.k === "msg" && rec.seq === 2);
  const corrupted = recs
    .filter((rec) => !(rec.k === "msg" && rec.seq === 3)) // 缺 seq 3
    .flatMap((rec) => (rec === seq2 ? [rec, { ...seq2 }] : [rec])); // 重一条 seq 2：条数仍是 5
  fs.writeFileSync(file, corrupted.map((rec) => JSON.stringify(rec)).join("\n") + "\n");
  assert.equal(corrupted.length, recs.length, "构造后总条数不变（旧实现会被凑满）");

  const cached = new RoomStore(dir, FAST).snapshot("r1", LIMITS);
  assert.equal(cached.truncated, true, "热缓存路径必须按 distinct seq 报缺口");

  // cacheSize 很小：快照必须走磁盘补读，同样不能用重复行凑数。
  const disk = new RoomStore(dir, { ...FAST, cacheSize: 2 }).snapshot("r1", LIMITS);
  assert.equal(disk.truncated, true, "磁盘补读路径必须按 distinct seq 报缺口");
});

/* ---------------- 中-3：superseded 集合上限 ---------------- */

test("中-3 superseded 集合有上限：超出按 seq 裁旧，不再线性膨胀", () => {
  const s = new RoomStore(tmpDir(), { persist: false, supersededMax: 8 });
  for (let i = 0; i < 40; i++) {
    s.record("r1", { type: "remote_message", text: `r${i}`, at: i });
    s.record("r1", end(user(`r${i}`, 100 + i)));
  }
  const r = s.rooms.get("r1");
  assert.ok(r.superseded.size <= 10, `集合必须被裁到上限附近（实际 ${r.superseded.size}）`);
  assert.ok(r.superseded.has(79), "最近被取代的回显 seq 必须保留（否则会重新出现在回放里）");
  assert.equal(r.superseded.has(1), false, "最旧的 superseded 应被裁掉");
});

/* ---------------- 中-5：reset 截断失败 ---------------- */

test("中-5 reset 截断失败返回 false 并中止 seed；恢复后换代成功、旧消息不复活", () => {
  const dir = tmpDir();
  const s = new RoomStore(dir, FAST);
  s.seedOrMerge("r1", [user("old-1", 1), asst("old-2", 2)]);
  s.flushAll();
  const file = path.join(dir, "r1.jsonl");
  const oldText = fs.readFileSync(file, "utf8");
  const oldInfo = s.info("r1");

  const origOpen = fs.openSync;
  const arm = () => {
    fs.openSync = function (p, flags, ...rest) {
      if (p === file && flags === "w") throw new Error("EACCES（测试模拟截断失败）");
      return origOpen.call(fs, p, flags, ...rest);
    };
  };
  const disarm = () => { fs.openSync = origOpen; };

  arm();
  let ok;
  try { ok = s.reset("r1"); } finally { disarm(); }
  assert.equal(ok, false, "reset 必须把截断失败报告给调用方");
  assert.equal(s.info("r1").rev, oldInfo.rev, "失败不能换代：内存与磁盘保持同一旧世代");
  assert.deepEqual(texts(s.snapshot("r1", LIMITS)), ["user:old-1", "assistant:old-2"]);

  // 不同分支快照 → 走 reset 的 seed 路径：再次失败必须中止 seed，不能往旧文件追加新世代。
  arm();
  let seeded;
  try {
    seeded = s.seedOrMerge("r1", [user("new-1", 9), asst("new-2", 10)]);
  } finally { disarm(); }
  assert.equal(seeded.resetFailed, true, "reset 失败的 seed 必须上报");
  assert.equal(seeded.seeded, 0, "失败时不能 seed");
  assert.equal(fs.readFileSync(file, "utf8"), oldText, "失败时不能把新世代写进旧文件");
  assert.equal(s.info("r1").seq, oldInfo.seq, "内存也不能换代");

  // 恢复后重试：正常换代，重启只看到新历史。
  const retry = s.seedOrMerge("r1", [user("new-1", 9), asst("new-2", 10)]);
  assert.equal(retry.reset, true);
  assert.equal(retry.resetFailed, undefined);
  assert.equal(retry.seeded, 2);
  s.flushAll();
  assert.deepEqual(
    texts(new RoomStore(dir, FAST).snapshot("r1", LIMITS)),
    ["user:new-1", "assistant:new-2"],
    "旧分支不能再复活",
  );
});
