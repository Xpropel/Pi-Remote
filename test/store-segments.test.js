"use strict";
/** 存储结构改造（目录分组 + 分段 + 清单索引）的专项用例。
 *  口径见 relay/store.js 文件头第 8 条：默认单文件、现役段写满 segmentMaxBytes 封存、
 *  清单 state 复用检查点 payload 形态、冷打开只扫现役段、清单损坏走重扫重建降级。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RoomStore, encodeCwdSegment } = require("../relay/store");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-seg-"));
}
function openStore(dir, opts = {}) {
  return new RoomStore(dir, { persist: true, prewarm: false, ...opts });
}
const user = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const end = (message) => ({ type: "message_end", message });
// ~230 字节正文 → 每条落盘行约 300 字节
const msg = (i, pad = 230) => end(user(`m${i}-` + "x".repeat(pad), i + 1));
const LIMITS = { limit: 100000, maxBytes: 64 * 1024 * 1024 };

/** 分批落盘 N 条（模拟真实 200ms/200 条的 flush 节奏：封存发生在批与批之间）。 */
function recordMany(s, n, { flushEvery = 5, pad = 230 } = {}) {
  for (let i = 0; i < n; i++) {
    s.record("r1", msg(i, pad));
    if ((i + 1) % flushEvery === 0) s.flushAll();
  }
  s.flushAll();
}

function roomFiles(dir, id) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith(id)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("小文件不分段：形态与改造前一致（只有 <id>.jsonl，无封存段、无清单）", () => {
  const dir = tmpDir();
  const s = openStore(dir, { segmentMaxBytes: 4096 });
  for (let i = 0; i < 5; i++) s.record("r1", msg(i));
  s.flushAll();
  assert.deepEqual(fs.readdirSync(dir), ["r1.jsonl"]);
  assert.equal(s.info("r1").seq, 5);
});

test("写满封存：0001/0002 递增、新现役续写、seq 跨段连续、快照跨段拼齐", () => {
  const dir = tmpDir();
  const s = openStore(dir, { segmentMaxBytes: 2048, ckptMinBytes: 1024 * 1024 });
  const N = 60;
  recordMany(s, N);
  const names = fs.readdirSync(dir).sort();
  assert.ok(names.includes("r1.0001.jsonl"), `应有第一个封存段: ${names}`);
  assert.ok(names.includes("r1.0002.jsonl"), `应有第二个封存段: ${names}`);
  assert.ok(names.includes("r1.jsonl"), "现役段仍在");
  assert.ok(names.includes("r1.index.json"), "封存后应有清单");
  // 封存段都不超过阈值 + 一批的余量（整批不越过：最多溢出一批）
  for (const n of names.filter((x) => /\.\d{4}\.jsonl/.test(x))) {
    assert.ok(fs.statSync(path.join(dir, n)).size <= 2048 + 2000, `${n} 不应远超段阈值 + 一批余量`);
  }
  assert.equal(s.info("r1").seq, N);
  const snap = s.snapshot("r1", LIMITS);
  assert.equal(snap.truncated, false);
  assert.equal(snap.items.length, N, "快照跨段拼齐");
  const texts = snap.items.map((j) => JSON.parse(j).content[0].text);
  for (let i = 0; i < N; i++) assert.ok(texts[i].startsWith(`m${i}-`), `第 ${i} 条顺序对齐`);
  // 清单条目形态：与段文件一一对位，state 是检查点 payload 形态
  const man = JSON.parse(fs.readFileSync(path.join(dir, "r1.index.json"), "utf8"));
  assert.equal(man.v, 1);
  assert.equal(man.room, "r1");
  assert.equal(man.segments.length, names.filter((x) => /\.\d{4}\.jsonl/.test(x)).length);
  const e0 = man.segments[0];
  assert.equal(e0.file, "r1.0001.jsonl");
  assert.equal(e0.bytes, fs.statSync(path.join(dir, "r1.0001.jsonl")).size);
  assert.ok(e0.events > 0 && e0.firstSeq === 1 && e0.lastSeq > 0, "首段条目统计: " + JSON.stringify(e0));
  assert.equal(e0.state.k, "ckpt");
  assert.equal(e0.state.v, 2);
  assert.equal(e0.state.maxSeq, e0.lastSeq, "state 应恰好覆盖到该段末尾");
  // 冷打开（新 store）：跨段数据完整
  const s2 = openStore(dir, { segmentMaxBytes: 2048, ckptMinBytes: 1024 * 1024 });
  assert.equal(s2.info("r1").seq, N);
  assert.equal(s2.snapshot("r1", LIMITS).items.length, N);
});

test("冷打开只扫现役段：封存段零字节读（清单命中），数据完整", () => {
  const dir = tmpDir();
  const s = openStore(dir, { segmentMaxBytes: 2048, ckptMinBytes: 1024 * 1024, ckptIntervalBytes: 1024 * 1024 });
  const N = 40;
  recordMany(s, N);
  assert.ok(fs.existsSync(path.join(dir, "r1.0001.jsonl")));

  // 按文件统计 readSync 读到的字节数
  const fdPaths = new Map();
  const readBytes = new Map();
  const origOpen = fs.openSync;
  const origRead = fs.readSync;
  fs.openSync = function (p, ...rest) {
    const fd = origOpen.call(fs, p, ...rest);
    fdPaths.set(fd, String(p));
    return fd;
  };
  fs.readSync = function (fd, buf, off, len, pos) {
    const got = origRead.call(fs, fd, buf, off, len, pos);
    const f = fdPaths.get(fd);
    if (f && typeof pos === "number") readBytes.set(f, (readBytes.get(f) || 0) + got);
    return got;
  };
  let info;
  let snap;
  try {
    const s2 = openStore(dir, { segmentMaxBytes: 2048, ckptMinBytes: 1024 * 1024, ckptIntervalBytes: 1024 * 1024 });
    info = s2.info("r1");
    snap = s2.snapshot("r1", LIMITS);
  } finally {
    fs.openSync = origOpen;
    fs.readSync = origRead;
  }
  assert.equal(info.seq, N);
  assert.equal(snap.items.length, N);
  for (const [f, bytes] of readBytes) {
    assert.ok(!/\.\d{4}\.jsonl$/.test(f), `封存段不应被读: ${f} 读了 ${bytes} 字节`);
  }
});

test("清单损坏：全量重扫降级、数据不丢、清单自动重建", () => {
  const dir = tmpDir();
  const opts = { segmentMaxBytes: 2048, ckptMinBytes: 1024 * 1024 * 1024, ckptIntervalBytes: 1024 * 1024 * 1024 };
  const s = openStore(dir, opts);
  const N = 40;
  recordMany(s, N);
  const manFile = path.join(dir, "r1.index.json");
  assert.ok(fs.existsSync(manFile));
  fs.writeFileSync(manFile, "{ not json !!!");

  const s2 = openStore(dir, opts);
  const snap = s2.snapshot("r1", LIMITS);
  assert.equal(snap.items.length, N, "清单损坏不能丢数据");
  assert.equal(s2.info("r1").seq, N);
  const rebuilt = JSON.parse(fs.readFileSync(manFile, "utf8"));
  assert.equal(rebuilt.v, 1);
  assert.ok(rebuilt.segments.length >= 1);
  assert.ok(rebuilt.segments.every((e) => e.state && e.state.k === "ckpt"), "重建的清单应带回 state");
});

test("清单条目字节对不上（段文件被外部改动）：该段作废重扫，数据仍完整", () => {
  const dir = tmpDir();
  const opts = { segmentMaxBytes: 2048, ckptMinBytes: 1024 * 1024 * 1024, ckptIntervalBytes: 1024 * 1024 * 1024 };
  const s = openStore(dir, opts);
  const N = 40;
  recordMany(s, N);
  // 篡改清单里第一段的 bytes（模拟段文件被换/清单过期）
  const manFile = path.join(dir, "r1.index.json");
  const man = JSON.parse(fs.readFileSync(manFile, "utf8"));
  man.segments[0].bytes += 1;
  fs.writeFileSync(manFile, JSON.stringify(man));
  const s2 = openStore(dir, opts);
  assert.equal(s2.snapshot("r1", LIMITS).items.length, N);
  assert.equal(s2.info("r1").seq, N);
});

test("检查点落在封存段里：虚拟偏移指针仍可恢复，快照完整", () => {
  const dir = tmpDir();
  const opts = { segmentMaxBytes: 4096, ckptMinBytes: 1024, ckptIntervalBytes: 1024 };
  const s = openStore(dir, opts);
  for (let i = 0; i < 10; i++) s.record("r1", msg(i));
  s.flushAll();
  const ptrFile = path.join(dir, "r1.ckpt.json");
  assert.ok(fs.existsSync(ptrFile), "应已写出检查点");
  const ptr = JSON.parse(fs.readFileSync(ptrFile, "utf8"));
  // 继续写到封存：含检查点行的段被封进 0001
  for (let i = 10; i < 40; i++) s.record("r1", msg(i));
  s.flushAll();
  assert.ok(fs.existsSync(path.join(dir, "r1.0001.jsonl")), "应已封存");
  const tailBefore = s.tailHashes("r1");
  const s2 = openStore(dir, opts);
  const info2 = s2.info("r1");
  assert.equal(info2.seq, 40);
  assert.equal(info2.msgCount, 40);
  assert.equal(s2.snapshot("r1", LIMITS).items.length, 40);
  assert.deepEqual(s2.tailHashes("r1"), tailBefore, "检查点恢复的尾哈希应与实时一致");
  assert.ok(ptr.off > 0);
});

test("检查点在封存后继续推进（虚拟偏移 > 封存字节）：重开仍只读尾巴且完整", () => {
  const dir = tmpDir();
  const opts = { segmentMaxBytes: 4096, ckptMinBytes: 1024, ckptIntervalBytes: 1024 };
  const s = openStore(dir, opts);
  for (let i = 0; i < 50; i++) s.record("r1", msg(i));
  s.flushAll();
  const man = JSON.parse(fs.readFileSync(path.join(dir, "r1.index.json"), "utf8"));
  const sealedBytes = man.segments.reduce((n, e) => n + e.bytes, 0);
  assert.ok(sealedBytes > 0);
  const ptr = JSON.parse(fs.readFileSync(path.join(dir, "r1.ckpt.json"), "utf8"));
  assert.ok(ptr.off >= sealedBytes, `后期检查点应在虚拟流后部: off=${ptr.off} sealed=${sealedBytes}`);
  const s2 = openStore(dir, opts);
  assert.equal(s2.info("r1").seq, 50);
  assert.equal(s2.snapshot("r1", LIMITS).items.length, 50);
});

test("平铺老文件启动迁移：定位可考证 → 分组目录；不可考证 → _未分类", () => {
  // (a) 可考证
  const dir = tmpDir();
  const lines = [
    JSON.stringify({ k: "meta", seq: 0, rev: "rev-mig" }),
    JSON.stringify({ k: "msg", seq: 1, m: user("hello", 1) }),
    JSON.stringify({ k: "msg", seq: 2, m: user("world", 2) }),
  ];
  fs.writeFileSync(path.join(dir, "r1.jsonl"), lines.join("\n") + "\n");
  const s = openStore(dir);
  s.setLocator(() => ({ deviceId: "dev-1", cwd: "/Users/a/proj" }));
  const grouped = path.join(dir, "dev-1", "--Users-a-proj--", "r1.jsonl");
  assert.equal(fs.existsSync(path.join(dir, "r1.jsonl")), false, "平铺原文件应已迁走");
  assert.equal(fs.existsSync(grouped), true, "应迁入分组目录");
  assert.equal(s.snapshot("r1", LIMITS).items.length, 2, "迁移后照常打开");
  assert.equal(s.info("r1").rev, "rev-mig");
  // 幂等：再接入一次不报错、不重复搬
  s.setLocator(() => ({ deviceId: "dev-1", cwd: "/Users/a/proj" }));
  assert.equal(fs.existsSync(grouped), true);

  // (b) 不可考证
  const dir2 = tmpDir();
  fs.writeFileSync(path.join(dir2, "r9.jsonl"), lines.join("\n") + "\n");
  const s2 = openStore(dir2);
  s2.setLocator(() => null);
  const fallback = path.join(dir2, "_未分类", "_未分类", "r9.jsonl");
  assert.equal(fs.existsSync(fallback), true, "无从考证应归 _未分类");
  assert.equal(s2.snapshot("r9", LIMITS).items.length, 2, "未分类房间数据不丢");
});

test("迁移崩溃可重入：工件一半已在分组、一半还在平铺时接着归位", () => {
  const dir = tmpDir();
  const groupedDir = path.join(dir, "dev-2", "--home-a-w--");
  fs.mkdirSync(groupedDir, { recursive: true });
  const lines = [JSON.stringify({ k: "meta", seq: 0, rev: "rev-part" }), JSON.stringify({ k: "msg", seq: 1, m: user("x", 1) })];
  fs.writeFileSync(path.join(groupedDir, "r2.jsonl"), lines.join("\n") + "\n"); // 正文已迁
  fs.writeFileSync(path.join(dir, "r2.ckpt.json"), JSON.stringify({ v: 2, room: "r2", rev: "rev-part", off: 0, len: 10, sum: "0".repeat(40), at: 1 }) + "\n"); // 指针还留在平铺
  const s = openStore(dir);
  s.setLocator(() => ({ deviceId: "dev-2", cwd: "/home/a/w" }));
  assert.equal(fs.existsSync(path.join(dir, "r2.ckpt.json")), false, "平铺指针应被接着迁走");
  assert.equal(fs.existsSync(path.join(groupedDir, "r2.ckpt.json")), true);
  assert.equal(s.info("r2").seq, 1);
});

test("分组落盘：带定位新建的房间直接生在 <设备>/<工作区> 目录", () => {
  const dir = tmpDir();
  const s = openStore(dir);
  s.setLocator((id) => (id === "r1" ? { deviceId: "mac-1", cwd: "/Users/a/CLI/Pi-Remote" } : null));
  s.record("r1", msg(0));
  s.flushAll();
  const file = path.join(dir, "mac-1", "--Users-a-CLI-Pi-Remote--", "r1.jsonl");
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(path.join(dir, "r1.jsonl")), false);
});

test("drop 整房删除：现役段 + 全部封存段 + 清单 + 指针一个不留", () => {
  const dir = tmpDir();
  const s = openStore(dir, { segmentMaxBytes: 2048, ckptMinBytes: 1024, ckptIntervalBytes: 1024 });
  recordMany(s, 40);
  assert.ok(roomFiles(dir, "r1").length >= 3, "应有段+现役+清单");
  s.drop("r1");
  assert.deepEqual(roomFiles(dir, "r1"), [], "drop 后不应剩任何 r1 文件");
  assert.equal(s.roomFileExists("r1"), false);
  assert.equal(s.exists("r1"), false);
});

test("reset 换代：封存段与清单一并清掉，新世代从空现役段重写", () => {
  const dir = tmpDir();
  const s = openStore(dir, { segmentMaxBytes: 2048, ckptMinBytes: 1024 * 1024 });
  recordMany(s, 40);
  assert.ok(fs.existsSync(path.join(dir, "r1.0001.jsonl")));
  assert.equal(s.reset("r1"), true);
  assert.deepEqual(roomFiles(dir, "r1").map((p) => path.basename(p)), ["r1.jsonl"]);
  assert.equal(fs.statSync(path.join(dir, "r1.jsonl")).size, 0);
  s.seedOrMerge("r1", [user("new-gen", 100)]);
  s.flushAll();
  const s2 = openStore(dir, { segmentMaxBytes: 2048 });
  const snap = s2.snapshot("r1", LIMITS);
  assert.equal(snap.items.length, 1);
  assert.equal(JSON.parse(snap.items[0]).content[0].text, "new-gen");
});

test("总量上限按全段总和判：封存段 + 现役段合计到顶后停止落盘", () => {
  const dir = tmpDir();
  const s = openStore(dir, { segmentMaxBytes: 1000, maxRoomFileBytes: 2600, ckptMinBytes: 1024 * 1024 });
  recordMany(s, 100, { flushEvery: 2 });
  const total = roomFiles(dir, "r1").filter((p) => p.endsWith(".jsonl")).reduce((n, p) => n + fs.statSync(p).size, 0);
  assert.ok(total <= 2600, `全段总和不应越过上限: ${total}`);
  assert.ok(total > 1000, "应已产生封存段并接近上限");
  const info = s.info("r1");
  assert.equal(info.seq, 100, "内存继续服务，seq 照常递增");
  assert.ok(info.dropped > 0, "到顶后丢弃的落盘应计数");
});

test("encodeCwdSegment 与 attach/pi 的目录编码同规则", () => {
  assert.equal(encodeCwdSegment("/Users/a/CLI/Pi-Remote"), "--Users-a-CLI-Pi-Remote--");
  assert.equal(encodeCwdSegment("/home/u/app"), "--home-u-app--");
  assert.equal(encodeCwdSegment("D:\\work\\app"), "--D--work-app--");
  assert.equal(encodeCwdSegment(""), null);
  assert.equal(encodeCwdSegment("/"), null);
  assert.equal(encodeCwdSegment(null), null);
});

test("异步路径跨段扫描：大房间（多段）冷打开走异步、落地后完整，清单顺路重建", { timeout: 120000 }, async () => {
  const dir = tmpDir();
  const opts = { segmentMaxBytes: 3 * 1024 * 1024, ckptMinBytes: 1024 * 1024 * 1024, ckptIntervalBytes: 1024 * 1024 * 1024 };
  const s = openStore(dir, opts);
  const big = end(user("y".repeat(4096), 1));
  const N = 2600; // ≈ 10.7MB → 3 个封存段 + 现役段
  for (let i = 0; i < N; i++) {
    big.message.timestamp = i + 1;
    s.record("r1", big);
  }
  s.flushAll();
  const names = fs.readdirSync(dir);
  assert.ok(names.filter((n) => /r1\.\d{4}\.jsonl/.test(n)).length >= 3, `应有 ≥3 个封存段: ${names}`);
  // 弄坏清单 → 冷打开必须走全量异步扫描并顺路重建
  fs.writeFileSync(path.join(dir, "r1.index.json"), "broken");
  const s2 = openStore(dir, opts);
  const info0 = s2.info("r1");
  assert.equal(info0.indexing, true, "10MB 级待扫应走异步索引");
  await s2.whenIndexed("r1");
  const info = s2.info("r1");
  assert.equal(info.seq, N);
  assert.equal(s2.snapshot("r1", LIMITS).items.length, N);
  const rebuilt = JSON.parse(fs.readFileSync(path.join(dir, "r1.index.json"), "utf8"));
  assert.ok(rebuilt.segments.length >= 3 && rebuilt.segments.every((e) => e.state), "异步扫描后清单应重建完整");
});
