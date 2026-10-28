"use strict";
/**
 * 账户 / 设备 / 会话清单索引。
 *
 * 只存名册与会话索引，不存对话正文：
 *   data/accounts/index.jsonl
 *   data/accounts/<accountId>/devices.jsonl
 *   data/accounts/<accountId>/device-tokens.jsonl   设备令牌，只存 sha256（按 hash 合并，后行覆盖前行；
 *                                                  超阈值原子压缩，保留有效令牌 + 近期撤销记录）
 *   data/accounts/<accountId>/sessions/<deviceId>.jsonl
 *
 * 写盘是追加；读时按 id 合并：两者都有 updatedAt 时取更新的行（相同/缺失仍按后行覆盖）。
 * 合并结果按文件整份缓存在内存：第一次用到时读一次，之后读全走内存；写穿透（先追加落盘，成功后再改缓存）。
 * 迁移合并也必须走这条写穿透路径，不能绕过缓存直接改文件（否则随后的压缩会用旧缓存整份重写）。
 * 进程运行期间手改这些文件不会被看到，要重启 relay。缓存里的行是共享对象，调用方只读。
 * full 对账：帧内 upsert，帧内缺失的活动位清掉，removed 写墓碑。截断帧不做“缺失置假”。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_ACCOUNT = "admin";

/** accountId / deviceId 落盘名：只留 [A-Za-z0-9_-]，其余变 _，最长 64 */
function safeKey(id) {
  const raw = String(id == null ? "" : id);
  const s = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "_";
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return s + "-" + hash;
}

function readMap(file) {
  const map = new Map();
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return map;
    throw e;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec.id === "string" && rec.id) {
        // 同一 id 以 updatedAt 新者为准：文件可能被旧版本/迁移/手改留下"新行在前、旧行在后"，
        // 不能盲目让后行覆盖前行。时间相同或缺省时仍按追加顺序（后者胜）。
        const prev = map.get(rec.id);
        const recAt = num(rec.updatedAt, null);
        const prevAt = prev ? num(prev.updatedAt, null) : null;
        if (prev && recAt != null && prevAt != null && recAt < prevAt) continue;
        map.set(rec.id, rec);
      }
    } catch {
      /* 单行损坏跳过，不让坏行挡住后面的更新 */
    }
  }
  return map;
}

function appendRows(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** 关键小文件 fsync（令牌签发/撤销必须扛断电：撤销行丢了等于令牌复活）。失败只告警。 */
function fsyncFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r+");
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    console.warn("[index] fsync 失败（数据可能只在页缓存）:", file, e.message);
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

const dirFsyncWarned = new Set();

/** fsync 目录：rename 的目录项不会跟着文件 fsync 一起落盘，掉电后旧文件/旧名字可能"复活"
 *  （索引重写后已删除的会话行回来）。不支持目录 fsync 的平台只告警一次并降级为尽力而为。 */
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    if (!dirFsyncWarned.has(dir)) {
      dirFsyncWarned.add(dir);
      console.warn("[index] 目录 fsync 失败（目录项耐久降级为尽力而为）:", dir, e.message);
    }
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * 追加多了就把当前合并结果重写成一份，避免文件无限变长、每次查询都同步扫全文件。
 * 墓碑在保留若干天后随压缩丢掉（读侧按 id 合并，丢旧墓碑不影响正确性，只是"复活"窗口结束）。
 */
const COMPACT_MIN_BYTES = 256 * 1024;
const COMPACT_TOMBSTONE_KEEP_MS = 7 * 24 * 3600 * 1000;
const COMPACT_MIN_INTERVAL_MS = 60 * 1000;
const lastCompactAt = new Map();

// 已排队的一次性整文件重写（按文件去重）。写路径只负责"登记"，真正的 stringify/写盘/rename/fsync
// 放到本轮消息处理之后：名册与令牌的写全是同步落盘的（令牌撤销必须 fsync，见 _writeTokens），
// 不能再让一次 256KB+ 的整文件重写挡在这次写入的返回上（报告：写入全在消息线程同步刷盘 + 整文件重写）。
const pendingCompacts = new Set();

/** 把整文件重写排到本轮事件循环之后。pending 期间同文件只排一次（多次 append 自动合并成一次重写）；
 *  执行时由 run 重新取一次最新缓存，避免用排队前的旧表把期间的新行/墓碑整份抹掉。 */
function scheduleRewrite(file, run, failText = "[index] 索引压缩失败（已保留原文件，本次写入仍成功）:") {
  if (pendingCompacts.has(file)) return false;
  pendingCompacts.add(file);
  setImmediate(() => {
    pendingCompacts.delete(file);
    try {
      // 文件在排队期间被迁移/删除（目录改名、旧目录合并）：不能凭空重建一份空文件。
      if (!fs.existsSync(file)) return;
      run();
    } catch (e) {
      console.warn(failText, file, e.message);
    }
  });
  return true;
}

// device-tokens.jsonl 是追加文件：每次配对/撤销都追加一行，旧行永远不删。
// 超过阈值时原子重写为"当前有效令牌 + 近期撤销行"；保留窗口外的撤销行可以丢——
// 令牌校验只认表中的行，丢掉旧撤销行不会让任何旧令牌重新有效，只是错误码从
// device_revoked 退化成 auth_failed。
const TOKEN_COMPACT_MIN_BYTES = 256 * 1024;
const TOKEN_COMPACT_MIN_INTERVAL_MS = 60 * 1000;
const TOKEN_REVOKED_KEEP_MS = 30 * 24 * 3600 * 1000;
const lastTokenCompactAt = new Map();

/** 按 map 的当前内容整文件原子重写（tmp + rename + fsync + 父目录 fsync），不做大小门槛。
 *  压缩（_compactIfLarge）、令牌压缩与 forgetSession（删会话留最小墓碑，P9 B）共用这一份落盘方式，
 *  避免三处各写一遍临时文件逻辑。失败时清掉半成品临时文件再抛给调用方处理。 */
function rewriteFromMap(file, map) {
  const rows = [...map.values()];
  const body = rows.length ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : "";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  fsyncFile(file);
  // rename 只改了目录项：不同步父目录的话，掉电后旧文件可能还在（forgetSession 删掉的会话行"复活"）。
  fsyncDir(path.dirname(file));
  return rows.length;
}

/** 最小墓碑的形状（P2-3）：只有 kind/id/deleted/updatedAt 四个键，不能带会话名/路径等旧行字段。 */
function isMinimalTombstone(row) {
  if (!row || row.deleted !== true || row.kind !== "session") return false;
  const keys = Object.keys(row);
  if (keys.length !== 4) return false;
  return keys.every((k) => k === "kind" || k === "id" || k === "deleted" || k === "updatedAt");
}

/** 「路径在 root 下」判断（P9 B 的 deviceScope 对账用）：按设备平台归一后比较前缀，
 *  要求完全相等或前缀后面紧跟分隔符（设备是 macOS 时大小写不敏感、Windows 反斜杠当分隔符）。
 *  懒加载 devices.js：index 是底层模块，devices 反向依赖 index，顶层 require 会成环。 */
function pathUnderRoot(root, p, platform) {
  if (typeof root !== "string" || typeof p !== "string" || !root || !p) return false;
  let normPath;
  try {
    ({ normPath } = require("./devices"));
  } catch {
    return false;
  }
  const r = normPath(root, platform);
  const target = normPath(p, platform);
  if (!r || !target) return false;
  if (target === r) return true;
  const prefix = r.endsWith("/") ? r : r + "/";
  return target.startsWith(prefix);
}

/** 旧版落盘名（safeKey 加 hash 后缀之前）：只清洗、截断到 64。升级迁移用。 */
function legacyKey(id) {
  const raw = String(id == null ? "" : id);
  const s = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return s || "_";
}

function num(v, dflt) {
  if (v == null || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

class AccountIndex {
  /**
   * @param {string} accountsDir 索引根目录（其下是 index.jsonl 与 <accountId>/）
   */
  constructor(accountsDir) {
    this.dir = accountsDir;
    /** @type {Map<string, number>} 每设备最近一次被接受的 manifest 帧 updatedAt */
    this.lastManifestAt = new Map();
    /** @type {Map<string, Map<string, object>>} 账号 → (令牌 hash → 行)；整份常驻内存，写穿透 */
    this.tokenCache = new Map();
    /** @type {Map<string, Map<string, object>>} 文件路径 → (id → 合并后的行) */
    this.fileCache = new Map();
    fs.mkdirSync(this.dir, { recursive: true });
    this._migrateLegacyNames();
  }

  /** 文件的合并结果（缓存）。读失败（ENOENT 以外）照常抛出且不缓存，下次再试 */
  _map(file) {
    let map = this.fileCache.get(file);
    if (!map) {
      map = readMap(file);
      this.fileCache.set(file, map);
    }
    return map;
  }

  /** 追加行：先落盘，成功后再进缓存；没有新行也照样检查要不要压缩 */
  _append(file, rows) {
    const map = this._map(file);
    if (rows.length) {
      appendRows(file, rows);
      for (const row of rows) map.set(row.id, row);
    }
    this._compactIfLarge(file);
  }

  /** 压缩是「追加成功之后的整理」，失败不能回传成这次写入失败：行已经在文件里，
   *  上层若据此跳过墓碑清理/列表广播，用户看到的状态就与磁盘不一致（报告 relay 中-14）。
   *  整文件重写排到本轮之后（scheduleRewrite），执行时重新取缓存：期间 forgetSession 可能刚
   *  换过 map，用排队前的旧表整份重写会把墓碑抹掉。 */
  _compactIfLarge(file) {
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return; }
    if (size < COMPACT_MIN_BYTES) return;
    const last = lastCompactAt.get(file) || 0;
    if (Date.now() - last < COMPACT_MIN_INTERVAL_MS) return;
    lastCompactAt.set(file, Date.now());
    scheduleRewrite(file, () => {
      const map = this._map(file);
      const now = Date.now();
      const keep = new Map();
      for (const [id, r] of map) {
        if (r && r.deleted && now - num(r.updatedAt, now) > COMPACT_TOMBSTONE_KEEP_MS) continue;
        keep.set(id, r);
      }
      rewriteFromMap(file, keep);
    });
  }

  /** 目录整体改名/迁移后，丢弃该目录下各文件的缓存（含曾经 ENOENT 缓存的空表），
   *  避免整目录改名后仍用旧缓存并在压缩时整份重写。 */
  _forgetDir(dir) {
    const prefix = dir + path.sep;
    for (const file of this.fileCache.keys()) {
      if (file.startsWith(prefix)) this.fileCache.delete(file);
    }
  }

  /**
   * 迁移合并：新文件没有的 id、或旧行 updatedAt 更新的，追加到新文件末尾。
   * **必须走 _append / _map**：直接 readMap+appendRows 会绕过 fileCache，随后压缩
   * 可能拿旧缓存整份重写，把刚合并进来的历史抹掉。合并完旧文件改名留档，不删除。
   */
  _mergeJsonlInto(from, to, stamp) {
    const src = readMap(from);
    const dst = this._map(to);
    const rows = [];
    for (const [id, row] of src) {
      const cur = dst.get(id);
      if (!cur || num(row && row.updatedAt, 0) > num(cur && cur.updatedAt, 0)) rows.push(row);
    }
    this._append(to, rows);
    fs.renameSync(from, from + ".migrated-" + stamp);
    return rows.length;
  }

  /** safeKey 加 hash 后缀前写的账号目录/会话文件，按文件里的原始 id 重命名，避免升级后历史索引变孤儿。 */
  _migrateLegacyNames() {
    let accounts = [];
    try {
      accounts = [...readMap(path.join(this.dir, "index.jsonl")).values()].filter(
        (r) => r && r.kind === "account" && typeof r.id === "string" && r.id,
      );
    } catch {
      return;
    }
    const stamp = Date.now();
    for (const a of accounts) this._migrateAccountDir(a.id, stamp);
  }

  /** 单个账号的旧目录迁移：先改名 sessions/ 里的会话文件，再改名/合并账号目录本身——
   *  这个顺序下任何一步崩溃，重跑都能继续（已改名的文件被 existsSync 守卫跳过）。 */
  _migrateAccountDir(accountId, stamp) {
    const id = this._accountId(accountId);
    const from = path.join(this.dir, legacyKey(id));
    const to = path.join(this.dir, safeKey(id));
    if (from === to) return;
    const hasFrom = fs.existsSync(from);
    const hasTo = fs.existsSync(to);
    if (!hasFrom) return;
    // 目标目录不存在 = 下面会整目录改名。先清掉目标路径下可能缓存过的空表（以前读 ENOENT 留下的），
    // 否则改名后读路径会拿空缓存，压缩时把刚搬进来的历史整份抹掉。
    if (!hasTo) this._forgetDir(to);
    try {
      if (hasTo) this._mergeLegacyDir(from, to, stamp);
      else fs.renameSync(from, to);
    } catch (e) {
      console.error("[index] 账号目录迁移失败:", id, e.message);
      return;
    }
    const dir = to;
    let devices = [];
    try {
      devices = [...readMap(path.join(dir, "devices.jsonl")).values()];
    } catch {
      return;
    }
    for (const d of devices) {
      if (!d || typeof d.id !== "string" || !d.id) continue;
      const sf = path.join(dir, "sessions", legacyKey(d.id) + ".jsonl");
      const st = path.join(dir, "sessions", safeKey(d.id) + ".jsonl");
      try {
        if (sf !== st && fs.existsSync(sf) && !fs.existsSync(st)) fs.renameSync(sf, st);
        else if (sf !== st && fs.existsSync(sf) && fs.existsSync(st)) this._mergeJsonlInto(sf, st, stamp);
      } catch (e) {
        console.error("[index] 会话文件迁移失败:", d.id, e.message);
      }
    }
  }

  /**
   * 新旧两个账号目录同时存在（升级后又回滚到旧版写过一段、再升级）：
   * 旧目录里的设备名册和会话清单按 updatedAt 合并进新目录，旧目录改名留档。不能直接跳过，否则这段时间的索引变孤儿。
   */
  _mergeLegacyDir(from, to, stamp) {
    const fromDevices = path.join(from, "devices.jsonl");
    let devices = [];
    try {
      devices = [...readMap(fromDevices).values()];
    } catch {
      devices = [];
    }
    if (fs.existsSync(fromDevices)) this._mergeJsonlInto(fromDevices, path.join(to, "devices.jsonl"), stamp);
    const fromSessions = path.join(from, "sessions");
    const byLegacy = new Map();
    for (const d of devices) {
      if (d && typeof d.id === "string" && d.id) byLegacy.set(legacyKey(d.id) + ".jsonl", safeKey(d.id) + ".jsonl");
    }
    let names = [];
    try {
      names = fs.readdirSync(fromSessions).filter((n) => n.endsWith(".jsonl"));
    } catch {
      names = [];
    }
    for (const name of names) {
      const target = path.join(to, "sessions", byLegacy.get(name) || name);
      const source = path.join(fromSessions, name);
      if (fs.existsSync(target)) this._mergeJsonlInto(source, target, stamp);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(source, target);
      }
    }
    fs.renameSync(from, from + ".migrated-" + stamp);
  }

  /** 按 deviceId 反查它登记在哪个账号下（device_register / session_manifest 绑定账号用）。 */
  findDevice(deviceId) {
    if (typeof deviceId !== "string" || !deviceId.trim()) return null;
    const id = deviceId.trim();
    let accounts = [];
    try {
      accounts = [...this._map(path.join(this.dir, "index.jsonl")).values()].filter((r) => r && r.kind === "account" && r.id);
    } catch {
      return null;
    }
    for (const a of accounts) {
      // 某个账号名册读不了（权限/被换成目录）时不能让整个反查失败：跳过它继续找
      let row = null;
      try {
        row = this.getDeviceRow(a.id, id);
      } catch (e) {
        console.error("[index] findDevice 读账号名册失败:", a.id, e.message);
      }
      if (row) return { accountId: a.id, row };
    }
    return null;
  }

  _accountId(accountId) {
    const id = typeof accountId === "string" && accountId.trim() ? accountId.trim() : DEFAULT_ACCOUNT;
    return id;
  }

  _key(accountId, deviceId) {
    return safeKey(this._accountId(accountId)) + "\0" + safeKey(deviceId);
  }

  _accountDir(accountId) {
    const id = this._accountId(accountId);
    const to = path.join(this.dir, safeKey(id));
    // 懒迁移：构造函数的扫描只覆盖 index.jsonl 里有 account 行的账号，而 upsertDevice /
    // applyManifest 建目录时不写 account 行——这类目录只能在这里按"访问时的账号名"兜底迁移，
    // 否则升级后读路径全指向新名字，旧目录永久孤儿、该账号清单对 UI 直接消失。
    try {
      const from = path.join(this.dir, legacyKey(id));
      if (from !== to && !fs.existsSync(to) && fs.existsSync(from)) this._migrateAccountDir(id, Date.now());
    } catch (e) {
      console.error("[index] 账号目录懒迁移失败:", id, e.message);
    }
    return to;
  }

  _devicesFile(accountId) {
    return path.join(this._accountDir(accountId), "devices.jsonl");
  }

  _sessionsFile(accountId, deviceId) {
    return path.join(this._accountDir(accountId), "sessions", safeKey(deviceId) + ".jsonl");
  }

  touchAccount(accountId, now = Date.now()) {
    const id = this._accountId(accountId);
    const file = path.join(this.dir, "index.jsonl");
    const prev = this._map(file).get(id);
    const row = {
      kind: "account",
      id,
      firstSeenAt: prev && Number.isFinite(Number(prev.firstSeenAt)) ? Number(prev.firstSeenAt) : now,
      lastSeenAt: now,
    };
    this._append(file, [row]);
    return row;
  }

  /**
   * @param {string} accountId
   * @param {{id:string, name?:string, platform?:string, projects?:string[], lastAttachAt?:number, pairedAt?:number, updatedAt?:number}} device
   *   firstSeenAt 不接受客户端上报：只在第一次登记时由服务端写入。
   */
  upsertDevice(accountId, device, now = Date.now()) {
    if (!device || typeof device.id !== "string" || !device.id.trim()) {
      return { ok: false, reason: "missing_id" };
    }
    const id = device.id.trim();
    const file = this._devicesFile(accountId);
    const prev = this._map(file).get(id) || {};
    // 客户端给的时间不可信：未来时间会把设备行顶到最前并躲过 stale 淘汰，统一夹到服务端当前时间。
    const updatedAt = Math.min(num(device.updatedAt, now), now);
    if (Number.isFinite(Number(prev.updatedAt)) && updatedAt < Number(prev.updatedAt)) {
      return { ok: true, stale: true, row: prev };
    }
    // 首次连接时间：第一次登记时写入，之后每次 attach 都保留同一个值，展示顺序不会随最近活跃变化。
    // 老索引行没有这个字段：按 pairedAt → lastAttachAt 回退（0 视为缺失），都没有才用本次登记时间。
    const prevFirstSeen = num(prev.firstSeenAt, 0);
    const prevPairedAt = num(prev.pairedAt, 0);
    const prevLastAttach = num(prev.lastAttachAt, 0);
    const firstSeenAt = prevFirstSeen > 0
      ? prevFirstSeen
      : prevPairedAt > 0
        ? prevPairedAt
        : prevLastAttach > 0
          ? prevLastAttach
          : now;
    const row = {
      kind: "device",
      id,
      name: device.name != null ? String(device.name) : (prev.name || ""),
      platform: device.platform != null ? String(device.platform) : (prev.platform || ""),
      projects: Array.isArray(device.projects) ? device.projects.map((p) => String(p)) : (Array.isArray(prev.projects) ? prev.projects : []),
      // 客户端给的时间不可信：未来时间会把设备永久置顶（参考 applyManifest 对帧时间的夹取）
      lastAttachAt: Math.min(num(device.lastAttachAt, num(prev.lastAttachAt, now)), now),
      // 配对过的设备留一个不可逆标记：撤销令牌后 legacy 也不能再冒用它（令牌可以删，身份不能回退）
      pairedAt: num(device.pairedAt, num(prev.pairedAt, 0)),
      firstSeenAt,
      updatedAt,
    };
    if (!sameJson(prev, row)) this._append(file, [row]);
    return { ok: true, stale: false, row };
  }

  listDevices(accountId) {
    const rows = [...this._map(this._devicesFile(accountId)).values()];
    rows.sort((a, b) => (Number(b.lastAttachAt) || 0) - (Number(a.lastAttachAt) || 0) || String(a.id).localeCompare(String(b.id)));
    return rows;
  }

  getDeviceRow(accountId, deviceId) {
    if (typeof deviceId !== "string" || !deviceId.trim()) return null;
    return this._map(this._devicesFile(accountId)).get(deviceId.trim()) || null;
  }

  _tokensFile(accountId) {
    return path.join(this._accountDir(accountId), "device-tokens.jsonl");
  }

  _tokens(accountId) {
    const id = this._accountId(accountId);
    let map = this.tokenCache.get(id);
    if (map) return map;
    map = new Map();
    let text = "";
    try {
      text = fs.readFileSync(this._tokensFile(id), "utf8");
    } catch (e) {
      if (!e || e.code !== "ENOENT") throw e;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const rec = JSON.parse(t);
        if (rec && rec.kind === "token" && typeof rec.hash === "string" && typeof rec.deviceId === "string") map.set(rec.hash, rec);
      } catch {
        /* 单行损坏跳过 */
      }
    }
    this.tokenCache.set(id, map);
    return map;
  }

  /** 先落盘再进缓存：写失败时内存不会领先于文件。令牌/撤销行 fsync 后才更新缓存，
   *  断电不会让刚撤销的令牌复活。 */
  _writeTokens(accountId, rows) {
    if (!rows.length) return;
    const file = this._tokensFile(accountId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
    fsyncFile(file);
    const map = this._tokens(accountId);
    for (const row of rows) map.set(row.hash, row);
    this._compactTokensIfLarge(accountId);
  }

  /**
   * 令牌文件只在写路径压缩：先把新增行追加落盘（失败会抛出，调用方按原样处理），
   * 再按阈值原子重写。这样即使压缩写失败，刚追加的行仍在文件里，内存缓存也已更新。
   * 保留全部未撤销行 + 30 天内的撤销行；旧撤销行丢弃后仍不可用（不在表里 = auth_failed）。
   * 整文件重写排到本轮之后：真正耐久的只有前面那次 append+fsync；压缩只是体积整理，
   * 不必挡在配对/撤销请求的同步返回上（报告：令牌写入全在消息线程同步刷盘 + 整文件重写）。
   */
  _compactTokensIfLarge(accountId) {
    const file = this._tokensFile(accountId);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return false; }
    if (size < TOKEN_COMPACT_MIN_BYTES) return false;
    const last = lastTokenCompactAt.get(file) || 0;
    if (Date.now() - last < TOKEN_COMPACT_MIN_INTERVAL_MS) return false;
    lastTokenCompactAt.set(file, Date.now());
    return scheduleRewrite(file, () => {
      const map = this._tokens(accountId);
      const now = Date.now();
      const rows = [];
      for (const row of map.values()) {
        if (!row || typeof row.hash !== "string" || typeof row.deviceId !== "string") continue;
        if (row.revokedAt && now - num(row.revokedAt, now) > TOKEN_REVOKED_KEEP_MS) continue;
        rows.push(row);
      }
      const body = rows.length ? rows.map((row) => JSON.stringify(row)).join("\n") + "\n" : "";
      const tmp = file + ".tmp";
      try {
        fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
        if (!fsyncFile(tmp)) throw new Error("tmp fsync 失败");
        fs.renameSync(tmp, file);
        // rename 的目录项也要同步，否则掉电后旧的（更大的）令牌文件可能回来。
        fsyncDir(path.dirname(file));
      } catch (e) {
        console.warn("[index] 令牌文件压缩失败（保留原文件）:", e.message);
        try { fs.unlinkSync(tmp); } catch {}
        return false;
      }
      // 压缩成功后把已丢弃的旧撤销行也从缓存里删掉，保持内存与磁盘一致
      const kept = new Set(rows.map((row) => row.hash));
      for (const hash of [...map.keys()]) if (!kept.has(hash)) map.delete(hash);
      return true;
    });
  }

  /** 账号下全部令牌行（含已作废的）：{kind, deviceId, hash, createdAt, revokedAt?} */
  deviceTokens(accountId) {
    return [...this._tokens(accountId).values()];
  }

  hasDeviceToken(accountId, deviceId) {
    for (const row of this._tokens(accountId).values()) if (row.deviceId === deviceId && !row.revokedAt) return true;
    return false;
  }

  /** 作废设备的全部有效令牌，返回作废条数 */
  revokeDeviceTokens(accountId, deviceId, now = Date.now()) {
    const rows = [];
    for (const row of this._tokens(accountId).values()) {
      if (row.deviceId === deviceId && !row.revokedAt) rows.push({ ...row, revokedAt: now });
    }
    this._writeTokens(accountId, rows);
    return rows.length;
  }

  /** 给设备登记新令牌（hash = sha256 hex）：同一设备之前的令牌一并作废 */
  issueDeviceToken(accountId, deviceId, hash, now = Date.now()) {
    const rows = [];
    for (const row of this._tokens(accountId).values()) {
      if (row.deviceId === deviceId && !row.revokedAt) rows.push({ ...row, revokedAt: now });
    }
    rows.push({ kind: "token", deviceId, hash, createdAt: now });
    this._writeTokens(accountId, rows);
    return { revoked: rows.length - 1 };
  }

  _sessionFrom(prev, src, { deleted, updatedAt }) {
    const p = prev || {};
    const active = deleted ? false : (src.active == null ? !!p.active : !!src.active);
    return {
      kind: "session",
      id: String(src.id),
      path: src.path != null ? String(src.path) : (p.path || ""),
      // name 为 null 或 "" 表示未命名，写成空字符串盖掉旧名字；缺省（undefined）沿用旧名字。
      name: src.name === null || src.name === "" ? "" : (src.name != null ? String(src.name) : (p.name || "")),
      cwd: src.cwd != null ? String(src.cwd) : (p.cwd || ""),
      firstMessage: src.firstMessage != null ? String(src.firstMessage) : (p.firstMessage || ""),
      // fork 谱系（R3-3 第 3 项）：父会话路径随清单行透传。口径同 name（第 3 轮审查 C-4）：
      // 帧带字符串 = 新值（空串归一为 null）；帧显式 null = 父指针已不存在，盖掉旧值；
      // 只有字段缺省（undefined，增量帧不带该行字段时）才沿用旧行。旧写法用 != null
      // 把"显式 null"与"缺省"混同，父指针一旦存下就永不能被新帧清掉。
      parentSession: src.parentSession === undefined
        ? (p.parentSession != null ? p.parentSession : null)
        : (src.parentSession ? String(src.parentSession) : null),
      messageCount: src.messageCount == null ? num(p.messageCount, 0) : num(src.messageCount, 0),
      sizeBytes: src.sizeBytes == null ? num(p.sizeBytes, 0) : num(src.sizeBytes, 0),
      createdAt: src.createdAt == null ? num(p.createdAt, 0) : num(src.createdAt, 0),
      updatedAt,
      active,
      deleted: !!deleted,
    };
  }

  /**
   * @param {string} accountId
   * @param {string} deviceId
   * @param {{full?:boolean, updatedAt?:number, sessions?:object[], removed?:string[], truncated?:boolean}} manifest
   * @param {number} [nowAt]
   * @param {{root:string, platform?:string}|null} [deviceScope] 只有 attach 窗口发的全量帧才传（P9 B）
   * @returns {{ok:boolean, reason?:string, stale?:boolean, written?:number, skipped?:number, tombstoned?:string[]}}
   */
  applyManifest(accountId, deviceId, manifest, nowAt = Date.now(), deviceScope = null) {
    const account = typeof accountId === "string" ? accountId.trim() : "";
    const device = typeof deviceId === "string" ? deviceId.trim() : "";
    if (!account || !device) return { ok: false, reason: "missing_id" };
    if (!manifest || !Array.isArray(manifest.sessions)) return { ok: false, reason: "bad_sessions" };

    // 客户端给的 updatedAt 不可信：未来时间会把 lastManifestAt 顶到十年后，
    // 之后真实帧全部被判 manifest_stale，索引永久卡死。统一夹到服务端当前时间。
    const frameAt = Math.min(num(manifest.updatedAt, 0), nowAt);
    const memKey = this._key(account, device);
    const prevFrameAt = Math.min(this.lastManifestAt.get(memKey) || 0, nowAt);
    if (frameAt < prevFrameAt) return { ok: false, stale: true, reason: "manifest_stale" };

    const file = this._sessionsFile(account, device);
    // 在缓存的副本上对账：写盘成功前缓存不能先变
    const map = new Map(this._map(file));
    const full = manifest.full === true;
    const truncated = manifest.truncated === true;
    const removed = Array.isArray(manifest.removed) ? manifest.removed : [];
    // deviceScope（P9 B）：attach 窗口的全量清单（full && !truncated）才带。带了就以设备目录为权威：
    // 落在 root 下、这一帧里没出现、还没删除的行打墓碑（设备上删掉/挪走的会话，反向同步到 relay）；
    // root 以外的行不动（会话目录可能被 PI_CODING_AGENT_SESSION_DIR 改到别处，attach 看不见，不能误删）。
    const scope = deviceScope || (manifest.deviceScope && typeof manifest.deviceScope === "object" ? manifest.deviceScope : null);
    const scopeRoot = scope && typeof scope.root === "string" ? scope.root : "";
    const scopePlatform = scope && typeof scope.platform === "string" ? scope.platform : "";
    const lines = [];
    const tombstoned = [];
    let skipped = 0;
    const seen = new Set();

    const take = (id, row, prev) => {
      const prevAt = num(prev && prev.updatedAt, 0);
      if (prev && row.updatedAt < prevAt) {
        skipped += 1;
        return;
      }
      if (!sameJson(prev || {}, row)) lines.push(row);
      map.set(id, row);
    };

    for (const src of manifest.sessions) {
      if (!src || typeof src.id !== "string" || !src.id) {
        skipped += 1;
        continue;
      }
      const id = src.id;
      seen.add(id);
      const prev = map.get(id);
      const rowAt = Math.min(num(src.updatedAt, frameAt || nowAt), nowAt);
      const row = this._sessionFrom(prev, src, { deleted: false, updatedAt: rowAt });
      // 设备是权威：deviceScope 帧里重新出现的会话（用户从废纸篓拿了回来等），
      // 就算之前打了墓碑也要恢复；新行的 updatedAt 必须压过墓碑时间，否则会被 take 当成更旧的丢掉。
      if (scopeRoot && prev && prev.deleted) row.updatedAt = Math.max(row.updatedAt, num(prev.updatedAt, 0) + 1);
      take(id, row, prev);
    }

    for (const raw of removed) {
      if (typeof raw !== "string" || !raw) continue;
      const id = raw;
      seen.add(id);
      const prev = map.get(id);
      if (prev && prev.deleted) continue;
      // 墓碑时间用帧时间；行比帧新则丢弃
      if (prev && frameAt < num(prev.updatedAt, 0)) {
        skipped += 1;
        continue;
      }
      // P2-3：直接写最小墓碑，不沿用上一行的 name/firstMessage/path/cwd——
      // 否则同一毫秒里 purge 的 forgetSession 提前返回时，会留下带会话名的墓碑。
      const row = { kind: "session", id, deleted: true, updatedAt: frameAt || nowAt };
      take(id, row, prev);
      tombstoned.push(id);
    }

    if (full && !truncated) {
      // P9 B：deviceScope 的目录对账优先——root 下缺失的会话打墓碑（墓碑时间用帧时间）。
      // 只处置没出现、没删除的行；root 外或没有 path（无法证明在 root 下）的行一律不动。
      if (scopeRoot) {
        for (const [id, prev] of map) {
          if (seen.has(id) || !prev || prev.deleted) continue;
          if (!pathUnderRoot(scopeRoot, prev.path, scopePlatform)) continue;
          if (frameAt < num(prev.updatedAt, 0)) {
            skipped += 1;
            continue;
          }
          const row = { kind: "session", id, deleted: true, updatedAt: frameAt || nowAt };
          if (sameJson(prev, row)) continue;
          lines.push(row);
          map.set(id, row);
          tombstoned.push(id);
        }
      }
      for (const [id, prev] of map) {
        if (seen.has(id) || !prev || prev.deleted || !prev.active) continue;
        if (frameAt < num(prev.updatedAt, 0)) {
          skipped += 1;
          continue;
        }
        // 只清 active。updatedAt 必须留会话自己的时间：写成帧时间后，
        // 下一次全量把同一会话再带回来（时间没变）会被当成更旧丢掉，活动位回不来。
        const row = this._sessionFrom(prev, prev, { deleted: false, updatedAt: num(prev.updatedAt, 0) });
        row.active = false;
        if (!sameJson(prev, row)) {
          lines.push(row);
          map.set(id, row);
        }
      }
    }

    try {
      this._append(file, lines);
    } catch (e) {
      return { ok: false, reason: "write_failed", error: e.message };
    }
    if (frameAt >= prevFrameAt) this.lastManifestAt.set(memKey, frameAt);
    return { ok: true, stale: false, written: lines.length, skipped, tombstoned };
  }

  /**
   * 删掉一个会话在索引里的旧行，只留一条最小墓碑 {kind,id,deleted,updatedAt}（P9 B）：
   * 会话名、首条消息、路径、目录一律不留。整个文件按 map 原子重写（不设大小门槛，写完 fsync）。
   * 幂等；重复调用不会刷新更旧的墓碑时间。返回是否落盘成功。
   */
  forgetSession(accountId, deviceId, sessionId, at = Date.now()) {
    const account = typeof accountId === "string" ? accountId.trim() : "";
    const device = typeof deviceId === "string" ? deviceId.trim() : "";
    const id = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!account || !device || !id) return false;
    const file = this._sessionsFile(account, device);
    const current = this._map(file);
    const prev = current.get(id);
    const prevAt = num(prev && prev.updatedAt, 0);
    const updatedAt = Math.max(num(at, Date.now()), prevAt);
    // P2-3：提前返回要求「已有墓碑已经是最小形状」。旧版本（或 applyManifest 旧写法）留下的
    // 墓碑可能带 name/firstMessage/path/cwd；同一毫秒里时间相等，不重写就会把它留在盘上。
    if (isMinimalTombstone(prev) && prevAt >= updatedAt) return true;
    const map = new Map(current);
    map.set(id, { kind: "session", id, deleted: true, updatedAt });
    try {
      rewriteFromMap(file, map);
    } catch (e) {
      console.warn("[index] 会话墓碑写盘失败:", id, e.message);
      return false;
    }
    this.fileCache.set(file, map);
    return true;
  }

  getSession(accountId, deviceId, sessionId) {
    if (typeof sessionId !== "string" || !sessionId) return null;
    return this._map(this._sessionsFile(accountId, deviceId)).get(sessionId) || null;
  }

  /**
   * 墓碑不返回。truncated = 未删除总数超过 limit。
   * @returns {{sessions: object[], truncated: boolean, total: number}}
   */
  listSessions(accountId, deviceId, { limit = 200 } = {}) {
    const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 200;
    const all = [...this._map(this._sessionsFile(accountId, deviceId)).values()].filter((r) => r && r.kind === "session" && !r.deleted);
    all.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0) || String(a.id).localeCompare(String(b.id)));
    return { sessions: all.slice(0, cap), truncated: all.length > cap, total: all.length };
  }
}

module.exports = { AccountIndex, safeKey, DEFAULT_ACCOUNT };
