"use strict";
/**
 * 加密地基阶段 1 · 设备身份（设计 A §3/§8 阶段 1）端到端：
 *   密钥配对（手输码 pop + 登记 + 停发令牌 / 二维码自带码 + SAS v2 + grant 透传）、
 *   挑战-签名鉴权（全程无令牌）、令牌降级拒绝、key_update 轮换、device_revoke 钥作废、
 *   content_key_request/grant 路由盖戳。签名载荷在本文件按跨端契约手工拼字节，
 *   不借 relay 的 authPayload/keyUpdatePayload——两份实现对不上就是契约漂移，必须红。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { normalizePairCode, pairCheckDigits, pairCheckDigitsV2, newPairCode } = require("../relay/pairing.js");
const { keyFingerprint } = require("../relay/util.js");

const LOCAL_TOKEN = "stage1-local-token";
const VIEWER_TOKEN = "stage1-viewer-token";
const ADMIN_TOKEN = "stage1-admin-token";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crypto1-"));
}

function boot(overrides = {}) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    perMessageDeflate: false,
    ...overrides,
  });
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const waiters = [];
  ws.on("error", () => {});
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      msg = { __raw: data.toString("utf8") };
    }
    frames.push(msg);
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue;
      msg.__taken = true;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      break;
    }
  });
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    wait(pred, ms = 3000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f));
      if (hit) {
        hit.__taken = true;
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            reject(new Error(`等待 ${what} 超时；已收到：${frames.map((f) => f.__raw || f.type).join(",")}`));
          }, ms),
        };
        w.timer.unref();
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type);
    },
    close() {
      try {
        ws.terminate();
      } catch {}
    },
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试内自造设备钥对（与 deploy 侧钥文件同材料：Ed25519 签名 + P-256 box，spki der base64） */
function genKeys() {
  const sign = crypto.generateKeyPairSync("ed25519");
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    signPriv: sign.privateKey,
    boxPriv: box.privateKey,
    signPub: sign.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    boxPub: box.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

const popFor = (keys, code) => crypto.sign(null, Buffer.from(normalizePairCode(code), "utf8"), keys.signPriv).toString("base64");

async function authedViewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  const frame = { type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4 };
  if (caps) frame.caps = caps;
  v.send(frame);
  const res = await v.type("auth_result");
  assert.equal(res.ok, true);
  return { conn: v, authResult: res };
}

/** 管理员在 viewer 通道生成一张手输配对码，返回裸码 */
async function adminPairCode(v, id) {
  v.send({ type: "pair_create", id, adminToken: ADMIN_TOKEN });
  const ack = await v.type("ack", (f) => f.id === id);
  assert.equal(ack.ok, true, JSON.stringify(ack));
  return ack.data.code;
}

/** 手输码配对（可带 keys/pop、可带旧令牌），回 pair_result 并关连接 */
async function pairWithCode(relay, { code, device, keys, pop, deviceToken }) {
  const c = client(relay.localPort);
  await c.opened;
  const frame = { type: "pair", code, device };
  if (keys) frame.keys = { signPub: keys.signPub, boxPub: keys.boxPub, pop };
  if (deviceToken) frame.deviceToken = deviceToken;
  c.send(frame);
  const res = await c.type("pair_result");
  c.close();
  return res;
}

/**
 * 挑战-签名鉴权：签名输入按跨端契约手工拼——
 * utf8("pi-remote-auth-v1") ‖ utf8(deviceId) ‖ relayNonce 原字节 ‖ clientNonce 原字节。
 * 返回 {conn, result}；被拒时 result 是失败的 auth_result（连接已关）。
 */
async function keyAuth(relay, deviceId, keys, { signWith = null, keyFp = null } = {}) {
  const c = client(relay.localPort);
  await c.opened;
  const clientNonce = crypto.randomBytes(16);
  c.send({
    type: "auth",
    role: "local",
    proto: 4,
    caps: ["crypto.auth"],
    deviceId,
    keyFp: keyFp || keyFingerprint(keys.signPub),
    clientNonce: clientNonce.toString("base64"),
  });
  const first = await c.wait((f) => f.type === "auth_challenge" || f.type === "auth_result", 3000, "auth_challenge/auth_result");
  if (first.type === "auth_result") return { conn: c, result: first };
  const payload = Buffer.concat([
    Buffer.from("pi-remote-auth-v1", "utf8"),
    Buffer.from(deviceId, "utf8"),
    Buffer.from(first.nonce, "base64"),
    clientNonce,
  ]);
  const sig = crypto.sign(null, payload, (signWith || keys).signPriv).toString("base64");
  c.send({ type: "auth_response", sig });
  const result = await c.type("auth_result");
  return { conn: c, result, challenge: first };
}

test("密钥配对（手输码）：pop 验签 → keyRegistered、无令牌下发、名册带 keyFp（按 cap 下发）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  const code = await adminPairCode(v, "pc-key-1");
  const keys = genKeys();
  const device = { id: "dev-key-1", name: "钥匙机", platform: "linux" };
  const res = await pairWithCode(relay, { code, device, keys, pop: popFor(keys, code) });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.keyRegistered, true);
  assert.equal(res.hasKeyHolder, false, "账号首台钥设备：本次登记前无其他持钥端");
  assert.equal(res.deviceToken, undefined, "钥设备不许下发 deviceToken");
  assert.equal(res.deviceId, "dev-key-1");

  // 名册：声明 crypto.auth 的 viewer 看得到 keyFp/keyAddedAt；未声明的看不到（旧面逐字节）
  const { conn: v2, authResult: withCap } = await authedViewer(relay, ["crypto.auth"]);
  t.after(() => v2.close());
  const entry = withCap.devices.find((d) => d.id === "dev-key-1");
  assert.ok(entry, "设备应在名册里");
  assert.equal(entry.keyFp, keyFingerprint(keys.signPub));
  assert.ok(Number(entry.keyAddedAt) > 0);
  const { authResult: noCap } = await authedViewer(relay);
  const bare = noCap.devices.find((d) => d.id === "dev-key-1");
  assert.ok(bare);
  assert.ok(!("keyFp" in bare) && !("keyAddedAt" in bare), "未声明 crypto.auth 不许带 keyFp/keyAddedAt");

  // 全程无令牌：挑战-签名直接登录
  const { conn, result } = await keyAuth(relay, "dev-key-1", keys);
  t.after(() => conn.close());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.auth, "key");
  assert.equal(result.deviceId, "dev-key-1");
});

test("pop 伪造（他人公钥 + 自签）必拒且不登记", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  const code = await adminPairCode(v, "pc-key-2");
  const victim = genKeys();
  const attacker = genKeys();
  // 登记受害者公钥、签名却是攻击者私钥签的：没有受害者私钥就登记不上
  const res = await pairWithCode(relay, {
    code,
    device: { id: "dev-key-2", name: "被冒名机", platform: "linux" },
    keys: victim,
    pop: popFor(attacker, code),
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
  // 没登记：拿受害者钥走挑战鉴权应在发挑战前就被拒（名册无钥）
  const { conn, result } = await keyAuth(relay, "dev-key-2", victim);
  t.after(() => conn.close());
  assert.equal(result.ok, false);
  assert.equal(result.code, "device_mismatch");
});

test("挑战鉴权失败口径：错签 → auth_failed；id/钥错配 → device_mismatch；无挑战回 auth_response → auth_failed", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  const code = await adminPairCode(v, "pc-key-3");
  const keys = genKeys();
  const other = genKeys();
  await pairWithCode(relay, { code, device: { id: "dev-key-3", name: "验签机", platform: "linux" }, keys, pop: popFor(keys, code) });

  // 错签（别人的私钥签本设备的挑战）
  const bad = await keyAuth(relay, "dev-key-3", keys, { signWith: other });
  t.after(() => bad.conn.close());
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.code, "auth_failed");

  // id 与钥错配：拿另一台的指纹给本设备发 auth
  const mm = await keyAuth(relay, "dev-key-3", keys, { keyFp: keyFingerprint(other.signPub) });
  t.after(() => mm.conn.close());
  assert.equal(mm.result.ok, false);
  assert.equal(mm.result.code, "device_mismatch");

  // 没领挑战直接回 auth_response
  const c = client(relay.localPort);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: "auth_response", sig: Buffer.alloc(64).toString("base64") });
  const res = await c.type("auth_result");
  assert.equal(res.ok, false);
  assert.equal(res.code, "auth_failed");
});

test("令牌迁移与降级拒绝：令牌设备带钥重配对后旧令牌立即失效、新令牌一律不发", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  const device = { id: "dev-mig-1", name: "迁移机", platform: "darwin" };

  const code1 = await adminPairCode(v, "pc-mig-1");
  const r1 = await pairWithCode(relay, { code: code1, device });
  assert.equal(r1.ok, true);
  assert.ok(typeof r1.deviceToken === "string" && r1.deviceToken.length > 0, "旧路径仍签发令牌");
  assert.ok(!("hasKeyHolder" in r1), "令牌形态 pair_result 不带 hasKeyHolder（逐字节回归）");

  // 升级：带钥重配对（替换校验要出示旧令牌）
  const keys = genKeys();
  const code2 = await adminPairCode(v, "pc-mig-2");
  const r2 = await pairWithCode(relay, { code: code2, device, keys, pop: popFor(keys, code2), deviceToken: r1.deviceToken });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.keyRegistered, true);
  assert.equal(r2.hasKeyHolder, false, "同设备自身重配对不算「其他」持钥端");
  assert.equal(r2.deviceToken, undefined);

  // 旧令牌再登录：必失败（令牌行已作废 + 显式降级守卫双保险）
  const c = client(relay.localPort);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: "auth", role: "local", proto: 4, deviceId: "dev-mig-1", deviceToken: r1.deviceToken });
  const res = await c.type("auth_result");
  assert.equal(res.ok, false, "钥设备拿旧令牌登录必失败");

  // 钥路径正常
  const { conn, result } = await keyAuth(relay, "dev-mig-1", keys);
  t.after(() => conn.close());
  assert.equal(result.ok, true);
  assert.equal(result.auth, "key");
});

test("hasKeyHolder：同账号第二台钥设备配对 → true（attach 据此不自生成 ACK，防内容钥分叉）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());

  const code1 = await adminPairCode(v, "pc-hkh-1");
  const keysA = genKeys();
  const r1 = await pairWithCode(relay, { code: code1, device: { id: "dev-hkh-a", name: "第一台钥机", platform: "linux" }, keys: keysA, pop: popFor(keysA, code1) });
  assert.equal(r1.ok, true, JSON.stringify(r1));
  assert.equal(r1.hasKeyHolder, false, "第一台：登记前账号内无持钥端");

  const code2 = await adminPairCode(v, "pc-hkh-2");
  const keysB = genKeys();
  const r2 = await pairWithCode(relay, { code: code2, device: { id: "dev-hkh-b", name: "第二台钥机", platform: "darwin" }, keys: keysB, pop: popFor(keysB, code2) });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal(r2.keyRegistered, true);
  assert.equal(r2.hasKeyHolder, true, "第二台：登记前已有持钥端（第一台）在册");
  assert.equal(r2.deviceToken, undefined);
});

test("二维码路径：带钥自带码 + SAS v2 + lookup 带 keyFp + approve 透传 contentKeyGrant", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const keys = genKeys();
  const proposed = newPairCode(new Map());
  const c = client(relay.localPort);
  t.after(() => c.close());
  await c.opened;
  c.send({
    type: "pair_request",
    device: { id: "dev-qr-1", name: "扫码机", platform: "win32" },
    code: proposed,
    keys: { signPub: keys.signPub, boxPub: keys.boxPub, pop: popFor(keys, proposed) },
  });
  const rr = await c.type("pair_request_result");
  assert.equal(rr.ok, true, JSON.stringify(rr));
  assert.equal(normalizePairCode(rr.code), proposed);
  assert.equal(rr.checkDigits, pairCheckDigitsV2(proposed, keys.signPub, keys.boxPub), "带钥申请核对字必须是 SAS v2");

  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  v.send({ type: "pair_lookup", id: "lk-q1", code: rr.code });
  const look = await v.type("pair_lookup_result", (f) => f.id === "lk-q1");
  assert.equal(look.checkDigits, rr.checkDigits, "两端同显同一对 SAS v2 数字");
  assert.equal(look.keyFp, keyFingerprint(keys.signPub));

  const grant = { to: keyFingerprint(keys.signPub), nonce: Buffer.alloc(12, 7).toString("base64"), ct: Buffer.alloc(48, 9).toString("base64") };
  v.send({ type: "pair_approve", id: "ap-q1", code: rr.code, adminToken: ADMIN_TOKEN, contentKeyGrant: grant });
  const ack = await v.type("ack", (f) => f.id === "ap-q1");
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const pr = await c.type("pair_result");
  assert.equal(pr.ok, true);
  assert.equal(pr.keyRegistered, true);
  assert.equal(pr.hasKeyHolder, false, "二维码批准路径同口径：首台钥设备 hasKeyHolder=false");
  assert.equal(pr.deviceToken, undefined);
  assert.deepEqual(pr.contentKeyGrant, grant, "grant 只透传：relay 不解析、不落盘、不改写");

  // 不带钥的旧申请：核对字仍是 v1（逐字节回归）
  const c2 = client(relay.localPort);
  t.after(() => c2.close());
  await c2.opened;
  c2.send({ type: "pair_request", device: { name: "旧机", platform: "linux" } });
  const rr2 = await c2.type("pair_request_result");
  assert.equal(rr2.ok, true);
  assert.equal(rr2.checkDigits, pairCheckDigits(normalizePairCode(rr2.code)));
});

test("key_update 轮换：旧钥签名换登记，旧钥即刻失效、新钥可登录；伪造签名被拒", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  const code = await adminPairCode(v, "pc-rot-1");
  const k1 = genKeys();
  await pairWithCode(relay, { code, device: { id: "dev-rot-1", name: "轮换机", platform: "linux" }, keys: k1, pop: popFor(k1, code) });

  const { conn } = await keyAuth(relay, "dev-rot-1", k1);
  t.after(() => conn.close());

  const k2 = genKeys();
  const payloadFor = (a, b) => Buffer.concat([
    Buffer.from("pi-remote-keyupdate-v1", "utf8"),
    Buffer.from("dev-rot-1", "utf8"),
    Buffer.from(a, "utf8"),
    Buffer.from(b, "utf8"),
  ]);
  // 伪造：新钥自己签（没有旧私钥）→ 拒，且登记不变
  conn.send({
    type: "key_update",
    deviceId: "dev-rot-1",
    newSignPub: k2.signPub,
    newBoxPub: k2.boxPub,
    sig: crypto.sign(null, payloadFor(k2.signPub, k2.boxPub), k2.signPriv).toString("base64"),
  });
  const err = await conn.type("error", (f) => f.code === "auth_failed");
  assert.ok(err);
  const still = await keyAuth(relay, "dev-rot-1", k1);
  t.after(() => still.conn.close());
  assert.equal(still.result.ok, true, "伪造轮换后旧钥仍应可登录");

  // 正规轮换：旧钥签名
  conn.send({
    type: "key_update",
    deviceId: "dev-rot-1",
    newSignPub: k2.signPub,
    newBoxPub: k2.boxPub,
    sig: crypto.sign(null, payloadFor(k2.signPub, k2.boxPub), k1.signPriv).toString("base64"),
  });
  // 成功无回执帧：轮询新钥登录直到生效
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    const attempt = await keyAuth(relay, "dev-rot-1", k2);
    ok = attempt.result.ok === true;
    attempt.conn.close();
    if (!ok) await sleep(100);
  }
  assert.ok(ok, "轮换后新钥应可登录");
  const old = await keyAuth(relay, "dev-rot-1", k1);
  t.after(() => old.conn.close());
  assert.equal(old.result.ok, false);
  assert.equal(old.result.code, "device_mismatch", "旧钥指纹与新登记对不上");
});

test("device_revoke：令牌与钥双死，挑战鉴权回 device_revoked", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  const code = await adminPairCode(v, "pc-rvk-1");
  const keys = genKeys();
  await pairWithCode(relay, { code, device: { id: "dev-rvk-1", name: "待撤机", platform: "linux" }, keys, pop: popFor(keys, code) });

  v.send({ type: "device_revoke", id: "rv-1", deviceId: "dev-rvk-1", adminToken: ADMIN_TOKEN });
  const ack = await v.type("ack", (f) => f.id === "rv-1");
  assert.equal(ack.ok, true, JSON.stringify(ack));

  const { conn, result } = await keyAuth(relay, "dev-rvk-1", keys);
  t.after(() => conn.close());
  assert.equal(result.ok, false);
  assert.equal(result.code, "device_revoked");
});

test("content_key 透传：request 转发盖戳（from + fromBoxPub），grant 按指纹路由盖戳，无人可投回 offline", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());

  const keysA = genKeys();
  const keysB = genKeys();
  const codeA = await adminPairCode(v, "pc-g-a");
  await pairWithCode(relay, { code: codeA, device: { id: "dev-g-a", name: "甲机", platform: "linux" }, keys: keysA, pop: popFor(keysA, codeA) });
  const codeB = await adminPairCode(v, "pc-g-b");
  await pairWithCode(relay, { code: codeB, device: { id: "dev-g-b", name: "乙机", platform: "linux" }, keys: keysB, pop: popFor(keysB, codeB) });

  const a = await keyAuth(relay, "dev-g-a", keysA);
  t.after(() => a.conn.close());
  assert.equal(a.result.ok, true);
  const b = await keyAuth(relay, "dev-g-b", keysB);
  t.after(() => b.conn.close());
  assert.equal(b.result.ok, true);

  // B 请求内容钥：A 收到转发，带请求方 keyFp 与 box 公钥（持钥端据此包裹交付）
  b.conn.send({ type: "content_key_request", want: "admin" });
  const req = await a.conn.type("content_key_request");
  assert.equal(req.from, keyFingerprint(keysB.signPub));
  assert.equal(req.fromBoxPub, keysB.boxPub);

  // A 交付给 B：B 收到原样 blob + 交付方盖戳（from/fromBoxPub 以名册为准）
  const blob = { to: keyFingerprint(keysB.signPub), nonce: Buffer.alloc(12, 3).toString("base64"), ct: Buffer.alloc(60, 5).toString("base64") };
  a.conn.send({ type: "content_key_grant", ...blob });
  const got = await b.conn.type("content_key_grant");
  assert.equal(got.to, blob.to);
  assert.equal(got.nonce, blob.nonce);
  assert.equal(got.ct, blob.ct);
  assert.equal(got.from, keyFingerprint(keysA.signPub));
  assert.equal(got.fromBoxPub, keysA.boxPub);

  // 投给不在线的指纹：明确 offline 回执，不静默吞
  a.conn.send({ type: "content_key_grant", to: "0123456789abcdef", nonce: blob.nonce, ct: blob.ct });
  const off = await a.conn.type("error", (f) => f.code === "offline");
  assert.ok(off);
});

test("content_key_request 无其他持钥端在线：回 offline，请求方保持无内容钥状态", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn: v } = await authedViewer(relay);
  t.after(() => v.close());
  const keys = genKeys();
  const code = await adminPairCode(v, "pc-g-solo");
  await pairWithCode(relay, { code, device: { id: "dev-g-solo", name: "独行机", platform: "linux" }, keys, pop: popFor(keys, code) });
  const solo = await keyAuth(relay, "dev-g-solo", keys);
  t.after(() => solo.conn.close());
  assert.equal(solo.result.ok, true, "没有内容钥也不阻塞普通连接");
  solo.conn.send({ type: "content_key_request", want: "admin" });
  const off = await solo.conn.type("error", (f) => f.code === "offline");
  assert.ok(off);
});
