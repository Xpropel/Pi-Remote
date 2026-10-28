"use strict";
/**
 * relay/conn.js 保活：心跳发送、pong 更新、连续 miss 回收、半开连接清理。
 * 定时器是 30s 固定值：测试直接截获 keepalive 注册的 interval 回调并手动 tick，
 * 不依赖真实等待，也不改被测模块行为。
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachCommon, keepalive } = require("../relay/conn.js");

const CFG = { rateBurst: 60, ratePerSec: 20, maxPayloadBytes: 256 * 1024 };

class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.pings = 0;
    this.terminated = 0;
    this.sent = [];
    this.closed = [];
  }
  ping() {
    this.pings++;
    return true;
  }
  terminate() {
    this.terminated++;
    this.readyState = 3;
  }
  send(data) {
    this.sent.push(typeof data === "string" ? data : String(data));
  }
  close(code, reason) {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
}

function makeAttached() {
  const ws = new FakeWS();
  attachCommon(ws, CFG, { onMessage() {} });
  return ws;
}

function clearAuthTimer(ws) {
  try {
    clearTimeout(ws._state.authTimer);
  } catch {}
}

/**
 * 截获 keepalive 内部注册的 interval：
 * 返回 tick() 手动触发一轮，unref 是否被调用也能断言。恢复全局 setInterval 后再返回。
 */
function captureKeepalive(clients) {
  const original = global.setInterval;
  const handle = {
    unrefCalled: false,
    unref() {
      this.unrefCalled = true;
    },
  };
  let callback = null;
  let delay = 0;
  let timer = null;
  global.setInterval = (fn, ms) => {
    callback = fn;
    delay = ms;
    return handle;
  };
  try {
    timer = keepalive({ clients });
  } finally {
    global.setInterval = original;
  }
  assert.equal(typeof callback, "function", "keepalive 必须注册 interval");
  assert.equal(timer, handle);
  return { tick: () => callback(), delay, handle, timer };
}

test("attachCommon：pong 把 alive 重新置 true，且不产生任何发帧副作用", () => {
  const ws = makeAttached();
  try {
    assert.equal(ws._state.alive, true);
    ws._state.alive = false;
    ws.emit("pong");
    assert.equal(ws._state.alive, true, "pong 是存活依据");
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(ws.closed, []);
    assert.equal(ws.terminated, 0);
  } finally {
    clearAuthTimer(ws);
  }
});

test("keepalive：30 秒一轮并 unref，不拖住进程退出", () => {
  const ws = makeAttached();
  try {
    const k = captureKeepalive([ws]);
    assert.equal(k.delay, 30000);
    assert.equal(k.handle.unrefCalled, true);
    assert.equal(ws.pings, 0, "注册 interval 本身不立即 ping");
  } finally {
    clearAuthTimer(ws);
  }
});

test("keepalive：每轮发 ping；一次未 pong 只记 miss，连续两次才 terminate", () => {
  const ws = makeAttached();
  try {
    const k = captureKeepalive([ws]);

    k.tick();
    assert.equal(ws.pings, 1, "每轮都要 ping");
    assert.equal(ws._state.alive, false, "发 ping 后先标记未回");
    assert.equal(ws._state.misses, 0);

    ws.emit("pong");
    assert.equal(ws._state.alive, true);

    k.tick();
    assert.equal(ws.pings, 2);
    assert.equal(ws._state.alive, false);

    // 第一次没回 pong：只累计 miss，给 VPS 抖动一次机会
    k.tick();
    assert.equal(ws.pings, 3);
    assert.equal(ws._state.misses, 1);
    assert.equal(ws.terminated, 0, "单次 miss 不能判死");

    ws.emit("pong");
    assert.equal(ws._state.alive, true);
    k.tick();
    assert.equal(ws._state.misses, 0, "恢复 pong 后 miss 归零");
    assert.equal(ws.pings, 4);

    // 连续第二次没回 pong：回收
    k.tick();
    assert.equal(ws._state.misses, 1);
    assert.equal(ws.pings, 5);
    k.tick();
    assert.equal(ws._state.misses, 2);
    assert.equal(ws.terminated, 1, "连续两次 miss 必须 terminate");
    assert.equal(ws.pings, 5, "terminate 后不再 ping 这条连接");
    assert.equal(ws._state.alive, false);
  } finally {
    clearAuthTimer(ws);
  }
});

test("keepalive：健康连接持续 pong 不被回收，半开连接两轮 miss 后 terminate", () => {
  const healthy = makeAttached();
  const half = makeAttached();
  try {
    const k = captureKeepalive([healthy, half]);

    k.tick();
    assert.equal(healthy.pings, 1);
    assert.equal(half.pings, 1);

    healthy.emit("pong"); // 半开连接永不回 pong
    k.tick();
    assert.equal(healthy.pings, 2);
    assert.equal(half.pings, 2);
    assert.equal(half._state.misses, 1);

    healthy.emit("pong");
    k.tick();
    assert.equal(healthy.pings, 3, "健康连接一直被 ping，不被误杀");
    assert.equal(healthy.terminated, 0);
    assert.equal(half.pings, 2, "被判死后不再 ping");
    assert.equal(half.terminated, 1, "半开连接最终回收");
    assert.equal(half._state.misses, 2);
    assert.equal(healthy._state.misses, 0);
  } finally {
    clearAuthTimer(healthy);
    clearAuthTimer(half);
  }
});

/* ---------------- 设备↔relay 延迟（ping/pong RTT + EMA） ---------------- */

/** 可推进的假时钟：RTT 断言要精确到毫秒，不靠真实等待。
 *  node:test 同一文件内用例串行执行，用例结束必须 restore()。 */
function fakeClock(start = 1_000_000) {
  const original = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    restore() {
      Date.now = original;
    },
  };
}

test("keepalive：发 ping 记发送时刻，pong 算出 RTT 并写 latencyMs / _lastPongAt", () => {
  const clock = fakeClock();
  const ws = makeAttached();
  try {
    const k = captureKeepalive([ws]);
    assert.equal(ws._state.latencyMs, null, "还没 pong 过就没有样本");
    assert.equal(ws._state._lastPongAt, 0);

    k.tick();
    assert.equal(ws._state._pingSentAt, clock.now(), "ping 发出时记时间戳");

    clock.advance(40);
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, 40, "第一个样本直接取原始 RTT");
    assert.equal(ws._state._lastPongAt, clock.now(), "pong 时刻要留档");
    assert.equal(ws._state._pingSentAt, 0, "样本取走后清空，避免重复计入");

    // EMA：新值占 0.3 → 40 + 0.3 * (20 - 40) = 34
    k.tick();
    assert.equal(ws._state._pingSentAt, clock.now(), "每轮 ping 都刷新时间戳");
    clock.advance(20);
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, 34);

    // 再来一次：34 + 0.3 * (100 - 34) = 53.8
    k.tick();
    clock.advance(100);
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, 53.8);
  } finally {
    clock.restore();
    clearAuthTimer(ws);
  }
});

test("keepalive：没有在飞 ping 的 pong 只记时刻，不产生样本（不拿 0 冒充延迟）", () => {
  const clock = fakeClock();
  const ws = makeAttached();
  try {
    // 主动/迟到 pong：连接是活的，但没发过 ping，不能算出 RTT
    clock.advance(500);
    ws.emit("pong");
    assert.equal(ws._state.alive, true);
    assert.equal(ws._state.latencyMs, null, "没有 ping 就没有样本");
    assert.equal(ws._state._lastPongAt, clock.now());

    // 一轮 ping 只计一次：同轮重复 pong 不改 EMA（_pingSentAt 已清空）
    const k = captureKeepalive([ws]);
    k.tick();
    clock.advance(30);
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, 30);
    clock.advance(30);
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, 30, "多余的 pong 不重复计入");

    // 负 RTT（系统时钟回拨）：丢弃这次样本，保留上一个值
    k.tick();
    clock.advance(-500);
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, 30, "时钟回拨不写负延迟");
  } finally {
    clock.restore();
    clearAuthTimer(ws);
  }
});

test("keepalive：ping 抛异常不留悬挂时间戳，之后到的 pong 不算假延迟", () => {
  const clock = fakeClock();
  const ws = makeAttached();
  const k = captureKeepalive([ws]);
  const realPing = ws.ping.bind(ws);
  try {
    ws.ping = () => {
      throw new Error("半开连接");
    };
    k.tick();
    assert.equal(ws._state._pingSentAt, 0, "ping 没送出去就不能记时间戳");

    ws.ping = realPing;
    clock.advance(30_000); // 假设这一轮 pong 迟到 30s
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, null, "没有有效 ping 时不产生几十秒的假延迟");
    assert.equal(ws._state._lastPongAt, clock.now());

    // 恢复正常：下一轮照常测量
    k.tick();
    clock.advance(12);
    ws.emit("pong");
    assert.equal(ws._state.latencyMs, 12);
  } finally {
    clock.restore();
    clearAuthTimer(ws);
  }
});

test("keepalive：单条连接 ping 抛异常不影响本轮其他连接，也不中断 miss 计数", () => {
  const bad = new FakeWS();
  bad._state = { alive: true, misses: 0 };
  bad.ping = () => {
    throw new Error("boom");
  };
  const good = new FakeWS();
  good._state = { alive: true, misses: 0 };

  const k = captureKeepalive([bad, good]);
  assert.doesNotThrow(() => k.tick());
  assert.equal(bad.terminated, 0);
  assert.equal(good.pings, 1, "异常连接不能挡住后面的连接");

  // 下一轮 bad 进入 miss=1，再 ping 仍然抛；good 照常再 ping
  assert.doesNotThrow(() => k.tick());
  assert.equal(bad._state.misses, 1);
  assert.equal(good.pings, 2);

  // 第三轮 bad 连续两次 miss → terminate（ping 抛异常不影响回收）；good 模拟 pong 保持健康
  good._state.alive = true;
  k.tick();
  assert.equal(bad.terminated, 1);
  assert.equal(good.pings, 3);
});
