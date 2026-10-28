// 三端联调（进程内）：真 relay + 真扩展 Bridge（走真 WebSocket）+ 模拟网页。
// 验证 v4 契约在组件之间真的接得上：握手能力、命令失败带码、消息 cid 从网页到 pi 再回来。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { startRelay } = require("../relay/server.js");
const WebSocket = require("ws");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-v4-int-"));
const ADMIN_TOKEN = "test-admin-token-int-5e2a";
const relay = await startRelay({
  localPort: 0,
  viewerPort: 0,
  dataDir: path.join(tmp, "rooms"),
  accountsDir: path.join(tmp, "accounts"),
  quiet: true,
  exitOnListenError: false,
  localToken: "lt",
  viewerToken: "vt",
  adminToken: ADMIN_TOKEN,
  flushIntervalMs: 10,
  perMessageDeflate: false,
  persistTranscripts: false,
});

const DEVICE = "dev-int";
const ROOM = "int-room-1";
const attachFile = path.join(tmp, "remote-attach.json");
fs.writeFileSync(attachFile, JSON.stringify({ pid: process.pid, deviceId: DEVICE, accountId: "admin", expiresAt: Date.now() + 3600e3 }));
Object.assign(process.env, {
  PI_REMOTE_RELAY: `ws://127.0.0.1:${relay.localPort}`,
  PI_REMOTE_TOKEN: "lt",
  PI_REMOTE_DEVICE_ID: DEVICE,
  PI_REMOTE_ATTACH_FILE: attachFile,
  PI_REMOTE_LOG: path.join(tmp, "ext.log"),
});
delete process.env.PI_REMOTE_DEVICE_TOKEN;
delete process.env.PI_REMOTE_ALWAYS_ONLINE;

const jiti = createJiti(import.meta.url, { interopDefault: false });
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname);

const until = async (pred, ms = 3000, what = "条件") => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时：" + what);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function viewer() {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.viewerPort}/`);
  const frames = [];
  ws.on("message", (d) => frames.push(JSON.parse(String(d))));
  return {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send: (o) => ws.send(JSON.stringify(o)),
    async take(pred, what) {
      await until(() => frames.some(pred), 3000, what);
      return frames.find(pred);
    },
  };
}

const sentToPi = [];
const bridge = new ext.Bridge();
bridge.pi = {
  sendUserMessage: (content, opts) => sentToPi.push({ content, opts }),
  getThinkingLevel: () => "off",
};
const ctx = {
  cwd: tmp,
  isIdle: () => true,
  model: { id: "m", provider: "p" },
  sessionManager: { sessionId: ROOM, cwd: tmp, getBranch: () => [], getSessionName: () => null, getSessionId: () => ROOM },
};

test.after(async () => {
  try { bridge.stop(); } catch {}
  await new Promise((r) => setTimeout(r, 200));
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("握手：扩展从 auth_result 拿到 relay 能力，不再靠猜；网页也拿到 proto 与 caps", async () => {
  bridge.start();
  await until(() => bridge.authed, 3000, "扩展鉴权");
  assert.ok(bridge.relayCaps instanceof Set, "v4 relay 必须回 caps");
  for (const cap of ["err.v4", "sync.v3", "room.label"]) assert.ok(bridge.relayCaps.has(cap), cap);
  assert.equal(bridge.relayV3, true);
  assert.equal(bridge.noRoomLabel, false);
  assert.equal(bridge.relayAuth, "legacy", "共享令牌登录");

  bridge.bindSession(ctx);
  await until(() => relay.rooms.peek(ROOM) && relay.rooms.peek(ROOM).online, 3000, "房间上线");

  const v = viewer();
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4", "msg.cid"], client: { kind: "viewer", version: "test" } });
  const auth = await v.take((f) => f.type === "auth_result", "viewer 鉴权");
  assert.equal(auth.ok, true);
  assert.equal(auth.proto, 4);
  assert.ok(Array.isArray(auth.caps) && auth.caps.includes("err.v4"));
  v.ws.close();
});

test("命令失败的错误码从扩展原样到网页：bad_args、unknown_command", async () => {
  const v = viewer();
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4"] });
  await v.take((f) => f.type === "auth_result" && f.ok, "鉴权");
  v.send({ type: "command", id: "e1", room: ROOM, command: "set_model", args: {}, dedupeKey: "e1" });
  v.send({ type: "command", id: "e2", room: ROOM, command: "no_such_command", args: {}, dedupeKey: "e2" });
  const a = await v.take((f) => f.type === "ack" && f.id === "e1", "set_model ack");
  const b = await v.take((f) => f.type === "ack" && f.id === "e2", "未知命令 ack");
  assert.deepEqual([a.ok, a.code], [false, "bad_args"]);
  assert.deepEqual([b.ok, b.code], [false, "unknown_command"]);
  assert.match(a.error, /provider/, "给人看的文案保留扩展原话");
  v.ws.close();
});

test("消息 cid：网页发出 → pi 收到 → 回显带 cid → pi 接收后网页收到 remote_message_delivered", async () => {
  const v = viewer();
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4", "msg.cid"] });
  await v.take((f) => f.type === "auth_result" && f.ok, "鉴权");
  v.send({ type: "subscribe", room: ROOM });
  await v.take((f) => f.type === "subscribed", "订阅");

  v.send({ type: "command", id: "p1", room: ROOM, command: "prompt", args: { message: "继续", cid: "k1" }, dedupeKey: "p1" });
  const ack = await v.take((f) => f.type === "ack" && f.id === "p1", "prompt ack");
  assert.equal(ack.ok, true, JSON.stringify(ack));
  assert.equal(sentToPi.at(-1).content, "继续");
  const echo = await v.take((f) => f.type === "room_event" && f.event.type === "remote_message", "回显");
  assert.equal(echo.event.cid, "k1");

  // pi 真正开始处理这条 user 消息
  bridge.forward({ type: "message_start", message: { role: "user", content: "继续", timestamp: Date.now() } });
  const delivered = await v.take((f) => f.type === "room_event" && f.event.type === "remote_message_delivered", "送达确认");
  assert.equal(delivered.event.cid, "k1");
  v.ws.close();
});

test("同文本两条：一条失败按 cid 摘回显，另一条被 pi 的 user 消息取代；重新订阅后历史里只剩真实消息", async () => {
  const v = viewer();
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4", "msg.cid"] });
  const auth = await v.take((f) => f.type === "auth_result" && f.ok, "鉴权");
  assert.ok(auth.caps.includes("msg.cid"), "relay 声明了 msg.cid");
  v.send({ type: "subscribe", room: ROOM });
  await v.take((f) => f.type === "subscribed", "订阅");

  v.send({ type: "command", id: "bad", room: ROOM, command: "prompt", args: { message: "x", cid: "has space" }, dedupeKey: "bad" });
  const bad = await v.take((f) => f.type === "ack" && f.id === "bad", "坏 cid");
  assert.deepEqual([bad.ok, bad.code], [false, "bad_args"], "relay 入口拒绝不合法 cid");

  v.send({ type: "command", id: "x1", room: ROOM, command: "prompt", args: { message: "好", cid: "x1" }, dedupeKey: "x1" });
  v.send({ type: "command", id: "x2", room: ROOM, command: "prompt", args: { message: "好", cid: "x2" }, dedupeKey: "x2" });
  await v.take((f) => f.type === "ack" && f.id === "x2", "第二条受理");
  await v.take((f) => f.type === "room_event" && f.event.type === "remote_message" && f.event.cid === "x2", "第二条回显");

  // 第一条没进 pi（比如被别的扩展拦下）：扩展按 cid 报失败
  const pending = bridge.pendingDeliveries.find((p) => p.cid === "x1");
  bridge.dropDeliveryEntry(pending);
  bridge.failRemote("好", "被拦下", null, "x1", "busy");
  const failed = await v.take((f) => f.type === "room_event" && f.event.type === "remote_message_failed", "失败事件");
  assert.deepEqual([failed.event.cid, failed.event.code], ["x1", "busy"]);

  // 第二条真的进了 pi
  bridge.forward({ type: "message_start", message: { role: "user", content: "好", timestamp: Date.now() } });
  bridge.forward({ type: "message_end", message: { role: "user", content: "好", timestamp: Date.now() } });
  await v.take((f) => f.type === "room_event" && f.event.type === "remote_message_delivered" && f.event.cid === "x2", "第二条送达");
  await v.take((f) => f.type === "room_event" && f.event.type === "message_end", "user message_end");
  v.ws.close();

  const fresh = viewer();
  await fresh.opened;
  fresh.send({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4", "msg.cid"] });
  await fresh.take((f) => f.type === "auth_result" && f.ok, "鉴权");
  fresh.send({ type: "subscribe", room: ROOM });
  const snap = await fresh.take((f) => f.type === "snapshot", "快照");
  const goods = snap.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes("好"));
  assert.equal(goods.length, 1, "历史里只有 pi 的那条真实 user 消息：" + JSON.stringify(goods));
  assert.equal(goods[0].remote, undefined, "不是回显");
  fresh.ws.close();
});

test("配对全流程：网页要配对码 → 真 attach 配对拿令牌 → 用令牌上线（名册显示已配对）→ 冒充别的设备被拒 → 撤销后断开、再连被拒", async () => {
  const attach = require("../deploy/attach.cjs");
  const v = viewer();
  await v.opened;
  v.send({ type: "auth", role: "viewer", token: "vt", proto: 4, caps: ["err.v4", "msg.cid", "device.token"] });
  const auth = await v.take((f) => f.type === "auth_result" && f.ok, "鉴权");
  assert.ok(auth.caps.includes("device.token"));

  v.send({ type: "pair_create", id: "pc1", name: "书房 Mac", adminToken: ADMIN_TOKEN });
  const created = await v.take((f) => f.type === "ack" && f.id === "pc1", "配对码");
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.data.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const relayUrl = `ws://127.0.0.1:${relay.localPort}`;
  const paired = await attach.requestPairing({ relay: relayUrl, code: attach.normalizePairCode(created.data.code), deviceName: "书房 Mac", platform: "darwin" });
  assert.equal(paired.ok, true, JSON.stringify(paired));
  assert.ok(paired.deviceId && paired.deviceToken.length >= 40);
  const reuse = await attach.requestPairing({ relay: relayUrl, code: attach.normalizePairCode(created.data.code), platform: "darwin" });
  assert.deepEqual([reuse.ok, reuse.code], [false, "pair_invalid"], "配对码只能用一次");

  const exits = [];
  const ctl = new attach.AttachController({
    platform: "darwin",
    relay: relayUrl,
    deviceId: paired.deviceId,
    deviceToken: paired.deviceToken,
    deviceName: "书房 Mac",
    projects: [tmp],
    attachFile: path.join(tmp, "pair-attach.json"),
    exit: (code) => exits.push(code),
    writeOut: () => {},
    status: false,
    spawnImpl: () => ({ unref() {}, on() {} }),
  });
  ctl.start();
  await until(() => ctl.authed, 3000, "attach 令牌鉴权");
  assert.equal(ctl.authMode, "token");
  const listed = await v.take((f) => f.type === "room_list" && (f.devices || []).some((d) => d.id === paired.deviceId && d.online), "名册");
  const dev = listed.devices.find((d) => d.id === paired.deviceId);
  assert.deepEqual([dev.auth, dev.paired, dev.platform], ["token", true, "macos"]);

  // 拿这台的令牌冒充别的设备
  const imp = new WebSocket(relayUrl);
  const impFrames = [];
  imp.on("message", (d) => impFrames.push(JSON.parse(String(d))));
  await new Promise((r) => imp.once("open", r));
  imp.send(JSON.stringify(attach.attachAuthFrame({ deviceId: "dev-int", deviceToken: paired.deviceToken, platform: "darwin" })));
  await until(() => impFrames.some((f) => f.type === "auth_result"), 3000, "冒充结果");
  const impAuth = impFrames.find((f) => f.type === "auth_result");
  assert.deepEqual([impAuth.ok, impAuth.code], [false, "device_mismatch"]);
  imp.terminate();

  v.send({ type: "device_revoke", id: "rv1", deviceId: paired.deviceId, adminToken: ADMIN_TOKEN });
  const revoked = await v.take((f) => f.type === "ack" && f.id === "rv1", "撤销");
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  await until(() => !ctl.authed, 3000, "撤销后断开");
  await until(() => exits.length > 0, 5000, "重连被拒后 attach 退出");
  assert.deepEqual(exits, [1], "令牌已撤销：attach 以退出码 1 结束并提示重新配对");
  ctl.shutdown();
  v.ws.close();
});
