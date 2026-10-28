"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const WebSocket = require("ws");
const { startRelay, commandTimeoutMs } = require("../relay/server.js");
const { hashOf } = require("../relay/store.js");
const { sendCachedTools, sendCachedToolEnds, sendCachedTaskList, sendCachedAgentState, sendCachedRemoteQueue, sendCachedDialogs, DROPPABLE_LOCAL_EVENTS } = require("../relay/rooms.js");
const { MIN_TOKEN_LENGTH, DEFAULT_CONFIG, usableToken, positiveInt, sanitizeNumericConfig } = require("../relay/config.js");
const { PAIR_CODES_MAX } = require("../relay/pairing.js");
const { DEVICE_COMMANDS, READONLY_DEVICE_COMMANDS } = require("../relay/commands");
const PROTOCOL = require("../relay/protocol.json");

const ROOM = "room-test-1";
// 生产要求令牌至少 16 字符；测试 fixture 也照这个长度来，避免弱令牌用例变成唯一合法输入。
const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";
const ADMIN_TOKEN = "test-admin-token-4d9c2e";

/** err.v4：失败帧的 code 必须在码表里，retryable 跟码表一致（不可重试的不带这个字段），文案照旧在 error / message 里 */
function assertCoded(frame, code) {
  assert.equal(frame.code, code, JSON.stringify(frame));
  const def = PROTOCOL.errors[code];
  assert.ok(def, "码表里没有 " + code);
  assert.equal(frame.retryable === true, def.retryable, code + " 的 retryable 与码表不一致");
  if (!def.retryable) assert.equal("retryable" in frame, false, code);
  assert.equal(typeof (frame.message ?? frame.error), "string", code + " 缺文案");
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-relay-"));
}

function boot(dataDir = tmpDir(), overrides = {}) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir,
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

/** 收帧客户端：wait(pred) 返回第一条尚未被取走、满足条件的帧（已到达的也算）。
 *  options 透传给 ws（测来源限流时用 X-Forwarded-For 扮成不同来源）。 */
function client(port, options) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, options);
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
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
        const w = { pred, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`等待 ${what} 超时；已收到：${frames.map((f) => f.type).join(",")}`));
        }, ms) };
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

async function local(relay, opts = {}) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: opts.epoch || 1, instance: opts.instance || "inst-a" } });
  const reg = await c.type("room_registered");
  return { c, reg };
}

async function viewer(relay, source, opts = {}) {
  const v = client(relay.viewerPort, source ? { headers: { "x-forwarded-for": source } } : undefined);
  await v.opened;
  const hello = { type: "auth", role: "viewer", token: VIEWER_TOKEN };
  // opts.caps 模拟新 UI 的握手声明（如 dialog.respond）；不传 = 旧端（无 cap 门控视角）
  if (Array.isArray(opts.caps)) hello.caps = opts.caps;
  v.send(hello);
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  return { v, auth };
}

const user = (text, ts) => ({ role: "user", content: [{ type: "text", text }], timestamp: ts });
const asst = (text, ts) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts, stopReason: "stop" });

test("注册回存储锚点；viewer auth_result 带 boot", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c, reg } = await local(relay);
  t.after(() => c.close());
  assert.equal(reg.room, ROOM);
  assert.equal(reg.msgCount, 0);
  assert.equal(reg.seq, 0);
  assert.equal(reg.rev, null, "还没有任何记录的新房间没有存储世代");
  const { v, auth } = await viewer(relay);
  t.after(() => v.close());
  assert.match(auth.boot, /^[0-9a-f]{12}$/);
  assert.ok(auth.rooms.some((r) => r.id === ROOM && r.online));
});

test("落盘事件带 seq/rev，流式事件不带；带 since 重订阅只收增量", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  const first = await v.type("snapshot");
  assert.equal(first.messages.length, 0);

  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("a", 1) } });
  c.send({ type: "event", room: ROOM, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } } });
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: asst("b", 2) } });
  const e1 = await v.type("room_event", (f) => f.event.type === "message_end");
  const upd = await v.type("room_event", (f) => f.event.type === "message_update");
  const e2 = await v.type("room_event", (f) => f.event.type === "message_end");
  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(typeof e1.rev, "string");
  assert.equal(upd.seq, undefined);
  assert.equal(upd.rev, undefined);

  // 断线重连：带 {rev, seq:1} 只收第 2 条
  const { v: v2 } = await viewer(relay);
  t.after(() => v2.close());
  v2.send({ type: "subscribe", room: ROOM, since: { rev: e1.rev, seq: 1 } });
  const delta = await v2.type("snapshot");
  assert.equal(delta.delta, true);
  assert.equal(delta.baseSeq, 1);
  assert.equal(delta.seq, 2);
  assert.deepEqual(delta.messages.map((m) => m.content[0].text), ["b"]);

  // rev 对不上：全量
  const { v: v3 } = await viewer(relay);
  t.after(() => v3.close());
  v3.send({ type: "subscribe", room: ROOM, since: { rev: "stale", seq: 1 } });
  const full = await v3.type("snapshot");
  assert.equal(full.delta, undefined);
  assert.equal(full.messages.length, 2);
});

test("扩展 append 快照：锚点对上广播增量，对不上回 snapshot_request", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({ type: "snapshot", room: ROOM, messages: [user("u1", 1), asst("a1", 2)] });
  const seeded = await v.type("snapshot");
  assert.equal(seeded.messages.length, 2);

  c.send({ type: "snapshot", room: ROOM, mode: "append", base: { count: 2, hash: hashOf(asst("a1", 2)) }, messages: [user("u2", 3)] });
  const delta = await v.type("snapshot");
  assert.equal(delta.delta, true);
  assert.equal(delta.baseSeq, seeded.seq);
  assert.deepEqual(delta.messages.map((m) => m.content[0].text), ["u2"]);

  c.send({ type: "snapshot", room: ROOM, mode: "append", base: { count: 3, hash: "bogus" }, messages: [user("u3", 4)] });
  const req = await c.type("snapshot_request");
  assert.equal(req.room, ROOM);
});

test("room_registered 带最近消息的 tailHashes", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("a", 1) } });
  c.send({ type: "event", room: ROOM, event: { type: "remote_message", text: "echo" } });
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: asst("b", 2) } });
  c.send({ type: "sync", room: ROOM });
  const reg = await c.type("room_registered", (f) => f.msgCount === 2);
  assert.deepEqual(reg.tailHashes, [hashOf(user("a", 1)), hashOf(asst("b", 2))]);
});

test("去重表超限时不拆掉还在飞的命令", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  const inflight = {
    wireId: "inflight",
    room: { id: ROOM },
    command: "bash",
    local: c.ws,
    waiters: [{ ws: {}, origId: "x", timer: setTimeout(() => {}, 60000) }],
    done: false,
    result: null,
    at: Date.now() - 1000,
    key: ROOM + "|inflight",
  };
  t.after(() => clearTimeout(inflight.waiters[0].timer));
  relay.rooms.dedupe.set(inflight.key, inflight);
  relay.rooms.commandWaiters.set(inflight.wireId, inflight);
  for (let i = 0; i < 2000; i++) {
    relay.rooms.dedupe.set(ROOM + "|old" + i, {
      wireId: "old" + i,
      waiters: [],
      done: true,
      at: Date.now(),
      key: ROOM + "|old" + i,
      result: { ok: true, data: null },
    });
  }
  v.send({ type: "command", id: "q-cap", room: ROOM, command: "get_state", args: {}, dedupeKey: "fresh" });
  await v.type("command_accepted", (f) => f.id === "q-cap");
  assert.equal(relay.rooms.dedupe.has(inflight.key), true);
  assert.equal(relay.rooms.commandWaiters.get("inflight"), inflight);
  assert.equal(inflight.waiters.length, 1);
  assert.ok(inflight.waiters[0].timer);
  assert.equal(relay.rooms.dedupe.has(ROOM + "|old0"), false);
});

test("命令：先回 command_accepted(timeoutMs)，同一 dedupeKey 重发只执行一次并回放结果", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  v.send({ type: "command", id: "q1", room: ROOM, command: "get_state", args: {}, dedupeKey: "k1" });
  const accepted = await v.type("command_accepted", (f) => f.id === "q1");
  assert.equal(accepted.timeoutMs, commandTimeoutMs("get_state", {}));
  const forwarded = await c.type("command");
  assert.equal(forwarded.command, "get_state");
  assert.equal(forwarded.timeoutMs, accepted.timeoutMs);

  // 结果回来之前重发：合并到同一个在飞请求，不再转发给本机
  v.send({ type: "command", id: "q2", room: ROOM, command: "get_state", args: {}, dedupeKey: "k1" });
  const merged = await v.type("command_accepted", (f) => f.id === "q2");
  assert.equal(merged.dedup, true);

  c.send({ type: "command_result", room: ROOM, id: forwarded.id, ok: true, data: { n: 1 } });
  const ack1 = await v.type("ack", (f) => f.id === "q1");
  const ack2 = await v.type("ack", (f) => f.id === "q2");
  assert.deepEqual(ack1.data, { n: 1 });
  assert.deepEqual(ack2.data, { n: 1 });

  // 完成之后再重发：直接回放
  v.send({ type: "command", id: "q3", room: ROOM, command: "get_state", args: {}, dedupeKey: "k1" });
  const ack3 = await v.type("ack", (f) => f.id === "q3");
  assert.equal(ack3.dedup, true);
  assert.deepEqual(ack3.data, { n: 1 });
  assert.equal(c.frames.filter((f) => f.type === "command").length, 1, "本机只收到一次");
});

test("本机断开：在飞命令立即失败，不让 viewer 干等超时", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "command", id: "q1", room: ROOM, command: "compact", args: {} });
  await v.type("command_accepted", (f) => f.id === "q1");
  await c.type("command");
  c.close();
  const ack = await v.type("ack", (f) => f.id === "q1");
  assert.equal(ack.ok, false);
  assert.match(ack.error, /断开/);
  assertCoded(ack, "result_unknown");
});

test("get_file / get_host_diag：在设备命令白名单里，按房间转发并原样回包；get_file 走慢读超时", async (t) => {
  // 白名单与超时表是 relay 侧唯一需要登记这两个命令的地方，先直接锁定口径
  assert.ok(DEVICE_COMMANDS.has("get_file"), "get_file 应允许设备级调用");
  assert.ok(DEVICE_COMMANDS.has("get_host_diag"), "get_host_diag 应允许设备级调用");
  assert.equal(commandTimeoutMs("get_file", {}), 30000);
  assert.equal(commandTimeoutMs("get_host_diag", {}), 15000);

  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  // get_file：只读、无缓存，转发 args 并原样带回结果
  v.send({ type: "command", id: "f1", room: ROOM, command: "get_file", args: { path: "docs/a.md" } });
  const accepted = await v.type("command_accepted", (f) => f.id === "f1");
  assert.equal(accepted.timeoutMs, 30000);
  const fileFwd = await c.type("command", (f) => f.command === "get_file");
  assert.equal(fileFwd.room, ROOM);
  assert.deepEqual(fileFwd.args, { path: "docs/a.md" });
  const fileData = { name: "a.md", mimeType: "text/markdown", size: 6, encoding: "utf8", data: "# hi\n", truncated: false };
  c.send({ type: "command_result", room: ROOM, id: fileFwd.id, ok: true, data: fileData });
  const fileAck = await v.type("ack", (f) => f.id === "f1");
  assert.equal(fileAck.ok, true);
  assert.deepEqual(fileAck.data, fileData);

  // get_host_diag：无参数，同样直通回包
  v.send({ type: "command", id: "d1", room: ROOM, command: "get_host_diag", args: {} });
  const diagAccepted = await v.type("command_accepted", (f) => f.id === "d1");
  assert.equal(diagAccepted.timeoutMs, 15000);
  const diagFwd = await c.type("command", (f) => f.command === "get_host_diag");
  assert.equal(diagFwd.room, ROOM);
  const diagData = { piVersion: "1.3.0", nodeVersion: "v22.18.0", platform: "macos", arch: "arm64", extensionVersion: "4.0.0", attach: { active: false }, recentErrors: [], logTail: [] };
  c.send({ type: "command_result", room: ROOM, id: diagFwd.id, ok: true, data: diagData });
  const diagAck = await v.type("ack", (f) => f.id === "d1");
  assert.equal(diagAck.ok, true);
  assert.deepEqual(diagAck.data, diagData);

  // 失败同样带协议码、原样透传（不在 relay 侧改写文案）
  v.send({ type: "command", id: "f2", room: ROOM, command: "get_file", args: { path: "../etc/passwd" } });
  await v.type("command_accepted", (f) => f.id === "f2");
  const deniedFwd = await c.type("command", (f) => f.command === "get_file" && f.id !== fileFwd.id);
  c.send({ type: "command_result", room: ROOM, id: deniedFwd.id, ok: false, error: "路径越界：只能读取当前会话目录内的文件", code: "cwd_not_allowed" });
  const deniedAck = await v.type("ack", (f) => f.id === "f2");
  assert.equal(deniedAck.ok, false);
  assertCoded(deniedAck, "cwd_not_allowed");
});

test("B-4 只读设备命令：没有活动会话也能直达设备；非只读仍被 activeRoom 拦截", async (t) => {
  // 白名单是安全边界：只读豁免只能是设备命令的子集
  for (const cmd of ["get_file", "get_image", "get_host_diag"]) {
    assert.ok(READONLY_DEVICE_COMMANDS.has(cmd), cmd + " 应在只读设备命令里");
    assert.ok(DEVICE_COMMANDS.has(cmd), cmd + " 必须仍是设备命令白名单成员");
  }
  assert.equal(commandTimeoutMs("get_image", {}), 30000, "get_image 与 get_file 同走慢读档");

  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-readonly";
  const win = client(relay.localPort);
  t.after(() => win.close());
  await win.opened;
  win.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await win.type("auth_result");
  win.send({
    type: "device_register",
    device: { id: DEV, name: "Mac", platform: "macos", projects: ["/tmp"], windowExpiresAt: Date.now() + 3600_000 },
  });
  await win.type("room_list");
  // 关键前提：设备在线，但没有任何房间（activeRoomId = null）
  const { v } = await viewer(relay);
  t.after(() => v.close());

  // get_host_diag：直达设备，不再被 device_no_active_session 挡住
  v.send({ type: "command", id: "d1", deviceId: DEV, command: "get_host_diag", args: {} });
  const diagAccepted = await v.type("command_accepted", (f) => f.id === "d1");
  assert.equal(diagAccepted.deviceId, DEV);
  assert.equal("room" in diagAccepted, false, "无活动会话的设备命令不带 room");
  const diagFwd = await win.type("command", (f) => f.command === "get_host_diag");
  assert.equal("room" in diagFwd, false, "转发帧不带 room，扩展按设备实例执行");
  win.send({ type: "command_result", id: diagFwd.id, ok: true, data: { platform: "macos", recentErrors: [] } });
  const diagAck = await v.type("ack", (f) => f.id === "d1");
  assert.equal(diagAck.ok, true);
  assert.deepEqual(diagAck.data, { platform: "macos", recentErrors: [] });

  // get_file / get_image：同样无房间直达，args 原样转发、结果原样回包
  v.send({ type: "command", id: "f1", deviceId: DEV, command: "get_file", args: { path: "a.md" } });
  await v.type("command_accepted", (f) => f.id === "f1");
  const fileFwd = await win.type("command", (f) => f.command === "get_file");
  assert.deepEqual(fileFwd.args, { path: "a.md" });
  win.send({ type: "command_result", id: fileFwd.id, ok: true, data: { encoding: "utf8", data: "hi" } });
  assert.equal((await v.type("ack", (f) => f.id === "f1")).ok, true);

  v.send({ type: "command", id: "i1", deviceId: DEV, command: "get_image", args: { entryId: "e1", blockIndex: 2 } });
  await v.type("command_accepted", (f) => f.id === "i1");
  const imageFwd = await win.type("command", (f) => f.command === "get_image");
  assert.equal(imageFwd.timeoutMs, 30000);
  assert.deepEqual(imageFwd.args, { entryId: "e1", blockIndex: 2 });
  win.send({ type: "command_result", id: imageFwd.id, ok: true, data: { entryId: "e1", blockIndex: 2, mimeType: "image/png", data: "AAAA", compressed: false } });
  const imageAck = await v.type("ack", (f) => f.id === "i1");
  assert.equal(imageAck.ok, true);
  assert.equal(imageAck.data.blockIndex, 2);

  // 非只读设备命令仍要活动会话：安全白名单没有被放宽
  v.send({ type: "command", id: "s1", deviceId: DEV, command: "switch_session", args: { sessionId: "x" } });
  const denied = await v.type("ack", (f) => f.id === "s1");
  assert.equal(denied.ok, false);
  assertCoded(denied, "device_no_active_session");
});

test("B-7 宿主异常断开：队列/清单补发带时间戳，断开时合成弹窗关闭并清缓存", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({ type: "event", room: ROOM, event: { type: "queue_update", steering: [{ text: "steer" }], followUp: [] } });
  c.send({ type: "event", room: ROOM, event: { type: "remote_queue_state", rev: 4, items: [{ id: "rq_1", segment: "steer", source: "web", text: "x", images: [], status: "pending", at: 1 }] } });
  c.send({ type: "event", room: ROOM, event: { type: "task_list_state", tasks: [{ id: "t1", content: "做", status: "pending" }], source: "todo", at: 123 } });
  c.send({ type: "event", room: ROOM, event: { type: "ui_prompt_start", reason: "select", kind: "confirm", title: "本机在等确认" } });
  await v.type("room_event", (f) => f.event.type === "queue_update");
  await v.type("room_event", (f) => f.event.type === "remote_queue_state");
  await v.type("room_event", (f) => f.event.type === "task_list_state");
  await v.type("room_event", (f) => f.event.type === "ui_prompt_start");

  // 补发缓存要带时间戳，且在线房间照常补发
  const { v: mid } = await viewer(relay);
  t.after(() => mid.close());
  mid.send({ type: "subscribe", room: ROOM });
  await mid.type("snapshot");
  const cachedQueue = await mid.type("room_event", (f) => f.event.type === "queue_update");
  const cachedRemote = await mid.type("room_event", (f) => f.event.type === "remote_queue_state");
  const cachedTask = await mid.type("room_event", (f) => f.event.type === "task_list_state");
  assert.equal(typeof cachedQueue.event.at, "number", "queue 缓存要带 at");
  assert.equal(typeof cachedRemote.event.at, "number", "remote_queue_state 缓存要带 at");
  assert.equal(cachedTask.event.at, 123);

  const seqBefore = relay.store.info(ROOM).seq;
  c.close();
  const offline = await v.type("room_offline");
  const beforeOffline = v.frames.filter((f, i) => i < v.frames.indexOf(offline) && f.type === "room_event");
  const emptyQueue = beforeOffline.find((f) => f.event.type === "queue_update" && f.event.steering.length === 0);
  const emptyRemote = beforeOffline.find((f) => f.event.type === "remote_queue_state" && f.event.items.length === 0);
  const emptyTask = beforeOffline.find((f) => f.event.type === "task_list_state" && f.event.tasks.length === 0);
  const promptEnd = beforeOffline.find((f) => f.event.type === "ui_prompt_end");
  assert.ok(emptyQueue, "room_offline 之前要有空 queue_update");
  assert.ok(emptyRemote, "room_offline 之前要有空 remote_queue_state");
  assert.equal(emptyRemote.event.rev, 0);
  assert.ok(emptyTask, "room_offline 之前要有空 task_list_state");
  assert.ok(promptEnd, "缓存的 uiPrompt 要合成关闭");
  assert.equal(relay.store.info(ROOM).seq, seqBefore, "合成帧不写 store");

  // 晚到的观众不能拿到旧队列/旧清单/旧弹窗
  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const staleTypes = new Set(["queue_update", "remote_queue_state", "task_list_state", "ui_prompt_start"]);
  assert.equal(
    late.frames.some((f) => f.type === "room_event" && staleTypes.has(f.event && f.event.type)),
    false,
    "离线房间不补发旧状态",
  );
});

test("O1 对话框观察：多槽缓存补发、close 摘槽、宿主断开逐槽合成关闭、ext_status 补发", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-1", kind: "select", title: "选一个", options: ["甲", "乙"], startedAt: 111 } });
  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-2", kind: "confirm", title: "确定？", message: "正文", timeout: 60000, startedAt: 222 } });
  c.send({ type: "event", room: ROOM, event: { type: "ext_status", statuses: { branch: "main" }, widgets: [{ key: "w", lines: ["行"] }], title: null, working: null, tap: { state: "ok" }, at: 5 } });
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-1");
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-2");
  await v.type("room_event", (f) => f.event.type === "ext_status");

  // 晚订阅：两个在开 dialog 逐槽补发（startedAt 用原值），ext_status 全量补发
  const { v: mid } = await viewer(relay);
  t.after(() => mid.close());
  mid.send({ type: "subscribe", room: ROOM });
  await mid.type("snapshot");
  const cached1 = await mid.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-1");
  const cached2 = await mid.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-2");
  const cachedStatus = await mid.type("room_event", (f) => f.event.type === "ext_status");
  assert.equal(cached1.event.startedAt, 111, "补发保留首次捕获的 startedAt");
  assert.deepEqual(cached1.event.options, ["甲", "乙"]);
  assert.equal(cached2.event.startedAt, 222);
  assert.equal(cached2.event.timeout, 60000);
  assert.equal(cachedStatus.event.statuses.branch, "main");
  assert.equal(cachedStatus.event.tap.state, "ok");

  // dialog_close 摘掉对应槽：再晚的观众只补发剩下的
  c.send({ type: "event", room: ROOM, event: { type: "dialog_close", dialogId: "dlg-1", outcome: "resolved" } });
  await v.type("room_event", (f) => f.event.type === "dialog_close" && f.event.dialogId === "dlg-1");
  const { v: mid2 } = await viewer(relay);
  t.after(() => mid2.close());
  mid2.send({ type: "subscribe", room: ROOM });
  await mid2.type("snapshot");
  await mid2.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-2");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    mid2.frames.some((f) => f.type === "room_event" && f.event.type === "dialog_open" && f.event.dialogId === "dlg-1"),
    false,
    "已关闭的 dialog 不再补发",
  );

  // 宿主断开：剩余槽逐个合成 dialog_close(gone)，合成帧不写 store
  const seqBefore = relay.store.info(ROOM).seq;
  c.close();
  const offline = await v.type("room_offline");
  const beforeOffline = v.frames.filter((f, i) => i < v.frames.indexOf(offline) && f.type === "room_event");
  const gone = beforeOffline.find((f) => f.event.type === "dialog_close" && f.event.dialogId === "dlg-2");
  assert.ok(gone, "room_offline 之前要合成 dlg-2 的关闭");
  assert.equal(gone.event.outcome, "gone");
  assert.equal(relay.store.info(ROOM).seq, seqBefore, "合成帧不写 store");

  // 离线房间不补发旧 dialog / ext_status
  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    late.frames.some((f) => f.type === "room_event" && (f.event.type === "dialog_open" || f.event.type === "ext_status")),
    false,
    "离线房间不补发旧弹窗/旧状态",
  );
});

test("relay 重启：rev/seq 不变，viewer 增量重连命中；扩展重新注册拿到原锚点", async (t) => {
  const dir = tmpDir();
  const r1 = await boot(dir);
  const { c } = await local(r1);
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("a", 1) } });
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: asst("b", 2) } });
  const { v } = await viewer(r1);
  v.send({ type: "subscribe", room: ROOM });
  const snap = await v.type("snapshot", (f) => f.messages.length === 2);
  c.close();
  v.close();
  await r1.close();

  const r2 = await boot(dir);
  t.after(() => r2.close());
  const { c: c2, reg } = await local(r2);
  t.after(() => c2.close());
  assert.equal(reg.rev, snap.rev);
  assert.equal(reg.msgCount, 2);
  assert.equal(reg.lastHash, hashOf(asst("b", 2)));
  const { v: v2, auth } = await viewer(r2);
  t.after(() => v2.close());
  assert.ok(auth.boot);
  v2.send({ type: "subscribe", room: ROOM, since: { rev: snap.rev, seq: snap.seq } });
  const delta = await v2.type("snapshot");
  assert.equal(delta.delta, true);
  assert.equal(delta.messages.length, 0);
});

test("同一扩展实例换 epoch 才重置存储；新实例（pi 重启）保留存储靠 hash 对齐", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay, { epoch: 1, instance: "inst-a" });
  c.send({ type: "snapshot", room: ROOM, messages: [user("u1", 1)] });
  await new Promise((r) => setTimeout(r, 50));
  c.close();

  const { c: c2, reg } = await local(relay, { epoch: 1, instance: "inst-b" });
  assert.equal(reg.msgCount, 1, "pi 重启（新 instance）不清库");
  c2.send({ type: "room_register", room: { id: ROOM, epoch: 2, instance: "inst-b" } });
  const reset = await c2.type("room_registered");
  assert.equal(reset.msgCount, 0, "同实例换 epoch（换分支）清库");
  assert.notEqual(reset.rev, reg.rev);
  c2.close();
});

test("command_result 里的大图同样降级成占位，viewer 单帧不超限", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  v.send({ type: "command", id: "q1", room: ROOM, command: "get_entry", args: {} });
  await v.type("command_accepted", (f) => f.id === "q1");
  const forwarded = await c.type("command");
  const big = "A".repeat(200 * 1024);
  c.send({
    type: "command_result",
    room: ROOM,
    id: forwarded.id,
    ok: true,
    data: { images: [{ type: "image", mimeType: "image/png", data: big }] },
  });
  const ack = await v.type("ack", (f) => f.id === "q1");
  const img = ack.data.images[0];
  assert.equal(img.data, "");
  assert.equal(img.omitted, true);
  assert.ok(img.omittedBytes > 100 * 1024, "占位要记下被删掉的体积");
  assert.ok(JSON.stringify(ack).length < 256 * 1024, "降级后的 ack 必须进得了 viewer 单帧预算");
});

test("room_list：离线房间仍下发（可回看），每条带 lastActivity", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  const online = await v.wait((f) => f.type === "room_list" && f.rooms.some((r) => r.id === ROOM && r.online));
  assert.equal(typeof online.rooms.find((r) => r.id === ROOM).lastActivity, "number");
  c.close();
  const gone = await v.wait((f) => f.type === "room_list" && f.rooms.some((r) => r.id === ROOM && !r.online));
  assert.equal(typeof gone.rooms.find((r) => r.id === ROOM).lastActivity, "number");
});

test("R3-1 回合摘要：落定进 room_list 并广播 room_attention；进房清、新活动清、aborted 不记", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  // 摘要是 cap 门控的新面（A-1）：本用例的 viewer 模拟新 UI，握手声明 room.attention
  const { v, auth } = await viewer(relay, undefined, { caps: ["room.attention"] });
  t.after(() => v.close());

  const entryOf = (frame) => (frame.rooms || []).find((r) => r.id === ROOM);
  // auth 快照的房间条目就带这个字段：还没落定过 → null
  assert.ok("lastTurnEnd" in entryOf(auth), "room_list 条目带 lastTurnEnd 字段");
  assert.equal(entryOf(auth).lastTurnEnd, null);

  const ev = (event) => c.send({ type: "event", room: ROOM, event });
  const pendingAttention = () => v.frames.filter((f) => f.type === "room_attention" && !f.__taken);
  const asstEnd = (stopReason) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1, stopReason },
  });

  // —— done：活动 → 助手终态 stop → settled ⇒ 摘要记 done，广播帧走字段白名单
  ev({ type: "agent_start" });
  ev(asstEnd("stop"));
  ev({ type: "agent_settled" });
  const doneFrame = await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd && f.lastTurnEnd.kind === "done");
  assert.deepEqual(Object.keys(doneFrame).filter((k) => k !== "__taken").sort(), ["lastTurnEnd", "room", "type"], "room_attention 帧只有 room + lastTurnEnd");
  assert.deepEqual(Object.keys(doneFrame.lastTurnEnd).sort(), ["at", "kind"], "摘要只有 kind/at，无正文无标题");
  assert.equal(typeof doneFrame.lastTurnEnd.at, "number");
  // 同回合重复 settled 不再广播（落定守卫，新活动才重置）
  ev({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pendingAttention().length, 0, "重复 settled 不重复广播");

  // —— 快照恢复：新 viewer 一连上，auth_result / list_rooms 都带摘要（刷新场景）
  const { v: v2, auth: auth2 } = await viewer(relay, "10.3.1.2", { caps: ["room.attention"] });
  t.after(() => v2.close());
  assert.equal(entryOf(auth2).lastTurnEnd.kind, "done");
  v2.send({ type: "list_rooms" });
  const list2 = await v2.type("room_list");
  assert.equal(entryOf(list2).lastTurnEnd.kind, "done");

  // —— 进房即已读（relay 落实）：任一 viewer 订阅进房 ⇒ 清摘要并广播 null
  v2.send({ type: "subscribe", room: ROOM });
  await v2.type("subscribed");
  await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd === null);
  v.send({ type: "list_rooms" });
  const listAfter = await v.type("room_list");
  assert.equal(entryOf(listAfter).lastTurnEnd, null, "进房后快照里摘要已清，不会复活");

  // —— error：终态 error 落定 ⇒ kind=error
  ev({ type: "agent_start" });
  ev(asstEnd("error"));
  ev({ type: "agent_settled" });
  await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd && f.lastTurnEnd.kind === "error");

  // —— 新活动清：下一回合刚开始，旧 error 摘要立刻清掉并广播 null
  ev({ type: "turn_start" });
  await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd === null);

  // —— aborted 不记：打断落定后无广播，快照仍为 null
  ev(asstEnd("aborted"));
  ev({ type: "agent_settled" });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(pendingAttention().length, 0, "aborted 落定不广播");
  v.send({ type: "list_rooms" });
  const listFinal = await v.type("room_list");
  assert.equal(entryOf(listFinal).lastTurnEnd, null);
});

test("R3-1 回合摘要·error 归一：stopReason=stop 但带 errorMessage 也记 error（第 3 轮审查 A-4）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay, undefined, { caps: ["room.attention"] });
  t.after(() => v.close());

  const ev = (event) => c.send({ type: "event", room: ROOM, event });
  // rooms 副本的终态判定与 notify 同口径：stopReason 本身不是 error 时，
  // 只要助手消息带 errorMessage 就按 error 落定（此前用例只覆盖 stopReason="error" 一路）。
  ev({ type: "agent_start" });
  ev({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1, stopReason: "stop", errorMessage: "模型调用失败" },
  });
  ev({ type: "agent_settled" });
  const frame = await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd && f.lastTurnEnd.kind === "error");
  assert.equal(frame.lastTurnEnd.kind, "error");
  v.send({ type: "list_rooms" });
  const list = await v.type("room_list");
  assert.equal((list.rooms || []).find((r) => r.id === ROOM).lastTurnEnd.kind, "error", "快照摘要同为 error");
});

test("A-1 门控：未声明 room.attention 的 viewer 不收 room_attention 帧、清单剥 lastTurnEnd；声明的照常", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v: capped, auth: authCap } = await viewer(relay, "10.4.0.1", { caps: ["room.attention"] });
  t.after(() => capped.close());
  const { v: plain, auth: authPlain } = await viewer(relay, "10.4.0.2");
  t.after(() => plain.close());

  const entryOf = (frame) => (frame.rooms || []).find((r) => r.id === ROOM);
  // auth_result 单发路径（listFor）：声明端带字段、未声明端整个字段不存在
  assert.ok("lastTurnEnd" in entryOf(authCap), "声明端 auth 快照带摘要字段");
  assert.equal(entryOf(authCap).lastTurnEnd, null);
  assert.ok(!("lastTurnEnd" in entryOf(authPlain)), "未声明端 auth 快照剥摘要字段（不是给 null，是不给）");

  const ev = (event) => c.send({ type: "event", room: ROOM, event });
  ev({ type: "agent_start" });
  ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1, stopReason: "stop" } });
  ev({ type: "agent_settled" });
  await capped.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd && f.lastTurnEnd.kind === "done");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(plain.frames.filter((f) => f.type === "room_attention").length, 0, "未声明端不收 room_attention 帧");

  // list_rooms 单发路径：先把旧帧全部标记已取，确保命中的是这次响应
  for (const f of capped.frames) f.__taken = true;
  capped.send({ type: "list_rooms" });
  const listCap = await capped.type("room_list");
  assert.equal(entryOf(listCap).lastTurnEnd.kind, "done", "声明端清单带落定摘要");
  for (const f of plain.frames) f.__taken = true;
  plain.send({ type: "list_rooms" });
  const listPlain = await plain.type("room_list");
  assert.ok(!("lastTurnEnd" in entryOf(listPlain)), "未声明端清单剥摘要字段");
  assert.equal(entryOf(listPlain).online, true, "只剥新面：在线等既有字段照常");

  // 广播路径（broadcastRoomList 按 cap 分流）：改名触发全体广播，两端各拿各的版本
  c.send({ type: "room_label", room: ROOM, label: "改名了" });
  await new Promise((r) => setTimeout(r, 250));
  const lastList = (api) => [...api.frames].reverse().find((f) => f.type === "room_list");
  assert.equal(entryOf(lastList(capped)).lastTurnEnd.kind, "done", "广播给声明端带摘要");
  assert.ok(!("lastTurnEnd" in entryOf(lastList(plain))), "广播给未声明端剥摘要");
});

test("A-2 换代清摘要：epoch 换代与 room_closed 都清 lastTurnEnd 并补广播 null", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay, undefined, { caps: ["room.attention"] });
  t.after(() => v.close());

  const ev = (event) => c.send({ type: "event", room: ROOM, event });
  const settleDone = async () => {
    ev({ type: "agent_start" });
    ev({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1, stopReason: "stop" } });
    ev({ type: "agent_settled" });
    await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd && f.lastTurnEnd.kind === "done");
  };
  await settleDone();

  // —— epoch 换代（同连接重注册）：存储重置 + 摘要清 + 补广播 null
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 2, instance: "inst-a" } });
  await c.type("room_registered");
  await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd === null);
  for (const f of v.frames) f.__taken = true;
  v.send({ type: "list_rooms" });
  const list1 = await v.type("room_list");
  assert.equal((list1.rooms || []).find((r) => r.id === ROOM).lastTurnEnd, null, "换代后快照摘要为 null，刷新端种不回旧落定");

  // —— 再落定一次，room_closed 同样清 + 补广播 null
  await settleDone();
  c.send({ type: "room_closed", room: ROOM });
  await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd === null);
  for (const f of v.frames) f.__taken = true;
  v.send({ type: "list_rooms" });
  const list2 = await v.type("room_list");
  assert.equal((list2.rooms || []).find((r) => r.id === ROOM).lastTurnEnd, null, "room_closed 后摘要已清");
});

test("退订后不再收兜底快照；留在房间里的观众照常拿到空快照", async (t) => {
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: false,
    resendSnapshotWaitMs: 200,
  });
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  // 新 relay（内存空、不落盘）：本机还没推过快照 → 订阅走"请本机重推"分支，200ms 后兜底空快照
  assert.equal(relay.store.info(ROOM).rev, null, "没有任何记录时没有世代可言");

  const { v: staying } = await viewer(relay);
  t.after(() => staying.close());
  const { v: leaving } = await viewer(relay);
  t.after(() => leaving.close());

  staying.send({ type: "subscribe", room: ROOM });
  await staying.type("subscribed");
  leaving.send({ type: "subscribe", room: ROOM });
  await leaving.type("subscribed");
  await c.type("resend_snapshot");
  leaving.send({ type: "unsubscribe", room: ROOM });
  const fallback = await staying.type("snapshot", (f) => f.snapshotPending === true);
  assert.equal(fallback.snapshotPending, true);
  // 原来写死 assert.equal(fallback.rev, null)：这个用例里存储本来就没有记录，null 是必然结果，
  // 断言永远为真、什么都锁不住。改成和存储世代对照，才真的在验"兜底帧带真实 rev/seq"。
  assert.equal(fallback.rev, relay.store.info(ROOM).rev, "兜底帧的 rev 必须跟存储世代一致（这里确实是 null：一条记录都还没有）");
  assert.equal(fallback.seq, relay.store.info(ROOM).seq, "seq 同样要对得上存储");
  assert.equal(fallback.messages.length, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(leaving.frames.some((f) => f.type === "snapshot"), false, "退订的人不该再收到兜底快照");
});

test("本机推空的全量快照也是快照：等首帧的观众立刻拿到空快照，不会一直挂着", async (t) => {
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: false,
    // 兜底放得很晚：2s 内收到只可能是本机推的空快照，不可能来自兜底
    resendSnapshotWaitMs: 10000,
  });
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  // 订阅已经把观众放进等待名单，relay 也向本机要了 resend_snapshot
  await c.type("resend_snapshot");
  c.send({ type: "snapshot", room: ROOM, busy: false, messages: [] });

  const snap = await v.type("snapshot", () => true, 2000, "本机空快照");
  assert.notEqual(snap.snapshotPending, true, "空快照已经到齐，不能再标待拉取");
  assert.deepEqual(snap.messages, []);
  assert.equal(snap.rev, relay.store.info(ROOM).rev);
  assert.equal(snap.seq, relay.store.info(ROOM).seq);
});

test("限速帧带回请求 id：查询能立刻失败，不用干等 10s 超时", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  // 令牌桶默认 60 突发：连续打 70 个带 id 的查询，后面的必然被限速
  for (let i = 0; i < 70; i++) v.send({ type: "get_sessions", id: "q-" + i, deviceId: "no-such" });
  const err = await v.type("error", (f) => f.code === "rate_limited");
  assert.match(String(err.id), /^q-/, "rate_limited 必须带回原始请求 id，否则 UI 只能等超时");
});

test("room_label：改名只更新标题并广播，不走整包 room_register", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  await v.type("room_list", (f) => f.rooms.some((r) => r.id === ROOM));
  const regsBefore = c.frames.filter((f) => f.type === "room_registered").length;
  c.send({ type: "room_label", room: ROOM, label: "新名字" });
  const after = await v.type("room_list", (f) => f.rooms.some((r) => r.id === ROOM && r.label === "新名字"));
  assert.equal(after.rooms.find((r) => r.id === ROOM).label, "新名字");
  assert.equal(c.frames.filter((f) => f.type === "room_registered").length, regsBefore, "改名不该触发重注册");
  // 空 label 不能把标题抹掉
  c.send({ type: "room_label", room: ROOM, label: "" });
  await new Promise((r) => setTimeout(r, 60));
  const last = v.frames.filter((f) => f.type === "room_list").pop();
  assert.equal(last.rooms.find((r) => r.id === ROOM).label, "新名字");
});


test("persistTranscripts=false（生产默认）：本机断开后离线房间仍在列表、仍能回看内存里的记录，数据目录不落正文", async (t) => {
  const dataDir = tmpDir();
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir,
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: false,
  });
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("a", 1) } });
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: asst("b", 2) } });
  await v.type("room_event", (f) => f.event.type === "message_end" && f.seq === 2);
  c.close();
  const gone = await v.wait((f) => f.type === "room_list" && f.rooms.some((r) => r.id === ROOM && !r.online));
  assert.ok(gone.rooms.find((r) => r.id === ROOM), "离线房间仍下发");

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  const snap = await late.type("snapshot");
  assert.deepEqual(snap.messages.map((m) => m.content[0].text), ["a", "b"], "离线后仍能从内存回看");
  await new Promise((r) => setTimeout(r, 50));
  const files = fs.readdirSync(dataDir).filter((n) => n.endsWith(".jsonl"));
  assert.deepEqual(files, [], "不落盘模式下 data/rooms 不能出现正文文件");
});

test("会话换代重置后，兜底快照带新的真实 rev（不能退化成 null）", async (t) => {
  // snapshotCacheTtlMs=1：观众订阅时内存快照必然已过期，一定走"请本机重推"分支
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: false,
    snapshotCacheTtlMs: 1,
    resendSnapshotWaitMs: 200,
  });
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("a", 1) } });
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: asst("b", 2) } });
  await new Promise((r) => setTimeout(r, 30));
  const before = relay.store.info(ROOM);
  assert.ok(before.rev, "有记录就有世代");

  // 同一扩展实例把 epoch 抬高（/tree 跳转后的换代）：存储整体重置，等重新 seed
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 2, instance: "inst-a" } });
  await c.type("room_registered");
  const after = relay.store.info(ROOM);
  assert.ok(after.rev && after.rev !== before.rev, "换代要换新世代");

  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  const fallback = await v.type("snapshot", (f) => f.snapshotPending === true);
  assert.equal(fallback.rev, after.rev, "兜底帧必须带重置后的真实 rev：rev=null 会被前端当成世代变了而多打一次全量重订阅");
  assert.equal(fallback.seq, after.seq);
  assert.deepEqual(fallback.messages, []);
});

test("新 attach 窗口顶替旧窗口：等首帧快照的 viewer 不该被永久挂住", async (t) => {
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: false,
    resendSnapshotWaitMs: 200,
  });
  t.after(() => relay.close());
  const DEV = "dev-rebind";
  // 生产拓扑：attach 窗口一条连接（device_register），扩展另一条（room_register 带 deviceId）
  const win = client(relay.localPort);
  await win.opened;
  win.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await win.type("auth_result");
  win.send({ type: "device_register", device: { id: DEV, name: "Windows", platform: "windows", projects: ["D:\\work"], windowExpiresAt: Date.now() + 3600_000 } });
  t.after(() => win.close());
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-a", deviceId: DEV } });
  await c.type("room_registered");
  t.after(() => c.close());

  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("subscribed");
  await c.type("resend_snapshot"); // 观众已进等待名单，就等本机重推

  // 第二个 attach 窗口用同一个 deviceId 登记：顶替旧窗口
  const win2 = client(relay.localPort);
  await win2.opened;
  win2.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await win2.type("auth_result");
  t.after(() => win2.close());
  win2.send({ type: "device_register", device: { id: DEV, name: "Windows-2", platform: "windows", projects: ["D:\\work"], windowExpiresAt: Date.now() + 3600_000 } });
  // device_replaced 是顶替路径已经跑过的精确同步点（restartResend 就在它后面几行）
  await win.type("device_replaced");

  // 顶替只能作废旧窗口发起的那次重发，不能把等待中的 viewer 一起丢掉
  const snap = await v.type("snapshot", (f) => f.snapshotPending === true, 3000, "顶替后的兜底快照");
  assert.equal(snap.snapshotPending, true);
});

test("v4 握手：auth_result 回 relay 的 proto 和已实现的能力；local 连接标 legacy", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = client(relay.localPort);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps: ["err.v4", "msg.cid", "no.such.cap"], client: { kind: "extension", version: "4.0.0", platform: "macos" } });
  const la = await c.type("auth_result");
  assert.equal(la.ok, true);
  assert.equal(la.proto, PROTOCOL.proto);
  assert.equal(la.auth, "legacy", "共享 localToken 登录的连接是 legacy");
  // 不算 relay 已实现能力的协议能力项：
  // - agent.state 仍是协议预留位（没有生产者）；
  // - session.files / fs.browse 是 attach 声明、relay 只转发的能力（P9 B/C），
  //   设备侧能力经 room_list.devices[].features 透传，不冒充 relay 自己的能力。
  // dialog.respond 已随第 2 轮 O2 落地（relay 转发应答/门控/开关），是已实现能力（随 R2-1 更新）；
  // room.dialogs（P9 A）、session.purge（P9 B）由 relay 自己实现，必须声明。
  const notRelayCaps = new Set(["agent.state", "session.files", "fs.browse"]);
  assert.deepEqual(
    [...la.caps].sort(),
    Object.keys(PROTOCOL.caps).filter((cap) => !notRelayCaps.has(cap)).sort(),
    "已实现能力全部声明；预留/设备侧能力不冒充已实现",
  );
  for (const cap of la.caps) assert.ok(cap in PROTOCOL.caps, cap);

  const v = client(relay.viewerPort);
  t.after(() => v.close());
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4, caps: ["err.v4"], client: { kind: "viewer", version: "4.0.0" } });
  const va = await v.type("auth_result");
  assert.equal(va.ok, true);
  assert.equal(va.proto, PROTOCOL.proto);
  assert.deepEqual(va.caps, la.caps);
  assert.equal(va.boot, la.boot, "两条通道报的是同一个 relay 进程实例");
  assert.equal("auth" in va, false, "auth 字段只在 local 通道");
  assert.ok(Array.isArray(va.rooms) && Array.isArray(va.devices), "v3 的字段照旧");

  // 不带 proto 的旧客户端照常登录，房间注册等 v3 流程不受影响
  const { c: old, reg } = await local(relay);
  t.after(() => old.close());
  assert.equal(reg.room, ROOM);
});

test("鉴权失败：auth_result 带 code=auth_failed，连接以 4003 关闭（两条通道）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  for (const [port, role] of [[relay.localPort, "local"], [relay.viewerPort, "viewer"]]) {
    const c = client(port);
    t.after(() => c.close());
    await c.opened;
    const closed = new Promise((resolve) => c.ws.once("close", (code) => resolve(code)));
    c.send({ type: "auth", role, token: "wrong", proto: 4 });
    const r = await c.type("auth_result");
    assert.equal(r.ok, false);
    assertCoded(r, "auth_failed");
    assert.equal(await closed, 4003, role);
  }
});

/** 未认证连接发一帧（业务帧或错误帧）：应当只收到 auth_failed 然后被 4003 关闭。 */
async function preauthFrame(relay, frame) {
  const c = client(relay.viewerPort);
  await c.opened;
  const closed = new Promise((resolve) => c.ws.once("close", (code) => resolve(code)));
  c.send(frame);
  const r = await c.type("auth_result");
  assert.equal(r.ok, false);
  assertCoded(r, "auth_failed");
  assert.equal(await closed, 4003);
  assert.deepEqual(c.frames.map((f) => f.type), ["auth_result"], "未认证帧不能换来任何业务响应");
  c.close();
}

/** 用错 token 认证：应当 auth_failed 并 4003。 */
async function failViewerAuth(relay, source) {
  const c = client(relay.viewerPort, { headers: { "x-forwarded-for": source } });
  await c.opened;
  const closed = new Promise((resolve) => c.ws.once("close", (code) => resolve(code)));
  c.send({ type: "auth", role: "viewer", token: "wrong-token", proto: 4 });
  const r = await c.type("auth_result");
  assert.equal(r.ok, false);
  assertCoded(r, "auth_failed");
  assert.equal(await closed, 4003);
  c.close();
}

test("viewer 认证失败按来源短时锁定：成功认证清零、其他来源不受影响", async (t) => {
  const relay = await boot(tmpDir(), {
    viewerAuthFailMax: 3,
    viewerAuthFailWindowMs: 5000,
    viewerAuthLockMs: 300,
  });
  t.after(() => relay.close());
  const A = "198.51.100.10";
  const B = "198.51.100.11";
  const C = "198.51.100.12";

  for (let i = 0; i < 3; i++) await failViewerAuth(relay, A);

  // 第 4 个连接在认证前就被拒：锁定期间连试 token 的窗口都不给。
  // 只关 1013、不下发 auth_result/error：观看端不会因为限流清掉本地 token，也不会留下过期提示。
  const blocked = client(relay.viewerPort, { headers: { "x-forwarded-for": A } });
  t.after(() => blocked.close());
  const blockedClose = new Promise((resolve) => blocked.ws.once("close", (code) => resolve(code)));
  await blocked.opened;
  assert.equal(await blockedClose, 1013);
  assert.deepEqual(blocked.frames, [], "锁定期间不下发任何帧，客户端按 1013 自行退避重连");

  // 别的来源照常登录：限流按来源记账，不是全局锁
  const { v: other } = await viewer(relay, B);
  t.after(() => other.close());

  // 短时锁定到期后，同一来源恢复正常（正常重连不能永久锁死）
  await new Promise((r) => setTimeout(r, 400));
  const { v: recovered } = await viewer(relay, A);
  t.after(() => recovered.close());

  // 成功认证会清空失败计数：两轮各错 2 次（都不到 3 次）后仍能登录
  await failViewerAuth(relay, C);
  await failViewerAuth(relay, C);
  const { v: cleared } = await viewer(relay, C);
  t.after(() => cleared.close());
  await failViewerAuth(relay, C);
  await failViewerAuth(relay, C);
  const { v: clearedAgain } = await viewer(relay, C);
  t.after(() => clearedAgain.close());
});

test("viewer 未认证连接数上限：满额拒绝 1013，认证成功或断开后释放", async (t) => {
  const relay = await boot(tmpDir(), { maxUnauthenticatedViewers: 1 });
  t.after(() => relay.close());

  const first = client(relay.viewerPort);
  await first.opened;
  t.after(() => first.close());
  await new Promise((r) => setTimeout(r, 100)); // 等服务端 connection 回调记账

  const rejected = client(relay.viewerPort);
  const rejectedClose = new Promise((resolve) => rejected.ws.once("close", (code) => resolve(code)));
  await rejected.opened;
  assert.equal(await rejectedClose, 1013, "超过未认证上限应以 1013 关闭");
  rejected.close();

  // 认证成功立即释放名额
  first.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
  const auth = await first.type("auth_result");
  assert.equal(auth.ok, true);
  const second = client(relay.viewerPort);
  await second.opened;
  t.after(() => second.close());
  await new Promise((r) => setTimeout(r, 100));
  const rejected2 = client(relay.viewerPort);
  const rejected2Close = new Promise((resolve) => rejected2.ws.once("close", (code) => resolve(code)));
  await rejected2.opened;
  assert.equal(await rejected2Close, 1013, "认证后释放的名额要先被未认证连接占用，再次超限仍拒绝");
  rejected2.close();

  // 未认证连接直接断开也要释放名额
  second.close();
  await new Promise((r) => setTimeout(r, 200));
  const third = client(relay.viewerPort);
  await third.opened;
  t.after(() => third.close());
  third.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
  assert.equal((await third.type("auth_result")).ok, true, "断开未认证连接后名额应释放");
});

test("viewer 未认证先发业务帧：拒绝并断开，不产生订阅/命令副作用", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const room = relay.rooms.peek(ROOM);
  assert.equal(room.viewers.size, 0);

  await preauthFrame(relay, { type: "subscribe", room: ROOM });
  await preauthFrame(relay, { type: "command", id: "pre-cmd", room: ROOM, command: "get_state", args: {} });
  await preauthFrame(relay, { type: "message", id: "pre-msg", room: ROOM, text: "hi" });
  await preauthFrame(relay, { type: "abort", id: "pre-abort", room: ROOM });
  await preauthFrame(relay, { type: "pair_create", id: "pre-pair" });

  assert.equal(room.viewers.size, 0, "未认证 subscribe 不能把连接加进观看者");
  assert.equal(room.resendWaiters ? room.resendWaiters.length : 0, 0);
  assert.equal(relay.rooms.commandWaiters.size, 0, "未认证 command 不能被转发并挂起");
  assert.equal(relay.rooms.dedupe.size, 0);
  assert.equal(c.frames.some((f) => ["command", "message", "abort"].includes(f.type)), false, "本机一条业务帧都不该收到");
});

test("viewer 认证防护有安全默认值：老 config.json 不补字段也不会关掉防护", () => {
  assert.equal(DEFAULT_CONFIG.maxUnauthenticatedViewers, 100);
  assert.equal(DEFAULT_CONFIG.viewerAuthFailMax, 10);
  assert.equal(DEFAULT_CONFIG.viewerAuthFailWindowMs, 60 * 1000);
  assert.equal(DEFAULT_CONFIG.viewerAuthLockMs, 30 * 1000);
});

test("令牌强度：拒绝短于 16 字符/占位符，启动时明确拒绝且不回显令牌", () => {
  assert.equal(MIN_TOKEN_LENGTH, 16);
  assert.equal(usableToken(""), "");
  assert.equal(usableToken("   "), "");
  assert.equal(usableToken("change-me"), "");
  assert.equal(usableToken("x".repeat(MIN_TOKEN_LENGTH - 1)), "");
  assert.equal(usableToken("x".repeat(MIN_TOKEN_LENGTH)), "x".repeat(MIN_TOKEN_LENGTH));
  assert.equal(usableToken("  " + "y".repeat(MIN_TOKEN_LENGTH) + "  "), "y".repeat(MIN_TOKEN_LENGTH));

  const weak = "weak-token";
  const res = spawnSync(process.execPath, ["relay/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PI_REMOTE_LOCAL_TOKEN: weak, PI_REMOTE_VIEWER_TOKEN: weak },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, new RegExp(`长度不足 ${MIN_TOKEN_LENGTH} 字符`));
  assert.equal(res.stderr.includes(weak), false, "启动日志不能回显令牌内容");
});

test("adminToken 配置：沿用 16 字符下限，未配置只警告“管理员功能已禁用”，启动日志不打印值", () => {
  assert.equal(DEFAULT_CONFIG.adminToken, "", "未配置时管理功能默认关闭");
  const probe = (adminToken, { local = LOCAL_TOKEN, viewer = VIEWER_TOKEN } = {}) => {
    const script = [
      'const { loadConfig } = require("./relay/config");',
      'let logs = "";',
      'const realLog = console.log, realError = console.error;',
      'console.log = (...a) => { logs += a.join(" ") + "\\n"; };',
      'console.error = (...a) => { logs += a.join(" ") + "\\n"; };',
      'const cfg = loadConfig();',
      'console.log = realLog; console.error = realError;',
      'process.stdout.write(JSON.stringify({ len: cfg.adminToken.length, logs }));',
    ].join("\n");
    const res = spawnSync(process.execPath, ["-e", script], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        PI_REMOTE_LOCAL_TOKEN: local,
        PI_REMOTE_VIEWER_TOKEN: viewer,
        PI_REMOTE_ADMIN_TOKEN: adminToken,
      },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout);
  };

  const unset = probe("");
  assert.equal(unset.len, 0);
  assert.match(unset.logs, /管理员功能已禁用/);
  assert.equal(unset.logs.includes("PI_REMOTE_ADMIN_TOKEN="), false, "日志只提变量名，不带值");

  const weak = "weak-admin";
  const rejected = probe(weak);
  assert.equal(rejected.len, 0);
  assert.match(rejected.logs, /adminToken 长度不足 16 字符/);
  assert.match(rejected.logs, /管理员功能已禁用/);
  assert.equal(rejected.logs.includes(weak), false, "弱 adminToken 也不回显");

  const configured = probe(ADMIN_TOKEN);
  assert.equal(configured.len, ADMIN_TOKEN.length);
  assert.doesNotMatch(configured.logs, /管理员功能已禁用/);
  assert.doesNotMatch(configured.logs, /分权失效/, "三个令牌互不相同时不该告警");
  assert.equal(configured.logs.includes(ADMIN_TOKEN), false, "启动日志不能打印 adminToken 的值");

  // adminToken 与 local/viewer 相同：明确告警但 relay 继续（loadConfig 正常返回），同样不打印令牌值
  const sameLocal = probe(LOCAL_TOKEN);
  assert.equal(sameLocal.len, LOCAL_TOKEN.length);
  assert.match(sameLocal.logs, /管理员令牌与 local\/viewer 相同，分权失效/);
  assert.match(sameLocal.logs, /adminToken 与 localToken 相同/);
  assert.equal(sameLocal.logs.includes(LOCAL_TOKEN), false, "告警不能带出令牌值");

  const sameViewer = probe(VIEWER_TOKEN);
  assert.match(sameViewer.logs, /管理员令牌与 local\/viewer 相同，分权失效/);
  assert.match(sameViewer.logs, /adminToken 与 viewerToken 相同/);
  assert.equal(sameViewer.logs.includes(VIEWER_TOKEN), false, "告警不能带出令牌值");

  const sameBoth = probe(LOCAL_TOKEN, { viewer: LOCAL_TOKEN });
  assert.match(sameBoth.logs, /adminToken 与 localToken \/ viewerToken 相同/);
  assert.equal(sameBoth.logs.includes(LOCAL_TOKEN), false, "两个都相同也只说字段名");
});

test("启动时 adminToken 与 localToken 相同：告警分权失效、不打印值，relay 仍启动", async (t) => {
  const errors = [];
  const realError = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  let relay;
  try {
    relay = await boot(tmpDir(), { localToken: LOCAL_TOKEN, adminToken: LOCAL_TOKEN });
  } finally {
    console.error = realError;
  }
  t.after(() => relay.close());
  const logs = errors.join("\n");
  assert.match(logs, /管理员令牌与 local\/viewer 相同，分权失效/);
  assert.match(logs, /adminToken 与 localToken 相同/);
  assert.equal(logs.includes(LOCAL_TOKEN), false, "告警不能带出令牌值");
  // 仍然能启动并接受 viewer 认证（只告警，不阻断）
  const { v } = await viewer(relay);
  t.after(() => v.close());
});

test("config.json 数值字段：非法类型/负数/NaN/小数/越界回退默认并逐项告警", () => {
  const cfg = {
    localPort: 70000,
    viewerPort: "7002",
    maxPayloadBytes: "262144",
    ratePerSec: -1,
    flushIntervalMs: 0,
    retentionDays: Number.NaN,
    viewerLagBytes: 1.5,
    maxSnapshotRecords: null,
    maxSnapshotBytes: { bytes: 1 },
    dedupeTtlMs: 1234,
    pairCodeTtlMs: 600000,
  };
  const warnings = [];
  sanitizeNumericConfig(cfg, DEFAULT_CONFIG, (msg) => warnings.push(msg));
  for (const key of ["localPort", "viewerPort", "maxPayloadBytes", "ratePerSec", "flushIntervalMs", "retentionDays", "viewerLagBytes", "maxSnapshotRecords", "maxSnapshotBytes"]) {
    assert.equal(cfg[key], DEFAULT_CONFIG[key], key + " 应回退默认值");
    assert.ok(warnings.some((m) => m.includes("字段 " + key + " 非法")), key + " 缺告警");
  }
  assert.equal(warnings.length, 9, warnings.join("\n"));
  assert.equal(cfg.dedupeTtlMs, 1234, "合法数值不能被误伤");
  assert.equal(cfg.pairCodeTtlMs, 600000);

  assert.equal(positiveInt("-1", 20), 20);
  assert.equal(positiveInt("0", 20), 20);
  assert.equal(positiveInt("12", 20), 12);
  assert.equal(positiveInt(1.5, 20), 20);
  assert.equal(positiveInt(Number.NaN, 20), 20);
  assert.equal(positiveInt(3, 20), 3);
});

test("loadConfig：config.json 的数值字段走校验（回退默认、告警、合法值保留）", () => {
  const file = path.join(tmpDir(), "config.json");
  fs.writeFileSync(file, JSON.stringify({
    localPort: "8001",
    viewerPort: 7002,
    maxPayloadBytes: "big",
    ratePerSec: -5,
    flushIntervalMs: 0,
    retentionDays: 1.5,
    viewerLagBytes: null,
    maxSnapshotRecords: 12345,
    dedupeTtlMs: 1234,
  }));
  const script = [
    'const { loadConfig } = require("./relay/config");',
    'const cfg = loadConfig(process.argv[1]);',
    'process.stdout.write(JSON.stringify({',
    '  localPort: cfg.localPort, viewerPort: cfg.viewerPort,',
    '  maxPayloadBytes: cfg.maxPayloadBytes, ratePerSec: cfg.ratePerSec,',
    '  flushIntervalMs: cfg.flushIntervalMs, retentionDays: cfg.retentionDays,',
    '  viewerLagBytes: cfg.viewerLagBytes, maxSnapshotRecords: cfg.maxSnapshotRecords,',
    '  dedupeTtlMs: cfg.dedupeTtlMs,',
    '}));',
  ].join("\n");
  const res = spawnSync(process.execPath, ["-e", script, file], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PI_REMOTE_LOCAL_TOKEN: LOCAL_TOKEN,
      PI_REMOTE_VIEWER_TOKEN: VIEWER_TOKEN,
      PI_REMOTE_ADMIN_TOKEN: ADMIN_TOKEN,
      PI_REMOTE_LOCAL_PORT: "",
      PI_REMOTE_VIEWER_PORT: "",
      PI_REMOTE_LOCAL_HOST: "",
      PI_REMOTE_VIEWER_HOST: "",
      PI_REMOTE_DATA_DIR: "",
      PI_REMOTE_ACCOUNTS_DIR: "",
      PI_REMOTE_RELAY_ACCOUNT: "",
      PI_REMOTE_PERSIST_TRANSCRIPTS: "",
      PI_REMOTE_ALLOW_LEGACY_LOCAL: "",
    },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(res.status, 0, res.stderr);
  const cfg = JSON.parse(res.stdout);
  assert.equal(cfg.localPort, DEFAULT_CONFIG.localPort, "字符串端口按非法类型回退");
  assert.equal(cfg.viewerPort, 7002);
  assert.equal(cfg.maxPayloadBytes, DEFAULT_CONFIG.maxPayloadBytes);
  assert.equal(cfg.ratePerSec, DEFAULT_CONFIG.ratePerSec);
  assert.equal(cfg.flushIntervalMs, DEFAULT_CONFIG.flushIntervalMs);
  assert.equal(cfg.retentionDays, DEFAULT_CONFIG.retentionDays);
  assert.equal(cfg.viewerLagBytes, DEFAULT_CONFIG.viewerLagBytes);
  assert.equal(cfg.maxSnapshotRecords, 12345, "合法值要保留");
  assert.equal(cfg.dedupeTtlMs, 1234, "合法值要保留");
  for (const key of ["localPort", "maxPayloadBytes", "ratePerSec", "flushIntervalMs", "retentionDays", "viewerLagBytes"]) {
    assert.match(res.stderr, new RegExp("config.json 字段 " + key + " 非法"), key);
  }
});

test("管理员令牌：pair_create/device_revoke 必须校验；失败无副作用，viewer 普通功能不受影响", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  const ackFor = async (frame) => {
    v.send(frame);
    return v.type("ack", (f) => f.id === frame.id);
  };
  const stripId = (ack) => {
    const { id, ...rest } = ack;
    return rest;
  };
  const expectAdminRequired = (ack) => {
    assert.equal(ack.ok, false, JSON.stringify(ack));
    assert.equal(ack.code, "admin_required", JSON.stringify(ack));
    assert.equal(ack.error, "需要管理员令牌");
    assert.equal("data" in ack, false, "失败响应不能带配对码/撤销结果");
    assert.equal("retryable" in ack, false);
  };

  // 不带/带错 adminToken：响应完全一致，不泄露 relay 到底配没配管理员令牌
  const noToken = await ackFor({ type: "pair_create", id: "pc-no-token" });
  const wrongToken = await ackFor({ type: "pair_create", id: "pc-wrong-token", adminToken: "x".repeat(ADMIN_TOKEN.length) });
  expectAdminRequired(noToken);
  expectAdminRequired(wrongToken);
  assert.deepEqual(stripId(noToken), stripId(wrongToken));

  // 失败 21 次（超过未用码上限）后，正确令牌仍能生成码：证明失败路径没有偷偷留下配对码
  for (let i = 0; i <= PAIR_CODES_MAX; i++) {
    const frame = i % 2
      ? { type: "pair_create", id: "pc-denied-" + i, adminToken: "wrong-admin-token" + i }
      : { type: "pair_create", id: "pc-denied-" + i };
    expectAdminRequired(await ackFor(frame));
  }
  const created = await ackFor({ type: "pair_create", id: "pc-admin-ok", adminToken: ADMIN_TOKEN });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(created.data.expiresAt > Date.now());

  // viewer 的普通消息不受管理员校验影响
  v.send({ type: "message", id: "msg-ok", room: ROOM, text: "普通消息" });
  assert.equal((await v.type("ack", (f) => f.id === "msg-ok")).ok, true);

  // 登记一台设备，验证撤销的失败路径不断连接、不删名册；正确令牌才真撤销
  const win = client(relay.localPort);
  t.after(() => win.close());
  await win.opened;
  win.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await win.type("auth_result");
  win.send({ type: "device_register", device: { id: "admin-dev", name: "Windows", platform: "windows", projects: ["D:\\work"], windowExpiresAt: Date.now() + 3600_000 } });
  await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === "admin-dev" && d.online));
  assert.equal(relay.devices.has("admin-dev"), true);

  const revokedAck = await ackFor({ type: "device_revoke", id: "rv-no-token", deviceId: "admin-dev" });
  expectAdminRequired(revokedAck);
  const revokedWrong = await ackFor({ type: "device_revoke", id: "rv-wrong-token", deviceId: "admin-dev", adminToken: ADMIN_TOKEN + "x" });
  expectAdminRequired(revokedWrong);
  assert.equal(win.ws.readyState, WebSocket.OPEN, "未通过管理员校验不能断开设备");
  assert.equal(relay.devices.has("admin-dev"), true, "未通过管理员校验不能删名册");

  const closed = new Promise((resolve) => win.ws.once("close", (code) => resolve(code)));
  const revoked = await ackFor({ type: "device_revoke", id: "rv-admin-ok", deviceId: "admin-dev", adminToken: ADMIN_TOKEN });
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  assert.deepEqual(revoked.data, { revoked: 0, closed: 1 });
  assert.equal(await closed, 4003);
  // ws close 事件与 relay 的 dropDevice 状态更新可能差一个 tick：等名册落定再断言
  for (let i = 0; i < 50 && relay.devices.get("admin-dev")?.online; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(relay.devices.get("admin-dev").online, false, "正确令牌才断开设备连接");

  // 完全没配置 adminToken 的 relay：带“看起来正确”的令牌也必须拒绝，错误形状与不匹配时一致
  const unconfigured = await boot(tmpDir(), { adminToken: "" });
  t.after(() => unconfigured.close());
  const { v: offViewer } = await viewer(unconfigured);
  t.after(() => offViewer.close());
  offViewer.send({ type: "pair_create", id: "pc-unconfigured", adminToken: ADMIN_TOKEN });
  const offAck = await offViewer.type("ack", (f) => f.id === "pc-unconfigured");
  expectAdminRequired(offAck);
  assert.deepEqual(stripId(offAck), stripId(noToken), "错误响应不能泄露 relay 是否配置了 adminToken");
  offViewer.send({ type: "device_revoke", id: "rv-unconfigured", deviceId: "admin-dev", adminToken: ADMIN_TOKEN });
  expectAdminRequired(await offViewer.type("ack", (f) => f.id === "rv-unconfigured"));
});

test("err.v4：viewer 通道的失败都带码表里的 code，retryable 跟码表走", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());

  v.send({ type: "message", id: "m-none", room: "no-such-room", text: "hi" });
  assertCoded(await v.type("ack", (f) => f.id === "m-none"), "no_room");
  v.send({ type: "message", id: "m-empty", room: ROOM, text: "  " });
  assertCoded(await v.type("ack", (f) => f.id === "m-empty"), "bad_args");
  v.send({ type: "command", id: "c-none", room: "no-such-room", command: "get_state", args: {} });
  assertCoded(await v.type("ack", (f) => f.id === "c-none"), "no_room");
  v.send({ type: "abort", id: "a-none", room: "no-such-room" });
  assertCoded(await v.type("ack", (f) => f.id === "a-none"), "no_room");
  v.send({ type: "history", id: "h1", room: ROOM });
  assertCoded(await v.type("ack", (f) => f.id === "h1"), "unsupported");
  v.send({ type: "subscribe", room: "no-such-room" });
  assertCoded(await v.type("error", (f) => f.room === "no-such-room"), "no_room");
  v.send({ type: "no_such_frame", id: "u1" });
  const unknown = await v.type("error", (f) => f.code === "unknown_type");
  assertCoded(unknown, "unknown_type");
  assert.equal(unknown.id, "u1", "带 id 的请求被拒也要能对上号");
  v.ws.send("{not json");
  assertCoded(await v.type("error", (f) => f.code === "bad_json"), "bad_json");

  // 本机断开后房间还在（可回看）：发消息、命令、中断都是 room_offline，可重试
  c.close();
  await v.type("room_list", (f) => f.rooms.some((r) => r.id === ROOM && !r.online));
  v.send({ type: "message", id: "m-off", room: ROOM, text: "hi" });
  assertCoded(await v.type("ack", (f) => f.id === "m-off"), "room_offline");
  v.send({ type: "command", id: "c-off", room: ROOM, command: "get_state", args: {} });
  assertCoded(await v.type("ack", (f) => f.id === "c-off"), "room_offline");
  v.send({ type: "abort", id: "a-off", room: ROOM });
  assertCoded(await v.type("ack", (f) => f.id === "a-off"), "room_offline");
});

test("message/abort：本机 send() 失败时不回 ok，回可重试失败 ack；恢复后照常送达", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  const room = relay.rooms.peek(ROOM);
  const realLocal = room.local;
  const fakeLocal = (overrides = {}) => ({
    readyState: 1,
    bufferedAmount: 0,
    _state: null,
    terminated: false,
    send() { return false; },
    terminate() { this.terminated = true; },
    ...overrides,
  });
  try {
    // wire.send 对积压到硬顶的连接会 terminate 并返回 false：message 不能回 ok
    const capped = fakeLocal({ bufferedAmount: DEFAULT_CONFIG.viewerMaxBufferBytes + 1 });
    room.local = capped;
    v.send({ type: "message", id: "m-drop", room: ROOM, text: "first" });
    const mack = await v.type("ack", (f) => f.id === "m-drop");
    assert.equal(mack.ok, false, "send 失败不能回 ok");
    assertCoded(mack, "busy");
    assert.match(mack.error, /积压/);
    assert.equal(capped.terminated, true, "积压到硬顶的连接应被断开");
    assert.equal(c.frames.some((f) => f.type === "message" && f.text === "first"), false, "失败帧不能到达本机");

    // 底层 send 抛异常（wire.send 返回 false，readyState 仍为 1）：abort 同样不能假成功
    const throwing = fakeLocal({ send() { throw new Error("send failed"); } });
    room.local = throwing;
    v.send({ type: "abort", id: "a-drop", room: ROOM });
    const aack = await v.type("ack", (f) => f.id === "a-drop");
    assert.equal(aack.ok, false, "abort 同样不能假成功");
    assertCoded(aack, "busy");
    assert.match(aack.error, /积压/);
    assert.equal(throwing.terminated, false);
    assert.equal(c.frames.some((f) => f.type === "abort"), false);

    // 对端已经断开：稳定回 room_offline
    room.local = fakeLocal({ readyState: 3 });
    v.send({ type: "message", id: "m-gone", room: ROOM, text: "gone" });
    assertCoded(await v.type("ack", (f) => f.id === "m-gone"), "room_offline");
  } finally {
    room.local = realLocal;
  }

  v.send({ type: "message", id: "m-ok", room: ROOM, text: "second" });
  const forwarded = await c.type("message", (f) => f.text === "second");
  assert.equal(forwarded.room, ROOM);
  const ok = await v.type("ack", (f) => f.id === "m-ok");
  assert.equal(ok.ok, true, "恢复后要回成功");
  v.send({ type: "abort", id: "a-ok", room: ROOM });
  await c.type("abort");
  assert.equal((await v.type("ack", (f) => f.id === "a-ok")).ok, true);
});

test("err.v4：本机回的失败没带码（旧扩展）填 internal、文案原样；带了码就透传，retryable 查码表", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  v.send({ type: "command", id: "q-old", room: ROOM, command: "get_state", args: {} });
  const f1 = await c.type("command", (f) => f.command === "get_state");
  c.send({ type: "command_result", room: ROOM, id: f1.id, ok: false, error: "未知命令：get_state" });
  const old = await v.type("ack", (f) => f.id === "q-old");
  assertCoded(old, "internal");
  assert.equal(old.error, "未知命令：get_state", "文案原样保留：前端还靠它认旧扩展");

  v.send({ type: "command", id: "q-busy", room: ROOM, command: "prompt", args: { message: "x" } });
  const f2 = await c.type("command", (f) => f.command === "prompt");
  c.send({ type: "command_result", room: ROOM, id: f2.id, ok: false, error: "正在回复", code: "busy" });
  assertCoded(await v.type("ack", (f) => f.id === "q-busy"), "busy");
});

test("local 通道：登记帧不合法回 bad_args，未知帧的文案保留帧名", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = client(relay.localPort);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4 });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: "../evil" } });
  assertCoded(await c.type("error", (f) => /房间 id/.test(f.message)), "bad_args");
  c.send({ type: "device_register", device: { id: "d1" } });
  assertCoded(await c.type("error", (f) => /不完整/.test(f.message)), "bad_args");
  c.send({ type: "room_label_v9", room: ROOM });
  const unknown = await c.type("error", (f) => f.code === "unknown_type");
  assertCoded(unknown, "unknown_type");
  assert.match(unknown.message, /room_label_v9/, "旧扩展靠文案里的帧名判断 relay 认不认某个帧，不能换成码表默认文案");
});

test("remote_message_failed：扩展没带码填 internal，带了就透传（顶层帧和事件两条路）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  const failed = (text) => v.type("room_event", (f) => f.event.type === "remote_message_failed" && f.event.text === text);
  c.send({ type: "remote_message_failed", room: ROOM, text: "a", error: "没送到" });
  assert.equal((await failed("a")).event.code, "internal");
  c.send({ type: "remote_message_failed", room: ROOM, text: "b", error: "会话已切换", code: "session_switched" });
  assert.equal((await failed("b")).event.code, "session_switched");
  c.send({ type: "event", room: ROOM, event: { type: "remote_message_failed", text: "c", error: "x" } });
  assert.equal((await failed("c")).event.code, "internal");
});

test("msg.cid：message 帧的 cid 只转给声明了 msg.cid 的扩展；cid 不合法回 bad_args", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());

  // 旧扩展（没声明能力）照常收消息，只是不带 cid
  const { c: old } = await local(relay);
  v.send({ type: "message", id: "m1", room: ROOM, text: "hi", cid: "c-1" });
  assert.equal((await v.type("ack", (f) => f.id === "m1")).ok, true);
  const plain = await old.type("message");
  assert.equal(plain.text, "hi");
  assert.equal("cid" in plain, false);
  old.close();

  const c = client(relay.localPort);
  t.after(() => c.close());
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps: ["msg.cid"] });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-a" } });
  await c.type("room_registered");
  v.send({ type: "message", id: "m2", room: ROOM, text: "hi", cid: "c-2" });
  assert.equal((await v.type("ack", (f) => f.id === "m2")).ok, true);
  assert.equal((await c.type("message")).cid, "c-2");

  v.send({ type: "message", id: "m3", room: ROOM, text: "hi", cid: "bad cid!" });
  assertCoded(await v.type("ack", (f) => f.id === "m3"), "bad_args");
  v.send({ type: "command", id: "p1", room: ROOM, command: "prompt", args: { message: "hi", cid: "x".repeat(PROTOCOL.limits.cidMax + 1) } });
  assertCoded(await v.type("ack", (f) => f.id === "p1"), "bad_args");
  v.send({ type: "command", id: "p2", room: ROOM, command: "steer", args: { message: "hi", cid: "c-3" } });
  const fwd = await c.type("command", (f) => f.command === "steer");
  assert.equal(fwd.args.cid, "c-3", "命令 args 原样转发");
  assert.equal(c.frames.filter((f) => f.type === "message").length, 1, "cid 不合法的消息不转发");
  assert.equal(c.frames.some((f) => f.type === "command" && f.command === "prompt"), false, "cid 不合法的命令不转发");
});

test("msg.cid：回显、送达、失败按 cid 对号；失败按 cid 摘回显，快照里的回显带 cid", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({ type: "event", room: ROOM, event: { type: "remote_message", text: "继续", at: 1, cid: "c-1" } });
  c.send({ type: "event", room: ROOM, event: { type: "remote_message", text: "继续", at: 2, cid: "c-2" } });
  c.send({ type: "event", room: ROOM, event: { type: "remote_message_delivered", cid: "c-2", at: 3 } });
  c.send({ type: "remote_message_failed", room: ROOM, text: "继续", error: "会话已切换", code: "session_switched", cid: "c-1" });
  c.send({ type: "event", room: ROOM, event: { type: "remote_message", text: "x", at: 4, cid: "not ok!" } });

  const echo = await v.type("room_event", (f) => f.event.type === "remote_message" && f.event.cid === "c-1");
  assert.ok(echo.seq, "回显进存储，带 seq");
  const delivered = await v.type("room_event", (f) => f.event.type === "remote_message_delivered");
  assert.equal(delivered.event.cid, "c-2");
  const failed = await v.type("room_event", (f) => f.event.type === "remote_message_failed");
  assert.equal(failed.event.cid, "c-1");
  assert.equal(failed.event.code, "session_switched");
  const bad = await v.type("room_event", (f) => f.event.type === "remote_message" && f.event.text === "x");
  assert.equal("cid" in bad.event, false, "不合法的 cid 当没带");

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  const snap = await late.type("snapshot");
  assert.deepEqual(
    snap.messages.filter((m) => m.remote).map((m) => [m.content[0].text, m.cid]),
    [["继续", "c-2"], ["x", undefined]],
    "失败的 c-1 摘掉了，同文本的 c-2 还在",
  );
});

test("GET /healthz：不要 token，只给计数和版本，不带房间名、路径、设备名", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  const win = client(relay.localPort);
  t.after(() => win.close());
  await win.opened;
  win.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await win.type("auth_result");
  win.send({ type: "device_register", device: { id: "dev-health", name: "秘密机器", platform: "macos", projects: ["/Users/secret"] } });
  await v.type("room_list", (f) => (f.devices || []).some((d) => d.id === "dev-health" && d.online));

  const res = await fetch(`http://127.0.0.1:${relay.viewerPort}/healthz`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["devices", "ok", "proto", "rooms", "uptimeSec", "version", "viewers"]);
  assert.equal(body.ok, true);
  assert.equal(body.proto, PROTOCOL.proto);
  assert.equal(body.version, require("../relay/server.js").RELAY_VERSION);
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof body.uptimeSec, "number");
  assert.deepEqual(body.rooms, { online: 1, total: 1 });
  assert.deepEqual(body.devices, { online: 1, total: 1 }, "未登记设备那一项不算");
  assert.equal(body.viewers, 1);
  const text = JSON.stringify(body);
  for (const secret of [ROOM, "/tmp", "dev-health", "秘密机器", "/Users/secret"]) assert.equal(text.includes(secret), false, secret);

  const head = await fetch(`http://127.0.0.1:${relay.viewerPort}/healthz`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("room_closed 收起待发队列和还在写的气泡；在线会话不收成已结束", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({ type: "state", room: ROOM, busy: true });
  await v.type("room_state", (f) => f.busy === true);
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "queue_update", steering: [{ text: "steer" }], followUp: [] },
  });
  const queued = await v.type("room_event", (f) => f.event.type === "queue_update");
  assert.equal(queued.event.steering.length, 1);
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "message_start", message: { role: "assistant", content: [], timestamp: 42 } },
  });
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "半截", contentIndex: 0 } },
  });
  await v.type("room_event", (f) => f.event.type === "message_start" && f.event.message.role === "assistant");
  await v.type("room_event", (f) => f.event.type === "message_update");
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: [{ id: "a1", seq: 1, name: "A", task: "t", status: "running" }] } });
  await v.type("room_event", (f) => f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 1);

  const { v: mid } = await viewer(relay);
  t.after(() => mid.close());
  mid.send({ type: "subscribe", room: ROOM });
  const live = await mid.type("snapshot");
  assert.equal(live.busy, true, "在线且还在写的快照仍报忙");
  const liveQueue = await mid.type("room_event", (f) => f.event.type === "queue_update");
  assert.deepEqual(liveQueue.event.steering, [{ text: "steer" }]);
  const liveStart = await mid.type("room_event", (f) => f.event.type === "message_start");
  assert.equal(liveStart.event.message.stopReason, "pending");
  assert.deepEqual(liveStart.event.message.content, [{ type: "text", text: "半截" }]);
  assert.equal(liveStart.seq, undefined);
  assert.equal(v.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_settled"), false);
  assert.equal(mid.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_settled"), false);

  const seqBefore = relay.store.info(ROOM).seq;
  c.send({ type: "room_closed", room: ROOM });
  const offline = await v.type("room_offline");
  const offAt = v.frames.indexOf(offline);
  const empty = v.frames.find((f, i) => i < offAt && f.type === "room_event" && f.event && f.event.type === "queue_update" && Array.isArray(f.event.steering) && f.event.steering.length === 0);
  const settled = v.frames.find((f, i) => i < offAt && f.type === "room_event" && f.event && f.event.type === "agent_settled");
  const emptyAgents = v.frames.find((f, i) => i < offAt && f.type === "room_event" && f.event && f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 0);
  assert.ok(empty, "room_offline 之前要有空 queue_update");
  assert.ok(settled, "room_offline 之前要有 agent_settled");
  assert.ok(emptyAgents, "room_offline 之前要有空 agent_state");
  assert.ok(v.frames.indexOf(empty) < v.frames.indexOf(settled));
  assert.deepEqual(empty.event, { type: "queue_update", steering: [], followUp: [] });
  assert.deepEqual(settled.event, { type: "agent_settled" });
  assert.equal(empty.seq, undefined);
  assert.equal(empty.rev, undefined);
  assert.equal(settled.seq, undefined);
  assert.equal(settled.rev, undefined);
  assert.equal(relay.store.info(ROOM).seq, seqBefore);
  assert.equal(fs.existsSync(path.join(relay.cfg.dataDir, `${ROOM}.jsonl`)), false, "收起的两帧不落 store");

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  const snap = await late.type("snapshot");
  assert.equal(snap.busy, false);
  await late.type("room_list");
  assert.equal(late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "queue_update"), false);
  assert.equal(late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "message_start"), false);
});

test("只断开 local、不发 room_closed：收起队列/清单但保留助手草稿，重连后不补旧队列", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "queue_update", steering: [{ text: "steer" }], followUp: [] },
  });
  await v.type("room_event", (f) => f.event.type === "queue_update");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "message_start", message: { role: "assistant", content: [], timestamp: 42 } },
  });
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "半截", contentIndex: 0 } },
  });
  await v.type("room_event", (f) => f.event.type === "message_start");
  await v.type("room_event", (f) => f.event.type === "message_update");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "agent_state", agents: [{ id: "a1", seq: 1, name: "Agent 1", task: "跑测试", status: "running" }], at: 7 },
  });
  await v.type("room_event", (f) => f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 1);

  const mark = v.frames.length;
  c.close();
  await v.type("room_offline");
  const after = v.frames.slice(mark);
  const emptyQueue = after.find((f) => f.type === "room_event" && f.event && f.event.type === "queue_update");
  assert.ok(emptyQueue, "异常断开也要收起旧队列");
  assert.deepEqual(emptyQueue.event, { type: "queue_update", steering: [], followUp: [] });
  assert.equal(emptyQueue.seq, undefined);
  assert.ok(
    after.some((f) => f.type === "room_event" && f.event && f.event.type === "task_list_state" && f.event.tasks.length === 0),
    "异常断开也要收起旧任务清单",
  );
  assert.ok(
    after.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 0),
    "异常断开也要收起旧子智能体状态",
  );
  assert.equal(after.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_settled"), false);

  const { c: again } = await local(relay);
  t.after(() => again.close());
  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  const replay = await late.type("room_event", (f) => f.event.type === "message_start");
  assert.equal(replay.seq, undefined);
  assert.equal(replay.rev, undefined);
  assert.equal(replay.event.message.role, "assistant");
  assert.equal(replay.event.message.stopReason, "pending");
  assert.equal(replay.event.message.timestamp, 42);
  assert.deepEqual(replay.event.message.content, [{ type: "text", text: "半截" }]);
  assert.equal(late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "queue_update"), false, "断线已清缓存，新的订阅者不补旧队列");
  assert.equal(late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_state"), false, "断线已清缓存，新的订阅者不补旧子智能体状态");
  assert.equal(late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_settled"), false);
});

function toolEvents(frames) {
  return frames.filter((f) => f.type === "room_event" && f.event && typeof f.event.type === "string" && f.event.type.startsWith("tool_execution_"));
}

test("快照里已有结果的工具不再补成还在跑", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  });
  await v.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_update", toolCallId: "call_1", toolName: "bash", partialResult: "part-1" },
  });
  await v.type("room_event", (f) => f.event.type === "tool_execution_update" && f.event.toolCallId === "call_1");
  c.send({
    type: "snapshot",
    room: ROOM,
    messages: [{ role: "toolResult", toolCallId: "call_1" }],
  });
  await v.type("snapshot", (f) => Array.isArray(f.messages) && f.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_1"));
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_start", toolCallId: "call_2", toolName: "read", args: { path: "a" } },
  });
  await v.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_2");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_update", toolCallId: "call_2", toolName: "read", partialResult: "part-2" },
  });
  await v.type("room_event", (f) => f.event.type === "tool_execution_update" && f.event.toolCallId === "call_2");

  const running = relay.rooms.peek(ROOM).runningTools;
  assert.deepEqual(running.map((e) => e.toolCallId), ["call_1", "call_2"]);

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  const snap = await late.type("snapshot");
  assert.equal(snap.delta, undefined);
  assert.ok(snap.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_1"));
  const start2 = await late.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_2");
  assert.equal(start2.event.toolName, "read");
  assert.deepEqual(start2.event.args, { path: "a" });
  assert.equal(start2.seq, undefined);
  const update2 = await late.type("room_event", (f) => f.event.type === "tool_execution_update" && f.event.toolCallId === "call_2");
  assert.equal(update2.event.partialResult, "part-2");
  assert.equal(toolEvents(late.frames).some((f) => f.event.toolCallId === "call_1"), false);
  assert.equal(toolEvents(late.frames).some((f) => f.event.type === "tool_execution_end"), false);

  const snapAt = v.frames.findIndex((f) => f.type === "snapshot" && Array.isArray(f.messages) && f.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_1"));
  assert.ok(snapAt >= 0);
  assert.equal(toolEvents(v.frames.slice(snapAt + 1)).some((f) => f.event.toolCallId === "call_1"), false);
  assert.equal(relay.rooms.peek(ROOM).runningTools, running);
  assert.deepEqual(running.map((e) => e.toolCallId), ["call_1", "call_2"]);
});

test("在线且工具还没出结果时补发不变成恒空", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  });
  await v.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  c.send({ type: "snapshot", room: ROOM, messages: [user("u1", 1)] });
  await v.type("snapshot", (f) => Array.isArray(f.messages) && f.messages.some((m) => m.role === "user"));

  const running = relay.rooms.peek(ROOM).runningTools;
  for (const name of ["late", "later"]) {
    const opened = await viewer(relay);
    t.after(() => opened.v.close());
    opened.v.send({ type: "subscribe", room: ROOM });
    const snap = await opened.v.type("snapshot");
    assert.equal(snap.messages.some((m) => m.role === "toolResult"), false, name);
    const start = await opened.v.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
    assert.equal(start.event.toolName, "bash");
    assert.deepEqual(start.event.args, { command: "ls" });
    assert.equal(toolEvents(opened.v.frames).some((f) => f.event.type === "tool_execution_end"), false, name);
  }
  assert.equal(relay.rooms.peek(ROOM).runningTools, running);
  assert.deepEqual(running.map((e) => e.toolCallId), ["call_1"]);
});

test("快照读取失败或房间上还没有存储时仍补 call_1", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } },
  });
  await v.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  c.send({ type: "snapshot", room: ROOM, messages: [{ role: "toolResult", toolCallId: "call_1" }] });
  await v.type("snapshot", (f) => Array.isArray(f.messages) && f.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_1"));

  const room = relay.rooms.get(ROOM);
  const running = room.runningTools;
  room.store = { snapshot() { throw new Error("read failed"); } };
  const { v: thrown } = await viewer(relay);
  t.after(() => thrown.close());
  thrown.send({ type: "subscribe", room: ROOM });
  const thrownSnap = await thrown.type("snapshot");
  assert.ok(thrownSnap.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_1"));
  await thrown.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  assert.equal(toolEvents(thrown.frames).some((f) => f.event.type === "tool_execution_end"), false);

  room.store = { snapshot() { return null; } };
  const { v: empty } = await viewer(relay);
  t.after(() => empty.close());
  empty.send({ type: "subscribe", room: ROOM });
  await empty.type("snapshot");
  await empty.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  assert.equal(toolEvents(empty.frames).some((f) => f.event.type === "tool_execution_end"), false);
  assert.equal(room.runningTools, running);
});

test("sendCachedTools 只按快照里的 toolResult 跳过，参数仍是 (ws, room, cfg)", () => {
  assert.equal(sendCachedTools.length, 3);
  const cfg = { maxSnapshotRecords: 20, maxPayloadBytes: 256 * 1024 };
  const tools = [
    { toolCallId: "call_1", fromStart: true, toolName: "bash", args: { command: "ls" }, partialResult: "part-1" },
    { toolCallId: "call_2", fromStart: true, toolName: "read", args: { path: "a" }, partialResult: "part-2" },
  ];
  const capture = () => {
    const frames = [];
    return {
      readyState: 1,
      bufferedAmount: 0,
      frames,
      send(data) { frames.push(JSON.parse(data)); },
    };
  };
  const room = { id: ROOM, online: true, runningTools: tools };
  const bare = capture();
  sendCachedTools(bare, room, cfg);
  assert.deepEqual(toolEvents(bare.frames).map((f) => [f.event.type, f.event.toolCallId]), [
    ["tool_execution_start", "call_1"],
    ["tool_execution_update", "call_1"],
    ["tool_execution_start", "call_2"],
    ["tool_execution_update", "call_2"],
  ]);

  room.store = { snapshot() { throw new Error("read failed"); } };
  const failed = capture();
  sendCachedTools(failed, room, cfg);
  assert.equal(toolEvents(failed.frames).some((f) => f.event.toolCallId === "call_1" && f.event.type === "tool_execution_start"), true);
  assert.equal(toolEvents(failed.frames).some((f) => f.event.type === "tool_execution_end"), false);

  room.store = { snapshot() { return null; } };
  const missing = capture();
  sendCachedTools(missing, room, cfg);
  assert.equal(toolEvents(missing.frames).filter((f) => f.event.toolCallId === "call_1").length, 2);

  room.store = { snapshot() { return { items: [] }; } };
  const none = capture();
  sendCachedTools(none, room, cfg);
  assert.equal(toolEvents(none.frames).some((f) => f.event.toolCallId === "call_1"), true);
  assert.equal(toolEvents(none.frames).some((f) => f.event.toolCallId === "call_2"), true);

  room.store = {
    snapshot() {
      return { items: [JSON.stringify({ role: "toolResult", toolCallId: "call_1" }), JSON.stringify({ role: "user" })] };
    },
  };
  const settled = capture();
  sendCachedTools(settled, room, cfg);
  assert.deepEqual(toolEvents(settled.frames).map((f) => [f.event.type, f.event.toolCallId]), [
    ["tool_execution_start", "call_2"],
    ["tool_execution_update", "call_2"],
  ]);
  assert.equal(room.runningTools, tools);
  assert.deepEqual(tools.map((e) => e.toolCallId), ["call_1", "call_2"]);
});

test("进行中工具 startedAt：relay 收 start 打戳，新观众补发拿到同一锚点", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  const before = Date.now();
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "sleep 30" } },
  });
  await v.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  const after = Date.now();

  const room = relay.rooms.peek(ROOM);
  assert.equal(room.runningTools.length, 1);
  const startedAt = room.runningTools[0].startedAt;
  assert.equal(typeof startedAt, "number");
  assert.ok(startedAt >= before && startedAt <= after, `startedAt=${startedAt} 应在 relay 收 start 的时刻`);

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  const replay = await late.type("room_event", (f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  assert.equal(replay.event.startedAt, startedAt, "晚到者从同一锚点续算，不从 0 重计");
  assert.deepEqual(replay.event.args, { command: "sleep 30" });
  assert.equal(replay.seq, undefined);
  assert.equal(replay.rev, undefined);
});

test("sendCachedTools：缓存条目有 startedAt 才补，没记过不乱编", () => {
  const cfg = { maxSnapshotRecords: 20, maxPayloadBytes: 256 * 1024 };
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(data) { frames.push(JSON.parse(data)); } };
  const room = {
    id: ROOM,
    online: true,
    runningTools: [
      { toolCallId: "call_1", fromStart: true, toolName: "bash", args: { command: "sleep 30" }, startedAt: 1700000000000 },
      { toolCallId: "call_2", fromStart: true, toolName: "read", args: { path: "a" } },
    ],
    store: { snapshot() { return { items: [] }; } },
  };
  sendCachedTools(ws, room, cfg);
  const start1 = frames.find((f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_1");
  const start2 = frames.find((f) => f.event.type === "tool_execution_start" && f.event.toolCallId === "call_2");
  assert.equal(start1.event.startedAt, 1700000000000);
  assert.equal("startedAt" in start2.event, false, "没有 start 时刻就不补造锚点");
});

test("sendCachedToolEnds：一帧全量 entries、camelCase、不带 seq/rev/完整输出", () => {
  const cfg = { maxSnapshotRecords: 20, maxPayloadBytes: 256 * 1024 };
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(data) { frames.push(JSON.parse(data)); } };
  const room = {
    id: ROOM,
    online: false, // 离线房间仍可回看历史
    store: {
      toolEnds() {
        return [
          { toolCallId: "call_1", isError: true, exit_code: 124, wall_time_seconds: 30, termStatus: "timeout", endedAt: 1700000000000 },
          { toolCallId: "call_2", isError: false, exit_code: 0 },
        ];
      },
    },
  };
  sendCachedToolEnds(ws, room, cfg);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, "room_event");
  assert.equal(frames[0].room, ROOM);
  assert.equal(frames[0].seq, undefined);
  assert.equal(frames[0].rev, undefined);
  assert.deepEqual(frames[0].event, {
    type: "tool_end_meta",
    entries: [
      { toolCallId: "call_1", exitCode: 124, wallTimeSeconds: 30, termStatus: "timeout", endedAt: 1700000000000, isError: true },
      { toolCallId: "call_2", exitCode: 0, isError: false },
    ],
    at: frames[0].event.at,
  });
  assert.equal(typeof frames[0].event.at, "number", "帧级 at 供 UI 校正 relay 时钟");
  assert.equal(JSON.stringify(frames[0]).includes("result"), false);
  assert.equal(JSON.stringify(frames[0]).includes("secret-output"), false);

  const empty = [];
  sendCachedToolEnds({ readyState: 1, bufferedAmount: 0, send(data) { empty.push(JSON.parse(data)); } }, { id: ROOM, store: { toolEnds() { return []; } } }, cfg);
  assert.deepEqual(empty, [], "没有元数据不发空帧");
});

test("sendCachedToolEnds：超过单帧上限时按 maxPayloadBytes 分批，不整批跳过（2000 条不再丢历史）", () => {
  const cfg = { maxPayloadBytes: 32 * 1024 };
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(data) { frames.push(JSON.parse(data)); } };
  const metas = Array.from({ length: 1200 }, (_, i) => ({
    toolCallId: `call_${i}`,
    isError: i % 2 === 0,
    exit_code: i % 256,
    wall_time_seconds: i % 10,
    termStatus: i % 3 === 0 ? "timeout" : undefined,
    endedAt: 1700000000000 + i,
  }));
  const room = { id: ROOM, online: false, store: { toolEnds() { return metas; } } };
  sendCachedToolEnds(ws, room, cfg);
  assert.ok(frames.length > 1, "必须分成多帧，而不是整包超过上限后一帧都不发");
  for (const frame of frames) {
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= cfg.maxPayloadBytes, "每帧都不超过 maxPayloadBytes");
    assert.equal(frame.event.type, "tool_end_meta");
  }
  const ids = frames.flatMap((frame) => frame.event.entries.map((entry) => entry.toolCallId));
  assert.equal(ids.length, metas.length, "所有条目都发出去");
  assert.equal(new Set(ids).size, metas.length);
  assert.equal(ids[0], "call_0");
  assert.equal(ids.at(-1), "call_1199");
  assert.equal(frames.every((frame) => frame.seq === undefined && frame.rev === undefined), true, "仍不带 seq/rev");
});

test("tool_end_meta：live end 后单条；晚到 viewer 订阅后全量补发，重复 end 不重复补", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({
    type: "event",
    room: ROOM,
    event: { type: "message_end", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", isError: true, content: [{ type: "text", text: "secret-output" }], timestamp: 1 } },
  });
  await v.type("room_event", (f) => f.event.type === "message_end");
  const endEvent = {
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    isError: true,
    result: { content: [{ type: "text", text: "secret-output" }] },
    exit_code: 124,
    wall_time_seconds: 30,
    termStatus: "timeout",
  };
  c.send({ type: "event", room: ROOM, event: endEvent });
  const liveEnd = await v.type("room_event", (f) => f.event.type === "tool_execution_end");
  assert.equal(liveEnd.seq, undefined);
  assert.equal(liveEnd.event.result.content[0].text, "secret-output", "原始 end 帧保持完整（不改 live 语义）");
  const liveMeta = await v.type("room_event", (f) => f.event.type === "tool_end_meta");
  assert.equal(liveMeta.seq, undefined);
  assert.equal(liveMeta.rev, undefined);
  assert.equal(liveMeta.event.entries.length, 1);
  const liveEntry = liveMeta.event.entries[0];
  assert.equal(liveEntry.toolCallId, "call_1");
  assert.equal(liveEntry.exitCode, 124);
  assert.equal(liveEntry.wallTimeSeconds, 30);
  assert.equal(liveEntry.termStatus, "timeout");
  assert.equal(liveEntry.isError, true);
  assert.equal(typeof liveEntry.endedAt, "number");
  assert.equal(typeof liveMeta.event.at, "number", "live 帧也带 relay 时刻供 UI 校时");

  // 重复 end：原事件照常广播，但元数据已存在，不再补第二条
  const metaCount = () => v.frames.filter((f) => f.type === "room_event" && f.event && f.event.type === "tool_end_meta").length;
  const before = metaCount();
  c.send({ type: "event", room: ROOM, event: endEvent });
  c.send({ type: "state", room: ROOM, busy: false });
  await v.type("room_state");
  assert.equal(metaCount(), before, "重复 end 不重复写/补");

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  const snap = await late.type("snapshot");
  assert.ok(snap.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_1"), "消息历史仍按 transcript 语义");
  assert.equal(snap.messages.some((m) => m.type === "tool_end_meta"), false);
  const replay = await late.type("room_event", (f) => f.event.type === "tool_end_meta");
  assert.equal(replay.seq, undefined);
  assert.equal(replay.rev, undefined);
  assert.equal(replay.event.entries.length, 1);
  assert.equal(replay.event.entries[0].toolCallId, "call_1");
  assert.equal(replay.event.entries[0].exitCode, 124);
  assert.equal(replay.event.entries[0].wallTimeSeconds, 30);
  assert.equal(replay.event.entries[0].termStatus, "timeout");
  assert.equal(replay.event.entries[0].isError, true);
  assert.equal("result" in replay.event.entries[0], false, "补发不重复完整输出");
  assert.equal(JSON.stringify(replay).includes("secret-output"), false);

  // 断线重连走 since 增量：快照是 delta，元数据也必须补（否则旧工具卡仍丢退出码）
  const { v: reconnect } = await viewer(relay);
  t.after(() => reconnect.close());
  reconnect.send({ type: "subscribe", room: ROOM, since: { rev: snap.rev, seq: snap.seq } });
  const delta = await reconnect.type("snapshot");
  assert.equal(delta.delta, true, "应当走增量快照");
  const deltaMeta = await reconnect.type("room_event", (f) => f.event.type === "tool_end_meta");
  assert.equal(deltaMeta.event.entries[0].toolCallId, "call_1");
  assert.equal(deltaMeta.event.entries[0].exitCode, 124);
  assert.equal(deltaMeta.seq, undefined);
});

test("tool_end_meta：relay 重启后仍能按 toolCallId 从历史补退出码/超时", async (t) => {
  const dir = tmpDir();
  const r1 = await boot(dir);
  const { c } = await local(r1);
  const { v } = await viewer(r1);
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "message_end", message: { role: "toolResult", toolCallId: "call_9", toolName: "bash", isError: true, content: [{ type: "text", text: "full-output" }], timestamp: 2 } },
  });
  c.send({
    type: "event",
    room: ROOM,
    event: { type: "tool_execution_end", toolCallId: "call_9", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "full-output" }] }, exit_code: 143, wall_time_seconds: 61.5, termStatus: "aborted" },
  });
  await v.type("room_event", (f) => f.event.type === "tool_end_meta");
  c.close();
  v.close();
  await r1.close();

  const r2 = await boot(dir);
  t.after(() => r2.close());
  const { c: c2 } = await local(r2);
  t.after(() => c2.close());
  const { v: v2 } = await viewer(r2);
  t.after(() => v2.close());
  v2.send({ type: "subscribe", room: ROOM });
  const snap = await v2.type("snapshot");
  assert.ok(snap.messages.some((m) => m.role === "toolResult" && m.toolCallId === "call_9"));
  const replay = await v2.type("room_event", (f) => f.event.type === "tool_end_meta");
  assert.deepEqual(replay.event.entries.map((e) => [e.toolCallId, e.exitCode, e.wallTimeSeconds, e.termStatus, e.isError]), [
    ["call_9", 143, 61.5, "aborted", true],
  ]);
  assert.equal(replay.seq, undefined, "补发帧不占 seq");
  assert.equal(JSON.stringify(replay).includes("full-output"), false);
});

const agentSnapshot = () => ({
  type: "agent_state",
  agents: [
    {
      id: "tc1:0",
      seq: 1,
      name: "Explore",
      description: "查代码",
      task: "找出终端胶囊的数据入口",
      status: "running",
      startedAt: 1700000000000,
      currentActivity: "$ rg terminal",
      recentItems: ["$ rg terminal", "read src/relay/useRelay.ts"],
      usage: { input: 10, output: 2 },
      model: "deepseek-chat",
      mode: "parallel",
      step: 1,
      depth: 1,
      parentAgentId: null,
    },
    { id: "tc1:1", seq: 2, name: "Reviewer", task: "复核接口", status: "succeeded", startedAt: 1700000000100, endedAt: 1700000000900, finalOutput: "ok" },
  ],
  at: 123,
});

test("agent_state：按房间缓存最后快照，新观众/增量重连补发；空数组清空且不落 store", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  // 先落一条消息，才有 rev/seq 可做增量重连
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("hi", 1) } });
  const stored = await v.type("room_event", (f) => f.event.type === "message_end");
  assert.ok(stored.seq > 0);

  const state = agentSnapshot();
  c.send({ type: "event", room: ROOM, event: state });
  const live = await v.type("room_event", (f) => f.event.type === "agent_state");
  assert.deepEqual(live.event, state);
  assert.equal(live.seq, undefined);
  assert.equal(live.rev, undefined);
  assert.equal(relay.store.info(ROOM).seq, stored.seq, "子智能体快照不落 store、不占 seq");

  // 新观众全量订阅：快照之后补最后一份快照
  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  const snap = await late.type("snapshot");
  const replay = await late.type("room_event", (f) => f.event.type === "agent_state");
  assert.deepEqual(replay.event, state);
  assert.equal(replay.seq, undefined);
  assert.equal(replay.rev, undefined);

  // 断线重连走 since 增量：快照是 delta，也要补快照
  const { v: reconnect } = await viewer(relay);
  t.after(() => reconnect.close());
  reconnect.send({ type: "subscribe", room: ROOM, since: { rev: snap.rev, seq: snap.seq } });
  const delta = await reconnect.type("snapshot");
  assert.equal(delta.delta, true, "应当走增量快照");
  const replayed = await reconnect.type("room_event", (f) => f.event.type === "agent_state");
  assert.deepEqual(replayed.event, state);

  // 空数组 = 清空；后来的观众看到空快照
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: [], at: 124 } });
  const cleared = await v.type("room_event", (f) => f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 0);
  assert.deepEqual(cleared.event, { type: "agent_state", agents: [], at: 124 });
  const { v: afterClear } = await viewer(relay);
  t.after(() => afterClear.close());
  afterClear.send({ type: "subscribe", room: ROOM });
  await afterClear.type("snapshot");
  const clearReplay = await afterClear.type("room_event", (f) => f.event.type === "agent_state");
  assert.deepEqual(clearReplay.event, { type: "agent_state", agents: [], at: 124 });

  const file = path.join(relay.cfg.dataDir, `${ROOM}.jsonl`);
  assert.equal(fs.readFileSync(file, "utf8").includes("agent_state"), false, "子智能体快照不落盘");
});

test("agent_state：坏帧不清空上一份快照，空数组才清空", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  const state = agentSnapshot();
  c.send({ type: "event", room: ROOM, event: state });
  await v.type("room_event", (f) => f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 2);

  // 认不出的条目逐条跳过；只剩认得出的那条
  const partial = [
    { id: "a3", seq: 3, name: "C", task: "半帧", status: "running" },
    { name: "缺 id" },
    { id: "bad2", status: "doing" },
  ];
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: partial } });

  // 坏帧：缺 agents / agents 不是数组 / 非空但一条都认不出。用一条 message_end 当顺序标记，确保服务器已处理完
  c.send({ type: "event", room: ROOM, event: { type: "agent_state" } });
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: "bad" } });
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: [{ name: "缺 id" }, { id: "x", status: "doing" }] } });
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("mark", 2) } });
  await v.type("room_event", (f) => f.event.type === "message_end");

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  const replay = await late.type("room_event", (f) => f.event.type === "agent_state");
  assert.deepEqual(replay.event, { type: "agent_state", agents: [partial[0]] }, "坏帧保留上一帧，坏条目跳过");

  // 先显式清空，再发坏帧：仍应保持空，而不是把旧快照捡回来
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: [] } });
  await v.type("room_event", (f) => f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 0);
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: {} } });
  c.send({ type: "event", room: ROOM, event: { type: "agent_state", agents: [{ id: "x", status: "doing" }] } });
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("mark2", 3) } });
  await v.type("room_event", (f) => f.event.type === "message_end");
  const { v: afterBad } = await viewer(relay);
  t.after(() => afterBad.close());
  afterBad.send({ type: "subscribe", room: ROOM });
  await afterBad.type("snapshot");
  const badReplay = await afterBad.type("room_event", (f) => f.event.type === "agent_state");
  assert.deepEqual(badReplay.event, { type: "agent_state", agents: [] });
});

test("agent_state：room_closed 与扩展实例更替清缓存，晚到观众不再补发", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  const state = agentSnapshot();
  c.send({ type: "event", room: ROOM, event: state });
  await v.type("room_event", (f) => f.event.type === "agent_state" && Array.isArray(f.event.agents) && f.event.agents.length === 2);

  c.send({ type: "room_closed", room: ROOM });
  await v.type("room_offline");
  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  await late.type("room_list");
  assert.equal(late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_state"), false);

  // 重新注册（实例更替）后再发一份，确认能补发；再换实例应当清掉
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-b" } });
  await c.type("room_registered");
  c.send({ type: "event", room: ROOM, event: state });
  const { v: mid } = await viewer(relay);
  t.after(() => mid.close());
  mid.send({ type: "subscribe", room: ROOM });
  await mid.type("snapshot");
  const replay = await mid.type("room_event", (f) => f.event.type === "agent_state");
  assert.deepEqual(replay.event, state);

  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-c" } });
  await c.type("room_registered");
  const { v: after } = await viewer(relay);
  t.after(() => after.close());
  after.send({ type: "subscribe", room: ROOM });
  await after.type("snapshot");
  await after.type("room_list");
  assert.equal(after.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "agent_state"), false);
});

test("sendCachedAgentState：在线才补发，空快照照发，不带 seq/rev，超限跳过；事件不可丢", () => {
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(s) { frames.push(JSON.parse(s)); } };
  const cfg = { maxPayloadBytes: 256 * 1024 };
  const agents = [{ id: "a1", seq: 1, name: "A", task: "t", status: "running" }];
  sendCachedAgentState(ws, { id: "r", online: true, agentState: { agents, at: 7 } }, cfg);
  assert.deepEqual(frames, [
    { type: "room_event", room: "r", event: { type: "agent_state", agents, at: 7 } },
  ]);
  frames.length = 0;
  sendCachedAgentState(ws, { id: "r", online: false, agentState: { agents } }, cfg);
  assert.equal(frames.length, 0, "离线房间不补发旧快照");
  sendCachedAgentState(ws, { id: "r", online: true }, cfg);
  assert.equal(frames.length, 0, "没缓存不编造");
  sendCachedAgentState(ws, { id: "r", online: true, agentState: { agents: [] } }, cfg);
  assert.deepEqual(frames, [{ type: "room_event", room: "r", event: { type: "agent_state", agents: [] } }], "空快照也补发（清空）");
  frames.length = 0;
  sendCachedAgentState(ws, { id: "r", online: true, agentState: { agents } }, { maxPayloadBytes: 10 });
  assert.equal(frames.length, 0, "超限跳过，不编造也不断线");
  assert.equal(DROPPABLE_LOCAL_EVENTS.has("agent_state"), false, "子智能体快照是关键帧，不能按流式事件丢弃");
});

test("conn.js：内部异常只回稳定码与通用文案，堆栈细节只进日志", () => {
  const { attachCommon } = require("../relay/conn.js");
  const { setQuiet } = require("../relay/util.js");
  const handlers = {};
  const sent = [];
  const fake = {
    readyState: 1,
    bufferedAmount: 0,
    _state: null,
    on(ev, fn) { handlers[ev] = fn; },
    send(data) { sent.push(JSON.parse(data)); },
    close() {},
  };
  attachCommon(fake, { rateBurst: 100, ratePerSec: 100 }, {
    onMessage() {
      throw new Error("ECONNREFUSED /secret/internal/path");
    },
  });
  const logs = [];
  const realLog = console.log;
  setQuiet(false);
  console.log = (...a) => logs.push(a.join(" "));
  try {
    handlers.message(Buffer.from(JSON.stringify({ type: "probe", id: "c1" })), false);
  } finally {
    console.log = realLog;
    setQuiet(true);
  }
  const err = sent.find((f) => f.type === "error");
  assert.ok(err, "必须回错误帧");
  assert.equal(err.code, "server_error");
  assert.equal(err.id, "c1");
  assert.equal(err.message, "服务端处理消息时出错", "不能把内部异常原文回给客户端");
  assert.equal(JSON.stringify(err).includes("secret"), false);
  assert.equal(JSON.stringify(err).includes("ECONNREFUSED"), false);
  assert.match(logs.join("\n"), /ECONNREFUSED \/secret\/internal\/path/, "详细异常仍要进日志");
});

test("保留期清理删内存房间前先清 resend 定时器（与 close 路径一致）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "relay", "server.js"), "utf8");
  const start = src.indexOf("const sweep = () =>");
  const end = src.indexOf("setInterval(sweep", start);
  assert.ok(start > 0 && end > start, "找不到保留期清理 sweep");
  const body = src.slice(start, end);
  const cancel = body.indexOf("cancelResend(r)");
  const del = body.indexOf("rooms.map.delete(id)");
  assert.ok(cancel > 0, "sweep 删房间前要调用 cancelResend");
  assert.ok(del > cancel, "顺序要先清定时器再删房间");
});

test("relay 源码里写死的错误码都在码表里（新增码先加进 protocol/v4.json 再 sync）", () => {
  const dir = path.join(__dirname, "..", "relay");
  const src = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  const used = new Set([...src.matchAll(/(?:errorFrame\(\s*|[cC]ode: )"([a-z][a-z0-9_]*)"/g)].map((m) => m[1]));
  assert.ok(used.size >= 15, "扫描规则失效：只找到 " + [...used].join(","));
  for (const code of used) assert.ok(code in PROTOCOL.errors, "码表里没有 " + code);
});

test("task_list_state：按房间缓存最后状态，新观众/增量重连补发；空清单清空且不落 store", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  // 先落一条消息，才有 rev/seq 可做增量重连
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: user("hi", 1) } });
  const stored = await v.type("room_event", (f) => f.event.type === "message_end");
  assert.ok(stored.seq > 0);

  const tasks = [
    { id: "1", content: "改后端", status: "in_progress", activeForm: "改后端中" },
    { id: "2", content: "跑测试", status: "pending" },
  ];
  c.send({ type: "event", room: ROOM, event: { type: "task_list_state", tasks, source: "todo", at: 123 } });
  const live = await v.type("room_event", (f) => f.event.type === "task_list_state");
  assert.deepEqual(live.event, { type: "task_list_state", tasks, source: "todo", at: 123 });
  assert.equal(live.seq, undefined);
  assert.equal(live.rev, undefined);
  assert.equal(relay.store.info(ROOM).seq, stored.seq, "清单状态不落 store、不占 seq");

  // 新观众全量订阅：快照之后补最后一份清单
  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  const snap = await late.type("snapshot");
  const replay = await late.type("room_event", (f) => f.event.type === "task_list_state");
  assert.deepEqual(replay.event, { type: "task_list_state", tasks, source: "todo", at: 123 });
  assert.equal(replay.seq, undefined);
  assert.equal(replay.rev, undefined);

  // 断线重连走 since 增量：快照是 delta，也要补清单
  const { v: reconnect } = await viewer(relay);
  t.after(() => reconnect.close());
  reconnect.send({ type: "subscribe", room: ROOM, since: { rev: snap.rev, seq: snap.seq } });
  const delta = await reconnect.type("snapshot");
  assert.equal(delta.delta, true, "应当走增量快照");
  const replayed = await reconnect.type("room_event", (f) => f.event.type === "task_list_state");
  assert.deepEqual(replayed.event.tasks, tasks);

  // 空数组 = 清空；缓存也换成空，后来的观众看到清空
  c.send({ type: "event", room: ROOM, event: { type: "task_list_state", tasks: [] } });
  const cleared = await v.type("room_event", (f) => f.event.type === "task_list_state");
  assert.deepEqual(cleared.event, { type: "task_list_state", tasks: [] });
  const { v: afterClear } = await viewer(relay);
  t.after(() => afterClear.close());
  afterClear.send({ type: "subscribe", room: ROOM });
  await afterClear.type("snapshot");
  const clearReplay = await afterClear.type("room_event", (f) => f.event.type === "task_list_state");
  assert.deepEqual(clearReplay.event, { type: "task_list_state", tasks: [] });

  const file = path.join(relay.cfg.dataDir, `${ROOM}.jsonl`);
  assert.equal(fs.readFileSync(file, "utf8").includes("task_list_state"), false, "清单状态不落盘");
});

test("task_list_state：room_closed 与扩展实例更替清缓存，晚到观众不再补发", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  const tasks = [{ id: "1", content: "改后端", status: "pending" }];
  c.send({ type: "event", room: ROOM, event: { type: "task_list_state", tasks, source: "todo" } });
  await v.type("room_event", (f) => f.event.type === "task_list_state");

  c.send({ type: "room_closed", room: ROOM });
  await v.type("room_offline");
  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  await late.type("room_list");
  assert.equal(late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "task_list_state"), false);

  // 重新注册（实例更替）后再发一份，确认能补发；再换实例应当清掉
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-b" } });
  await c.type("room_registered");
  c.send({ type: "event", room: ROOM, event: { type: "task_list_state", tasks, source: "todo" } });
  const { v: mid } = await viewer(relay);
  t.after(() => mid.close());
  mid.send({ type: "subscribe", room: ROOM });
  await mid.type("snapshot");
  const replay = await mid.type("room_event", (f) => f.event.type === "task_list_state");
  assert.deepEqual(replay.event.tasks, tasks);

  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-c" } });
  await c.type("room_registered");
  const { v: after } = await viewer(relay);
  t.after(() => after.close());
  after.send({ type: "subscribe", room: ROOM });
  await after.type("snapshot");
  await after.type("room_list");
  assert.equal(after.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "task_list_state"), false);
});

test("sendCachedTaskList：只补在线房间的缓存，空清单照发，不带 seq/rev，超限跳过", () => {
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(s) { frames.push(JSON.parse(s)); } };
  const cfg = { maxPayloadBytes: 256 * 1024 };
  sendCachedTaskList(ws, { id: "r", online: true, taskList: { tasks: [], source: "plan", at: 7 } }, cfg);
  assert.deepEqual(frames, [
    { type: "room_event", room: "r", event: { type: "task_list_state", tasks: [], source: "plan", at: 7 } },
  ]);
  frames.length = 0;
  sendCachedTaskList(ws, { id: "r", online: false, taskList: { tasks: [{ id: "1", content: "x", status: "pending" }] } }, cfg);
  assert.equal(frames.length, 0, "离线房间不补发旧清单");
  sendCachedTaskList(ws, { id: "r", online: true }, cfg);
  assert.equal(frames.length, 0, "没缓存不编造");
  sendCachedTaskList(ws, { id: "r", online: true, taskList: { tasks: [{ id: "1", content: "x", status: "pending" }] } }, { maxPayloadBytes: 10 });
  assert.equal(frames.length, 0, "超限跳过，不编造也不断线");
});

test("sendCachedRemoteQueue：离线不补发，在线补发带缓存时间戳", () => {
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(s) { frames.push(JSON.parse(s)); } };
  const cfg = { maxPayloadBytes: 256 * 1024 };
  const cached = { rev: 2, items: [{ id: "rq_1", segment: "steer", source: "web", text: "x", images: [], status: "pending", at: 5 }], at: 99 };
  sendCachedRemoteQueue(ws, { id: "r", online: false, remoteQueue: cached }, cfg);
  assert.equal(frames.length, 0, "离线房间不补发旧待发队列");
  sendCachedRemoteQueue(ws, { id: "r", online: true, remoteQueue: cached }, cfg);
  assert.deepEqual(frames, [{
    type: "room_event",
    room: "r",
    event: { type: "remote_queue_state", rev: 2, items: cached.items, at: 99 },
  }]);
});


test("remote_queue_state：按房间缓存整份状态、新 viewer 补发、room_closed 清空且不落 store", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  const longText = "远".repeat(9000);
  c.send({
    type: "event",
    room: ROOM,
    event: {
      type: "remote_queue_state",
      rev: 3,
      items: [
        {
          id: "rq_111111111111",
          segment: "steer",
          source: "web",
          text: longText,
          images: [{ mimeType: "image/png", bytes: 2048 }],
          status: "pending",
          at: 100,
          cid: "cid-1",
          junk: "不能进缓存",
        },
        { id: "bad", segment: "wrong", status: "pending" },
        { id: "rq_222222222222", segment: "follow_up", source: "web", text: "第二条", images: [], status: "injected", at: 101, injectedAt: 102 },
      ],
    },
  });
  const live = await v.type("room_event", (f) => f.event.type === "remote_queue_state");
  assert.equal(live.seq, undefined, "状态帧不进 store");
  assert.equal(live.rev, undefined);
  assert.equal(live.event.rev, 3);
  assert.equal(live.event.items.length, 2, "非法条目被过滤");
  assert.equal(live.event.items[0].text.length, 8000, "正文按缓存上限截断");
  assert.equal("junk" in live.event.items[0], false);
  assert.deepEqual(live.event.items[0].images, [{ mimeType: "image/png", bytes: 2048 }]);

  const { v: mid } = await viewer(relay);
  t.after(() => mid.close());
  mid.send({ type: "subscribe", room: ROOM });
  await mid.type("snapshot");
  const replay = await mid.type("room_event", (f) => f.event.type === "remote_queue_state");
  assert.equal(replay.seq, undefined);
  assert.equal(replay.rev, undefined);
  assert.deepEqual(replay.event.items.map((item) => item.id), ["rq_111111111111", "rq_222222222222"]);
  assert.equal(replay.event.items[0].cid, "cid-1");

  const seqBefore = relay.store.info(ROOM).seq;
  c.send({ type: "room_closed", room: ROOM });
  const offline = await v.type("room_offline");
  const offAt = v.frames.indexOf(offline);
  const empty = v.frames.find(
    (f, i) => i < offAt && f.type === "room_event" && f.event && f.event.type === "remote_queue_state" && f.event.items.length === 0,
  );
  assert.ok(empty, "room_offline 之前要有空 remote_queue_state");
  assert.equal(empty.event.rev, 0);
  assert.equal(empty.seq, undefined);
  assert.equal(relay.store.info(ROOM).seq, seqBefore, "状态帧不写 store");

  const { v: late } = await viewer(relay);
  t.after(() => late.close());
  late.send({ type: "subscribe", room: ROOM });
  await late.type("snapshot");
  assert.equal(
    late.frames.some((f) => f.type === "room_event" && f.event && f.event.type === "remote_queue_state"),
    false,
    "房间关闭后缓存已清，不再补发旧状态",
  );
});

/* ---------------- O2 对话框应答（第 2 轮 R2-1） ---------------- */

test("O2 门控：订阅数 0↔>0 向桥推 dialog_gate；桥注册时补发当前值", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  // 注册即补发：此刻无 viewer → hasViewers:false
  const gate0 = await c.type("dialog_gate");
  assert.equal(gate0.hasViewers, false);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  const gate1 = await c.type("dialog_gate", (f) => f.hasViewers === true);
  assert.equal(gate1.room, ROOM);
  v.send({ type: "unsubscribe", room: ROOM });
  const gate2 = await c.type("dialog_gate", (f) => f.hasViewers === false);
  assert.equal(gate2.hasViewers, false, "最后一个 viewer 退订 → 门控关闭");
});

test("O2 应答全链：viewer 答案经 relay 转发桥、回执对号回 ack；denied 的 close 广播带 reason/note", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-a", kind: "confirm", title: "删库？", answerable: true, timeout: 120000, startedAt: 1000 } });
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-a");

  v.send({ type: "dialog_answer", id: "ans-q1", room: ROOM, dialogId: "dlg-a", action: "deny", note: "先备份再说" });
  const fwd = await c.type("dialog_answer");
  assert.equal(fwd.dialogId, "dlg-a");
  assert.equal(fwd.action, "deny");
  assert.equal(fwd.note, "先备份再说");
  assert.equal(typeof fwd.aid, "string");
  c.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-a", ok: true });
  const ack = await v.type("ack", (f) => f.id === "ans-q1");
  assert.equal(ack.ok, true);

  // 裁决后的关闭广播原样带 reason/note（UI 呈 denied 态靠它）
  c.send({ type: "event", room: ROOM, event: { type: "dialog_close", dialogId: "dlg-a", outcome: "resolved", reason: "denied", note: "先备份再说" } });
  const close = await v.type("room_event", (f) => f.event.type === "dialog_close" && f.event.dialogId === "dlg-a");
  assert.equal(close.event.reason, "denied");
  assert.equal(close.event.note, "先备份再说");
});

test("O2 应答校验：不存在/观察态 dialog 直接 dialog_gone 不转发；坏 action 回 bad_args；桥回 gone 透传", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  // 观察态 dialog（无 answerable）：不可答
  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-obs", kind: "confirm", title: "看", startedAt: 5 } });
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-obs");
  v.send({ type: "dialog_answer", id: "g1", room: ROOM, dialogId: "dlg-obs", action: "allow" });
  const e1 = await v.type("error", (f) => f.id === "g1");
  assert.equal(e1.code, "dialog_gone");

  // 根本不存在的 dialogId
  v.send({ type: "dialog_answer", id: "g2", room: ROOM, dialogId: "dlg-nope", action: "allow" });
  const e2 = await v.type("error", (f) => f.id === "g2");
  assert.equal(e2.code, "dialog_gone");

  // 可答 dialog + 坏 action → bad_args（不转发）
  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-b", kind: "confirm", title: "题", answerable: true, startedAt: 6 } });
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-b");
  v.send({ type: "dialog_answer", id: "g3", room: ROOM, dialogId: "dlg-b", action: "remember" });
  const e3 = await v.type("error", (f) => f.id === "g3");
  assert.equal(e3.code, "bad_args", "一期没有 Allow & remember");

  // 正常转发后桥回 gone（先答已被他端拿走）→ 答题端收到 dialog_gone
  v.send({ type: "dialog_answer", id: "g4", room: ROOM, dialogId: "dlg-b", action: "allow" });
  const fwd = await c.type("dialog_answer", (f) => f.dialogId === "dlg-b");
  c.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-b", ok: false, code: "dialog_gone" });
  const e4 = await v.type("error", (f) => f.id === "g4");
  assert.equal(e4.code, "dialog_gone");
});

test("O2 硬验收：未答 dialog 在 viewer 重连时补发，answerable 与 startedAt 原样保留、可接着答完", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-r", kind: "select", title: "选", options: ["甲", "乙"], answerable: true, timeout: 120000, startedAt: 4242 } });
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-r");
  v.close(); // 模拟刷新

  const { v: v2 } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  t.after(() => v2.close());
  v2.send({ type: "subscribe", room: ROOM });
  await v2.type("snapshot");
  const cached = await v2.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-r");
  assert.equal(cached.event.answerable, true, "补发保留 answerable（回来能接着答）");
  assert.equal(cached.event.startedAt, 4242, "startedAt 不重置——剩余时限按 startedAt+timeout 重算，不重新计时");
  assert.equal(cached.event.timeout, 120000);

  // 补发后接着答完：全链仍通
  v2.send({ type: "dialog_answer", id: "r1", room: ROOM, dialogId: "dlg-r", action: "submit", value: "乙" });
  const fwd = await c.type("dialog_answer", (f) => f.dialogId === "dlg-r");
  assert.equal(fwd.action, "submit");
  assert.equal(fwd.value, "乙");
  c.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-r", ok: true });
  const ack = await v2.type("ack", (f) => f.id === "r1");
  assert.equal(ack.ok, true);
});

test("O2 开关下达：relay 存当前值，桥重连时自动重下达（+ 门控当前值）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const first = await local(relay);
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");

  v.send({ type: "dialog_answer_switch", id: "sw1", room: ROOM, enabled: true });
  const ack = await v.type("ack", (f) => f.id === "sw1");
  assert.equal(ack.ok, true);
  const fwd = await first.c.type("dialog_answer_switch");
  assert.equal(fwd.enabled, true, "在线桥即时收到下达");

  // 桥断线重连：relay 按存值自动重下达 + 门控按当前订阅数补发（viewer 还在 → true）
  first.c.close();
  await v.type("room_offline");
  const second = await local(relay);
  t.after(() => second.c.close());
  const reGate = await second.c.type("dialog_gate");
  assert.equal(reGate.hasViewers, true);
  const reSwitch = await second.c.type("dialog_answer_switch");
  assert.equal(reSwitch.enabled, true, "桥重连自动重下达，不用等人再拨一次开关");
});

test("O2 回执兜底：桥在答案转发后断开 → 等回执的 viewer 立刻收到 dialog_gone", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  const { v } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-x", kind: "confirm", title: "题", answerable: true, startedAt: 7 } });
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-x");
  v.send({ type: "dialog_answer", id: "x1", room: ROOM, dialogId: "dlg-x", action: "allow" });
  await c.type("dialog_answer");
  c.close(); // 桥断开、永不回 result
  const err = await v.type("error", (f) => f.id === "x1");
  assert.equal(err.code, "dialog_gone");
});

test("sendCachedDialogs：按连接 cap 剥 answerable（A-6 单元），缓存槽本体不被改动", () => {
  const cfg = { maxPayloadBytes: 256 * 1024 };
  const room = { id: "r", online: true, dialogs: { d1: { type: "dialog_open", dialogId: "d1", kind: "confirm", title: "题", answerable: true, startedAt: 3 } } };
  const framesOld = [];
  const oldWs = { readyState: 1, bufferedAmount: 0, send(s) { framesOld.push(JSON.parse(s)); } };
  sendCachedDialogs(oldWs, room, cfg);
  assert.equal(framesOld.length, 1);
  assert.equal("answerable" in framesOld[0].event, false, "无 cap：补发剥 answerable");
  assert.equal(framesOld[0].event.title, "题", "观察卡本体照发");
  const framesCap = [];
  const capWs = { readyState: 1, bufferedAmount: 0, _state: { caps: new Set(["dialog.respond"]) }, send(s) { framesCap.push(JSON.parse(s)); } };
  sendCachedDialogs(capWs, room, cfg);
  assert.equal(framesCap[0].event.answerable, true, "有 cap：补发保留 answerable");
  assert.equal(room.dialogs.d1.answerable, true, "剥的是副本，缓存槽不被改动");
});

test("A-6 cap 门控：旧端直播/补发只收观察卡、应答直接 dialog_gone 且不转发桥", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v: vCap } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  t.after(() => vCap.close());
  const { v: vOld } = await viewer(relay);
  t.after(() => vOld.close());
  vCap.send({ type: "subscribe", room: ROOM });
  vOld.send({ type: "subscribe", room: ROOM });
  await vCap.type("snapshot");
  await vOld.type("snapshot");

  // 直播：同一条 dialog_open，有 cap 带 answerable、无 cap 剥掉但卡本体照到
  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-cap", kind: "confirm", title: "可答题", answerable: true, startedAt: 42 } });
  const liveCap = await vCap.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-cap");
  assert.equal(liveCap.event.answerable, true);
  const liveOld = await vOld.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-cap");
  assert.equal("answerable" in liveOld.event, false, "旧端直播帧不得带 answerable");
  assert.equal(liveOld.event.title, "可答题", "观察卡本体不剥");
  assert.equal(liveOld.event.kind, "confirm");

  // 旧端应答：直接 dialog_gone、不转发桥、不建 waiter
  vOld.send({ type: "dialog_answer", id: "cap1", room: ROOM, dialogId: "dlg-cap", action: "allow" });
  const e = await vOld.type("error", (f) => f.id === "cap1");
  assert.equal(e.code, "dialog_gone");
  assert.equal(c.frames.some((f) => f.type === "dialog_answer"), false, "无 cap 的答案不许转发给桥");

  // 补发：后订阅的旧端收到剥过的槽，后订阅的有 cap 端收到原样槽
  const { v: lateOld } = await viewer(relay);
  t.after(() => lateOld.close());
  lateOld.send({ type: "subscribe", room: ROOM });
  await lateOld.type("snapshot");
  const reOld = await lateOld.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-cap");
  assert.equal("answerable" in reOld.event, false, "补发同样剥 answerable");
  assert.equal(reOld.event.startedAt, 42);
  const { v: lateCap } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  t.after(() => lateCap.close());
  lateCap.send({ type: "subscribe", room: ROOM });
  await lateCap.type("snapshot");
  const reCap = await lateCap.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-cap");
  assert.equal(reCap.event.answerable, true, "有 cap 的补发保留 answerable");
});

test("A-3 纵深清洗：桥发来的 dialog_close note 在 relay 出口再切一刀并滤控制字符", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay);
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  const dirty = "拒".repeat(400) + String.fromCharCode(7) + "尾".repeat(150);
  c.send({ type: "event", room: ROOM, event: { type: "dialog_close", dialogId: "dlg-n", outcome: "resolved", reason: "denied", note: dirty } });
  const close = await v.type("room_event", (f) => f.event.type === "dialog_close" && f.event.dialogId === "dlg-n");
  assert.equal(typeof close.event.note, "string");
  assert.ok(close.event.note.length <= 500, "note 按 dialogNoteMax 在出口复核截断");
  const hasCtrl = [...close.event.note].some((ch) => { const cp = ch.codePointAt(0); return cp < 0x20 || cp === 0x7f; });
  assert.equal(hasCtrl, false, "控制字符被滤掉");
  assert.ok(close.event.note.startsWith("拒拒拒"), "正常文本保留");
  assert.ok(close.event.note.endsWith("尾"), "截断发生在清洗之后，尾部正常文本保留");
});

test("A-2 回执来源不符：结果不采信，但立刻以 dialog_gone 结案答题端（不等 15s 超时）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const { c } = await local(relay);
  t.after(() => c.close());
  const { v } = await viewer(relay, undefined, { caps: ["dialog.respond"] });
  t.after(() => v.close());
  v.send({ type: "subscribe", room: ROOM });
  await v.type("snapshot");
  c.send({ type: "event", room: ROOM, event: { type: "dialog_open", dialogId: "dlg-m", kind: "confirm", title: "题", answerable: true, startedAt: 9 } });
  await v.type("room_event", (f) => f.event.type === "dialog_open" && f.event.dialogId === "dlg-m");
  v.send({ type: "dialog_answer", id: "m1", room: ROOM, dialogId: "dlg-m", action: "allow" });
  const fwd = await c.type("dialog_answer", (f) => f.dialogId === "dlg-m");

  // 另一条桥连接（另一个房间的）拿着这个 aid 回 result：来源与 waiter 登记的桥不符
  const other = client(relay.localPort);
  t.after(() => other.close());
  await other.opened;
  other.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await other.type("auth_result");
  other.send({ type: "room_register", room: { id: "room-other", label: "o", cwd: "/tmp", epoch: 1, instance: "inst-b" } });
  await other.type("room_registered");
  other.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-m", ok: true });

  // 答题端立刻收到 dialog_gone 结案（旧行为是只丢弃、晾到 15s waiter 超时才回 timeout）
  const err = await v.type("error", (f) => f.id === "m1", 2500);
  assert.equal(err.code, "dialog_gone");

  // waiter 已删：真桥随后回的合法 result 不再产生 ack
  c.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-m", ok: true });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(v.frames.some((f) => f.type === "ack" && f.id === "m1"), false);
});

/* ======================================================================
 * P9 B：删除三端一致（relay 侧：routeDeleteSession / purgeSessions / session_removed）
 * P9 C：list_dirs 路由 / routeHarness 浏览根目录放行 / devices[] 新字段
 * ==================================================================== */

/** 带能力的设备窗口（attach）：caps 决定设备侧能力（session.files / fs.browse） */
async function attachWindow(relay, device, caps = []) {
  const w = client(relay.localPort);
  await w.opened;
  w.send({
    type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps,
    client: { kind: "attach", version: "4.0.0", platform: device.platform || "macos" },
  });
  await w.type("auth_result");
  w.send({ type: "device_register", device });
  // device_register 成功会触发一次 room_list（发给设备窗口连接），拿它当同步点
  await w.wait((f) => f.type === "room_list", 3000, "设备窗口的 room_list");
  return w;
}

/** 扩展侧：一条 socket 注册一个房间（可带 deviceId） */
async function extensionRoom(relay, roomId, { deviceId, cwd = "/tmp", label = roomId } = {}) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await c.type("auth_result");
  const room = { id: roomId, label, cwd, epoch: 1, instance: "inst-" + roomId };
  if (deviceId) room.deviceId = deviceId;
  c.send({ type: "room_register", room });
  const reg = await c.type("room_registered");
  return { c, reg };
}

/** 轮询等一个内存条件成立（B/C 用例里核对服务端状态用） */
async function until(fn, what, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("等待超时：" + what);
}

/** 用 attach 窗口的全量清单在索引里种一行会话（scope:"device" + root 走 P9 B 的新对账路径） */
async function seedIndexSession(win, deviceId, session, root = "/sessions") {
  win.send({
    type: "session_manifest",
    deviceId,
    full: true,
    scope: "device",
    root,
    updatedAt: Date.now(),
    sessions: [session],
  });
  await win.wait((f) => f.type === "room_list", 3000, "manifest 后的 room_list");
}

/** 给某个会话造齐服务器副本：离线房间 + 正文文件（+ 可选会话库正文）。返回文件路径。 */
async function seedCopies(relay, { sessionId, deviceId, messages = [user("hi", 1)] }) {
  const room = relay.rooms.get(sessionId); // 离线房间（名册里已有的样子）
  room.label = "S-" + sessionId;
  room.deviceId = deviceId || null;
  relay.store.seedOrMerge(sessionId, messages);
  relay.store.flushAll();
  const file = path.join(relay.cfg.dataDir, `${sessionId}.jsonl`);
  assert.equal(fs.existsSync(file), true, "正文文件已落盘");
  return file;
}

const sessionPathOf = (sessionId, dir = "--proj--") => `/sessions/${dir}/1700000000000_${sessionId}.jsonl`;

test("删除路由①attach：声明 session.files 时按 sessionId 交给 attach，成功清掉全部服务器副本并广播 session_removed", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-attach";
  const SID = "session-del-attach";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, ["session.files", "fs.browse"]);
  t.after(() => win.close());
  await seedIndexSession(win, DEV, {
    id: SID, path: sessionPathOf(SID), cwd: "/w/proj", name: "S1", firstMessage: "hi", messageCount: 3, updatedAt: Date.now(),
  });
  const roomFile = await seedCopies(relay, { sessionId: SID, deviceId: DEV });
  win.send({ type: "session_archive", deviceId: DEV, session: { id: SID, messages: [{ role: "user", text: "hi" }] } });
  await until(() => relay.devices.get(DEV).archives && relay.devices.get(DEV).archives.has(SID), "会话库正文");

  const { v: v1 } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  const { v: v2 } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => { v1.close(); v2.close(); });
  v1.send({ type: "command", id: "del-a1", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const fwd = await win.type("command", (f) => f.command === "delete_session");
  assert.deepEqual(fwd.args, { sessionId: SID, pathHint: sessionPathOf(SID) }, "attach 路由按 sessionId 发，索引路径作 pathHint（P1-3）");
  assert.equal(fwd.timeoutMs, 30000, "SESSION_OP_COMMANDS 走 30s 超时");
  win.send({ type: "command_result", id: fwd.id, ok: true, data: { status: "deleted", method: "trash" } });

  const ack = await v1.type("ack", (f) => f.id === "del-a1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, { status: "deleted", method: "trash" });

  // 清理核对：房间 / 正文内存与文件 / 会话库正文 / 索引墓碑
  assert.equal(relay.rooms.peek(SID), null, "名册里的离线房间被清掉");
  assert.equal(relay.store.exists(SID), false, "存储里没有这个会话");
  assert.equal(fs.existsSync(roomFile), false, "data/rooms 下的正文文件被删");
  assert.equal(relay.devices.get(DEV).archives.has(SID), false, "会话库正文被清");
  const row = relay.index.getSession("admin", DEV, SID);
  assert.ok(row, "索引里留下一条墓碑");
  assert.equal(row.deleted, true);
  assert.equal(row.name, undefined, "墓碑不留会话名");
  assert.equal(row.firstMessage, undefined);
  assert.equal(row.path, undefined, "墓碑不留路径");
  assert.equal(row.cwd, undefined);

  // 两个声明了 session.purge 的网页都收到广播；room_list 里已经看不到这个房间
  for (const v of [v1, v2]) {
    const removed = await v.type("session_removed", (f) => Array.isArray(f.ids) && f.ids.includes(SID));
    assert.equal(removed.deviceId, DEV);
  }
  const list = await v1.wait((f) => f.type === "room_list" && Array.isArray(f.rooms) && !f.rooms.some((r) => r.id === SID), 3000, "清掉后的 room_list");
  assert.ok(list);
});

test("删除路由②同目录房间：attach 没有 session.files 时，交给与目标同 cwd 的在线房间（老 R25 路径）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-room";
  const SID = "session-del-room";
  const RUN = "room-running-del";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, []);
  t.after(() => win.close());
  const { c: ext } = await extensionRoom(relay, RUN, { deviceId: DEV, cwd: "/w/proj" });
  t.after(() => ext.close());
  const pathOf = sessionPathOf(SID, "--w-proj--");
  await seedIndexSession(win, DEV, { id: SID, path: pathOf, cwd: "/w/proj", name: "S2", updatedAt: Date.now() });
  const roomFile = await seedCopies(relay, { sessionId: SID, deviceId: DEV });

  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());
  v.send({ type: "command", id: "del-b1", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const fwd = await ext.type("command", (f) => f.command === "delete_session");
  assert.equal(fwd.args.sessionPath, pathOf, "扩展路由按 sessionPath 发");
  assert.equal(fwd.room, RUN, "命令落到同目录的在线房间");
  ext.send({ type: "command_result", id: fwd.id, ok: true, data: { status: "deleted", method: "unlink" } });
  const ack = await v.type("ack", (f) => f.id === "del-b1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, { status: "deleted", method: "unlink" });
  assert.equal(relay.store.exists(SID), false);
  assert.equal(fs.existsSync(roomFile), false);
  assert.equal(relay.index.getSession("admin", DEV, SID).deleted, true);
  await v.type("session_removed", (f) => f.ids.includes(SID));
});

test("删除路由③设备离线：回 device_offline；④设备在线但 attach 太旧：回 device_update_required", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-offline";
  const SID = "session-del-offline";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, []);
  await seedIndexSession(win, DEV, { id: SID, path: sessionPathOf(SID), cwd: "/w/proj", updatedAt: Date.now() });
  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());

  // ④ 设备在线（窗口还在）、没有 session.files、又没有同目录在线房间
  v.send({ type: "command", id: "del-c1", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const needUpdate = await v.type("ack", (f) => f.id === "del-c1");
  assert.equal(needUpdate.ok, false);
  assertCoded(needUpdate, "device_update_required");

  // ③ 设备离线
  win.close();
  await until(() => !relay.devices.get(DEV).online, "窗口离线");
  v.send({ type: "command", id: "del-c2", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const offline = await v.type("ack", (f) => f.id === "del-c2");
  assert.equal(offline.ok, false);
  assertCoded(offline, "device_offline");
  assert.equal(relay.store.exists(SID), false, "被拒的删除没有产生副作用");
  assert.equal(relay.index.getSession("admin", DEV, SID).deleted, false, "索引行原样（没打墓碑）");
});

test("删除：目标正在运行（在线房间 id 相同）时回 session_running，不产生任何清理", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-running";
  const SID = "session-running";
  const { c: ext } = await extensionRoom(relay, SID, { deviceId: DEV, cwd: "/w/proj" });
  t.after(() => ext.close());
  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());

  v.send({ type: "command", id: "del-run", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const ack = await v.type("ack", (f) => f.id === "del-run");
  assert.equal(ack.ok, false);
  assertCoded(ack, "session_running");
  assert.deepEqual(ack.error, PROTOCOL.errors.session_running.message);
  assert.ok(relay.rooms.peek(SID) && relay.rooms.peek(SID).online, "在线房间纹丝不动");
});

test("删除（P1-2）：索引里查不到（!row）先交给 attach 按 id 找，不先清副本；attach 回 already_deleted 才清理", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-gone";
  const SID = "session-gone";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, ["session.files"]);
  t.after(() => win.close());
  // 只有副本、没有索引行（清单还没收到 / 账号不同）：不能据此认定设备上删了
  const roomFile = await seedCopies(relay, { sessionId: SID, deviceId: DEV });
  win.send({ type: "session_archive", deviceId: DEV, session: { id: SID, messages: [{ role: "user", text: "hi" }] } });
  await until(() => { const a = relay.devices.get(DEV).archives; return !!(a && a.has(SID)); }, "会话库正文");
  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());

  v.send({ type: "command", id: "del-g1", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const fwd = await win.type("command", (f) => f.command === "delete_session");
  assert.deepEqual(fwd.args, { sessionId: SID }, "查不到行就没有 pathHint，但照常交给 attach 按 id 找");
  // 设备回执之前，服务器副本一点都不能动（审查 P1-2 的核心）
  assert.equal(relay.store.exists(SID), true, "还没确认删除，正文不能清");
  assert.ok(relay.rooms.peek(SID), "离线房间还在");
  assert.equal(relay.devices.get(DEV).archives.has(SID), true);

  win.send({ type: "command_result", id: fwd.id, ok: true, data: { status: "already_deleted", method: null } });
  const ack = await v.type("ack", (f) => f.id === "del-g1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, { status: "already_deleted", method: null });
  // 设备确认确实没有 → 这时才清副本并补墓碑
  assert.equal(relay.rooms.peek(SID), null);
  assert.equal(fs.existsSync(roomFile), false);
  assert.equal(relay.devices.get(DEV).archives.has(SID), false);
  assert.equal(relay.index.getSession("admin", DEV, SID).deleted, true, "补了一条墓碑");
  await v.type("session_removed", (f) => f.ids.includes(SID));
});

test("删除（P1-2）：已有墓碑（row.deleted）才回 already_deleted 并幂等清理，不转发设备", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-tomb";
  const SID = "session-tomb";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, ["session.files"]);
  t.after(() => win.close());
  await seedIndexSession(win, DEV, { id: SID, path: sessionPathOf(SID), cwd: "/w/proj", name: "S", updatedAt: Date.now() });
  // 先手动打墓碑（模拟设备上已删、清单 removed 已到）
  assert.equal(relay.index.forgetSession("admin", DEV, SID, Date.now()), true);
  const roomFile = await seedCopies(relay, { sessionId: SID, deviceId: DEV });
  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());

  v.send({ type: "command", id: "del-t1", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const ack = await v.type("ack", (f) => f.id === "del-t1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, { status: "already_deleted", method: null });
  assert.equal(win.frames.some((f) => f.type === "command"), false, "已有墓碑不再打扰设备");
  assert.equal(relay.rooms.peek(SID), null);
  assert.equal(fs.existsSync(roomFile), false);
  await v.type("session_removed", (f) => f.ids.includes(SID));
});

test("删除：旧网页按房间寻址的 delete_session 也会清服务器副本（id 从 sessionPath 反推）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-legacy";
  const SID = "session-legacy";
  const RUN = "room-legacy-run";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, ["session.files"]);
  t.after(() => win.close());
  const { c: ext } = await extensionRoom(relay, RUN, { deviceId: DEV, cwd: "/w/proj" });
  t.after(() => ext.close());
  const pathOf = sessionPathOf(SID, "--w-proj--");
  await seedIndexSession(win, DEV, { id: SID, path: pathOf, cwd: "/w/proj", name: "旧", updatedAt: Date.now() });
  const roomFile = await seedCopies(relay, { sessionId: SID, deviceId: DEV });
  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());

  // 旧网页：不带 deviceId，按房间发（这里指向同目录的在线房间）
  v.send({ type: "command", id: "del-l1", room: RUN, command: "delete_session", args: { sessionPath: pathOf } });
  const fwd = await ext.type("command", (f) => f.command === "delete_session");
  assert.equal(fwd.args.sessionPath, pathOf);
  ext.send({ type: "command_result", id: fwd.id, ok: true, data: { status: "deleted", method: "trash" } });
  const ack = await v.type("ack", (f) => f.id === "del-l1");
  assert.equal(ack.ok, true);
  assert.equal(relay.store.exists(SID), false, "旧路径也清了正文");
  assert.equal(fs.existsSync(roomFile), false);
  assert.equal(relay.index.getSession("admin", DEV, SID).deleted, true);
  await v.type("session_removed", (f) => f.ids.includes(SID));
});

/* ---------------- P9 C：list_dirs / routeHarness / devices[] ---------------- */

test("list_dirs：只转给声明 fs.browse 的 attach（超时 8s），没声明的回 device_update_required", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-browse";
  const win = await attachWindow(relay, {
    id: DEV, name: "Mac", platform: "macos", projects: [], trash: true, browse: { roots: ["/Users/me"] },
  }, ["fs.browse"]);
  t.after(() => win.close());
  const { v, auth } = await viewer(relay, null, { caps: ["err.v4"] });
  t.after(() => v.close());

  // room_list.devices[] 带设备侧能力与事实
  const d = auth.devices.find((x) => x.id === DEV);
  assert.ok(d);
  assert.deepEqual(d.features, ["fs.browse"], "features 只留 relay 关心的子集");
  assert.deepEqual(d.browseRoots, ["/Users/me"]);
  assert.equal(d.trash, true);

  const listing = { root: "/Users/me", path: "/Users/me/proj", parent: "/Users/me", entries: [{ name: "a", path: "/Users/me/proj/a" }], truncated: false };
  v.send({ type: "command", id: "ls-1", deviceId: DEV, command: "list_dirs", args: { path: "/Users/me/proj", showHidden: true } });
  const fwd = await win.type("command", (f) => f.command === "list_dirs");
  assert.equal(fwd.timeoutMs, 8000, "list_dirs 超时 8s");
  assert.deepEqual(fwd.args, { path: "/Users/me/proj", showHidden: true });
  win.send({ type: "command_result", id: fwd.id, ok: true, data: listing });
  const ack = await v.type("ack", (f) => f.id === "ls-1");
  assert.equal(ack.ok, true);
  assert.deepEqual(ack.data, listing);

  // 旧 attach（没声明 fs.browse）：明确回 device_update_required，不往扩展房间分支掉
  const OLD = "dev-browse-old";
  const winOld = await attachWindow(relay, { id: OLD, name: "Old", platform: "macos", projects: [] }, []);
  t.after(() => winOld.close());
  v.send({ type: "command", id: "ls-2", deviceId: OLD, command: "list_dirs", args: {} });
  const oldAck = await v.type("ack", (f) => f.id === "ls-2");
  assert.equal(oldAck.ok, false);
  assertCoded(oldAck, "device_update_required");

  // 设备离线后 devices[] 的 features / browseRoots 为空
  win.close();
  await until(() => !relay.devices.get(DEV).online, "窗口离线");
  v.send({ type: "list_rooms" });
  const list = await v.wait((f) => f.type === "room_list" && Array.isArray(f.devices) && f.devices.some((x) => x.id === DEV && x.online === false), 3000, "离线后的 room_list");
  const offlineDev = list.devices.find((x) => x.id === DEV);
  assert.deepEqual(offlineDev.features, [], "离线设备 features 为空");
  assert.deepEqual(offlineDev.browseRoots, [], "离线设备不下发浏览根目录");
});

test("devices[].latencyMs：真实心跳 ping/pong 后，viewer 的 auth_result 与 room_list 都带上平滑延迟", async (t) => {
  const { keepaliveSweep } = require("../relay/conn.js");
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-latency";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, []);
  t.after(() => win.close());

  // 设备刚登记、还没回过 pong：字段在、值是 null（老端忽略未知字段，新端据此显示「—」）
  const first = await viewer(relay);
  t.after(() => first.v.close());
  const before = first.auth.devices.find((d) => d.id === DEV);
  assert.ok(before, "auth_result.devices 里有这台设备");
  assert.equal(before.online, true);
  assert.equal(before.latencyMs, null, "没有样本时给 null，不能拿 0ms 冒充");

  // 真打一轮心跳：relay 的 ws.ping → ws 客户端自动回 pong → relay 算 RTT 并存进 _state
  const serverWs = relay.devices.get(DEV).conn;
  keepaliveSweep({ clients: new Set([serverWs]) });
  await until(() => Number.isFinite(serverWs._state.latencyMs), "第一个 RTT 样本");
  assert.ok(serverWs._state._lastPongAt > 0, "_lastPongAt 留档");

  // room_list 走同一个 buildDeviceList：字段自动带出，整数毫秒
  first.v.send({ type: "list_rooms" });
  const list = await first.v.wait((f) => f.type === "room_list" && Array.isArray(f.devices) && f.devices.some((d) => d.id === DEV), 3000, "list_rooms 回包");
  const d = list.devices.find((x) => x.id === DEV);
  assert.equal(Number.isInteger(d.latencyMs), true, "下发整数毫秒：" + d.latencyMs);
  assert.ok(d.latencyMs >= 0 && d.latencyMs < 5000, "本机回环 RTT 不该是离谱值：" + d.latencyMs);
  assert.equal(d.online, true);

  // 之后新连上的 viewer：auth_result 的 devices 是同一份 deviceSnapshot，同样带该字段
  const second = await viewer(relay);
  t.after(() => second.v.close());
  const authDev = second.auth.devices.find((x) => x.id === DEV);
  assert.equal(Number.isInteger(authDev.latencyMs), true, "auth_result 自动继承该字段");
});

test("routeHarness：设备有 fs.browse 时放行浏览根目录下的 cwd，没有时照旧 cwd_not_allowed", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-harness-browse";
  const win = await attachWindow(relay, {
    id: DEV, name: "Mac", platform: "macos", projects: [], browse: { roots: ["/Users/me"] },
  }, ["fs.browse"]);
  t.after(() => win.close());
  const { v } = await viewer(relay, null, { caps: ["err.v4"] });
  t.after(() => v.close());

  v.send({ type: "command", id: "h-1", deviceId: DEV, command: "harness_start", args: { cwd: "/Users/me/proj" } });
  const fwd = await win.type("command", (f) => f.command === "harness_start");
  assert.equal(fwd.args.cwd, "/Users/me/proj", "根目录下的 cwd 被放行到 attach");
  win.send({ type: "command_result", id: fwd.id, ok: true, data: { status: "started" } });
  const ack = await v.type("ack", (f) => f.id === "h-1");
  assert.equal(ack.ok, true);

  // 同一台设备改成没有 fs.browse：白名单以外的 cwd 仍然拒绝
  const OLD = "dev-harness-old";
  const winOld = await attachWindow(relay, {
    id: OLD, name: "Old", platform: "macos", projects: [], browse: { roots: ["/Users/me"] },
  }, []);
  t.after(() => winOld.close());
  v.send({ type: "command", id: "h-2", deviceId: OLD, command: "harness_start", args: { cwd: "/Users/me/proj" } });
  const denied = await v.type("ack", (f) => f.id === "h-2");
  assert.equal(denied.ok, false);
  assertCoded(denied, "cwd_not_allowed");
  assert.equal(winOld.frames.some((f) => f.type === "command" && f.command === "harness_start"), false, "被拒的 cwd 不会转发");
});

/* ---------------- P9 第 1 轮审查修复：P1-2 / P1-3 / P2-1（D8） ---------------- */

test("删除（P1-2）：索引里没有、又没有能按 id 找文件的 attach → session_not_found，服务器副本一点不动", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-norow";
  const SID = "session-norow";
  // 在线但没声明 session.files 的旧 attach
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, []);
  t.after(() => win.close());
  const roomFile = await seedCopies(relay, { sessionId: SID, deviceId: DEV });
  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());

  v.send({ type: "command", id: "del-n1", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const ack = await v.type("ack", (f) => f.id === "del-n1");
  assert.equal(ack.ok, false, "无从证明设备上删了，不能回成功");
  assertCoded(ack, "session_not_found");
  assert.equal(win.frames.some((f) => f.type === "command"), false, "没有 attach 能力时不转发");
  assert.equal(relay.store.exists(SID), true, "服务器副本不能被清");
  assert.equal(fs.existsSync(roomFile), true);
  assert.ok(relay.rooms.peek(SID), "离线房间还在");
  assert.equal(v.frames.some((f) => f.type === "session_removed"), false, "不广播 session_removed");
});

test("删除（P1-3）：索引里有路径时 attach 路由带 pathHint；attach 回 session_outside_root 时不清服务器副本", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-del-hint";
  const SID = "session-hint";
  const pathOf = sessionPathOf(SID, "--p--");
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, ["session.files"]);
  t.after(() => win.close());
  await seedIndexSession(win, DEV, { id: SID, path: pathOf, cwd: "/w/proj", name: "S", updatedAt: Date.now() });
  const roomFile = await seedCopies(relay, { sessionId: SID, deviceId: DEV });
  const { v } = await viewer(relay, null, { caps: ["err.v4", "session.purge"] });
  t.after(() => v.close());

  v.send({ type: "command", id: "del-h1", deviceId: DEV, command: "delete_session", args: { sessionId: SID } });
  const fwd = await win.type("command", (f) => f.command === "delete_session");
  assert.deepEqual(fwd.args, { sessionId: SID, pathHint: pathOf }, "relay 转发索引里的路径作提示（P1-3）");
  // 设备侧判定文件在会话根目录外：回 session_outside_root，不发 removed、不清副本
  win.send({ type: "command_result", id: fwd.id, ok: false, error: PROTOCOL.errors.session_outside_root.message, code: "session_outside_root" });
  const ack = await v.type("ack", (f) => f.id === "del-h1");
  assert.equal(ack.ok, false);
  assertCoded(ack, "session_outside_root");
  assert.equal(ack.error, PROTOCOL.errors.session_outside_root.message);
  assert.equal(relay.store.exists(SID), true, "失败不清正文");
  assert.equal(fs.existsSync(roomFile), true);
  assert.ok(relay.rooms.peek(SID), "房间还在");
  assert.equal(relay.index.getSession("admin", DEV, SID).deleted, false, "索引没打墓碑");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(v.frames.some((f) => f.type === "session_removed"), false, "失败不广播 session_removed");
});

test("D8 路由（P2-1）：文件名类命令按索引 cwd 交给同目录房间（不是活动房间）；改名成功后同步 dev.archives 的 name", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-d8";
  const SID = "session-d8";
  const pathOf = sessionPathOf(SID, "--w-proj--");
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, []);
  t.after(() => win.close());
  await seedIndexSession(win, DEV, { id: SID, path: pathOf, cwd: "/w/proj", name: "旧名", updatedAt: Date.now() });
  // 会话库正文里已经有旧名字（网页打开过这个未载入会话）
  win.send({ type: "session_archive", deviceId: DEV, session: { id: SID, name: "旧名", messageCount: 1, messages: [{ role: "user", text: "hi" }] } });
  await until(() => { const a = relay.devices.get(DEV).archives; return !!(a && a.get(SID) && a.get(SID).name === "旧名"); }, "会话库正文");

  // 活动房间在别的目录（后注册的那个成为活动房间），目标会话在 /w/proj
  const { c: extSame } = await extensionRoom(relay, "room-d8-same", { deviceId: DEV, cwd: "/w/proj" });
  t.after(() => extSame.close());
  const { c: extOther } = await extensionRoom(relay, "room-d8-other", { deviceId: DEV, cwd: "/w/other" });
  t.after(() => extOther.close());
  assert.equal(relay.devices.get(DEV).activeRoomId, "room-d8-other", "活动房间已经不是目标会话的目录");

  const { v } = await viewer(relay, null, { caps: ["err.v4"] });
  t.after(() => v.close());
  v.send({ type: "command", id: "rn-1", deviceId: DEV, command: "rename_session_file", args: { sessionPath: pathOf, name: "新名" } });
  const fwd = await extSame.type("command", (f) => f.command === "rename_session_file");
  assert.equal(fwd.room, "room-d8-same", "按索引 row.cwd 找到同目录房间");
  assert.deepEqual(fwd.args, { sessionPath: pathOf, name: "新名" }, "args 原样转发");
  assert.equal(extOther.frames.some((f) => f.type === "command"), false, "不能捆到活动房间");
  extSame.send({ type: "command_result", id: fwd.id, ok: true, data: { name: "新名" } });
  const ack = await v.type("ack", (f) => f.id === "rn-1");
  assert.equal(ack.ok, true);
  assert.equal(relay.devices.get(DEV).archives.get(SID).name, "新名", "改名成功后同步会话库正文的名字");
});

test("D8 路由（P2-1）：索引里没有目标行时退回原来的活动房间逻辑", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "dev-d8-fb";
  const win = await attachWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: [] }, []);
  t.after(() => win.close());
  const { c: ext } = await extensionRoom(relay, "room-d8-fb", { deviceId: DEV, cwd: "/w/anything" });
  t.after(() => ext.close());
  const { v } = await viewer(relay, null, { caps: ["err.v4"] });
  t.after(() => v.close());

  v.send({ type: "command", id: "rn-fb", deviceId: DEV, command: "rename_session_file", args: { sessionPath: "/sessions/--x--/1700000000000_no-such-session.jsonl", name: "n" } });
  const fwd = await ext.type("command", (f) => f.command === "rename_session_file");
  assert.equal(fwd.room, "room-d8-fb", "查不到行时退回活动房间");
  ext.send({ type: "command_result", id: fwd.id, ok: true, data: { name: "n" } });
  const ack = await v.type("ack", (f) => f.id === "rn-fb");
  assert.equal(ack.ok, true);
});
