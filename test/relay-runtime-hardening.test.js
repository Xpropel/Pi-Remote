"use strict";
/**
 * relay 运行时/协议中危修复的回归测试（报告 relay 中-4/6/7/8/9/11/12/13/14/15/16、低-10，
 * 合并高危 relay 高-3 的负时区校验）。
 *
 * 全部用单元测试 + 真实 startRelay 的最小 ws 拓扑，不跑 UI/e2e。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const WebSocket = require("ws");

const { startRelay } = require("../relay/server.js");
const { DEFAULT_CONFIG, loadConfig, sanitizeTypedConfig } = require("../relay/config.js");
const { purgeSessions } = require("../relay/purge.js");
const { ARCHIVE_MAX_SESSIONS, storeSessionArchive, broadcastSessionArchive } = require("../relay/sessionArchive.js");
const { keepaliveSweep } = require("../relay/conn.js");
const { send } = require("../relay/wire.js");
const { pruneDedupe, dedupeKeyOf } = require("../relay/commands.js");
const { validateUsageSnapshot } = require("../relay/usage.js");
const { AccountIndex } = require("../relay/index.js");

const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";
const ADMIN_TOKEN = "test-admin-token-4d9c2e";
const ROOM = "room-runtime-fixes";

function tmpDir(prefix = "pi-relay-fixes-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function boot(overrides = {}) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: true,
    ...overrides,
  });
}

function wsClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const frames = [];
    const waiters = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      frames.push(msg);
      for (const w of [...waiters]) {
        if (!w.pred(msg)) continue;
        w.taken = true;
        msg.__taken = true;
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
        break;
      }
    });
    ws.once("error", reject);
    ws.once("open", () => resolve({
      ws,
      frames,
      send(obj) { ws.send(JSON.stringify(obj)); },
      wait(pred, ms = 4000, what = "frame") {
        const hit = frames.find((f) => !f.__taken && pred(f));
        if (hit) { hit.__taken = true; return Promise.resolve(hit); }
        return new Promise((res, rej) => {
          const w = { pred };
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`等待 ${what} 超时；已收 ${frames.map((f) => f.type).join(",")}`));
          }, ms);
          w.resolve = (m) => { m.__taken = true; res(m); };
          waiters.push(w);
        });
      },
      type(t, pred = () => true, ms) { return this.wait((f) => f.type === t && pred(f), ms, t); },
      close() { try { ws.terminate(); } catch {} },
    }));
  });
}

async function authedLocal(relay) {
  const c = await wsClient(relay.localPort);
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, client: { kind: "extension", version: "4.0.0", platform: "macos" } });
  const auth = await c.type("auth_result", (f) => f.ok === true);
  assert.equal(auth.ok, true);
  return c;
}

async function localRoom(relay, roomId = ROOM) {
  const c = await authedLocal(relay);
  c.send({ type: "room_register", room: { id: roomId, label: roomId, cwd: "/tmp", epoch: 1, instance: "inst-" + roomId } });
  await c.type("room_registered");
  return c;
}

async function authedViewer(relay) {
  const v = await wsClient(relay.viewerPort);
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4, caps: ["err.v4", "session.purge"] });
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  return v;
}

async function until(fn, what, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待超时：" + what);
}

/* ---------------- relay 中-4：purge 假成功 ---------------- */

function purgeHarness({ roomFileExists, drop } = {}) {
  const dir = tmpDir("pi-purge-");
  const id = "sess-purge";
  const file = path.join(dir, id + ".jsonl");
  if (roomFileExists !== false) fs.writeFileSync(file, '{"k":"msg","seq":1,"m":{}}\n');
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
    broadcastRoomList() { this.listBroadcasts = (this.listBroadcasts || 0) + 1; },
  };
  const archive = new Map([[id, { id }]]);
  const store = {
    _file(rid) { return path.join(dir, rid + ".jsonl"); },
    drop(rid) {
      if (typeof drop === "function") return drop(rid);
      fs.unlinkSync(path.join(dir, rid + ".jsonl"));
    },
  };
  const indexCalls = [];
  const index = { forgetSession(accountId, deviceId, sid) { indexCalls.push([accountId, deviceId, sid]); return true; } };
  const devices = new Map([["dev-1", { archives: archive }]]);
  return { dir, id, file, frames, viewer, room, rooms, store, index, indexCalls, devices };
}

test("relay 中-4：正文删除失败时不广播 session_removed、不删索引/会话库，等重试", () => {
  const h = purgeHarness({ drop() { /* 模拟 store.drop 吞掉 unlink 失败 */ } });
  try {
    const done = purgeSessions({
      accountId: "admin", deviceId: "dev-1", ids: [h.id],
      rooms: h.rooms, store: h.store, devices: h.devices, index: h.index, cfg: {},
    });
    assert.deepEqual(done, [], "没清掉正文的 id 不能放进 done");
    assert.equal(fs.existsSync(h.file), true, "正文文件仍在");
    assert.equal(h.frames.length, 0, "不能广播 session_removed/room_offline");
    assert.equal(h.indexCalls.length, 0, "索引墓碑也要等正文清掉后再写");
    assert.equal(h.devices.get("dev-1").archives.has(h.id), true, "会话库正文保留");
    assert.equal(h.rooms.map.has(h.id), true, "房间保留，网页还能看到并重试");
    assert.equal(h.rooms.listBroadcasts || 0, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test("relay 中-4：正文确实清掉时才广播并清索引/会话库/房间", () => {
  const h = purgeHarness();
  try {
    const done = purgeSessions({
      accountId: "admin", deviceId: "dev-1", ids: [h.id],
      rooms: h.rooms, store: h.store, devices: h.devices, index: h.index, cfg: {},
    });
    assert.deepEqual(done, [h.id]);
    assert.equal(fs.existsSync(h.file), false);
    assert.equal(h.devices.get("dev-1").archives.has(h.id), false);
    assert.deepEqual(h.indexCalls, [["admin", "dev-1", h.id]]);
    assert.equal(h.rooms.map.has(h.id), false);
    assert.ok(h.frames.some((f) => f.type === "session_removed" && f.ids.includes(h.id)), "广播 session_removed");
    assert.ok(h.frames.some((f) => f.type === "room_offline"), "先给观看端收成离线");
    assert.equal(h.rooms.listBroadcasts, 1);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

/* ---------------- relay 中-16：viewer 断线不丢无 key 在飞命令的 onResult ---------------- */

test("relay 中-16：viewer 断线后无 key 命令的结果仍会执行 onResult（删除副本）", async (t) => {
  const relay = await boot();
  const dir = relay.cfg.dataDir;
  t.after(async () => {
    try { await relay.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const c = await localRoom(relay);
  const v = await authedViewer(relay);
  t.after(() => { try { c.close(); } catch {} });
  const target = "sess-deleted-while-offline";
  relay.store.seedOrMerge(target, [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }]);
  relay.store.flushAll();
  const file = relay.store._file(target);
  assert.equal(fs.existsSync(file), true, "正文文件已落盘");

  v.send({
    type: "command", id: "del-offline", room: ROOM, command: "delete_session",
    args: { sessionPath: `/tmp/1700000000000_${target}.jsonl` },
  });
  const fwd = await c.type("command", (f) => f.command === "delete_session");
  assert.deepEqual(fwd.args, { sessionPath: `/tmp/1700000000000_${target}.jsonl` });

  // viewer 在结果回来前断开：无 dedupeKey（本用例刻意不带），旧实现会立刻删掉 commandWaiters 条目
  v.close();
  await until(() => relay.rooms.viewers.size === 0, "viewer 从房间表移除");
  c.send({ type: "command_result", id: fwd.id, ok: true, data: { status: "deleted" } });
  await until(() => !fs.existsSync(file), "删除成功后的服务器副本清理", 4000);
  assert.equal(relay.store.exists(target), false, "存储里也没有这个会话");
});

/* ---------------- relay 中-8：去重表挤兑不删在飞条目 ---------------- */

test("relay 中-8：超限挤兑只淘汰已完成条目，无等待者的在飞条目保留", () => {
  const rooms = { dedupe: new Map(), commandWaiters: new Map() };
  const inflight = {
    wireId: "w-inflight", key: ROOM + "|get_state|abc|k", done: false, waiters: [], result: null,
    at: Date.now(), command: "get_state", room: { id: ROOM },
  };
  rooms.dedupe.set(inflight.key, inflight);
  rooms.commandWaiters.set(inflight.wireId, inflight);
  for (let i = 0; i < 2000; i++) {
    const entry = {
      wireId: "w-done-" + i, key: ROOM + "|get_state|abc|old" + i, done: true, waiters: [],
      result: { ok: true, data: null }, at: Date.now(), command: "get_state", room: { id: ROOM },
    };
    rooms.dedupe.set(entry.key, entry);
    rooms.commandWaiters.set(entry.wireId, entry);
  }
  pruneDedupe(rooms, { dedupeTtlMs: 600000 });
  assert.equal(rooms.dedupe.has(inflight.key), true, "在飞条目不能被挤掉");
  assert.equal(rooms.commandWaiters.get(inflight.wireId), inflight, "commandWaiters 里也要在");
  assert.equal(rooms.dedupe.size, 2000, "只挤掉一个已完成条目");
  assert.equal(rooms.dedupe.has(ROOM + "|get_state|abc|old0"), false);
});

/* ---------------- relay 低-10：去重键绑定命令名 + 参数 ---------------- */

test("relay 低-10：同一 dedupeKey 换命令/参数不会回放上一个结果", async (t) => {
  const relay = await boot();
  t.after(async () => {
    try { await relay.close(); } catch {}
    fs.rmSync(relay.cfg.dataDir, { recursive: true, force: true });
  });
  const c = await localRoom(relay);
  const v = await authedViewer(relay);
  t.after(() => { try { c.close(); v.close(); } catch {} });

  // 第一次：get_state
  v.send({ type: "command", id: "q1", room: ROOM, command: "get_state", args: {}, dedupeKey: "same" });
  const f1 = await c.type("command", (f) => f.command === "get_state");
  c.send({ type: "command_result", id: f1.id, ok: true, data: { n: 1 } });
  assert.deepEqual((await v.type("ack", (f) => f.id === "q1")).data, { n: 1 });

  // 同 key 换命令：必须作为新命令转发，不能回放 {n:1}
  v.send({ type: "command", id: "q2", room: ROOM, command: "get_sessions", args: {}, dedupeKey: "same" });
  const f2 = await c.type("command", (f) => f.command === "get_sessions");
  c.send({ type: "command_result", id: f2.id, ok: true, data: { n: 2 } });
  const ack2 = await v.type("ack", (f) => f.id === "q2");
  assert.equal(ack2.dedup, undefined, "新命令不是去重回放");
  assert.deepEqual(ack2.data, { n: 2 });

  // 同 key 同命令换参数：也要作为新命令转发
  v.send({ type: "command", id: "q3", room: ROOM, command: "get_state", args: { include: "all" }, dedupeKey: "same" });
  const f3 = await c.type("command", (f) => f.command === "get_state" && f.id !== f1.id);
  c.send({ type: "command_result", id: f3.id, ok: true, data: { n: 3 } });
  const ack3 = await v.type("ack", (f) => f.id === "q3");
  assert.equal(ack3.dedup, undefined);
  assert.deepEqual(ack3.data, { n: 3 });

  // 参数键序不影响指纹：同一请求重发仍命中去重
  assert.equal(
    dedupeKeyOf(ROOM, "prompt", { text: "hi", cid: "c1" }, "k"),
    dedupeKeyOf(ROOM, "prompt", { cid: "c1", text: "hi" }, "k"),
  );
});

/* ---------------- relay 中-6：sessionArchive 上限 + 广播 sanitize ---------------- */

test("relay 中-6：会话归档按 LRU 限制条数，重复推送视为最近使用", () => {
  const dev = {};
  for (let i = 0; i <= ARCHIVE_MAX_SESSIONS; i++) {
    storeSessionArchive(dev, { id: "s" + i, messages: [] });
  }
  assert.equal(dev.archives.size, ARCHIVE_MAX_SESSIONS);
  assert.equal(dev.archives.has("s0"), false, "最旧的一份被淘汰");
  assert.equal(dev.archives.has("s" + ARCHIVE_MAX_SESSIONS), true);
  // 重新推 s1 → 它变成最近使用；再塞一份，最旧的 s2 应被淘汰而不是 s1
  storeSessionArchive(dev, { id: "s1", messages: [] });
  storeSessionArchive(dev, { id: "s-new", messages: [] });
  assert.equal(dev.archives.has("s1"), true, "重新推送过的条目不先淘汰");
  assert.equal(dev.archives.has("s2"), false);
});

test("relay 中-6：实时广播走 sanitize（剥掉额外字段、超 200KB 不广播）", () => {
  const frames = [];
  const viewer = { readyState: 1, bufferedAmount: 0, send(data) { frames.push(JSON.parse(data)); } };
  const rooms = { viewers: new Set([viewer]) };
  const raw = {
    id: "s1",
    internalSecret: "不要广播",
    messages: [{ id: "m1", role: "user", text: "hi", secret: "x" }],
  };
  assert.equal(broadcastSessionArchive(rooms, "dev-1", raw, {}), true);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].session.id, "s1");
  assert.equal(frames[0].session.internalSecret, undefined, "原始对象额外字段被剥掉");
  assert.deepEqual(frames[0].session.messages, [{ id: "m1", role: "user", text: "hi" }]);

  const huge = {
    id: "s2",
    messages: Array.from({ length: 30 }, (_, i) => ({ id: "m" + i, role: "user", text: "x".repeat(8000) })),
  };
  assert.equal(broadcastSessionArchive(rooms, "dev-1", huge, {}), false, "超过 200KB 的归档不广播");
  assert.equal(frames.length, 1);
});

/* ---------------- relay 中-7：keepalive 无 _state 防护 ---------------- */

test("relay 中-7：无 _state 连接不打断心跳，单连接异常隔离", () => {
  const pings = [];
  const terminated = [];
  const wss = {
    clients: [
      { ping() { throw new Error("没有 _state 的连接"); } },
      { _state: { alive: true }, ping() { pings.push("a"); } },
      { _state: { alive: false, misses: 0 }, ping() { pings.push("b"); } },
      { _state: { alive: false, misses: 1 }, ping() {}, terminate() { terminated.push("dead"); } },
      { _state: { alive: true }, ping() { throw new Error("单连接 ping 失败"); } },
      { _state: { alive: true }, ping() { pings.push("c"); } },
    ],
  };
  const checked = keepaliveSweep(wss);
  assert.equal(checked, 3);
  assert.deepEqual(pings, ["a", "b", "c"], "无状态/异常连接后面的健康连接照常 ping");
  assert.deepEqual(terminated, ["dead"]);
});

/* ---------------- relay 中-9：wire.send 单帧字节上限 ---------------- */

test("relay 中-9：缓冲 + 本帧超过硬顶的帧被拒绝，不扩大积压", () => {
  const frames = [];
  const ws = {
    readyState: 1,
    bufferedAmount: 0,
    terminated: false,
    send(data) { frames.push(data); },
    terminate() { this.terminated = true; },
  };
  const cfg = { viewerLagBytes: 10, viewerMaxBufferBytes: 100 };

  assert.equal(send(ws, "small", cfg), true);
  assert.equal(frames.length, 1);

  // 缓冲 90 + 本帧 20 > 100：拒绝，不发
  ws.bufferedAmount = 90;
  assert.equal(send(ws, "x".repeat(20), cfg), false);
  assert.equal(frames.length, 1, "超限帧不能入队");
  assert.equal(ws.terminated, false, "还没超过硬顶，不断开");

  // 单帧本身就超过硬顶：拒绝
  ws.bufferedAmount = 0;
  assert.equal(send(ws, "y".repeat(200), cfg), false);
  assert.equal(frames.length, 1);

  // 已积压本身超过硬顶：维持旧行为，断开
  ws.bufferedAmount = 101;
  assert.equal(send(ws, "z", cfg), false);
  assert.equal(ws.terminated, true);
});

/* ---------------- relay 中-11：启动失败可 reject ---------------- */

test("relay 中-11：端口被占用时 startRelay reject（不永久挂起、不裸奔退出）", async () => {
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = blocker.address().port;
  const dir = tmpDir("pi-relay-startfail-");
  try {
    await assert.rejects(
      startRelay({
        localPort: port,
        viewerPort: 0,
        dataDir: dir,
        quiet: true,
        exitOnListenError: false,
        localToken: LOCAL_TOKEN,
        viewerToken: VIEWER_TOKEN,
      }),
      /EADDRINUSE|address already in use/i,
    );
  } finally {
    await new Promise((r) => blocker.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- relay 中-12/13/15：config 类型校验、损坏不静默、示例补齐 ---------------- */

test("relay 中-12：config 字符串/布尔字段非法类型回退默认并逐个告警", () => {
  const warnings = [];
  const fileCfg = {
    localHost: 5,
    viewerHost: null,
    dataDir: {},
    accountsDir: [],
    accountId: 7,
    serverName: true,
    localToken: 123,
    viewerToken: ["x"],
    adminToken: {},
    notifyWebhookUrl: 9,
    quiet: "false",
    persistTranscripts: "true",
    allowLegacyLocal: 0,
    perMessageDeflate: "false",
    notifyEvents: { turn_done: "true", turn_error: 1, dialog_waiting: false },
  };
  sanitizeTypedConfig(fileCfg, DEFAULT_CONFIG, (msg) => warnings.push(msg));
  for (const key of ["localHost", "viewerHost", "dataDir", "accountsDir", "accountId", "serverName", "localToken", "viewerToken", "adminToken", "notifyWebhookUrl"]) {
    assert.equal(fileCfg[key], DEFAULT_CONFIG[key], key + " 应回退默认值");
  }
  for (const key of ["quiet", "persistTranscripts", "allowLegacyLocal", "perMessageDeflate"]) {
    assert.equal(fileCfg[key], DEFAULT_CONFIG[key], key + " 应回退默认值");
  }
  assert.equal(fileCfg.notifyEvents.turn_done, false, "\"true\" 字符串不能当 true");
  assert.equal(fileCfg.notifyEvents.turn_error, false);
  assert.equal(fileCfg.notifyEvents.dialog_waiting, false);
  assert.equal(warnings.length, 16, warnings.join("\n"));
  for (const key of ["localHost", "quiet", "notifyEvents.turn_done"]) {
    assert.ok(warnings.some((m) => m.includes(key)), key + " 缺告警");
  }
});

test("relay 中-12：loadConfig 实际应用类型校验（字符串 \"false\" 不再按真生效）", () => {
  const dir = tmpDir("pi-config-types-");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify({
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    quiet: "false",
    persistTranscripts: "true",
    allowLegacyLocal: 0,
    perMessageDeflate: "false",
  }));
  const prevPersist = process.env.PI_REMOTE_PERSIST_TRANSCRIPTS;
  const prevLegacy = process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL;
  const realError = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));
  try {
    delete process.env.PI_REMOTE_PERSIST_TRANSCRIPTS;
    delete process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL;
    const cfg = loadConfig(file);
    assert.equal(cfg.quiet, false);
    assert.equal(cfg.persistTranscripts, false);
    assert.equal(cfg.allowLegacyLocal, true);
    assert.equal(cfg.perMessageDeflate, true);
    assert.ok(errors.join("\n").includes("config.json 字段 quiet 非法"));
  } finally {
    console.error = realError;
    if (prevPersist == null) delete process.env.PI_REMOTE_PERSIST_TRANSCRIPTS;
    else process.env.PI_REMOTE_PERSIST_TRANSCRIPTS = prevPersist;
    if (prevLegacy == null) delete process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL;
    else process.env.PI_REMOTE_ALLOW_LEGACY_LOCAL = prevLegacy;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("relay 中-13：config.json 解析失败直接抛错（带文件与原因），不再默认值静默启动", () => {
  const dir = tmpDir("pi-config-broken-");
  const file = path.join(dir, "config.json");
  try {
    fs.writeFileSync(file, "{localToken: nope");
    assert.throws(
      () => loadConfig(file),
      (e) => /config\.json 解析失败/.test(e.message) && e.message.includes(file),
      "损坏的 config.json 必须报错并指出文件",
    );
    fs.writeFileSync(file, "[]");
    assert.throws(() => loadConfig(file), /内容必须是对象/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("relay 中-15：config.example.json 覆盖 DEFAULT_CONFIG 的全部字段", () => {
  const file = path.join(__dirname, "..", "relay", "config.example.json");
  const example = JSON.parse(fs.readFileSync(file, "utf8"));
  const missing = Object.keys(DEFAULT_CONFIG).filter((k) => !Object.prototype.hasOwnProperty.call(example, k));
  assert.deepEqual(missing, [], "示例缺字段：" + missing.join(","));
  assert.equal(typeof example.notifyEvents, "object");
  assert.equal(example.notifyEvents.turn_done, false);
});

/* ---------------- relay 中-14：索引压缩失败不误报写入失败 ---------------- */

test("relay 中-14：索引压缩失败只告警，本次追加仍算成功且清临时文件", async () => {
  const dir = tmpDir("pi-index-compact-");
  const realWarn = console.warn;
  const warnings = [];
  try {
    const index = new AccountIndex(dir);
    const file = index._sessionsFile("admin", "dev");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [];
    for (let i = 0; i < 300; i++) {
      rows.push(JSON.stringify({ kind: "session", id: "s" + i, name: "x".repeat(900), updatedAt: 1 }));
    }
    fs.writeFileSync(file, rows.join("\n") + "\n");
    assert.ok(fs.statSync(file).size >= 256 * 1024, "文件已超过压缩阈值");

    // 让 tmp 文件写入失败：符号链接指向不存在的目录（root 下也稳定失败）
    const tmp = file + ".tmp";
    fs.symlinkSync(path.join(dir, "no-such-dir", "target"), tmp);
    console.warn = (...a) => warnings.push(a.join(" "));

    const res = index.applyManifest("admin", "dev", {
      sessions: [{ id: "new", name: "新会话", updatedAt: Date.now() }],
      updatedAt: Date.now(),
    });
    assert.equal(res.ok, true, "行已落盘，不能报 write_failed");
    assert.equal(res.reason, undefined);
    // 整文件重写被排到本轮之后（不挡写路径）：让出一轮事件循环再断言告警与临时文件清理
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(warnings.join("\n"), /索引压缩失败/);
    assert.equal(fs.existsSync(tmp), false, "临时文件要清掉");
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /"id":"new"/, "追加的新行仍在原文件里");
    assert.ok(text.split("\n").filter(Boolean).length >= 300, "旧行没被压缩失败抹掉");
  } finally {
    console.warn = realWarn;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 合并高危：usage 负时区 ---------------- */

function usageSnapshot(offsetMinutes = -300) {
  const day = "2026-10-20";
  return {
    v: "usage.activity.v1",
    generatedAt: Date.now(),
    deviceId: "dev-usage",
    timezone: { id: offsetMinutes < 0 ? "America/New_York" : "Asia/Shanghai", offsetMinutes },
    range: { firstDay: day, lastDay: day, days: 1 },
    days: [{
      date: day,
      tokens: { total: 10, input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
      messages: { user: 1, assistant: 1 },
      sessions: 1,
    }],
    summary: {
      totals: { tokens: 10, messagesUser: 1, messagesAssistant: 1, sessions: 1, activeDays: 1 },
      streaks: { current: 1, longest: 1 },
      peaks: { tokens: { date: day, value: 10 }, messages: { date: day, value: 2 } },
      models: [],
      modelsWindowDays: 30,
    },
    coverage: { files: 1, parsedFiles: 1, cacheHitFiles: 0, skippedFiles: 0, truncated: false, errors: 0, scanMs: 1, source: "pi-sessions" },
    cache: { hit: false, generatedFrom: "full" },
  };
}

test("合并高危·负时区：usage 时区偏移改有符号整数 [-840, 840]", () => {
  for (const offset of [-720, -300, -60, 0, 480, 840]) {
    assert.equal(validateUsageSnapshot(usageSnapshot(offset)).ok, true, "offset " + offset + " 应合法");
  }
  for (const offset of [-841, 841, 300.5, -300.5, NaN, Infinity, "-300", null]) {
    const checked = validateUsageSnapshot(usageSnapshot(offset));
    assert.equal(checked.ok, false, "offset " + String(offset) + " 应非法");
    assert.ok(checked.errors.some((e) => e.includes("timezone")), "要报 timezone 非法");
  }
});
