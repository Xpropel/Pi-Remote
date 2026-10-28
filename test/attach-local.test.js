"use strict";
/**
 * 免服务器（本地）模式：模式判定、lanOrigin 打分、currentViewerOrigin 三级优先、
 * LocalKeeper 管家顺序（假 relay 脚本驱动：就绪前不返回、探活命中不接管、崩溃重拉、孤儿回收）、
 * setup --local 生成物、--link 隧道换源重出示同一枚码、--share 双源出示、doctor 本地行。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const attach = require("../deploy/attach.cjs");
const setup = require("../deploy/setup.cjs");

function tmpDir(prefix = "pi-attach-local-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function until(fn, what, ms = 8000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("等待超时：" + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- lanOrigin / 打分 / 出示源 ---------------- */

const IFACES = {
  lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, mac: "00:00:00:00:00:00" }],
  eth0: [{ address: "192.168.1.10", family: "IPv4", internal: false, mac: "aa" }],
  wlan0: [{ address: "192.168.1.11", family: "IPv4", internal: false, mac: "bb" }],
  utun3: [{ address: "10.8.0.2", family: "IPv4", internal: false, mac: "cc" }],
  docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false, mac: "dd" }],
  eth9: [{ address: "169.254.4.5", family: "IPv4", internal: false, mac: "ee" }],
  v6only: [{ address: "fe80::1", family: "IPv6", internal: false, mac: "ff" }],
};

test("rankLanCandidates：剔内部/IPv6/link-local，默认路由源置顶，虚拟网卡降分", () => {
  const ranked = attach.rankLanCandidates(IFACES, "192.168.1.10");
  assert.equal(ranked[0].address, "192.168.1.10");
  const names = ranked.map((c) => c.address);
  assert.ok(!names.includes("127.0.0.1"), "内部地址被剔");
  assert.ok(!names.includes("169.254.4.5"), "link-local 被剔");
  assert.ok(!names.includes("fe80::1"), "IPv6 被剔");
  const noRoute = attach.rankLanCandidates(IFACES, "");
  const idx = (addr) => noRoute.findIndex((c) => c.address === addr);
  assert.ok(idx("192.168.1.10") < idx("10.8.0.2"), "物理网卡排在 utun 前");
  assert.ok(idx("192.168.1.10") < idx("172.17.0.1"), "物理网卡排在 docker 前");
});

test("lanOrigin：主地址=默认路由源，候选与备选齐全；端口跟随参数；无地址时 origin 为空", async () => {
  const lan = await attach.lanOrigin(7002, { defaultRouteAddress: "192.168.1.10", networkInterfaces: () => IFACES });
  assert.equal(lan.address, "192.168.1.10");
  assert.equal(lan.origin, "http://192.168.1.10:7002/");
  assert.ok(lan.candidates.length >= 3);
  assert.ok(!lan.alternatives.includes("http://192.168.1.10:7002/"));
  assert.ok(lan.alternatives.includes("http://192.168.1.11:7002/"));
  const lan8080 = await attach.lanOrigin(8080, { defaultRouteAddress: "192.168.1.10", networkInterfaces: () => IFACES });
  assert.equal(lan8080.origin, "http://192.168.1.10:8080/");
  const none = await attach.lanOrigin(7002, { defaultRouteAddress: "", networkInterfaces: () => ({}) });
  assert.equal(none.origin, "");
});

test("currentViewerOrigin：隧道 > 局域网（回环 relay 时）> 推导；服务器模式行为不变", () => {
  const base = { relay: "ws://127.0.0.1:7001", viewerPort: 7002, lan: "http://192.168.1.10:7002/" };
  assert.equal(attach.currentViewerOrigin({ ...base, tunnelUrl: "https://a-b.trycloudflare.com" }), "https://a-b.trycloudflare.com/");
  assert.equal(attach.currentViewerOrigin(base), "http://192.168.1.10:7002/");
  assert.equal(attach.currentViewerOrigin({ ...base, lan: "" }), "http://127.0.0.1:7002/");
  // 服务器模式：给了 lan 也不用，走 relay 推导（与旧行为一致）
  assert.equal(attach.currentViewerOrigin({ relay: "wss://example.com:7001", viewerPort: 7002, lan: "http://192.168.1.10:7002/" }), "https://example.com:7002/");
  assert.equal(attach.currentViewerOrigin({ relay: "ws://1.2.3.4:7001", viewerPort: 7002 }), "http://1.2.3.4:7002/");
});

/* ---------------- 模式判定 ---------------- */

function rootWithConfig(t, cfg = { localPort: 7001, viewerPort: 7002 }) {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "relay"), { recursive: true });
  if (cfg) fs.writeFileSync(path.join(root, "relay", "config.json"), JSON.stringify(cfg));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("localModeInfo：回环+端口对上才是本地模式；远端/端口对不上/无配置都不是", (t) => {
  const root = rootWithConfig(t);
  assert.equal(attach.localModeInfo("ws://127.0.0.1:7001", root).local, true);
  assert.equal(attach.localModeInfo("ws://localhost:7001", root).local, true);
  assert.equal(attach.localModeInfo("ws://127.0.0.1:17001", root).local, false);
  assert.equal(attach.localModeInfo("wss://example.com:7001", root).local, false);
  const bare = rootWithConfig(t, null);
  const info = attach.localModeInfo("ws://127.0.0.1:7001", bare);
  assert.equal(info.local, false);
  assert.equal(info.configExists, false);
});

/* ---------------- 管家（假 relay 脚本驱动） ---------------- */

const STUB_RELAY = `"use strict";
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const marker = process.env.STUB_MARKER || "";
if (marker) fs.appendFileSync(marker, "start\\n");
if (process.env.STUB_STDERR) console.error(process.env.STUB_STDERR);
const delay = Number(process.env.STUB_DELAY_MS || 0);
const dieAfter = Number(process.env.STUB_DIE_AFTER_MS || 0);
const dieOnceFile = process.env.STUB_DIE_ONCE_FILE || "";
setTimeout(() => {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); return; }
    res.writeHead(404); res.end();
  });
  server.listen(cfg.viewerPort, "127.0.0.1", () => {
    if (dieAfter > 0) {
      let shouldDie = true;
      if (dieOnceFile) {
        if (fs.existsSync(dieOnceFile)) shouldDie = false;
        else fs.writeFileSync(dieOnceFile, "1");
      }
      if (shouldDie) setTimeout(() => process.exit(3), dieAfter);
    }
  });
}, delay);
`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function keeperFixture(t, stubEnv = {}) {
  const root = tmpDir();
  const viewerPort = await freePort();
  const localPort = await freePort();
  fs.mkdirSync(path.join(root, "relay"), { recursive: true });
  fs.writeFileSync(path.join(root, "relay", "server.js"), STUB_RELAY);
  const config = { localPort, viewerPort, localToken: "x".repeat(20), viewerToken: "y".repeat(20), adminToken: "z".repeat(20) };
  fs.writeFileSync(path.join(root, "relay", "config.json"), JSON.stringify(config));
  const stateFile = path.join(root, "keeper-state.json");
  const marker = path.join(root, "marker.log");
  const keeper = attach.createLocalKeeper({
    root,
    config,
    relay: `ws://127.0.0.1:${localPort}`,
    stateFile,
    out: () => {},
    env: { ...process.env, STUB_MARKER: marker, ...stubEnv },
    lanDeps: { defaultRouteAddress: "", networkInterfaces: () => ({}) },
  });
  t.after(async () => {
    await keeper.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, viewerPort, localPort, stateFile, marker, keeper };
}

test("管家顺序：relay 就绪后 ensureRelay 才返回；管家状态文件写有 pid；stop 后 relay 真的没了", async (t) => {
  const { keeper, viewerPort, stateFile } = await keeperFixture(t, { STUB_DELAY_MS: "700" });
  const t0 = Date.now();
  const ensured = await keeper.ensureRelay();
  const elapsed = Date.now() - t0;
  assert.equal(ensured.owned, true);
  assert.ok(elapsed >= 600, `应当等 relay 就绪（实际 ${elapsed}ms）`);
  assert.equal(await attach.httpHealthz(viewerPort, 1000), true);
  const rec = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.ok(rec.relayPid > 0);
  assert.equal(rec.ownerPid, process.pid);
  await keeper.stop();
  assert.equal(await attach.httpHealthz(viewerPort, 800), false);
  assert.equal(fs.existsSync(stateFile), false);
});

test("管家：已有健康 relay（别人拉起的）直接用，stop 不杀它", async (t) => {
  const { root, config, viewerPort, keeper } = await keeperFixture(t);
  const foreign = spawn(process.execPath, [path.join(root, "relay", "server.js")], { cwd: root, stdio: "ignore", env: { ...process.env } });
  t.after(() => {
    try {
      foreign.kill("SIGKILL");
    } catch {}
  });
  await until(() => attach.httpHealthz(viewerPort, 500), "外部 relay 就绪");
  const ensured = await keeper.ensureRelay();
  assert.equal(ensured.owned, false);
  await keeper.stop();
  assert.equal(await attach.httpHealthz(viewerPort, 800), true, "别人的 relay 不能被 stop 杀掉");
  foreign.kill("SIGKILL");
  await until(async () => !(await attach.httpHealthz(viewerPort, 400)), "外部 relay 已收尾");
  assert.ok(config);
});

test("管家：自有 relay 崩溃后退避重拉并恢复健康", async (t) => {
  // die-once 文件用相对名：假 relay 的工作目录就是 fixture 根，标记落在那里，第二次拉起就不再自杀
  const { keeper, viewerPort, marker } = await keeperFixture(t, {
    STUB_DIE_AFTER_MS: "400",
    STUB_DIE_ONCE_FILE: "die-once.flag",
  });
  const ensured = await keeper.ensureRelay();
  assert.equal(ensured.owned, true);
  assert.equal(await attach.httpHealthz(viewerPort, 800), true);
  // 第一次会自己死（die-once 文件在第一次启动时落盘），等它死透再等重拉恢复
  await until(async () => !(await attach.httpHealthz(viewerPort, 400)), "relay 第一次崩溃", 6000);
  await until(() => attach.httpHealthz(viewerPort, 600), "relay 被重拉恢复", 12000);
  const starts = fs.readFileSync(marker, "utf8").trim().split("\n").length;
  assert.ok(starts >= 2, `至少拉起两次（实际 ${starts}）`);
  await keeper.stop();
});

test("管家：上个管家已死时回收它拉起的孤儿 relay（命令行核对后才杀）", async (t) => {
  const { root, config, viewerPort, stateFile, keeper } = await keeperFixture(t);
  // 手工拉一个 relay 当孤儿，再写下「owner 已死」的管家记录
  const orphan = spawn(process.execPath, [path.join(root, "relay", "server.js")], { cwd: root, stdio: "ignore", detached: true, env: { ...process.env } });
  orphan.unref();
  t.after(() => {
    try {
      process.kill(orphan.pid, "SIGKILL");
    } catch {}
  });
  await until(() => attach.httpHealthz(viewerPort, 500), "孤儿 relay 就绪");
  fs.writeFileSync(stateFile, JSON.stringify({ ownerPid: 999999, relayPid: orphan.pid, relayOwned: true, tunnelPid: 0, tunnelArgs: [] }));
  const ensured = await keeper.ensureRelay();
  assert.equal(ensured.owned, true, "孤儿回收后由本管家重新拉起");
  assert.equal(await attach.httpHealthz(viewerPort, 800), true);
  assert.throws(() => process.kill(orphan.pid, 0), /ESRCH/, "孤儿进程已被回收");
  assert.ok(config);
});

test("管家：relay 起不来时报错带子进程输出尾巴", async (t) => {
  const fx = await keeperFixture(t, { STUB_DELAY_MS: "60000", STUB_STDERR: "boom-marker-123" });
  const k2 = attach.createLocalKeeper({
    root: fx.root,
    config: fx.config,
    relay: `ws://127.0.0.1:${fx.config.localPort}`,
    stateFile: fx.stateFile,
    out: () => {},
    env: { ...process.env, STUB_MARKER: fx.marker, STUB_DELAY_MS: "60000", STUB_STDERR: "boom-marker-123" },
    lanDeps: { defaultRouteAddress: "", networkInterfaces: () => ({}) },
    readyTimeoutMs: 1200,
  });
  t.after(() => k2.stop().catch(() => {}));
  await assert.rejects(() => k2.ensureRelay(), /boom-marker-123/);
});

test("管家：隧道启动阶段失败只通报一次（带原因）；就绪后掉线也只通报一次", async (t) => {
  const root = rootWithConfig(t);
  const stateFile = path.join(root, "keeper-state.json");
  const notes = [];
  let captured = null;
  let readyControl = null;
  const keeper = attach.createLocalKeeper({
    root,
    config: { localPort: 7001, viewerPort: 7002 },
    relay: "ws://127.0.0.1:7001",
    stateFile,
    out: () => {},
    onTunnel: (info) => notes.push(info),
    resolveCloudflared: async () => ({ bin: "/fake/cloudflared", source: "path", version: "2026.10.4" }),
    tunnelStartImpl: (o) => {
      captured = o;
      const ready = new Promise((resolve, reject) => {
        readyControl = { resolve, reject };
      });
      ready.catch(() => {});
      return { args: ["tunnel"], child: () => null, ready, stop: async () => {} };
    },
  });
  t.after(() => keeper.stop().catch(() => {}));

  // 启动阶段进程退出：onExit 先到（不报），ready 拒绝随后到（报一次，带具体原因）
  await keeper.startTunnel();
  captured.onExit({ code: 1, signal: null });
  assert.equal(notes.filter((n) => n.status === "failed").length, 0, "启动阶段 onExit 不抢报");
  readyControl.reject(new Error("cloudflared 在隧道就绪前退出（code 1）：boom"));
  await sleep(20);
  const failed1 = notes.filter((n) => n.status === "failed");
  assert.equal(failed1.length, 1);
  assert.match(failed1[0].error, /boom/);
  await keeper.stop();

  // 就绪后掉线：onReady 已报 ready，onExit 报一次 failed
  notes.length = 0;
  const keeper2 = attach.createLocalKeeper({
    root,
    config: { localPort: 7001, viewerPort: 7002 },
    relay: "ws://127.0.0.1:7001",
    stateFile,
    out: () => {},
    onTunnel: (info) => notes.push(info),
    resolveCloudflared: async () => ({ bin: "/fake/cloudflared", source: "path", version: "2026.10.4" }),
    tunnelStartImpl: (o) => {
      captured = o;
      return {
        args: ["tunnel"],
        child: () => null,
        ready: Promise.resolve({ url: "https://a-b.trycloudflare.com" }),
        stop: async () => {},
      };
    },
  });
  t.after(() => keeper2.stop().catch(() => {}));
  await keeper2.startTunnel();
  captured.onUrl("https://a-b.trycloudflare.com");
  captured.onReady("https://a-b.trycloudflare.com");
  assert.equal(keeper2.tunnelState().status, "ready");
  captured.onExit({ code: 0, signal: null });
  const failed2 = notes.filter((n) => n.status === "failed");
  assert.equal(failed2.length, 1);
  assert.match(failed2[0].error, /退出了/);
  assert.equal(keeper2.origin(), "http://127.0.0.1:7002/", "掉线后出示源回落");
  await keeper2.stop();
});

/* ---------------- setup --local ---------------- */

function setupFixture(t) {
  const root = tmpDir("pi-setup-local-");
  fs.copyFileSync(path.join(__dirname, "..", ".env.example"), path.join(root, ".env.example"));
  fs.mkdirSync(path.join(root, "relay"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("setup --local：config.json 0600、三令牌互不相同、.env 指向回环且 token 与配置一致、输出不回显令牌", (t) => {
  const root = setupFixture(t);
  const lines = [];
  const r = setup.setupLocal({ root, hostname: "test-host", writeOut: (l) => lines.push(l), writeErr: (l) => lines.push(l) });
  assert.equal(r.code, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "relay", "config.json"), "utf8"));
  assert.equal(cfg.localPort, 7001);
  assert.equal(cfg.viewerPort, 7002);
  assert.equal(cfg.localHost, "127.0.0.1");
  assert.equal(cfg.viewerHost, "0.0.0.0");
  assert.equal(cfg.serverName, "test-host");
  assert.equal(cfg.tunnel.mode, "quick");
  const tokens = [cfg.localToken, cfg.viewerToken, cfg.adminToken];
  assert.equal(new Set(tokens).size, 3, "三令牌互不相同");
  for (const tok of tokens) assert.ok(tok.length >= 40, "32 字节 base64url 令牌");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(root, "relay", "config.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, ".env")).mode & 0o777, 0o600);
  }
  const envText = fs.readFileSync(path.join(root, ".env"), "utf8");
  assert.match(envText, /^PI_REMOTE_RELAY=ws:\/\/127\.0\.0\.1:7001$/m);
  const tokenLine = envText.match(/^PI_REMOTE_TOKEN=(.*)$/m);
  assert.equal(tokenLine[1], cfg.localToken);
  const printed = lines.join("\n");
  for (const tok of tokens) assert.ok(!printed.includes(tok), "终端输出不许回显令牌");
  assert.match(printed, /attach.*--link/);
});

test("setup --local：已有文件拒绝覆盖（一个都不写）；--force 重建并轮换全部令牌", (t) => {
  const root = setupFixture(t);
  const quiet = { writeOut: () => {}, writeErr: () => {} };
  const r1 = setup.setupLocal({ root, hostname: "h", ...quiet });
  assert.equal(r1.code, 0);
  const cfgBefore = fs.readFileSync(path.join(root, "relay", "config.json"), "utf8");
  const envBefore = fs.readFileSync(path.join(root, ".env"), "utf8");
  const r2 = setup.setupLocal({ root, hostname: "h", ...quiet });
  assert.equal(r2.code, 1);
  assert.equal(fs.readFileSync(path.join(root, "relay", "config.json"), "utf8"), cfgBefore);
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), envBefore);
  const errs = [];
  const r3 = setup.setupLocal({ root, hostname: "h", force: true, writeOut: () => {}, writeErr: (l) => errs.push(l) });
  assert.equal(r3.code, 0);
  const cfgAfter = JSON.parse(fs.readFileSync(path.join(root, "relay", "config.json"), "utf8"));
  const before = JSON.parse(cfgBefore);
  assert.notEqual(cfgAfter.localToken, before.localToken);
  assert.notEqual(cfgAfter.viewerToken, before.viewerToken);
  assert.notEqual(cfgAfter.adminToken, before.adminToken);
  assert.match(errs.join("\n"), /轮换/);
});

/* ---------------- --link 换源重出示 ---------------- */

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

test("--link：隧道就绪后换源重出示同一枚码；落盘流程不变", async (t) => {
  FakeWS.reset();
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:17001\nPI_REMOTE_DEVICE_NAME=测试机\n", { mode: 0o600 });
  const outLines = [];
  let originCb = null;
  const fakeKeeper = {
    _origin: "http://192.168.1.10:7002/",
    async ensureRelay() {
      return { owned: true, healthy: true };
    },
    origin() {
      return this._origin;
    },
    setOnOriginChange(fn) {
      originCb = fn;
    },
    async startTunnel() {
      setTimeout(() => {
        this._origin = "https://abc-def.trycloudflare.com/";
        if (originCb) originCb();
      }, 30);
      return { status: "starting", url: "" };
    },
    async stop() {},
  };
  const args = attach.parseArgs(["--link", "--tunnel"]);
  const linkPromise = attach.linkMain(args, envPath, {
    env: {},
    platform: "darwin",
    WebSocketImpl: FakeWS,
    writeOut: (l) => outLines.push(l),
    writeErr: (l) => outLines.push(l),
    timeoutMs: 3000,
    bindSignals: false,
    linkWindow: false,
    doneLingerMs: 0,
    regenGraceMs: 0,
    terminalWidth: 200,
    keeperFactory: () => fakeKeeper,
    root: dir,
  });
  const ws = await until(() => FakeWS.instances[0], "link 的 WS 已建立");
  await until(() => ws.sent.find((f) => f.type === "pair_request"), "pair_request 已发出");
  ws.push({ type: "pair_request_result", code: "ABCD1234", expiresAt: Date.now() + 600000, checkDigits: "42" });
  await until(() => outLines.some((l) => l.includes("http://192.168.1.10:7002/#pair=ABCD1234")), "先按局域网地址出示");
  await until(() => outLines.some((l) => l.includes("https://abc-def.trycloudflare.com/#pair=ABCD1234")), "隧道就绪后换源重出示同一枚码");
  ws.push({ type: "pair_result", ok: true, deviceId: "dev-1", deviceToken: "dev-token-1234567890" });
  const code = await linkPromise;
  assert.equal(code, 0);
  const envText = fs.readFileSync(envPath, "utf8");
  assert.match(envText, /PI_REMOTE_DEVICE_ID=dev-1/);
  assert.match(envText, /PI_REMOTE_DEVICE_TOKEN=dev-token-1234567890/);
});

/* ---------------- --share ---------------- */

test("--share：双源出示（局域网 + 隧道），Ctrl-C 后管家回收且退出码 130", async (t) => {
  const root = rootWithConfig(t);
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_NAME=测试机\n", { mode: 0o600 });
  const outLines = [];
  let stopped = false;
  const signalSource = new EventEmitter();
  const fakeKeeper = {
    async ensureRelay() {
      return { owned: true, healthy: true };
    },
    lanInfo() {
      return { origin: "http://192.168.1.10:7002/", alternatives: ["http://10.0.0.5:7002/"], candidates: [] };
    },
    async startTunnel() {
      this._opts.onTunnel({ status: "ready", url: "https://abc-def.trycloudflare.com" });
      return { status: "ready", url: "https://abc-def.trycloudflare.com" };
    },
    async stop() {
      stopped = true;
    },
  };
  const sharePromise = attach.shareMain(attach.parseArgs(["--share"]), envPath, {
    env: {},
    platform: "linux",
    root,
    writeOut: (l) => outLines.push(l),
    writeErr: (l) => outLines.push(l),
    shareWindow: false,
    signalSource,
    terminalWidth: 200,
    keeperFactory: (o) => {
      fakeKeeper._opts = o;
      return fakeKeeper;
    },
  });
  await until(() => outLines.some((l) => l.includes("https://abc-def.trycloudflare.com")), "隧道地址已出示");
  assert.ok(outLines.some((l) => l.includes("http://192.168.1.10:7002/")), "局域网地址已出示");
  assert.ok(outLines.some((l) => l.includes("http://10.0.0.5:7002/")), "备选地址已出示");
  signalSource.emit("SIGINT");
  const code = await sharePromise;
  assert.equal(code, 130);
  assert.equal(stopped, true);
});

test("--share：非本地模式直接拒绝并指路 setup --local", async (t) => {
  const root = rootWithConfig(t, null);
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=wss://example.com:7001\n", { mode: 0o600 });
  const errs = [];
  const code = await attach.shareMain(attach.parseArgs(["--share"]), envPath, {
    env: {},
    root,
    writeOut: () => {},
    writeErr: (l) => errs.push(l),
    shareWindow: false,
    bindSignals: false,
  });
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /setup\.cjs --local/);
});

test("分享窗口状态：双源 + 隧道状态 + 二维码 SVG 齐全", async (t) => {
  const state = {
    deviceName: "测试机",
    platformLabel: "Linux",
    lanUrl: "http://192.168.1.10:7002/",
    lanCandidates: [],
    tunnel: { status: "ready", url: "https://abc-def.trycloudflare.com", error: "" },
  };
  const json = attach.shareWindowStateJson(state);
  assert.equal(json.tunnelStatus, "ready");
  assert.equal(json.tunnelUrl, "https://abc-def.trycloudflare.com");
  assert.match(json.tunnelQrSvg, /<svg/);
  assert.match(json.lanQrSvg, /<svg/);
  const win = await attach.startShareWindowServer(state);
  t.after(() => win && win.close());
  assert.ok(win);
  const html = await new Promise((resolve, reject) => {
    http.get(win.url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    }).on("error", reject);
  });
  assert.match(html, /分享访问地址/);
  assert.match(html, /公网地址/);
  assert.match(html, /局域网地址/);
});

/* ---------------- doctor 本地行 ---------------- */

test("doctor：本地模式行 + 隧道目标异常核对（记录指向本地通道必须报 fail）", async (t) => {
  const root = rootWithConfig(t);
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(
    envPath,
    ["PI_REMOTE_RELAY=ws://127.0.0.1:7001", "PI_REMOTE_DEVICE_ID=dev-1", "PI_REMOTE_TOKEN=" + "t".repeat(20), ""].join("\n"),
    { mode: 0o600 },
  );
  const attachFile = path.join(dir, "remote-attach.json");
  const doctorEnv = { PI_REMOTE_ATTACH_FILE: attachFile, PI_CODING_AGENT_DIR: path.join(dir, "agent") };
  // 管家记录里放一组指向本地通道（7001）的坏隧道参数
  fs.writeFileSync(
    path.join(dir, "pi-remote-local.json"),
    JSON.stringify({ ownerPid: 999999, relayPid: 0, tunnelPid: 0, tunnelUrl: "https://a-b.trycloudflare.com", tunnelArgs: ["tunnel", "--url", "http://127.0.0.1:7001", "--no-autoupdate", "--metrics", "127.0.0.1:20241"] }),
  );
  const rows = [];
  await attach.doctorMain(attach.parseArgs(["--doctor"]), envPath, {
    env: doctorEnv,
    root,
    platform: "linux",
    writeOut: (l) => rows.push(l),
    healthProbe: async () => true,
    resolveCloudflared: async () => {
      throw new Error("not installed");
    },
    spawnSyncImpl: () => ({ status: 1, stdout: "", error: new Error("nope") }),
    probe: async () => ({ ok: true }),
  });
  const text = rows.join("\n");
  assert.match(text, /免服务器模式/);
  assert.match(text, /本地 relay.*healthz 正常/);
  assert.match(text, /cloudflared/);
  assert.match(text, /隧道目标异常/);
});
