"use strict";
/**
 * local 通道（7001）未认证帧：与 viewer 的 pre-auth 用例对等。
 * 除 pair 外，认证前收到任何帧都只回 auth_result(auth_failed) 并 4003 关闭；
 * 这里逐类发业务帧，并断言 relay 内部没有订阅、命令、消息、房间、设备等副作用。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");

const ROOM = "room-preauth-local";
const ATTACK_ROOM = "room-created-by-preauth";
const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-preauth-"));
}

function boot(dataDir) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir,
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    perMessageDeflate: false,
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

/** 未认证连接发一帧：只允许得到 auth_failed，随后 4003 关闭，且没有任何业务响应 */
async function preauthLocalFrame(relay, frame) {
  const c = client(relay.localPort);
  try {
    await c.opened;
    const closed = new Promise((resolve) => c.ws.once("close", (code) => resolve(code)));
    c.send(frame);
    const r = await c.type("auth_result");
    assert.equal(r.ok, false, JSON.stringify(frame));
    assert.equal(r.code, "auth_failed", JSON.stringify(frame));
    assert.equal(await closed, 4003, JSON.stringify(frame));
    assert.deepEqual(c.frames.map((f) => f.type), ["auth_result"], "未认证帧不能换来任何业务响应");
  } finally {
    c.close();
  }
}

async function registeredLocal(relay) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  const auth = await c.type("auth_result");
  assert.equal(auth.ok, true);
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-a" } });
  const reg = await c.type("room_registered");
  assert.equal(reg.room, ROOM);
  return c;
}

test("local 未认证先发业务帧：auth_failed + 4003，不产生订阅/命令/消息/房间/设备副作用", async (t) => {
  const dataDir = tmpDir();
  const relay = await boot(dataDir);
  t.after(() => relay.close());
  const legit = await registeredLocal(relay);
  t.after(() => legit.close());

  const room = relay.rooms.peek(ROOM);
  assert.ok(room, "先注册一个真实房间，攻击帧才有明确的目标");
  const localConn = room.local;
  assert.ok(localConn, "房间应绑定真实本机连接");
  const framesBefore = legit.frames.length;

  const attacks = [
    { type: "subscribe", room: ROOM },
    { type: "command", id: "pre-cmd", room: ROOM, command: "get_state", args: {} },
    { type: "message", id: "pre-msg", room: ROOM, text: "hi" },
    { type: "abort", id: "pre-abort", room: ROOM },
    { type: "event", room: ROOM, event: { type: "message_end", message: { role: "user", content: [{ type: "text", text: "x" }], timestamp: 1 } } },
    { type: "room_register", room: { id: ATTACK_ROOM, label: "evil", cwd: "/tmp", epoch: 1, instance: "inst-evil" } },
    { type: "device_register", device: { id: "evil-dev", name: "Evil", platform: "linux", projects: ["/"], windowExpiresAt: Date.now() + 3600_000 } },
    { type: "list_rooms" },
  ];
  for (const frame of attacks) await preauthLocalFrame(relay, frame);

  // 再等一轮 setImmediate：即使有漏网的广播/延迟副作用，也在这里暴露
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(room.viewers.size, 0, "未认证 subscribe 不能把连接加进观看者");
  assert.equal(relay.rooms.viewers.size, 0);
  assert.equal(relay.rooms.peek(ATTACK_ROOM), null, "未认证 room_register 不能建房间");
  assert.equal(relay.rooms.map.size, 1, "房间表里只应有真实注册的那个房间");
  assert.equal(relay.store.exists(ATTACK_ROOM), false);
  assert.equal(fs.existsSync(path.join(dataDir, `${ATTACK_ROOM}.jsonl`)), false);
  assert.equal(relay.devices.size, 0, "未认证 device_register 不能进设备名册");
  assert.equal(relay.rooms.commandWaiters.size, 0, "未认证 command 不能被转发并挂起");
  assert.equal(relay.rooms.dedupe.size, 0);
  assert.equal(relay.rooms.viewerQueries.size, 0);

  const info = relay.store.info(ROOM);
  assert.equal(info.seq, 0, "未认证 event 不能写入存储");
  assert.equal(info.msgCount, 0);

  const received = legit.frames.slice(framesBefore);
  for (const type of ["command", "message", "abort", "event"]) {
    assert.equal(received.some((f) => f.type === type), false, `本机不应收到未认证连接发来的 ${type}`);
  }
  assert.equal(room.local, localConn, "真实本机连接不能被未认证帧挤掉");
  assert.equal(room.online, true);

  // 攻击之后 relay 仍然正常：viewer 能认证，房间列表里真实房间仍在线
  const viewer = client(relay.viewerPort);
  t.after(() => viewer.close());
  await viewer.opened;
  viewer.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
  assert.equal((await viewer.type("auth_result")).ok, true);
  viewer.send({ type: "list_rooms" });
  const list = await viewer.type("room_list", (f) => f.rooms.some((r) => r.id === ROOM));
  assert.equal(list.rooms.find((r) => r.id === ROOM).online, true);
});
