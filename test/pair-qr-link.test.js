"use strict";
/**
 * 二维码设备链接（device.qr-link）+ 三个已复核 bug 的回归测试：
 *   pair_request（local 预鉴权）→ pair_lookup（viewer）→ pair_approve（管理员门 + 共用签发）
 *   → 沿等待连接回 pair_result，全链路对真实 relay 跑。
 *   另覆盖：approve 无管理员令牌被拒、码过期、等待连接断开删码、重新配对旧令牌校验、
 *   lookup 失败限速、R-1（viewer 空令牌守卫）、R-2（purge forget 返回 false 不广播）、
 *   R-6（broadcast 序列化兜底）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { normalizePairCode, pairCheckDigits } = require("../relay/pairing.js");
const { purgeSessions } = require("../relay/purge.js");
const { broadcast } = require("../relay/wire.js");

const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";
const ADMIN_TOKEN = "test-admin-token-4d9c2e";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-pair-qr-"));
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

async function authedViewer(relay) {
  const v = client(relay.viewerPort);
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
  assert.equal((await v.type("auth_result")).ok, true);
  return v;
}

/** pi 运行端发 pair_request 申请链接码，返回 {conn, result}（连接保持开启等批准） */
async function requestLink(relay, device, deviceToken) {
  const c = client(relay.localPort);
  await c.opened;
  const frame = { type: "pair_request", device };
  if (deviceToken) frame.deviceToken = deviceToken;
  c.send(frame);
  const result = await c.type("pair_request_result");
  assert.equal(result.ok, true, JSON.stringify(result));
  return { conn: c, result };
}

test("pairCheckDigits：2 位数字、同码稳定（relay 单一计算）", () => {
  const d = pairCheckDigits("ABCD2345");
  assert.match(d, /^\d{2}$/);
  assert.equal(pairCheckDigits("ABCD2345"), d);
});

test("二维码链接全链路：request → lookup → approve → pair_result，令牌可用且码已消费", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());

  const { conn, result } = await requestLink(relay, { name: "工位机", platform: "darwin" });
  t.after(() => conn.close());
  assert.match(result.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/, "回码是 XXXX-XXXX 展示形式");
  assert.ok(result.expiresAt > Date.now(), "expiresAt 在未来");
  // 核对字由 relay 对裸码派生：与 pairing 的单一实现对齐
  assert.equal(result.checkDigits, pairCheckDigits(normalizePairCode(result.code)));

  const v = await authedViewer(relay);
  t.after(() => v.close());
  v.send({ type: "pair_lookup", id: "lk-1", code: result.code });
  const look = await v.type("pair_lookup_result", (f) => f.id === "lk-1");
  assert.equal(look.name, "工位机");
  assert.equal(look.platform, "macos", "platform 与 handlePair 一样过 normalizePlatform（darwin→macos）");
  assert.equal(look.expiresAt, result.expiresAt);
  assert.equal(look.checkDigits, result.checkDigits, "两端同显同一个核对字");

  v.send({ type: "pair_approve", id: "ap-1", code: result.code, adminToken: ADMIN_TOKEN });
  const ack = await v.type("ack", (f) => f.id === "ap-1");
  assert.equal(ack.ok, true, JSON.stringify(ack));

  const paired = await conn.type("pair_result");
  assert.equal(paired.ok, true, JSON.stringify(paired));
  assert.equal(ack.data.deviceId, paired.deviceId);
  assert.equal(typeof paired.deviceToken, "string");
  assert.ok(paired.deviceToken.length >= 20);

  // 签发的设备令牌能过 local 鉴权（与手输码配出的令牌同路）
  const local = client(relay.localPort);
  t.after(() => local.close());
  await local.opened;
  local.send({ type: "auth", role: "local", deviceId: paired.deviceId, deviceToken: paired.deviceToken });
  const auth = await local.type("auth_result");
  assert.equal(auth.ok, true, JSON.stringify(auth));
  assert.equal(auth.auth, "token");

  // 码一次性：再批准同一个码只能得到 pair_invalid
  v.send({ type: "pair_approve", id: "ap-2", code: result.code, adminToken: ADMIN_TOKEN });
  const ack2 = await v.type("ack", (f) => f.id === "ap-2");
  assert.equal(ack2.ok, false);
  assert.equal(ack2.code, "pair_invalid");
});

test("pair_lookup 成功：等待端收到 pair_claimed 且只发一次", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());

  const { conn, result } = await requestLink(relay, { name: "工位机", platform: "darwin" });
  t.after(() => conn.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());

  v.send({ type: "pair_lookup", id: "lk-a", code: result.code });
  await v.type("pair_lookup_result", (f) => f.id === "lk-a");
  await conn.type("pair_claimed");

  v.send({ type: "pair_lookup", id: "lk-b", code: result.code });
  await v.type("pair_lookup_result", (f) => f.id === "lk-b");
  await sleep(150);
  assert.equal(conn.frames.filter((f) => f.type === "pair_claimed").length, 1, "重复 lookup 不重发 pair_claimed");
});

test("pair_approve 无管理员令牌被拒，条目不消费、补上令牌可再批准", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn, result } = await requestLink(relay, { name: "笔记本", platform: "win32" });
  t.after(() => conn.close());

  const v = await authedViewer(relay);
  t.after(() => v.close());
  v.send({ type: "pair_approve", id: "ap-noauth", code: result.code });
  const denied = await v.type("ack", (f) => f.id === "ap-noauth");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "admin_required");

  // 没被拒动作消费掉：lookup 还在，带令牌批准成功
  v.send({ type: "pair_lookup", id: "lk-2", code: result.code });
  assert.equal((await v.type("pair_lookup_result", (f) => f.id === "lk-2")).name, "笔记本");
  v.send({ type: "pair_approve", id: "ap-ok", code: result.code, adminToken: ADMIN_TOKEN });
  assert.equal((await v.type("ack", (f) => f.id === "ap-ok")).ok, true);
  assert.equal((await conn.type("pair_result")).ok, true);
});

test("二维码链接：码过期后 lookup 回 pair_expired", async (t) => {
  const relay = await boot({ pairCodeTtlMs: 80 });
  t.after(() => relay.close());
  const { conn, result } = await requestLink(relay, { name: "快过期", platform: "linux" });
  t.after(() => conn.close());
  assert.ok(result.expiresAt - Date.now() <= 1000, "用的是测试 TTL");

  await sleep(160);
  const v = await authedViewer(relay);
  t.after(() => v.close());
  v.send({ type: "pair_lookup", id: "lk-exp", code: result.code });
  const err = await v.type("error", (f) => f.id === "lk-exp");
  assert.equal(err.code, "pair_expired");
});

test("二维码链接：等待连接断开即删码，lookup 只剩 pair_invalid", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { conn, result } = await requestLink(relay, { name: "会断开", platform: "linux" });
  conn.close();

  const v = await authedViewer(relay);
  t.after(() => v.close());
  // close 处理是异步的：轮询 lookup，直到条目被删（成功回结果说明还没删，不记失败账）
  let err = null;
  for (let i = 0; i < 20 && !err; i++) {
    const id = "lk-gone-" + i;
    v.send({ type: "pair_lookup", id, code: result.code });
    const f = await v.wait((m) => (m.type === "error" || m.type === "pair_lookup_result") && m.id === id, 2000, "lookup 回包");
    if (f.type === "error") err = f;
    else await sleep(100);
  }
  assert.ok(err, "断开后 lookup 应当失败");
  assert.equal(err.code, "pair_invalid");
});

test("二维码链接重新配对：不带旧令牌被 device_mismatch 拒，带对旧令牌才换发", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());

  // 先走经典手输码流程把 dev-qr-repair 配上，拿到旧令牌 T1
  v.send({ type: "pair_create", id: "pc-1", adminToken: ADMIN_TOKEN, name: "待重配" });
  const created = await v.type("ack", (f) => f.id === "pc-1");
  assert.equal(created.ok, true, JSON.stringify(created));
  const classic = client(relay.localPort);
  await classic.opened;
  classic.send({ type: "pair", code: created.data.code, device: { id: "dev-qr-repair", name: "旧机", platform: "darwin" } });
  const first = await classic.type("pair_result");
  assert.equal(first.ok, true, JSON.stringify(first));
  const t1 = first.deviceToken;
  classic.close();

  // 二维码路径重配同一 deviceId、不带旧令牌：approve 时被共用签发段拦下，两端都收到 device_mismatch
  const bad = await requestLink(relay, { id: "dev-qr-repair", name: "新机", platform: "darwin" });
  t.after(() => bad.conn.close());
  v.send({ type: "pair_approve", id: "ap-bad", code: bad.result.code, adminToken: ADMIN_TOKEN });
  const ackBad = await v.type("ack", (f) => f.id === "ap-bad");
  assert.equal(ackBad.ok, false);
  assert.equal(ackBad.code, "device_mismatch");
  const waitBad = await bad.conn.type("pair_result");
  assert.equal(waitBad.ok, false);
  assert.equal(waitBad.code, "device_mismatch");

  // 带上旧令牌重配：签发新令牌，旧的作废
  const good = await requestLink(relay, { id: "dev-qr-repair", name: "新机", platform: "darwin" }, t1);
  t.after(() => good.conn.close());
  v.send({ type: "pair_approve", id: "ap-good", code: good.result.code, adminToken: ADMIN_TOKEN });
  assert.equal((await v.type("ack", (f) => f.id === "ap-good")).ok, true);
  const second = await good.conn.type("pair_result");
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.deviceId, "dev-qr-repair");
  assert.notEqual(second.deviceToken, t1);
});

test("pair_lookup 失败按来源限速：连错 10 次后回 rate_limited", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  for (let i = 0; i < 10; i++) {
    const id = "lk-bad-" + i;
    v.send({ type: "pair_lookup", id, code: "ZZZZZZZZ" });
    const err = await v.type("error", (f) => f.id === id);
    assert.equal(err.code, "pair_invalid", `第 ${i + 1} 次应为 pair_invalid`);
  }
  v.send({ type: "pair_lookup", id: "lk-bad-11", code: "ZZZZZZZZ" });
  const limited = await v.type("error", (f) => f.id === "lk-bad-11");
  assert.equal(limited.code, "rate_limited");
});

test("R-1：viewerToken 未配置（空串）时，空 token 不能通过 viewer 鉴权", async (t) => {
  const relay = await boot({ viewerToken: "" });
  t.after(() => relay.close());
  const v = client(relay.viewerPort);
  t.after(() => v.close());
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "" });
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, false, "两边同为空串不许判通过（与 local legacy 的非空守卫同口径）");
});

test("R-2：forgetSession 返回 false（不抛错）时 purge 不广播 session_removed，下轮重试才广播", () => {
  const dir = tmpDir();
  const id = "sess-r2";
  const file = path.join(dir, id + ".jsonl");
  fs.writeFileSync(file, '{"k":"msg","seq":1,"m":{}}\n');
  try {
    const frames = [];
    const viewer = {
      readyState: 1,
      bufferedAmount: 0,
      _state: { caps: new Set(["session.purge"]) },
      send(data) { frames.push(JSON.parse(data)); },
    };
    const room = { id, online: false, viewers: new Set([viewer]) };
    const rooms = {
      viewers: new Set([viewer]),
      map: new Map([[id, room]]),
      peek(rid) { return this.map.get(rid) || null; },
      broadcastRoomList() {},
    };
    const store = {
      drop(rid) { try { fs.unlinkSync(path.join(dir, rid + ".jsonl")); } catch {} },
      roomFileExists(rid) { return fs.existsSync(path.join(dir, rid + ".jsonl")); },
    };
    let forgetResult = false;
    let forgetCalls = 0;
    const index = { forgetSession() { forgetCalls++; return forgetResult; } };
    const devices = new Map([["dev-1", { archives: new Map([[id, { id }]]) }]]);
    const args = { accountId: "admin", deviceId: "dev-1", ids: [id], rooms, store, devices, index, cfg: {} };

    const done1 = purgeSessions(args);
    assert.deepEqual(done1, [], "墓碑没立住的 id 不能计入 done");
    assert.equal(forgetCalls, 1);
    assert.equal(frames.some((f) => f.type === "session_removed"), false, "不能广播 session_removed");

    forgetResult = true;
    const done2 = purgeSessions(args);
    assert.deepEqual(done2, [id], "下轮重试 forget 成功后正常计入");
    assert.ok(frames.some((f) => f.type === "session_removed" && f.ids.includes(id)), "重试成功才广播");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("R-6：broadcast 遇到序列化不了的帧不抛错、跳过；正常帧照常发", () => {
  const sent = [];
  const fakeWs = { readyState: 1, bufferedAmount: 0, send(data) { sent.push(data); } };
  const circular = { type: "x" };
  circular.self = circular;
  assert.doesNotThrow(() => broadcast([fakeWs], circular, {}));
  assert.equal(sent.length, 0, "坏帧不能发出去");
  broadcast([fakeWs], { type: "ok" }, {});
  assert.deepEqual(sent, ['{"type":"ok"}']);
});
