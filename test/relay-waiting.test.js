// P9 A：房间等待摘要 room.dialogs（spec §3.5 的 9 条）。
// 真起 relay（端口 0），用两条通道的真实帧验证：room_list 字段、room_waiting 广播与 cap 门控、
// same-tick 合并、离线清空、ui_prompt 兜底、auth_result.rooms、设备窗口拿不到新字段。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const { broadcastRoomWaiting } = require("../relay/rooms.js");

const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";
const R1 = "room-wait-1";
const R2 = "room-wait-2";
// 新网页的握手能力：A 的 room.dialogs、应答面 dialog.respond，外加既有 err.v4
const NEW_CAPS = ["err.v4", "msg.cid", "dialog.respond", "room.dialogs"];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-waiting-"));
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
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: true, // 与 relay.test.js 的 boot 一致：subscribe 立刻拿到快照
    ...overrides,
  });
}

/** 收帧客户端（与 relay.test.js 同款）：wait/type 取第一条还没被取走的匹配帧。 */
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
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

/** 扩展侧：一条 socket 注册一个房间，可选带 deviceId。 */
async function extensionRoom(relay, roomId, { deviceId, label = roomId, cwd = "/tmp" } = {}) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await c.type("auth_result");
  const room = { id: roomId, label, cwd, epoch: 1, instance: "inst-" + roomId };
  if (deviceId) room.deviceId = deviceId;
  c.send({ type: "room_register", room });
  await c.type("room_registered");
  return c;
}

/** 网页侧：auth 帧带 opts.caps（不传 = 旧端）。 */
async function viewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  const hello = { type: "auth", role: "viewer", token: VIEWER_TOKEN };
  if (Array.isArray(caps)) hello.caps = caps;
  v.send(hello);
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  return { v, auth };
}

/** 设备窗口（attach）：local 通道 device_register，只处理 harness_start 的那条连接。 */
async function deviceWindow(relay, device) {
  const w = client(relay.localPort);
  await w.opened;
  w.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await w.type("auth_result");
  w.send({ type: "device_register", device });
  return w;
}

const dialogOpen = (dialogId, extra = {}) => ({
  type: "dialog_open",
  dialogId,
  kind: "confirm",
  title: "允许执行 " + dialogId + "？",
  startedAt: 1000 + dialogId.length,
  timeout: 120000,
  ...extra,
});

/** 取某房间最近一帧 room_waiting（不含已被取走的） */
const waitingOfRoom = (v, room, extra = () => true) => (f) => f.type === "room_waiting" && f.room === room && extra(f);

test("dialog_open 后订阅其它房间的网页也收到该房的 room_waiting（1 条），dialog_close 后变空", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const r1 = await extensionRoom(relay, R1);
  t.after(() => r1.close());
  const r2 = await extensionRoom(relay, R2);
  t.after(() => r2.close());
  const { v } = await viewer(relay, NEW_CAPS);
  t.after(() => v.close());
  // 网页只看 R2：room_waiting 不按订阅过滤（和 room_attention 同一批听众）
  v.send({ type: "subscribe", room: R2 });
  await v.type("snapshot");

  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-1", { answerable: true }) });
  const w = await v.type("room_waiting", waitingOfRoom(v, R1));
  assert.equal(w.waiting.length, 1);
  assert.deepEqual(w.waiting[0], {
    dialogId: "dlg-1",
    kind: "confirm",
    title: "允许执行 dlg-1？",
    startedAt: "dlg-1".length + 1000,
    timeout: 120000,
    answerable: true,
  });
  assert.equal(w.waitingPrompt, null);
  assert.equal("options" in w.waiting[0], false, "摘要不带 options 正文面");

  r1.send({ type: "event", room: R1, event: { type: "dialog_close", dialogId: "dlg-1", outcome: "answered" } });
  const cleared = await v.type("room_waiting", waitingOfRoom(v, R1));
  assert.deepEqual(cleared.waiting, []);
  assert.equal(cleared.waitingPrompt, null);
});

test("同一 tick 两次触发 broadcastRoomWaiting 只出一帧、帧带全量两条（setImmediate 合并，单元）", async () => {
  const frames = [];
  const fakeViewer = {
    readyState: 1,
    _state: { caps: new Set(["room.dialogs", "dialog.respond"]) },
    send(data) { frames.push(JSON.parse(String(data))); },
  };
  const room = {
    id: "unit-room",
    online: true,
    uiPrompt: null,
    dialogs: {
      a: { dialogId: "a", kind: "confirm", title: "A", startedAt: 1, answerable: true },
      b: { dialogId: "b", kind: "confirm", title: "B", startedAt: 2, answerable: true },
    },
  };
  const rooms = { viewers: new Set([fakeViewer]) };
  const cfg = {};
  // 同步连续两次 = 同一个 tick；第一次 schedule 后第二次必须被 _waitingScheduled 吃掉
  broadcastRoomWaiting(rooms, room, cfg);
  broadcastRoomWaiting(rooms, room, cfg);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 1, "同一 tick 的多次触发只出一帧");
  assert.deepEqual(frames[0].waiting.map((w) => w.dialogId), ["a", "b"]);
  assert.equal(room._waitingScheduled, false, "合并标记清掉，后续变化还能再广播");
});

test("连发两个 dialog_open：最终摘要含两条（帧可能合并，也可能分两帧到达）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const r1 = await extensionRoom(relay, R1);
  t.after(() => r1.close());
  const { v } = await viewer(relay, NEW_CAPS);
  t.after(() => v.close());

  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-a", { answerable: true }) });
  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-b", { answerable: true }) });
  const w = await v.wait((f) => f.type === "room_waiting" && f.room === R1 && Array.isArray(f.waiting) && f.waiting.length === 2, 2000, "两条 waiting");
  assert.deepEqual(w.waiting.map((x) => x.dialogId), ["dlg-a", "dlg-b"]);
  // 不应出现第 3 帧：两条 dialog_open 最多各触发一次合并后的广播
  await new Promise((resolve) => setTimeout(resolve, 120));
  const frames = v.frames.filter((f) => f.type === "room_waiting" && f.room === R1);
  assert.ok(frames.length <= 2, "两次触发最多两帧，不能更多");
  assert.equal(frames[frames.length - 1].waiting.length, 2, "最后一帧是全量两条");
});

test("扩展断开（房间离线）：摘要广播成空", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const r1 = await extensionRoom(relay, R1);
  const { v } = await viewer(relay, NEW_CAPS);
  t.after(() => v.close());

  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-x", { answerable: true }) });
  const before = await v.type("room_waiting", waitingOfRoom(v, R1));
  assert.equal(before.waiting.length, 1);

  r1.close();
  const after = await v.type("room_waiting", waitingOfRoom(v, R1));
  assert.deepEqual(after.waiting, [], "离线房间的摘要是空的");
  assert.equal(after.waitingPrompt, null);
});

test("auth_result.rooms 里在线房间带着 waiting（新端）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const r1 = await extensionRoom(relay, R1);
  t.after(() => r1.close());
  // 先产生摘要，再让网页连上来：auth_result 的快照里就要有
  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-auth", { answerable: true }) });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const { auth } = await viewer(relay, NEW_CAPS);
  const entry = auth.rooms.find((r) => r.id === R1);
  assert.ok(entry, "auth_result.rooms 里有 R1");
  assert.equal(entry.waiting.length, 1);
  assert.equal(entry.waiting[0].dialogId, "dlg-auth");
  assert.equal(entry.waiting[0].answerable, true);
  assert.equal(entry.waitingPrompt, null);
});

test("没声明 room.dialogs 的旧端：收不到 room_waiting，清单条目也没有新字段", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const r1 = await extensionRoom(relay, R1);
  t.after(() => r1.close());
  const { v, auth } = await viewer(relay, ["err.v4"]); // 旧端
  t.after(() => v.close());

  const authed = auth.rooms.find((r) => r.id === R1);
  assert.ok(authed);
  assert.equal(Object.prototype.hasOwnProperty.call(authed, "waiting"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(authed, "waitingPrompt"), false);

  v.send({ type: "list_rooms" });
  const list = await v.type("room_list");
  const listed = list.rooms.find((r) => r.id === R1);
  assert.ok(listed);
  assert.equal(Object.prototype.hasOwnProperty.call(listed, "waiting"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(listed, "waitingPrompt"), false);

  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-old", { answerable: true }) });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(v.frames.some((f) => f.type === "room_waiting"), false, "旧端不该收到新帧");
});

test("没声明 dialog.respond 的网页：waiting[].answerable 被剥掉（清单与广播两处）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const r1 = await extensionRoom(relay, R1);
  t.after(() => r1.close());
  const { v, auth } = await viewer(relay, ["err.v4", "room.dialogs"]); // 有摘要、无应答权
  t.after(() => v.close());

  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-ro", { answerable: true }) });
  const w = await v.type("room_waiting", waitingOfRoom(v, R1));
  assert.equal(w.waiting.length, 1);
  assert.equal("answerable" in w.waiting[0], false, "没声明 dialog.respond 时不给应答面");

  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-ro2", { answerable: false }) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  // 清单（auth_result / list_rooms）同样按连接 cap 裁剪
  v.send({ type: "list_rooms" });
  const list = await v.type("room_list");
  const listed = list.rooms.find((r) => r.id === R1);
  assert.equal(listed.waiting.length, 2);
  for (const item of listed.waiting) assert.equal("answerable" in item, false);
  assert.ok(auth.rooms.find((r) => r.id === R1), "auth_result 里也有该房间");
});

test("只有 ui_prompt_start、没有 dialog 时：waitingPrompt 带 at，waiting 为空", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const r1 = await extensionRoom(relay, R1);
  t.after(() => r1.close());
  const { v } = await viewer(relay, NEW_CAPS);
  t.after(() => v.close());

  const startedAt = Date.now();
  r1.send({ type: "event", room: R1, event: { type: "ui_prompt_start", kind: "confirm", title: "确认切换？" } });
  const w = await v.type("room_waiting", waitingOfRoom(v, R1));
  assert.deepEqual(w.waiting, []);
  assert.equal(w.waitingPrompt.kind, "confirm");
  assert.equal(w.waitingPrompt.title, "确认切换？");
  assert.equal(typeof w.waitingPrompt.at, "number");
  assert.ok(w.waitingPrompt.at >= startedAt - 5, "at 是 relay 收到信号的时间");
  assert.equal(w.waitingPrompt.reason, undefined, "waitingPrompt 只带 kind/title/at 白名单");
});

test("设备窗口连接拿到的 room_list 没有新字段（什么 cap 都没声明的那份）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const DEV = "mac-wait-1";
  const r1 = await extensionRoom(relay, R1, { deviceId: DEV });
  t.after(() => r1.close());
  r1.send({ type: "event", room: R1, event: dialogOpen("dlg-dev", { answerable: true }) });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const win = await deviceWindow(relay, { id: DEV, name: "Mac", platform: "macos", projects: ["/tmp"] });
  t.after(() => win.close());
  const list = await win.type("room_list", (f) => Array.isArray(f.rooms) && f.rooms.some((r) => r.id === R1));
  const entry = list.rooms.find((r) => r.id === R1);
  assert.ok(entry);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "waiting"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "waitingPrompt"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(entry, "lastTurnEnd"), false, "设备窗口走最干净那份视图");
  assert.deepEqual(list.devices.map((d) => d.id), [DEV], "设备窗口只拿自己的设备");
});

/* ---------- 设计 D §2.3：房间最近事件摘要 lastEvent（cap room.activity） ---------- */

const { observeRoomTurnEvent, roomsViewFor, clearSessionState } = require("../relay/rooms.js");

test("lastEvent：白名单事件刷新摘要，只取 toolName 元数据（不带 args/正文）", () => {
  const room = { lastTurnEnd: null, turnOutcome: null, turnSettled: false, lastEvent: null };
  observeRoomTurnEvent(room, { type: "turn_start" }, 1000);
  assert.deepEqual(room.lastEvent, { type: "turn_start", at: 1000 });
  observeRoomTurnEvent(room, { type: "tool_execution_start", toolName: "bash", args: { command: "rm -rf /" }, partialResult: "正文" }, 2000);
  assert.deepEqual(room.lastEvent, { type: "tool_execution_start", toolName: "bash", at: 2000 }, "只有类型/工具名/时刻，args 与正文绝不入摘要");
  observeRoomTurnEvent(room, { type: "message_update", delta: "正文增量" }, 3000);
  assert.deepEqual(room.lastEvent, { type: "message_update", at: 3000 });
  observeRoomTurnEvent(room, { type: "tool_execution_update", toolName: "bash" }, 4000);
  assert.deepEqual(room.lastEvent, { type: "message_update", at: 3000 }, "非白名单事件不刷新");
  observeRoomTurnEvent(room, { type: "compaction_start" }, 5000);
  assert.deepEqual(room.lastEvent, { type: "compaction_start", at: 5000 });
});

test("lastEvent：回合落定（agent_settled）与会话状态清理时清空", () => {
  const room = { lastTurnEnd: null, turnOutcome: null, turnSettled: false, lastEvent: null };
  observeRoomTurnEvent(room, { type: "message_update" }, 1000);
  assert.ok(room.lastEvent);
  observeRoomTurnEvent(room, { type: "agent_settled" }, 2000);
  assert.equal(room.lastEvent, null, "落定即清，状态行转走 lastTurnEnd 分支");
  assert.deepEqual(room.lastTurnEnd, { kind: "done", at: 2000 }, "落定摘要照常维护");
  observeRoomTurnEvent(room, { type: "message_update" }, 3000);
  assert.ok(room.lastEvent);
  clearSessionState(room);
  assert.equal(room.lastEvent, null, "clearSessionState 一并清 lastEvent");
});

test("roomsViewFor：room.activity 未声明时剥 lastEvent，声明时保留（其余字段不动）", () => {
  const entry = { id: "r1", lastEvent: { type: "message_update", at: 9 }, lastTurnEnd: { kind: "done", at: 8 }, waiting: [], waitingPrompt: null };
  const legacy = { _state: { caps: new Set(["room.attention", "room.dialogs", "dialog.respond"]) } };
  const [stripped] = roomsViewFor(legacy, [entry]);
  assert.ok(!("lastEvent" in stripped), "旧端（无 room.activity）条目里没有 lastEvent");
  assert.deepEqual(stripped.lastTurnEnd, { kind: "done", at: 8 });
  assert.ok("lastEvent" in entry, "裁剪不改原条目");
  const modern = { _state: { caps: new Set(["room.attention", "room.dialogs", "dialog.respond", "room.activity"]) } };
  const [kept] = roomsViewFor(modern, [entry]);
  assert.deepEqual(kept.lastEvent, { type: "message_update", at: 9 });
  const bare = { _state: { caps: new Set() } };
  const [cleanest] = roomsViewFor(bare, [entry]);
  assert.ok(!("lastEvent" in cleanest) && !("lastTurnEnd" in cleanest) && !("waiting" in cleanest), "零 cap 连接拿最干净的条目");
});
