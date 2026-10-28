"use strict";
/**
 * 畸形帧：非对象 JSON、空帧、数组、二进制帧、超出 maxPayload 的帧。
 * 两条通道（local 7001 / viewer 7002）都按 relay/conn.js 的现有实现断言：
 *   - 非对象 JSON / 空文本帧 → error bad_json，不断开；
 *   - 数组是 object，未认证阶段按业务帧处理 → auth_failed + 4003；
 *   - 二进制帧（含 0 字节）→ error binary_not_allowed + 4002；
 *   - 超过 ws maxPayload → ws 层 1009 关闭，不进入业务层。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");
const PROTOCOL = require("../relay/protocol.json");

const LOCAL_TOKEN = "test-local-token-2f8c1d";
const VIEWER_TOKEN = "test-viewer-token-7a3b9e";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-frames-"));
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
    ...overrides,
  });
}

/** err.v4 的码必须在码表里；畸形帧都不 retryable */
function assertCoded(frame, code) {
  assert.equal(frame.code, code, JSON.stringify(frame));
  assert.ok(PROTOCOL.errors[code], "码表里没有 " + code);
  assert.equal(typeof (frame.message ?? frame.error), "string", code + " 缺文案");
  assert.equal(frame.retryable, undefined, code + " 不应可重试");
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("等待 " + what + " 超时")), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** 收帧客户端：wait 返回第一条尚未取走且满足条件的帧 */
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: String(reason) })));
  ws.on("error", () => {});
  ws.on("message", (data, isBinary) => {
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      msg = { __raw: data.toString("utf8"), __binary: !!isBinary };
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
    closed,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    sendRaw(data) {
      ws.send(data);
    },
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

function authToken(role) {
  return role === "local" ? LOCAL_TOKEN : VIEWER_TOKEN;
}

test("非对象 JSON / 空文本帧：bad_json，连接不断开，随后仍能认证（两条通道）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  for (const [port, role] of [[relay.localPort, "local"], [relay.viewerPort, "viewer"]]) {
    const c = client(port);
    t.after(() => c.close());
    await c.opened;

    // JSON.parse 成功但不是对象（null 也走 !msg 分支）；空帧在 parse 时抛错
    for (const raw of ["42", "\"hello\"", "true", "null", ""]) {
      c.sendRaw(raw);
      const err = await c.wait((f) => f.type === "error", 2000, "bad_json");
      assertCoded(err, "bad_json");
      assert.equal(c.ws.readyState, WebSocket.OPEN, `${role} 收到坏帧 ${JSON.stringify(raw)} 后不能断开`);
    }

    c.send({ type: "auth", role, token: authToken(role) });
    const auth = await c.type("auth_result");
    assert.equal(auth.ok, true, role);
  }
});

test("数组是 object：未认证阶段按业务帧处理，auth_failed + 4003，不返回任何业务帧（两条通道）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  for (const [port, role] of [[relay.localPort, "local"], [relay.viewerPort, "viewer"]]) {
    const c = client(port);
    t.after(() => c.close());
    await c.opened;
    c.sendRaw(JSON.stringify([1, 2, 3]));
    const auth = await c.type("auth_result");
    assert.equal(auth.ok, false, role);
    assertCoded(auth, "auth_failed");
    const closed = await withTimeout(c.closed, 3000, role + " 关闭");
    assert.equal(closed.code, 4003, role);
    assert.deepEqual(c.frames.map((f) => f.type), ["auth_result"], role + " 未认证帧不能产生业务响应");
  }
});

test("二进制帧（含 0 字节）：binary_not_allowed + 4002（两条通道）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  for (const [port, role] of [[relay.localPort, "local"], [relay.viewerPort, "viewer"]]) {
    for (const payload of [Buffer.from([1, 2, 3]), Buffer.alloc(0)]) {
      const c = client(port);
      t.after(() => c.close());
      await c.opened;
      c.ws.send(payload);
      const err = await c.type("error");
      assertCoded(err, "binary_not_allowed");
      const closed = await withTimeout(c.closed, 3000, role + " 关闭");
      assert.equal(closed.code, 4002, role + " 二进制帧应立即断开");
      assert.deepEqual(c.frames.map((f) => f.type), ["error"], role + " 二进制帧不能进入业务层");
    }
  }
});

test("超过 maxPayload 的帧：ws 层以 1009 关闭，不产生错误/业务帧（两条通道）", async (t) => {
  // 用配置项把上限压小，避免测试构造 16MB 的 local 帧；被测的是 WebSocketServer.maxPayload 这条机制
  const relay = await boot({ maxPayloadBytes: 2048, localMaxPayloadBytes: 2048 });
  t.after(() => relay.close());
  const huge = JSON.stringify({ type: "event", room: "r", pad: "x".repeat(8192) });
  for (const [port, role] of [[relay.localPort, "local"], [relay.viewerPort, "viewer"]]) {
    const c = client(port);
    t.after(() => c.close());
    await c.opened;
    c.sendRaw(huge);
    const closed = await withTimeout(c.closed, 3000, role + " 超限关闭");
    assert.equal(closed.code, 1009, role + " 超限帧应由 ws 以 1009 关闭");
    assert.deepEqual(c.frames, [], role + " 超限帧不该收到 bad_json/业务帧");
  }
});

test("已认证后的空帧/非对象帧仍然只报 bad_json，连接继续可用（两条通道）", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const local = client(relay.localPort);
  const viewer = client(relay.viewerPort);
  t.after(() => {
    local.close();
    viewer.close();
  });

  await local.opened;
  local.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  assert.equal((await local.type("auth_result")).ok, true);
  await viewer.opened;
  viewer.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN });
  assert.equal((await viewer.type("auth_result")).ok, true);

  for (const c of [local, viewer]) {
    c.sendRaw("");
    assertCoded(await c.wait((f) => f.type === "error"), "bad_json");
    c.sendRaw("42");
    assertCoded(await c.wait((f) => f.type === "error" && !f.__taken), "bad_json");
    assert.equal(c.ws.readyState, WebSocket.OPEN);
  }

  // 坏帧没有把连接踢掉：认证后的正常帧照常工作
  viewer.send({ type: "list_rooms" });
  assert.ok(Array.isArray((await viewer.type("room_list")).rooms));
  local.send({ type: "room_register", room: { id: "room-after-bad-json", label: "t", cwd: "/tmp", epoch: 1, instance: "inst-a" } });
  assert.equal((await local.type("room_registered")).room, "room-after-bad-json");
});
