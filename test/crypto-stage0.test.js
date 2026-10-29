"use strict";
/**
 * 加密地基阶段 0（设计 A §8）：只铺地基、零行为变化。
 * 本文件钉住四件事：
 *  1) 协议登记：caps crypto.auth/crypto.content、错误码 crypto_required/key_mismatch、
 *     六个 crypto limits 已进 protocol/v4.json；RELAY_CAPS 的声明口径随实现阶段走：
 *     阶段 0 两项都不声明（未实现不冒充）；阶段 1 设备身份落地后 crypto.auth 进列，
 *     crypto.content（正文加密，阶段 3）仍不声明。
 *  2) 名册：设备行 keys/prevKeyFps 原样保留往返（写入、普通 upsert 继承、落盘重读、手写文件读入）；
 *     老设备行不带这两个键时落盘形状逐字节不变。viewers.jsonl 具备同样的读写保留能力。
 *  3) store：meta 行未知字段（含 enc/ackFp/rckWrap 形状）读入后经 reset 换代写回不丢
 *     （同步扫描与异步索引两条装载路径）；普通房间 meta 行形状与旧版逐字节一致。
 *  4) 指纹函数：公钥 SHA-256 前 8 字节 hex + 分组展示（设计 §2.2），Buffer/base64 双入参同结果。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const proto = require("../protocol/v4.json");
const { RELAY_CAPS } = require("../relay/wire.js");
const { AccountIndex, safeKey } = require("../relay/index.js");
const { RoomStore } = require("../relay/store.js");
const { keyFingerprint, formatFingerprint } = require("../relay/util.js");

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const KEYS = {
  sign: { alg: "ed25519", pub: "c2lnbi1wdWJsaWMta2V5LWJ5dGVzLWZvci10ZXN0cw", addedAt: 111 },
  box: { alg: "p256", pub: "Ym94LXB1YmxpYy1rZXktYnl0ZXMtZm9yLXRlc3Rz" },
};
const PREV_FPS = ["0123456789abcdef"];

/* ---------- 1) 协议登记 ---------- */

test("协议登记：caps / 错误码 / limits 齐全，RELAY_CAPS 按实现阶段声明", () => {
  assert.equal(typeof proto.caps["crypto.auth"], "string");
  assert.ok(proto.caps["crypto.auth"].length > 0);
  assert.equal(typeof proto.caps["crypto.content"], "string");
  assert.ok(proto.caps["crypto.content"].length > 0);
  assert.deepEqual(proto.errors.crypto_required.retryable, false);
  assert.ok(proto.errors.crypto_required.message.length > 0);
  assert.deepEqual(proto.errors.key_mismatch.retryable, true);
  assert.ok(proto.errors.key_mismatch.message.length > 0);
  assert.equal(proto.limits.signPubKeyBytes, 44);
  assert.equal(proto.limits.boxPubKeyBytes, 128);
  assert.equal(proto.limits.signatureMaxBytes, 128);
  assert.equal(proto.limits.wrappedKeyMaxBytes, 512);
  assert.equal(proto.limits.authNonceBytes, 32);
  assert.equal(proto.limits.contentKeyFpChars, 16);
  // 阶段 1 已实现设备身份（配对登记公钥/挑战鉴权/key_update/grant 透传）：crypto.auth
  // 名副其实进 RELAY_CAPS；阶段 3 已实现正文加密（信封落盘/版本门/迁移）：crypto.content
  // 同样名副其实进 RELAY_CAPS（本断言随阶段推进更新，旧口径见 git 历史）。
  assert.ok(RELAY_CAPS.includes("crypto.auth"));
  assert.ok(RELAY_CAPS.includes("crypto.content"));
});

/* ---------- 2) 设备名册 keys 往返 ---------- */

test("设备行 keys/prevKeyFps：写入保留、普通 upsert 继承、落盘重读不丢", () => {
  const dir = tmpDir("pi-crypto0-dev-");
  const idx = new AccountIndex(dir);
  const r1 = idx.upsertDevice("admin", { id: "dev1", name: "Mac", platform: "darwin", keys: KEYS, prevKeyFps: PREV_FPS }, 1000);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.row.keys, KEYS);
  assert.deepEqual(r1.row.prevKeyFps, PREV_FPS);

  // 不带 keys 的普通 upsert（attach 日常登记）绝不能把公钥抹掉
  const r2 = idx.upsertDevice("admin", { id: "dev1", name: "Mac", platform: "darwin", lastAttachAt: 2000 }, 2000);
  assert.deepEqual(r2.row.keys, KEYS, "普通 upsert 后 keys 必须原样保留");
  assert.deepEqual(r2.row.prevKeyFps, PREV_FPS);

  // 落盘原文里就在行内
  const file = path.join(dir, safeKey("admin"), "devices.jsonl");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[lines.length - 1].keys, KEYS);

  // 全新实例从磁盘重读仍在
  const idx2 = new AccountIndex(dir);
  const row = idx2.getDeviceRow("admin", "dev1");
  assert.deepEqual(row.keys, KEYS);
  assert.deepEqual(row.prevKeyFps, PREV_FPS);
});

test("设备行无 keys 时落盘形状逐字节不变（老行不长新键）", () => {
  const dir = tmpDir("pi-crypto0-plain-");
  const idx = new AccountIndex(dir);
  const { row } = idx.upsertDevice("admin", { id: "dev-old", name: "Old", platform: "linux" }, 1000);
  assert.ok(!("keys" in row), "无钥设备行不得出现 keys 键");
  assert.ok(!("prevKeyFps" in row), "无钥设备行不得出现 prevKeyFps 键");
  assert.deepEqual(
    Object.keys(row),
    ["kind", "id", "name", "platform", "projects", "lastAttachAt", "pairedAt", "firstSeenAt", "updatedAt"],
  );
});

test("设备行 keys：手写文件读入不丢、不报错（将来/外部写入的先行数据）", () => {
  const dir = tmpDir("pi-crypto0-hand-");
  const accDir = path.join(dir, safeKey("admin"));
  fs.mkdirSync(accDir, { recursive: true });
  const hand = {
    kind: "device", id: "dev-hand", name: "Hand", platform: "darwin", projects: [],
    lastAttachAt: 5, pairedAt: 5, firstSeenAt: 5, updatedAt: 5,
    keys: KEYS, prevKeyFps: PREV_FPS, futureField: { x: 1 },
  };
  fs.writeFileSync(path.join(accDir, "devices.jsonl"), JSON.stringify(hand) + "\n");
  const idx = new AccountIndex(dir);
  const row = idx.getDeviceRow("admin", "dev-hand");
  assert.deepEqual(row.keys, KEYS);
  assert.deepEqual(row.prevKeyFps, PREV_FPS);
  assert.deepEqual(row.futureField, { x: 1 });
});

/* ---------- 2b) viewers.jsonl 读写 ---------- */

test("viewers.jsonl：upsert/列表/重读往返，字段原样保留、未提及字段继承", () => {
  const dir = tmpDir("pi-crypto0-viewer-");
  const idx = new AccountIndex(dir);
  const v = {
    viewerId: "view1", name: "手机", signPub: "c2lnbi1wdWI", boxPub: "Ym94LXB1Yg",
    admin: true, futureField: "keep-me",
  };
  const r1 = idx.upsertViewer("admin", v, 1000);
  assert.equal(r1.ok, true);
  assert.equal(r1.row.kind, "viewer");
  assert.equal(r1.row.id, "view1");
  assert.equal(r1.row.createdAt, 1000, "createdAt 首次由服务端落戳");

  // 第二次只改名：公钥/admin/未知字段都必须继承保留
  const r2 = idx.upsertViewer("admin", { viewerId: "view1", name: "平板" }, 2000);
  assert.equal(r2.row.name, "平板");
  assert.equal(r2.row.signPub, "c2lnbi1wdWI");
  assert.equal(r2.row.boxPub, "Ym94LXB1Yg");
  assert.equal(r2.row.admin, true);
  assert.equal(r2.row.futureField, "keep-me");
  assert.equal(r2.row.createdAt, 1000);

  // 文件落点与重读
  const file = path.join(dir, safeKey("admin"), "viewers.jsonl");
  assert.ok(fs.existsSync(file), "viewers.jsonl 应落在账号目录下");
  const idx2 = new AccountIndex(dir);
  const rows = idx2.listViewers("admin");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].viewerId, "view1");
  assert.equal(rows[0].signPub, "c2lnbi1wdWI");
  assert.equal(idx2.getViewerRow("admin", "view1").name, "平板");
  assert.equal(idx2.getViewerRow("admin", "nobody"), null);

  // 缺 id 拒绝
  assert.equal(idx.upsertViewer("admin", { name: "x" }).ok, false);
  assert.equal(idx.upsertViewer("admin", null).ok, false);
});

/* ---------- 3) store meta 未知字段往返 ---------- */

const LIMITS = { limit: 10000, maxBytes: 64 * 1024 * 1024 };
const NO_CKPT = { ckptMinBytes: 1024 * 1024 * 1024, ckptIntervalBytes: 1024 * 1024 * 1024 }; // 禁检查点：装载必走扫描 meta 行
const user = (text, ts = 1) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const end = (message) => ({ type: "message_end", message });

function doctorMetaLine(dir, roomId, extra) {
  const file = path.join(dir, roomId + ".jsonl");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const meta = JSON.parse(lines[0]);
  assert.equal(meta.k, "meta");
  lines[0] = JSON.stringify({ ...meta, ...extra });
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

function readMetaLine(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
}

test("store meta：普通房间 meta 行形状与旧版逐字节一致（无多余键）", () => {
  const dir = tmpDir("pi-crypto0-meta-plain-");
  const s = new RoomStore(dir, { persist: true, ...NO_CKPT });
  s.record("r1", end(user("hi", 1)));
  s.flushAll();
  const raw = fs.readFileSync(path.join(dir, "r1.jsonl"), "utf8").split("\n")[0];
  const meta = JSON.parse(raw);
  assert.deepEqual(Object.keys(meta), ["k", "seq", "rev"]);
  assert.equal(raw, JSON.stringify({ k: "meta", seq: 0, rev: meta.rev }), "meta 行原文不得多一字节");
});

test("store meta：enc/ackFp/rckWrap 与未知字段经重开装载 + reset 换代写回不丢（同步扫描路径）", () => {
  const dir = tmpDir("pi-crypto0-meta-enc-");
  const s = new RoomStore(dir, { persist: true, ...NO_CKPT });
  s.record("r1", end(user("secret history", 1)));
  s.flushAll();
  const extra = { enc: 1, ackFp: "0123456789abcdef", rckWrap: "d3JhcHBlZC1yY2stYmxvYg", zzFuture: { x: 1 } };
  const file = doctorMetaLine(dir, "r1", extra);

  const s2 = new RoomStore(dir, { persist: true, ...NO_CKPT });
  // 先装载（扫描读到 meta 行），再换代：新世代 meta 行必须继续带这些字段（设计 §5 不许借 reset 洗掉）
  assert.equal(s2.snapshot("r1", LIMITS).items.length, 1);
  assert.equal(s2.reset("r1"), true);
  s2.record("r1", end(user("new gen", 2)));
  s2.flushAll();
  const meta = readMetaLine(file);
  assert.equal(meta.k, "meta");
  assert.equal(meta.enc, 1);
  assert.equal(meta.ackFp, "0123456789abcdef");
  assert.equal(meta.rckWrap, "d3JhcHBlZC1yY2stYmxvYg");
  assert.deepEqual(meta.zzFuture, { x: 1 });
});

test("store meta：未知字段经异步索引装载（大房冷打开）后换代写回不丢", { timeout: 60000 }, async () => {
  const dir = tmpDir("pi-crypto0-meta-async-");
  const s = new RoomStore(dir, { persist: true, ...NO_CKPT });
  const big = end(user("y".repeat(4096), 1));
  for (let i = 0; i < 300; i++) { // ≈1.2MB > SYNC_SCAN_MAX_BYTES(1MB) → 异步索引
    big.message.timestamp = i + 1;
    s.record("r1", big);
  }
  s.flushAll();
  const extra = { enc: 1, ackFp: "fedcba9876543210", rckWrap: "d3JhcHBlZA" };
  const file = doctorMetaLine(dir, "r1", extra);

  const s2 = new RoomStore(dir, { persist: true, ...NO_CKPT });
  assert.equal(s2.info("r1").indexing, true, "大房应走异步索引");
  await s2.whenIndexed("r1");
  assert.equal(s2.reset("r1"), true);
  s2.record("r1", end(user("after", 9999)));
  s2.flushAll();
  const meta = readMetaLine(file);
  assert.equal(meta.enc, 1, "异步装载（staging→live 移植）不得丢 meta 未知字段");
  assert.equal(meta.ackFp, "fedcba9876543210");
  assert.equal(meta.rckWrap, "d3JhcHBlZA");
});

/* ---------- 4) 指纹函数 ---------- */

test("指纹：公钥 SHA-256 前 8 字节 hex；Buffer/base64 同结果；分组展示", () => {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const expect = crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
  assert.equal(keyFingerprint(der), expect);
  assert.equal(keyFingerprint(der.toString("base64")), expect);
  assert.equal(keyFingerprint(der).length, 16);

  const p256 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der2 = p256.publicKey.export({ type: "spki", format: "der" });
  assert.equal(keyFingerprint(der2), crypto.createHash("sha256").update(der2).digest("hex").slice(0, 16));

  assert.equal(formatFingerprint("3f9ac41de5f60789"), "3f9a c41d e5f6 0789");
  assert.equal(formatFingerprint(keyFingerprint(der)), expect.replace(/(.{4})(?=.)/g, "$1 "));
});
