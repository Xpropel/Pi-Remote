"use strict";
/** 命令：超时表、白名单与错误文案、viewer → local → viewer 的等待与去重 */
const crypto = require("node:crypto");
const { log } = require("./util");
const { send, ackFrame } = require("./wire");

/* ---------------- 命令超时表（relay 是唯一权威；转发给扩展，回给 viewer） ---------------- */
const SESSION_OP_COMMANDS = new Set(["new_session", "switch_session", "fork", "clone", "navigate_tree", "delete_session"]);
const SLOW_READ_COMMANDS = new Set(["export_session", "list_sessions", "get_entries", "get_projection", "get_tree", "get_session_stats", "get_file", "get_image", "search_session_bodies"]);
/** 没有活动房间也能对目标 .jsonl 执行的会话文件操作（改名/导出/冷 fork）。 */
const INACTIVE_SESSION_COMMANDS = new Set(["rename_session_file", "export_session_file", "fork_session_file"]);

function commandTimeoutMs(command, args, harnessMs) {
  // harness_start 只有一个口径：cfg.harnessStartTimeoutMs（原来这里写死 10000，改配置只生效一半）
  if (command === "harness_start") {
    const v = Number(harnessMs);
    return Number.isFinite(v) && v > 0 ? v : 10000;
  }
  if (command === "compact" || command === "regenerate") return 120000;
  // 跳树并总结要等一次模型调用；沿用 30s 会在摘要还没回来时先判超时。
  if (command === "navigate_tree" && args && args.summarize === true) return 120000;
  if (command === "bash") {
    const t = Math.max(1, Math.min(120, Number(args && args.timeout) || 30));
    return (t + 15) * 1000;
  }
  // 目录浏览是本地 readdir，正常几毫秒；给 8s 而不是默认 15s，卡住时网页能更早报错重试（P9 C）
  if (command === "list_dirs") return 8000;
  if (SESSION_OP_COMMANDS.has(command) || SLOW_READ_COMMANDS.has(command) || INACTIVE_SESSION_COMMANDS.has(command)) return 30000;
  if (command === "abort") return 20000;
  return 15000;
}

/** 发消息类命令：args.cid（msg.cid）在这里校验，其余参数原样转发 */
const MESSAGE_COMMANDS = new Set(["prompt", "steer", "follow_up"]);
/** 带 cid 的远程消息事件：回显、送达、失败 */
const REMOTE_MESSAGE_EVENTS = new Set(["remote_message", "remote_message_delivered", "remote_message_failed"]);

/** 设备级命令白名单。发消息类必须走房间，不在此列。 */
const DEVICE_COMMANDS = new Set([
  "switch_session", "new_session", "fork", "clone", "get_state", "get_sessions", "harness_start",
  "get_file", "get_image", "get_host_diag", "search_session_bodies", "list_dirs",
  ...INACTIVE_SESSION_COMMANDS,
]);

/** 只读设备命令：没有活动会话时也允许直达设备（诊断/文件回程恰恰在没会话时最需要）。
 *  仍是 DEVICE_COMMANDS 的子集：白名单与设备在线检查照旧，发消息类永远不在此列。 */
const READONLY_DEVICE_COMMANDS = new Set(["get_file", "get_image", "get_host_diag"]);

const DEVICE_ERRORS = {
  no_device: "这台设备从未连接过",
  device_offline: "设备未连接：先在电脑上打开 attach 窗口",
  device_no_active_session: "这台设备没有在跑的会话，先启用/新建一个",
  session_not_found: "这台设备上没有这个会话",
  cwd_not_allowed: "该目录不在这台设备的允许列表里",
};

const HARNESS_BUSY = "正在启动另一个会话，请稍候";
const HARNESS_ARGS = "参数错误：cwd 与 sessionId 必须二选一";

/** 低-20：relay 超时后保留条目的对账窗口。设备可能只是慢，结果迟到时仍要跑 onResult
 *  （删除会话的服务器副本清理）并让带 dedupeKey 的重发取回结果；窗口过后才丢条目。 */
const COMMAND_RECONCILE_GRACE_MS = 60 * 1000;

/* ---------------- 命令路由（viewer → local → viewer） ---------------- */
/** CommandEntry = { wireId, room, command, local, timeoutMs, waiters:[{ws, origId, timer}], done, result, at, key } */

/** 稳定序列化（对象键排序）：同一份参数无论键序如何都得到同一个去重指纹。 */
function stableJson(value) {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    return text === undefined ? "null" : text;
  }
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

/** 参数指纹：只取摘要，不把消息正文/大 base64 塞进去重键（键会进日志/Map）。 */
function argsDigest(args) {
  let text = "{}";
  try {
    text = stableJson(args == null ? {} : args);
  } catch {
    text = "{}";
  }
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * 去重键 = 作用域 + 命令名 + 参数指纹 + 客户端 key（报告 relay 低-10）。
 * 只绑定 (作用域, dedupeKey) 时，客户端复用同一个 key 发不同命令/参数会拿到上一个结果。
 * 同一逻辑请求重发时命令名与参数不变，指纹稳定，去重/回放语义保持不变。
 * 完整契约（命中/在飞/超时对账/与 cid 的分工）见 protocol/relay-sync.md §3。
 */
function dedupeKeyOf(scope, command, args, key) {
  return String(scope || "") + "|" + String(command || "") + "|" + argsDigest(args) + "|" + String(key || "");
}

function finishWaiter(w) {
  if (w.timer) clearTimeout(w.timer);
  w.timer = null;
}

function settleEntry(entry) {
  if (!entry || entry._settled) return;
  entry._settled = true;
  // viewer 断线后无 key 命令的兜底清理定时器（见 viewer close）：结果/超时已落定就撤销。
  if (entry._orphanTimer) {
    clearTimeout(entry._orphanTimer);
    entry._orphanTimer = null;
  }
  if (entry._reconcileTimer) {
    clearTimeout(entry._reconcileTimer);
    entry._reconcileTimer = null;
  }
  if (typeof entry.onSettle === "function") {
    try { entry.onSettle(); } catch (e) { log("命令收尾异常:", e.message); }
  }
}

/**
 * 超时后保留条目的对账窗口（低-20）。设备侧没有可靠的取消帧，relay 不能假装命令没执行；
 * 能做的是：结果迟到时仍按原 wireId 收下（跑 onResult、更新去重表），窗口过后才清理，
 * 避免条目永久占着 commandWaiters。
 */
function armReconcileCleanup(rooms, entry) {
  if (!rooms || !entry) return;
  if (entry._reconcileTimer) clearTimeout(entry._reconcileTimer);
  // 窗口至少覆盖一次完整的命令超时：120s 档的命令重发后仍在窗口内等待，不能被提前清掉。
  const grace = Math.max(COMMAND_RECONCILE_GRACE_MS, Number(entry.timeoutMs) || 0);
  entry._reconcileTimer = setTimeout(() => {
    entry._reconcileTimer = null;
    if (rooms.commandWaiters.get(entry.wireId) !== entry) return;
    // 重发请求在窗口内又挂上了 waiter：继续保留，重新计时，别把还在等的请求清掉。
    if (entry.waiters.length) return armReconcileCleanup(rooms, entry);
    if (!entry.done) log("命令超时后对账窗口结束，仍无结果，清理:", entry.room && entry.room.id, entry.wireId, entry.command);
    rooms.commandWaiters.delete(entry.wireId);
    if (entry.key && rooms.dedupe.get(entry.key) === entry) rooms.dedupe.delete(entry.key);
  }, grace);
  if (entry._reconcileTimer.unref) entry._reconcileTimer.unref();
}

function armWaiter(rooms, entry, w, cfg) {
  w.timer = setTimeout(() => {
    w.timer = null;
    const i = entry.waiters.indexOf(w);
    if (i >= 0) entry.waiters.splice(i, 1);
    entry._timedOut = true;
    log("命令超时:", entry.room && entry.room.id, entry.wireId, entry.command);
    send(w.ws, ackFrame(w.origId, false, {
      room: entry.room && entry.room.id,
      deviceId: entry.deviceId,
      error: "本机执行超时（" + entry.timeoutMs / 1000 + "s）",
      code: "timeout",
    }), cfg);
    // 低-20：超时只代表"relay 不等了"，设备可能还在执行。所有条目都保留对账窗口：
    // 迟到结果仍会跑 onResult，带 key 的还可被重发取回；窗口结束后由 armReconcileCleanup 清理。
    // 旧实现立刻删掉无 key 条目，删除会话的迟到结果会被当成"waiter 已不存在"丢掉，服务器副本复活。
    if (!entry.waiters.length) {
      settleEntry(entry);
      armReconcileCleanup(rooms, entry);
    }
  }, entry.timeoutMs);
  w.timer.unref();
}

function pruneDedupe(rooms, cfg) {
  const cutoff = Date.now() - cfg.dedupeTtlMs;
  for (const [k, e] of rooms.dedupe) {
    if (e.at < cutoff && !e.waiters.length) {
      rooms.dedupe.delete(k);
      if (rooms.commandWaiters.get(e.wireId) === e) rooms.commandWaiters.delete(e.wireId);
    }
  }
  // 只丢已经完成的条目：等待者数量为 0 不代表命令结束（viewer 断线后命令还在本机跑），
  // 把在飞条目挤掉会让重连后的同 key 重发被第二次真执行（报告 relay 中-8）。
  while (rooms.dedupe.size > 2000) {
    let evicted = false;
    for (const [k, e] of rooms.dedupe) {
      if (!e.done) continue;
      if (e.waiters && e.waiters.length) continue;
      rooms.dedupe.delete(k);
      if (rooms.commandWaiters.get(e.wireId) === e) rooms.commandWaiters.delete(e.wireId);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
}

module.exports = { commandTimeoutMs, MESSAGE_COMMANDS, REMOTE_MESSAGE_EVENTS, DEVICE_COMMANDS, READONLY_DEVICE_COMMANDS, INACTIVE_SESSION_COMMANDS, DEVICE_ERRORS, HARNESS_BUSY, HARNESS_ARGS, COMMAND_RECONCILE_GRACE_MS, finishWaiter, settleEntry, armWaiter, armReconcileCleanup, pruneDedupe, stableJson, argsDigest, dedupeKeyOf };
