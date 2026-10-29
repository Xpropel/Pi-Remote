// 收件箱账本（波次 1 · D-§1）：全局「等你处理」清单的 relay 侧唯一事实源。
// 只存元数据（房、对话 id、种类、一句标题、时间）——绝不存正文：不存 options/message/prefill，
// 标题是协议面 dialog_open 本来就带的一句摘要（≤120 字，与槽位同口径）。
// 落盘沿 PrefsStore 模式：per-account 一份 inbox.json（data/accounts/<safeKey>/inbox.json），
// tmp + fsync + rename、0600；账本只为重启恢复，未读跨重启不丢靠它，运行时以内存为准。
// 写失败（磁盘满/只读）只记日志、内存继续服务，不让账本拖垮 relay 本体。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { safeKey } = require("./index");
const { log } = require("./util");

/** 与 prefs.js 同款本地 fsync（index.js 的那份未导出）：失败只告警、返回 false。 */
function fsyncFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    log("收件箱 fsync 失败（数据可能只在页缓存）:", file, e.message);
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** pending 上限（每账号）：溢出先淘 done 再淘 error，waiting 永不淘汰（§1.2）。 */
const INBOX_PENDING_MAX = 50;
/** 墓碑保留时长：过期的墓碑在加载/写入时顺手清掉（§1.2）。 */
const INBOX_TOMB_RETENTION_MS = 24 * 60 * 60 * 1000;
/** 字段上限（与槽位/协议口径同源：dialogId ≤64、标题 ≤120）。 */
const INBOX_TITLE_MAX = 120;
const INBOX_KEY_MAX = 240;

const KINDS = new Set(["waiting", "error", "done"]);
const SUBKINDS = new Set(["dialog", "prompt", "ask", "turn", "schedule"]);
const GONE_REASONS = new Set(["answered", "resolved", "timeout", "dismissed", "stale"]);

function capStr(v, n) {
  if (typeof v !== "string" || !v) return null;
  const chars = Array.from(v);
  return chars.length > n ? chars.slice(0, n).join("") : v;
}

/** 落盘/上行前的字段清洗：形状不对整条丢弃（账本坏数据宁缺毋滥）。 */
function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = capStr(raw.key, INBOX_KEY_MAX);
  const roomId = capStr(raw.roomId, 128);
  if (!key || !roomId) return null;
  if (!KINDS.has(raw.kind) || !SUBKINDS.has(raw.subkind)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const entry = {
    key,
    accountId: capStr(raw.accountId, 128) || "default",
    roomId,
    deviceId: capStr(raw.deviceId, 128),
    kind: raw.kind,
    subkind: raw.subkind,
    at,
  };
  const dialogKind = capStr(raw.dialogKind, 32);
  if (dialogKind) entry.dialogKind = dialogKind;
  const title = capStr(raw.title, INBOX_TITLE_MAX);
  if (title) entry.title = title;
  if (typeof raw.answerable === "boolean") entry.answerable = raw.answerable;
  return entry;
}

/** 上行形状：白名单字段（§1.5），内部标记（_restored）不外泄。 */
function wireOf(entry) {
  const wire = {
    key: entry.key,
    accountId: entry.accountId,
    roomId: entry.roomId,
    deviceId: entry.deviceId || null,
    kind: entry.kind,
    subkind: entry.subkind,
    at: entry.at,
  };
  if (entry.dialogKind) wire.dialogKind = entry.dialogKind;
  if (entry.title) wire.title = entry.title;
  if (typeof entry.answerable === "boolean") wire.answerable = entry.answerable;
  return wire;
}

function sameWire(a, b) {
  return a.roomId === b.roomId && a.deviceId === b.deviceId && a.kind === b.kind &&
    a.subkind === b.subkind && a.dialogKind === b.dialogKind && a.title === b.title &&
    a.answerable === b.answerable && a.at === b.at;
}

class InboxStore {
  /** accountsDir 与 AccountIndex/PrefsStore 同根：data/accounts/<safeKey(accountId)>/inbox.json。 */
  constructor(accountsDir, opts = {}) {
    this.dir = accountsDir ? path.resolve(accountsDir) : null;
    this._now = typeof opts.now === "function" ? opts.now : Date.now;
    /** accountId → { entries: Map<key, entry>, tombs: Map<key, {goneAt, goneReason}> }，懒加载 */
    this._accounts = new Map();
    /** 增量广播的待发变更（rooms.flush 时 drain）：key → wire 条目 / 已删 key */
    this._changeUpserts = new Map();
    this._changeRemoved = new Set();
    /** §1.6 推送接口面：notify 后续改订这里的迁移事件（created/updated/removed），去重键 = 条目 key。 */
    this._listeners = new Set();
  }

  _file(accountId) {
    return this.dir ? path.join(this.dir, safeKey(accountId), "inbox.json") : null;
  }

  _load(accountId) {
    let bucket = this._accounts.get(accountId);
    if (bucket) return bucket;
    bucket = { entries: new Map(), tombs: new Map() };
    this._accounts.set(accountId, bucket);
    const file = this._file(accountId);
    if (!file) return bucket;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { raw = null; }
    if (!raw || typeof raw !== "object") return bucket;
    const now = this._now();
    if (Array.isArray(raw.entries)) {
      for (const item of raw.entries) {
        const entry = cleanEntry(item);
        if (!entry || entry.accountId !== accountId) continue;
        // 重启恢复的 waiting 一律先标「未确认」：等房间重连补发对账（confirm 或 sweep 成 stale），
        // turn 条目原样恢复——这正是「未读跨 relay 重启不丢」（§1.4）。
        if (entry.kind === "waiting") entry._restored = true;
        bucket.entries.set(entry.key, entry);
      }
    }
    if (raw.tombs && typeof raw.tombs === "object") {
      for (const [key, tomb] of Object.entries(raw.tombs)) {
        if (!tomb || typeof tomb !== "object") continue;
        const goneAt = Number(tomb.goneAt);
        if (!Number.isFinite(goneAt) || now - goneAt > INBOX_TOMB_RETENTION_MS) continue;
        bucket.tombs.set(key, { goneAt, goneReason: GONE_REASONS.has(tomb.goneReason) ? tomb.goneReason : "resolved" });
      }
    }
    return bucket;
  }

  _persist(accountId, now = this._now()) {
    const file = this._file(accountId);
    if (!file) return;
    const bucket = this._load(accountId);
    // 清理过期墓碑必须与写入方同一个时钟（调用方传事件时刻）：混用真实时钟会把
    // 刚写下的墓碑按「过期」误删（单测用小时间戳时必现，生产同理只差量级）。
    for (const [key, tomb] of bucket.tombs) {
      if (now - tomb.goneAt > INBOX_TOMB_RETENTION_MS) bucket.tombs.delete(key);
    }
    const payload = {
      v: 1,
      entries: [...bucket.entries.values()].map(wireOf),
      tombs: Object.fromEntries(bucket.tombs),
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      if (!fsyncFile(tmp)) throw new Error("tmp fsync 失败");
      fs.renameSync(tmp, file);
    } catch (e) {
      log("收件箱账本落盘失败（继续内存服务）:", e && e.message ? e.message : e);
    }
  }

  _emit(evt) {
    for (const fn of this._listeners) {
      try { fn(evt); } catch {}
    }
  }

  /** §1.6：推送（设计 C）订阅口——迁移事件 {type, entry|key, reason?}，去重键 = entry.key。 */
  onTransition(fn) {
    if (typeof fn === "function") this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _noteUpsert(entry) {
    this._changeRemoved.delete(entry.key);
    this._changeUpserts.set(entry.key, wireOf(entry));
  }

  _noteRemoved(key) {
    this._changeUpserts.delete(key);
    this._changeRemoved.add(key);
  }

  /** rooms 的广播 flush 取走自上次以来的增量（upserts 为上行形状，removed 为 key 列表）。 */
  drainChanges() {
    if (!this._changeUpserts.size && !this._changeRemoved.size) return null;
    const out = { upserts: [...this._changeUpserts.values()], removed: [...this._changeRemoved] };
    this._changeUpserts.clear();
    this._changeRemoved.clear();
    return out;
  }

  /**
   * 建/更新一条 pending 条目。来源事件（实时槽位/落定）永远压过墓碑：墓碑只防「重启恢复时
   * 把已消的条目当未确认 waiting 挂回去」，活槽重现即以槽为准重建（§1.4 裁决）。
   * 返回 { entry, created }；字段无变化时返回 null（不落盘、不发迁移事件，保证对账幂等）。
   */
  upsert(raw, now = this._now()) {
    const entry = cleanEntry(raw);
    if (!entry) return null;
    const bucket = this._load(entry.accountId);
    bucket.tombs.delete(entry.key);
    const prev = bucket.entries.get(entry.key);
    if (prev && !prev._restored && sameWire(prev, entry)) return null;
    const created = !prev;
    bucket.entries.set(entry.key, entry);
    this._evictOverflow(entry.accountId, bucket);
    this._persist(entry.accountId, now);
    this._noteUpsert(entry);
    this._emit({ type: created ? "created" : "updated", entry: wireOf(entry), at: now });
    return { entry, created };
  }

  /** 淘汰：pending 超上限时先淘最老的 done、再淘最老的 error；waiting 永不淘汰（§1.2）。 */
  _evictOverflow(accountId, bucket) {
    let pending = bucket.entries.size;
    if (pending <= INBOX_PENDING_MAX) return;
    for (const kind of ["done", "error"]) {
      if (pending <= INBOX_PENDING_MAX) break;
      const victims = [...bucket.entries.values()]
        .filter((e) => e.kind === kind)
        .sort((a, b) => a.at - b.at);
      for (const victim of victims) {
        if (pending <= INBOX_PENDING_MAX) break;
        bucket.entries.delete(victim.key);
        pending -= 1;
        this._noteRemoved(victim.key);
        this._emit({ type: "removed", key: victim.key, reason: "resolved", entry: wireOf(victim), at: this._now() });
      }
    }
  }

  /** 消项 + 写墓碑。条目不存在返回 false（重复消项幂等）。 */
  remove(accountId, key, reason, now = this._now()) {
    const bucket = this._load(accountId);
    const prev = bucket.entries.get(key);
    const goneReason = GONE_REASONS.has(reason) ? reason : "resolved";
    if (!prev) {
      // 条目已不在：只在还没有墓碑时补写一块（防「进程重启后旧快照把已消条目挂回来」）；
      // 已有墓碑不刷新——第一次关闭的时刻与原因才是事实，重复消项不许改写它。
      if (!bucket.tombs.has(key)) {
        bucket.tombs.set(key, { goneAt: now, goneReason });
        this._persist(accountId, now);
      }
      return false;
    }
    bucket.tombs.set(key, { goneAt: now, goneReason });
    bucket.entries.delete(key);
    this._persist(accountId, now);
    this._noteRemoved(key);
    this._emit({ type: "removed", key, reason: goneReason, entry: wireOf(prev), at: now });
    return true;
  }

  /**
   * 手动清除（inbox_dismiss）：只许 done/error——waiting 是「真的还在等」，清了就是假清零，
   * 防的正是用户把未答的对话误清（§1.3）。跨账号按 key 查（单账号 relay 的常态口径，
   * 与 room_list 全局可见同姿势）。返回被清条目或 null。
   */
  dismiss(key, now = this._now()) {
    for (const accountId of this._knownAccounts()) {
      const bucket = this._load(accountId);
      const entry = bucket.entries.get(key);
      if (!entry) continue;
      if (entry.kind === "waiting") return null;
      this.remove(accountId, key, "dismissed", now);
      return entry;
    }
    return null;
  }

  /** 提前加载某账号的落盘账本（装配时调：让重启后的首个 room_list 就带上恢复条目）。 */
  prime(accountId) {
    if (accountId) this._load(accountId);
  }

  _knownAccounts() {
    // 只查已加载账号：目录名是 safeKey 后的形状、不可逆，不能反推 accountId 当键用。
    // 装配时 prime 了主账号，其余账号在首个房间事件时懒加载，dismiss 在那之后必然命中。
    return [...this._accounts.keys()];
  }

  /**
   * 墓碑原因回填：dialog_close 的 reason 到达时机晚于对账消项（local 先对账后走共享事件出口），
   * rooms 在 observeRoomTurnEvent 里把准确原因补到已写下的墓碑上（answered/timeout 才值得改）。
   */
  amendTombReason(accountId, key, reason) {
    if (!GONE_REASONS.has(reason)) return false;
    const bucket = this._load(accountId);
    const tomb = bucket.tombs.get(key);
    if (!tomb || bucket.entries.has(key) || tomb.goneReason === reason) return false;
    tomb.goneReason = reason;
    // 落盘清理墓碑以墓碑自身时刻为参照：用真实时钟会把刚回填的这块按「过期」顺手删掉。
    this._persist(accountId, tomb.goneAt);
    return true;
  }

  /** 恢复期清扫：某房仍未被补发确认的 waiting 条目批量转 gone(stale)（§1.4）。返回清扫数。 */
  sweepRestored(roomId, now = this._now()) {
    let n = 0;
    for (const accountId of this._knownAccounts()) {
      for (const entry of this.roomEntries(accountId, roomId)) {
        if (entry.kind === "waiting" && entry._restored) {
          this.remove(accountId, entry.key, "stale", now);
          n += 1;
        }
      }
    }
    return n;
  }

  /** 某房当前 pending 条目（内部形状，含 _restored 标记——rooms 对账用）。 */
  roomEntries(accountId, roomId) {
    const bucket = this._load(accountId);
    return [...bucket.entries.values()].filter((e) => e.roomId === roomId);
  }

  /** 仍未被补发确认的恢复期 waiting key 集合（rooms 的 stale 清扫面）。 */
  restoredWaitingKeys(accountId, roomId) {
    return new Set(this.roomEntries(accountId, roomId)
      .filter((e) => e.kind === "waiting" && e._restored)
      .map((e) => e.key));
  }

  /**
   * 回合条目整房替换：新落定先顶掉同房旧 turn 条目（墓碑 reason=resolved，静默顶替不算用户已读，
   * 与 UI 侧 RoomTurnTracker 每房只留最新一份同规则），再 upsert 新条目。
   */
  replaceRoomTurn(raw, now = this._now()) {
    const entry = cleanEntry(raw);
    if (!entry || entry.subkind !== "turn") return null;
    const bucket = this._load(entry.accountId);
    for (const prev of [...bucket.entries.values()]) {
      if (prev.roomId === entry.roomId && prev.subkind === "turn" && prev.key !== entry.key) {
        this.remove(entry.accountId, prev.key, "resolved", now);
      }
    }
    return this.upsert(entry, now);
  }

  /** 进房即已读（既有行为扩到账本）：删同房全部 turn 条目。返回删除数。 */
  clearRoomTurns(accountId, roomId, now = this._now()) {
    let n = 0;
    for (const prev of this.roomEntries(accountId, roomId)) {
      if (prev.subkind !== "turn") continue;
      if (this.remove(accountId, prev.key, "resolved", now)) n += 1;
    }
    return n;
  }

  /**
   * §3（定时）预留面：排队/定时失败以 subkind:"schedule" 的 error 条目进账本——
   * 本期只备形状与入口，生产者在 §3 落地时调用（key 形如 sched:<scheduleId>）。
   */
  upsertScheduleError(raw, now = this._now()) {
    const entry = cleanEntry({ ...raw, kind: "error", subkind: "schedule" });
    if (!entry) return null;
    return this.upsert(entry, now);
  }

  /** §B（ask）预留面：结构化提问进账本（key 形如 ask:<askId>），生产者在设计 B 落地时调用。 */
  upsertAsk(raw, now = this._now()) {
    const entry = cleanEntry({ ...raw, kind: "waiting", subkind: "ask" });
    if (!entry) return null;
    return this.upsert(entry, now);
  }

  removeAsk(accountId, askId, answered, now = this._now()) {
    return this.remove(accountId, `ask:${askId}`, answered ? "answered" : "resolved", now);
  }

  /** 全部账号的 pending 上行快照（room_list/auth_result 附带面，单账号 relay 常态）。 */
  snapshot() {
    const out = [];
    for (const accountId of this._accounts.keys()) {
      for (const entry of this._load(accountId).entries.values()) out.push(wireOf(entry));
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }
}

module.exports = {
  InboxStore,
  cleanEntry,
  wireOf,
  INBOX_PENDING_MAX,
  INBOX_TOMB_RETENTION_MS,
  INBOX_TITLE_MAX,
};
