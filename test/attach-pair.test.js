"use strict";
/**
 * attach --pair 与真实 relay 的联调：
 * viewer 生成配对码 → deploy/attach.cjs pairMain 连真实 local 端口 → pair_result 落盘
 * → 用落盘的钥文件走挑战-签名 auth，确认 relay 认这套钥（阶段 1：钥设备不再发令牌）。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-attach-pair-"));
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

function client(port, url) {
  const ws = new WebSocket(url || `ws://127.0.0.1:${port}/`);
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

/** 管理员在 viewer 上生成一次性配对码（和网页「添加设备」同一路径） */
async function createPairCode(relay, name) {
  const c = client(relay.viewerPort);
  try {
    await c.opened;
    c.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
    assert.equal((await c.type("auth_result")).ok, true);
    c.send({ type: "pair_create", id: "pc-e2e", adminToken: ADMIN_TOKEN, name });
    const ack = await c.type("ack", (f) => f.id === "pc-e2e");
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(typeof ack.data.code, "string");
    return ack.data.code;
  } finally {
    c.close();
  }
}

test("attach --pair 与真实 relay：密钥配对成功落盘，钥文件能通过挑战-签名鉴权", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const relayUrl = `ws://127.0.0.1:${relay.localPort}`;
  const code = await createPairCode(relay, "pair-e2e");

  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  const logs = [];
  const errs = [];
  const rc = await attach.pairMain({ pair: code, relay: relayUrl }, envPath, {
    env: {}, // 不继承本机 PI_REMOTE_* 环境变量
    platform: "darwin",
    WebSocketImpl: WebSocket,
    writeOut: (line) => logs.push(line),
    writeErr: (line) => errs.push(line),
    timeoutMs: 3000,
  });
  assert.equal(rc, 0, errs.join("\n"));
  assert.deepEqual(errs, []);

  const cfg = attach.loadConfig(envPath, {});
  assert.equal(cfg.relay, relayUrl);
  assert.match(cfg.deviceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  // 阶段 1：relay 验 pop 后登记公钥、停发令牌——.env 里没有设备令牌，只有钥文件路径
  assert.equal(cfg.deviceToken, "", "钥设备不再下发设备令牌");
  const vars = attach.parseEnv(fs.readFileSync(envPath, "utf8"));
  const keyFile = path.join(dir, "pi-remote-device.key.json");
  assert.equal(vars.PI_REMOTE_DEVICE_KEY_FILE, keyFile);
  const keys = attach.loadDeviceKeys(keyFile);
  assert.equal(keys.deviceId, cfg.deviceId, "钥文件回填了 relay 签发的 deviceId");
  const ackValues = Object.values(keys.contentKeys || {});
  assert.equal(ackValues.length, 1, "首台钥设备为本账号生成一把 ACK 自持");
  assert.equal(Buffer.from(ackValues[0], "base64").length, 32);
  assert.match(logs.join("\n"), /配对成功/);
  assert.equal(logs.join("\n").includes(keys.sign.priv), false, "私钥不能打印出来");
  assert.equal(logs.join("\n").includes(ackValues[0]), false, "ACK 不能打印出来");
  if (process.platform !== "win32") assert.equal((fs.statSync(envPath).mode & 0o777).toString(8), "600");
  if (process.platform !== "win32") assert.equal((fs.statSync(keyFile).mode & 0o777).toString(8), "600");

  // 真实 relay 认落盘的钥：走 §3.3 挑战-签名全程（auth 带 keyFp → auth_challenge → auth_response）
  const local = client(relay.localPort);
  t.after(() => local.close());
  await local.opened;
  const clientNonce = crypto.randomBytes(16);
  local.send({
    type: "auth",
    role: "local",
    proto: 4,
    caps: ["crypto.auth"],
    client: { kind: "attach-test", version: "test" },
    deviceId: cfg.deviceId,
    keyFp: attach.keyFingerprint(keys.sign.pub),
    clientNonce: clientNonce.toString("base64"),
  });
  const challenge = await local.type("auth_challenge");
  const payload = Buffer.concat([Buffer.from("pi-remote-auth-v1", "utf8"), Buffer.from(cfg.deviceId, "utf8"), Buffer.from(challenge.nonce, "base64"), clientNonce]);
  const priv = crypto.createPrivateKey({ key: Buffer.from(keys.sign.priv, "base64"), format: "der", type: "pkcs8" });
  local.send({ type: "auth_response", sig: crypto.sign(null, payload, priv).toString("base64") });
  const auth = await local.type("auth_result");
  assert.equal(auth.ok, true, JSON.stringify(auth));
  assert.equal(auth.auth, "key");
  assert.equal(auth.deviceId, cfg.deviceId);
});

test("attach --pair 与真实 relay：配对码无效时退出码 1，不落 .env", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envPath = path.join(dir, ".env");
  const errs = [];
  const rc = await attach.pairMain({ pair: "ABCD-EFGH", relay: `ws://127.0.0.1:${relay.localPort}` }, envPath, {
    env: {},
    platform: "darwin",
    WebSocketImpl: WebSocket,
    writeOut: () => {},
    writeErr: (line) => errs.push(line),
    timeoutMs: 3000,
  });
  assert.equal(rc, 1);
  assert.match(errs.join("\n"), /pair_invalid/);
  assert.equal(fs.existsSync(envPath), false, "配对失败不能写令牌文件");
});
