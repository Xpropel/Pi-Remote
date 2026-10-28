"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AccountIndex } = require("../relay/index.js");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-index-"));
}

function open() {
  return new AccountIndex(path.join(tmpDir(), "accounts"));
}

/** 整文件重写（压缩）从写路径挪到了本轮之后：断言文件体积/内容前先让出一轮事件循环。 */
const compactTick = () => new Promise((resolve) => setImmediate(resolve));

const sess = (id, extra = {}) => ({
  id,
  path: `C:/s/${id}.jsonl`,
  name: id,
  cwd: "D:\\work",
  firstMessage: "hi",
  messageCount: 1,
  sizeBytes: 10,
  createdAt: 1,
  updatedAt: 1,
  active: false,
  ...extra,
});

test("touchAccount 缺省 admin，重复触摸保留 firstSeenAt", () => {
  const idx = open();
  const a = idx.touchAccount(undefined, 10);
  assert.equal(a.id, "admin");
  assert.equal(a.firstSeenAt, 10);
  const b = idx.touchAccount("admin", 20);
  assert.equal(b.firstSeenAt, 10);
  assert.equal(b.lastSeenAt, 20);
  const rows = idx.listDevices("admin");
  assert.deepEqual(rows, []);
});

test("账户与设备 id 里的路径字符不会逃出索引目录", () => {
  const root = tmpDir();
  const dir = path.join(root, "accounts");
  const idx = new AccountIndex(dir);
  idx.touchAccount("..\\..\\outside", 1);
  idx.upsertDevice("..\\..\\outside", { id: "..\\..\\dev", name: "n", platform: "windows", projects: [], updatedAt: 1, lastAttachAt: 1 });
  assert.deepEqual(fs.readdirSync(root), ["accounts"]);
  const nested = fs.readdirSync(dir).filter((n) => n !== "index.jsonl");
  assert.equal(nested.length, 1);
  assert.equal(nested[0].includes(".."), false);
  assert.ok(idx.getDeviceRow("..\\..\\outside", "..\\..\\dev"));
});

test("设备 upsert：后写覆盖，updatedAt 更旧的行丢弃", () => {
  const idx = open();
  idx.upsertDevice("admin", { id: "d1", name: "A", platform: "windows", projects: ["D:\\a"], lastAttachAt: 5, updatedAt: 5 });
  idx.upsertDevice("admin", { id: "d1", name: "B", platform: "windows", projects: ["D:\\b"], lastAttachAt: 9, updatedAt: 9 });
  const stale = idx.upsertDevice("admin", { id: "d1", name: "OLD", platform: "windows", projects: [], lastAttachAt: 1, updatedAt: 1 });
  assert.equal(stale.stale, true);
  const row = idx.getDeviceRow("admin", "d1");
  assert.equal(row.name, "B");
  assert.deepEqual(row.projects, ["D:\\b"]);
  assert.equal(row.online, undefined);
  idx.upsertDevice("admin", { id: "d2", name: "C", platform: "windows", projects: [], lastAttachAt: 3, updatedAt: 3 });
  assert.deepEqual(idx.listDevices("admin").map((d) => d.id), ["d1", "d2"]);
});

test("upsertDevice：未来 updatedAt 夹到服务端当前时间，非法值回落 now", () => {
  const idx = open();
  const now = 1_800_000_000_000;
  const future = now + 10 * 365 * 86400_000;
  idx.upsertDevice("admin", { id: "d1", name: "A", platform: "macos", projects: [], lastAttachAt: future, updatedAt: future }, now);
  const row = idx.getDeviceRow("admin", "d1");
  assert.equal(row.updatedAt, now, "未来 updatedAt 不能写进设备行");
  assert.equal(row.lastAttachAt, now, "同文件其它时间字段早已夹取，口径要一致");

  // 未来时间被夹取后，紧随其后的真实登记（同一时刻或稍后）不能被判成 stale
  const real = idx.upsertDevice("admin", { id: "d1", name: "B", platform: "macos", projects: [], updatedAt: now + 1 }, now + 1);
  assert.equal(real.stale, false);
  assert.equal(real.row.name, "B");

  // 非数字/NaN 也不能把时间写成怪值：回落服务端 now
  idx.upsertDevice("admin", { id: "d2", name: "C", platform: "linux", projects: [], updatedAt: "nope" }, now + 2);
  assert.equal(idx.getDeviceRow("admin", "d2").updatedAt, now + 2);
  idx.upsertDevice("admin", { id: "d3", name: "D", platform: "linux", projects: [], updatedAt: Number.NaN }, now + 3);
  assert.equal(idx.getDeviceRow("admin", "d3").updatedAt, now + 3);
});

test("upsertDevice：pairedAt 一旦写入不可逆，后续不带该字段的登记不能清掉它", () => {
  const idx = open();
  idx.upsertDevice("admin", { id: "d1", name: "Mac", platform: "macos", pairedAt: 100, updatedAt: 100 });
  idx.upsertDevice("admin", { id: "d1", name: "Mac", platform: "macos", updatedAt: 200 });
  assert.equal(idx.getDeviceRow("admin", "d1").pairedAt, 100);
  idx.upsertDevice("admin", { id: "d1", name: "Mac", platform: "macos", pairedAt: 300, updatedAt: 300 });
  assert.equal(idx.getDeviceRow("admin", "d1").pairedAt, 300);
});

test("applyManifest：未来 updatedAt 被夹到现在，不会让索引永久卡死", () => {
  const idx = open();
  const now = 1_800_000_000_000;
  const future = now + 10 * 365 * 86400_000;
  const poisoned = idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: future,
    sessions: [sess("pwn", { updatedAt: future, active: true })],
  }, now);
  assert.equal(poisoned.ok, true);
  assert.equal(idx.getSession("admin", "d1", "pwn").updatedAt, now, "未来行时间要夹到服务端当前时间");

  // 真实帧紧随其后（同一时刻）：不能被未来帧判成 stale
  const real = idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: now,
    sessions: [sess("real", { updatedAt: now, active: true })],
  }, now);
  assert.equal(real.stale, false);
  assert.equal(idx.getSession("admin", "d1", "real").active, true);
  assert.equal(idx.getSession("admin", "d1", "pwn").active, false, "full 对账要能清掉不在帧里的活动位");
});

test("applyManifest：upsert、墓碑、帧级与行级 updatedAt、full 对账、截断不误伤", () => {
  const idx = open();
  const bad = idx.applyManifest("", "d1", { sessions: [] });
  assert.equal(bad.ok, false);
  assert.equal(idx.applyManifest("admin", "d1", { sessions: "nope" }).ok, false);

  const first = idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 100,
    sessions: [sess("a", { name: "A", updatedAt: 10, active: true }), sess("b", { name: "B", updatedAt: 20 })],
  });
  assert.equal(first.ok, true);
  let listed = idx.listSessions("admin", "d1", { limit: 10 });
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.sessions.map((s) => s.id), ["b", "a"]);
  assert.equal(listed.sessions.find((s) => s.id === "a").active, true);

  // 帧更新了，但这一行的 updatedAt 更旧：丢弃该行
  idx.applyManifest("admin", "d1", {
    full: false,
    updatedAt: 110,
    sessions: [sess("a", { name: "STALE", updatedAt: 5, active: false })],
  });
  assert.equal(idx.getSession("admin", "d1", "a").name, "A");

  // 同等 updatedAt 可以覆盖（不是更旧）
  idx.applyManifest("admin", "d1", {
    full: false,
    updatedAt: 120,
    sessions: [sess("a", { name: "A2", updatedAt: 10, active: true })],
  });
  assert.equal(idx.getSession("admin", "d1", "a").name, "A2");

  // 整帧 updatedAt 更旧：整帧丢弃，包括墓碑
  const stale = idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 50,
    sessions: [sess("a", { name: "NO", updatedAt: 999 })],
    removed: ["b"],
  });
  assert.equal(stale.stale, true);
  assert.equal(idx.getSession("admin", "d1", "a").name, "A2");
  assert.equal(idx.getSession("admin", "d1", "b").deleted, false);

  // full：帧里没有的活动会话 active 置假，行还在
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 200,
    sessions: [sess("b", { name: "B2", updatedAt: 30, active: true })],
  });
  const a = idx.getSession("admin", "d1", "a");
  assert.equal(a.deleted, false);
  assert.equal(a.active, false);
  assert.equal(a.name, "A2");
  assert.equal(a.updatedAt, 10, "对账不能把帧时间写成会话 updatedAt");
  assert.equal(idx.getSession("admin", "d1", "b").active, true);

  // 截断的 full 不把缺失行打成非活动
  idx.applyManifest("admin", "d1", {
    full: true,
    truncated: true,
    updatedAt: 210,
    sessions: [sess("b", { name: "B3", updatedAt: 40, active: true })],
  });
  // a 的 active 仍是 false（上一帧已清），再塞一个 active 的 c 不在截断帧里时不应被清
  idx.applyManifest("admin", "d1", {
    full: false,
    updatedAt: 220,
    sessions: [sess("c", { name: "C", updatedAt: 50, active: true })],
  });
  idx.applyManifest("admin", "d1", {
    full: true,
    truncated: true,
    updatedAt: 230,
    sessions: [sess("b", { name: "B4", updatedAt: 60 })],
  });
  assert.equal(idx.getSession("admin", "d1", "c").active, true, "截断帧不能把没带上的会话打成非活动");

  // 墓碑不出现在 list；更旧的 upsert 不能把墓碑翻回来；更新的 upsert 可以
  idx.applyManifest("admin", "d1", { full: false, updatedAt: 300, sessions: [], removed: ["b"] });
  assert.equal(idx.getSession("admin", "d1", "b").deleted, true);
  assert.equal(idx.listSessions("admin", "d1").sessions.some((s) => s.id === "b"), false);
  idx.applyManifest("admin", "d1", {
    full: false,
    updatedAt: 310,
    sessions: [sess("b", { name: "BACK-TOO-OLD", updatedAt: 10 })],
  });
  assert.equal(idx.getSession("admin", "d1", "b").deleted, true);
  idx.applyManifest("admin", "d1", {
    full: false,
    updatedAt: 320,
    sessions: [sess("b", { name: "BACK", updatedAt: 400, active: false })],
  });
  assert.equal(idx.getSession("admin", "d1", "b").deleted, false);
  assert.equal(idx.getSession("admin", "d1", "b").name, "BACK");

  const limited = idx.listSessions("admin", "d1", { limit: 1 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.sessions.length, 1);
  assert.equal(limited.sessions[0].id, "b");
});

test("full 对账清掉的活动位，同一 updatedAt 的后续全量可以写回，且不删行", () => {
  const idx = open();
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 100,
    sessions: [sess("a", { name: "A", updatedAt: 10, active: true }), sess("b", { name: "B", updatedAt: 20 })],
  });
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 200,
    sessions: [sess("b", { name: "B2", updatedAt: 30, active: true })],
  });
  const hidden = idx.getSession("admin", "d1", "a");
  assert.equal(hidden.deleted, false);
  assert.equal(hidden.active, false);
  assert.equal(hidden.updatedAt, 10);
  assert.ok(idx.listSessions("admin", "d1").sessions.some((s) => s.id === "a"));

  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 300,
    sessions: [
      sess("a", { name: "A2", updatedAt: 10, active: true }),
      sess("b", { name: "B2", updatedAt: 30, active: true }),
    ],
  });
  const back = idx.getSession("admin", "d1", "a");
  assert.equal(back.name, "A2");
  assert.equal(back.active, true);
  assert.equal(back.deleted, false);
  assert.equal(back.updatedAt, 10);
  assert.equal(idx.getSession("admin", "d1", "b").deleted, false);
});

test("设备登记过但没有清单文件时 listSessions 为空", () => {
  const idx = open();
  idx.upsertDevice("admin", { id: "d1", name: "A", platform: "windows", projects: [], updatedAt: 1, lastAttachAt: 1 });
  assert.equal(idx.getDeviceRow("admin", "missing"), null);
  const listed = idx.listSessions("admin", "d1");
  assert.deepEqual(listed.sessions, []);
  assert.equal(listed.truncated, false);
});

test("safeKey 换格式后自动迁移旧文件：历史账号/设备/会话不丢", () => {
  const dir = path.join(tmpDir(), "accounts");
  fs.mkdirSync(dir, { recursive: true });
  // 旧版落盘名：只清洗、截断 64，没有 hash 后缀
  const legacyAccountDir = path.join(dir, "admin");
  fs.mkdirSync(path.join(legacyAccountDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.jsonl"), JSON.stringify({ kind: "account", id: "admin", firstSeenAt: 1, lastSeenAt: 2 }) + "\n", "utf8");
  fs.writeFileSync(path.join(legacyAccountDir, "devices.jsonl"), JSON.stringify({ kind: "device", id: "dev-1", name: "PC", platform: "windows", projects: [], lastAttachAt: 5, updatedAt: 5 }) + "\n", "utf8");
  fs.writeFileSync(path.join(legacyAccountDir, "sessions", "dev-1.jsonl"), JSON.stringify({ kind: "session", id: "s1", path: "C:/s1.jsonl", updatedAt: 9 }) + "\n", "utf8");

  const { AccountIndex, safeKey } = require("../relay/index.js");
  const idx = new AccountIndex(dir);
  const newAccountDir = path.join(dir, safeKey("admin"));
  assert.ok(fs.existsSync(newAccountDir), "账号目录应迁到 safeKey 新名字");
  assert.ok(!fs.existsSync(legacyAccountDir), "旧名字不应残留");
  assert.ok(fs.existsSync(path.join(newAccountDir, "sessions", safeKey("dev-1") + ".jsonl")), "会话文件应跟着迁");
  assert.equal(idx.getDeviceRow("admin", "dev-1").name, "PC");
  assert.equal(idx.getSession("admin", "dev-1", "s1").id, "s1");
});

test("新旧账号目录同时存在：旧目录按 updatedAt 合并进新目录、旧目录改名留档，不再被跳过", () => {
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.jsonl"), JSON.stringify({ kind: "account", id: "admin", firstSeenAt: 1, lastSeenAt: 2 }) + "\n", "utf8");
  const newDir = path.join(dir, safeKey("admin"));
  const legacyDir = path.join(dir, "admin");
  // 新目录：dev-1 旧名字、s1 旧版本
  fs.mkdirSync(path.join(newDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(newDir, "devices.jsonl"), JSON.stringify({ kind: "device", id: "dev-1", name: "旧名", updatedAt: 5 }) + "\n", "utf8");
  fs.writeFileSync(path.join(newDir, "sessions", safeKey("dev-1") + ".jsonl"), JSON.stringify({ kind: "session", id: "s1", path: "C:/s1.jsonl", name: "新目录里的", updatedAt: 20 }) + "\n", "utf8");
  // 旧目录（回滚到旧版期间写的）：dev-1 改名更新、新设备 dev-2；s1 更旧（不覆盖）、新会话 s2
  fs.mkdirSync(path.join(legacyDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "devices.jsonl"),
    [
      JSON.stringify({ kind: "device", id: "dev-1", name: "新名", updatedAt: 9 }),
      JSON.stringify({ kind: "device", id: "dev-2", name: "笔记本", updatedAt: 9 }),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(legacyDir, "sessions", "dev-1.jsonl"),
    [
      JSON.stringify({ kind: "session", id: "s1", path: "C:/s1.jsonl", name: "旧目录里的", updatedAt: 10 }),
      JSON.stringify({ kind: "session", id: "s2", path: "C:/s2.jsonl", updatedAt: 11 }),
    ].join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(path.join(legacyDir, "sessions", "dev-2.jsonl"), JSON.stringify({ kind: "session", id: "s3", path: "C:/s3.jsonl", updatedAt: 12 }) + "\n", "utf8");

  const idx = new AccountIndex(dir);
  assert.equal(fs.existsSync(legacyDir), false, "旧目录不能留在原名（否则下次还会被当成待迁移）");
  const archived = fs.readdirSync(dir).filter((n) => n.startsWith("admin.migrated-"));
  assert.equal(archived.length, 1, "旧目录改名留档，不删除");
  assert.equal(idx.getDeviceRow("admin", "dev-1").name, "新名", "旧目录里更新的设备行要合并进来");
  assert.equal(idx.getDeviceRow("admin", "dev-2").name, "笔记本");
  assert.equal(idx.getSession("admin", "dev-1", "s1").name, "新目录里的", "更旧的行不能覆盖新目录");
  assert.equal(idx.getSession("admin", "dev-1", "s2").id, "s2", "旧目录里新增的会话要合并进来");
  assert.equal(idx.getSession("admin", "dev-2", "s3").id, "s3", "新目录没有的会话文件整份搬过来");
  // 再开一次不会重复合并
  const again = new AccountIndex(dir);
  assert.equal(again.getDeviceRow("admin", "dev-1").name, "新名");
});

test("findDevice：按 deviceId 反查它在哪个账号下", () => {
  const idx = open();
  idx.touchAccount("admin", 1);
  idx.upsertDevice("admin", { id: "dev-9", name: "PC", platform: "windows", updatedAt: 5 });
  const hit = idx.findDevice("dev-9");
  assert.equal(hit.accountId, "admin");
  assert.equal(hit.row.name, "PC");
  assert.equal(idx.findDevice("nope"), null);
});

test("墓碑随压缩丢弃：超过 7 天的删除记录不占体积", async () => {
  const dir = path.join(tmpDir(), "accounts");
  fs.mkdirSync(dir, { recursive: true });
  const { AccountIndex } = require("../relay/index.js");
  const idx = new AccountIndex(dir);
  idx.applyManifest("admin", "dev-1", { full: true, updatedAt: 100, sessions: [] }, 100);
  idx.applyManifest("admin", "dev-1", { full: false, updatedAt: 200, sessions: [], removed: ["gone"] }, 200);
  const file = path.join(dir, require("../relay/index.js").safeKey("admin"), "sessions", require("../relay/index.js").safeKey("dev-1") + ".jsonl");
  // 直接写一个超旧的墓碑 + 一个大 padding 行，迫使压缩触发
  const old = Date.now() - 30 * 24 * 3600 * 1000;
  fs.appendFileSync(file, JSON.stringify({ kind: "session", id: "ancient", deleted: true, updatedAt: old }) + "\n", "utf8");
  fs.appendFileSync(file, "x".repeat(300 * 1024) + "\n", "utf8");
  idx.applyManifest("admin", "dev-1", { full: false, updatedAt: 300, sessions: [] }, 300);
  await compactTick();
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes("ancient"), "30 天前的墓碑应被压缩丢掉");
  assert.ok(fs.statSync(file).size < 300 * 1024, "压缩后体积应降下来");
});

test("账号目录存在但 index.jsonl 里没有 account 行：构造阶段不猜，首次访问时懒迁移", () => {
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  fs.mkdirSync(dir, { recursive: true });
  // 旧版 upsertDevice/applyManifest 直接建账号目录，不写 account 行 → 索引里根本没有这个账号
  fs.writeFileSync(path.join(dir, "index.jsonl"), "", "utf8");
  const legacyDir = path.join(dir, "admin");
  fs.mkdirSync(path.join(legacyDir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "devices.jsonl"), JSON.stringify({ kind: "device", id: "dev-1", name: "PC", platform: "windows", projects: [], lastAttachAt: 5, updatedAt: 5 }) + "\n", "utf8");
  fs.writeFileSync(path.join(legacyDir, "sessions", "dev-1.jsonl"), JSON.stringify({ kind: "session", id: "s1", path: "C:/s1.jsonl", updatedAt: 9 }) + "\n", "utf8");

  const idx = new AccountIndex(dir);
  const newDir = path.join(dir, safeKey("admin"));
  assert.equal(fs.existsSync(newDir), false, "没有 account 行时构造阶段不知道有这个账号，不能凭猜迁移");
  assert.equal(fs.existsSync(legacyDir), true);

  // 读一次就够：getDeviceRow → _devicesFile → _accountDir 触发懒迁移
  assert.equal(idx.getDeviceRow("admin", "dev-1").name, "PC");
  // 新目录本来不存在：直接整份改名（不是合并），所以没有 .migrated- 留档目录
  assert.equal(fs.existsSync(legacyDir), false, "旧目录不应留在原名");
  assert.equal(fs.existsSync(path.join(newDir, "devices.jsonl")), true, "名册跟着搬到新目录");
  assert.equal(idx.getSession("admin", "dev-1", "s1").id, "s1");
  // 迁移后写路径也指向新目录：再 upsert 不会把旧目录重新建出来
  idx.upsertDevice("admin", { id: "dev-2", name: "第二台", platform: "windows", projects: [], updatedAt: 7 });
  assert.ok(fs.existsSync(newDir), "新目录应在");
  assert.equal(idx.getDeviceRow("admin", "dev-2").name, "第二台");
});

test("findDevice：某个账号名册读不了时，反查继续找别的账号而不是整体失败", () => {
  const dir = path.join(tmpDir(), "accounts");
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const idx = new AccountIndex(dir);
  idx.touchAccount("broken", 1);
  idx.upsertDevice("broken", { id: "dev-x", name: "坏账号", platform: "windows", updatedAt: 5 });
  idx.touchAccount("good", 1);
  idx.upsertDevice("good", { id: "dev-9", name: "PC", platform: "windows", updatedAt: 5 });
  // 把坏账号的 devices.jsonl 换成目录：读它会抛 EISDIR。名册读过一次就缓存在内存，所以换一个新实例才会真去读
  const brokenFile = path.join(dir, safeKey("broken"), "devices.jsonl");
  fs.rmSync(brokenFile);
  fs.mkdirSync(brokenFile);
  const fresh = new AccountIndex(dir);
  const hit = fresh.findDevice("dev-9");
  assert.equal(hit.accountId, "good");
  assert.equal(hit.row.name, "PC");
  assert.equal(fresh.findDevice("dev-x"), null, "读不了的账号里的设备也查不到，但不能因此抛异常");
});

test("名册/清单缓存：读过一次后查询不再读盘；写穿透，新实例从文件读到同样结果", () => {
  const { AccountIndex } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  idx.touchAccount("admin", 1);
  idx.upsertDevice("admin", { id: "d1", name: "PC", platform: "windows", updatedAt: 1 });
  idx.applyManifest("admin", "d1", { full: true, updatedAt: 2, sessions: [sess("s1")] }, 2);
  const reads = [];
  const orig = fs.readFileSync;
  fs.readFileSync = function (file, ...rest) {
    reads.push(String(file));
    return orig.call(this, file, ...rest);
  };
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(idx.listDevices("admin").length, 1);
      assert.equal(idx.findDevice("d1").accountId, "admin");
      assert.equal(idx.listSessions("admin", "d1").sessions.length, 1);
      assert.equal(idx.getSession("admin", "d1", "s1").id, "s1");
    }
    idx.upsertDevice("admin", { id: "d1", name: "PC-2", platform: "windows", updatedAt: 3 });
    idx.applyManifest("admin", "d1", { full: false, updatedAt: 4, sessions: [], removed: ["s1"] }, 4);
    assert.equal(idx.getDeviceRow("admin", "d1").name, "PC-2");
    assert.equal(idx.listSessions("admin", "d1").sessions.length, 0);
  } finally {
    fs.readFileSync = orig;
  }
  assert.deepEqual(reads, [], "缓存命中时不读盘");
  const fresh = new AccountIndex(dir);
  assert.equal(fresh.getDeviceRow("admin", "d1").name, "PC-2", "写穿透：新实例从文件读到同样的结果");
  assert.equal(fresh.listSessions("admin", "d1").sessions.length, 0);
  assert.equal(fresh.getSession("admin", "d1", "s1").deleted, true);
});

test("设备令牌：重新签发作废同一设备的旧令牌，撤销后不再算已配对，重开索引结果一致，文件只给属主读写", () => {
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  idx.issueDeviceToken("admin", "d1", "h1", 1);
  idx.issueDeviceToken("admin", "d2", "h2", 2);
  assert.equal(idx.hasDeviceToken("admin", "d1"), true);
  assert.deepEqual(idx.issueDeviceToken("admin", "d1", "h3", 3), { revoked: 1 });
  const rows = new Map(idx.deviceTokens("admin").map((r) => [r.hash, r]));
  assert.equal(rows.get("h1").revokedAt, 3);
  assert.equal(rows.get("h3").revokedAt, undefined);
  assert.equal(idx.revokeDeviceTokens("admin", "d1", 4), 1);
  assert.equal(idx.hasDeviceToken("admin", "d1"), false);
  assert.equal(idx.hasDeviceToken("admin", "d2"), true, "撤销只影响这一台");

  const reopened = new AccountIndex(dir);
  assert.equal(reopened.hasDeviceToken("admin", "d1"), false);
  assert.equal(reopened.hasDeviceToken("admin", "d2"), true);
  assert.equal(reopened.deviceTokens("admin").length, 3);
  if (process.platform !== "win32") {
    const mode = fs.statSync(path.join(dir, safeKey("admin"), "device-tokens.jsonl")).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("readMap 按 updatedAt 取新：旧行排在新行之后也不能覆盖", () => {
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  const file = path.join(dir, safeKey("admin"), "devices.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const base = { kind: "device", id: "d1", platform: "windows", projects: [] };
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ ...base, name: "NEW", lastAttachAt: 20, updatedAt: 20 }),
      JSON.stringify({ ...base, name: "OLD", lastAttachAt: 10, updatedAt: 10 }),
    ].join("\n") + "\n",
    "utf8",
  );
  assert.equal(idx.getDeviceRow("admin", "d1").name, "NEW", "后行更旧时不能让后行覆盖把新行吃掉");

  // 时间相同（以及没有 updatedAt 的账户行）仍按追加顺序：后行胜
  fs.appendFileSync(file, JSON.stringify({ ...base, name: "EQ", lastAttachAt: 20, updatedAt: 20 }) + "\n", "utf8");
  assert.equal(new AccountIndex(dir).getDeviceRow("admin", "d1").name, "EQ");
});

test("懒迁移合并走缓存写路径：压缩不会用旧 fileCache 抹掉刚合并的历史", async () => {
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.jsonl"), "", "utf8");
  const newDir = path.join(dir, safeKey("admin"));
  fs.mkdirSync(newDir, { recursive: true });
  const newDevices = path.join(newDir, "devices.jsonl");
  // 新目录自身带一个超过压缩阈值的文件：600 条同 id 历史，合并结果只有一行
  const targetRows = [];
  for (let i = 0; i < 600; i++) {
    targetRows.push(JSON.stringify({ kind: "device", id: "d-pad", name: `pad-${i}-${"y".repeat(600)}`, platform: "windows", projects: [], lastAttachAt: 10 + i, updatedAt: 10 + i }));
  }
  targetRows.push(JSON.stringify({ kind: "device", id: "d-new", name: "target", platform: "windows", projects: [], lastAttachAt: 20, updatedAt: 20 }));
  fs.writeFileSync(newDevices, targetRows.join("\n") + "\n", "utf8");
  assert.ok(fs.statSync(newDevices).size > 256 * 1024);

  const idx = new AccountIndex(dir);
  assert.equal(idx.getDeviceRow("admin", "d-pad").name.startsWith("pad-599-"), true);
  assert.equal(idx.getDeviceRow("admin", "d-new").name, "target", "预热目标文件的 fileCache");

  // 旧目录：一个只有旧目录才有的设备 + 更新的 d-new
  const legacyDir = path.join(dir, "admin");
  fs.mkdirSync(path.join(legacyDir, "sessions"), { recursive: true });
  fs.writeFileSync(
    path.join(legacyDir, "devices.jsonl"),
    [
      JSON.stringify({ kind: "device", id: "d-old", name: "legacy-only", platform: "windows", projects: [], lastAttachAt: 30, updatedAt: 30 }),
      JSON.stringify({ kind: "device", id: "d-new", name: "legacy-newer", platform: "windows", projects: [], lastAttachAt: 31, updatedAt: 31 }),
    ].join("\n") + "\n",
    "utf8",
  );

  // 与构造函数/懒迁移相同的合并入口（目标目录已存在 → 按 updatedAt 合并）
  idx._migrateAccountDir("admin", Date.now());
  await compactTick();

  assert.equal(idx.getDeviceRow("admin", "d-old").name, "legacy-only", "合并后缓存里必须有旧目录的设备");
  assert.equal(idx.getDeviceRow("admin", "d-new").name, "legacy-newer", "旧目录更新行要覆盖新目录旧行");
  assert.ok(fs.statSync(newDevices).size < 64 * 1024, "合并后应触发压缩，600 条重复历史收成一行");

  // 再写一次会经过 _append → compactIfLarge；如果缓存还是合并前的旧表，这里会整份重写并抹掉 d-old
  idx.upsertDevice("admin", { id: "d-new", name: "final", platform: "windows", projects: [], lastAttachAt: 40, updatedAt: 40 }, 40);
  await compactTick();
  const fresh = new AccountIndex(dir);
  assert.equal(fresh.getDeviceRow("admin", "d-old").name, "legacy-only", "压缩不能抹掉刚合并进来的历史");
  assert.equal(fresh.getDeviceRow("admin", "d-new").name, "final");
});

test("upsertDevice：客户端未来 lastAttachAt 夹到服务端 now，不能永久置顶", () => {
  const idx = open();
  const now = 1_800_000_000_000;
  idx.upsertDevice("admin", { id: "future", name: "F", platform: "macos", lastAttachAt: now + 10 * 365 * 86400_000, updatedAt: now }, now);
  assert.equal(idx.getDeviceRow("admin", "future").lastAttachAt, now, "未来时间要夹到服务端当前时间");
  idx.upsertDevice("admin", { id: "real", name: "R", platform: "macos", lastAttachAt: now + 10, updatedAt: now + 10 }, now + 10);
  assert.equal(idx.getDeviceRow("admin", "real").lastAttachAt, now + 10);
  assert.deepEqual(idx.listDevices("admin").map((d) => d.id), ["real", "future"], "一次真实的后续连接就能排到被夹取的未来时间之前");

  // 更新时没带 lastAttachAt：沿用旧值，且不会把旧值抬到未来
  idx.upsertDevice("admin", { id: "future", name: "F2", platform: "macos", updatedAt: now + 20 }, now + 20);
  assert.equal(idx.getDeviceRow("admin", "future").lastAttachAt, now);
});

test("device-tokens.jsonl 超大时安全压缩：保留有效令牌与近期撤销记录，旧撤销行可丢", async () => {
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  const now = Date.now();
  idx.issueDeviceToken("admin", "d1", "validhash", now - 3 * 86400_000);
  idx.issueDeviceToken("admin", "d2", "recentrevoked", now - 2 * 86400_000);
  idx.revokeDeviceTokens("admin", "d2", now - 86400_000);
  idx.issueDeviceToken("admin", "d3", "oldrevoked", now - 90 * 86400_000);
  idx.revokeDeviceTokens("admin", "d3", now - 60 * 86400_000);

  const file = path.join(dir, safeKey("admin"), "device-tokens.jsonl");
  const before = fs.statSync(file).size;
  assert.ok(before > 0);
  // 模拟历史遗留的垃圾/重复行把文件撑大（解析时会跳过这些行）
  fs.appendFileSync(file, ("x".repeat(1024) + "\n").repeat(300), "utf8");
  assert.ok(fs.statSync(file).size > 300 * 1024);

  idx.issueDeviceToken("admin", "d4", "newhash", now);
  await compactTick();

  assert.ok(fs.statSync(file).size < 64 * 1024, "压缩后文件应显著变小");
  assert.equal(fs.readFileSync(file, "utf8").includes("x".repeat(1024)), false, "垃圾行应被清掉");
  assert.equal(idx.hasDeviceToken("admin", "d1"), true, "有效令牌必须保留");
  assert.equal(idx.hasDeviceToken("admin", "d4"), true);
  assert.equal(idx.hasDeviceToken("admin", "d2"), false, "近期撤销仍不可用");
  assert.equal(idx.deviceTokens("admin").find((r) => r.hash === "recentrevoked").revokedAt, now - 86400_000, "近期撤销记录保留");
  assert.equal(idx.deviceTokens("admin").some((r) => r.hash === "oldrevoked"), false, "超过保留窗口的撤销行可丢");

  const reopened = new AccountIndex(dir);
  assert.equal(reopened.hasDeviceToken("admin", "d1"), true, "重开后有效令牌仍能用（不破坏已验证令牌）");
  assert.equal(reopened.hasDeviceToken("admin", "d2"), false);
  assert.equal(reopened.hasDeviceToken("admin", "d4"), true);
  assert.equal(reopened.deviceTokens("admin").some((r) => r.hash === "oldrevoked"), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "压缩重写不能放宽权限");
  }
});

test("设备令牌写/撤销在追加后 fsync：断电不会让刚撤销的令牌复活", () => {
  const { AccountIndex, safeKey } = require("../relay/index.js");
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  idx.issueDeviceToken("admin", "d1", "h1", 1);
  const file = path.join(dir, safeKey("admin"), "device-tokens.jsonl");
  const orig = fs.fsyncSync;
  const seen = [];
  fs.fsyncSync = function (fd) {
    seen.push(fs.readFileSync(file, "utf8").includes('"revokedAt"'));
    return orig.call(fs, fd);
  };
  try {
    idx.revokeDeviceTokens("admin", "d1", 2);
  } finally {
    fs.fsyncSync = orig;
  }
  assert.deepEqual(seen, [true], "fsync 必须发生在撤销行追加之后");
  assert.equal(idx.hasDeviceToken("admin", "d1"), false);
});

test("房间会话清理统一清 usage：room_closed/实例更替后新订阅者看不到上一会话用量", () => {
  const { clearSessionState } = require("../relay/rooms.js");
  const room = {
    id: "r1",
    usage: { contextUsage: { tokens: 123, contextWindow: 200000, percent: 0.1 } },
    queue: { steering: [] },
    compaction: { type: "compaction_start" },
    runningTools: [{ toolCallId: "t1" }],
    autoRetry: { attempt: 1 },
    uiPrompt: { title: "x" },
    assistantDraft: { blocks: [] },
  };
  clearSessionState(room);
  for (const key of ["usage", "queue", "compaction", "runningTools", "autoRetry", "uiPrompt", "assistantDraft"]) {
    assert.equal(room[key], null, `${key} 必须清掉`);
  }
  assert.equal(room.id, "r1", "房间身份字段不能动");
  assert.doesNotThrow(() => clearSessionState(null));
});

test("进行中助手草稿 text/thinking 有字节上限（与工具参数一致），超长 delta/end 都截断", () => {
  const { rememberAssistantStart, rememberAssistantDelta } = require("../relay/local.js");
  const cfg = { maxPayloadBytes: 1024 };
  const room = {};
  rememberAssistantStart(room, { message: { role: "assistant", timestamp: 7 } });
  for (let i = 0; i < 20; i++) {
    rememberAssistantDelta(room, { assistantMessageEvent: { type: "text_delta", delta: "x".repeat(100), contentIndex: 0 } }, cfg);
  }
  assert.ok(Buffer.byteLength(room.assistantDraft.blocks[0].text) <= 1024, "text 累计不能突破上限");
  rememberAssistantDelta(room, { assistantMessageEvent: { type: "thinking_delta", delta: "y".repeat(5000), contentIndex: 1 } }, cfg);
  assert.ok(Buffer.byteLength(room.assistantDraft.blocks[1].thinking) <= 1024, "单次超长 thinking delta 也要截断");
  rememberAssistantDelta(room, { assistantMessageEvent: { type: "text_end", content: "z".repeat(5000), contentIndex: 0 } }, cfg);
  assert.ok(Buffer.byteLength(room.assistantDraft.blocks[0].text) <= 1024, "text_end 全量内容也要截断");
  assert.equal(room.assistantDraft.timestamp, 7);
});

/* ---------------- P9 B：forgetSession / applyManifest deviceScope / tombstoned（spec §4.9） ---------------- */

test("forgetSession：旧行换成最小墓碑（不留名/首条/路径/目录），listSessions 看不到，幂等", () => {
  const idx = open();
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 100,
    sessions: [
      sess("keep", { updatedAt: 10, active: true }),
      sess("gone", { updatedAt: 20, active: true, name: "要删的", path: "C:/s/gone.jsonl", cwd: "C:/proj", firstMessage: "秘密" }),
    ],
  });
  assert.deepEqual(idx.listSessions("admin", "d1").sessions.map((s) => s.id).sort(), ["gone", "keep"]);

  assert.equal(idx.forgetSession("admin", "d1", "gone", 300), true);
  // 旧行整份从文件里消失：会话名/路径/首条消息一个字都不能留
  const raw = fs.readFileSync(idx._sessionsFile("admin", "d1"), "utf8");
  assert.equal(raw.includes("要删的"), false, "会话名不能留在文件里");
  assert.equal(raw.includes("C:/s/gone.jsonl"), false, "路径不能留在文件里");
  assert.equal(raw.includes("秘密"), false, "首条消息不能留在文件里");
  assert.deepEqual(idx.getSession("admin", "d1", "gone"), { kind: "session", id: "gone", deleted: true, updatedAt: 300 }, "只留最小墓碑");
  assert.equal(idx.getSession("admin", "d1", "keep").name, "keep", "别的行原样保留");
  assert.deepEqual(idx.listSessions("admin", "d1").sessions.map((s) => s.id), ["keep"], "墓碑不出现在清单里");

  // 幂等：重复调用不把墓碑时间改得更旧，也不再改写文件
  const before = fs.readFileSync(idx._sessionsFile("admin", "d1"), "utf8");
  assert.equal(idx.forgetSession("admin", "d1", "gone", 200), true);
  assert.equal(idx.getSession("admin", "d1", "gone").updatedAt, 300);
  assert.equal(fs.readFileSync(idx._sessionsFile("admin", "d1"), "utf8"), before);
  // 参数不完整时不动文件
  assert.equal(idx.forgetSession("admin", "d1", "", 400), false);
});

test("applyManifest deviceScope：只给 root 下缺失的行打墓碑，root 外只能清活动位；tombstoned 返回正确", () => {
  const idx = open();
  const now = 1_800_000_000_000;
  const ROOT = "/Users/me/.pi/sessions";
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 100,
    sessions: [
      sess("in1", { updatedAt: 10, active: true, path: ROOT + "/--a--/1_in1.jsonl", cwd: "/Users/me/proj" }),
      sess("in2", { updatedAt: 11, active: true, path: ROOT + "/--b--/2_in2.jsonl", cwd: "/Users/me/b" }),
      sess("out", { updatedAt: 12, active: true, path: "/tmp/other-sessions/--x--/3_out.jsonl", cwd: "/tmp/other" }),
    ],
  }, now);

  const res = idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 200,
    sessions: [sess("in1", { updatedAt: 10, active: true, path: ROOT + "/--a--/1_in1.jsonl", cwd: "/Users/me/proj" })],
  }, now, { root: ROOT, platform: "macos" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.tombstoned, ["in2"], "只有 root 下缺失的会话打墓碑");
  const in2 = idx.getSession("admin", "d1", "in2");
  assert.equal(in2.deleted, true, "设备上删掉的会话反向同步成墓碑");
  assert.equal(in2.path, undefined, "墓碑不留路径");
  const out = idx.getSession("admin", "d1", "out");
  assert.equal(out.deleted, false, "root 以外的会话不能被误删");
  assert.equal(out.active, false, "root 以外照旧只清活动位");
  assert.equal(idx.getSession("admin", "d1", "in1").active, true);
  assert.deepEqual(idx.listSessions("admin", "d1").sessions.map((s) => s.id).sort(), ["in1", "out"]);

  // 截断的全量帧不做 deviceScope 对账（拿不全，不能推"缺失 = 已删"）
  const res2 = idx.applyManifest("admin", "d1", {
    full: true, truncated: true, updatedAt: 300, sessions: [],
  }, now, { root: ROOT, platform: "macos" });
  assert.deepEqual(res2.tombstoned, []);
  assert.equal(idx.getSession("admin", "d1", "in1").deleted, false);

  // 没有 deviceScope 的普通全量（扩展/旧 attach）：行为照旧，不因缺失打墓碑
  const res3 = idx.applyManifest("admin", "d1", {
    full: true, updatedAt: 400, sessions: [],
  }, now);
  assert.deepEqual(res3.tombstoned, []);
  assert.equal(idx.getSession("admin", "d1", "in1").deleted, false);
});

test("applyManifest deviceScope：设备上重新出现的会话从墓碑恢复（updatedAt 压过墓碑时间）", () => {
  const idx = open();
  const now = Date.now();
  const ROOT = "/Users/me/.pi/sessions";
  const row = () => sess("s1", { updatedAt: 10, active: true, path: ROOT + "/--a--/1_s1.jsonl", cwd: "/Users/me/p", name: "S" });
  idx.applyManifest("admin", "d1", { full: true, updatedAt: now - 1000, sessions: [row()] }, now);

  const del = idx.applyManifest("admin", "d1", { full: true, updatedAt: now - 500, sessions: [] }, now, { root: ROOT, platform: "macos" });
  assert.deepEqual(del.tombstoned, ["s1"]);
  assert.equal(idx.getSession("admin", "d1", "s1").deleted, true);

  // 用户从废纸篓把文件拿回来：设备全量里重新出现（行 updatedAt 仍是旧的，不能因此丢掉）
  const back = idx.applyManifest("admin", "d1", { full: true, updatedAt: now - 400, sessions: [row()] }, now, { root: ROOT, platform: "macos" });
  assert.equal(back.ok, true);
  const restored = idx.getSession("admin", "d1", "s1");
  assert.equal(restored.deleted, false, "墓碑被恢复");
  assert.equal(restored.name, "S");
  assert.equal(restored.updatedAt, now - 500 + 1, "恢复行的时间压过墓碑 +1");
  assert.deepEqual(idx.listSessions("admin", "d1").sessions.map((s) => s.id), ["s1"]);
});

test("BUG-2 + R3-1（第 2/3 轮审查）：兜底行只带 id+path+updatedAt，对账不清空字段、时间不跳成帧时间", () => {
  const idx = open();
  const now = 2_000_000_000_000;
  const ROOT = "/Users/me/.pi/sessions";
  const file = ROOT + "/--a--/1_s1.jsonl";
  const MTIME = 5000;
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 100,
    sessions: [sess("s1", { updatedAt: MTIME, active: true, path: file, cwd: "/Users/me/proj", name: "我的会话", firstMessage: "第一条", messageCount: 7, sizeBytes: 1234, createdAt: 5 })],
  }, now);
  // attach 的兜底行（正文暂时读不出）：id + path + 文件真实 mtime；其它字段缺省（undefined）。
  // 帧时间故意比 mtime 新（7000）：relay 不能用帧时间把 updatedAt 顶成 7000（否则列表显示「刚刚」）。
  const res = idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: 7000,
    sessions: [{ id: "s1", path: file, updatedAt: MTIME }],
  }, now, { root: ROOT, platform: "macos" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.tombstoned, [], "还在磁盘上，不能打墓碑");
  const row = idx.getSession("admin", "d1", "s1");
  assert.equal(row.deleted, false);
  assert.equal(row.updatedAt, MTIME, "时间保持文件 mtime，不跳成帧时间");
  assert.equal(row.name, "我的会话", "name 沿用旧值");
  assert.equal(row.cwd, "/Users/me/proj", "cwd 沿用旧值");
  assert.equal(row.firstMessage, "第一条");
  assert.equal(row.messageCount, 7, "messageCount 沿用旧值");
  assert.equal(row.sizeBytes, 1234);
  assert.equal(row.createdAt, 5);
});

test("applyManifest tombstoned：removed 里新打墓碑的 id 才返回（已墓碑的不重复）", () => {
  const idx = open();
  const now = Date.now();
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: now - 1000,
    sessions: [sess("r1", { updatedAt: now - 1000, active: true }), sess("r2", { updatedAt: now - 1000, active: true })],
  }, now);
  const res = idx.applyManifest("admin", "d1", { full: false, updatedAt: now - 500, sessions: [], removed: ["r1", "r2", "nope"] }, now);
  assert.deepEqual(res.tombstoned.sort(), ["nope", "r1", "r2"], "removed 里的 id 全部记入本帧墓碑");
  for (const id of ["r1", "r2", "nope"]) assert.equal(idx.getSession("admin", "d1", id).deleted, true);
  const again = idx.applyManifest("admin", "d1", { full: false, updatedAt: now - 400, sessions: [], removed: ["r1"] }, now);
  assert.deepEqual(again.tombstoned, [], "已经是墓碑的不再重复返回（幂等清理）");
});

/* ---------------- P9 第 1 轮审查 P2-3：removed 直接写最小墓碑 / forgetSession 形状判断 ---------------- */

test("applyManifest removed 直接写最小墓碑，不沿用旧行的 name/firstMessage/path/cwd", () => {
  const idx = open();
  const now = Date.now();
  idx.applyManifest("admin", "d1", {
    full: true,
    updatedAt: now - 1000,
    sessions: [sess("s1", { updatedAt: now - 1000, name: "秘密名", path: "C:/x/s1.jsonl", cwd: "C:/proj", firstMessage: "首条秘密", active: true })],
  }, now);
  const res = idx.applyManifest("admin", "d1", { full: false, updatedAt: now - 500, sessions: [], removed: ["s1"] }, now);
  assert.deepEqual(res.tombstoned, ["s1"]);
  assert.deepEqual(idx.getSession("admin", "d1", "s1"), { kind: "session", id: "s1", deleted: true, updatedAt: now - 500 }, "removed 分支直接写最小墓碑");
  // 追加式 jsonl 里旧行本来就会留到压缩；这里核对"墓碑这一行"本身不带旧字段
  const lines = fs.readFileSync(idx._sessionsFile("admin", "d1"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const last = lines[lines.length - 1];
  assert.deepEqual(last, { kind: "session", id: "s1", deleted: true, updatedAt: now - 500 }, "落盘的墓碑行是最小形状");
  for (const key of ["name", "firstMessage", "path", "cwd"]) assert.equal(key in last, false, "墓碑行不能有 " + key);
  assert.deepEqual(idx.listSessions("admin", "d1").sessions, [], "墓碑不进清单");
});

test("forgetSession：已有墓碑不是最小形状时，同一毫秒也要改写成最小墓碑（P2-3）", () => {
  const idx = open();
  const file = idx._sessionsFile("admin", "d1");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 模拟 P9 修复前 removed 写出的"带旧行字段的墓碑"（同一毫秒里 purge 会调 forgetSession）
  const legacyTombstone = { kind: "session", id: "s1", deleted: true, updatedAt: 500, name: "秘密名", path: "C:/x/s1.jsonl", cwd: "C:/proj", firstMessage: "首条秘密" };
  fs.writeFileSync(file, JSON.stringify(legacyTombstone) + "\n");

  // 时间相同：旧逻辑会提前返回，把带会话名的墓碑留在盘上；现在必须重写
  assert.equal(idx.forgetSession("admin", "d1", "s1", 500), true);
  assert.deepEqual(idx.getSession("admin", "d1", "s1"), { kind: "session", id: "s1", deleted: true, updatedAt: 500 });
  assert.equal(fs.readFileSync(file, "utf8").includes("秘密名"), false, "旧形状墓碑必须被改写成最小形状");
  assert.equal(fs.readFileSync(file, "utf8").includes("C:/x/s1.jsonl"), false);

  // 已经是最小形状且不更旧：幂等、不重写文件
  const before = fs.readFileSync(file, "utf8");
  assert.equal(idx.forgetSession("admin", "d1", "s1", 400), true);
  assert.equal(fs.readFileSync(file, "utf8"), before, "最小墓碑 + 更旧时间不再改写");
});
