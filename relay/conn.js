"use strict";
/** 连接通用：认证超时、二进制/坏 JSON、限速、心跳 */
const crypto = require("node:crypto");
const { log } = require("./util");
const { errorFrame, send } = require("./wire");

/** 心跳 RTT 的 EMA 系数：新样本占 0.3、旧值占 0.7。
 *  延迟是慢变量，小系数让单轮抖动不至于把显示值拽飞；30s 一轮，几轮就收敛。 */
const LATENCY_EMA_ALPHA = 0.3;

/* ---------------- 连接通用 ---------------- */
function attachCommon(ws, cfg, opts) {
  ws._state = {
    connId: crypto.randomBytes(6).toString("hex"),
    authed: false,
    tokens: cfg.rateBurst,
    lastRefill: Date.now(),
    alive: true,
    // 设备↔relay 心跳 RTT（keepalive 的 ping/pong 实测）：latencyMs 是平滑后的值（浮点，
    // 没样本时为 null），_lastPongAt 是最近一次 pong 的时刻，_pingSentAt 是当前在飞 ping 的发出时刻。
    // 只在连接内存在，不落盘、不进协议必填字段。
    latencyMs: null,
    _lastPongAt: 0,
    _pingSentAt: 0,
    authTimer: (() => {
      const t = setTimeout(() => {
        if (!ws._state.authed) {
          send(ws, errorFrame("auth_timeout", "10 秒内未完成认证"), cfg);
          ws.close(4001, "auth timeout");
        }
      }, 10000);
      t.unref();
      return t;
    })(),
  };
  ws.on("pong", () => {
    const s = ws._state;
    if (!s) return;
    s.alive = true;
    // RTT 只认"这一轮 ping 的 pong"：发 ping 时记了 _pingSentAt，收到 pong 取走并清空。
    // 没有在飞 ping 的主动/迟到 pong 只更新 _lastPongAt，不产生样本（否则会算出 0 或几十秒的假延迟）。
    const now = Date.now();
    s._lastPongAt = now;
    const sentAt = Number(s._pingSentAt) || 0;
    if (!sentAt) return;
    s._pingSentAt = 0;
    const rtt = now - sentAt;
    // 系统时钟回拨会让 rtt 变负：丢掉这次样本，不把负延迟写进名册
    if (!(rtt >= 0)) return;
    s.latencyMs = s.latencyMs == null ? rtt : s.latencyMs + LATENCY_EMA_ALPHA * (rtt - s.latencyMs);
  });
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      send(ws, errorFrame("binary_not_allowed", "本服务只接受 JSON 文本帧"), cfg);
      ws.close(4002, "binary not allowed");
      return;
    }
    // 先解析再限速：解析失败也消耗令牌，否则未认证连接可无限刷 bad_json
    let msg = null;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      msg = null;
    }
    const s = ws._state;
    // 已认证的 local 连接（本机扩展）不限速：思考/工具输出时事件流远超 20 条/秒，
    // 限速只会丢 delta 和 command_result，观看端缺字或命令假超时。viewer 与未认证连接照常限速。
    if (!s.stream) {
      const now = Date.now();
      s.tokens = Math.min(cfg.rateBurst, s.tokens + ((now - s.lastRefill) / 1000) * cfg.ratePerSec);
      s.lastRefill = now;
      const cost = 1 + Math.floor(data.length / 65536);
      if (s.tokens < cost) {
        send(ws, errorFrame("rate_limited", "操作太频繁", { id: msg && typeof msg.id === "string" ? msg.id : undefined }), cfg);
        if (!s.rateLogged || Date.now() - s.rateLogged > 5000) {
          s.rateLogged = Date.now();
          log("限速丢弃:", ws._room ? ws._room.id : "(未认证)", "type=" + (msg ? msg.type : "bad_json"), "cmd=" + (msg && msg.command ? String(msg.command) : "-"), "left=" + s.tokens.toFixed(1), "cost=" + cost, "len=" + data.length);
        }
        return;
      }
      s.tokens -= cost;
    }
    if (!msg || typeof msg !== "object") {
      send(ws, errorFrame("bad_json", "不是合法 JSON"), cfg);
      return;
    }
    try {
      opts.onMessage(msg);
    } catch (e) {
      // 内部异常细节只进日志（含堆栈）；客户端只拿稳定码和通用文案，避免把文件路径/实现细节带出去。
      log("处理消息异常:", msg && msg.type, "conn=" + (ws._state && ws._state.connId), e && e.stack ? String(e.stack) : e);
      send(ws, errorFrame("server_error", "服务端处理消息时出错", { id: typeof msg.id === "string" ? msg.id : undefined }), cfg);
    }
  });
  ws.on("error", (e) => log("ws 错误:", e.message));
}

/**
 * 一轮心跳。被拒/尚未 attachCommon 的连接没有 _state：跳过它，不能让一次属性访问异常
 * 打断整轮，把后面的健康连接全部漏掉（报告 relay 中-7）。单连接异常也只影响它自己。
 */
function keepaliveSweep(wss) {
  if (!wss || !wss.clients) return 0;
  let checked = 0;
  for (const ws of wss.clients) {
    try {
      const s = ws && ws._state;
      if (!s) continue;
      // 两次机会：VPS 事件循环偶发 >1s 抖动时，单次判死会误杀健康连接
      if (!s.alive) {
        s.misses = (s.misses || 0) + 1;
        if (s.misses >= 2) {
          ws.terminate();
          continue;
        }
      } else {
        s.misses = 0;
      }
      s.alive = false;
      const sentAt = Date.now();
      ws.ping();
      // ping 真发出去之后才记时间戳：ping 抛异常（已关闭/半开）时不留悬挂样本，
      // 否则下一条 pong（可能是上一轮的）会被算成一段假延迟。
      s._pingSentAt = sentAt;
      checked++;
    } catch (e) {
      log("心跳检查失败（跳过该连接）:", e && e.message);
    }
  }
  return checked;
}

function keepalive(wss) {
  const t = setInterval(() => keepaliveSweep(wss), 30000);
  t.unref();
  return t;
}

module.exports = { attachCommon, keepalive, keepaliveSweep };
