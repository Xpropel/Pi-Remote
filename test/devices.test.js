"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const crypto = require("node:crypto");
const { startRelay, loadConfig, commandTimeoutMs, normalizePlatform, normPath, cwdAllowed, cleanProjects, requestSource } = require("../relay/server.js");
const { buildDeviceList } = require("../relay/devices.js");
const { safeKey, AccountIndex } = require("../relay/index.js");
const PROTOCOL = require("../relay/protocol.json");

const DEV = "dev-1";
const ROOM = "sess-a";
// 配对/撤销现在要独立的管理员令牌；测试 fixture 与 viewer token 明确分开。
const ADMIN_TOKEN = "test-admin-token-8b1f4c";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-dev-"));
}

function boot(extra = {}) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: "lt",
    viewerToken: "vt",
    adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: false,
    ...extra,
  });
}

function client(port, opts) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, opts);
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    frames.push(msg);
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue;
      msg.__taken = true;
      const idx = waiters.indexOf(w);
      if (idx >= 0) waiters.splice(idx, 1);
      w.settled = true;
      clearTimeout(w.timer);
      w.resolve(msg);
      break;
    }
  });
  ws.on("error", () => {});
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
          settled: false,
          timer: setTimeout(() => {
            if (w.settled) return;
            const idx = waiters.indexOf(w);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error(`等待 ${what} 超时；已收到：${frames.map((f) => f.type + (f.command ? ":" + f.command : "")).join(",")}`));
          }, ms),
        };
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type);
    },
    close() {
      ws.terminate();
    },
  };
  return api;
}

async function authedLocal(relay) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: "lt" });
  const auth = await c.type("auth_result");
  assert.equal(auth.ok, true);
  return c;
}

async function authedViewer(relay) {
  const v = client(relay.viewerPort);
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt" });
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  return v;
}

function registerDevice(c, extra = {}) {
  c.send({
    type: "device_register",
    accountId: extra.accountId,
    device: {
      id: extra.id || DEV,
      name: extra.name || "Windows",
      platform: extra.platform || "windows",
      projects: extra.projects || ["D:\\work"],
      windowExpiresAt: extra.windowExpiresAt || 1791437613000,
    },
  });
}

/** 网页生成配对码 → 本机用 pair 第一帧换设备令牌 */
let pairSeq = 0;
async function pairDevice(relay, v, device = {}, deviceToken = "") {
  const id = "pc-" + ++pairSeq;
  v.send({ type: "pair_create", id, adminToken: ADMIN_TOKEN });
  const ack = await v.type("ack", (f) => f.id === id);
  assert.equal(ack.ok, true);
  const p = client(relay.localPort);
  await p.opened;
  const closed = new Promise((resolve) => p.ws.once("close", (code) => resolve(code)));
  const frame = { type: "pair", proto: 4, code: ack.data.code, device: { name: "Mac", platform: "macos", ...device } };
  if (deviceToken) frame.deviceToken = deviceToken;
  p.send(frame);
  const result = await p.type("pair_result");
  return { code: ack.data.code, expiresAt: ack.data.expiresAt, result, closed };
}

/** 用设备令牌登录 local 通道 */
async function tokenLocal(relay, deviceId, deviceToken) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", proto: 4, caps: ["device.token"], deviceId, deviceToken });
  const auth = await c.type("auth_result");
  return { c, auth };
}

test("配对：网页生成配对码，本机 pair 帧换设备令牌；码只能用一次，令牌文件只存哈希", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const before = Date.now();
  const { code, expiresAt, result, closed } = await pairDevice(relay, v);
  assert.match(code, /^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/, "8 位、XXXX-XXXX、不含 0/O/1/I");
  assert.ok(expiresAt >= before + PROTOCOL.limits.pairCodeTtlMs && expiresAt <= Date.now() + PROTOCOL.limits.pairCodeTtlMs);
  assert.equal(result.ok, true);
  assert.equal(result.accountId, "admin");
  assert.match(result.deviceId, /^[0-9a-f-]{36}$/, "没带 id 时由 relay 生成 uuid");
  assert.equal(Buffer.from(result.deviceToken, "base64url").length, PROTOCOL.limits.deviceTokenBytes);
  assert.equal(await closed, 1000, "回完 pair_result 就关连接");

  const text = fs.readFileSync(path.join(relay.cfg.accountsDir, safeKey("admin"), "device-tokens.jsonl"), "utf8");
  assert.equal(text.includes(result.deviceToken), false, "令牌原文不落盘");
  assert.ok(text.includes(crypto.createHash("sha256").update(result.deviceToken).digest("hex")));

  // 同一个码再用一次（小写、不带短横线也认得出）：已经用掉了
  const again = client(relay.localPort);
  t.after(() => again.close());
  await again.opened;
  again.send({ type: "pair", proto: 4, code: code.replace("-", "").toLowerCase(), device: { name: "Mac", platform: "macos" } });
  const reused = await again.type("pair_result");
  assert.equal(reused.ok, false);
  assert.equal(reused.code, "pair_invalid");

  // 配对完就进名册：paired=true，还没连上所以 auth=null
  v.send({ type: "list_rooms" });
  const list = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === result.deviceId));
  const row = list.devices.find((d) => d.id === result.deviceId);
  assert.equal(row.paired, true);
  assert.equal(row.auth, null);
  assert.equal(row.name, "Mac");
  assert.equal(row.platform, "macos");
});

test("设备令牌登录：auth_result 回 auth=token 和 deviceId；只能以绑定的设备说话，别的 id 回 device_mismatch", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const { result } = await pairDevice(relay, v, { id: DEV, name: "Windows", platform: "windows" });
  assert.equal(result.deviceId, DEV, "带了 id 就沿用：原有名册和会话清单不丢");

  const { c, auth } = await tokenLocal(relay, DEV, result.deviceToken);
  t.after(() => c.close());
  assert.equal(auth.ok, true);
  assert.equal(auth.auth, "token");
  assert.equal(auth.deviceId, DEV);

  registerDevice(c, { id: "dev-other" });
  assert.match((await c.type("error", (f) => f.code === "device_mismatch")).message, /device_register/);
  c.send({ type: "room_register", room: { id: ROOM, label: "A", cwd: "D:\\work", deviceId: "dev-other" } });
  await c.type("error", (f) => f.code === "device_mismatch" && /room_register/.test(f.message));
  c.send({ type: "session_manifest", deviceId: "dev-other", full: true, updatedAt: Date.now(), sessions: [] });
  await c.type("error", (f) => f.code === "device_mismatch" && /session_manifest/.test(f.message));
  assert.equal(relay.devices.has("dev-other"), false, "冒名的登记帧被丢掉");
  assert.equal(relay.rooms.peek(ROOM), null);

  registerDevice(c);
  const list = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online));
  const row = list.devices.find((d) => d.id === DEV);
  assert.equal(row.auth, "token");
  assert.equal(row.paired, true);
  assert.equal(row.windowExpiresAt, 1791437613000, "连接窗口到期时间要随名册下发，网页设置页才能显示剩余时间");
});

test("legacy 共享令牌不能冒用已配对设备；撤销令牌后也仍然不行", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const paired = (await pairDevice(relay, v, { id: DEV, name: "Mac", platform: "macos" })).result;
  assert.equal(paired.ok, true);

  const legacy = (() => {
    const c = client(relay.localPort);
    return c;
  })();
  await legacy.opened;
  legacy.send({ type: "auth", role: "local", token: "lt" });
  const auth = await legacy.type("auth_result");
  assert.equal(auth.auth, "legacy");
  t.after(() => legacy.close());

  legacy.send({ type: "device_register", device: { id: DEV, name: "EVIL", platform: "linux", projects: ["/"] } });
  const regErr = await legacy.type("error", (f) => f.code === "device_mismatch");
  assert.match(regErr.message, /已经配对/, "legacy 不能顶替已配对设备");
  assert.equal(relay.devices.has(DEV), false, "被拒绝的登记不能进内存名册");

  legacy.send({ type: "room_register", room: { id: "evil-room", label: "EVIL", cwd: "/", deviceId: DEV } });
  await legacy.type("error", (f) => f.code === "device_mismatch" && /room_register/.test(f.message));
  assert.equal(relay.rooms.peek("evil-room"), null);

  legacy.send({ type: "session_manifest", deviceId: DEV, full: true, updatedAt: Date.now(), sessions: [] });
  await legacy.type("error", (f) => f.code === "device_mismatch" && /session_manifest/.test(f.message));

  // 撤销后 legacy 仍不能回来：pairedAt 是不可逆标记
  relay.index.revokeDeviceTokens("admin", DEV, Date.now());
  const back = client(relay.localPort);
  t.after(() => back.close());
  await back.opened;
  back.send({ type: "auth", role: "local", token: "lt" });
  await back.type("auth_result");
  back.send({ type: "device_register", device: { id: DEV, name: "EVIL-BACK", platform: "linux", projects: ["/"] } });
  await back.type("error", (f) => f.code === "device_mismatch");
  assert.equal(relay.devices.has(DEV), false, "撤销后 legacy 也不能重新占用这个设备编号");
});

test("重新配对已有设备必须出示旧设备令牌：只有配对码不能接管", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const original = (await pairDevice(relay, v, { id: DEV, name: "Mac", platform: "macos" })).result;

  async function newCode() {
    const id = "pc-" + ++pairSeq;
    v.send({ type: "pair_create", id, adminToken: ADMIN_TOKEN });
    const ack = await v.type("ack", (f) => f.id === id);
    assert.equal(ack.ok, true);
    return ack.data.code;
  }

  const steal = client(relay.localPort);
  t.after(() => steal.close());
  await steal.opened;
  steal.send({ type: "pair", proto: 4, code: await newCode(), device: { id: DEV, name: "Evil", platform: "linux" } });
  const denied = await steal.type("pair_result");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "device_mismatch");
  assert.match(denied.error, /旧设备令牌/);

  const rotate = client(relay.localPort);
  t.after(() => rotate.close());
  await rotate.opened;
  rotate.send({ type: "pair", proto: 4, code: await newCode(), device: { id: DEV, name: "Mac", platform: "macos" }, deviceToken: original.deviceToken });
  const allowed = await rotate.type("pair_result");
  assert.equal(allowed.ok, true, "带旧令牌的重新配对要放行");
  assert.equal(allowed.deviceId, DEV);
  assert.notEqual(allowed.deviceToken, original.deviceToken);
});

test("令牌校验：错令牌 auth_failed；拿 A 的令牌登记成 B 是 device_mismatch；重新配对后旧令牌作废、旧连接被断开", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const a = (await pairDevice(relay, v, { id: "dev-a" })).result;
  await pairDevice(relay, v, { id: "dev-b" });

  const wrong = await tokenLocal(relay, "dev-a", "x".repeat(43));
  assert.equal(wrong.auth.ok, false);
  assert.equal(wrong.auth.code, "auth_failed");
  assert.equal((await tokenLocal(relay, "dev-b", a.deviceToken)).auth.code, "device_mismatch");

  const { c: old } = await tokenLocal(relay, "dev-a", a.deviceToken);
  const kicked = new Promise((resolve) => old.ws.once("close", (code) => resolve(code)));
  // 重新配对已有设备必须带旧令牌：只有配对码不再是接管凭据
  const a2 = (await pairDevice(relay, v, { id: "dev-a" }, a.deviceToken)).result;
  assert.notEqual(a2.deviceToken, a.deviceToken);
  await old.type("error", (f) => f.code === "device_revoked");
  assert.equal(await kicked, 4003);
  assert.equal((await tokenLocal(relay, "dev-a", a.deviceToken)).auth.code, "device_revoked");
  const fresh = await tokenLocal(relay, "dev-a", a2.deviceToken);
  t.after(() => fresh.c.close());
  assert.equal(fresh.auth.ok, true);
});

test("device_revoke：作废令牌、断开这台设备的窗口和扩展，旧令牌再登录回 device_revoked", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const { result } = await pairDevice(relay, v, { id: DEV, name: "Windows", platform: "windows" });
  const { c: win } = await tokenLocal(relay, DEV, result.deviceToken);
  registerDevice(win);
  await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online));
  const { c: ext } = await tokenLocal(relay, DEV, result.deviceToken);
  ext.send({ type: "room_register", room: { id: ROOM, label: "A", cwd: "D:\\work", deviceId: DEV } });
  await ext.type("room_registered");
  const winClosed = new Promise((resolve) => win.ws.once("close", (code) => resolve(code)));
  const extClosed = new Promise((resolve) => ext.ws.once("close", (code) => resolve(code)));

  v.send({ type: "device_revoke", id: "r1", deviceId: DEV, adminToken: ADMIN_TOKEN });
  const ack = await v.type("ack", (f) => f.id === "r1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, { revoked: 1, closed: 2 });
  assert.equal(await winClosed, 4003);
  assert.equal(await extClosed, 4003);
  const list = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && !d.online && d.paired === false));
  assert.equal(list.devices.find((d) => d.id === DEV).auth, null);
  assert.equal((await tokenLocal(relay, DEV, result.deviceToken)).auth.code, "device_revoked");

  v.send({ type: "device_revoke", id: "r2", deviceId: "no-such-device", adminToken: ADMIN_TOKEN });
  assert.equal((await v.type("ack", (f) => f.id === "r2")).code, "no_device");
  v.send({ type: "device_revoke", id: "r3", adminToken: ADMIN_TOKEN });
  assert.equal((await v.type("ack", (f) => f.id === "r3")).code, "bad_args");
});

test("配对码过期回 pair_expired；一分钟内猜错 10 次后暂停配对", async (t) => {
  const relay = await boot({ pairCodeTtlMs: 30 });
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  v.send({ type: "pair_create", id: "p1", adminToken: ADMIN_TOKEN });
  const { data } = await v.type("ack", (f) => f.id === "p1");
  await new Promise((r) => setTimeout(r, 60));
  const attempt = async (code) => {
    const p = client(relay.localPort);
    t.after(() => p.close());
    await p.opened;
    p.send({ type: "pair", proto: 4, code, device: { name: "x", platform: "linux" } });
    return (await p.type("pair_result")).code;
  };
  assert.equal(await attempt(data.code), "pair_expired");
  for (let i = 0; i < 9; i++) assert.equal(await attempt("2222-2222"), "pair_invalid");
  assert.equal(await attempt("2222-2222"), "rate_limited");
});

test("配对失败按来源限速：一个来源错满 10 次只停它自己，拿真码也不行且码不作废；别的来源照常配对；IPv6 同一 /64 算一个来源", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  // 测试连接的对端都是回环，用 X-Forwarded-For 扮成不同来源（本机反代的场景）
  const attempt = async (code, from) => {
    const p = client(relay.localPort, { headers: { "X-Forwarded-For": from } });
    t.after(() => p.close());
    await p.opened;
    p.send({ type: "pair", proto: 4, code, device: { name: "x", platform: "linux" } });
    return p.type("pair_result");
  };
  for (let i = 0; i < 10; i++) assert.equal((await attempt("2222-2222", "203.0.113.7")).code, "pair_invalid");
  assert.equal((await attempt("2222-2222", "203.0.113.7")).code, "rate_limited");

  v.send({ type: "pair_create", id: "p1", adminToken: ADMIN_TOKEN });
  const { data } = await v.type("ack", (f) => f.id === "p1");
  assert.equal((await attempt(data.code, "203.0.113.7")).code, "rate_limited");
  assert.equal((await attempt("2222-2222", "198.51.100.1, 203.0.113.7")).code, "rate_limited", "只认最后一跳，前面的是客户端自己写的");
  const paired = await attempt(data.code, "203.0.113.7, 198.51.100.9");
  assert.equal(paired.ok, true, "别的来源不受影响，被停的来源也没把码用掉");

  for (let i = 1; i <= 10; i++) assert.equal((await attempt("2222-2222", `2001:db8:1:2::${i}`)).code, "pair_invalid");
  assert.equal((await attempt("2222-2222", "2001:0db8:0001:0002:ffff::9")).code, "rate_limited");
  assert.equal((await attempt("2222-2222", "2001:db8:1:3::1")).code, "pair_invalid");
});

test("requestSource：对端不是回环就不认 X-Forwarded-For；IPv4 映射地址还原；IPv6 归到 /64；认不出的头退回对端地址", () => {
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
  assert.equal(requestSource(req("203.0.113.7", "198.51.100.1")), "203.0.113.7");
  assert.equal(requestSource(req("::ffff:203.0.113.7")), "203.0.113.7");
  assert.equal(requestSource(req("::ffff:127.0.0.1", "10.0.0.1, 198.51.100.1")), "198.51.100.1");
  assert.equal(requestSource(req("::1", " ::ffff:198.51.100.2 ")), "198.51.100.2");
  assert.equal(requestSource(req("127.0.0.1", "unknown")), "127.0.0.1");
  assert.equal(requestSource(req("127.0.0.1", "")), "127.0.0.1");
  assert.equal(requestSource(req("::1")), "::1");
  assert.equal(requestSource(req("2001:db8:a:b:c:d:e:f")), "2001:db8:a:b::/64");
  assert.equal(requestSource(req("2001:db8::1")), "2001:db8:0:0::/64");
  assert.equal(requestSource(req("::2:3:4:5:6:7:8")), "0:2:3:4::/64");
  assert.equal(requestSource(req("64:ff9b::192.0.2.1")), "64:ff9b:0:0::/64");
  assert.equal(requestSource(req("fe80::1%en0")), "fe80:0:0:0::/64");
  assert.equal(requestSource(req(undefined)), "unknown");
  assert.equal(requestSource(undefined), "unknown");
});

test("名册：共享 token 登录的窗口 auth=legacy、paired=false", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  registerDevice(win);
  const list = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online));
  const row = list.devices.find((d) => d.id === DEV);
  assert.equal(row.auth, "legacy");
  assert.equal(row.paired, false);
});

test("allowLegacyLocal=false：共享 token 登录被拒，配对和设备令牌登录照常；环境变量 PI_REMOTE_ALLOW_LEGACY_LOCAL=0 关掉它", async (t) => {
  const relay = await boot({ allowLegacyLocal: false });
  t.after(() => relay.close());
  const c = client(relay.localPort);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: "auth", role: "local", token: "lt" });
  const denied = await c.type("auth_result");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "auth_failed");
  assert.match(denied.error, /配对/);

  const v = await authedViewer(relay);
  t.after(() => v.close());
  const { result } = await pairDevice(relay, v);
  const { c: ok, auth } = await tokenLocal(relay, result.deviceId, result.deviceToken);
  t.after(() => ok.close());
  assert.equal(auth.ok, true);

  const prev = process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL;
  try {
    delete process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL;
    assert.equal(loadConfig().allowLegacyLocal, true, "兼容期默认还接受共享 token");
    process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL = "0";
    assert.equal(loadConfig().allowLegacyLocal, false);
    process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL = "false";
    assert.equal(loadConfig().allowLegacyLocal, false);
  } finally {
    if (prev == null) delete process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL;
    else process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL = prev;
  }
});

test("loadConfig 默认不落对话正文，只有 PI_REMOTE_PERSIST_TRANSCRIPTS=1/true 才打开", () => {
  const prev = process.env.PI_REMOTE_PERSIST_TRANSCRIPTS;
  try {
    delete process.env.PI_REMOTE_PERSIST_TRANSCRIPTS;
    assert.equal(loadConfig().persistTranscripts, false);
    process.env.PI_REMOTE_PERSIST_TRANSCRIPTS = "1";
    assert.equal(loadConfig().persistTranscripts, true);
    process.env.PI_REMOTE_PERSIST_TRANSCRIPTS = "true";
    assert.equal(loadConfig().persistTranscripts, true);
    process.env.PI_REMOTE_PERSIST_TRANSCRIPTS = "0";
    assert.equal(loadConfig().persistTranscripts, false);
  } finally {
    if (prev == null) delete process.env.PI_REMOTE_PERSIST_TRANSCRIPTS;
    else process.env.PI_REMOTE_PERSIST_TRANSCRIPTS = prev;
  }
  assert.equal(commandTimeoutMs("harness_start"), 10000);
  assert.equal(commandTimeoutMs("get_state"), 15000);
});

test("旧房间归未登记设备；room_register 带上账户和设备字段", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  ext.send({ type: "room_register", room: { id: ROOM, label: "旧", cwd: "D:\\work" } });
  await ext.type("room_registered");
  const list = await v.type("room_list", (f) => (f.rooms || []).some((r) => r.id === ROOM));
  const room = list.rooms.find((r) => r.id === ROOM);
  assert.equal(room.accountId, "admin");
  assert.equal(room.deviceId, "未登记设备");
  assert.equal(room.online, true);
  // 未登记设备的 online 由名下房间决定：房间在线时伪设备必须在线，否则设备模式下打不开、发不了
  assert.ok(list.devices.some((d) => d.id === "未登记设备" && d.online === true));

  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "新", cwd: "D:\\work", accountId: "admin", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  const again = await v.type("room_list", (f) => (f.rooms || []).some((r) => r.id === ROOM && r.deviceId === DEV));
  const updated = again.rooms.find((r) => r.id === ROOM);
  assert.equal(updated.deviceId, DEV);
  assert.equal(updated.label, "新");
});

test("device_register：登记、顶替、断开只改内存；未连接仍能 get_sessions", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "s", cwd: "D:\\work", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  await ext.type("room_registered");

  registerDevice(win);
  const listed = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online === true));
  const dev = listed.devices.find((d) => d.id === DEV);
  assert.equal(dev.name, "Windows");
  assert.equal(dev.platform, "windows");
  assert.deepEqual(dev.projects, ["D:\\work"]);
  assert.equal(listed.rooms.find((r) => r.id === ROOM).online, true);

  v.send({ type: "get_sessions", id: "g1", deviceId: DEV });
  const empty = await v.type("session_list", (f) => f.id === "g1");
  assert.deepEqual(empty.sessions, []);
  assert.equal(empty.truncated, false);

  const win2 = await authedLocal(relay);
  t.after(() => win2.close());
  registerDevice(win2, { name: "Windows-2" });
  const replaced = await win.type("device_replaced");
  assert.equal(replaced.type, "device_replaced");
  const still = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.name === "Windows-2" && d.online === true));
  assert.equal(still.rooms.find((r) => r.id === ROOM).online, true, "顶替窗口不能拆掉 pi 房间");

  win2.close();
  const offline = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online === false));
  assert.equal(offline.rooms.find((r) => r.id === ROOM).online, true, "窗口断开不清活动房间");
  assert.equal(offline.devices.find((d) => d.id === DEV).windowExpiresAt, null, "离线时不编造窗口剩余时间");
  v.send({ type: "get_sessions", id: "g2", deviceId: DEV });
  const stillListed = await v.type("session_list", (f) => f.id === "g2");
  assert.equal(stillListed.deviceId, DEV);
  assert.ok(Array.isArray(stillListed.sessions));

  const file = path.join(relay.cfg.accountsDir, safeKey("admin"), "devices.jsonl");
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes('"online"'), false);
});

test("session_manifest 写入清单；无关连接的帧丢弃；get_sessions 带 online / 截断 / no_device", async (t) => {
  const relay = await boot({ maxSessionsListed: 1 });
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  const stranger = await authedLocal(relay);
  t.after(() => stranger.close());
  registerDevice(win);
  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "A", cwd: "D:\\work", accountId: "admin", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  await ext.type("room_registered");

  stranger.send({
    type: "session_manifest",
    deviceId: DEV,
    full: true,
    updatedAt: 500,
    sessions: [{ id: "hijack", name: "NO", cwd: "D:\\work", updatedAt: 500 }],
  });
  ext.send({
    type: "session_manifest",
    accountId: "admin",
    deviceId: DEV,
    full: true,
    updatedAt: 100,
    sessions: [
      { id: ROOM, name: "A", cwd: "D:\\work", messageCount: 2, sizeBytes: 20, updatedAt: 20, active: true },
      { id: "sess-b", name: "B", cwd: "D:\\other", messageCount: 1, sizeBytes: 5, updatedAt: 10, active: false },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));
  v.send({ type: "get_sessions", id: "g1", deviceId: DEV });
  const page = await v.type("session_list", (f) => f.id === "g1");
  assert.equal(page.truncated, true);
  assert.equal(page.sessions.length, 1);
  assert.equal(page.sessions[0].id, ROOM);
  assert.equal(page.sessions[0].online, true);
  assert.equal(page.sessions[0].active, true);
  assert.equal(page.sessions.some((s) => s.id === "hijack"), false);

  v.send({ type: "get_sessions", id: "g0" });
  const missing = await v.type("error", (f) => f.id === "g0");
  assert.equal(missing.code, "no_device");
  assert.match(missing.message, /从未连接/);
  v.send({ type: "get_sessions", id: "g9", deviceId: "never" });
  const never = await v.type("error", (f) => f.id === "g9");
  assert.equal(never.code, "no_device");
});

test("fork 谱系端到端（第 3 轮审查 C-1）：manifest 的 parentSession 经落盘与 viewer session_list 两跳不丢", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  registerDevice(win);
  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "A", cwd: "/work", accountId: "admin", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  await ext.type("room_registered");

  // 扩展帧（session_manifest）→ relay 落盘（AccountIndex）→ viewer get_sessions → session_list，全链一例到底
  ext.send({
    type: "session_manifest",
    accountId: "admin",
    deviceId: DEV,
    full: true,
    updatedAt: 100,
    sessions: [
      { id: "sess-parent", path: "/s/parent.jsonl", name: "父", cwd: "/work", messageCount: 3, sizeBytes: 30, updatedAt: 30, active: false },
      { id: "sess-kid", path: "/s/kid.jsonl", name: "子", cwd: "/work", parentSession: "/s/parent.jsonl", messageCount: 1, sizeBytes: 10, updatedAt: 20, active: false },
      { id: "sess-solo", path: "/s/solo.jsonl", name: "独", cwd: "/work", messageCount: 1, sizeBytes: 5, updatedAt: 10, active: false },
    ],
  });
  await new Promise((r) => setTimeout(r, 30));
  v.send({ type: "get_sessions", id: "g1", deviceId: DEV });
  const page = await v.type("session_list", (f) => f.id === "g1");
  const byId = Object.fromEntries(page.sessions.map((s) => [s.id, s]));
  assert.equal(byId["sess-kid"].parentSession, "/s/parent.jsonl", "fork 行父指针经落盘 + viewer 映射两跳不丢（C-1 漏的是 viewer 这一跳）");
  assert.equal(byId["sess-parent"].parentSession, null, "父会话本身无父指针，帧上为 null");
  assert.equal(byId["sess-solo"].parentSession, null, "非 fork 行帧上为 null（字段必须在，UI 靠它区分无父与未知）");
});

test("A-1 门控·设备窗口：窗口连接不声明 cap，广播清单剥 lastTurnEnd；声明端同刻拿到摘要", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  registerDevice(win);
  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "A", cwd: "/work", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  await ext.type("room_registered");

  const ev = (event) => ext.send({ type: "event", room: ROOM, event });
  ev({ type: "agent_start" });
  ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1, stopReason: "stop" } });
  ev({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 30));

  // 声明端此刻 auth 快照里摘要是 done——证明摘要确实存在，窗口拿到的是剥离版而非"本来就没有"
  const v = client(relay.viewerPort);
  t.after(() => v.close());
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt", caps: ["room.attention"] });
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  assert.equal((auth.rooms || []).find((r) => r.id === ROOM).lastTurnEnd.kind, "done");

  // 改名触发 broadcastRoomList：窗口经 deviceConns 通道收到清单，条目不得带 lastTurnEnd
  const before = win.frames.filter((f) => f.type === "room_list").length;
  ext.send({ type: "room_label", room: ROOM, label: "A2" });
  await new Promise((r) => setTimeout(r, 250));
  const lists = win.frames.filter((f) => f.type === "room_list");
  assert.ok(lists.length > before, "窗口收到广播清单");
  const entry = (lists[lists.length - 1].rooms || []).find((r) => r.id === ROOM);
  assert.ok(entry, "窗口清单含本机房间");
  assert.ok(!("lastTurnEnd" in entry), "设备窗口（未声明 cap）的清单条目剥摘要字段");
  assert.equal(entry.online, true, "只剥新面：在线状态照常");
});

test("command 按 deviceId 寻址：离线、无活动会话、白名单、转发到活动房间", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());

  v.send({ type: "command", id: "c0", deviceId: "never", command: "get_state", args: {} });
  const none = await v.type("ack", (f) => f.id === "c0");
  assert.equal(none.ok, false);
  assert.equal(none.code, "no_device");

  const win = await authedLocal(relay);
  t.after(() => win.close());
  registerDevice(win);
  await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online === true));
  v.send({ type: "command", id: "c1", deviceId: DEV, command: "get_state", args: {} });
  const idle = await v.type("ack", (f) => f.id === "c1");
  assert.equal(idle.ok, false);
  assert.equal(idle.code, "device_no_active_session");

  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "A", cwd: "D:\\work", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  await ext.type("room_registered");

  v.send({ type: "command", id: "c2", deviceId: DEV, command: "prompt", args: { message: "hi" } });
  const denied = await v.type("ack", (f) => f.id === "c2");
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "该命令必须指定房间");
  assert.equal(denied.code, "bad_args");
  assert.equal(ext.frames.some((f) => f.type === "command"), false);

  v.send({ type: "command", id: "c3", deviceId: DEV, command: "switch_session", args: { sessionPath: "C:/a.jsonl" } });
  const accepted = await v.type("command_accepted", (f) => f.id === "c3");
  assert.equal(accepted.timeoutMs, 30000);
  assert.equal(accepted.room, ROOM);
  const forwarded = await ext.type("command");
  assert.equal(forwarded.command, "switch_session");
  assert.equal(forwarded.room, ROOM);
  assert.equal(forwarded.deviceId, DEV);
  assert.equal(win.frames.some((f) => f.type === "command"), false);
  ext.send({ type: "command_result", room: ROOM, id: forwarded.id, ok: true, data: { n: 1 } });
  const ack = await v.type("ack", (f) => f.id === "c3");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, { n: 1 });

  win.close();
  await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online === false));
  v.send({ type: "command", id: "c4", deviceId: DEV, command: "get_state", args: {} });
  const off = await v.type("ack", (f) => f.id === "c4");
  assert.equal(off.ok, false);
  assert.equal(off.code, "device_offline");
  assert.match(off.error, /attach 窗口/);
});

test("harness_start：预判、校验、串行、超时、spawn_failed，并转给窗口连接", async (t) => {
  const relay = await boot({ harnessStartTimeoutMs: 120 });
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  registerDevice(win, { projects: ["D:\\work", "D:\\work\\sub", "D:\\work\\fresh", "D:\\work\\next"] });
  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "A", cwd: "D:\\work", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  await ext.type("room_registered");
  ext.send({
    type: "session_manifest",
    deviceId: DEV,
    full: true,
    updatedAt: 50,
    sessions: [
      { id: ROOM, name: "A", cwd: "D:\\work", updatedAt: 20, active: true },
      { id: "sess-b", name: "B", cwd: "D:\\other", updatedAt: 10, active: false },
    ],
  });
  await new Promise((r) => setTimeout(r, 20));

  v.send({ type: "command", id: "h0", deviceId: DEV, command: "harness_start", args: {} });
  const badArgs = await v.type("ack", (f) => f.id === "h0");
  assert.equal(badArgs.ok, false);
  assert.match(badArgs.error, /二选一/);
  assert.equal(badArgs.code, "bad_args");

  v.send({ type: "command", id: "h1", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\work", sessionId: ROOM } });
  const both = await v.type("ack", (f) => f.id === "h1");
  assert.equal(both.ok, false);

  v.send({ type: "command", id: "h2", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\workshop" } });
  const cwdNo = await v.type("ack", (f) => f.id === "h2");
  assert.equal(cwdNo.code, "cwd_not_allowed");

  v.send({ type: "command", id: "h3", deviceId: DEV, command: "harness_start", args: { sessionId: "missing" } });
  const noSess = await v.type("ack", (f) => f.id === "h3");
  assert.equal(noSess.code, "session_not_found");

  v.send({ type: "command", id: "h4", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\work" } });
  const running = await v.type("ack", (f) => f.id === "h4");
  assert.equal(running.ok, true);
  assert.equal(running.data.status, "already_running");
  assert.equal(running.data.roomId, ROOM);
  assert.equal(win.frames.some((f) => f.type === "command"), false, "已有在线房间时不转给本机");

  // 关掉活动房间后再测真正的转发。already_running 看的是 cwd 精确匹配，子目录不会命中。
  ext.send({ type: "room_closed", room: ROOM });
  await v.type("room_list", (f) => (f.rooms || []).every((r) => r.id !== ROOM || r.online === false));

  v.send({ type: "command", id: "h5no", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\work\\nope" } });
  const nope = await v.type("ack", (f) => f.id === "h5no");
  assert.equal(nope.code, "cwd_not_allowed");

  v.send({ type: "command", id: "h5", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\work\\sub" } });
  const accepted = await v.type("command_accepted", (f) => f.id === "h5");
  assert.equal(accepted.timeoutMs, 120);
  const forwarded = await win.type("command", (f) => f.command === "harness_start");
  assert.equal(forwarded.deviceId, DEV);
  assert.equal(forwarded.args.cwd, "D:\\work\\sub");
  assert.equal(ext.frames.some((f) => f.type === "command" && f.command === "harness_start"), false);

  v.send({ type: "command", id: "h6", deviceId: DEV, command: "harness_start", args: { sessionId: "sess-b" } });
  const busy = await v.type("ack", (f) => f.id === "h6");
  assert.equal(busy.ok, false);
  assert.match(busy.error, /正在启动/);
  assert.equal(busy.code, "harness_busy");
  assert.equal(busy.retryable, true);

  win.send({ type: "command_result", id: forwarded.id, ok: false, code: "spawn_failed", error: "端口被占" });
  const failed = await v.type("ack", (f) => f.id === "h5");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "spawn_failed");
  assert.match(failed.error, /端口被占/);

  v.send({ type: "command", id: "h7", deviceId: DEV, command: "harness_start", args: { sessionId: "sess-b" } });
  const again = await win.type("command", (f) => f.command === "harness_start" && f.args && f.args.sessionId === "sess-b");
  win.send({ type: "command_result", id: again.id, ok: true, data: { status: "started" } });
  const started = await v.type("ack", (f) => f.id === "h7");
  assert.equal(started.ok, true);
  assert.equal(started.data.status, "started");

  v.send({ type: "command", id: "h8", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\work\\fresh" } });
  await win.type("command", (f) => f.args && f.args.cwd === "D:\\work\\fresh");
  const timed = await v.type("ack", (f) => f.id === "h8");
  assert.equal(timed.ok, false);
  assert.match(timed.error, /超时/);
  assert.equal(timed.code, "timeout");
  assert.equal(timed.retryable, true);
  assert.equal(relay.devices.get(DEV).startInFlight, false);

  v.send({ type: "command", id: "h9", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\work\\next" } });
  await win.type("command", (f) => f.args && f.args.cwd === "D:\\work\\next");
});

test("harness_start 默认超时 10s（command_accepted.timeoutMs）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  registerDevice(win);
  v.send({ type: "command", id: "h", deviceId: DEV, command: "harness_start", args: { cwd: "D:\\work" } });
  const accepted = await v.type("command_accepted", (f) => f.id === "h");
  assert.equal(accepted.timeoutMs, 10000);
});

test("不落盘时在线房间向本机要快照；超时给 snapshotPending；快照后到则替换", async (t) => {
  const relay = await boot({ resendSnapshotWaitMs: 80, persistTranscripts: false });
  t.after(() => relay.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  ext.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp" } });
  await ext.type("room_registered");
  const v = await authedViewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  const ask = await ext.type("resend_snapshot");
  assert.equal(ask.room, ROOM);
  const pending = await v.type("snapshot");
  assert.equal(pending.snapshotPending, true);
  assert.deepEqual(pending.messages, []);

  const relay2 = await boot({ resendSnapshotWaitMs: 400, persistTranscripts: false });
  t.after(() => relay2.close());
  const ext2 = await authedLocal(relay2);
  t.after(() => ext2.close());
  ext2.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp" } });
  await ext2.type("room_registered");
  const v2 = await authedViewer(relay2);
  t.after(() => v2.close());
  v2.send({ type: "subscribe", room: ROOM });
  await ext2.type("resend_snapshot");
  ext2.send({
    type: "snapshot",
    room: ROOM,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
  });
  const snap = await v2.type("snapshot");
  assert.equal(snap.snapshotPending, undefined);
  assert.equal(snap.messages.length, 1);
  assert.equal(snap.messages[0].content[0].text, "hello");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(v2.frames.some((f) => f.type === "snapshot" && f.snapshotPending), false);
});

test("默认不把对话正文写入 data/rooms，活动会话的事件仍转发给观众", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  ext.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp" } });
  await ext.type("room_registered");
  const v = await authedViewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  ext.send({ type: "event", room: ROOM, event: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } } });
  const ev = await v.type("room_event", (f) => f.event && f.event.type === "message_end");
  assert.equal(ev.event.message.content[0].text, "hi");
  assert.equal(ev.seq, 1);
  const jsonl = fs.readdirSync(relay.cfg.dataDir).filter((name) => name.endsWith(".jsonl"));
  assert.deepEqual(jsonl, []);
});

test("设备窗口收到的 room_list 只含本设备的设备项和房间，不含别的设备/账号", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const mine = await authedLocal(relay);
  t.after(() => mine.close());
  const other = await authedLocal(relay);
  t.after(() => other.close());
  const extA = await authedLocal(relay);
  t.after(() => extA.close());
  const extB = await authedLocal(relay);
  t.after(() => extB.close());
  registerDevice(mine, { id: "dev-a" });
  registerDevice(other, { id: "dev-b", accountId: "bob", projects: ["E:\\secret"] });
  extA.send({ type: "room_register", room: { id: "room-a", label: "a", cwd: "D:\\work", deviceId: "dev-a" } });
  await extA.type("room_registered");
  extB.send({ type: "room_register", room: { id: "room-b", label: "b", cwd: "E:\\secret", deviceId: "dev-b" } });
  await extB.type("room_registered");
  // viewer 仍能看到全部
  await v.type("room_list", (f) => (f.rooms || []).some((r) => r.id === "room-a") && (f.rooms || []).some((r) => r.id === "room-b"));
  const a = await mine.type("room_list", (f) => (f.rooms || []).some((r) => r.id === "room-a"));
  assert.deepEqual(a.rooms.map((r) => r.id), ["room-a"], "只发本设备的房间");
  assert.deepEqual(a.devices.map((d) => d.id), ["dev-a"], "只发本设备的设备项");
  const b = await other.type("room_list", (f) => (f.rooms || []).some((r) => r.id === "room-b"));
  assert.deepEqual(b.rooms.map((r) => r.id), ["room-b"]);
  for (const f of mine.frames.filter((x) => x.type === "room_list")) {
    assert.equal(JSON.stringify(f).includes("E:\\\\secret"), false, "别的设备的 cwd 不能发给本设备窗口");
  }
});

test("账号由服务端绑定：新设备首次登记、房间、清单都不采信上报的 accountId", async (t) => {
  const dataDir = tmpDir();
  const relay = await boot({ dataDir });
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  registerDevice(win, { id: "dev-new", accountId: "evil" });
  const listed = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === "dev-new" && d.online));
  assert.equal(listed.devices.find((d) => d.id === "dev-new").accountId, "admin", "首次登记也不能按上报的账号落");
  ext.send({ type: "room_register", room: { id: "room-x", label: "x", cwd: "D:\\work", accountId: "evil", deviceId: "dev-new" } });
  await ext.type("room_registered");
  const withRoom = await v.type("room_list", (f) => (f.rooms || []).some((r) => r.id === "room-x"));
  assert.equal(withRoom.rooms.find((r) => r.id === "room-x").accountId, "admin", "房间账号按设备绑定");
  win.send({ type: "session_manifest", accountId: "evil", deviceId: "dev-new", full: true, updatedAt: 100, sessions: [{ id: "s1", name: "A", cwd: "D:\\work", updatedAt: 10 }] });
  await new Promise((r) => setTimeout(r, 50));
  const idx = new AccountIndex(path.join(dataDir, "accounts"));
  assert.ok(idx.getDeviceRow("admin", "dev-new"), "设备写进服务端绑定的账号");
  assert.equal(idx.getDeviceRow("evil", "dev-new"), null, "上报的账号里不能出现这台设备");
  assert.ok(idx.getSession("admin", "dev-new", "s1"), "清单写进绑定的账号");
  assert.equal(fs.existsSync(path.join(dataDir, "accounts", safeKey("evil"))), false, "不能因为上报就建出别的账号目录");
});

test("账号绑定：relay 可配置账号（cfg.accountId）；已登记设备沿用原账号（兼容）", async (t) => {
  const dataDir = tmpDir();
  // 旧版 relay 已把 dev-old 登记在 bob 名下
  const seed = new AccountIndex(path.join(dataDir, "accounts"));
  seed.touchAccount("bob", 1);
  seed.upsertDevice("bob", { id: "dev-old", name: "旧机", platform: "windows", projects: [], lastAttachAt: 1, updatedAt: 1 });
  const relay = await boot({ dataDir, accountId: "alice" });
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const oldWin = await authedLocal(relay);
  t.after(() => oldWin.close());
  const newWin = await authedLocal(relay);
  t.after(() => newWin.close());
  registerDevice(oldWin, { id: "dev-old", accountId: "admin" });
  registerDevice(newWin, { id: "dev-a", accountId: "admin" });
  const listed = await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === "dev-a" && d.online));
  assert.equal(listed.devices.find((d) => d.id === "dev-a").accountId, "alice", "新设备落到 relay 配置的账号");
  await new Promise((r) => setTimeout(r, 30));
  const idx = new AccountIndex(path.join(dataDir, "accounts"));
  assert.ok(idx.getDeviceRow("bob", "dev-old"), "已登记设备沿用原账号");
  assert.equal(idx.getDeviceRow("admin", "dev-old"), null);
  assert.ok(idx.getDeviceRow("alice", "dev-a"));
  // viewer 不带 accountId 查清单：默认按 relay 配置的账号
  v.send({ type: "get_sessions", id: "g-a", deviceId: "dev-a" });
  const page = await v.type("session_list", (f) => f.id === "g-a");
  assert.equal(page.deviceId, "dev-a");
  assert.ok(Array.isArray(page.sessions));
});

test("loadConfig：accountId 缺省 admin，PI_REMOTE_RELAY_ACCOUNT 可覆盖", () => {
  const prev = process.env.PI_REMOTE_RELAY_ACCOUNT;
  try {
    delete process.env.PI_REMOTE_RELAY_ACCOUNT;
    assert.equal(loadConfig().accountId, "admin");
    process.env.PI_REMOTE_RELAY_ACCOUNT = " team ";
    assert.equal(loadConfig().accountId, "team");
  } finally {
    if (prev === undefined) delete process.env.PI_REMOTE_RELAY_ACCOUNT;
    else process.env.PI_REMOTE_RELAY_ACCOUNT = prev;
  }
});

test("多平台：平台名归一，路径大小写按设备平台比，白名单有上限", () => {
  assert.equal(normalizePlatform("darwin"), "macos", "旧扩展在 macOS 上报 Node 的 darwin");
  assert.equal(normalizePlatform(" MacOS "), "macos");
  assert.equal(normalizePlatform("win32"), "windows");
  assert.equal(normalizePlatform("linux"), "linux");
  assert.equal(normalizePlatform("Free BSD!"), "freebsd");
  assert.equal(normalizePlatform(""), "");
  assert.equal(normalizePlatform(42), "");

  assert.equal(cwdAllowed(["D:\\Work"], "d:/work/", "windows"), true);
  assert.equal(cwdAllowed(["/Users/user/App"], "/users/user/app", "macos"), true, "APFS 默认不分大小写");
  assert.equal(cwdAllowed(["/srv/App"], "/srv/app", "linux"), false, "Linux 区分大小写");
  assert.equal(cwdAllowed(["/srv/App"], "/srv/App/", "linux"), true);
  assert.equal(cwdAllowed(["/srv/a\\b"], "/srv/a/b", "linux"), false, "POSIX 上反斜杠是普通字符");
  assert.equal(cwdAllowed(["D:\\Work"], "d:/work", ""), true, "平台未知（老设备）沿用旧规则");
  assert.equal(normPath("/srv/X//", "linux"), "/srv/X");

  const many = Array.from({ length: 100 }, (_, i) => `/p/${i}`);
  assert.equal(cleanProjects(many).length, 64);
  assert.deepEqual(cleanProjects([" /a ", "/a", "", 5, null, "x".repeat(2000), "/b"]), ["/a", "/b"]);
  assert.deepEqual(cleanProjects("not-a-list"), []);
});

test("Windows、Mac、Linux 三台设备同时在线：名册平台统一，harness_start 按各自平台判白名单与已在运行", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const wins = [];
  for (const [id, name, platform, projects] of [
    ["dev-win", "Windows", "windows", ["D:\\Work"]],
    ["dev-mac", "Mac", "darwin", ["/Users/user/CLI/Pi-Remote"]],
    ["dev-linux", "Linux", "linux", ["/srv/App", "/srv/app"]],
  ]) {
    const w = await authedLocal(relay);
    t.after(() => w.close());
    registerDevice(w, { id, name: name + " ".repeat(3) + "x".repeat(100), platform, projects });
    wins.push(w);
  }
  const listed = await v.type("room_list", (f) => (f.devices || []).filter((d) => d.online).length === 3);
  const byId = Object.fromEntries(listed.devices.map((d) => [d.id, d]));
  assert.equal(byId["dev-win"].platform, "windows");
  assert.equal(byId["dev-mac"].platform, "macos", "darwin 归一成 macos");
  assert.equal(byId["dev-linux"].platform, "linux");
  assert.equal(byId["dev-mac"].name.length, 64, "设备名截到 64 字符");

  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  ext.send({ type: "room_register", room: { id: "mac-room", label: "m", cwd: "/Users/user/CLI/Pi-Remote", deviceId: "dev-mac", deviceName: "Mac", platform: "darwin" } });
  await ext.type("room_registered");
  assert.equal(relay.rooms.peek("mac-room").platform, "macos");

  v.send({ type: "command", id: "m1", deviceId: "dev-mac", command: "harness_start", args: { cwd: "/users/user/cli/pi-remote" } });
  const macRunning = await v.type("ack", (f) => f.id === "m1");
  assert.equal(macRunning.ok, true);
  assert.equal(macRunning.data.status, "already_running", "macOS 上大小写不同也是同一个目录");
  assert.equal(macRunning.data.roomId, "mac-room");

  v.send({ type: "command", id: "l1", deviceId: "dev-linux", command: "harness_start", args: { cwd: "/srv/APP" } });
  const linuxNo = await v.type("ack", (f) => f.id === "l1");
  assert.equal(linuxNo.code, "cwd_not_allowed", "Linux 白名单区分大小写");

  v.send({ type: "command", id: "l2", deviceId: "dev-linux", command: "harness_start", args: { cwd: "/srv/app" } });
  const fwd = await wins[2].type("command", (f) => f.command === "harness_start");
  assert.equal(fwd.args.cwd, "/srv/app", "转给 Linux 设备自己的窗口");
  assert.equal(wins[0].frames.some((f) => f.type === "command"), false);
  assert.equal(wins[1].frames.some((f) => f.type === "command"), false);
});


test("设备名册 firstSeenAt：首次 upsert 写入、后续 attach 保留，重启后仍持久", () => {
  const dir = path.join(tmpDir(), "accounts");
  const idx = new AccountIndex(dir);
  idx.upsertDevice("admin", { id: "d1", name: "A", platform: "linux", pairedAt: 100, updatedAt: 100 }, 100);
  assert.equal(idx.getDeviceRow("admin", "d1").firstSeenAt, 100, "首次登记即写入");
  idx.upsertDevice("admin", { id: "d1", name: "A2", platform: "linux", lastAttachAt: 900, pairedAt: 400, updatedAt: 900 }, 900);
  assert.equal(idx.getDeviceRow("admin", "d1").firstSeenAt, 100, "后续 attach 不能重写首次连接时间");
  assert.equal(new AccountIndex(dir).getDeviceRow("admin", "d1").firstSeenAt, 100, "首次连接时间要持久到名册文件");
});

test("设备名册 firstSeenAt：老行升级时按 pairedAt || lastAttachAt 回退，不写 now", () => {
  const dir = path.join(tmpDir(), "accounts");
  const accountDir = path.join(dir, safeKey("admin"));
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(
    path.join(accountDir, "devices.jsonl"),
    [
      JSON.stringify({ kind: "device", id: "old-paired", name: "Old", platform: "linux", projects: [], pairedAt: 50, lastAttachAt: 80, updatedAt: 80 }),
      JSON.stringify({ kind: "device", id: "old-attach", name: "Legacy", platform: "linux", projects: [], pairedAt: 0, lastAttachAt: 70, updatedAt: 70 }),
    ].join("\n") + "\n",
    "utf8",
  );
  const idx = new AccountIndex(dir);
  idx.upsertDevice("admin", { id: "old-paired", name: "Old", platform: "linux", lastAttachAt: 900, updatedAt: 900 }, 900);
  assert.equal(idx.getDeviceRow("admin", "old-paired").firstSeenAt, 50, "老行沿用配对时间");
  idx.upsertDevice("admin", { id: "old-attach", name: "Legacy", platform: "linux", lastAttachAt: 900, updatedAt: 900 }, 900);
  assert.equal(idx.getDeviceRow("admin", "old-attach").firstSeenAt, 70, "pairedAt 为 0 / 缺失时继续回退 lastAttachAt");
});

test("buildDeviceList：下发 firstSeenAt，老数据回退 pairedAt || lastAttachAt，不伪造时间", () => {
  const rows = [
    { id: "new", name: "New", platform: "linux", projects: [], firstSeenAt: 10, pairedAt: 50, lastAttachAt: 80 },
    { id: "legacy-paired", name: "Legacy Paired", platform: "linux", projects: [], pairedAt: 50, lastAttachAt: 80 },
    { id: "legacy-attach", name: "Legacy Attach", platform: "linux", projects: [], lastAttachAt: 80 },
    { id: "unknown", name: "Unknown", platform: "linux", projects: [] },
  ];
  const index = { listDevices: () => rows, hasDeviceToken: () => false };
  const list = buildDeviceList(index, new Map(), { map: new Map() }, "admin");
  const byId = Object.fromEntries(list.map((device) => [device.id, device]));
  assert.equal(byId.new.firstSeenAt, 10, "新行优先用持久 firstSeenAt");
  assert.equal(byId["legacy-paired"].firstSeenAt, 50, "老行先回退 pairedAt");
  assert.equal(byId["legacy-attach"].firstSeenAt, 80, "没有 pairedAt 再回退 lastAttachAt");
  assert.equal(byId.unknown.firstSeenAt, 0, "都没有就是未知，不能拿 now 伪造");

  const mem = new Map([["mem-only", { accountId: "admin", name: "Mem", platform: "linux", online: true, projects: [], lastAttachAt: 70 }]]);
  const memList = buildDeviceList({ listDevices: () => [], hasDeviceToken: () => false }, mem, { map: new Map() }, "admin");
  assert.equal(memList[0].id, "mem-only");
  assert.equal(memList[0].firstSeenAt, 70, "只在内存里的设备也用真实 lastAttachAt 回退");
});

test("buildDeviceList：latencyMs 只在线且有样本时下发整数，离线/无样本给 null，不伪造", () => {
  const conn = (state) => ({ _state: state });
  const rows = [
    { id: "sampled", name: "Sampled", platform: "linux", projects: [] },
    { id: "no-sample", name: "No Sample", platform: "linux", projects: [] },
    { id: "offline", name: "Offline", platform: "linux", projects: [] },
    { id: "no-state", name: "No State", platform: "linux", projects: [] },
  ];
  const devices = new Map([
    // 平滑后的浮点值：下发一律取整（设计稿「延迟 38ms」是整数毫秒）
    ["sampled", { accountId: "admin", online: true, conn: conn({ latencyMs: 38.4 }) }],
    ["no-sample", { accountId: "admin", online: true, conn: conn({ latencyMs: null }) }],
    // 离线设备哪怕连接对象上还有上一轮的样本，也不能下发
    ["offline", { accountId: "admin", online: false, conn: conn({ latencyMs: 12 }) }],
    ["no-state", { accountId: "admin", online: true, conn: {} }],
  ]);
  const index = { listDevices: () => rows, hasDeviceToken: () => false };
  const list = buildDeviceList(index, devices, { map: new Map() }, "admin");
  const byId = Object.fromEntries(list.map((device) => [device.id, device]));

  assert.equal(byId.sampled.latencyMs, 38, "在线且有样本：整数毫秒");
  assert.equal(byId["no-sample"].latencyMs, null, "刚连上还没 pong 过：null，不写 0");
  assert.equal(byId.offline.latencyMs, null, "离线不下发延迟");
  assert.equal(byId["no-state"].latencyMs, null, "连接还没 attachCommon 时没有样本");
  // 其它字段语义不变：延迟只是加了一个字段
  assert.equal(byId.sampled.online, true);
  assert.equal(byId.offline.online, false);
  assert.equal(byId.sampled.name, "Sampled");
});

test("buildDeviceList：latencyMs 在内存名册分支同样下发；0ms（本机回环）是有效样本", () => {
  const mem = new Map([
    ["mem-online", { accountId: "admin", name: "Mem", platform: "linux", online: true, conn: { _state: { latencyMs: 0 } } }],
    ["mem-offline", { accountId: "admin", name: "Mem2", platform: "linux", online: false, conn: null }],
  ]);
  const list = buildDeviceList({ listDevices: () => [], hasDeviceToken: () => false }, mem, { map: new Map() }, "admin");
  const byId = Object.fromEntries(list.map((device) => [device.id, device]));
  assert.equal(byId["mem-online"].latencyMs, 0, "0ms 也是真实样本，不能当成「没有」");
  assert.equal(byId["mem-offline"].latencyMs, null);

  // 未登记设备的条目仍固定为 {id, online}：不给它编延迟
  const rooms = { map: new Map([["room-x", { id: "room-x", online: true, deviceId: null }]]) };
  const withUnreg = buildDeviceList({ listDevices: () => [], hasDeviceToken: () => false }, new Map(), rooms, "admin");
  const unreg = withUnreg.find((device) => device.id === "未登记设备");
  assert.deepEqual(unreg, { id: "未登记设备", online: true }, "契约 §4.2 的固定形状不能被新字段撑开");
});

test("fork 谱系（R3-3）：清单行 parentSession 经 _sessionFrom 白名单落盘透传；增量帧缺字段沿用旧值", () => {
  const idx = new AccountIndex(path.join(tmpDir(), "accounts"));
  const first = idx.applyManifest("admin", "dev-1", {
    full: true,
    updatedAt: 100,
    sessions: [
      { id: "kid", path: "/s/kid.jsonl", name: "子", cwd: "/w", parentSession: "/s/parent.jsonl", updatedAt: 10, messageCount: 1 },
      { id: "solo", path: "/s/solo.jsonl", name: "独", cwd: "/w", updatedAt: 9, messageCount: 1 },
    ],
  }, 1000);
  assert.equal(first.ok, true);
  assert.equal(idx.getSession("admin", "dev-1", "kid").parentSession, "/s/parent.jsonl", "白名单不透传则 UI 永远拿不到父指针");
  assert.equal(idx.getSession("admin", "dev-1", "solo").parentSession, null, "非 fork 会话为 null");
  // 增量帧该行不带 parentSession → 沿用已存值，不被冲掉
  const second = idx.applyManifest("admin", "dev-1", {
    full: false,
    updatedAt: 200,
    sessions: [{ id: "kid", path: "/s/kid.jsonl", name: "子改名", cwd: "/w", updatedAt: 20, messageCount: 2 }],
  }, 2000);
  assert.equal(second.ok, true);
  assert.equal(idx.getSession("admin", "dev-1", "kid").parentSession, "/s/parent.jsonl");
  assert.equal(idx.getSession("admin", "dev-1", "kid").name, "子改名");
});

test("fork 谱系（第 3 轮审查 C-4）：显式 null 清掉已存父指针；空串归一为 null；缺省仍沿用", () => {
  const idx = new AccountIndex(path.join(tmpDir(), "accounts"));
  idx.applyManifest("admin", "dev-1", {
    full: true,
    updatedAt: 100,
    sessions: [{ id: "kid", path: "/s/kid.jsonl", name: "子", cwd: "/w", parentSession: "/s/parent.jsonl", updatedAt: 10, messageCount: 1 }],
  }, 1000);
  assert.equal(idx.getSession("admin", "dev-1", "kid").parentSession, "/s/parent.jsonl");
  // 显式 null = 父指针已不存在，必须盖掉旧值（旧写法 src.parentSession != null 把它与缺省混同，旧值永存）
  const cleared = idx.applyManifest("admin", "dev-1", {
    full: false,
    updatedAt: 200,
    sessions: [{ id: "kid", path: "/s/kid.jsonl", name: "子", cwd: "/w", parentSession: null, updatedAt: 20, messageCount: 2 }],
  }, 2000);
  assert.equal(cleared.ok, true);
  assert.equal(idx.getSession("admin", "dev-1", "kid").parentSession, null, "显式 null 清掉父指针");
  // 重新带上字符串 = 新父指针；其后再给空串 = 归一为 null
  idx.applyManifest("admin", "dev-1", {
    full: false,
    updatedAt: 300,
    sessions: [{ id: "kid", path: "/s/kid.jsonl", name: "子", cwd: "/w", parentSession: "/s/other.jsonl", updatedAt: 30, messageCount: 3 }],
  }, 3000);
  assert.equal(idx.getSession("admin", "dev-1", "kid").parentSession, "/s/other.jsonl");
  idx.applyManifest("admin", "dev-1", {
    full: false,
    updatedAt: 400,
    sessions: [{ id: "kid", path: "/s/kid.jsonl", name: "子", cwd: "/w", parentSession: "", updatedAt: 40, messageCount: 4 }],
  }, 4000);
  assert.equal(idx.getSession("admin", "dev-1", "kid").parentSession, null, "空串归一为 null");
});

test("R4-2 正文搜索全链：viewer 设备命令 → relay 慢读路由 → 扩展回包透传，relay 不落盘正文", async (t) => {
  const dataDir = tmpDir();
  const relay = await boot({ dataDir });
  t.after(() => relay.close());
  const v = await authedViewer(relay);
  t.after(() => v.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  registerDevice(win);
  const ext = await authedLocal(relay);
  t.after(() => ext.close());
  ext.send({
    type: "room_register",
    room: { id: ROOM, label: "A", cwd: "/work", deviceId: DEV, deviceName: "Windows", platform: "windows" },
  });
  await ext.type("room_registered");
  await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === DEV && d.online === true));

  // 设备离线/无活动会话的诚实态由既有路由保证；这里验有活动房间时的正链
  const SNIPPET = "这块紫水晶的成色不错";
  v.send({ type: "command", id: "bs1", deviceId: DEV, command: "search_session_bodies", args: { query: "紫水晶" } });
  const accepted = await v.type("command_accepted", (f) => f.id === "bs1");
  assert.equal(accepted.timeoutMs, 30000, "慢读命令 30s 口径经 command_accepted 下发");
  assert.equal(accepted.room, ROOM);
  const forwarded = await ext.type("command", (f) => f.command === "search_session_bodies");
  assert.deepEqual(forwarded.args, { query: "紫水晶" }, "参数原样转发");
  const page = {
    query: "紫水晶",
    results: [{ session: "/s/body.jsonl", id: "body-1", title: "宝石会话", cwd: "/work/b", mtime: 42, matchCount: 1, snippets: [{ text: SNIPPET, entryId: "a1" }] }],
    truncated: false,
    scannedFiles: 3,
    totalFiles: 3,
  };
  ext.send({ type: "command_result", room: ROOM, id: forwarded.id, ok: true, data: page });
  const ack = await v.type("ack", (f) => f.id === "bs1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, page, "片段回包原样透传，relay 不改写");

  // 红线：正文片段只透传——relay 数据目录里任何文件都不得出现片段文本
  await new Promise((r) => setTimeout(r, 60));
  const stack = [dataDir];
  let persisted = "";
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else {
        const text = fs.readFileSync(p, "utf8");
        if (text.includes(SNIPPET) || text.includes("紫水晶")) persisted = p;
      }
    }
  }
  assert.equal(persisted, "", "relay 落盘文件不得含正文片段：" + persisted);
});
