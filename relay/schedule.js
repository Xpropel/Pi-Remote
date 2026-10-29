"use strict";
/**
 * 定时/心跳排期（波次 1 · 设计 D §3）：给远程消息加时间触发——一次定时（once）与
 * 周期心跳（every）。计时器归 relay：排期表落盘（per-account schedules.json，沿
 * InboxStore/PrefsStore 的 tmp+fsync+rename、0600 模式），relay 重启可恢复、到点可算账；
 * extension 零改动——到点时 relay 把消息当一条普通 prompt 命令下发（cid 含排期 id 与
 * 拍号，extension 凭既有 cid 对号机制天然幂等），入队/保序/送达确认全走既有队列机制。
 *
 * 语义红线（§3.1/3.4/3.5）：
 *  - 到点只入队、不打断：投递恒带 streamingBehavior（steer / followUp），忙时进扩展自管队列。
 *  - 投递失败（命令回执失败 / remote_message_failed 送达判失败 / 队列满 busy）→ once、every
 *    都停（state=failed）并写收件箱账本 error 条目（subkind=schedule）：失败通常意味着会话
 *    已死或被拒，心跳不无限重试刷屏。
 *  - 离线：once 顺延宽限 15 分钟（自原 at 起算）补投、超限作废（missed）；every 跳过错过的
 *    拍不积压，房间恢复后 nextAt 从恢复时刻 +interval 重新起算。
 *  - every 按计划节律推进 nextAt（max(now, 上一拍) + interval），落后多拍只补当前一拍。
 *  - expireAt（默认创建 +24h）到点静默退休（expired，不进账本——用户设的到期是预期行为）。
 *  - 一期只支持纯文本：带图片的创建在入口拒绝（排期表落盘存 base64 会膨胀且涉及隐私留存）。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { safeKey } = require("./index");
const { log } = require("./util");

/** 粗粒度 tick：排期不需要秒级精度，5 秒足够且省电（§3.4）。 */
const SCHEDULE_TICK_MS = 5000;
/** 心跳间隔下限（§3.6）：每次触发都是真实回合、真实计费，太密就是烧额度。 */
const SCHEDULE_MIN_INTERVAL_MS = 60 * 1000;
/** 总到期缺省：创建 +24h，防僵尸心跳（§3.3 拍板项 5）。 */
const SCHEDULE_DEFAULT_EXPIRE_MS = 24 * 60 * 60 * 1000;
/** once 离线顺延宽限（自原 at 起算，§3.5 拍板项 4）。 */
const SCHEDULE_ONCE_GRACE_MS = 15 * 60 * 1000;
/** retired/failed 条目在管理面的保留时长，之后清（§3.3）。 */
const SCHEDULE_RETAIN_MS = 24 * 60 * 60 * 1000;
/** 每房间 / 每账号 armed 上限（§3.3）。 */
const SCHEDULE_ROOM_ARMED_MAX = 10;
const SCHEDULE_ACCOUNT_ARMED_MAX = 30;
/** 正文落盘上限：沿队列全文口径 1MB（§3.3）；UI 编辑框上限 10 万字在 UI 侧。 */
const SCHEDULE_TEXT_MAX_BYTES = 1024 * 1024;
/** at 允许的时钟容差：略早于 now 也收（§3.6 的 10 秒容差）。 */
const SCHEDULE_AT_TOLERANCE_MS = 10 * 1000;

const SEGMENTS = new Set(["steer", "follow_up"]);
const KINDS = new Set(["once", "every"]);
const STATES = new Set(["armed", "retired", "failed"]);
const RETIRE_REASONS = new Set(["canceled", "session_ended", "expired", "max_fires", "missed", "delivery_failed"]);

const ID_RE = /^sch_[a-z0-9]{8,32}$/;
const CID_RE = /^(sch_[a-z0-9]{8,32})_(\d{1,9})$/;

function newScheduleId() {
  return "sch_" + crypto.randomBytes(8).toString("hex");
}

/** 排期投递的 cid：sch_<随机>_<拍号>（拍号从 1 起）。extension 队列条目会带上它，
 *  UI 据此在排队卡上标注「来自定时 · 第 N 次」，relay 据 remote_message_failed 对号判失败。 */
function scheduleCid(entry, fireNo) {
  return `${entry.id}_${fireNo}`;
}

/** 解析定时 cid → { scheduleId, fireNo }；不是定时 cid 返回 null。 */
function parseScheduleCid(cid) {
  if (typeof cid !== "string") return null;
  const m = CID_RE.exec(cid);
  if (!m) return null;
  const fireNo = Number(m[2]);
  if (!Number.isSafeInteger(fireNo) || fireNo < 1) return null;
  return { scheduleId: m[1], fireNo };
}

function capStr(v, n) {
  if (typeof v !== "string" || !v) return null;
  const chars = Array.from(v);
  return chars.length > n ? chars.slice(0, n).join("") : v;
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 落盘记录清洗：形状不对整条丢弃（坏排期宁缺毋滥，与 inbox cleanEntry 同纪律）。 */
function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  const accountId = capStr(raw.accountId, 128);
  const roomId = capStr(raw.roomId, 128);
  const text = typeof raw.text === "string" ? raw.text : null;
  if (!accountId || !roomId || text === null || !text) return null;
  if (Buffer.byteLength(text, "utf8") > SCHEDULE_TEXT_MAX_BYTES) return null;
  if (!SEGMENTS.has(raw.segment) || !KINDS.has(raw.kind) || !STATES.has(raw.state)) return null;
  const nextAt = numOr(raw.nextAt, NaN);
  const expireAt = numOr(raw.expireAt, NaN);
  const createdAt = numOr(raw.createdAt, NaN);
  if (!Number.isFinite(nextAt) || !Number.isFinite(expireAt) || !Number.isFinite(createdAt)) return null;
  const entry = {
    id: raw.id,
    accountId,
    roomId,
    deviceId: capStr(raw.deviceId, 128),
    text,
    segment: raw.segment,
    kind: raw.kind,
    nextAt,
    firedCount: Number.isSafeInteger(raw.firedCount) && raw.firedCount >= 0 ? raw.firedCount : 0,
    expireAt,
    state: raw.state,
    createdAt,
    stateAt: numOr(raw.stateAt, createdAt),
  };
  if (raw.kind === "once") {
    const at = numOr(raw.at, NaN);
    if (!Number.isFinite(at)) return null;
    entry.at = at;
  } else {
    const intervalMs = numOr(raw.intervalMs, NaN);
    if (!Number.isFinite(intervalMs) || intervalMs < SCHEDULE_MIN_INTERVAL_MS) return null;
    entry.intervalMs = intervalMs;
  }
  if (Number.isSafeInteger(raw.maxFires) && raw.maxFires >= 1) entry.maxFires = raw.maxFires;
  if (RETIRE_REASONS.has(raw.retireReason)) entry.retireReason = raw.retireReason;
  if (Number.isFinite(numOr(raw.lastFiredAt, NaN))) entry.lastFiredAt = Number(raw.lastFiredAt);
  const lastError = capStr(raw.lastError, 300);
  if (lastError) entry.lastError = lastError;
  return entry;
}

/** 上行/落盘形状：内部瞬时字段（_firing/_missedOffline）不外泄。 */
function wireOf(entry) {
  const wire = {
    id: entry.id,
    accountId: entry.accountId,
    roomId: entry.roomId,
    deviceId: entry.deviceId || null,
    text: entry.text,
    segment: entry.segment,
    kind: entry.kind,
    nextAt: entry.nextAt,
    firedCount: entry.firedCount,
    expireAt: entry.expireAt,
    state: entry.state,
    createdAt: entry.createdAt,
    stateAt: entry.stateAt,
  };
  if (entry.kind === "once") wire.at = entry.at;
  else wire.intervalMs = entry.intervalMs;
  if (entry.maxFires) wire.maxFires = entry.maxFires;
  if (entry.retireReason) wire.retireReason = entry.retireReason;
  if (entry.lastFiredAt) wire.lastFiredAt = entry.lastFiredAt;
  if (entry.lastError) wire.lastError = entry.lastError;
  return wire;
}

/**
 * 创建入参校验（viewer 命令面与测试共用）：返回 { fields } 或 { code, error }。
 * 错误码沿既有同族：bad_args（形状/时刻/间隔）、payload_too_large（正文超限）。
 * 带图片（images 非空）一期直接拒绝（§3.6）。
 */
function validateScheduleInput(raw, now) {
  const bad = (error) => ({ code: "bad_args", error });
  if (!raw || typeof raw !== "object") return bad("排期参数不合法");
  const roomId = typeof raw.roomId === "string" ? raw.roomId.trim() : "";
  if (!roomId) return bad("定时消息需要目标房间");
  const text = typeof raw.text === "string" ? raw.text : "";
  if (!text.trim()) return bad("定时消息正文为空");
  if (Buffer.byteLength(text, "utf8") > SCHEDULE_TEXT_MAX_BYTES) {
    return { code: "payload_too_large", error: "定时消息正文超过 1MB 上限" };
  }
  if (Array.isArray(raw.images) && raw.images.length) {
    return bad("一期定时消息只支持纯文本（带图片不能设定时）");
  }
  const segment = raw.segment === "follow_up" ? "follow_up" : raw.segment === "steer" ? "steer" : null;
  if (!segment) return bad("定时消息需要段位（steer / follow_up）");
  const kind = raw.kind === "every" ? "every" : raw.kind === "once" ? "once" : null;
  if (!kind) return bad("定时方式不合法（once / every）");
  const fields = { roomId, text, segment, kind };
  if (kind === "once") {
    const at = Number(raw.at);
    if (!Number.isFinite(at) || at <= 0) return bad("一次定时需要目标时刻");
    if (at < now - SCHEDULE_AT_TOLERANCE_MS) return bad("目标时刻已过");
    fields.at = at;
    fields.nextAt = at;
  } else {
    const intervalMs = Number(raw.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs < SCHEDULE_MIN_INTERVAL_MS) {
      return bad("心跳间隔不能小于 60 秒");
    }
    fields.intervalMs = Math.floor(intervalMs);
    fields.nextAt = now + fields.intervalMs;
  }
  if (raw.maxFires != null) {
    const maxFires = Number(raw.maxFires);
    if (!Number.isSafeInteger(maxFires) || maxFires < 1 || maxFires > 10000) return bad("触发次数上限不合法");
    fields.maxFires = maxFires;
  }
  if (raw.expireAt != null) {
    const expireAt = Number(raw.expireAt);
    if (!Number.isFinite(expireAt) || expireAt <= now) return bad("到期时刻必须是未来");
    fields.expireAt = expireAt;
  } else {
    fields.expireAt = now + SCHEDULE_DEFAULT_EXPIRE_MS;
  }
  return { fields };
}

/** 与 prefs.js/inbox.js 同款本地 fsync：失败只告警、返回 false。 */
function fsyncFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    log("排期表 fsync 失败（数据可能只在页缓存）:", file, e.message);
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

class ScheduleStore {
  /** accountsDir 与 InboxStore/PrefsStore 同根：data/accounts/<safeKey(accountId)>/schedules.json。 */
  constructor(accountsDir, opts = {}) {
    this.dir = accountsDir ? path.resolve(accountsDir) : null;
    this._now = typeof opts.now === "function" ? opts.now : Date.now;
    /** accountId → Map<id, entry>，懒加载 */
    this._accounts = new Map();
    /** 自上次 drain 以来有条目变化的房间键 `${accountId}|${roomId}`（rooms 据此广播 schedule_update）。 */
    this._dirtyRooms = new Set();
  }

  _file(accountId) {
    return this.dir ? path.join(this.dir, safeKey(accountId), "schedules.json") : null;
  }

  _load(accountId) {
    let bucket = this._accounts.get(accountId);
    if (bucket) return bucket;
    bucket = new Map();
    this._accounts.set(accountId, bucket);
    const file = this._file(accountId);
    if (!file) return bucket;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { raw = null; }
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.entries)) return bucket;
    const now = this._now();
    for (const item of raw.entries) {
      const entry = cleanEntry(item);
      if (!entry || entry.accountId !== accountId) continue;
      // 终态条目只为管理面保留 24h：加载时顺手清掉过期的，免得陈年退休项无限堆积。
      if (entry.state !== "armed" && now - entry.stateAt > SCHEDULE_RETAIN_MS) continue;
      bucket.set(entry.id, entry);
    }
    return bucket;
  }

  _persist(accountId) {
    const file = this._file(accountId);
    if (!file) return;
    const bucket = this._load(accountId);
    const now = this._now();
    for (const [id, entry] of bucket) {
      if (entry.state !== "armed" && now - entry.stateAt > SCHEDULE_RETAIN_MS) bucket.delete(id);
    }
    const payload = { v: 1, accountId, entries: [...bucket.values()].map(wireOf) };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      if (!fsyncFile(tmp)) throw new Error("tmp fsync 失败");
      fs.renameSync(tmp, file);
    } catch (e) {
      log("排期表落盘失败（继续内存服务）:", e && e.message ? e.message : e);
    }
  }

  _noteDirty(entry) {
    this._dirtyRooms.add(`${entry.accountId}|${entry.roomId}`);
  }

  /** rooms 的广播 flush 取走自上次以来变化过的房间键（accountId|roomId）。 */
  drainDirtyRooms() {
    if (!this._dirtyRooms.size) return [];
    const out = [...this._dirtyRooms];
    this._dirtyRooms.clear();
    return out;
  }

  /** 提前加载主账号（装配时调）。 */
  prime(accountId) {
    if (accountId) this._load(accountId);
  }

  /**
   * 扫 accountsDir 把所有已有排期表都加载进来：计时器是全局职责，重启后任何账号的
   * armed 排期都得能算账——不能等该账号先有房间活动才懒加载（与 inbox 的「查已加载
   * 账号」不同，这里按文件 payload 里的 accountId 建桶，目录名不可逆也不需要逆）。
   */
  primeAll() {
    if (!this.dir) return;
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const file = path.join(this.dir, name, "schedules.json");
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      if (!raw || typeof raw !== "object") continue;
      const accountId = typeof raw.accountId === "string" && raw.accountId ? raw.accountId
        : (Array.isArray(raw.entries) && raw.entries[0] && typeof raw.entries[0].accountId === "string" ? raw.entries[0].accountId : null);
      if (accountId) this._load(accountId);
    }
  }

  _knownAccounts() {
    return [...this._accounts.keys()];
  }

  /** 新建一条 armed 排期（入参已经过 validateScheduleInput + 上限裁决）。 */
  create(accountId, fields, now = this._now()) {
    const bucket = this._load(accountId);
    const entry = {
      id: newScheduleId(),
      accountId,
      roomId: fields.roomId,
      deviceId: fields.deviceId || null,
      text: fields.text,
      segment: fields.segment,
      kind: fields.kind,
      nextAt: fields.nextAt,
      firedCount: 0,
      expireAt: fields.expireAt,
      state: "armed",
      createdAt: now,
      stateAt: now,
    };
    if (fields.kind === "once") entry.at = fields.at;
    else entry.intervalMs = fields.intervalMs;
    if (fields.maxFires) entry.maxFires = fields.maxFires;
    bucket.set(entry.id, entry);
    this._persist(accountId);
    this._noteDirty(entry);
    return entry;
  }

  get(accountId, id) {
    return this._load(accountId).get(id) || null;
  }

  /** 跨账号按 id 查（remote_message_failed 对号、会话结束退休都只拿得到 id/roomId）。 */
  findById(id) {
    for (const accountId of this._knownAccounts()) {
      const entry = this._accounts.get(accountId).get(id);
      if (entry) return entry;
    }
    return null;
  }

  /** 状态推进后落盘 + 记脏（引擎的每次迁移都走这里，保证重启恢复与广播不漏）。 */
  update(entry, now = this._now()) {
    entry.stateAt = now;
    this._persist(entry.accountId);
    this._noteDirty(entry);
    return entry;
  }

  /** 某房的上行清单：armed 全量 + 保留期内 retired/failed（§3.7），按创建时间排序。 */
  listRoom(accountId, roomId, now = this._now()) {
    const bucket = this._load(accountId);
    const out = [];
    for (const entry of bucket.values()) {
      if (entry.roomId !== roomId) continue;
      if (entry.state !== "armed" && now - entry.stateAt > SCHEDULE_RETAIN_MS) continue;
      out.push(wireOf(entry));
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  /** 全部 armed 条目（tick 的工作集），内部形状（含瞬时字段）。 */
  armedEntries() {
    const out = [];
    for (const accountId of this._knownAccounts()) {
      for (const entry of this._accounts.get(accountId).values()) {
        if (entry.state === "armed") out.push(entry);
      }
    }
    return out;
  }

  armedCount(accountId, roomId = null) {
    let n = 0;
    for (const entry of this._load(accountId).values()) {
      if (entry.state !== "armed") continue;
      if (roomId && entry.roomId !== roomId) continue;
      n += 1;
    }
    return n;
  }

  /** 某房全部 armed 条目（会话结束退休用），跨账号。 */
  armedOfRoom(roomId) {
    return this.armedEntries().filter((e) => e.roomId === roomId);
  }
}

/** 账本 error 的固定文案：只报状态不带正文（与推送内容最小化同一纪律）。 */
const INBOX_TITLES = {
  delivery_failed: "定时消息投递失败",
  missed: "定时消息已作废（错过投递窗口）",
  session_ended: "定时消息已作废（会话已结束）",
};

/**
 * 排期引擎（闹钟）：持有 tick 与全部状态迁移；房间在线状态与投递经 host 注入
 * （rooms 装配：peekRoom / deliver），账本经 inbox 注入（未注入时提示静默跳过）。
 * deliver(room, entry, fireNo, done)：done({ok:true}) / done({ok:false, error})，
 * 只许回调一次语义由引擎侧 token 守卫兜底（迟到回执一律忽略）。
 */
class ScheduleEngine {
  constructor({ store, inbox = null, now, tickMs, graceMs, startGraceMs } = {}) {
    if (!store) throw new Error("ScheduleEngine 需要 ScheduleStore");
    this.store = store;
    this.inbox = inbox;
    this._now = typeof now === "function" ? now : Date.now;
    this.tickMs = Number.isFinite(tickMs) && tickMs > 0 ? tickMs : SCHEDULE_TICK_MS;
    this.graceMs = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : SCHEDULE_ONCE_GRACE_MS;
    // 启动宽限：relay 重启后扩展需要时间重连注册，宽限内「房间不在内存表」只按离线
    // 处理，不判会话结束——否则每次重启都会把全部 armed 排期误退休。
    this.startGraceMs = Number.isFinite(startGraceMs) && startGraceMs >= 0 ? startGraceMs : 60 * 1000;
    this.host = null;
    this._timer = null;
    this._startedAt = 0;
  }

  bindHost(host) {
    this.host = host || null;
  }

  /** 排期表有变化时通知装配层（rooms 据此 drain 脏房间并广播 schedule_update）。 */
  _changed() {
    if (this.host && typeof this.host.onDirty === "function") {
      try { this.host.onDirty(); } catch {}
    }
  }

  start() {
    if (this._timer) return;
    this._startedAt = this._now();
    // 启动先跑一遍过期处理（§3.4：排期表读回后按 nextAt 与 now 的关系算账），再起 tick。
    try { this.tick(); } catch (e) { log("排期启动算账失败:", e.message); }
    this._timer = setInterval(() => {
      try { this.tick(); } catch (e) { log("排期 tick 失败:", e.message); }
    }, this.tickMs);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /* ---------------- 命令面（viewer → rooms → 这里） ---------------- */

  /** 创建：校验 + 上限裁决 + 落表。返回 { entry } 或 { code, error }。 */
  create(accountId, raw, now = this._now()) {
    const v = validateScheduleInput(raw, now);
    if (!v.fields) return v;
    if (this.store.armedCount(accountId, v.fields.roomId) >= SCHEDULE_ROOM_ARMED_MAX) {
      return { code: "queue_locked", error: `这个会话的定时消息已达上限（${SCHEDULE_ROOM_ARMED_MAX} 条）` };
    }
    if (this.store.armedCount(accountId) >= SCHEDULE_ACCOUNT_ARMED_MAX) {
      return { code: "queue_locked", error: `定时消息总数已达上限（${SCHEDULE_ACCOUNT_ARMED_MAX} 条）` };
    }
    const room = this.host && typeof this.host.peekRoom === "function" ? this.host.peekRoom(v.fields.roomId) : null;
    const entry = this.store.create(accountId, {
      ...v.fields,
      deviceId: room && room.deviceId ? room.deviceId : null,
    }, now);
    this._changed();
    return { entry };
  }

  /** 取消：只有 armed 能取消（终态条目本来就不会再触发）。返回被取消条目或 null。 */
  cancel(accountId, id, now = this._now()) {
    const entry = typeof id === "string" ? this.store.get(accountId, id) : null;
    if (!entry || entry.state !== "armed") return null;
    entry._firing = null;
    this._retire(entry, "canceled", now);
    this._changed();
    return entry;
  }

  /* ---------------- 状态迁移 ---------------- */

  _retire(entry, reason, now) {
    entry.state = "retired";
    entry.retireReason = reason;
    entry._firing = null;
    this.store.update(entry, now);
  }

  _fail(entry, now, errorText) {
    entry.state = "failed";
    entry.retireReason = "delivery_failed";
    if (errorText) entry.lastError = String(errorText).slice(0, 300);
    entry._firing = null;
    this.store.update(entry, now);
    this._inboxError(entry, "delivery_failed", now);
  }

  _inboxError(entry, reason, now) {
    if (!this.inbox || typeof this.inbox.upsertScheduleError !== "function") return;
    try {
      this.inbox.upsertScheduleError({
        key: `sched:${entry.id}`,
        accountId: entry.accountId,
        roomId: entry.roomId,
        deviceId: entry.deviceId || null,
        title: INBOX_TITLES[reason] || INBOX_TITLES.delivery_failed,
        at: now,
      }, now);
      if (typeof this.host?.flushInbox === "function") this.host.flushInbox();
    } catch (e) {
      log("排期失败写账本失败:", entry.id, e.message);
    }
  }

  /** 会话结束/换代（rooms 的 clearSessionState 钩子）：该房 armed 全部退休 + 账本提示。 */
  retireRoom(roomId, now = this._now()) {
    let n = 0;
    for (const entry of this.store.armedOfRoom(roomId)) {
      this._retire(entry, "session_ended", now);
      this._inboxError(entry, "session_ended", now);
      n += 1;
    }
    if (n) this._changed();
    return n;
  }

  /**
   * 送达确认判失败（remote_message_failed 事件，cid 对号）：命令回执可能已判成功
   * （消息进了扩展队列），之后注入失败照样要停——这正是 §3.4 的第三种失败来源。
   * 在飞的那一拍以失败结案；已计数的那一拍失败则整条停机。过期/无关 cid 忽略。
   */
  noteRemoteFailed(cid, errorText, now = this._now()) {
    const parsed = parseScheduleCid(cid);
    if (!parsed) return false;
    const entry = this.store.findById(parsed.scheduleId);
    if (!entry || entry.state !== "armed") return false;
    if (entry._firing && entry._firing.fireNo === parsed.fireNo) {
      this._fail(entry, now, errorText || "消息未注入");
      this._changed();
      return true;
    }
    if (entry.firedCount === parsed.fireNo) {
      this._fail(entry, now, errorText || "消息未注入");
      this._changed();
      return true;
    }
    return false;
  }

  /* ---------------- tick 与投递 ---------------- */

  tick(now = this._now()) {
    if (!this.host) return;
    for (const entry of this.store.armedEntries()) {
      if (entry.state !== "armed" || entry._firing) continue;
      // 总到期优先于一切：静默退休（用户设的到期就是预期行为，不进账本）。
      if (now >= entry.expireAt) {
        this._retire(entry, "expired", now);
        continue;
      }
      const room = typeof this.host.peekRoom === "function" ? this.host.peekRoom(entry.roomId) : null;
      if (!room && now - this._startedAt >= this.startGraceMs) {
        // 房间已不在内存表（被淘汰/从未注册）：按会话结束处理，不让排期悬空。
        // 启动宽限内不在此列（扩展还没重连回来），落到下面的离线分支按离线算。
        this._retire(entry, "session_ended", now);
        this._inboxError(entry, "session_ended", now);
        continue;
      }
      if (!room || !room.online) {
        if (entry.kind === "once") {
          if (now > entry.at + this.graceMs) {
            this._retire(entry, "missed", now);
            this._inboxError(entry, "missed", now);
          }
          // 宽限内：保持 armed 等房间回来（重注册后 tick 自然补投）。
        } else if (entry.nextAt <= now) {
          entry._missedOffline = true; // 只记内存标记：恢复后按§3.5 重新起算，不落盘
        }
        continue;
      }
      if (entry.kind === "every" && entry._missedOffline) {
        // 离线错过的拍不补：从恢复时刻重新起算节律。
        entry._missedOffline = false;
        entry.nextAt = now + entry.intervalMs;
        this.store.update(entry, now);
        continue;
      }
      if (entry.kind === "once" && now > entry.at + this.graceMs) {
        // relay 自己停机错过窗口：与离线同规矩，超宽限即作废（§3.5 第二行）。
        this._retire(entry, "missed", now);
        this._inboxError(entry, "missed", now);
        continue;
      }
      if (entry.nextAt <= now) this._fire(entry, room, now);
    }
    this._changed();
  }

  _fire(entry, room, now) {
    const fireNo = entry.firedCount + 1;
    const prevNextAt = entry.nextAt;
    entry._firing = { fireNo, cid: scheduleCid(entry, fireNo), at: now };
    const done = (outcome) => {
      // token 守卫：同一拍只结案一次（命令结果/超时/送达失败谁先到谁算，迟到一律忽略）。
      if (!entry._firing || entry._firing.fireNo !== fireNo) return;
      entry._firing = null;
      const t2 = this._now();
      if (entry.state !== "armed") return; // 在飞期间被取消/退休：结果不再推进状态
      if (outcome && outcome.ok) {
        entry.firedCount = fireNo;
        entry.lastFiredAt = t2;
        delete entry.lastError;
        if (entry.kind === "once") {
          this._retire(entry, "max_fires", t2); // once 完成即退休（§3.4：max_fires 语义即完成）
        } else if (entry.maxFires && entry.firedCount >= entry.maxFires) {
          this._retire(entry, "max_fires", t2);
        } else {
          // 按计划节律推进：max(现在, 上一拍) + 间隔——投递耗时不拖偏、落后多拍不追赶。
          entry.nextAt = Math.max(t2, prevNextAt) + entry.intervalMs;
          this.store.update(entry, t2);
        }
      } else {
        this._fail(entry, t2, (outcome && outcome.error) || "投递失败");
      }
    };
    try {
      this.host.deliver(room, entry, fireNo, done);
    } catch (e) {
      done({ ok: false, error: e && e.message ? e.message : "投递失败" });
    }
  }
}

module.exports = {
  ScheduleStore,
  ScheduleEngine,
  validateScheduleInput,
  cleanEntry,
  wireOf,
  scheduleCid,
  parseScheduleCid,
  INBOX_TITLES,
  SCHEDULE_TICK_MS,
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_DEFAULT_EXPIRE_MS,
  SCHEDULE_ONCE_GRACE_MS,
  SCHEDULE_RETAIN_MS,
  SCHEDULE_ROOM_ARMED_MAX,
  SCHEDULE_ACCOUNT_ARMED_MAX,
  SCHEDULE_TEXT_MAX_BYTES,
};
