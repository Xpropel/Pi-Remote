"use strict";
/**
 * P10「使用活动」relay 侧：校验 / 按 account+device 缓存 / 向 viewer 分发（usage.activity.v1）。
 *
 * 链路：viewer usage_get → relay 查缓存（新鲜则直回）→ 否则向设备 extension 发 usage_refresh
 *       → extension 增量扫描后回 usage_snapshot → relay 校验/落盘缓存/回给等待中的 viewer。
 *
 * 兼容：设备无 usage.activity.v1 cap → unsupported 空态（不阻塞、不重试）；旧 relay 不认 usage_get（本文件即新版）。
 * 隐私：只缓存聚合快照；校验会拒绝含 cost/正文/标题/cwd 等敏感键的数据。缓存文件在 data/accounts/usage/ 下，
 * 按 account+device 哈希命名，重启后仍在（设备离线时回 stale）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const PROTOCOL = require("./protocol.json");
const { log } = require("./util");
const { hasCap, send } = require("./wire");

const USAGE_CAP = "usage.activity.v1";
const USAGE_VERSION = "usage.activity.v1";
const USAGE_DAYS_MAX = Number(PROTOCOL.limits.usageDaysMax) || 400;
const USAGE_MODELS_MAX = Number(PROTOCOL.limits.usageModelsMax) || 8;
const USAGE_SNAPSHOT_MAX_BYTES = Number(PROTOCOL.limits.usageSnapshotMaxBytes) || 262144;
const USAGE_REQUEST_TIMEOUT_MS = Number(PROTOCOL.limits.usageRequestTimeoutMs) || 8000;
const USAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_CACHE_VERSION = 1;
const FORBIDDEN_KEYS = new Set(["cost", "content", "cwd", "title", "text", "path", "body", "prompt"]);

const isRecord = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isNonNegInt = (v) => typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
// 时区偏移沿用扩展的 -getTimezoneOffset() 口径：东半球为正、西半球为负，合法范围 UTC-14..UTC+14。
const TZ_OFFSET_MIN = -840;
const TZ_OFFSET_MAX = 840;
const isTimezoneOffset = (v) => typeof v === "number" && Number.isInteger(v) && v >= TZ_OFFSET_MIN && v <= TZ_OFFSET_MAX;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
const keyHash = (v) => crypto.createHash("sha1").update(String(v)).digest("hex").slice(0, 24);

/** 敏感键深度扫描（快照只允许聚合计数；发现即拒收）。返回命中路径或 null。 */
function sensitivePath(value, at = "$") {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = sensitivePath(value[i], at + "[" + i + "]");
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(k)) return at + "." + k;
    const hit = sensitivePath(v, at + "." + k);
    if (hit) return hit;
  }
  return null;
}

/** 校验 usage.activity.v1 快照（relay 不信任 extension；失败丢弃并记录）。 */
function validateUsageSnapshot(raw) {
  const errors = [];
  if (!isRecord(raw)) return { ok: false, errors: ["快照必须是对象"] };
  const sensitive = sensitivePath(raw);
  if (sensitive) return { ok: false, errors: ["含敏感字段：" + sensitive] };
  if (raw.v !== USAGE_VERSION) errors.push("v 不对");
  if (!isNonNegInt(raw.generatedAt) || raw.generatedAt <= 0) errors.push("generatedAt 非法");
  if (!isRecord(raw.timezone) || typeof raw.timezone.id !== "string" || !isTimezoneOffset(raw.timezone.offsetMinutes)) errors.push("timezone 非法");
  if (!isRecord(raw.range)) errors.push("range 非法");
  // 明细合计供 summary 对账（低-23）：summary 只校验"是对象"时，汇总和 days 对不上也照收，
  // UI 会出现总量与图表自相矛盾的快照。这里把能由 days 推出的上下界全部核对。
  const dayStats = { tokens: 0, user: 0, assistant: 0, sessions: 0, activeDays: 0, maxTokens: 0, maxMessages: 0, dates: new Set() };
  let daysOk = true;
  if (!Array.isArray(raw.days)) {
    errors.push("days 非法");
    daysOk = false;
  } else {
    if (raw.days.length > USAGE_DAYS_MAX) errors.push("days 超上限");
    let prev = "";
    for (let i = 0; i < raw.days.length; i++) {
      const d = raw.days[i];
      if (!isRecord(d) || !isDate(d.date) || !isRecord(d.tokens) || !isRecord(d.messages) || !isNonNegInt(d.sessions)) { errors.push("days[" + i + "] 非法"); daysOk = false; break; }
      if (d.date <= prev) { errors.push("days 必须升序去重"); daysOk = false; break; }
      prev = d.date;
      let dayOk = true;
      for (const k of ["total", "input", "output", "cacheRead", "cacheWrite"]) if (!isNonNegInt(d.tokens[k])) { errors.push("tokens." + k + " 非法"); dayOk = false; break; }
      for (const k of ["user", "assistant"]) if (!isNonNegInt(d.messages[k])) { errors.push("messages." + k + " 非法"); dayOk = false; break; }
      if (!dayOk) { daysOk = false; break; }
      dayStats.dates.add(d.date);
      dayStats.tokens += d.tokens.total;
      dayStats.user += d.messages.user;
      dayStats.assistant += d.messages.assistant;
      dayStats.sessions += d.sessions;
      if (d.sessions > 0 || d.messages.user > 0 || d.messages.assistant > 0 || d.tokens.total > 0) dayStats.activeDays++;
      if (d.tokens.total > dayStats.maxTokens) dayStats.maxTokens = d.tokens.total;
      const messagesOfDay = d.messages.user + d.messages.assistant;
      if (messagesOfDay > dayStats.maxMessages) dayStats.maxMessages = messagesOfDay;
    }
    if (isRecord(raw.range) && isNonNegInt(raw.range.days) && raw.range.days !== raw.days.length) errors.push("range.days 不一致");
  }
  const summary = raw.summary;
  if (!isRecord(summary)) errors.push("summary 非法");
  else {
    const totals = summary.totals;
    let totalsOk = isRecord(totals);
    if (!totalsOk) errors.push("summary.totals 非法");
    else {
      for (const k of ["tokens", "messagesUser", "messagesAssistant", "sessions", "activeDays"]) {
        if (isNonNegInt(totals[k])) continue;
        errors.push("summary.totals." + k + " 非法");
        totalsOk = false;
        break;
      }
    }
    if (!isRecord(summary.streaks) || !isNonNegInt(summary.streaks.current) || !isNonNegInt(summary.streaks.longest)) errors.push("summary.streaks 非法");
    else if (summary.streaks.current > summary.streaks.longest) errors.push("summary.streaks 不一致");
    const peaks = summary.peaks;
    if (!isRecord(peaks)) errors.push("summary.peaks 非法");
    else if (!Object.prototype.hasOwnProperty.call(peaks, "tokens") || !Object.prototype.hasOwnProperty.call(peaks, "messages")) errors.push("summary.peaks 字段不全");
    if (!Array.isArray(summary.models) || summary.models.length > USAGE_MODELS_MAX) errors.push("summary.models 非法/超上限");
    else {
      for (let i = 0; i < summary.models.length; i++) {
        const m = summary.models[i];
        if (!isRecord(m) || typeof m.provider !== "string" || typeof m.model !== "string" || !isNonNegInt(m.tokens)) {
          errors.push("summary.models[" + i + "] 非法");
          break;
        }
      }
    }
    if (summary.modelsWindowDays !== 30) errors.push("modelsWindowDays 必须 30");
    // 汇总 vs 明细：totals 是近 30 天子集，只能 <= 全量 days 合计；峰值必须在 days 里且不超过单日最大。
    if (daysOk && totalsOk) {
      if (totals.tokens > dayStats.tokens) errors.push("summary.totals.tokens 与 days 合计不一致");
      if (totals.messagesUser > dayStats.user) errors.push("summary.totals.messagesUser 与 days 合计不一致");
      if (totals.messagesAssistant > dayStats.assistant) errors.push("summary.totals.messagesAssistant 与 days 合计不一致");
      if (totals.sessions > dayStats.sessions) errors.push("summary.totals.sessions 与 days 合计不一致");
      if (totals.activeDays > dayStats.activeDays || totals.activeDays > raw.days.length) errors.push("summary.totals.activeDays 与 days 不一致");
    }
    if (daysOk && isRecord(peaks)) {
      for (const name of ["tokens", "messages"]) {
        const p = peaks[name];
        if (p == null) continue;
        if (!isRecord(p) || !isDate(p.date) || !isNonNegInt(p.value)) { errors.push("summary.peaks." + name + " 非法"); continue; }
        if (!dayStats.dates.has(p.date)) errors.push("summary.peaks." + name + " 日期不在 days 里");
        if (p.value > (name === "tokens" ? dayStats.maxTokens : dayStats.maxMessages)) errors.push("summary.peaks." + name + " 与 days 明细不一致");
      }
    }
  }
  if (!isRecord(raw.coverage)) errors.push("coverage 非法");
  if (!isRecord(raw.cache)) errors.push("cache 非法");
  if (errors.length) return { ok: false, errors };
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > USAGE_SNAPSHOT_MAX_BYTES) return { ok: false, errors: ["快照 " + bytes + "B 超过上限 " + USAGE_SNAPSHOT_MAX_BYTES] };
  return { ok: true, snapshot: raw };
}

/** 空态帧（无数据/离线/旧端/超时；UI 不报错，只显示空态与一句原因） */
function usageUnavailable(reason, requestId) {
  const frame = { type: "usage_snapshot", available: false, reason };
  if (requestId) frame.requestId = requestId;
  return frame;
}

class UsageBroker {
  constructor({ cfg, index, devices, rooms }) {
    this.cfg = cfg;
    this.index = index;
    this.devices = devices;
    this.rooms = rooms;
    /** deviceId → { relayRequestId, viewers: [{ws, requestId}], timer }（同一设备并发请求合并） */
    this.pending = new Map();
    this.seq = 0;
    this.cacheDir = path.join(index.dir, "usage");
  }

  cacheFile(accountId, deviceId) {
    return path.join(this.cacheDir, keyHash(accountId) + "-" + keyHash(deviceId) + ".json");
  }

  readCache(accountId, deviceId) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.cacheFile(accountId, deviceId), "utf8"));
      if (!raw || raw.v !== USAGE_CACHE_VERSION) return null;
      if (raw.accountId !== accountId || raw.deviceId !== deviceId) return null;
      if (!isNonNegInt(raw.receivedAt)) return null;
      const checked = validateUsageSnapshot(raw.snapshot);
      if (!checked.ok) return null;
      return { accountId, deviceId, receivedAt: raw.receivedAt, snapshot: checked.snapshot };
    } catch {
      return null;
    }
  }

  writeCache(accountId, deviceId, snapshot) {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const file = this.cacheFile(accountId, deviceId);
      const tmp = file + "." + process.pid + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ v: USAGE_CACHE_VERSION, accountId, deviceId, receivedAt: Date.now(), snapshot }), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      log("usage 缓存写入失败（忽略）:", e && e.message);
    }
  }

  /** extension → relay：校验/缓存/回给等待的 viewer（请求 id 对不上视为迟到，丢弃）。 */
  onSnapshot(deviceId, accountId, msg) {
    const pending = this.pending.get(deviceId);
    const checked = msg && validateUsageSnapshot(msg.snapshot);
    if (!checked.ok) {
      log("usage_snapshot 丢弃:", (checked.errors || []).join("; "), deviceId);
      return;
    }
    // 低-22：有等待中的刷新时，快照必须带回同一个 requestId 才能结案。
    // 旧实现允许"不带 requestId"的快照无条件放行，一条旧的全量快照就能顶掉刚发出的强制刷新，
    // 等待的 viewer 拿到的是过期数据还以为是最新。没有等待者时仍接受主动推送（用于预热缓存）。
    if (pending) {
      const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
      if (!requestId || requestId !== pending.relayRequestId) {
        log("usage_snapshot 请求号缺失或不符，忽略（不结案、不写缓存）:", deviceId, requestId || "-");
        return;
      }
    }
    this.writeCache(accountId, deviceId, checked.snapshot);
    if (!pending) return;
    this.pending.delete(deviceId);
    clearTimeout(pending.timer);
    const frame = { type: "usage_snapshot", available: true, snapshot: checked.snapshot, receivedAt: Date.now(), stale: false };
    for (const viewer of pending.viewers) {
      try { send(viewer.ws, { ...frame, requestId: viewer.requestId }, this.cfg); } catch {}
    }
  }

  /**
   * P10 真实链路修复：`dev.conn` 是 **attach 窗口**连接（只声明 session.files/fs.browse），
   * extension 的 usage 能力在**它自己的 room 连接**（room.local）上。usage_refresh 必须发到声明了
   * usage.activity.v1 的连接，否则会发到 attach（忽略未知帧）→ 8s 超时。返回该设备可用的 usage 连接。
   */
  usageConnOf(deviceId) {
    const dev = this.devices.get(deviceId);
    if (dev && dev.conn && hasCap(dev.conn, USAGE_CAP)) return dev.conn;
    for (const room of this.rooms.map.values()) {
      if (room.deviceId !== deviceId) continue;
      if (room.local && hasCap(room.local, USAGE_CAP)) return room.local;
    }
    return null;
  }

  /** viewer → relay：缓存新鲜直接回；否则让设备增量刷新（超时回 stale/空态）。 */
  handleGet(ws, msg, accountId) {
    const deviceId = typeof msg.deviceId === "string" ? msg.deviceId.trim() : "";
    const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 64) : "";
    const force = msg.force === true;
    if (!deviceId) { send(ws, usageUnavailable("no_data", requestId), this.cfg); return; }
    const cached = this.readCache(accountId, deviceId);
    const fresh = cached && !force && Date.now() - cached.receivedAt <= USAGE_CACHE_TTL_MS;
    const dev = this.devices.get(deviceId);
    if (fresh) {
      // 缓存新鲜仍要看设备是否在线：设备离线/名册里没有（relay 重启）时标记 stale，UI 可提示"可能不是最新"。
      // 低-21：stale 必须看**能刷新 usage 的那条连接**（usage.activity.v1 在 extension 的 room 连接上），
      // 旧实现看 dev.conn（attach 窗口）——attach 在线但没有 usage 能力时误报"新鲜"，反之也误报。
      const usageConn = this.usageConnOf(deviceId);
      const stale = !dev || !dev.online || !usageConn || usageConn.readyState !== 1;
      send(ws, { type: "usage_snapshot", available: true, requestId, snapshot: cached.snapshot, receivedAt: cached.receivedAt, stale }, this.cfg);
      return;
    }
    // 设备不在名册（relay 重启后/已删除）：有缓存回 stale，否则空态
    if (!dev) {
      if (cached && cached.accountId === accountId) send(ws, { type: "usage_snapshot", available: true, requestId, snapshot: cached.snapshot, receivedAt: cached.receivedAt, stale: true }, this.cfg);
      else send(ws, usageUnavailable("no_data", requestId), this.cfg);
      return;
    }
    if (dev.accountId !== accountId) { send(ws, usageUnavailable("no_data", requestId), this.cfg); return; }
    // 真实链路：能力在 extension 的 room 连接上（不是 attach 窗口的 dev.conn）
    const usageConn = this.usageConnOf(deviceId);
    if (!usageConn || usageConn.readyState !== 1) {
      if (cached) send(ws, { type: "usage_snapshot", available: true, requestId, snapshot: cached.snapshot, receivedAt: cached.receivedAt, stale: true }, this.cfg);
      else send(ws, usageUnavailable(dev.online ? "unsupported" : "device_offline", requestId), this.cfg);
      return;
    }
    const existing = this.pending.get(deviceId);
    if (existing) {
      // 合并：只发一次 usage_refresh；所有等待 viewer 收到同一快照
      existing.viewers.push({ ws, requestId });
      return;
    }
    const relayRequestId = "u-" + (++this.seq) + "-" + Date.now().toString(36);
    const entry = { relayRequestId, viewers: [{ ws, requestId }], timer: null };
    entry.timer = setTimeout(() => {
      if (!this.pending.has(deviceId)) return;
      this.pending.delete(deviceId);
      const last = this.readCache(accountId, deviceId);
      for (const viewer of entry.viewers) {
        if (last) send(viewer.ws, { type: "usage_snapshot", available: true, requestId: viewer.requestId, snapshot: last.snapshot, receivedAt: last.receivedAt, stale: true }, this.cfg);
        else send(viewer.ws, usageUnavailable("timeout", viewer.requestId), this.cfg);
      }
    }, USAGE_REQUEST_TIMEOUT_MS);
    if (entry.timer.unref) entry.timer.unref();
    this.pending.set(deviceId, entry);
    try { send(usageConn, { type: "usage_refresh", deviceId, requestId: relayRequestId }, this.cfg); } catch (e) { log("usage_refresh 发送失败:", e && e.message); }
  }

  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }
}

module.exports = {
  UsageBroker,
  validateUsageSnapshot,
  usageUnavailable,
  USAGE_CAP,
  USAGE_VERSION,
  USAGE_DAYS_MAX,
  USAGE_MODELS_MAX,
  USAGE_SNAPSHOT_MAX_BYTES,
  USAGE_REQUEST_TIMEOUT_MS,
  USAGE_CACHE_TTL_MS,
  USAGE_CACHE_VERSION,
  TZ_OFFSET_MIN,
  TZ_OFFSET_MAX,
  isTimezoneOffset,
};
