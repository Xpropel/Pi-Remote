"use strict";
// 页面外通知编排器（R2-2 / P2-4b）：归一 / 去重 / 偏好矩阵 / webhook 渠道 / 配置清洗。
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EVENT_KINDS, sanitizeNotifyEvents, buildEvent, createWebhookChannel, createNotifier } = require("../relay/notify");
const { loadConfig } = require("../relay/config");
const { observeRoomTurnEvent } = require("../relay/rooms");

const ALL_ON = { turn_done: true, turn_error: true, dialog_waiting: true };
const ROOM = { id: "room-1", label: "测试会话" };

function makeNotifier({ cfg = {}, fetchImpl } = {}) {
  const calls = [];
  const logs = [];
  const notifier = createNotifier(
    { notifyWebhookUrl: "http://127.0.0.1:9/placeholder-topic", notifyEvents: { ...ALL_ON }, ...cfg },
    {
      log: (...a) => logs.push(a.join(" ")),
      fetchImpl: fetchImpl || (async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; }),
    },
  );
  return { notifier, calls, logs };
}

function postedKinds(calls) {
  return calls.map((c) => JSON.parse(c.init.body).kind);
}

function settledTurn(notifier, room, stopReason, errorMessage) {
  notifier.observe(room, { type: "agent_start" });
  notifier.observe(room, { type: "message_end", message: { role: "assistant", stopReason, errorMessage } });
  notifier.observe(room, { type: "agent_settled" });
}

/* ---------------- 偏好矩阵清洗 ---------------- */

test("sanitizeNotifyEvents：缺省全关、只认三键的布尔 true", () => {
  assert.deepEqual(sanitizeNotifyEvents(undefined), { turn_done: false, turn_error: false, dialog_waiting: false });
  assert.deepEqual(sanitizeNotifyEvents(null), { turn_done: false, turn_error: false, dialog_waiting: false });
  assert.deepEqual(sanitizeNotifyEvents("turn_done"), { turn_done: false, turn_error: false, dialog_waiting: false });
  assert.deepEqual(
    sanitizeNotifyEvents({ turn_done: true, turn_error: "yes", dialog_waiting: 1, other: true }),
    { turn_done: true, turn_error: false, dialog_waiting: false },
  );
  assert.deepEqual(EVENT_KINDS, ["turn_done", "turn_error", "dialog_waiting"]);
});

/* ---------------- 事件归一 ---------------- */

test("归一：助手正常终态 + agent_settled → turn_done（priority 3）", () => {
  const { notifier, calls } = makeNotifier();
  settledTurn(notifier, ROOM, "stop");
  assert.equal(calls.length, 1);
  // C-1 发送形态：端点 = 配置地址去掉话题段的站点根，话题拆进 body（ntfy JSON 发布语义）
  assert.equal(calls[0].url, "http://127.0.0.1:9/");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.topic, "placeholder-topic");
  assert.equal(body.kind, "turn_done");
  assert.equal(body.priority, 3);
  assert.equal(body.room, "room-1");
  assert.match(body.message, /测试会话/);
  assert.ok(Array.isArray(body.tags) && body.tags.length > 0);
});

test("归一：stopReason=error / 带 errorMessage → turn_error（priority 4，与 done 有区分）", () => {
  const a = makeNotifier();
  settledTurn(a.notifier, ROOM, "error");
  assert.deepEqual(postedKinds(a.calls), ["turn_error"]);
  assert.equal(JSON.parse(a.calls[0].init.body).priority, 4);

  const b = makeNotifier();
  settledTurn(b.notifier, ROOM, "stop", "模型炸了");
  assert.deepEqual(postedKinds(b.calls), ["turn_error"]);
});

test("归一：toolUse 等中间态不算终态；无终态结论时落定按完成报", () => {
  const { notifier, calls } = makeNotifier();
  notifier.observe(ROOM, { type: "agent_start" });
  notifier.observe(ROOM, { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } });
  notifier.observe(ROOM, { type: "message_end", message: { role: "toolResult", stopReason: "error" } });
  notifier.observe(ROOM, { type: "agent_settled" });
  assert.deepEqual(postedKinds(calls), ["turn_done"]);
});

test("归一：aborted 单列静默——用户主动打断的回合不推完成也不推出错（C-2）", () => {
  const { notifier, calls } = makeNotifier();
  settledTurn(notifier, ROOM, "aborted");
  assert.equal(calls.length, 0, "aborted 落定零发送");
  // 静默只针对被打断的那一回合：之后的新回合正常完成仍可推
  settledTurn(notifier, ROOM, "stop");
  assert.deepEqual(postedKinds(calls), ["turn_done"]);
});

test("observe 自身不向外抛：事件对象属性读取抛错也被吞掉（C-4）", () => {
  const { notifier, calls } = makeNotifier();
  const evil = {};
  Object.defineProperty(evil, "type", { get() { throw new Error("boom"); } });
  assert.doesNotThrow(() => notifier.observe(ROOM, evil));
  assert.equal(calls.length, 0);
});

/* ---------------- 去重 ---------------- */

test("去重：同一回合落定只推一次；新回合活动后可再推", () => {
  const { notifier, calls } = makeNotifier();
  settledTurn(notifier, ROOM, "stop");
  notifier.observe(ROOM, { type: "agent_settled" }); // 重复落定信号，无新活动
  assert.equal(calls.length, 1);
  settledTurn(notifier, ROOM, "stop"); // 新回合（agent_start 重新武装）
  assert.equal(calls.length, 2);
});

test("去重：同一 dialogId 只推一次；dialog_close 释放后可再推", () => {
  const { notifier, calls } = makeNotifier();
  const open = { type: "dialog_open", dialogId: "d1", kind: "confirm" };
  notifier.observe(ROOM, open);
  notifier.observe(ROOM, open); // 重连/重放同帧
  assert.equal(calls.length, 1);
  notifier.observe(ROOM, { type: "dialog_close", dialogId: "d1" });
  notifier.observe(ROOM, open);
  assert.equal(calls.length, 2);
  assert.deepEqual(postedKinds(calls), ["dialog_waiting", "dialog_waiting"]);
  assert.equal(JSON.parse(calls[0].init.body).priority, 5);
});

test("dialog_waiting 文案分段：观察态=回去处理；answerable=点开可答（R2-1 补验位）", () => {
  const a = makeNotifier();
  a.notifier.observe(ROOM, { type: "dialog_open", dialogId: "d1", kind: "select" });
  assert.match(JSON.parse(a.calls[0].init.body).message, /回去处理/);

  const b = makeNotifier();
  b.notifier.observe(ROOM, { type: "dialog_open", dialogId: "d2", kind: "select", answerable: true });
  assert.match(JSON.parse(b.calls[0].init.body).message, /点开 Pi-Remote 即可作答/);
});

/* ---------------- 偏好矩阵判定 ---------------- */

test("偏好矩阵：逐类关停只停该类，其余照常", () => {
  for (const off of EVENT_KINDS) {
    const events = { ...ALL_ON, [off]: false };
    const { notifier, calls } = makeNotifier({ cfg: { notifyEvents: events } });
    settledTurn(notifier, ROOM, "stop");   // → turn_done
    settledTurn(notifier, ROOM, "error");  // → turn_error
    notifier.observe(ROOM, { type: "dialog_open", dialogId: "dx", kind: "input" }); // → dialog_waiting
    const kinds = postedKinds(calls);
    assert.ok(!kinds.includes(off), `${off} 关后不应发出，实际发了 ${kinds}`);
    assert.equal(kinds.length, 2, `${off} 关后其余两类应照常，实际 ${kinds}`);
  }
});

/* ---------------- 渠道禁用与失败隔离 ---------------- */

test("未配 webhook URL：编排器禁用、观察事件零发送、零报错日志", () => {
  let fetchCalls = 0;
  const { notifier, logs } = makeNotifier({
    cfg: { notifyWebhookUrl: "" },
    fetchImpl: async () => { fetchCalls += 1; return { ok: true, status: 200 }; },
  });
  assert.equal(notifier.enabled, false);
  settledTurn(notifier, ROOM, "error");
  notifier.observe(ROOM, { type: "dialog_open", dialogId: "d1", kind: "confirm" });
  assert.equal(fetchCalls, 0);
  assert.equal(logs.length, 0);
});

test("webhook 目标不可达：send 返回 false、恰一行日志、日志不带 URL、不抛错", async () => {
  // 先占一个端口再释放，得到确定关闭的端口
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  const secretUrl = `http://127.0.0.1:${port}/very-secret-topic`;
  const logs = [];
  const channel = createWebhookChannel({ url: secretUrl, log: (...a) => logs.push(a.join(" ")) });
  assert.equal(channel.configured, true);
  const ok = await channel.send(buildEvent("turn_done", ROOM));
  assert.equal(ok, false);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("very-secret-topic"), "日志绝不能带 webhook 地址（凭据）");
});

test("webhook 目标返回 HTTP 500：send 返回 false、恰一行日志", async () => {
  const logs = [];
  const channel = createWebhookChannel({
    url: "http://127.0.0.1:9/placeholder-topic",
    fetchImpl: async () => ({ ok: false, status: 500 }),
    log: (...a) => logs.push(a.join(" ")),
  });
  assert.equal(await channel.send(buildEvent("turn_error", ROOM)), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /HTTP 500/);
});

test("webhook 地址拆不出话题段：渠道按未配置处理、记一行不带地址的告警、零发送", async () => {
  const logs = [];
  let fetchCalls = 0;
  const channel = createWebhookChannel({
    url: "http://127.0.0.1:9/", // 只有站点根、没有话题段
    fetchImpl: async () => { fetchCalls += 1; return { ok: true, status: 200 }; },
    log: (...a) => logs.push(a.join(" ")),
  });
  assert.equal(channel.configured, false);
  assert.equal(await channel.send(buildEvent("turn_done", ROOM)), false);
  assert.equal(fetchCalls, 0);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("127.0.0.1"), "告警日志不带地址");
});

/* ---------------- webhook 发送（假 ntfy 服务器实收） ----------------
 * 假服务器按 ntfy 官方发布语义解析，而不是旧 mock 的"收到什么 JSON 就信什么"：
 *  - POST 到站点根 + JSON body：topic / title / message / priority / tags 从 body 取；
 *    JSON 里没 topic = 拒收（delivered=null）。
 *  - POST 到 /<话题>：纯文本发布——body 整体是正文，title / priority 只认请求头。
 * 旧实现把 JSON 直 POST 到话题 URL，在这台假服务器上解析出的 title 是 null、
 * priority 是缺省——正是 C-1 在真 ntfy 上的失效形态，本用例就是冲着让它红写的。 */
function ntfyLikeServer(received) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const pathTopic = (req.url || "").split("/").filter(Boolean)[0] || "";
      let delivered = null;
      if (!pathTopic && (req.headers["content-type"] || "").includes("application/json")) {
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        if (body && typeof body.topic === "string" && body.topic) {
          delivered = { topic: body.topic, title: body.title ?? null, message: body.message ?? null, priority: body.priority ?? null, tags: body.tags ?? null, kind: body.kind ?? null };
        }
      } else if (pathTopic) {
        delivered = {
          topic: decodeURIComponent(pathTopic),
          title: req.headers.title ?? null,
          message: raw,
          priority: req.headers.priority != null ? Number(req.headers.priority) : null,
          tags: req.headers.tags ? req.headers.tags.split(",") : null,
          kind: null,
        };
      }
      received.push({ method: req.method, url: req.url, delivered });
      res.writeHead(200).end("ok");
    });
  });
}

test("webhook 发送：假 ntfy 按官方语义解析——标题/priority/话题真送达（C-1）", async () => {
  const received = [];
  const srv = ntfyLikeServer(received);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/some-topic`;
    // 走真实 fetch 的编排器（不注入 fetchImpl）
    const real = createNotifier(
      { notifyWebhookUrl: url, notifyEvents: { ...ALL_ON } },
      { log: () => {} },
    );
    real.observe(ROOM, { type: "dialog_open", dialogId: "d9", kind: "editor" });
    settledTurn(real, ROOM, "stop");
    // fire-and-forget：等实收两条
    for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(received.length, 2);
    for (const r of received) {
      assert.equal(r.method, "POST");
      assert.ok(r.delivered, "假 ntfy 必须能按发布语义解析出通知（旧 JSON 直发话题 URL 在此解析不出标题/优先级）");
      assert.equal(r.delivered.topic, "some-topic");
      assert.equal(typeof r.delivered.title, "string");
      assert.match(r.delivered.title, /Pi-Remote/);
      assert.equal(typeof r.delivered.message, "string");
      assert.ok(Array.isArray(r.delivered.tags));
    }
    const byKind = Object.fromEntries(received.map((r) => [r.delivered.kind, r.delivered]));
    assert.equal(byKind.dialog_waiting.priority, 5);
    assert.equal(byKind.turn_done.priority, 3);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ---------------- 配置装配 ---------------- */

test("loadConfig：notify 字段装配——文件值、env 覆盖、垃圾值清洗、默认全关", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-notify-cfg-"));
  const cfgPath = path.join(dir, "config.json");
  const savedEnv = process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL;
  const savedErr = console.error;
  console.error = () => {}; // loadConfig 的令牌告警与本用例无关，静音保持输出干净
  try {
    delete process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL;
    // 缺省：未配即空地址 + 全关
    fs.writeFileSync(cfgPath, JSON.stringify({}));
    let cfg = loadConfig(cfgPath);
    assert.equal(cfg.notifyWebhookUrl, "");
    assert.deepEqual(cfg.notifyEvents, { turn_done: false, turn_error: false, dialog_waiting: false });
    // 文件值 + 部分开关
    fs.writeFileSync(cfgPath, JSON.stringify({
      notifyWebhookUrl: "  http://127.0.0.1:9/from-file  ",
      notifyEvents: { turn_done: true, bogus_kind: true },
    }));
    cfg = loadConfig(cfgPath);
    assert.equal(cfg.notifyWebhookUrl, "http://127.0.0.1:9/from-file");
    assert.deepEqual(cfg.notifyEvents, { turn_done: true, turn_error: false, dialog_waiting: false });
    // env 覆盖文件
    process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL = "http://127.0.0.1:9/from-env";
    cfg = loadConfig(cfgPath);
    assert.equal(cfg.notifyWebhookUrl, "http://127.0.0.1:9/from-env");
    // env 显式设空 = 临时停发：覆盖掉文件里已配的 URL，而不是被当"未设置"回落文件值（C-5）
    process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL = "";
    cfg = loadConfig(cfgPath);
    assert.equal(cfg.notifyWebhookUrl, "");
    // 垃圾值：URL 非字符串回空、矩阵非布尔 true 一律关
    delete process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL;
    fs.writeFileSync(cfgPath, JSON.stringify({ notifyWebhookUrl: 42, notifyEvents: { turn_done: "true" } }));
    cfg = loadConfig(cfgPath);
    assert.equal(cfg.notifyWebhookUrl, "");
    assert.deepEqual(cfg.notifyEvents, { turn_done: false, turn_error: false, dialog_waiting: false });
  } finally {
    console.error = savedErr;
    if (savedEnv === undefined) delete process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL;
    else process.env.PI_REMOTE_NOTIFY_WEBHOOK_URL = savedEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 与 rooms 摘要副本的等价性（第 3 轮审查 A-3） ----------------
 * 回合归一逻辑有两份同口径副本：notify 的 observeEvent（推送结论）与 rooms 的
 * observeRoomTurnEvent（lastTurnEnd 摘要）。同一事件序列喂两边，每个落定点的
 * 结论必须一致——改一漏一，这条用例就会红。 */

test("等价（A-3）：notify 归一与 rooms 摘要副本对同一序列结论一致", () => {
  const start = { type: "agent_start" };
  const end = (stopReason, extra = {}) => ({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1, stopReason, ...extra },
  });
  const settled = { type: "agent_settled" };
  const sequences = [
    ["正常终态 → done", [start, end("stop"), settled], ["turn_done"]],
    ["stopReason=error → error", [start, end("error"), settled], ["turn_error"]],
    ["stop 但带 errorMessage → error", [start, end("stop", { errorMessage: "模型调用失败" }), settled], ["turn_error"]],
    ["aborted → 两边都不记", [start, end("aborted"), settled], ["none"]],
    ["只有中间态（toolUse）→ done", [start, end("toolUse"), settled], ["turn_done"]],
    ["无 stopReason → done", [start, end(""), settled], ["turn_done"]],
    ["用户消息不算助手终态", [start, { type: "message_end", message: { role: "user", stopReason: "error" } }, settled], ["turn_done"]],
    ["重复 settled 只记一次（其间的新终态不翻案）", [start, end("stop"), settled, end("error"), settled], ["turn_done", "none"]],
    ["新活动后可再记一回合", [start, end("error"), settled, start, end("stop"), settled], ["turn_error", "turn_done"]],
    ["aborted 后新活动正常记", [start, end("aborted"), settled, start, end("stop"), settled], ["none", "turn_done"]],
  ];
  for (const [name, events, expected] of sequences) {
    const { notifier, calls } = makeNotifier();
    const room = { lastTurnEnd: null, turnOutcome: null, turnSettled: false };
    const conclusions = [];
    let seen = 0;
    for (const ev of events) {
      notifier.observe(ROOM, ev);
      const changed = observeRoomTurnEvent(room, ev, 4242);
      if (ev.type !== "agent_settled") continue;
      // notify 侧结论：这次落定新发出的 turn_done/turn_error（没有 = none）
      const posted = postedKinds(calls).slice(seen).filter((k) => k === "turn_done" || k === "turn_error");
      seen = calls.length;
      const notifyConclusion = posted.length ? posted[0] : "none";
      // rooms 侧结论：这次落定新记下的摘要（changed 且有摘要 = 其 kind；否则 none）
      const roomsConclusion = changed && room.lastTurnEnd
        ? (room.lastTurnEnd.kind === "error" ? "turn_error" : "turn_done")
        : "none";
      assert.equal(roomsConclusion, notifyConclusion, `${name}：第 ${conclusions.length + 1} 次落定两边结论不一致`);
      conclusions.push(notifyConclusion);
    }
    assert.deepEqual(conclusions, expected, name);
  }
});
