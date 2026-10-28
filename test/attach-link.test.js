"use strict";
/**
 * attach --link 的帧交互（假 WebSocketImpl 驱动，不连真 relay）：
 * pair_request → pair_request_result 出示（终端打印链接/对照码/核对字/字符二维码）
 * → pair_result 复用 pairMain 落盘段写 .env；外加过期、旧 relay、断线、Ctrl-C、窗口页五条路径。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const attach = require("../deploy/attach.cjs");

const RELAY = "ws://127.0.0.1:17001";
const DEVICE_ID = "11111111-2222-3333-4444-555555555555";
const DEVICE_TOKEN = "link-device-token-0123456789abcdef";

class FakeWS extends EventEmitter {
  static instances = [];
  static reset() {
    FakeWS.instances = [];
  }
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWS.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
  }
  push(obj) {
    this.emit("message", JSON.stringify(obj));
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-link-"));
}

async function until(fn, what, ms = 3000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("等待超时：" + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function baseOpts(extra = {}) {
  return {
    env: {},
    platform: "darwin",
    WebSocketImpl: FakeWS,
    writeOut: () => {},
    writeErr: () => {},
    timeoutMs: 3000,
    bindSignals: false,
    linkWindow: false,
    doneLingerMs: 0,
    regenGraceMs: 0,
    terminalWidth: 120,
    ...extra,
  };
}

function startLink(t, extra = {}) {
  FakeWS.reset();
  const dir = tmpDir();
  t.after(() => {
    // 断言中途失败时也要把悬着的尝试收掉，别让进程陪等到码过期
    for (const ws of FakeWS.instances) {
      try {
        ws.emit("close");
      } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const envPath = path.join(dir, ".env");
  const logs = [];
  const errs = [];
  const opts = baseOpts({
    writeOut: (line) => logs.push(String(line)),
    writeErr: (line) => errs.push(String(line)),
    ...extra,
  });
  const promise = attach.linkMain({ relay: RELAY }, envPath, opts);
  return { dir, envPath, logs, errs, promise };
}

async function firstWs() {
  return until(() => FakeWS.instances[0], "第一条 WS 连接");
}

async function sentRequest(ws) {
  return until(() => ws.sent.find((f) => f.type === "pair_request"), "pair_request 首帧");
}

test("--link 主链路：pair_request 首帧 → 出示打印 → pair_result 落盘 .env", async (t) => {
  const { envPath, logs, errs, promise } = startLink(t);
  const ws = await firstWs();
  const req = await sentRequest(ws);
  assert.equal(req.device.platform, "macos");
  assert.equal(typeof req.device.name, "string");
  assert.ok(req.device.name.length > 0);

  ws.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 120000, checkDigits: "42" });
  const shown = await until(() => logs.join("\n").includes("设备对照码：K7Q4-MX2P") && logs, "终端出示对照码");
  const text = shown.join("\n");
  assert.ok(text.includes("http://127.0.0.1:7002/#pair=K7Q4MX2P"), "应打印完整链接（viewer 源 + #pair=裸码）");
  assert.ok(text.includes("核对字：42"), "应打印 relay 下发的核对字");
  assert.ok(text.includes("不要拍照转发"), "应打印防转发提示");
  assert.ok(logs.some((line) => line.includes("█")), "终端宽度够时应画出字符二维码");

  ws.push({ type: "pair_result", ok: true, accountId: "admin", deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN });
  const rc = await promise;
  assert.equal(rc, 0, errs.join("\n"));
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(cfg.deviceId, DEVICE_ID);
  assert.equal(cfg.deviceToken, DEVICE_TOKEN);
  assert.equal(cfg.relay, RELAY, "--relay 指定的地址应一并落盘（与 pairMain 同口径）");
  assert.equal(logs.join("\n").includes(DEVICE_TOKEN), false, "令牌不能打印出来");
  assert.match(logs.join("\n"), /链接成功/);
  if (process.platform !== "win32") assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), "600");
});

test("--link 过期：本地到点收尾，退出码 1，不落 .env", async (t) => {
  const { envPath, logs, errs, promise } = startLink(t);
  const ws = await firstWs();
  await sentRequest(ws);
  ws.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 60, checkDigits: "42" });
  const rc = await promise;
  assert.equal(rc, 1);
  assert.match(errs.join("\n"), /已过期/);
  assert.match(logs.join("\n"), /--link/, "过期提示应指引重跑 --link");
  assert.equal(fs.existsSync(envPath), false, "过期不能写令牌文件");
});

test("--link 过期帧：relay 发 pair_expired 立即收尾", async (t) => {
  const { envPath, errs, promise } = startLink(t);
  const ws = await firstWs();
  await sentRequest(ws);
  ws.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 120000 });
  await new Promise((r) => setTimeout(r, 20));
  ws.push({ type: "pair_expired" });
  const rc = await promise;
  assert.equal(rc, 1);
  assert.match(errs.join("\n"), /已过期/);
  assert.equal(fs.existsSync(envPath), false);
});

test("--link 旧 relay：unknown_type → unsupported 并提示改用 --pair", async (t) => {
  const { envPath, errs, promise } = startLink(t);
  const ws = await firstWs();
  await sentRequest(ws);
  ws.push({ type: "error", code: "unknown_type", error: "unknown frame type" });
  const rc = await promise;
  assert.equal(rc, 1);
  const text = errs.join("\n");
  assert.match(text, /unsupported/, "失败行应带 unsupported 码");
  assert.match(text, /版本太旧/);
  assert.match(text, /--pair/, "应提示改用手输配对码");
  assert.equal(fs.existsSync(envPath), false);
});

test("--link 等待中断开：relay 关连接 → offline 收尾", async (t) => {
  const { envPath, errs, promise } = startLink(t);
  const ws = await firstWs();
  await sentRequest(ws);
  ws.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 120000 });
  ws.emit("close");
  const rc = await promise;
  assert.equal(rc, 1);
  assert.match(errs.join("\n"), /offline/);
  assert.equal(fs.existsSync(envPath), false);
});

test("--link 终端太窄时降级：不画字符码，只打印链接和对照码", async (t) => {
  // 本例 URL 的字符码渲染宽 37 列；终端宽 30 时必须降级
  const { logs, promise } = startLink(t, { terminalWidth: 30 });
  const ws = await firstWs();
  await sentRequest(ws);
  ws.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 120000, checkDigits: "07" });
  await until(() => logs.join("\n").includes("设备对照码：K7Q4-MX2P"), "出示对照码");
  const text = logs.join("\n");
  assert.ok(!logs.some((line) => line.includes("█")), "窄终端不应画字符二维码");
  assert.ok(text.includes("没画二维码"), "应说明降级原因");
  assert.ok(text.includes("http://127.0.0.1:7002/#pair=K7Q4MX2P"));
  ws.push({ type: "pair_result", ok: true, deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN });
  assert.equal(await promise, 0);
});

test("--link Ctrl-C：干净退出（关连接、退出码 130、不落盘）", async (t) => {
  const signals = new EventEmitter();
  const { envPath, promise } = startLink(t, { bindSignals: true, signalSource: signals });
  const ws = await firstWs();
  await sentRequest(ws);
  ws.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 120000 });
  signals.emit("SIGINT");
  const rc = await promise;
  assert.equal(rc, 130);
  assert.equal(ws.closed, true, "退出时应关掉等待连接（码随连接作废）");
  assert.equal(fs.existsSync(envPath), false);
  assert.equal(signals.listenerCount("SIGINT"), 0, "退出后应摘掉信号监听");
});

test("--link 窗口页：本机页面四态由 /state 驱动，成功后 phase=done", async (t) => {
  const { logs, promise } = startLink(t, { linkWindow: true, openBrowser: false, doneLingerMs: 30 });
  const winLine = await until(() => logs.find((l) => l.startsWith("链接窗口：")), "窗口地址打印");
  const base = winLine.slice("链接窗口：".length).split("（")[0];
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/$/, "窗口只绑 127.0.0.1 随机端口");

  const pageRes = await fetch(base);
  assert.equal(pageRes.status, 200);
  const html = await pageRes.text();
  assert.ok(html.includes("链接这台设备"));
  assert.ok(html.includes('data-pane="4"'), "四态面板应都在页面里");
  assert.ok(!html.includes("traffic"), "页面不得有红绿灯元素（设计铁规）");

  const ws = await firstWs();
  await sentRequest(ws);
  ws.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 120000, checkDigits: "42" });
  const st = await until(async () => {
    const r = await fetch(base + "state");
    const j = await r.json();
    return j.phase === "waiting" ? j : null;
  }, "/state 进入 waiting");
  assert.equal(st.codeFormatted, "K7Q4-MX2P");
  assert.equal(st.checkDigits, "42");
  assert.ok(st.qrSvg.startsWith("<svg"), "/state 应带真码 SVG");
  assert.ok(st.url.endsWith("#pair=K7Q4MX2P"));

  const regenRes = await fetch(base + "regen", { method: "POST" });
  assert.equal(regenRes.status, 204, "waiting 态的 /regen 应被接受并忽略");

  ws.push({ type: "pair_result", ok: true, deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN });
  assert.equal(await promise, 0);
});

test("--link 窗口页过期后点重新生成：同进程换新码再战一轮", async (t) => {
  const { logs, promise } = startLink(t, { linkWindow: true, openBrowser: false, doneLingerMs: 0, regenGraceMs: 5000 });
  const winLine = await until(() => logs.find((l) => l.startsWith("链接窗口：")), "窗口地址打印");
  const base = winLine.slice("链接窗口：".length).split("（")[0];
  const ws1 = await firstWs();
  await sentRequest(ws1);
  ws1.push({ type: "pair_request_result", code: "K7Q4MX2P", expiresAt: Date.now() + 60, checkDigits: "42" });
  const expired = await until(async () => {
    const r = await fetch(base + "state");
    const j = await r.json();
    return j.phase === "expired" ? j : null;
  }, "/state 进入 expired", 5000);
  assert.ok(expired);
  await fetch(base + "regen", { method: "POST" });
  const ws2 = await until(() => FakeWS.instances[1], "重新生成后的第二条连接");
  const req2 = await sentRequest(ws2);
  assert.equal(req2.type, "pair_request");
  ws2.push({ type: "pair_request_result", code: "AB23CD45", expiresAt: Date.now() + 120000, checkDigits: "07" });
  ws2.push({ type: "pair_result", ok: true, deviceId: DEVICE_ID, deviceToken: DEVICE_TOKEN });
  assert.equal(await promise, 0);
});
