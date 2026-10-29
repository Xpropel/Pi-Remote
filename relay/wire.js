"use strict";
/** 协议 v4 与发帧：版本、能力、握手、错误帧、ack、快照帧、带背压的发送 */
const PROTOCOL = require("./protocol.json");
const { log } = require("./util");
const { DEFAULT_CONFIG } = require("./config");

/** relay 版本（/healthz 用）。部署只带 relay/，服务器上的 package.json 不会跟着更新，所以写死在这里 */
const RELAY_VERSION = "4.0.0";

/* ---------------- 协议 v4：版本、能力、错误码（码表在 relay/protocol.json） ---------------- */
/**
 * 本 relay 已经实现的能力，握手时回给对方。对方会照着这里发新帧/新字段，
 * 所以只能列做完了的：新能力落地的同一次提交里再加进来。
 * 注意：session.files / fs.browse 是 attach 声明、relay 只转发的能力，不在 relay 的
 * 能力表里（relay 通过 room_list.devices[].features 把设备侧能力透传给网页）。
 */
const RELAY_CAPS = ["device.qr-link", "device.token", "dialog.observe", "dialog.respond", "err.v4", "health", "msg.cid", "prefs.sync", "room.activity", "room.attention", "room.dialogs", "room.inbox", "room.label", "room.schedule", "session.purge", "sync.v3", "usage.activity.v1"];
const CODE_RE = /^[a-z][a-z0-9_]*$/;

/** 对方连接在握手里声明过这个能力（新帧/新字段只发给声明过的一方） */
function hasCap(ws, cap) {
  return !!(ws && ws._state && ws._state.caps && ws._state.caps.has(cap));
}

/** auth 帧里的协议信息：proto 不带按 v3（兼容期旧客户端），高于本 relay 的按本 relay 说；
 *  显式带 proto 但低于 minProto 的由 helloVersionError 在握手处拒绝，不再静默抬到最低版；
 *  caps 只留协议里有的名字。 */
function parseHello(msg) {
  const n = Number(msg.proto);
  const proto = Number.isInteger(n) && n >= PROTOCOL.minProto ? Math.min(n, PROTOCOL.proto) : PROTOCOL.minProto;
  const caps = new Set();
  if (Array.isArray(msg.caps)) {
    for (const c of msg.caps) {
      if (typeof c === "string" && Object.prototype.hasOwnProperty.call(PROTOCOL.caps, c)) caps.add(c);
    }
  }
  const client = {};
  const raw = msg.client && typeof msg.client === "object" ? msg.client : {};
  for (const k of ["kind", "version", "platform"]) {
    if (typeof raw[k] === "string" && raw[k].trim()) client[k] = raw[k].trim().slice(0, 32);
  }
  return { proto, caps, client };
}

/**
 * 握手版本闸门（报告 relay 低-12）：显式带 proto 且低于 minProto 的握手必须拒绝。
 * 旧实现把任何过低/不可解析的 proto 静默抬成 minProto，客户端会误以为 relay 按 v4 说话。
 * 没有 proto 字段（更老的客户端）仍按兼容期 v3 接受——这是既有行为，不在此处改变。
 * 返回 null = 可以握手；否则返回 {code, message}（code 用协议码表里的 unsupported）。
 */
function helloVersionError(msg) {
  if (!msg || !Object.prototype.hasOwnProperty.call(msg, "proto") || msg.proto == null) return null;
  const n = Number(msg.proto);
  if (Number.isInteger(n) && n >= PROTOCOL.minProto) return null;
  const shown = String(msg.proto).slice(0, 16);
  return {
    code: "unsupported",
    message: `协议版本过低（proto=${shown}），本 relay 最低支持 ${PROTOCOL.minProto}；请升级客户端`,
  };
}

function helloText(s) {
  const c = s.client || {};
  return `proto=${s.proto} client=${[c.kind, c.version, c.platform].filter(Boolean).join("/") || "-"}`;
}

function errorDef(code) {
  return Object.prototype.hasOwnProperty.call(PROTOCOL.errors, code) ? PROTOCOL.errors[code] : null;
}

/**
 * 失败的 code：relay 自己发的码都在码表里；扩展/attach 报上来的码形状合法就透传，
 * 没带码（旧扩展）或形状不对的填 internal（文案原样保留）。
 */
function failureCode(code) {
  return typeof code === "string" && CODE_RE.test(code) ? code : "internal";
}

/** 查询/协议级失败：{type:"error", id?, room?, deviceId?, code, message, retryable?}；message 缺省用码表文案 */
function errorFrame(code, message, extra) {
  const c = failureCode(code);
  const def = errorDef(c);
  const out = { type: "error" };
  if (extra) {
    for (const k of ["id", "room", "deviceId"]) if (extra[k]) out[k] = extra[k];
  }
  out.code = c;
  out.message = message || (def || PROTOCOL.errors.internal).message;
  if (def && def.retryable) out.retryable = true;
  return out;
}

/**
 * 发送一帧。frame 可以是对象或已序列化字符串。
 * 背压：droppable 帧在对端积压超过 viewerLagBytes 时直接跳过（只丢流式 delta）；
 * 硬顶按「已积压字节 + 本帧字节」判断（只查积压会漏掉正在入队的这一帧，慢 viewer 时
 * 单连接可冲高数十 MB）；超过 viewerMaxBufferBytes 的帧拒绝并记日志，已积压超过硬顶才断开。
 * 关键帧（快照/收尾/ack）不因"慢"而丢——旧实现 8MB 一刀切，大快照刚发出去下一帧就把连接踢掉，形成重连死循环。
 */
function send(ws, frame, cfg, opts) {
  if (!ws || ws.readyState !== 1) return false;
  const lag = (cfg && cfg.viewerLagBytes) || DEFAULT_CONFIG.viewerLagBytes;
  const max = (cfg && cfg.viewerMaxBufferBytes) || DEFAULT_CONFIG.viewerMaxBufferBytes;
  let data;
  try {
    data = typeof frame === "string" ? frame : JSON.stringify(frame);
  } catch {
    return false;
  }
  if (typeof data !== "string") return false;
  const bytes = Buffer.byteLength(data, "utf8");
  const buffered = Number(ws.bufferedAmount) || 0;
  if (buffered > max) {
    log("发送缓冲超过硬顶，断开慢连接:", buffered);
    try { ws.terminate(); } catch {}
    return false;
  }
  // 本帧本身不能让队列越过硬顶：超限帧拒绝（调用方按发送失败处理），不扩大积压。
  if (buffered + bytes > max) {
    ws._oversizeDropped = (ws._oversizeDropped || 0) + 1;
    if (!ws._oversizeLogged || Date.now() - ws._oversizeLogged > 5000) {
      ws._oversizeLogged = Date.now();
      log("发送缓冲将达到硬顶，拒绝本帧:", "buffered=" + buffered, "frame=" + bytes, "max=" + max, "累计拒绝=" + ws._oversizeDropped);
    }
    return false;
  }
  if (opts && opts.droppable && buffered > lag) {
    ws._dropped = (ws._dropped || 0) + 1;
    if (!ws._dropLogged || Date.now() - ws._dropLogged > 5000) {
      ws._dropLogged = Date.now();
      log("viewer 积压，跳过流式帧:", "buffered=" + buffered, "累计跳过=" + ws._dropped);
    }
    return false;
  }
  try {
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/** 同一 payload 广播给多个连接时只序列化一次 */
function broadcast(conns, frame, cfg, opts) {
  const list = conns instanceof Set ? [...conns] : (conns || []);
  if (!list.length) return;
  let data;
  try {
    data = typeof frame === "string" ? frame : JSON.stringify(frame);
  } catch (e) {
    // 与 send 的兜底口径一致（R-6）：序列化不了的帧记一行日志、跳过本次广播，
    // 不能让异常从定时器/setImmediate 路径上抛到进程级、把广播打成半截。
    log("广播序列化失败，跳过本次广播:", e && e.message);
    return;
  }
  for (const c of list) send(c, data, cfg, opts);
}

function ackFrame(origId, ok, extra) {
  const out = { type: "ack", ok: !!ok };
  if (origId) out.id = origId;
  if (extra && extra.room) out.room = extra.room;
  if (!ok) {
    // err.v4：失败必带 code，可重试的再带 retryable:true；error 仍是给人看的文案
    const code = failureCode(extra && extra.code);
    const def = errorDef(code);
    out.error = (extra && extra.error) || (def || PROTOCOL.errors.internal).message;
    out.code = code;
    if (def && def.retryable) out.retryable = true;
  }
  if (extra && extra.deviceId) out.deviceId = extra.deviceId;
  if (extra && "data" in extra) out.data = extra.data;
  if (extra && extra.dedup) out.dedup = true;
  return out;
}

/** 快照帧：正文（rev/seq/truncated/messages）由存储供给，busy 发送时现取。
 *  离线房间上次 state 仍可能记着 busy，快照不报正在输出（subscribed 帧仍可带真）。 */
function snapshotBodyFrom(snap) {
  if (!snap) return `"rev":null,"seq":0,"truncated":false,"messages":[]`;
  let s = `"rev":${JSON.stringify(snap.rev)},"seq":${snap.seq},"truncated":${!!snap.truncated}`;
  if (snap.delta) s += `,"delta":true,"baseSeq":${snap.baseSeq}`;
  return s + `,"messages":[${snap.items.join(",")}]`;
}
function snapshotFrame(room, body) {
  const busy = !!(room.online && room.busy);
  return `{"type":"snapshot","room":${JSON.stringify(room.id)},"busy":${busy},${body}}`;
}

module.exports = { RELAY_VERSION, RELAY_CAPS, hasCap, parseHello, helloVersionError, helloText, failureCode, errorFrame, send, broadcast, ackFrame, snapshotBodyFrom, snapshotFrame };
