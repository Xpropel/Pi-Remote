"use strict";
/**
 * Phase 4 K-1/K-2 (design ch. 3): the doctor authentication-posture section
 * and the one-command token-to-key upgrade (`attach --upgrade-to-key`).
 * Everything here is local/synthetic: the end-to-end cases run against an
 * in-process relay on loopback (same style as attach-pair.test.js), the
 * old-relay case against a fake socket. No real server is ever contacted.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const attach = require("../deploy/attach.cjs");

const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";
const ADMIN_TOKEN = "test-admin-token-4d9c2e";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-upgrade-"));
}

function boot() {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    perMessageDeflate: false,
  });
}

// Minimal frame client for the relay's local/viewer ports (same shape as
// the helper in attach-pair.test.js).
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
    wait(pred, ms = 4000, what = "frame") {
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
            reject(new Error(`waiting for ${what} timed out; got: ${frames.map((f) => f.__raw || f.type).join(",")}`));
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

async function createPairCode(relay, name) {
  const c = client(relay.viewerPort);
  try {
    await c.opened;
    c.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
    assert.equal((await c.type("auth_result")).ok, true);
    c.send({ type: "pair_create", id: "pc-upg", adminToken: ADMIN_TOKEN, name });
    const ack = await c.type("ack", (f) => f.id === "pc-upg");
    assert.equal(ack.ok, true, JSON.stringify(ack));
    return ack.data.code;
  } finally {
    c.close();
  }
}

// Fake socket in the style of attach.test.js's fakeRelaySocket: the reply
// callback maps each parsed client frame to a relay frame (or null).
function fakeRelaySocket(reply) {
  const seen = [];
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.handlers = {};
      setImmediate(() => this.handlers.open && this.handlers.open());
    }
    on(event, fn) {
      this.handlers[event] = fn;
    }
    send(data) {
      const frame = JSON.parse(data);
      seen.push(frame);
      const out = reply(frame);
      if (out) setImmediate(() => this.handlers.message && this.handlers.message(JSON.stringify(out)));
    }
    close() {
      setImmediate(() => this.handlers.close && this.handlers.close());
    }
  }
  return { FakeWS, seen };
}

test("removeEnvVars：整行删除目标键，注释/其他键/CRLF 不动，缺键无操作", () => {
  const dir = tmpDir();
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "# PI_REMOTE_DEVICE_TOKEN 只是注释\r\nPI_REMOTE_RELAY=ws://a:7001\r\nPI_REMOTE_DEVICE_TOKEN=secret\r\nPI_REMOTE_DEVICE_ID=d1\r\n", "utf8");
  attach.removeEnvVars(file, ["PI_REMOTE_DEVICE_TOKEN"]);
  assert.equal(fs.readFileSync(file, "utf8"), "# PI_REMOTE_DEVICE_TOKEN 只是注释\r\nPI_REMOTE_RELAY=ws://a:7001\r\nPI_REMOTE_DEVICE_ID=d1\r\n");
  attach.removeEnvVars(file, ["PI_REMOTE_DEVICE_TOKEN"]);
  assert.equal(fs.readFileSync(file, "utf8"), "# PI_REMOTE_DEVICE_TOKEN 只是注释\r\nPI_REMOTE_RELAY=ws://a:7001\r\nPI_REMOTE_DEVICE_ID=d1\r\n", "重复删除无副作用");
  if (process.platform !== "win32") assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
});

test("deviceKeyState：missing / ok / unregistered / mismatch / corrupt 五态", () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  assert.equal(attach.deviceKeyState(envPath, { env: {}, deviceId: "d1" }).state, "missing");

  const bound = attach.ensureDeviceKeys(envPath, { env: {}, deviceId: "d1" });
  assert.equal(attach.deviceKeyState(envPath, { env: {}, deviceId: "d1" }).state, "ok");
  assert.equal(attach.deviceKeyState(envPath, { env: {}, deviceId: "someone-else" }).state, "mismatch");
  assert.equal(bound.keys.deviceId, "d1");

  const dir2 = tmpDir();
  const unreg = attach.ensureDeviceKeys(path.join(dir2, ".env"), { env: {} });
  assert.equal(unreg.keys.deviceId, "");
  assert.equal(attach.deviceKeyState(path.join(dir2, ".env"), { env: {}, deviceId: "d1" }).state, "unregistered");

  const dir3 = tmpDir();
  const badPath = path.join(dir3, ".env");
  fs.writeFileSync(attach.deviceKeyFilePath(badPath, { env: {} }), "{not json", "utf8");
  assert.equal(attach.deviceKeyState(badPath, { env: {}, deviceId: "d1" }).state, "corrupt");
});

test("authPostureOf：姿态矩阵（钥优先、残存令牌、升级资格、阻挡态）", () => {
  assert.deepEqual(attach.authPostureOf({ deviceId: "d1", deviceToken: "t", keyState: "ok" }), { mode: "key", upgrade: "not-needed", leftoverToken: true });
  assert.deepEqual(attach.authPostureOf({ deviceId: "d1", keyState: "ok" }), { mode: "key", upgrade: "not-needed", leftoverToken: false });
  assert.deepEqual(attach.authPostureOf({ deviceId: "d1", deviceToken: "t", keyState: "missing" }), { mode: "token", upgrade: "eligible", leftoverToken: false });
  assert.deepEqual(attach.authPostureOf({ deviceId: "d1", deviceToken: "t", keyState: "unregistered" }), { mode: "token", upgrade: "eligible", leftoverToken: false });
  assert.deepEqual(attach.authPostureOf({ deviceToken: "t", keyState: "missing" }), { mode: "token", upgrade: "needs-pair", leftoverToken: false });
  assert.deepEqual(attach.authPostureOf({ sharedToken: "s", keyState: "missing" }), { mode: "legacy", upgrade: "needs-pair", leftoverToken: false });
  assert.deepEqual(attach.authPostureOf({ keyState: "missing" }), { mode: "none", upgrade: "needs-pair", leftoverToken: false });
  assert.equal(attach.authPostureOf({ deviceId: "d1", deviceToken: "t", keyState: "mismatch" }).upgrade, "blocked-mismatch");
  assert.equal(attach.authPostureOf({ deviceId: "d1", deviceToken: "t", keyState: "corrupt" }).upgrade, "blocked-corrupt");
});

test("probeKeyAuth：真实 relay 按 key 认对钥、拒错钥", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const relayUrl = `ws://127.0.0.1:${relay.localPort}`;
  const code = await createPairCode(relay, "probe-e2e");
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  const rc = await attach.pairMain({ pair: code, relay: relayUrl }, envPath, {
    env: {},
    platform: "linux",
    WebSocketImpl: WebSocket,
    writeOut: () => {},
    writeErr: (l) => {
      throw new Error(l);
    },
    timeoutMs: 4000,
  });
  assert.equal(rc, 0);
  const cfg = attach.loadConfig(envPath, {});
  const keys = attach.loadDeviceKeys(path.join(dir, "pi-remote-device.key.json"));

  const good = await attach.probeKeyAuth({ relay: relayUrl, deviceId: cfg.deviceId, keys, WebSocketImpl: WebSocket, timeoutMs: 4000 });
  assert.deepEqual({ ok: good.ok, auth: good.auth }, { ok: true, auth: "key" });

  const wrong = await attach.probeKeyAuth({ relay: relayUrl, deviceId: cfg.deviceId, keys: attach.generateDeviceKeys(cfg.deviceId), WebSocketImpl: WebSocket, timeoutMs: 4000 });
  assert.equal(wrong.ok, false, "另一把钥签的应答必须被 relay 拒");
});

test("--upgrade-to-key 与真实 relay：令牌设备一条命令升钥，旧令牌随即失效", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const relayUrl = `ws://127.0.0.1:${relay.localPort}`;

  // A pre-Phase-1 device: pair WITHOUT keys (raw pair frame, like an old
  // attach) so the relay issues a plain device token.
  const code1 = await createPairCode(relay, "token-device");
  const pc = client(relay.localPort);
  t.after(() => pc.close());
  await pc.opened;
  pc.send({ type: "pair", proto: 4, code: attach.normalizePairCode(code1), device: { name: "token-device", platform: "linux" } });
  const paired = await pc.type("pair_result");
  assert.equal(paired.ok, true, JSON.stringify(paired));
  assert.equal(typeof paired.deviceToken, "string");
  const deviceId = paired.deviceId;
  const oldToken = paired.deviceToken;
  pc.close();

  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, `PI_REMOTE_RELAY=${relayUrl}\nPI_REMOTE_DEVICE_ID=${deviceId}\nPI_REMOTE_DEVICE_TOKEN=${oldToken}\n`, "utf8");

  const code2 = await createPairCode(relay, "token-device");
  const logs = [];
  const errs = [];
  const rc = await attach.upgradeMain({ upgradeToKey: code2, relay: relayUrl }, envPath, {
    env: {},
    platform: "linux",
    WebSocketImpl: WebSocket,
    writeOut: (l) => logs.push(l),
    writeErr: (l) => errs.push(l),
    timeoutMs: 5000,
  });
  const outText = logs.join("\n");
  assert.equal(rc, 0, errs.join("\n") + "\n" + outText);
  assert.match(outText, /升级完成/);
  assert.match(outText, /auth=key/);
  assert.ok(!outText.includes(oldToken), "旧令牌不许出现在输出里");

  const text = fs.readFileSync(envPath, "utf8");
  assert.ok(!text.includes("PI_REMOTE_DEVICE_TOKEN="), "令牌行整行删除，不是写空");
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(cfg.deviceId, deviceId, "设备编号不变");
  assert.equal(cfg.deviceToken, "");
  const keys = attach.loadDeviceKeys(path.join(dir, "pi-remote-device.key.json"));
  assert.equal(keys.deviceId, deviceId, "钥文件回填了设备编号");
  assert.ok(!outText.includes(keys.sign.priv), "私钥不许出现在输出里");

  // The revoked token must now be refused by the relay itself.
  const ac = client(relay.localPort);
  t.after(() => ac.close());
  await ac.opened;
  ac.send({ type: "auth", role: "local", proto: 4, deviceId, deviceToken: oldToken });
  const auth = await ac.type("auth_result");
  assert.equal(auth.ok, false, "已作废的旧令牌必须被 relay 拒");
  ac.close();
});

test("--upgrade-to-key 对旧 relay：探测到未登记钥即中止，设备不掉线、文案明示", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://relay:7001\nPI_REMOTE_DEVICE_ID=dev-old-1\nPI_REMOTE_DEVICE_TOKEN=old-token-1\n", "utf8");
  // An old relay does not know the keys field: it answers with a fresh
  // token, exactly like today's token branch.
  const { FakeWS, seen } = fakeRelaySocket((frame) =>
    frame.type === "pair" ? { type: "pair_result", ok: true, accountId: "admin", deviceId: "dev-old-1", deviceToken: "brand-new-token" } : null,
  );
  const logs = [];
  const errs = [];
  const rc = await attach.upgradeMain({ upgradeToKey: "ABCDEFGH", relay: "" }, envPath, {
    env: {},
    platform: "linux",
    WebSocketImpl: FakeWS,
    writeOut: (l) => logs.push(l),
    writeErr: (l) => errs.push(l),
    timeoutMs: 2000,
  });
  assert.equal(rc, 1);
  const errText = errs.join("\n");
  assert.match(errText, /relay 版本太旧/);
  assert.match(errText, /升级未完成/);
  assert.doesNotMatch(logs.join("\n"), /升级完成/);
  assert.ok(seen[0].keys && seen[0].keys.pop, "升级配对帧带 keys+pop");
  assert.equal(seen[0].deviceToken, "old-token-1", "升级配对帧出示旧令牌过防接管校验");
  const cfg = attach.loadConfig(envPath, {});
  assert.equal(cfg.deviceToken, "brand-new-token", "旧 relay 新签的令牌照常落盘，设备不掉线");
  assert.ok(fs.existsSync(path.join(dir, "pi-remote-device.key.json")), "钥文件保留，供 relay 升级后重试");
});

test("--upgrade-to-key 前置：已是钥模式直接说明，并顺带清理残存令牌行", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  attach.ensureDeviceKeys(envPath, { env: {}, deviceId: "d1" });
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:1\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=leftover\n", "utf8");
  const logs = [];
  const rc = await attach.upgradeMain({ upgradeToKey: "ABCDEFGH" }, envPath, {
    env: {},
    platform: "linux",
    writeOut: (l) => logs.push(l),
    writeErr: (l) => logs.push(l),
  });
  assert.equal(rc, 0, logs.join("\n"));
  assert.match(logs.join("\n"), /已是钥模式/);
  assert.ok(!fs.readFileSync(envPath, "utf8").includes("PI_REMOTE_DEVICE_TOKEN="), "残存令牌行被删");
});

test("--upgrade-to-key 前置：钥文件属于别台设备时拒绝，.env 与钥文件都不动", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  const keyFile = attach.deviceKeyFilePath(envPath, { env: {} });
  attach.writeDeviceKeyFile(keyFile, attach.generateDeviceKeys("other-device"));
  const envText = "PI_REMOTE_RELAY=ws://127.0.0.1:1\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=tok\n";
  fs.writeFileSync(envPath, envText, "utf8");
  const keyText = fs.readFileSync(keyFile, "utf8");
  const errs = [];
  const rc = await attach.upgradeMain({ upgradeToKey: "ABCDEFGH" }, envPath, {
    env: {},
    platform: "linux",
    writeOut: () => {},
    writeErr: (l) => errs.push(l),
  });
  assert.equal(rc, 1);
  assert.match(errs.join("\n"), /属于另一台设备/);
  assert.equal(fs.readFileSync(envPath, "utf8"), envText, ".env 原样");
  assert.equal(fs.readFileSync(keyFile, "utf8"), keyText, "钥文件原样");
});

test("--upgrade-to-key 前置：没有设备令牌可出示时拒绝并给替代路径", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:1\nPI_REMOTE_DEVICE_ID=d1\n", "utf8");
  const errs = [];
  const rc = await attach.upgradeMain({ upgradeToKey: "ABCDEFGH" }, envPath, {
    env: {},
    platform: "linux",
    writeOut: () => {},
    writeErr: (l) => errs.push(l),
  });
  assert.equal(rc, 1);
  assert.match(errs.join("\n"), /没有设备令牌可供出示/);
});

test("--upgrade-to-key 前置：钥文件损坏时响亮报错，不静默退回令牌路", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(attach.deviceKeyFilePath(envPath, { env: {} }), "{broken", "utf8");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://127.0.0.1:1\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=tok\n", "utf8");
  const errs = [];
  const rc = await attach.upgradeMain({ upgradeToKey: "ABCDEFGH" }, envPath, {
    env: {},
    platform: "linux",
    writeOut: () => {},
    writeErr: (l) => errs.push(l),
  });
  assert.equal(rc, 1);
  assert.match(errs.join("\n"), /损坏/);
});

test("--pair 自动识别升级情形：出示过旧令牌且钥登记成功时点明已顺带升级", async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, "PI_REMOTE_RELAY=ws://relay:7001\nPI_REMOTE_DEVICE_TOKEN=stale-token\n", "utf8");
  const { FakeWS } = fakeRelaySocket((frame) =>
    frame.type === "pair" ? { type: "pair_result", ok: true, accountId: "admin", deviceId: "dev-key-9", keyRegistered: true } : null,
  );
  const lines = [];
  const code = await attach.pairMain({ pair: "ABCDEFGH", relay: "" }, envPath, {
    WebSocketImpl: FakeWS,
    platform: "darwin",
    env: {},
    writeOut: (l) => lines.push(l),
    writeErr: (l) => lines.push(l),
  });
  assert.equal(code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), /已顺带完成令牌→钥升级/);
  assert.ok(!fs.readFileSync(envPath, "utf8").includes("PI_REMOTE_DEVICE_TOKEN="), "令牌行整行删除");
});

function doctorFixture(t, envText, extra) {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  fs.writeFileSync(envPath, envText, "utf8");
  if (extra) extra(dir, envPath);
  return { dir, envPath };
}

async function runDoctor(envPath, dir) {
  const lines = [];
  await attach.doctorMain({}, envPath, {
    writeOut: (line) => lines.push(String(line)),
    platform: "linux",
    root: dir,
    env: { PI_REMOTE_ATTACH_FILE: path.join(dir, "state.json"), PI_REMOTE_PI_BIN: process.execPath },
    probe: async () => ({ ok: true }),
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
  });
  return lines.join("\n");
}

test("--doctor 姿态段：令牌设备显示令牌鉴权 + 一条命令升级资格", async (t) => {
  const { dir, envPath } = doctorFixture(t, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=tok\nPI_REMOTE_LAUNCHER=tmux\n");
  const text = await runDoctor(envPath, dir);
  assert.match(text, /令牌鉴权（auth=token）/);
  assert.match(text, /升级到钥模式.*--upgrade-to-key/);
});

test("--doctor 姿态段：钥设备带残存令牌行时，姿态为钥鉴权且点名残存令牌", async (t) => {
  const { dir, envPath } = doctorFixture(t, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=leftover\nPI_REMOTE_LAUNCHER=tmux\n", (d, p) => {
    attach.ensureDeviceKeys(p, { env: {}, deviceId: "d1" });
  });
  const text = await runDoctor(envPath, dir);
  assert.match(text, /钥鉴权（auth=key）/);
  assert.match(text, /残存令牌/);
  assert.match(text, /已是钥模式，无需升级/);
});

test("--doctor 姿态段：钥文件属于别台设备时点名归属且升级被挡", async (t) => {
  const { dir, envPath } = doctorFixture(t, "PI_REMOTE_RELAY=ws://127.0.0.1:7001\nPI_REMOTE_DEVICE_ID=d1\nPI_REMOTE_DEVICE_TOKEN=tok\nPI_REMOTE_LAUNCHER=tmux\n", (d, p) => {
    attach.writeDeviceKeyFile(attach.deviceKeyFilePath(p, { env: {} }), attach.generateDeviceKeys("other-device"));
  });
  const text = await runDoctor(envPath, dir);
  assert.match(text, /钥文件属于另一台设备/);
  assert.match(text, /升级到钥模式.*被钥文件归属挡住/);
});
