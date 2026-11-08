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
const { Rooms, recordFinalFrame, finalFramesOf, snapshotBodyWithFinalFrames, FINAL_FRAMES_TTL_MS, FINAL_FRAMES_MAX_PER_ROOM } = require("../relay/rooms.js");
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

/* ---------------- D (U1): createdAt on room shells ---------------- */

test("D：createdAt 建房时盖戳、不可变（活动/注册刷新都不动）", () => {
  const rooms = makeRooms();
  const before = Date.now();
  const r = rooms.get("stamp-1");
  const after = Date.now();
  assert.ok(Number.isFinite(r.createdAt) && r.createdAt >= before && r.createdAt <= after, "建房即盖戳");
  const stamp = r.createdAt;
  r.lastActivity = 1;
  rooms.get("stamp-1"); // 普通 get：刷新 lastActivity
  rooms.get("stamp-1", { activity: false }); // 注册路径
  rooms.touch(r);
  assert.equal(r.createdAt, stamp, "createdAt 恒为建房时刻");
  assert.ok(r.lastActivity > 1, "lastActivity 照常刷新（对照）");
});

test("D：list() 条目透出 createdAt，roomsViewFor（无 cap 连接）不剥", () => {
  const rooms = makeRooms();
  const r = shell(rooms, "listed-1");
  const entry = rooms.list().find((e) => e.id === "listed-1");
  assert.ok(entry, "离线新房应在列表里");
  assert.equal(entry.createdAt, r.createdAt);
  const viewedEntry = rooms.listFor({}).find((e) => e.id === "listed-1");
  assert.ok(viewedEntry);
  assert.equal(viewedEntry.createdAt, r.createdAt, "createdAt 不按 cap 裁剪");
});

test("D：evictIdle 只认 lastActivity——createdAt 新不保命、旧不判死", () => {
  const rooms = makeRooms({ store: fakeStore() });
  const fresh = shell(rooms, "fresh-created");
  fresh.createdAt = Date.now(); // 刚建
  fresh.lastActivity = 0; // 但早已无活动
  const ancient = shell(rooms, "ancient-created");
  ancient.createdAt = 1; // 很久以前建的
  ancient.lastActivity = Date.now(); // 但刚刚还有活动
  assert.equal(rooms.evictIdle(), 1);
  assert.equal(rooms.peek("fresh-created"), null, "createdAt 再新，无活动照样淘汰");
  assert.ok(rooms.peek("ancient-created"), "createdAt 再旧，有活动照样保留");
});

/* ---------------- E1: per-room delivery finals ---------------- */

test("E1：recordFinalFrame 记录/替换/忽略非法值", () => {
  const rooms = makeRooms();
  const room = rooms.get("fin-1");
  assert.deepEqual(finalFramesOf(room), []);
  const base = Date.now();
  recordFinalFrame(room, "cid-a", "delivered", base + 1000);
  recordFinalFrame(room, "cid-b", "failed", base + 2000);
  assert.deepEqual(finalFramesOf(room, base + 3000), [
    { cid: "cid-a", disposition: "delivered", at: base + 1000 },
    { cid: "cid-b", disposition: "failed", at: base + 2000 },
  ]);
  recordFinalFrame(room, "cid-a", "failed", base + 2500); // 同 cid 改判：替换且变最新
  assert.deepEqual(finalFramesOf(room, base + 3000), [
    { cid: "cid-b", disposition: "failed", at: base + 2000 },
    { cid: "cid-a", disposition: "failed", at: base + 2500 },
  ]);
  recordFinalFrame(room, "", "delivered", base + 2600);
  recordFinalFrame(room, "cid-c", "unknown", base + 2600);
  recordFinalFrame(null, "cid-d", "delivered", base + 2600);
  assert.equal(finalFramesOf(room, base + 3000).length, 2, "空 cid / 非法 disposition 不入表");
});

test("E1：终局表 TTL 过期淘汰（10 分钟）", () => {
  const rooms = makeRooms();
  const room = rooms.get("fin-ttl");
  const now = Date.now();
  recordFinalFrame(room, "cid-old", "delivered", now - FINAL_FRAMES_TTL_MS - 1);
  recordFinalFrame(room, "cid-new", "failed", now);
  assert.deepEqual(finalFramesOf(room, now), [{ cid: "cid-new", disposition: "failed", at: now }]);
  assert.equal(room.finalFrames.size, 1, "过期条目已从表里清掉");
});

test("E1：终局表条数上限淘汰最旧（200 条）", () => {
  const rooms = makeRooms();
  const room = rooms.get("fin-cap");
  const base = Date.now();
  for (let i = 0; i < FINAL_FRAMES_MAX_PER_ROOM + 5; i++) {
    recordFinalFrame(room, "cid-" + i, i % 2 ? "failed" : "delivered", base + i);
  }
  const out = finalFramesOf(room, base + FINAL_FRAMES_MAX_PER_ROOM + 5);
  assert.equal(out.length, FINAL_FRAMES_MAX_PER_ROOM);
  assert.equal(out[0].cid, "cid-5", "最旧 5 条已被挤掉");
  assert.equal(out[out.length - 1].cid, "cid-" + (FINAL_FRAMES_MAX_PER_ROOM + 4));
});

test("E1：snapshotBodyWithFinalFrames——无终局原样、有终局以 finalFrames 附在正文后", () => {
  const rooms = makeRooms();
  const room = rooms.get("fin-body");
  const body = `"rev":"r1","seq":3,"truncated":false,"messages":[]`;
  assert.equal(snapshotBodyWithFinalFrames(body, room), body, "无终局时正文逐字不变");
  const at = Date.now();
  recordFinalFrame(room, "cid-x", "delivered", at);
  const wrapped = snapshotBodyWithFinalFrames(body, room);
  const frame = JSON.parse(`{"type":"snapshot","room":"fin-body","busy":false,${wrapped}}`);
  assert.deepEqual(frame.finalFrames, [{ cid: "cid-x", disposition: "delivered", at }]);
  assert.deepEqual(frame.messages, []);
});

test("E1：切走期间产生的终局，切回订阅时随快照 finalFrames 补发（delivered + failed 两路）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const local = await authedLocal(relay);
  t.after(() => local.close());
  local.send({
    type: "room_register",
    room: { id: "e1-room", label: "E1", cwd: "/work", deviceId: "dev-e1", deviceName: "E1", platform: "linux" },
  });
  await local.type("room_registered");

  const viewer = client(relay.viewerPort);
  t.after(() => viewer.close());
  await viewer.opened;
  viewer.send({ type: "auth", role: "viewer", token: "vt" });
  assert.equal((await viewer.type("auth_result")).ok, true);

  // 第一次订阅：本机回空快照作答 resend —— 无终局时快照不带 finalFrames
  viewer.send({ type: "subscribe", room: "e1-room" });
  await local.type("resend_snapshot");
  local.send({ type: "snapshot", room: "e1-room", messages: [] });
  const snap1 = await viewer.type("snapshot", (f) => f.room === "e1-room");
  assert.ok(!("finalFrames" in snap1), "无终局时快照保持原形状");

  // 切走：退订后本机先后落定 delivered（事件路）与 failed（独立帧路）
  viewer.send({ type: "unsubscribe", room: "e1-room" });
  local.send({ type: "event", room: "e1-room", event: { type: "remote_message_delivered", cid: "e1-cid-ok", at: Date.now() } });
  local.send({ type: "remote_message_failed", room: "e1-room", cid: "e1-cid-bad", text: "hello", error: "注入失败" });
  assert.ok(await until(() => {
    const room = relay.rooms.peek("e1-room");
    return !!(room && room.finalFrames && room.finalFrames.size === 2);
  }), "两条终局应已记入房终局表");

  // 切回订阅：快照必须带上两条终局
  viewer.send({ type: "subscribe", room: "e1-room" });
  await local.type("resend_snapshot");
  local.send({ type: "snapshot", room: "e1-room", messages: [] });
  const snap2 = await viewer.type("snapshot", (f) => f.room === "e1-room" && Array.isArray(f.finalFrames));
  assert.equal(snap2.finalFrames.length, 2);
  const byCid = new Map(snap2.finalFrames.map((f) => [f.cid, f]));
  assert.equal(byCid.get("e1-cid-ok").disposition, "delivered");
  assert.equal(byCid.get("e1-cid-bad").disposition, "failed");
  assert.ok(Number.isFinite(byCid.get("e1-cid-ok").at) && Number.isFinite(byCid.get("e1-cid-bad").at));
});
