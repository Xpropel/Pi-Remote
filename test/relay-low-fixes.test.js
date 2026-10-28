"use strict";
/**
 * 报告 relay 低-5/9/10/12/13/14/19/20/21/22/23/24/25/26 的最小回归测试。
 * （低-18 静态服务读错误/流式发送在 test/web-static.test.js。）
 *
 * 全部是单元测试 + 真实 startRelay 的最小拓扑，不跑 UI/e2e。
 * 低-10 的端到端用例已在 test/relay-runtime-hardening.test.js 里（去重键绑定命令/参数），
 * 本文件只补一条键组成的纯函数断言并标注 verified。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const WebSocket = require("ws");

const { startRelay } = require("../relay/server.js");
const { helloVersionError } = require("../relay/wire.js");
const { dedupeKeyOf, armWaiter, COMMAND_RECONCILE_GRACE_MS } = require("../relay/commands.js");
const { normPath, cwdAllowed, underRoots } = require("../relay/devices.js");
const { PrefsStore } = require("../relay/prefs.js");
const { createNotifier } = require("../relay/notify.js");
const { UsageBroker, validateUsageSnapshot, USAGE_CAP } = require("../relay/usage.js");
const PROTOCOL = require("../relay/protocol.json");

const LOCAL_TOKEN = "test-local-token-lowfix-01";
const VIEWER_TOKEN = "test-viewer-token-lowfix-02";
const ADMIN_TOKEN = "test-admin-token-lowfix-03";

function tmpDir(prefix = "pi-relay-low-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
    adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    ...overrides,
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const frames = [];
    const waiters = [];
    const closed = new Promise((r) => ws.once("close", (code) => r(code)));
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
    ws.once("error", reject);
    ws.once("open", () => resolve({
      ws,
      frames,
      closed,
      send(obj) { ws.send(JSON.stringify(obj)); },
      wait(pred, ms = 3000, what = "frame") {
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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

/* ---------------- 低-5：数据目录进程锁 ---------------- */

test("低-5：同一 dataDir 第二个 relay 启动被拒；close 释放锁后可以重启", async (t) => {
  const dir = tmpDir("pi-low5-");
  const relay = await boot({ dataDir: dir });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(dir, ".relay.lock")), true, "启动后应留下锁文件（内容只有 pid/时间）");
  await assert.rejects(boot({ dataDir: dir }), /数据目录.*(另一个|不能开两个)/, "同数据目录双开必须拒绝");

  await relay.close();
  assert.equal(fs.existsSync(path.join(dir, ".relay.lock")), false, "close 要删除锁文件");
  const again = await boot({ dataDir: dir });
  await again.close();
});

test("低-5：陈旧锁按 pid 存活回收；活着的别的进程持锁时拒绝启动", async (t) => {
  const dir = tmpDir("pi-low5-stale-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".relay.lock"), JSON.stringify({ pid: 99999999, at: 1 }) + "\n");
  const relay = await boot({ dataDir: dir });
  assert.equal(relay.localPort > 0, true, "陈旧锁（pid 不存在）应被回收后正常启动");
  await relay.close();

  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    await sleep(30);
    assert.ok(child.pid > 0);
    fs.writeFileSync(path.join(dir, ".relay.lock"), JSON.stringify({ pid: child.pid, at: Date.now() }) + "\n");
    await assert.rejects(boot({ dataDir: dir }), new RegExp("pid " + child.pid), "活进程持锁必须拒绝，并指出占用 pid");
  } finally {
    try { child.kill(); } catch {}
    await new Promise((r) => { child.once("exit", r); setTimeout(r, 500); });
  }
});

/* ---------------- 低-9：协议文档补同步/去重契约 ---------------- */

test("低-9：protocol/relay-sync.md 覆盖 sync.v3、dedupeKey、握手版本与 prefs/usage 裁决", () => {
  const doc = fs.readFileSync(path.join(__dirname, "..", "protocol", "relay-sync.md"), "utf8");
  for (const word of ["sync.v3", "dedupeKey", "command_accepted", "COMMAND_RECONCILE_GRACE_MS", "minProto", "baseRev", "requestId"]) {
    assert.ok(doc.includes(word), "协议文档缺 " + word);
  }
  assert.match(doc, /字段合并/, "prefs 部分写清了部分子集按字段合并");
});

/* ---------------- 低-10：去重键绑定命令名 + 参数（verified） ---------------- */

test("低-10（verified）：去重键绑定 scope/命令/参数指纹/客户端 key", () => {
  assert.notEqual(
    dedupeKeyOf("room-1", "get_state", {}, "k"),
    dedupeKeyOf("room-1", "get_sessions", {}, "k"),
    "换命令不能命中同一个去重键",
  );
  assert.notEqual(
    dedupeKeyOf("room-1", "get_state", { a: 1 }, "k"),
    dedupeKeyOf("room-1", "get_state", { a: 2 }, "k"),
    "换参数不能命中同一个去重键",
  );
  assert.notEqual(dedupeKeyOf("room-1", "get_state", {}, "k"), dedupeKeyOf("room-2", "get_state", {}, "k"), "scope 要入键");
  assert.equal(
    dedupeKeyOf("room-1", "prompt", { text: "hi", cid: "c1" }, "k"),
    dedupeKeyOf("room-1", "prompt", { cid: "c1", text: "hi" }, "k"),
    "参数键序不影响指纹",
  );
});

/* ---------------- 低-12：过低协议版本握手必须拒绝 ---------------- */

test("低-12：显式 proto < minProto 握手被拒（viewer/local），不带 proto 的旧端仍兼容", async (t) => {
  assert.equal(helloVersionError({}), null, "不带 proto = 兼容期旧端，不能拒绝");
  assert.equal(helloVersionError({ proto: PROTOCOL.proto }), null);
  assert.equal(helloVersionError({ proto: PROTOCOL.minProto }), null);
  assert.equal(helloVersionError({ proto: PROTOCOL.minProto - 1 }).code, "unsupported", "显式过低必须拒绝");
  assert.equal(helloVersionError({ proto: "abc" }).code, "unsupported", "不可解析的显式 proto 也拒绝");

  const relay = await boot();
  t.after(async () => { await relay.close(); });
  const v = await wsClient(relay.viewerPort);
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: PROTOCOL.minProto - 1 });
  const va = await v.type("auth_result");
  assert.deepEqual([va.ok, va.code, va.minProto], [false, "unsupported", PROTOCOL.minProto]);
  assert.equal(await v.closed, 4003);

  const l = await wsClient(relay.localPort);
  l.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: PROTOCOL.minProto - 1 });
  const la = await l.type("auth_result");
  assert.deepEqual([la.ok, la.code], [false, "unsupported"]);
  assert.equal(await l.closed, 4003);

  const legacy = await wsClient(relay.viewerPort);
  t.after(() => legacy.close());
  legacy.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
  assert.equal((await legacy.type("auth_result")).ok, true, "老客户端（无 proto）照旧可连");
});

/* ---------------- 低-13：两个端口同值前置检查 ---------------- */

test("低-13：localPort 与 viewerPort 同值在启动前明确拒绝", async (t) => {
  const dir = tmpDir("pi-low13-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  await assert.rejects(
    boot({ dataDir: dir, localPort: port, viewerPort: port }),
    /不能配成同一个端口/,
    "要在 listen 之前报配置错误，而不是 EADDRINUSE",
  );
});

/* ---------------- 低-14：HTTP 长连接不能挂住 close ---------------- */

test("低-14：存在浏览器 keep-alive/半开 HTTP 连接时 relay.close() 仍在秒级完成", async (t) => {
  const dir = tmpDir("pi-low14-");
  const relay = await boot({ dataDir: dir });
  const sock = net.connect(relay.viewerPort, "127.0.0.1");
  t.after(() => { try { sock.destroy(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  // 只发请求行/半个头：服务端认为连接仍活着，server.close() 的旧实现会一直等它。
  sock.write("GET / HTTP/1.1\r\nHost: test\r\n");
  await sleep(50);
  const started = Date.now();
  await Promise.race([
    relay.close(),
    sleep(1500).then(() => { throw new Error("relay.close() 被 HTTP 长连接挂住"); }),
  ]);
  assert.ok(Date.now() - started < 1200, "close 应在一个宽限期内完成，实际 " + (Date.now() - started) + "ms");
});

/* ---------------- 低-20：命令超时后的对账窗口 ---------------- */

test("低-20：命令超时后条目保留对账窗口（迟到结果仍能跑 onResult），窗口结束才清理", async () => {
  const frames = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(data) { frames.push(JSON.parse(data)); } };
  const rooms = { commandWaiters: new Map(), dedupe: new Map() };
  let settled = 0;
  const entry = {
    wireId: "w-low20", room: { id: "r-low20" }, command: "delete_session",
    timeoutMs: 25, waiters: [{ ws, origId: "q-low20", timer: null }],
    done: false, result: null, key: null, at: Date.now(),
    onSettle() { settled++; },
  };
  rooms.commandWaiters.set(entry.wireId, entry);
  armWaiter(rooms, entry, entry.waiters[0], {});
  await sleep(80);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].code, "timeout");
  assert.equal(settled, 1, "超时照常收尾（释放 harness 串行锁等）");
  assert.equal(entry._timedOut, true);
  assert.equal(entry._settled, true);
  assert.equal(rooms.commandWaiters.get(entry.wireId), entry, "超时不能立刻删条目：设备可能还在执行");
  assert.ok(entry._reconcileTimer, "应挂上对账窗口定时器");
  assert.ok(COMMAND_RECONCILE_GRACE_MS >= 1000);

  // 迟到结果到达 local.js 的 command_result 分支时 entry 仍在 → onResult/去重表都能执行。
  // （真实链路由 relay-runtime-hardening 的「中-16」覆盖「结果迟到/无 waiter 时 onResult 仍执行」。）
  clearTimeout(entry._reconcileTimer);
  rooms.commandWaiters.delete(entry.wireId);
});

/* ---------------- usage：低-21 / 22 / 23 ---------------- */

function usageSnapshot(overrides = {}) {
  const day = "2026-10-20";
  return {
    v: "usage.activity.v1",
    generatedAt: Date.now(),
    timezone: { id: "Asia/Shanghai", offsetMinutes: 480 },
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
      peaks: { tokens: { date: day, value: 10 }, messages: { date: day, value: 1 } },
      models: [],
      modelsWindowDays: 30,
    },
    coverage: { files: 1, parsedFiles: 1, cacheHitFiles: 0, skippedFiles: 0, truncated: false, errors: 0, scanMs: 1, source: "pi-sessions" },
    cache: { hit: false, generatedFrom: "full" },
    ...overrides,
  };
}

function fakeWs(caps = []) {
  const frames = [];
  return {
    readyState: 1,
    bufferedAmount: 0,
    _state: { caps: new Set(caps) },
    frames,
    send(data) { frames.push(JSON.parse(data)); },
  };
}

function usageHarness() {
  const dir = tmpDir("pi-low-usage-");
  const broker = new UsageBroker({
    cfg: {},
    index: { dir },
    devices: new Map(),
    rooms: { map: new Map() },
  });
  return { dir, broker };
}

test("低-21：usage stale 看刷新用的连接（room 的 usage cap），不看 attach 的 dev.conn", async (t) => {
  const { dir, broker } = usageHarness();
  t.after(() => { broker.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const snap = usageSnapshot();
  assert.equal(validateUsageSnapshot(snap).ok, true);
  broker.writeCache("admin", "dev-low21", snap);

  // A：attach 在线但没有 usage 能力，也没有 extension room 连接 → 无法刷新，必须标 stale。
  const attach = fakeWs([]);
  broker.devices.set("dev-low21", { id: "dev-low21", accountId: "admin", online: true, conn: attach });
  const a = fakeWs();
  broker.handleGet(a, { deviceId: "dev-low21", requestId: "r-a" }, "admin");
  assert.equal(a.frames.length, 1);
  assert.equal(a.frames[0].stale, true, "没有可刷新 usage 的连接时必须 stale");

  // B：attach 不在（dev.conn 为空），但 extension room 连接在线且声明 usage cap → 能刷新，不是 stale。
  broker.devices.set("dev-low21", { id: "dev-low21", accountId: "admin", online: true, conn: null });
  const usageConn = fakeWs([USAGE_CAP]);
  broker.rooms.map.set("room-low21", { deviceId: "dev-low21", local: usageConn });
  const b = fakeWs();
  broker.handleGet(b, { deviceId: "dev-low21", requestId: "r-b" }, "admin");
  assert.equal(b.frames.length, 1);
  assert.equal(b.frames[0].stale, false, "usage 连接在线时不能仅因 dev.conn 为空就标 stale");
});

test("低-22：pending 刷新期间，不带/带错 requestId 的 usage_snapshot 不能结案或顶掉强制刷新", async (t) => {
  const { dir, broker } = usageHarness();
  t.after(() => { broker.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  const usageConn = fakeWs([USAGE_CAP]);
  broker.devices.set("dev-low22", { id: "dev-low22", accountId: "admin", online: true, conn: null });
  broker.rooms.map.set("room-low22", { deviceId: "dev-low22", local: usageConn });

  const viewer = fakeWs();
  broker.handleGet(viewer, { deviceId: "dev-low22", requestId: "r-force", force: true }, "admin");
  assert.equal(viewer.frames.length, 0, "还没拿到设备快照，不应回 viewer");
  assert.equal(usageConn.frames.filter((f) => f.type === "usage_refresh").length, 1);
  assert.equal(broker.pending.has("dev-low22"), true);

  broker.onSnapshot("dev-low22", "admin", { snapshot: usageSnapshot() }); // 不带请求号
  assert.equal(viewer.frames.length, 0, "无请求号的快照不能结案");
  assert.equal(broker.pending.has("dev-low22"), true, "pending 必须保留给真正的刷新结果");

  broker.onSnapshot("dev-low22", "admin", { requestId: "wrong-id", snapshot: usageSnapshot() });
  assert.equal(viewer.frames.length, 0, "错请求号同样不能结案");
  assert.equal(broker.pending.has("dev-low22"), true);

  const relayRequestId = broker.pending.get("dev-low22").relayRequestId;
  broker.onSnapshot("dev-low22", "admin", { requestId: relayRequestId, snapshot: usageSnapshot() });
  assert.equal(viewer.frames.length, 1);
  assert.equal(viewer.frames[0].requestId, "r-force", "回带 viewer 自己的请求号");
  assert.equal(viewer.frames[0].stale, false);
  assert.equal(broker.pending.has("dev-low22"), false);
});

test("低-23：usage summary 与 days 明细对不上时拒收（字段类型/总量/峰值/streak）", () => {
  const base = usageSnapshot();
  assert.equal(validateUsageSnapshot(base).ok, true, "合法快照仍通过");

  const tooBig = JSON.parse(JSON.stringify(base));
  tooBig.summary.totals.tokens = 999;
  const big = validateUsageSnapshot(tooBig);
  assert.equal(big.ok, false);
  assert.ok(big.errors.some((e) => e.includes("与 days 合计不一致")), big.errors.join(";"));

  const badType = JSON.parse(JSON.stringify(base));
  badType.summary.totals.tokens = "10";
  const typed = validateUsageSnapshot(badType);
  assert.equal(typed.ok, false);
  assert.ok(typed.errors.some((e) => e.includes("summary.totals.tokens 非法")), typed.errors.join(";"));

  const badStreak = JSON.parse(JSON.stringify(base));
  badStreak.summary.streaks = { current: 5, longest: 1 };
  assert.equal(validateUsageSnapshot(badStreak).ok, false, "current > longest 不可能");

  const badPeak = JSON.parse(JSON.stringify(base));
  badPeak.summary.peaks.tokens = { date: "2020-01-01", value: 1 };
  const peak = validateUsageSnapshot(badPeak);
  assert.equal(peak.ok, false);
  assert.ok(peak.errors.some((e) => e.includes("日期不在 days")), peak.errors.join(";"));

  const badPeakValue = JSON.parse(JSON.stringify(base));
  badPeakValue.summary.peaks.tokens.value = 999;
  const peakValue = validateUsageSnapshot(badPeakValue);
  assert.equal(peakValue.ok, false);
  assert.ok(peakValue.errors.some((e) => e.includes("与 days 明细不一致")), peakValue.errors.join(";"));
});

/* ---------------- 低-24：零观察不推假完成 ---------------- */

test("低-24：一个 message_end 都没观察到的落定不推 turn_done；有观察时保留既有完成口径", () => {
  const calls = [];
  const notifier = createNotifier(
    { notifyWebhookUrl: "http://127.0.0.1:9/lowfix-topic", notifyEvents: { turn_done: true, turn_error: true, dialog_waiting: true } },
    {
      log: () => {},
      fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200 }; },
    },
  );
  const room = { id: "room-low24", label: "测试" };
  notifier.observe(room, { type: "agent_start" });
  notifier.observe(room, { type: "agent_settled" });
  assert.equal(calls.length, 0, "没有助手终态/任何消息时不能默认报完成");

  // 兼容口径：只观察到用户消息（或只有中间态）时仍按完成报——与 rooms 摘要副本的等价性测试同源。
  notifier.observe(room, { type: "agent_start" });
  notifier.observe(room, { type: "message_end", message: { role: "user" } });
  notifier.observe(room, { type: "agent_settled" });
  assert.deepEqual(calls.map((c) => c.kind), ["turn_done"]);
});

/* ---------------- 低-25：偏好部分子集按字段合并 ---------------- */

test("低-25：prefs 部分子集按字段合并（mobileNav 不清外观字段），落后 baseRev 仍以到达顺序裁决", () => {
  const dir = tmpDir("pi-low25-");
  try {
    const store = new PrefsStore(dir);
    const base = { theme: "sea", chrome: "codex", font: "inter", size: 14, mono: "system" };
    assert.equal(store.set("admin", { ...base }, 1000, 0).rev, 1);
    const r2 = store.set("admin", { mobileNav: "drawer" }, 2000, 1);
    assert.equal(r2.rev, 2);
    assert.deepEqual(r2.subset, { ...base, mobileNav: "drawer" }, "只上行 mobileNav 时外观五字段不能被清空");

    const r3 = store.set("admin", { size: 16 }, 3000, 1); // baseRev 落后（当前 2）
    assert.equal(r3.rev, 3);
    assert.equal(r3.subset.theme, "sea", "另一端的 theme 仍在");
    assert.equal(r3.subset.size, 16, "本次变化字段生效");
    assert.equal(r3.subset.mobileNav, "drawer", "其它字段保留");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 低-26：根目录 / 的路径归一 ---------------- */

test("低-26：根目录 / 能匹配项目/浏览根，不再归一成空串", () => {
  assert.equal(normPath("/", "linux"), "/");
  assert.equal(normPath("///", "linux"), "/");
  assert.equal(normPath("", "linux"), "", "空输入仍是空");
  assert.equal(normPath("/srv/X//", "linux"), "/srv/X", "既有去尾斜杠不变");
  assert.equal(cwdAllowed(["/"], "/", "linux"), true, "项目根就是 / 时 cwd=/ 应放行");
  assert.equal(cwdAllowed(["/"], "/srv", "linux"), false, "cwdAllowed 仍是精确匹配");
  assert.equal(underRoots(["/"], "/tmp/anywhere", "linux"), true, "浏览根为 / 时其下任意目录都应在范围内");
  assert.equal(underRoots(["/"], "/", "linux"), true);
});

/* ---------------- 低-19：切房订阅失败不能丢原订阅 ---------------- */

test("低-19：切房因房间满失败时保留原房间订阅；成功切房仍摘旧房", async (t) => {
  const relay = await boot({ maxViewersPerRoom: 1 });
  const a = await wsClient(relay.viewerPort);
  const b = await wsClient(relay.viewerPort);
  t.after(async () => {
    a.close();
    b.close();
    await relay.close();
  });

  const roomA = relay.rooms.get("low19-a");
  const roomB = relay.rooms.get("low19-b");
  const roomC = relay.rooms.get("low19-c");

  for (const client of [a, b]) {
    client.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
    assert.equal((await client.type("auth_result")).ok, true);
  }

  b.send({ type: "subscribe", room: roomB.id });
  await b.type("subscribed");
  a.send({ type: "subscribe", room: roomA.id });
  await a.type("subscribed");
  const aServer = [...roomA.viewers][0];
  assert.ok(aServer, "A 应已进 roomA");
  assert.equal(roomA.viewers.size, 1);
  assert.equal(roomB.viewers.size, 1);
  // 旧实现会在 room_full 报错前先摘旧房，并把这条兜底等待者也一起过滤掉
  roomA.resendWaiters = [aServer];

  a.send({ type: "subscribe", room: roomB.id });
  const err = await a.type("error");
  assert.equal(err.code, "room_full");
  assert.equal(roomA.viewers.has(aServer), true, "失败切房后原房间仍应包含该 viewer");
  assert.equal(roomA.viewers.size, 1);
  assert.deepEqual(roomA.resendWaiters, [aServer], "失败切房不能清掉原房间的兜底等待名单");
  assert.equal(roomB.viewers.size, 1, "失败切房不能偷偷进新房间");

  // 成功切到还有空位的房间时，旧订阅仍要正常摘掉
  a.send({ type: "subscribe", room: roomC.id });
  await a.type("subscribed");
  assert.equal(roomA.viewers.size, 0);
  assert.equal(roomC.viewers.size, 1);
  assert.equal(roomB.viewers.size, 1);
});
