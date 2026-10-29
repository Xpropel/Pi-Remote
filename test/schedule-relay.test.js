// 定时/心跳排期 relay 集成（设计 D §3）：真起 relay、两条通道真实帧验证——
// cap 门控、schedule_create/cancel/list 命令面、到点经既有命令通道下发 prompt
// （cid 对号 + 段位映射）、投递成功/失败的状态迁移与账本联动、离线顺延、重启恢复、
// remote_message_failed 送达判失败。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");

const LOCAL_TOKEN = ["sched", "local", "token"].join("-");
const VIEWER_TOKEN = ["sched", "viewer", "token"].join("-");
const R1 = "room-sched-1";
const CAPS = ["err.v4", "msg.cid", "room.schedule", "room.inbox"];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-sched-relay-"));
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
    persistTranscripts: true,
    scheduleTickMs: 50,
    ...overrides,
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
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(obj) { ws.send(JSON.stringify(obj)); },
    wait(pred, ms = 4000, what = "frame") {
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
    close() { ws.terminate(); },
  };
  return api;
}

async function extensionRoom(relay, roomId) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: roomId, label: roomId, cwd: "/tmp", epoch: 1, instance: "inst-" + roomId } });
  await c.type("room_registered");
  return c;
}

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

let qseq = 0;
async function query(v, frame) {
  const id = "q" + (++qseq);
  v.send({ ...frame, id });
  return v.wait((f) => f.type === "ack" && f.id === id, 4000, "ack " + frame.type);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const schedUpdateWith = (pred) => (f) => f.type === "schedule_update" && pred(f);

test("cap 门控：未声明 room.schedule 的端 room_list 无 schedules、命令回 unsupported", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const old = await viewer(relay, ["err.v4"]);
  t.after(() => old.v.close());
  const roomOld = old.auth.rooms.find((r) => r.id === R1);
  assert.ok(roomOld);
  assert.equal("schedules" in roomOld, false);
  old.v.send({ type: "schedule_create", id: "qx", roomId: R1, text: "hi", segment: "steer", kind: "once", at: Date.now() + 60000 });
  const err = await old.v.wait((f) => f.type === "error" && f.id === "qx");
  assert.equal(err.code, "unsupported");

  const fresh = await viewer(relay, CAPS);
  t.after(() => fresh.v.close());
  const roomNew = fresh.auth.rooms.find((r) => r.id === R1);
  assert.deepEqual(roomNew.schedules, []);
});

test("到点投递：create 回执 → 命令通道下发 prompt（cid/段位对号）→ 成功退休 + schedule_update", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());

  const ack = await query(v, { type: "schedule_create", roomId: R1, text: "记得交周报", segment: "follow_up", kind: "once", at: Date.now() + 300 });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  const entry = ack.data;
  assert.match(entry.id, /^sch_[a-z0-9]+$/);
  assert.equal(entry.state, "armed");

  const cmd = await ext.type("command", (f) => f.command === "prompt");
  assert.equal(cmd.args.text, "记得交周报");
  assert.equal(cmd.args.streamingBehavior, "followUp", "follow_up 段映射为 followUp");
  assert.equal(cmd.args.cid, `${entry.id}_1`);
  ext.send({ type: "command_result", room: R1, id: cmd.id, ok: true, data: { disposition: "queued" } });

  const upd = await v.type("schedule_update", schedUpdateWith((f) => f.room === R1 && f.schedules.some((s) => s.id === entry.id && s.state === "retired")));
  const done = upd.schedules.find((s) => s.id === entry.id);
  assert.equal(done.retireReason, "max_fires");
  assert.equal(done.firedCount, 1);

  const list = await query(v, { type: "schedule_list", roomId: R1 });
  assert.equal(list.ok, true);
  assert.ok(list.data.schedules.some((s) => s.id === entry.id && s.state === "retired"));
});

test("投递失败：命令回执失败 → 条目 failed + 收件箱账本 error 条目（sched:<id>）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());

  const ack = await query(v, { type: "schedule_create", roomId: R1, text: "会失败的一条", segment: "steer", kind: "every", intervalMs: 60000, expireAt: Date.now() + 3600000 });
  assert.equal(ack.ok, true);
  const entry = ack.data;
  // 白盒把首拍拨到现在（集成环境里等不了真实 60 秒）
  const stored = relay.schedule.store.get(entry.accountId, entry.id);
  stored.nextAt = Date.now();

  const cmd = await ext.type("command", (f) => f.command === "prompt" && f.args && f.args.cid === `${entry.id}_1`);
  assert.equal(cmd.args.streamingBehavior, "steer");
  ext.send({ type: "command_result", room: R1, id: cmd.id, ok: false, error: "队列已满", code: "busy" });

  const upd = await v.type("schedule_update", schedUpdateWith((f) => f.schedules.some((s) => s.id === entry.id && s.state === "failed")));
  assert.equal(upd.schedules.find((s) => s.id === entry.id).retireReason, "delivery_failed");
  const inboxUpd = await v.type("inbox_update", (f) => Array.isArray(f.upserts) && f.upserts.some((e) => e.key === `sched:${entry.id}`));
  const errEntry = inboxUpd.upserts.find((e) => e.key === `sched:${entry.id}`);
  assert.equal(errEntry.kind, "error");
  assert.equal(errEntry.subkind, "schedule");
});

test("送达判失败：回执成功后 remote_message_failed 按 cid 停机（every）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());

  const ack = await query(v, { type: "schedule_create", roomId: R1, text: "心跳", segment: "steer", kind: "every", intervalMs: 60000 });
  const entry = ack.data;
  relay.schedule.store.get(entry.accountId, entry.id).nextAt = Date.now();
  const cmd = await ext.type("command", (f) => f.command === "prompt" && f.args && f.args.cid === `${entry.id}_1`);
  ext.send({ type: "command_result", room: R1, id: cmd.id, ok: true, data: { disposition: "queued" } });
  await v.type("schedule_update", schedUpdateWith((f) => f.schedules.some((s) => s.id === entry.id && s.firedCount === 1 && s.state === "armed")));
  // 队列释放时注入失败（会话已换代）：事件带同一 cid
  ext.send({ type: "event", room: R1, event: { type: "remote_message_failed", cid: `${entry.id}_1`, error: "会话已结束" } });
  const upd = await v.type("schedule_update", schedUpdateWith((f) => f.schedules.some((s) => s.id === entry.id && s.state === "failed")));
  assert.ok(upd);
});

test("校验与取消：坏参数回 bad_args、无房回 no_room、取消后终态再取消回 not_found", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());

  const badInterval = await query(v, { type: "schedule_create", roomId: R1, text: "x", segment: "steer", kind: "every", intervalMs: 30000 });
  assert.equal(badInterval.ok, false);
  assert.equal(badInterval.code, "bad_args");
  const past = await query(v, { type: "schedule_create", roomId: R1, text: "x", segment: "steer", kind: "once", at: Date.now() - 60000 });
  assert.equal(past.code, "bad_args");
  const withImage = await query(v, { type: "schedule_create", roomId: R1, text: "x", segment: "steer", kind: "once", at: Date.now() + 60000, images: [{ type: "image", data: "AA==" }] });
  assert.equal(withImage.code, "bad_args", "一期纯文本");
  const noRoom = await query(v, { type: "schedule_create", roomId: "room-nope", text: "x", segment: "steer", kind: "once", at: Date.now() + 60000 });
  assert.equal(noRoom.code, "no_room");

  const ack = await query(v, { type: "schedule_create", roomId: R1, text: "待取消", segment: "steer", kind: "every", intervalMs: 60000 });
  assert.equal(ack.ok, true);
  const cancel = await query(v, { type: "schedule_cancel", scheduleId: ack.data.id });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.data.state, "retired");
  assert.equal(cancel.data.retireReason, "canceled");
  const again = await query(v, { type: "schedule_cancel", scheduleId: ack.data.id });
  assert.equal(again.ok, false);
  assert.equal(again.code, "not_found");
});

test("离线顺延：房间离线时到点不投、保持 armed；重连注册后补投", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  let ext = await extensionRoom(relay, R1);
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());
  ext.close();
  ext = null;
  await sleep(300); // 等 relay 把房间标离线

  const ack = await query(v, { type: "schedule_create", roomId: R1, text: "离线顺延", segment: "steer", kind: "once", at: Date.now() + 200 });
  assert.equal(ack.ok, true, JSON.stringify(ack));
  await sleep(600); // 已过 at，宽限内
  const mid = await query(v, { type: "schedule_list", roomId: R1 });
  const midEntry = mid.data.schedules.find((s) => s.id === ack.data.id);
  assert.equal(midEntry.state, "armed", "宽限内不作废、不投递");
  assert.equal(midEntry.firedCount, 0);

  const ext2 = await extensionRoom(relay, R1);
  t.after(() => ext2.close());
  const cmd = await ext2.type("command", (f) => f.command === "prompt" && f.args && f.args.cid === `${ack.data.id}_1`);
  ext2.send({ type: "command_result", room: R1, id: cmd.id, ok: true, data: { disposition: "started" } });
  await v.type("schedule_update", schedUpdateWith((f) => f.schedules.some((s) => s.id === ack.data.id && s.state === "retired")));
});

test("重启恢复：armed 排期跨 relay 重启读回（排期表落盘）", async (t) => {
  const dataDir = tmpDir();
  const relay1 = await boot({ dataDir });
  const ext1 = await extensionRoom(relay1, R1);
  const v1 = await viewer(relay1, CAPS);
  const ack = await query(v1.v, { type: "schedule_create", roomId: R1, text: "跨重启", segment: "follow_up", kind: "every", intervalMs: 60000 });
  assert.equal(ack.ok, true);
  const id = ack.data.id;
  ext1.close();
  v1.v.close();
  await relay1.close();

  const relay2 = await boot({ dataDir });
  t.after(() => relay2.close());
  const v2 = await viewer(relay2, CAPS);
  t.after(() => v2.v.close());
  const list = await query(v2.v, { type: "schedule_list", roomId: R1 });
  const restored = list.data.schedules.find((s) => s.id === id);
  assert.ok(restored, "重启后排期仍在表上");
  assert.equal(restored.state, "armed");
  assert.equal(restored.kind, "every");
});
