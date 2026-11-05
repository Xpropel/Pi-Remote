"use strict";
// D-4: relay room-registry hygiene. Attach re-registrations mint a fresh
// room shell per restart (new room id, same device + workspace); before
// D-4 the registry grew by a handful of shells per re-registration and
// never shrank (registration renewed lastActivity, so the idle evictor
// never fired). These tests pin the fix: registration does not renew the
// idle clock, going offline stamps it, a live registration supersedes
// empty stale shells for the same device + workspace, and the shared
// teardown also clears the room's inbox turn entries -- while anything
// live, watched, stored, dialog-pending or schedule-armed is preserved.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { Rooms } = require("../relay/rooms.js");
const { InboxStore } = require("../relay/inbox.js");
const { startRelay } = require("../relay/server.js");

const ADMIN_TOKEN = "registry-admin-token-0123456789";

/* ---------------- unit: Rooms in isolation ---------------- */

function fakeStore(infos = {}) {
  return {
    info: (id) => infos[id] || { exists: false, msgCount: 0, indexing: false },
    exists: (id) => !!(infos[id] && infos[id].onDisk),
  };
}

function fakeSchedule(armedByRoom = {}) {
  const retired = [];
  return {
    retired,
    store: { armedOfRoom: (roomId) => armedByRoom[roomId] || [] },
    bindHost() {},
    retireRoom(id) { retired.push(id); },
  };
}

function makeRooms(extra = {}) {
  const rooms = new Rooms({ roomIdleEvictMs: 1000, snapshotCacheTtlMs: 1000 });
  if (extra.store) rooms.bindStore(extra.store);
  if (extra.inbox) rooms.bindInbox(extra.inbox);
  if (extra.schedule) rooms.bindSchedule(extra.schedule);
  return rooms;
}

function shell(rooms, id, { deviceId = "dev-1", cwd = "/work", accountId = "admin" } = {}) {
  const r = rooms.get(id);
  r.deviceId = deviceId;
  r.cwd = cwd;
  r.accountId = accountId;
  r.online = false;
  r.local = null;
  return r;
}

function liveRoom(rooms, id, opts = {}) {
  const r = shell(rooms, id, opts);
  r.online = true;
  r.local = { fake: true };
  return r;
}

test("D-4：get({activity:false}) 不续期 lastActivity，普通 get 照常续期", () => {
  const rooms = makeRooms();
  const r = rooms.get("r1");
  r.lastActivity = 1000;
  assert.equal(rooms.get("r1", { activity: false }).lastActivity, 1000, "注册路径不许刷新空闲时钟");
  assert.ok(rooms.get("r1").lastActivity > 1000, "普通 get 仍刷新");
  assert.equal(rooms.get("r1").lastRegisterAt, null, "新壳 lastRegisterAt 初始为 null");
});

test("D-4：supersede 回收同设备同工作区的空壳，活房/异目录/异设备不动", () => {
  const rooms = makeRooms();
  const live = liveRoom(rooms, "live-1");
  shell(rooms, "stale-1");
  shell(rooms, "stale-2");
  shell(rooms, "stale-3");
  shell(rooms, "other-cwd", { cwd: "/elsewhere" });
  shell(rooms, "other-dev", { deviceId: "dev-2" });
  assert.equal(rooms.supersedeStaleShells(live), 3);
  assert.deepEqual([...rooms.map.keys()].sort(), ["live-1", "other-cwd", "other-dev"]);
});

test("D-4：supersede 对无 deviceId / 无 cwd 的活房是 no-op", () => {
  const rooms = makeRooms();
  shell(rooms, "stale-1");
  const bare = rooms.get("bare");
  assert.equal(rooms.supersedeStaleShells(bare), 0);
  assert.ok(rooms.peek("stale-1"));
});

test("D-4：有存储转录的壳不回收（store msgCount / 索引中 / 仅磁盘文件三种形态）", () => {
  const store = fakeStore({
    "has-msgs": { exists: true, msgCount: 2, indexing: false },
    "indexing": { exists: true, msgCount: 0, indexing: true },
    "disk-only": { exists: false, msgCount: 0, indexing: false, onDisk: true },
    "empty-shell": { exists: true, msgCount: 0, indexing: false },
  });
  const rooms = makeRooms({ store });
  const live = liveRoom(rooms, "live-1");
  shell(rooms, "has-msgs");
  shell(rooms, "indexing");
  shell(rooms, "disk-only");
  shell(rooms, "empty-shell");
  assert.equal(rooms.supersedeStaleShells(live), 1, "只有真空壳被回收");
  assert.ok(rooms.peek("has-msgs") && rooms.peek("indexing") && rooms.peek("disk-only"));
  assert.equal(rooms.peek("empty-shell"), null);
});

test("D-4：有未答对话框（房上活槽 / 收件箱 waiting 条目）的壳不回收", () => {
  const inbox = new InboxStore(null);
  const rooms = makeRooms({ inbox });
  const live = liveRoom(rooms, "live-1");
  const withDialog = shell(rooms, "dlg-room");
  withDialog.dialogs = { "dlg-1": { dialogId: "dlg-1", kind: "select", startedAt: 1 } };
  shell(rooms, "inbox-room");
  inbox.upsert({ key: "w1", accountId: "admin", roomId: "inbox-room", kind: "waiting", subkind: "dialog", at: 100 });
  shell(rooms, "plain-shell");
  assert.equal(rooms.supersedeStaleShells(live), 1);
  assert.ok(rooms.peek("dlg-room"), "房上挂着未答 dialog 的壳保留");
  assert.ok(rooms.peek("inbox-room"), "收件箱有 waiting 条目的壳保留");
  assert.equal(rooms.peek("plain-shell"), null);
});

test("D-4：回收壳时一并清掉它的收件箱 turn 条目（P5），并退休其 armed 排期", () => {
  const inbox = new InboxStore(null);
  const schedule = fakeSchedule();
  const rooms = makeRooms({ inbox, schedule });
  const live = liveRoom(rooms, "live-1");
  shell(rooms, "gone-room");
  inbox.upsert({ key: "t1", accountId: "admin", roomId: "gone-room", kind: "done", subkind: "turn", at: 100 });
  assert.equal(inbox.roomEntries("admin", "gone-room").length, 1);
  assert.equal(rooms.supersedeStaleShells(live), 1);
  assert.equal(inbox.roomEntries("admin", "gone-room").length, 0, "turn 条目随壳一起清掉，不再永久残留");
  assert.deepEqual(schedule.retired, ["gone-room"], "armed 排期随壳退休");
});

test("D-4：有 armed 排期 / 有观众 / 在线的同族壳不回收", () => {
  const schedule = fakeSchedule({ "sched-room": [{ id: "s1" }] });
  const rooms = makeRooms({ schedule });
  const live = liveRoom(rooms, "live-1");
  shell(rooms, "sched-room");
  const watched = shell(rooms, "watched-room");
  watched.viewers.add({ fake: true });
  const online = shell(rooms, "online-room");
  online.online = true;
  assert.equal(rooms.supersedeStaleShells(live), 0);
  assert.ok(rooms.peek("sched-room") && rooms.peek("watched-room") && rooms.peek("online-room"));
});

test("D-4：evictIdle 走共享拆除——过期壳连同 turn 条目一起清，在线房不动", () => {
  const inbox = new InboxStore(null);
  const rooms = makeRooms({ inbox });
  const old = shell(rooms, "old-room");
  old.lastActivity = 0;
  inbox.upsert({ key: "t1", accountId: "admin", roomId: "old-room", kind: "done", subkind: "turn", at: 100 });
  liveRoom(rooms, "live-1");
  assert.equal(rooms.evictIdle(), 1);
  assert.equal(rooms.peek("old-room"), null);
  assert.equal(inbox.roomEntries("admin", "old-room").length, 0);
  assert.ok(rooms.peek("live-1"));
});

/* ---------------- integration: real relay, real sockets ---------------- */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-registry-"));
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
  ws.on("error", () => {});
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(obj) { ws.send(JSON.stringify(obj)); },
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
            reject(new Error(`等待 ${what} 超时；已收到：${frames.map((f) => f.type).join(",")}`));
          }, ms),
        };
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type);
    },
    close() { ws.terminate(); },
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

async function until(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

test("D-4：重注册风暴——同设备同工作区连开 8 个房，注册表始终只有最新一个", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const N = 8;
  for (let i = 1; i <= N; i++) {
    const c = await authedLocal(relay);
    c.send({
      type: "room_register",
      room: { id: "storm-" + i, label: "S" + i, cwd: "/work", deviceId: "dev-storm", deviceName: "Storm", platform: "linux" },
    });
    await c.type("room_registered");
    assert.equal(relay.rooms.map.size, 1, `第 ${i} 次注册后注册表应只有 1 个房（实际 ${[...relay.rooms.map.keys()]}）`);
    assert.ok(relay.rooms.peek("storm-" + i), "最新房在册");
    if (i < N) {
      c.close();
      assert.ok(await until(() => {
        const r = relay.rooms.peek("storm-" + i);
        return !r || r.online === false;
      }), "断开后旧房应离线（壳留待下次注册回收）");
    } else {
      t.after(() => c.close());
    }
  }
});

test("D-4：连接断开（下线路径）给 lastActivity 盖戳，空闲窗口从会话结束起算", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const c = await authedLocal(relay);
  t.after(() => c.close());
  c.send({
    type: "room_register",
    room: { id: "stamp-room", label: "S", cwd: "/work", deviceId: "dev-stamp", platform: "linux" },
  });
  await c.type("room_registered");
  const room = relay.rooms.peek("stamp-room");
  assert.ok(room);
  room.lastActivity = 1; // 假装这个房已经闲置很久
  c.close();
  assert.ok(await until(() => room.online === false), "断开后房间离线");
  assert.ok(room.lastActivity > 1, "下线路径必须盖戳：lastActivity 应为断开时刻而非旧值");
});

test("D-4：harness_start 选房优先认设备活动房，不被 lastActivity 更大的同目录旧房抢走", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const win = await authedLocal(relay);
  t.after(() => win.close());
  win.send({
    type: "device_register",
    device: { id: "dev-pref", name: "Win", platform: "windows", projects: ["D:\\work"], windowExpiresAt: 1791437613000 },
  });
  const extOld = await authedLocal(relay);
  t.after(() => extOld.close());
  extOld.send({
    type: "room_register",
    room: { id: "room-old", label: "old", cwd: "D:\\work", deviceId: "dev-pref", deviceName: "Win", platform: "windows" },
  });
  await extOld.type("room_registered");
  const extNew = await authedLocal(relay);
  t.after(() => extNew.close());
  extNew.send({
    type: "room_register",
    room: { id: "room-new", label: "new", cwd: "D:\\work", deviceId: "dev-pref", deviceName: "Win", platform: "windows" },
  });
  await extNew.type("room_registered");
  // 活动房是后注册的 room-new（noteActive 在注册时记下）；故意把
  // lastActivity 弄成旧房更大——没有 D-4 的优先规则时扫描会选错房。
  relay.rooms.peek("room-old").lastActivity = Date.now() + 100000;
  relay.rooms.peek("room-new").lastActivity = 1;

  const v = client(relay.viewerPort);
  t.after(() => v.close());
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt" });
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  v.send({ type: "command", id: "h1", deviceId: "dev-pref", command: "harness_start", args: { cwd: "D:\\work" } });
  const ack = await v.type("ack", (f) => f.id === "h1");
  assert.equal(ack.ok, true);
  assert.equal(ack.data.status, "already_running");
  assert.equal(ack.data.roomId, "room-new", "应命中设备活动房，而非 lastActivity 最大的旧房");
});
