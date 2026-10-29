// 扩展的协议 v4：鉴权帧、按 relay 能力启用、命令失败带错误码、消息 cid 贯穿（回显 / 送达 / 失败）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

process.env.PI_REMOTE_LOG = path.join(os.tmpdir(), "pi-remote-extension-v4-test.log");
process.env.PI_REMOTE_TOKEN = "";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname);
const proto = (await import("../protocol/v4.json", { with: { type: "json" } })).default;

function wired() {
  const sent = [];
  const bridge = new ext.Bridge();
  bridge.connected = true;
  bridge.authed = true; // business sends are gated on auth_result ok; simulate an authenticated connection
  bridge.roomId = "r1";
  bridge.ws = { bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} };
  const delivered = [];
  bridge.pi = { sendUserMessage: (content, opts) => delivered.push({ content, opts }) };
  bridge.ctx = { isIdle: () => true, model: { id: "m" } };
  return { bridge, sent, delivered };
}

const events = (sent, type) => sent.filter((f) => f.type === "event" && f.event.type === type).map((f) => f.event);

function quiet(bridge) {
  for (const p of bridge.pendingDeliveries || []) clearTimeout(p.timer);
  for (const key of ["syncTimer", "manifestTimer", "probeTimer", "reconnectTimer", "coalesceTimer"]) {
    if (bridge[key]) clearTimeout(bridge[key]);
    bridge[key] = null;
  }
}

test("鉴权帧：带 proto/caps/client；有设备令牌就带上，共享 token 照带（旧 relay 只认它）", () => {
  const f = ext.authFrame({ PI_REMOTE_TOKEN: "lt", PI_REMOTE_DEVICE_ID: "dev-1", PI_REMOTE_DEVICE_TOKEN: "dt" }, "darwin");
  assert.equal(f.type, "auth");
  assert.equal(f.role, "local");
  assert.equal(f.proto, proto.proto);
  assert.deepEqual(f.caps, ext.CLIENT_CAPS);
  for (const cap of f.caps) assert.ok(cap in proto.caps, "能力必须登记在 protocol/v4.json：" + cap);
  assert.deepEqual(f.client, { kind: "extension", version: "4.0.0", platform: "macos" });
  assert.equal(f.deviceId, "dev-1");
  assert.equal(f.deviceToken, "dt");
  assert.equal(f.token, "lt");
  const legacy = ext.authFrame({ PI_REMOTE_TOKEN: "lt", PI_REMOTE_DEVICE_ID: "dev-1" }, "win32");
  assert.equal("deviceToken" in legacy, false, "只有编号没有令牌：不带设备鉴权字段");
  assert.equal(legacy.client.platform, "windows");
  const tokenOnly = ext.authFrame({ PI_REMOTE_DEVICE_ID: "dev-1", PI_REMOTE_DEVICE_TOKEN: "dt" }, "darwin");
  assert.equal("token" in tokenOnly, false, "没配共享 token 就不发空串");
});

test("relay 声明能力就不再猜：sync.v3 直接启用、没有 room.label 就用整包改名；旧 relay 保留猜测", () => {
  const { bridge } = wired();
  bridge.applyRelayCaps({ ok: true, proto: 4, caps: ["sync.v3", "room.label"], auth: "token" });
  assert.equal(bridge.relayV3, true);
  assert.equal(bridge.noRoomLabel, false);
  assert.equal(bridge.relayAuth, "token");
  bridge.applyRelayCaps({ ok: true, proto: 4, caps: ["sync.v3"] });
  assert.equal(bridge.noRoomLabel, true);
  bridge.relayV3 = false;
  bridge.noRoomLabel = false;
  bridge.applyRelayCaps({ ok: true, boot: "b" });
  assert.equal(bridge.relayCaps, null, "旧 relay 不带 caps");
  assert.equal(bridge.relayV3, false, "旧 relay 仍等 room_registered 再判断");
  assert.equal(bridge.noRoomLabel, false);
  quiet(bridge);
});

test("设备令牌被撤销：停止重连并提示重新配对", () => {
  const { bridge } = wired();
  bridge.handle({ type: "auth_result", ok: false, code: "device_revoked", error: "这台设备已被撤销" });
  assert.equal(bridge.authFailed, true);
  quiet(bridge);
});

test("可重试的鉴权失败不永久停连：按 retryable/码表继续退避重连，不可重试才停", () => {
  // 码表说 rate_limited 可重试（relay 没显式带 retryable 也认）
  const a = wired();
  a.bridge.gateOpen = () => true;
  a.bridge.backoff = 4000;
  a.bridge.handle({ type: "auth_result", ok: false, code: "rate_limited", error: "请求太频繁" });
  assert.equal(a.bridge.authed, false);
  assert.equal(a.bridge.authFailed, false, "可重试错误不能永久停连");
  assert.equal(a.bridge.ws, null, "旧 socket 先摘掉");
  assert.equal(a.bridge.backoff, 8000, "按原退避翻倍，没有被 onopen 重置");
  assert.ok(a.bridge.reconnectTimer, "已安排退避重连");
  quiet(a.bridge);

  // relay 显式 retryable:true 优先，即使码表是 false
  const b = wired();
  b.bridge.gateOpen = () => true;
  b.bridge.backoff = 2000;
  b.bridge.handle({ type: "auth_result", ok: false, code: "auth_failed", retryable: true, error: "暂时不可用" });
  assert.equal(b.bridge.authFailed, false);
  assert.equal(b.bridge.backoff, 4000);
  assert.ok(b.bridge.reconnectTimer);
  quiet(b.bridge);

  // 显式 retryable:false 优先，即使码表是 true → 仍然停连
  const c = wired();
  c.bridge.gateOpen = () => true;
  c.bridge.handle({ type: "auth_result", ok: false, code: "rate_limited", retryable: false, error: "别再试了" });
  assert.equal(c.bridge.authFailed, true);
  assert.equal(c.bridge.reconnectTimer, null);
  quiet(c.bridge);
});

test("退避只在 auth_result.ok 后清零；成功后清掉旧的 authFailed", () => {
  const { bridge } = wired();
  bridge.backoff = 16000;
  bridge.authFailed = true;
  bridge.handle({ type: "auth_result", ok: true, proto: 4, caps: ["sync.v3"] });
  assert.equal(bridge.authFailed, false);
  assert.equal(bridge.backoff, 1000);
  quiet(bridge);
});

test("命令失败一律带错误码：未知命令、缺参数、会话已切换", async () => {
  const { bridge, sent } = wired();
  bridge.runCommand({ id: "c1", command: "no_such_command", args: {} });
  bridge.runCommand({ id: "c2", command: "set_model", args: {} });
  bridge.runCommand({ id: "c3", room: "other-room", command: "get_state", args: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const byId = Object.fromEntries(sent.filter((f) => f.type === "command_result").map((f) => [f.id, f]));
  assert.equal(byId.c1.ok, false);
  assert.equal(byId.c1.code, "unknown_command");
  assert.equal(byId.c2.code, "bad_args");
  assert.equal(byId.c3.code, "session_switched");
  for (const f of Object.values(byId)) assert.ok(f.code in proto.errors, f.code);
  assert.equal(ext.remoteErrorCode(new Error("x")), "internal");
  assert.equal(ext.remoteErrorCode(Object.assign(new Error("x"), { code: "ENOENT" })), "internal", "系统错误码不算协议码");
  assert.equal(new ext.RemoteError("nope").code, "internal");
  assert.equal(new ext.RemoteError("busy").message, proto.errors.busy.message, "没给文案用码表默认文案");
  quiet(bridge);
});

test("cid：回显带 cid；同文本两条在等时按先进先出确认，各自回 remote_message_delivered", async () => {
  const { bridge, sent, delivered } = wired();
  await bridge.executeCommand("prompt", { message: "继续", cid: "a1" });
  await bridge.executeCommand("prompt", { message: "继续", cid: "a2" });
  assert.equal(delivered.length, 2);
  assert.deepEqual(events(sent, "remote_message").map((e) => e.cid), ["a1", "a2"]);
  bridge.trackDelivery({ type: "message_start", message: { role: "user", content: "继续" } });
  assert.deepEqual(events(sent, "remote_message_delivered").map((e) => e.cid), ["a1"]);
  bridge.trackDelivery({ type: "message_start", message: { role: "user", content: "继续" } });
  assert.deepEqual(events(sent, "remote_message_delivered").map((e) => e.cid), ["a1", "a2"]);
  assert.equal(bridge.pendingDeliveries.length, 0);
  quiet(bridge);
});

test("资源命令注入：只对明确选中的命令传 expandPromptTemplates；普通 / 正文不展开、照常回显与等送达", async () => {
  const { bridge, sent, delivered } = wired();
  bridge.pi.getCommands = () => [
    { name: "review", source: "prompt" },
    { name: "deploy", source: "extension" },
  ];
  try {
    const data = await bridge.executeCommand("prompt", { message: "/review $1 $@ ${1:-默认} \"a b\"", cid: "cmd-1", expandPromptTemplates: true });
    assert.deepEqual(data, { disposition: "started", expanded: true });
    assert.deepEqual(delivered[0].opts, { deliverAs: "steer", expandPromptTemplates: true }, "模板/技能展开交给 pi");
    assert.equal(events(sent, "remote_message").length, 0, "命令注入不回显命令原文，避免幽灵气泡");
    assert.equal(bridge.pendingDeliveries.length, 0, "展开后正文会变，不能按原文等送达");

    // 普通正文即使以 / 开头也不打开展开：走原来的回显 + 送达观察。
    await bridge.executeCommand("prompt", { message: "/这不是命令 只是正文", cid: "plain-1" });
    assert.deepEqual(delivered[1].opts, { deliverAs: "steer" }, "普通消息没有 expandPromptTemplates");
    assert.deepEqual(events(sent, "remote_message").map((e) => e.cid), ["plain-1"]);
    assert.equal(bridge.pendingDeliveries.length, 1);

    // 明确要执行但清单里没有：报错，不把原文当普通消息发出去。
    await assert.rejects(
      bridge.executeCommand("prompt", { message: "/gone", expandPromptTemplates: true }),
      (e) => e.code === "not_found" && /没有可执行/.test(e.message),
    );
    assert.equal(delivered.length, 2, "未知命令没有注入");
  } finally {
    quiet(bridge);
  }
});

test("资源命令注入：扩展命令不经过模型检查；模板在没模型时仍明确失败", async () => {
  const { bridge, delivered } = wired();
  bridge.pi.getCommands = () => [
    { name: "review", source: "prompt" },
    { name: "deploy", source: "extension" },
  ];
  bridge.ctx.model = null;
  try {
    await bridge.executeCommand("prompt", { message: "/deploy", expandPromptTemplates: true });
    assert.equal(delivered.length, 1, "扩展命令先于模型检查执行");
    await assert.rejects(
      bridge.executeCommand("prompt", { message: "/review 改动", expandPromptTemplates: true }),
      (e) => e.code === "no_model",
    );
    assert.equal(delivered.length, 1, "模板没有模型时不注入");
  } finally {
    quiet(bridge);
  }
});

test("cid 不合法就当没有：不回显 cid，也不发送达确认", async () => {
  const { bridge, sent } = wired();
  await bridge.executeCommand("prompt", { message: "hi", cid: "has space" });
  await bridge.executeCommand("prompt", { message: "hi2", cid: "x".repeat(65) });
  assert.deepEqual(events(sent, "remote_message").map((e) => "cid" in e), [false, false]);
  bridge.trackDelivery({ type: "message_start", message: { role: "user", content: "hi" } });
  assert.equal(events(sent, "remote_message_delivered").length, 0);
  quiet(bridge);
});

test("注入失败：回显已发出时只报一次失败，带 cid 和错误码；命令回包同样带码", async () => {
  const { bridge, sent } = wired();
  bridge.pi.sendUserMessage = () => {
    throw new Error("stale extension context");
  };
  bridge.runCommand({ id: "p1", command: "prompt", args: { message: "做这个", cid: "f1" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = events(sent, "remote_message_failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].cid, "f1");
  assert.equal(failed[0].code, "session_switched");
  const result = sent.find((f) => f.type === "command_result" && f.id === "p1");
  assert.equal(result.ok, false);
  assert.equal(result.code, "session_switched");

  bridge.handle({ type: "message", room: "r1", text: "快捷帧", cid: "q1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = events(sent, "remote_message_failed");
  assert.equal(again.length, 2, "快捷帧注入失败也只报一次");
  assert.equal(again[1].cid, "q1");
  quiet(bridge);
});

test("压缩中、没选模型：注入前就拦下，错误码分别是 compacting / no_model", async () => {
  const { bridge, sent } = wired();
  bridge.compacting = true;
  await assert.rejects(bridge.executeCommand("prompt", { message: "a" }), (e) => e.code === "compacting");
  bridge.compacting = false;
  bridge.ctx.model = null;
  await assert.rejects(bridge.executeCommand("prompt", { message: "a" }), (e) => e.code === "no_model");
  assert.equal(events(sent, "remote_message").length, 0, "拦下的消息不回显");
  quiet(bridge);
});

test("会话已切换时发往旧房间的快捷注入：顶层 remote_message_failed 带 cid 与码", () => {
  const { bridge, sent } = wired();
  bridge.handle({ type: "message", room: "old-room", text: "晚了", cid: "s1" });
  const top = sent.find((f) => f.type === "remote_message_failed");
  assert.equal(top.room, "old-room");
  assert.equal(top.cid, "s1");
  assert.equal(top.code, "session_switched");
  quiet(bridge);
});

/** 中断前记下输入框，abort 里把待发标志和输入框改成返回后的样子。 */
function armAbortEditor(bridge, { before, after, pendingBefore = true, pendingAfter = false, hasUI = true }) {
  let pending = pendingBefore;
  const editor = { text: before };
  const sets = [];
  bridge.ctx = {
    hasUI,
    model: { id: "m" },
    isIdle: () => true,
    hasPendingMessages: () => pending,
    abort() {
      pending = pendingAfter;
      editor.text = after;
    },
    ui: {
      getEditorText: () => editor.text,
      setEditorText: (text) => { sets.push(text); editor.text = text; },
    },
  };
  return { editor, sets };
}

test("超过 8000 字的排队停止时按全文交回，网页 queue_update 仍只带前 8000 字", () => {
  const { bridge, sent } = wired();
  try {
    const full = "甲".repeat(8000) + "尾";
    assert.equal(full.length, 8001);
    bridge.watchDelivery(full, "long-1");
    bridge.noteQueuedInput({ text: full, streamingBehavior: "steer" });
    assert.equal(bridge.steeringQueue[0], full, "待发镜像留完整正文");
    const queued = events(sent, "queue_update");
    assert.equal(queued.length, 1);
    assert.equal(queued[0].steering[0].content, full.slice(0, 8000));
    assert.equal(queued[0].steering[0].content.endsWith("尾"), false);
    assert.deepEqual(queued[0].followUp, []);

    const { editor, sets } = armAbortEditor(bridge, { before: "", after: full });
    bridge.handle({ type: "abort" });
    assert.deepEqual(sets, [""], "输入框设回中断前的空草稿");
    assert.equal(editor.text, "");
    const failed = events(sent, "remote_message_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].text, full);
    assert.equal(failed[0].error, "已停止，这条排队消息没有送进会话");
    assert.equal(failed[0].code, "aborted");
    assert.equal(failed[0].cid, "long-1");
    const afterQueues = events(sent, "queue_update");
    assert.equal(afterQueues.length, 2);
    assert.deepEqual(afterQueues[1], { type: "queue_update", steering: [], followUp: [] });
    assert.deepEqual(bridge.steeringQueue, []);
    assert.deepEqual(bridge.followUpQueue, []);
    assert.equal(bridge.pendingDeliveries.length, 0);
  } finally {
    quiet(bridge);
  }
});

test("8000 字以内的排队停止交回保持不变", () => {
  const { bridge, sent } = wired();
  try {
    const full = "乙".repeat(8000);
    bridge.watchDelivery(full, "edge-8k");
    bridge.noteQueuedInput({ text: full, streamingBehavior: "steer" });
    assert.equal(events(sent, "queue_update")[0].steering[0].content, full);
    const { sets } = armAbortEditor(bridge, { before: "草稿", after: full + "\n\n草稿" });
    bridge.handle({ type: "abort" });
    assert.deepEqual(sets, ["草稿"]);
    const failed = events(sent, "remote_message_failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].text, full);
    assert.equal(failed[0].error, "已停止，这条排队消息没有送进会话");
    assert.equal(failed[0].code, "aborted");
    assert.deepEqual(events(sent, "queue_update")[1], { type: "queue_update", steering: [], followUp: [] });
  } finally {
    quiet(bridge);
  }
});

test("停止交回对不上、仍有待发、没有 UI，或没有待发时，不改输入框也不多发失败帧", () => {
  const full = "甲".repeat(8000) + "尾";

  const prefix = wired();
  try {
    prefix.bridge.watchDelivery(full, "pre-1");
    prefix.bridge.noteQueuedInput({ text: full, streamingBehavior: "steer" });
    const { sets } = armAbortEditor(prefix.bridge, { before: "", after: full.slice(0, 8000) });
    prefix.bridge.handle({ type: "abort" });
    assert.deepEqual(sets, [], "输入框只有前 8000 字时不交回");
    assert.equal(events(prefix.sent, "remote_message_failed").length, 0);
    assert.equal(prefix.bridge.steeringQueue[0], full);
  } finally {
    quiet(prefix.bridge);
  }

  const still = wired();
  try {
    still.bridge.watchDelivery(full, "still-1");
    still.bridge.noteQueuedInput({ text: full, streamingBehavior: "steer" });
    const { sets } = armAbortEditor(still.bridge, { before: "", after: full, pendingAfter: true });
    still.bridge.handle({ type: "abort" });
    assert.deepEqual(sets, []);
    assert.equal(events(still.sent, "remote_message_failed").length, 0);
  } finally {
    quiet(still.bridge);
  }

  const noUi = wired();
  try {
    noUi.bridge.watchDelivery(full, "noui-1");
    noUi.bridge.noteQueuedInput({ text: full, streamingBehavior: "steer" });
    const { sets } = armAbortEditor(noUi.bridge, { before: "", after: full, hasUI: false });
    noUi.bridge.handle({ type: "abort" });
    assert.deepEqual(sets, []);
    assert.equal(events(noUi.sent, "remote_message_failed").length, 0);
  } finally {
    quiet(noUi.bridge);
  }

  const none = wired();
  try {
    none.bridge.watchDelivery("短", "none-1");
    none.bridge.noteQueuedInput({ text: "短", streamingBehavior: "steer" });
    const queues = events(none.sent, "queue_update").length;
    const failed = events(none.sent, "remote_message_failed").length;
    const { sets } = armAbortEditor(none.bridge, { before: "", after: "短", pendingBefore: false, pendingAfter: false });
    none.bridge.handle({ type: "abort" });
    assert.deepEqual(sets, []);
    assert.equal(events(none.sent, "queue_update").length, queues);
    assert.equal(events(none.sent, "remote_message_failed").length, failed);
  } finally {
    quiet(none.bridge);
  }
});

/* ---------- P1 §6：远程自管待发缓冲（排队可改可撤） ---------- */

function wiredBusy() {
  const sent = [];
  const delivered = [];
  const bridge = new ext.Bridge();
  bridge.connected = true;
  bridge.authed = true;
  bridge.roomId = "r1";
  bridge.ws = { bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} };
  let idle = false;
  bridge.pi = {
    sendUserMessage: (content, opts) => {
      delivered.push({ content, opts });
      return Promise.resolve();
    },
  };
  bridge.ctx = {
    isIdle: () => idle,
    model: { id: "m" },
    hasPendingMessages: () => false,
    abort: () => { idle = true; return Promise.resolve(); },
  };
  return { bridge, sent, delivered, setIdle: (value) => { idle = value; } };
}

const queueStates = (sent) => events(sent, "remote_queue_state");
const lastQueue = (sent) => {
  const all = queueStates(sent);
  return all[all.length - 1];
};

test("远程缓冲：忙时按顺序入队，带稳定 id/段位/来源/状态；空闲发送仍立即注入", async () => {
  const { bridge, sent, delivered } = wiredBusy();
  try {
    const first = await bridge.cmdSendLike("steer", { message: "一", cid: "c1" });
    const second = await bridge.cmdSendLike("follow_up", { message: "二", cid: "c2" });
    const third = await bridge.cmdSendLike("steer", { message: "三", cid: "c3" });
    assert.equal(first.disposition, "queued");
    assert.equal(second.disposition, "queued");
    assert.equal(third.disposition, "queued");
    assert.equal(delivered.length, 0, "忙时不直接交给 pi");
    const items = lastQueue(sent).items;
    assert.deepEqual(items.map((item) => item.segment), ["steer", "follow_up", "steer"]);
    assert.deepEqual(items.map((item) => item.text), ["一", "二", "三"]);
    assert.equal(new Set(items.map((item) => item.id)).size, 3, "id 稳定且唯一");
    for (const item of items) {
      assert.match(item.id, /^rq_[0-9a-f]{12}$/);
      assert.equal(item.source, "web");
      assert.equal(item.status, "pending");
      assert.deepEqual(item.images, []);
    }
    assert.deepEqual(items.map((item) => item.cid), ["c1", "c2", "c3"]);
    assert.deepEqual(lastQueue(sent).items.map((item) => item.id), [bridge.remoteQueue[0].id, bridge.remoteQueue[1].id, bridge.remoteQueue[2].id]);

    // 空闲且没有待发：走原来的立即注入，不产生缓冲条目
    bridge.ctx.isIdle = () => true;
    const direct = await bridge.cmdSendLike("steer", { message: "直接发" });
    assert.equal(direct.disposition, "started");
    // 空闲后先按序放行积压的 3 条，再注入新消息；新消息不新增缓冲条目
    assert.deepEqual(delivered.map((item) => item.content), ["一", "二", "三", "直接发"]);
    assert.equal(bridge.remoteQueue.length, 3);
    assert.equal(bridge.remoteQueue.every((item) => item.status === "injected"), true);
    assert.equal(events(sent, "remote_message").at(-1).text, "直接发");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：编辑保位次、取消只删 pending，queue_get 返回最新快照", () => {
  const { bridge, sent } = wiredBusy();
  try {
    const ids = ["a", "b", "c"].map((text) => bridge.enqueueRemoteMessage("steer", text, [], text));
    const queueId = ids.map((item) => item.id);
    const edited = bridge.cmdQueueEdit({ id: queueId[1], text: "第二改" });
    assert.equal(edited.ok, true);
    assert.equal(edited.item.text, "第二改");
    assert.deepEqual(bridge.remoteQueue.map((item) => item.id), queueId, "编辑不改变数组位次");
    assert.equal(bridge.remoteQueue[1].text, "第二改");
    assert.equal(bridge.cmdQueueGet().items[1].text, "第二改");
    assert.equal(lastQueue(sent).items[1].text, "第二改");

    const cancelled = bridge.cmdQueueCancel({ id: queueId[0] });
    assert.equal(cancelled.ok, true);
    assert.deepEqual(bridge.remoteQueue.map((item) => item.id), [queueId[1], queueId[2]]);
    assert.deepEqual(bridge.cmdQueueGet().items.map((item) => item.text), ["第二改", "c"]);

    assert.throws(() => bridge.cmdQueueEdit({ id: "missing", text: "x" }), (e) => e.code === "not_found");
    assert.throws(() => bridge.cmdQueueCancel({ id: "missing" }), (e) => e.code === "not_found");
    assert.throws(() => bridge.cmdQueueEdit({ id: queueId[1], text: "  " }), (e) => e.code === "bad_args");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：queue_send 立即发送 pending，follow_up 也按 steer 立即送达", async () => {
  const { bridge, delivered } = wiredBusy();
  try {
    const { queueId } = await bridge.cmdSendLike("follow_up", { message: "立即", cid: "cnow" });
    const res = await bridge.cmdQueueSend({ id: queueId });
    assert.equal(res.ok, true);
    assert.equal(res.item.status, "injected");
    assert.deepEqual(delivered.map((item) => item.content), ["立即"]);
    assert.equal(bridge.remoteQueue.find((item) => item.id === queueId).status, "injected");
    await assert.rejects(() => bridge.cmdQueueSend({ id: queueId }), (e) => e.code === "queue_locked");
    await assert.rejects(() => bridge.cmdQueueSend({ id: "missing" }), (e) => e.code === "not_found");

    // interrupt:false 只做 steer 插入，不 abort 当前操作。
    const steer = bridge.enqueueRemoteMessage("steer", "等工具", [], "csteer");
    let aborted = false;
    bridge.ctx.abort = () => { aborted = true; return Promise.resolve(); };
    const steerRes = await bridge.cmdQueueSend({ id: steer.id, interrupt: false });
    assert.equal(steerRes.item.status, "injected");
    assert.equal(aborted, false, "等工具结束模式不得 abort");
    assert.deepEqual(delivered.map((item) => item.content), ["立即", "等工具"]);
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：turn_end 只注 steer，agent_settled 再按序注 follow_up；注入后不可改", async () => {
  const { bridge, sent, delivered, setIdle } = wiredBusy();
  try {
    const a = await bridge.cmdSendLike("steer", { message: "A", cid: "ca" });
    const b = await bridge.cmdSendLike("follow_up", { message: "B", cid: "cb" });
    const c = await bridge.cmdSendLike("steer", { message: "C", cid: "cc" });
    bridge.forward({ type: "turn_end", message: { role: "assistant", content: [] } });
    assert.deepEqual(delivered.map((item) => item.content), ["A"], "turn_end 只放行 steer，遇到 follow_up 停住保序");
    assert.deepEqual(bridge.remoteQueue.map((item) => item.status), ["injected", "pending", "pending"]);
    assert.equal(lastQueue(sent).items[0].status, "injected");
    assert.ok(lastQueue(sent).items[0].injectedAt);

    setIdle(true);
    bridge.forward({ type: "agent_settled" });
    assert.deepEqual(delivered.map((item) => item.content), ["A", "B", "C"], "settle 按入队顺序注入");
    assert.deepEqual(bridge.remoteQueue.map((item) => item.status), ["injected", "injected", "injected"]);
    assert.deepEqual(lastQueue(sent).items.map((item) => item.status), ["injected", "injected", "injected"]);
    assert.throws(() => bridge.cmdQueueEdit({ id: a.queueId, text: "x" }), (e) => e.code === "queue_locked");
    assert.throws(() => bridge.cmdQueueCancel({ id: b.queueId }), (e) => e.code === "queue_locked");
    assert.throws(() => bridge.cmdQueueEdit({ id: c.queueId, text: "x" }), (e) => e.code === "queue_locked");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：注入失败标 failed 并广播；queue_get 能看到失败原因，终态不可改", async () => {
  const { bridge, sent, setIdle } = wiredBusy();
  try {
    bridge.pi.sendUserMessage = () => Promise.reject(new Error("模型不可用"));
    const { queueId } = await bridge.cmdSendLike("steer", { message: "会失败", cid: "cf" });
    setIdle(true);
    bridge.forward({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const item = bridge.cmdQueueGet().items.find((entry) => entry.id === queueId);
    assert.equal(item.status, "failed");
    assert.equal(item.error, "模型不可用");
    assert.equal(item.code, "internal");
    assert.equal(lastQueue(sent).items.find((entry) => entry.id === queueId).status, "failed");
    const failed = events(sent, "remote_message_failed");
    assert.ok(failed.some((event) => event.cid === "cf" && event.text === "会失败"));
    assert.throws(() => bridge.cmdQueueEdit({ id: queueId, text: "改不了" }), (e) => e.code === "queue_locked");
    assert.throws(() => bridge.cmdQueueCancel({ id: queueId }), (e) => e.code === "queue_locked");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：停止会把未注入条目整批标失败，agent_settled 不再自动注入", async () => {
  const { bridge, sent, delivered, setIdle } = wiredBusy();
  try {
    const one = await bridge.cmdSendLike("steer", { message: "甲", cid: "s1" });
    const two = await bridge.cmdSendLike("follow_up", { message: "乙", cid: "s2" });
    bridge.ctx.abort = () => { setIdle(true); };
    await bridge.cmdAbort();
    assert.equal(delivered.length, 0, "停止后不注入");
    assert.deepEqual(bridge.remoteQueue.map((item) => item.status), ["failed", "failed"]);
    assert.deepEqual(bridge.remoteQueue.map((item) => item.code), ["aborted", "aborted"]);
    assert.ok(events(sent, "remote_message_failed").some((event) => event.cid === "s1"));
    bridge.forward({ type: "agent_settled" });
    assert.equal(delivered.length, 0);
    assert.equal(bridge.cmdQueueGet().items.every((item) => item.status === "failed"), true);
    assert.equal(one.queueId !== two.queueId, true);
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：queue_get/edit/cancel 走命令面；坏 id / 已注入都带协议码", async () => {
  const { bridge, sent } = wiredBusy();
  try {
    const { queueId } = await bridge.cmdSendLike("steer", { message: "命令面", cid: "cq" });
    bridge.runCommand({ id: "q-edit", command: "queue_edit", args: { id: queueId, text: "命令面改" }, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.runCommand({ id: "q-get", command: "queue_get", args: {}, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const get = sent.find((frame) => frame.type === "command_result" && frame.id === "q-get");
    const edit = sent.find((frame) => frame.type === "command_result" && frame.id === "q-edit");
    assert.equal(edit.ok, true);
    assert.equal(get.ok, true);
    assert.equal(get.data.items[0].text, "命令面改");
    bridge.runCommand({ id: "q-bad", command: "queue_cancel", args: { id: "nope" }, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const bad = sent.find((frame) => frame.type === "command_result" && frame.id === "q-bad");
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "not_found");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：旧式 message 帧忙时也进缓冲，不绕过编辑窗口", async () => {
  const { bridge, delivered } = wiredBusy();
  try {
    bridge.handle({ type: "message", room: "r1", text: "旧客户端", cid: "legacy1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delivered.length, 0);
    assert.equal(bridge.remoteQueue.length, 1);
    assert.equal(bridge.remoteQueue[0].text, "旧客户端");
    assert.equal(bridge.remoteQueue[0].segment, "steer");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：多图随条目保存，编辑不清图，注入时仍走 content 数组", async () => {
  const { bridge, sent, delivered, setIdle } = wiredBusy();
  try {
    const { queueId } = await bridge.cmdSendLike("steer", {
      message: "带两张图",
      cid: "img1",
      images: [
        { data: "AAAA", mimeType: "image/png" },
        { data: "BBBB", mimeType: "image/jpeg" },
      ],
    });
    const item = bridge.cmdQueueGet().items.find((entry) => entry.id === queueId);
    assert.deepEqual(item.images, [
      { mimeType: "image/png", bytes: 3 },
      { mimeType: "image/jpeg", bytes: 3 },
    ]);
    bridge.cmdQueueEdit({ id: queueId, text: "带两张图（已改）" });
    assert.equal(bridge.cmdQueueGet().items[0].images.length, 2, "编辑正文不清空图片");
    setIdle(true);
    bridge.forward({ type: "agent_settled" });
    assert.equal(delivered.length, 1);
    assert.equal(Array.isArray(delivered[0].content), true);
    assert.deepEqual(delivered[0].content[0], { type: "text", text: "带两张图（已改）" });
    assert.equal(delivered[0].content.length, 3, "text + 2 images");
    assert.equal(delivered[0].content[1].type, "image");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲：状态帧正文不超过 4000 字、pending 上限 20（注入仍用全文）", async () => {
  const { bridge, sent } = wiredBusy();
  try {
    const longText = "长".repeat(5001);
    const { queueId } = await bridge.cmdSendLike("steer", { message: longText, cid: "long" });
    const item = bridge.cmdQueueGet().items.find((entry) => entry.id === queueId);
    assert.equal(item.text.length, 4000);
    assert.equal(lastQueue(sent).items[0].text.length, 4000);
    assert.equal(bridge.remoteQueue.find((entry) => entry.id === queueId).text.length, 5001, "扩展内存保留全文");
    for (let i = 0; i < 19; i += 1) await bridge.cmdSendLike("steer", { message: "第" + i + "条" });
    await assert.rejects(
      () => bridge.cmdSendLike("steer", { message: "第 21 条" }),
      (e) => e.code === "busy",
    );
    assert.equal(bridge.cmdQueueGet().items.length, 20);
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲（R3-3 防丢字）：截断投影带 truncated/textLen 标记，未截断不带；状态帧仍只带截断版", async () => {
  const { bridge, sent } = wiredBusy();
  try {
    const longText = "长".repeat(5001);
    const { queueId } = await bridge.cmdSendLike("steer", { message: longText, cid: "long2" });
    await bridge.cmdSendLike("steer", { message: "短消息", cid: "short" });
    const snap = bridge.cmdQueueGet();
    const long = snap.items.find((entry) => entry.id === queueId);
    assert.equal(long.text.length, 4000);
    assert.equal(long.truncated, true, "截断必须明示，不许静默");
    assert.equal(long.textLen, 5001);
    const frameItem = lastQueue(sent).items.find((entry) => entry.id === queueId);
    assert.equal(frameItem.truncated, true);
    assert.equal(frameItem.textLen, 5001);
    assert.equal(frameItem.text.length, 4000, "状态帧不因拉全文需求而膨胀");
    const short = snap.items.find((entry) => entry.cid === "short");
    assert.equal("truncated" in short, false);
    assert.equal("textLen" in short, false);
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲（R3-3 防丢字）：queue_get 按 id 拉全文；编辑改一处，扩展侧全文其余逐字无损", async () => {
  const { bridge } = wiredBusy();
  try {
    const longText = "头" + "身".repeat(5000) + "尾";
    const { queueId } = await bridge.cmdSendLike("steer", { message: longText, cid: "fulledit" });
    // 单条不带 full → 仍是投影形（带标记）
    const projected = bridge.cmdQueueGet({ id: queueId });
    assert.equal(projected.item.truncated, true);
    assert.equal(projected.item.text.length, 4000);
    // full → 全文回包
    const full = bridge.cmdQueueGet({ id: queueId, full: true });
    assert.equal(full.ok, true);
    assert.equal(full.item.text, longText);
    assert.equal(full.item.truncated, false);
    assert.equal(full.item.textLen, longText.length);
    // 模拟网页端：拿全文改中间一处保存 → 扩展内存除该处外逐字一致
    const edited = full.item.text.replace("身".repeat(100), "改".repeat(100));
    bridge.cmdQueueEdit({ id: queueId, text: edited });
    assert.equal(bridge.remoteQueue.find((entry) => entry.id === queueId).text, edited);
    assert.equal(edited.length, longText.length);
    // 坏 id：单条与 full 都报 not_found，不静默给整份快照冒充
    assert.throws(() => bridge.cmdQueueGet({ id: "nope" }), (e) => e.code === "not_found");
    assert.throws(() => bridge.cmdQueueGet({ id: "nope", full: true }), (e) => e.code === "not_found");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲（C-8 乐观并发）：queue_edit 带 baseHash 才校验；他端先改 → queue_conflict 且原文不动", async () => {
  const { bridge } = wiredBusy();
  try {
    const longText = "头" + "身".repeat(5000) + "尾";
    const { queueId } = await bridge.cmdSendLike("steer", { message: longText, cid: "conflict" });
    // 指纹恒带：状态帧投影、单条投影、full 回包三处同值（对全文算，与截断无关）
    const snapItem = bridge.cmdQueueGet().items.find((entry) => entry.id === queueId);
    const full = bridge.cmdQueueGet({ id: queueId, full: true });
    assert.match(snapItem.textHash, /^[0-9a-f]{8}$/);
    assert.equal(full.item.textHash, snapItem.textHash, "full 回包与状态帧指纹一致");
    const base = full.item.textHash;

    // 模拟他端先改：现值指纹已变，拿旧基线保存 → 明确冲突，扩展侧全文逐字不动
    bridge.cmdQueueEdit({ id: queueId, text: "他端先改" });
    assert.throws(
      () => bridge.cmdQueueEdit({ id: queueId, text: "我的旧稿覆盖", baseHash: base }),
      (e) => e.code === "queue_conflict" && /已被其他端修改/.test(e.message),
    );
    assert.equal(bridge.remoteQueue.find((entry) => entry.id === queueId).text, "他端先改", "冲突时不许无声覆盖");

    // 拿当前基线保存 → 成功，且指纹随之更新（旧基线随即失效）
    const current = bridge.cmdQueueGet({ id: queueId, full: true });
    const edited = bridge.cmdQueueEdit({ id: queueId, text: "基于最新稿的修改", baseHash: current.item.textHash });
    assert.equal(edited.ok, true);
    assert.notEqual(edited.item.textHash, current.item.textHash);
    assert.throws(
      () => bridge.cmdQueueEdit({ id: queueId, text: "再覆盖", baseHash: current.item.textHash }),
      (e) => e.code === "queue_conflict",
      "保存成功后旧基线必须失效",
    );

    // 不带 baseHash（老客户端）→ 不校验，照常保存（兼容口径）
    const legacy = bridge.cmdQueueEdit({ id: queueId, text: "老客户端保存" });
    assert.equal(legacy.ok, true);
    assert.equal(bridge.remoteQueue.find((entry) => entry.id === queueId).text, "老客户端保存");
  } finally {
    quiet(bridge);
  }
});

test("远程缓冲（R3-3 防丢字）：全文超过单条拉取上限 → payload_too_large 明示，快照不受影响", async () => {
  const { bridge } = wiredBusy();
  try {
    const huge = "长".repeat(400_000); // 1.2MB 字节 > 1MB 上限
    const item = bridge.enqueueRemoteMessage("steer", huge, [], "huge");
    assert.throws(
      () => bridge.cmdQueueGet({ id: item.id, full: true }),
      (e) => e.code === "payload_too_large" && /本机查看全文/.test(e.message),
      "过大必须明确失败，不许截断冒充全文",
    );
    const projected = bridge.cmdQueueGet({ id: item.id });
    assert.equal(projected.item.truncated, true);
    assert.equal(projected.item.textLen, huge.length);
    assert.equal(bridge.remoteQueue.find((entry) => entry.id === item.id).text, huge, "扩展内存仍是全文");
  } finally {
    quiet(bridge);
  }
});

test("fork 谱系（R3-3）：parseSessionFile 从文件头读 parentSession 并归一斜杠；无父为 null", () => {
  const { bridge } = wired();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lineage-"));
    const child = path.join(dir, "child.jsonl");
    fs.writeFileSync(
      child,
      JSON.stringify({ type: "session", id: "child1", timestamp: "2026-10-22T00:00:00.000Z", cwd: "/w", parentSession: "C:\\sessions\\parent.jsonl" }) +
        "\n" + JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-10-22T00:00:01.000Z", message: { role: "user", content: "hi" } }) + "\n",
      "utf8",
    );
    const row = bridge.parseSessionFile(child, null);
    assert.equal(row.parentSession, "C:/sessions/parent.jsonl");
    const plain = path.join(dir, "plain.jsonl");
    fs.writeFileSync(
      plain,
      JSON.stringify({ type: "session", id: "plain1", timestamp: "2026-10-22T00:00:00.000Z", cwd: "/w" }) + "\n",
      "utf8",
    );
    assert.equal(bridge.parseSessionFile(plain, null).parentSession, null);
  } finally {
    quiet(bridge);
  }
});

/* ---- B-1：onmessage 归属守卫（关窗/被取代后，在途帧不执行） ---- */

function installFakeWebSocket(t) {
  const prev = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.bufferedAmount = 0;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
    }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    close() { this.closed = true; this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    if (prev === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = prev;
  });
  return sockets;
}

function guardBridge(executed, injected) {
  const bridge = new ext.Bridge();
  bridge.closing = false;
  bridge.gateOpen = () => true;
  bridge.roomId = "";
  bridge.executeCommand = async (command) => { executed.push(command); return { ok: true }; };
  bridge.inject = async (text) => { injected.push(text); };
  return bridge;
}

const lateCommand = JSON.stringify({ type: "command", id: "late-1", command: "get_image", args: { entryId: "e", blockIndex: 0 } });
const lateMessage = JSON.stringify({ type: "message", text: "关窗后到达" });

test("B-1 连接窗口关闭：suspendConnection 摘掉全部回调，在途 command/message 不执行", async (t) => {
  const sockets = installFakeWebSocket(t);
  const executed = [];
  const injected = [];
  const bridge = guardBridge(executed, injected);
  try {
    bridge.connect();
    const ws = sockets[0];
    assert.ok(ws, "connect 应建立 socket");
    ws.onopen();
    assert.equal(bridge.ws, ws);
    const stale = ws.onmessage;
    assert.equal(typeof stale, "function");

    bridge.suspendConnection();
    assert.equal(bridge.ws, null);
    assert.equal(ws.onmessage, null, "suspendConnection 必须摘掉 onmessage");
    assert.equal(ws.onopen, null);
    assert.equal(ws.onclose, null);
    assert.equal(ws.onerror, null);

    // 即使底层仍把已捕获的回调投递进来，归属守卫也必须挡住
    stale({ data: lateCommand });
    stale({ data: lateMessage });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(executed, [], "关窗后的 command 帧不能执行");
    assert.deepEqual(injected, [], "关窗后的 message 帧不能注入");
  } finally {
    quiet(bridge);
  }
});

test("B-1 连接窗口关闭（evaluateGate）：旧 socket 摘回调，关窗后到达的帧不执行", async (t) => {
  const sockets = installFakeWebSocket(t);
  const executed = [];
  const injected = [];
  const bridge = guardBridge(executed, injected);
  try {
    bridge.connect();
    const ws = sockets[0];
    ws.onopen();
    const stale = ws.onmessage;
    bridge.gateOpen = () => false;
    bridge.evaluateGate("window-closed");
    assert.equal(bridge.ws, null);
    assert.equal(ws.onmessage, null);
    assert.equal(ws.onclose, null);
    stale({ data: lateCommand });
    stale({ data: lateMessage });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(executed, []);
    assert.deepEqual(injected, []);
  } finally {
    quiet(bridge);
  }
});

test("B-1 被新连接取代：旧 socket 在途帧不执行，新 socket 正常", async (t) => {
  const sockets = installFakeWebSocket(t);
  const executed = [];
  const injected = [];
  const bridge = guardBridge(executed, injected);
  try {
    bridge.connect();
    const oldWs = sockets[0];
    oldWs.onopen();
    const stale = oldWs.onmessage;

    bridge.connect();
    const fresh = sockets[1];
    assert.ok(fresh && fresh !== oldWs);
    fresh.onopen();
    assert.equal(bridge.ws, fresh);

    stale({ data: lateCommand });
    stale({ data: lateMessage });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(executed, [], "旧 socket 的 command 不能落到新连接");
    assert.deepEqual(injected, [], "旧 socket 的 message 不能落到新连接");

    fresh.onmessage({ data: JSON.stringify({ type: "command", id: "fresh-1", command: "get_image", args: {} }) });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(executed, ["get_image"], "新 socket 的命令正常执行");
    assert.ok(fresh.sent.some((frame) => frame.type === "command_result" && frame.id === "fresh-1"));
  } finally {
    quiet(bridge);
  }
});

/* ---- B-6：对话框桥协议（O1 登记能力位与错误码；O2 已落地接管应答，第 2 轮口径更新） ---- */

test("B-6 对话框应答：caps 登记 dialog.respond 且接管已实现，错误码 dialog_claimed/dialog_gone 在位", () => {
  assert.equal(typeof proto.caps["dialog.respond"], "string");
  assert.match(proto.caps["dialog.respond"], /接管/, "O2 已落地：描述写接管语义，不再是预留（随第 2 轮 R2-1 更新）");
  assert.equal(ext.CLIENT_CAPS.includes("dialog.respond"), true, "应答已实现，握手里真实声明");
  for (const code of ["dialog_claimed", "dialog_gone"]) {
    assert.ok(proto.errors[code], code);
    assert.equal(proto.errors[code].retryable, false, code + " 是不可重试的裁决失败");
  }
});

/* ---- Working 胶囊协议预留：agent.state 只登记能力位，当前无生产者 ---- */

test("agent.state 协议预留：caps 三处同步，扩展不冒充生产者", () => {
  assert.equal(typeof proto.caps["agent.state"], "string");
  assert.match(proto.caps["agent.state"], /agent_state/);
  assert.match(proto.caps["agent.state"], /预留/, "当前只登记能力位");
  const relayProto = JSON.parse(fs.readFileSync(new URL("../relay/protocol.json", import.meta.url), "utf8"));
  assert.deepEqual(relayProto.caps, proto.caps, "relay 副本与唯一事实源一致");
  assert.deepEqual(ext.PROTOCOL.caps, proto.caps, "扩展 PROTOCOL 块与唯一事实源一致");
  assert.equal(ext.CLIENT_CAPS.includes("agent.state"), false, "没有生产者就不在握手里声明");
});

/* ---- 未载入会话的文件级操作 + 树跳转 summarize ---- */

const require = createRequire(import.meta.url);
const relayCommands = require("../relay/commands.js");

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-session-file-"));
  const active = path.join(dir, "active.jsonl");
  const target = path.join(dir, "target.jsonl");
  fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "active-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" }) + "\n");
  const lines = [
    { type: "session", version: 3, id: "sess-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "第一答" }], stopReason: "stop" } },
  ];
  fs.writeFileSync(target, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return { dir, active, target };
}

function fileBridge(dir, active) {
  const bridge = new ext.Bridge();
  bridge.ctx = { sessionManager: { getSessionDir: () => dir, getSessionFile: () => active }, isIdle: () => true };
  bridge.loadPiPackage = async () => null;
  return bridge;
}

function cleanup(dir) {
  try { fs.chmodSync(dir, 0o700); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

test("inactive 改名：追加 pi 语义 session_info，保留原 id/路径/父链", async () => {
  const { dir, active, target } = fixture();
  try {
    const bridge = fileBridge(dir, active);
    const before = fs.readFileSync(target, "utf8");
    const data = await bridge.executeCommand("rename_session_file", { sessionPath: target, name: "新名字" });
    assert.equal(data.ok, true);
    assert.equal(data.id, "sess-1");
    assert.equal(data.sessionPath, target.replace(/\\/g, "/"));
    assert.equal(fs.existsSync(target), true, "不改文件名");
    const after = fs.readFileSync(target, "utf8");
    assert.ok(after.startsWith(before.trim() + "\n"), "原内容逐字保留在尾部之前");
    const lines = after.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].id, "sess-1", "会话头 id 不变");
    const last = lines.at(-1);
    assert.equal(last.type, "session_info");
    assert.equal(last.name, "新名字");
    assert.equal(last.parentId, "a1", "新条目挂在原叶下");
    assert.ok(lines.some((entry) => entry.id === last.id) && last.id.length > 0);
    assert.equal(data.session.name, "新名字");
    assert.equal(data.session.id, "sess-1");
  } finally {
    cleanup(dir);
  }
});

test("inactive 改名：当前会话/空名/越界/不存在都明确失败", async () => {
  const { dir, active, target } = fixture();
  try {
    const bridge = fileBridge(dir, active);
    await assert.rejects(bridge.executeCommand("rename_session_file", { sessionPath: active, name: "x" }), (e) => e.code === "bad_args");
    await assert.rejects(bridge.executeCommand("rename_session_file", { sessionPath: target, name: "   " }), (e) => e.code === "bad_args");
    await assert.rejects(bridge.executeCommand("rename_session_file", { sessionPath: path.join(dir, "missing.jsonl"), name: "x" }), (e) => e.code === "not_found");

    const outside = path.join(dir, "..", "outside-" + process.pid + ".jsonl");
    fs.writeFileSync(outside, JSON.stringify({ type: "session", id: "out", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
    try {
      await assert.rejects(bridge.executeCommand("rename_session_file", { sessionPath: outside, name: "x" }), (e) => e.code === "bad_args" && /越界/.test(e.message));
    } finally {
      fs.rmSync(outside, { force: true });
    }
  } finally {
    cleanup(dir);
  }
});

test("inactive 导出：text 与 JSONL 都是完整内容；超大/损坏/权限错误不伪装成功", async () => {
  const { dir, active, target } = fixture();
  try {
    const bridge = fileBridge(dir, active);
    const raw = fs.readFileSync(target, "utf8");
    const jsonl = await bridge.executeCommand("export_session_file", { sessionPath: target, format: "jsonl" });
    assert.equal(jsonl.text, raw, "JSONL 原样返回");
    assert.equal(jsonl.totalBytes, Buffer.byteLength(raw));
    assert.equal(jsonl.truncated, false);
    const text = await bridge.executeCommand("export_session_file", { sessionPath: target, format: "text" });
    assert.match(text.text, /\[User\]: 第一问/);
    assert.match(text.text, /\[Assistant\]: 第一答/);
    assert.equal(text.truncated, false);

    const big = path.join(dir, "big.jsonl");
    fs.writeFileSync(big, JSON.stringify({ type: "session", id: "big", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n" + JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "x".repeat(20 * 1024) } }) + "\n");
    await assert.rejects(bridge.executeCommand("export_session_file", { sessionPath: big, format: "jsonl", maxBytes: 16 * 1024 }), (e) => e.code === "payload_too_large" && /上限/.test(e.message));

    const corrupt = path.join(dir, "corrupt.jsonl");
    fs.writeFileSync(corrupt, JSON.stringify({ type: "session", id: "c", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n{not json}\n");
    for (const format of ["text", "jsonl"]) {
      await assert.rejects(bridge.executeCommand("export_session_file", { sessionPath: corrupt, format }), (e) => e.code === "internal" && /损坏/.test(e.message));
    }

    if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0) {
      fs.chmodSync(target, 0o000);
      try {
        await assert.rejects(bridge.executeCommand("export_session_file", { sessionPath: target, format: "text" }), (e) => e.code === "internal" && /权限/.test(e.message));
        await assert.rejects(bridge.executeCommand("rename_session_file", { sessionPath: target, name: "x" }), (e) => e.code === "internal" && /权限/.test(e.message));
      } finally {
        fs.chmodSync(target, 0o600);
      }
    }
  } finally {
    cleanup(dir);
  }
});

test("cold fork 兜底：无头复制当前分支落新文件，不启动 pi；空会话/损坏明确报错", async () => {
  const { dir, active, target } = fixture();
  try {
    const bridge = fileBridge(dir, active);
    const data = await bridge.executeCommand("fork_session_file", { sessionPath: target });
    assert.equal(data.ok, true);
    assert.notEqual(data.sessionPath, target);
    assert.ok(data.sessionPath.startsWith(dir.replace(/\\/g, "/") + "/"), "新文件在会话目录内");
    const created = fs.readFileSync(data.sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const header = created[0];
    assert.equal(header.type, "session");
    assert.notEqual(header.id, "sess-1");
    assert.equal(header.parentSession, target);
    const messages = created.filter((entry) => entry.type === "message");
    assert.deepEqual(messages.map((entry) => entry.id), ["u1", "a1"], "只复制活动分支");
    assert.equal(messages[0].parentId, null);
    assert.equal(messages[1].parentId, "u1");
    assert.equal(data.session.id, header.id);

    const empty = path.join(dir, "empty.jsonl");
    fs.writeFileSync(empty, JSON.stringify({ type: "session", id: "empty", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
    await assert.rejects(bridge.executeCommand("fork_session_file", { sessionPath: empty }), (e) => e.code === "bad_args" && /用户\/助手消息/.test(e.message));

    const corrupt = path.join(dir, "corrupt-fork.jsonl");
    fs.writeFileSync(corrupt, JSON.stringify({ type: "session", id: "c", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\nnot-json\n");
    await assert.rejects(bridge.executeCommand("fork_session_file", { sessionPath: corrupt }), (e) => e.code === "internal" && /损坏/.test(e.message));
  } finally {
    cleanup(dir);
  }
});

test("inactive >8MB：改名/冷 fork 纯文件流式完成，不加载 pi 包；损坏仍明确报错", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-big-session-"));
  const active = path.join(dir, "active.jsonl");
  const target = path.join(dir, "big.jsonl");
  const big = "x".repeat(9 * 1024 * 1024);
  fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "active-1", cwd: "/tmp/project" }) + "\n");
  const source = [
    { type: "session", version: 3, id: "big-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "第一问" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: big }] } },
    { type: "message", id: "b1", parentId: null, timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: [{ type: "text", text: "另一分支" }] } },
    { type: "message", id: "a2", parentId: "a1", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "收尾" }] } },
    { type: "label", id: "l1", parentId: "a2", timestamp: "2026-01-01T00:00:05.000Z", targetId: "u1", label: "起点" },
  ];
  fs.writeFileSync(target, source.map((line) => JSON.stringify(line)).join("\n") + "\n");
  assert.ok(fs.statSync(target).size > 8 * 1024 * 1024, "fixture 必须真的超过旧 8MB 上限");
  try {
    const bridge = fileBridge(dir, active);
    // 纯文件实现：任何路径调用 pi 包都算失败。
    bridge.loadPiPackage = async () => { throw new Error("inactive 文件操作不能依赖 pi 包"); };

    const before = fs.readFileSync(target, "utf8").split("\n");
    const renamed = await bridge.executeCommand("rename_session_file", { sessionPath: target, name: "大文件改名" });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.id, "big-1");
    const afterRename = fs.readFileSync(target, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(afterRename.at(-1).type, "session_info");
    assert.equal(afterRename.at(-1).name, "大文件改名");
    assert.equal(afterRename.at(-1).parentId, "l1", "父节点是文件当前叶（label 条目）");
    assert.ok(fs.readFileSync(target, "utf8").startsWith(before.slice(0, -1).join("\n")), "原内容前段逐字保留");
    const renamedAgain = await bridge.executeCommand("rename_session_file", { sessionPath: target, name: "再改一次" });
    assert.equal(renamedAgain.previousName, "大文件改名", "大文件也能从流式扫描里读到上一条 session_info");

    const forked = await bridge.executeCommand("fork_session_file", { sessionPath: target });
    assert.equal(forked.ok, true);
    assert.ok(fs.statSync(forked.sessionPath).size > 8 * 1024 * 1024, "fork 结果也必须超过 8MB");
    const created = fs.readFileSync(forked.sessionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(created[0].type, "session");
    assert.notEqual(created[0].id, "big-1");
    assert.equal(created[0].parentSession, target);
    const messages = created.filter((entry) => entry.type === "message");
    assert.deepEqual(messages.map((entry) => entry.id), ["u1", "a1", "a2"], "只复制活动分支，不复制另一分支");
    assert.equal(messages[0].parentId, null);
    assert.equal(messages[1].parentId, "u1");
    assert.equal(messages[1].message.content[0].text.length, big.length, "大正文完整保留");
    assert.equal(forked.session.messageCount, 3);
    const label = created.filter((entry) => entry.type === "label").at(-1);
    assert.equal(label.targetId, "u1", "label 重新挂到新链末尾");
    assert.equal(label.parentId, created.at(-2).id, "label 的父节点是前一条保留条目");

    const corrupt = path.join(dir, "corrupt-big.jsonl");
    fs.copyFileSync(target, corrupt);
    fs.appendFileSync(corrupt, "not-json\n");
    await assert.rejects(bridge.executeCommand("rename_session_file", { sessionPath: corrupt, name: "x" }), (e) => e.code === "internal" && /损坏/.test(e.message));
    await assert.rejects(bridge.executeCommand("fork_session_file", { sessionPath: corrupt }), (e) => e.code === "internal" && /损坏/.test(e.message));
  } finally {
    cleanup(dir);
  }
});

test("navigate_tree summarize：优先走 pi 公开 navigateTree（钩子自然触发），取消不改叶、失败报真实错误", async () => {
  const calls = [];
  const sm = {
    getSessionFile: () => "/tmp/active.jsonl",
    getLeafId: () => "old-leaf",
    getEntry: (id) => ({ id, type: "message" }),
    branch: (id) => calls.push(["branch", id]),
  };
  let navResult = {
    cancelled: false,
    summaryEntry: { summary: "分支摘要", details: { readFiles: ["a"], modifiedFiles: ["b", "c"] } },
  };
  const bridge = new ext.Bridge();
  bridge.roomId = "A";
  bridge.connected = true;
  bridge.ws = { bufferedAmount: 0, send() {}, close() {} };
  bridge.ctx = {
    sessionManager: sm,
    isIdle: () => true,
    navigateTree: async (id, opts) => {
      calls.push(["nav", id, opts]);
      return navResult;
    },
  };
  bridge.loadPiPackage = async () => { throw new Error("公开 navigateTree 路径不能再去加载摘要实现"); };
  const out = await bridge.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true });
  assert.deepEqual(calls, [["nav", "target-leaf", { summarize: true }]], "只调用公开 navigateTree，不自己 branch/branchWithSummary");
  assert.equal(out.cancelled, false);
  assert.equal(out.summary, true);
  assert.equal(out.summaryChars, 4);
  assert.deepEqual([out.readFiles, out.modifiedFiles], [1, 2]);
  assert.equal(bridge.gen, 1, "session_tree 事件负责换代；这里不能手动 bump 造成双重 reset");

  // 钩子取消：pi 返回 cancelled，不改叶、不补摘要、也不换代
  calls.length = 0;
  navResult = { cancelled: true };
  const cancelled = await bridge.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.summary, false);
  assert.equal(bridge.gen, 1);
  assert.deepEqual(calls, [["nav", "target-leaf", { summarize: true }]]);

  // 公开 API 的真实错误要映射成协议码，不能伪装成 unsupported 或成功
  bridge.ctx.navigateTree = async () => { throw new Error("No model available for summarization"); };
  await assert.rejects(
    bridge.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true }),
    (e) => e.code === "no_model",
  );
  assert.equal(bridge.gen, 1, "失败不改叶/不换代");

  // 命令上下文（ExtensionCommandContext）也能作为公开 navigateTree 的来源
  const manualCalls = [];
  const manual = new ext.Bridge();
  manual.roomId = "A";
  manual.connected = true;
  manual.ws = { bufferedAmount: 0, send() {}, close() {} };
  manual.ctx = { sessionManager: sm, isIdle: () => true };
  const result = await manual.runSessionOp("navigate_tree", { targetId: "target-leaf", summarize: true }, {
    navigateTree: async (id, opts) => { manualCalls.push([id, opts]); return { cancelled: false, summaryEntry: { summary: "x" } }; },
  });
  assert.deepEqual(manualCalls, [["target-leaf", { summarize: true }]]);
  assert.equal(result.summary, true);
});

test("navigate_tree summarize：有摘要接口才写 branch_summary；缺接口/没模型/已在叶都不改叶", async () => {
  const calls = [];
  const sm = {
    getSessionDir: () => os.tmpdir(),
    getSessionFile: () => "/tmp/active.jsonl",
    getLeafId: () => "old-leaf",
    getEntry: (id) => (id === "target-leaf" ? { id, type: "message" } : null),
    branch: (id) => calls.push(["branch", id]),
    branchWithSummary: (...args) => calls.push(["summary", ...args]),
  };
  const bridge = new ext.Bridge();
  bridge.ctx = { sessionManager: sm, isIdle: () => true, model: { id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } };
  const usage = { input: 1, output: 2 };
  bridge.loadPiPackage = async () => ({
    collectEntriesForBranchSummary: () => ({ entries: [{ id: "old-leaf" }] }),
    generateBranchSummary: async () => ({ summary: "分支摘要", usage, readFiles: ["a"], modifiedFiles: [] }),
  });
  const out = await bridge.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true });
  assert.equal(out.summary, true);
  assert.equal(out.summaryChars, 4);
  assert.deepEqual(calls, [["summary", "target-leaf", "分支摘要", { readFiles: ["a"], modifiedFiles: [] }, false, usage]]);

  // 没有 pi 摘要接口：明确 unsupported，不静默降级成直接跳转
  const missing = new ext.Bridge();
  missing.ctx = { sessionManager: sm, isIdle: () => true, model: { id: "m" } };
  missing.loadPiPackage = async () => null;
  const before = calls.length;
  await assert.rejects(missing.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true }), (e) => e.code === "unsupported");
  assert.equal(calls.length, before, "unsupported 时没有改叶");
  await missing.executeCommand("navigate_tree", { targetId: "target-leaf" });
  assert.deepEqual(calls.at(-1), ["branch", "target-leaf"], "直接跳转仍是原来的 branch");

  const noModel = new ext.Bridge();
  noModel.ctx = { sessionManager: sm, isIdle: () => true, model: null };
  noModel.loadPiPackage = bridge.loadPiPackage;
  await assert.rejects(noModel.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true }), (e) => e.code === "no_model");

  const atLeaf = new ext.Bridge();
  atLeaf.ctx = { sessionManager: { ...sm, getLeafId: () => "target-leaf" }, isIdle: () => true, model: { id: "m" } };
  atLeaf.loadPiPackage = async () => ({ collectEntriesForBranchSummary: () => ({ entries: [] }), generateBranchSummary: async () => ({ summary: "x" }) });
  const noop = await atLeaf.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true });
  assert.equal(noop.summary, false);
  assert.equal(noop.noop, true);

  // 没有可总结条目时仍完成直接跳转，但不把“没摘要”伪装成“已在当前叶”。
  const noEntries = new ext.Bridge();
  noEntries.ctx = { sessionManager: { ...sm, branch: (id) => calls.push(["branch-empty", id]) }, isIdle: () => true, model: { id: "m" } };
  noEntries.loadPiPackage = async () => ({ collectEntriesForBranchSummary: () => ({ entries: [] }), generateBranchSummary: async () => ({ summary: "x" }) });
  const emptyJump = await noEntries.executeCommand("navigate_tree", { targetId: "target-leaf", summarize: true });
  assert.equal(emptyJump.summary, false);
  assert.equal(emptyJump.noop, false);
  assert.deepEqual(calls.at(-1), ["branch-empty", "target-leaf"]);

  assert.deepEqual(bridge.normalizeOpArgs("navigate_tree", { targetId: "t", summarize: true }), { targetId: "t", summarize: true });
  assert.deepEqual(bridge.normalizeOpArgs("navigate_tree", { targetId: "t" }), { targetId: "t" });
});

test("relay 命令白名单/超时：inactive 文件操作可无房间直达，summarize 走 120s", () => {
  for (const command of ["rename_session_file", "export_session_file", "fork_session_file"]) {
    assert.ok(relayCommands.DEVICE_COMMANDS.has(command), command);
    assert.ok(relayCommands.INACTIVE_SESSION_COMMANDS.has(command), command);
    assert.equal(relayCommands.commandTimeoutMs(command, {}), 30000);
  }
  assert.equal(relayCommands.commandTimeoutMs("navigate_tree", { summarize: true }), 120000);
  assert.equal(relayCommands.commandTimeoutMs("navigate_tree", {}), 30000);
});

/* ---- 正文搜索（R4-2）：宿主侧扫 sessionDir，预算与截断诚实态 ---- */

function bodyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-search-"));
  const active = path.join(dir, "active.jsonl");
  const write = (name, lines) => fs.writeFileSync(path.join(dir, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  write("active.jsonl", [
    { type: "session", version: 3, id: "act-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/a" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "当前会话的问题" }] } },
  ]);
  // needle 只出现在正文（不在标题/首消息/cwd）：会话名靠尾段 session_info
  write("body.jsonl", [
    { type: "session", version: 3, id: "body-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/b" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "普通开场白" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "这块紫水晶的成色不错，值得细看。" }], stopReason: "stop" } },
    { type: "session_info", id: "si1", parentId: "a1", timestamp: "2026-01-01T00:00:03.000Z", name: "宝石会话" },
  ]);
  // 多条命中：计数按条、snippet 只留前 3
  const many = [{ type: "session", version: 3, id: "many-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/work/c" }];
  for (let i = 0; i < 5; i++) {
    many.push({ type: "message", id: "m" + i, parentId: null, timestamp: "2026-01-01T00:00:0" + i + ".000Z", message: { role: "assistant", content: [{ type: "text", text: "第 " + i + " 处提到紫水晶" }], stopReason: "stop" } });
  }
  write("many.jsonl", many);
  // 监狱外：同词文件放在 sessionDir 外面，绝不能被搜到
  const outside = path.join(dir, "..", "outside-body-" + process.pid + ".jsonl");
  fs.writeFileSync(outside, JSON.stringify({ type: "message", id: "x1", message: { role: "user", content: "紫水晶在监狱外" } }) + "\n");
  return { dir, active, outside };
}

test("正文搜索：只搜 sessionDir 内正文，片段/标题/计数口径，监狱外搜不到", async () => {
  const { dir, active, outside } = bodyFixture();
  try {
    const bridge = fileBridge(dir, active);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(out.query, "紫水晶");
    assert.equal(out.totalFiles, 3);
    assert.equal(out.scannedFiles, 3);
    assert.equal(out.truncated, false, "全扫完不许标截断");
    const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
    assert.deepEqual(Object.keys(byId).sort(), ["body-1", "many-1"], "监狱外文件与无命中文件都不出现");
    const body = byId["body-1"];
    assert.equal(body.session, path.join(dir, "body.jsonl").replace(/\\/g, "/"));
    assert.equal(body.title, "宝石会话", "标题取尾段 session_info 的名字");
    assert.equal(body.cwd, "/work/b");
    assert.equal(body.matchCount, 1);
    assert.equal(body.snippets.length, 1);
    assert.ok(body.snippets[0].text.includes("紫水晶"), "片段含命中词");
    assert.ok(body.snippets[0].text.length <= 160, "片段不超协议上限");
    assert.equal(body.snippets[0].entryId, "a1");
    const many = byId["many-1"];
    assert.equal(many.matchCount, 5, "命中按条目计数");
    assert.equal(many.snippets.length, 3, "snippet 每会话只留 3 条");
    assert.equal(many.title, "many-1", "无名无首消息时标题回退会话 id，不编假名");
    // 大小写不敏感（英文同理）
    const upper = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(upper.results.length, 2);
  } finally {
    cleanup(dir);
    try { fs.rmSync(outside, { force: true }); } catch {}
  }
});

test("正文搜索：搜索词过短/过长明确 bad_args；无会话目录回诚实空结果", async () => {
  const { dir, active } = bodyFixture();
  try {
    const bridge = fileBridge(dir, active);
    await assert.rejects(bridge.executeCommand("search_session_bodies", { query: "紫" }), (e) => e.code === "bad_args");
    await assert.rejects(bridge.executeCommand("search_session_bodies", { query: "x".repeat(101) }), (e) => e.code === "bad_args");
    await assert.rejects(bridge.executeCommand("search_session_bodies", {}), (e) => e.code === "bad_args");
    const none = await bridge.executeCommand("search_session_bodies", { query: "不存在的词组" });
    assert.deepEqual(none.results, []);
    assert.equal(none.truncated, false);
    assert.equal(none.scannedFiles, 3);
    const noDir = new ext.Bridge();
    noDir.ctx = { sessionManager: { getSessionDir: () => path.join(dir, "missing-dir"), getSessionFile: () => null }, isIdle: () => true };
    const empty = await noDir.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.deepEqual(empty, { query: "紫水晶", results: [], truncated: false, scannedFiles: 0, totalFiles: 0 });
  } finally {
    cleanup(dir);
  }
});

test("正文搜索：文件数上限与结果上限都触发 truncated 诚实态", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-cap-"));
  const active = path.join(dir, "active.jsonl");
  try {
    // 205 个文件 > 200 上限：扫到 200 必停、truncated、totalFiles 如实报 205
    for (let i = 0; i < 205; i++) {
      const name = "f" + String(i).padStart(3, "0") + ".jsonl";
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ type: "session", version: 3, id: "f" + i, cwd: "/w" }) + "\n");
      const t = new Date(1700000000000 + i * 1000);
      fs.utimesSync(path.join(dir, name), t, t);
    }
    fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "act", cwd: "/w" }) + "\n");
    const bridge = fileBridge(dir, active);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(out.totalFiles, 206);
    assert.equal(out.scannedFiles, 200, "文件数上限 200（协议 limits）");
    assert.equal(out.truncated, true, "没扫完必须明示");
    assert.deepEqual(out.results, []);
  } finally {
    cleanup(dir);
  }

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-cap2-"));
  const active2 = path.join(dir2, "active.jsonl");
  try {
    // 25 个文件全命中 > 全局结果上限 20：只回 20 个会话且 truncated
    for (let i = 0; i < 25; i++) {
      const name = "h" + String(i).padStart(2, "0") + ".jsonl";
      const lines = [
        { type: "session", version: 3, id: "h" + i, cwd: "/w" },
        { type: "message", id: "u1", message: { role: "user", content: "紫水晶" } },
      ];
      fs.writeFileSync(path.join(dir2, name), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      const t = new Date(1700000000000 + i * 1000);
      fs.utimesSync(path.join(dir2, name), t, t);
    }
    fs.writeFileSync(active2, JSON.stringify({ type: "session", version: 3, id: "act2", cwd: "/w" }) + "\n");
    const bridge = fileBridge(dir2, active2);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(out.results.length, 20, "全局结果上限 20（协议 limits）");
    assert.equal(out.truncated, true);
    assert.equal(out.totalFiles, 26);
  } finally {
    cleanup(dir2);
  }
});

test("正文搜索：单会话命中计数封顶 50，工具大块输出按条截断后仍可命中", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-count-"));
  const active = path.join(dir, "active.jsonl");
  try {
    const lines = [{ type: "session", version: 3, id: "cap-1", cwd: "/w" }];
    for (let i = 0; i < 60; i++) {
      lines.push({ type: "message", id: "m" + i, message: { role: "assistant", content: [{ type: "text", text: "紫水晶 " + i }] } });
    }
    // 一条超大工具输出：命中词在 40KB 之后——单条文本按 bodySearchEntryTextMax 截断计入，
    // 截断外的词不算命中（口径如此，防大块输出撑爆扫描）；词在截断内则命中。
    const big = "x".repeat(40000) + "紫水晶在截断外";
    lines.push({ type: "message", id: "big1", message: { role: "tool_result", content: [{ type: "text", text: big }] } });
    fs.writeFileSync(path.join(dir, "cap.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "act3", cwd: "/w" }) + "\n");
    const bridge = fileBridge(dir, active);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    const hit = out.results.find((r) => r.id === "cap-1");
    assert.ok(hit, "cap 会话应命中");
    assert.equal(hit.matchCount, 50, "命中计数封顶 50，不虚报 61");
    assert.equal(hit.snippets.length, 3);
  } finally {
    cleanup(dir);
  }
});

test("正文搜索：最后一个文件扫描中途读失败——回包必 truncated 且该文件不计入已扫（B-1/B-3）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-err-"));
  const active = path.join(dir, "a-hit.jsonl");
  const victim = path.join(dir, "z-victim.jsonl");
  try {
    const write = (name, id, mtimeOffset) => {
      const lines = [
        { type: "session", version: 3, id, cwd: "/w" },
        { type: "message", id: "u1", message: { role: "user", content: "这里提到紫水晶" } },
      ];
      const p = path.join(dir, name);
      fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      const t = new Date(1700000000000 + mtimeOffset);
      fs.utimesSync(p, t, t);
    };
    // 扫描按 mtime 倒序：a 最新、b 次之、victim 最老排最后扫
    write("a-hit.jsonl", "a-1", 2000);
    write("b-hit.jsonl", "b-1", 1000);
    write("z-victim.jsonl", "victim-1", 0);
    const bridge = fileBridge(dir, active);
    const pending = bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    // 命令分发同步直达扫描：枚举（readdir+stat）在本 tick 内已完成、文件读是异步 I/O
    // 尚未落盘读——此刻把 victim 换成同名目录，模拟扫描中途文件被替换，
    // 轮到它时读流必走读异常路径（root 下 chmod 造不出读失败，故用此法）。
    fs.rmSync(victim);
    fs.mkdirSync(victim);
    const out = await pending;
    assert.equal(out.totalFiles, 3);
    assert.equal(out.truncated, true, "最后一个文件没扫完：绝不假报搜全（B-1）");
    assert.equal(out.scannedFiles, 2, "读失败的文件不计入已扫（B-3）");
    assert.deepEqual(out.results.map((r) => r.id).sort(), ["a-1", "b-1"], "先扫完文件的命中照常回，失败文件的命中不出现");
  } finally {
    cleanup(dir);
  }
});

/* ---- 正文搜索 B-2（R5-1）：单行巨行预算残缝——块粒度计账、超限整行丢弃 ---- */

test("正文搜索：单行巨行超单行上限——巨行不解析命中不计，前后正常行照常命中，标 truncated（B-2）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-giant-"));
  const active = path.join(dir, "active.jsonl");
  try {
    assert.equal(proto.limits.bodySearchLineMaxBytes, 4194304, "单行上限已登记协议 limits（4MiB）");
    fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "act-g", cwd: "/w" }) + "\n");
    // 巨行：正文 6MiB（「巨」3 字节 × 2M），命中词埋在超限点之后——整行必须被丢弃、不许先整行入内存再计账
    const giant = { type: "message", id: "g1", message: { role: "assistant", content: [{ type: "text", text: "巨".repeat(2 * 1024 * 1024) + "紫水晶埋在巨行后段" }] } };
    const lines = [
      { type: "session", version: 3, id: "giant-1", cwd: "/w" },
      { type: "message", id: "u1", message: { role: "user", content: "巨行之前提到紫水晶" } },
      giant,
      { type: "message", id: "u2", message: { role: "user", content: "巨行之后也提到紫水晶" } },
    ];
    fs.writeFileSync(path.join(dir, "giant.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const bridge = fileBridge(dir, active);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(out.totalFiles, 2);
    assert.equal(out.truncated, true, "有行被跳过：没搜全必须明示");
    assert.equal(out.scannedFiles, 1, "含跳行的文件不算完整已扫（只 active 计入）");
    assert.equal(out.results.length, 1);
    const hit = out.results[0];
    assert.equal(hit.id, "giant-1");
    assert.equal(hit.matchCount, 2, "只数巨行前后两条正常行；巨行内的命中不计");
    assert.ok(hit.snippets.every((s) => !s.text.includes("巨行后段")), "巨行片段不得出现");
  } finally {
    cleanup(dir);
  }
});

test("正文搜索：巨行是文件唯一内容——结果为空且 truncated，不假装搜全（B-2）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-giantonly-"));
  const active = path.join(dir, "active.jsonl");
  try {
    fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "act-o", cwd: "/w" }) + "\n");
    const giant = { type: "message", id: "g1", message: { role: "user", content: [{ type: "text", text: "紫水晶在巨行开头也会被整行丢弃" + "巨".repeat(2 * 1024 * 1024) }] } };
    fs.writeFileSync(path.join(dir, "only.jsonl"), JSON.stringify(giant) + "\n");
    const bridge = fileBridge(dir, active);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(out.totalFiles, 2);
    assert.deepEqual(out.results, [], "巨行内的命中一律不计，哪怕词在行首");
    assert.equal(out.truncated, true);
    assert.equal(out.scannedFiles, 1, "只有 active 算完整已扫");
  } finally {
    cleanup(dir);
  }
});

test("正文搜索：约 1MiB 长行未超单行上限——不误杀，命中照常（B-2）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-longline-"));
  const active = path.join(dir, "active.jsonl");
  try {
    fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "act-l", cwd: "/w" }) + "\n");
    // 行长约 1MiB：体积放在条目的非正文字段（pad）——正文 32KB 条目截断与单行上限是两道独立的闸，
    // 本条只验单行闸：行 < 4MiB 必须整行解析、正文尾部的词照常命中、不许标截断。
    const entry = {
      type: "message", id: "m1",
      pad: "x".repeat(1024 * 1024),
      message: { role: "user", content: [{ type: "text", text: "长行正文填充" + "a".repeat(200) + "紫水晶在正文尾" }] },
    };
    const lines = [{ type: "session", version: 3, id: "long-1", cwd: "/w" }, entry];
    fs.writeFileSync(path.join(dir, "long.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const bridge = fileBridge(dir, active);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(out.truncated, false, "未超限不许标截断");
    assert.equal(out.scannedFiles, 2);
    const hit = out.results.find((r) => r.id === "long-1");
    assert.ok(hit, "长行会话应命中");
    assert.equal(hit.matchCount, 1);
    assert.ok(hit.snippets[0].text.includes("紫水晶"));
  } finally {
    cleanup(dir);
  }
});

test("正文搜索：跨块多字节字符不乱码——命中词首字节压在 64KB 块边界前一位（B-2）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-body-cjk-"));
  const active = path.join(dir, "active.jsonl");
  try {
    fs.writeFileSync(active, JSON.stringify({ type: "session", version: 3, id: "act-c", cwd: "/w" }) + "\n");
    const header = JSON.stringify({ type: "session", version: 3, id: "cjk-1", cwd: "/w" });
    // 体积放在 pad 字段把命中词顶到块边界：「紫」3 字节，首字节在文件偏移 65535 时恰被
    // 64KB 读块从中间切开——StringDecoder 必须兜住半截字符，不许出替换字符丢命中。
    // 注意：本夹具依赖 fs.createReadStream 默认块大小恰为 64KB 这一运行时事实（扩展侧
    // 未显式传 highWaterMark）；若运行时默认值变化、偏移 65535 不再是块边界，需同步调整。
    const mk = (pad) => JSON.stringify({ type: "message", id: "m1", pad, message: { role: "user", content: [{ type: "text", text: "紫水晶压在块边界上" }] } });
    const probe = mk("");
    const base = Buffer.byteLength(header + "\n", "utf8") + Buffer.byteLength(probe.slice(0, probe.indexOf("紫水晶")), "utf8");
    const line = mk("x".repeat(65535 - base));
    assert.equal(Buffer.byteLength(header + "\n" + line.slice(0, line.indexOf("紫水晶")), "utf8"), 65535, "夹具自检：命中词首字节恰在块边界前一位");
    fs.writeFileSync(path.join(dir, "cjk.jsonl"), header + "\n" + line + "\n");
    const bridge = fileBridge(dir, active);
    const out = await bridge.executeCommand("search_session_bodies", { query: "紫水晶" });
    assert.equal(out.truncated, false);
    const hit = out.results.find((r) => r.id === "cjk-1");
    assert.ok(hit, "跨块被切开的命中词也必须命中");
    assert.equal(hit.matchCount, 1);
    assert.ok(hit.snippets[0].text.includes("紫水晶"), "片段含完整命中词");
    assert.ok(!hit.snippets[0].text.includes("�"), "片段不得有替换字符（乱码）");
  } finally {
    cleanup(dir);
  }
});

test("relay 命令分类：search_session_bodies 是设备命令且走 30s 慢读档（R4-2）", () => {
  assert.ok(relayCommands.DEVICE_COMMANDS.has("search_session_bodies"), "设备命令白名单登记");
  assert.equal(relayCommands.commandTimeoutMs("search_session_bodies", {}), 30000, "慢读 30s 口径");
  assert.equal(relayCommands.READONLY_DEVICE_COMMANDS.has("search_session_bodies"), false, "不进无活动会话直达集：需要扩展的会话目录");
});

/* ---------------- P9 §4.6：删除会话文件改成 trash 优先（回 method） ---------------- */

/** PATH 里放一个假 trash（绝对路径调 /bin/mv；Windows 用 trash.cmd + move，和 npm 全局 shim 一致）。 */
function fakeTrashEnv(bin, movedDir) {
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(movedDir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(bin, "trash.cmd"),
      '@echo off\r\nif "%~1"=="--" shift\r\nmove /Y %* "' + movedDir + '\\" >nul\r\nexit /b 0\r\n',
    );
    return { PATH: bin };
  }
  fs.writeFileSync(
    path.join(bin, "trash"),
    "#!/bin/sh\n/bin/mkdir -p " + JSON.stringify(movedDir) + "\n/bin/mv -- \"$@\" " + JSON.stringify(movedDir + "/") + " 2>/dev/null\nexit 0\n",
  );
  fs.chmodSync(path.join(bin, "trash"), 0o755);
  return { PATH: bin };
}

test("P9：deleteLikePi 有 trash 用 trash、没有就 unlink（env 注入，不改全局 PATH）", (t) => {
  const host = process.platform;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-del-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  const moved = path.join(dir, "moved");
  const env = fakeTrashEnv(bin, moved);
  assert.equal(ext.hasTrashCommand(host, env), true);
  assert.equal(ext.hasTrashCommand(host, { PATH: path.join(dir, "empty") }), false);

  const f1 = path.join(dir, "1700_s1.jsonl");
  fs.writeFileSync(f1, "{}\n");
  assert.deepEqual(ext.deleteLikePi(f1, host, env), { ok: true, method: "trash" });
  assert.equal(fs.existsSync(f1), false);
  assert.ok(fs.readdirSync(moved).includes("1700_s1.jsonl"), "文件进了（假）废纸篓");

  const f2 = path.join(dir, "1700_s2.jsonl");
  fs.writeFileSync(f2, "{}\n");
  assert.deepEqual(ext.deleteLikePi(f2, host, { PATH: path.join(dir, "empty") }), { ok: true, method: "unlink" });
  assert.equal(fs.existsSync(f2), false);
});

test("P9：cmdDeleteSession 回 method（无 trash 时 unlink），并保留不能删当前会话的检查", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ext-sessions-"));
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const emptyBin = path.join(dir, "bin");
  fs.mkdirSync(emptyBin);
  process.env.PATH = emptyBin; // 确定没有 trash → 退回 unlink
  const file = path.join(dir, "1700_s1.jsonl");
  fs.writeFileSync(file, "{}\n");

  const makeBridge = (currentFile) => {
    const bridge = new ext.Bridge();
    bridge.ctx = { sessionManager: { getSessionDir: () => dir, getSessionFile: () => currentFile } };
    return bridge;
  };

  // 不能删当前会话：同一个检查保留
  const current = makeBridge(file);
  assert.throws(() => current.cmdDeleteSession({ sessionPath: file }), (e) => e.code === "bad_args" && /不能删除当前会话/.test(e.message));
  assert.equal(fs.existsSync(file), true, "被拒绝时文件不动");

  // 正常删除：method 跟着回包
  const other = makeBridge("");
  const out = other.cmdDeleteSession({ sessionPath: file });
  assert.equal(out.ok, true);
  assert.equal(out.method, "unlink");
  assert.equal(out.deleted, file.replace(/\\/g, "/"));
  assert.equal(fs.existsSync(file), false);

  // 有 trash：method=trash
  const bin = path.join(dir, "trash-bin");
  const moved = path.join(dir, "moved");
  process.env.PATH = fakeTrashEnv(bin, moved).PATH;
  const file2 = path.join(dir, "1700_s2.jsonl");
  fs.writeFileSync(file2, "{}\n");
  const out2 = makeBridge("").cmdDeleteSession({ sessionPath: file2 });
  assert.equal(out2.method, "trash");
  assert.equal(fs.existsSync(file2), false);
  assert.ok(fs.readdirSync(moved).includes("1700_s2.jsonl"));
});
