"use strict";
/**
 * 主题偏好跨设备同步（R4-1）的 relay 托管存储。
 *
 * per-account 一份记录 {subset, rev, updatedAt}：subset 只含通用外观五字段
 * {theme, chrome, font, size, mono}（白名单见 cleanPrefsSubset），rev 是 relay
 * 维护的单调递增序号——冲突裁决只认 rev 与到达顺序，不信客户端时钟（LWW）。
 *
 * 落盘骑 AccountIndex 同款小文件机制：data/accounts/<safeKey(accountId)>/prefs.json，
 * tmp + fsync + rename、mode 0o600。内存态是主态，落盘只是重启恢复用：
 * 写失败只记日志降级为纯内存态，不阻断同步（偏好丢一版不值得让通道报错）。
 */
const fs = require("node:fs");
const path = require("node:path");
const { safeKey } = require("./index");
const { log } = require("./util");

/** 同步白名单五字段（定版）：faces/color 是皮肤内部细节、本设备行为字段不入同步。 */
const PREFS_FIELDS = ["theme", "chrome", "font", "size", "mono", "mobileNav"];
const FIELD_VALUE_RE = /^[A-Za-z0-9_-]+$/;

/**
 * 入口清洗：只收白名单五字段，逐个验形状（字符串字段 ≤32 字符的标识符形状；
 * size 是 10–32 的整数）。坏字段丢弃而不是整份拒绝——发送端偶发多带/带坏一个
 * 字段，不该让其余字段的同步一起失败；一个合法字段都没有才返回 null。
 * 枚举级校验（主题名是否存在等）归 UI 应用侧（cleanStyleSubset 与 loadStyle 同口径），
 * relay 不复制 UI 的取值表。
 * 与 cleanStyleSubset 的同构关系（第 4 轮审查 A-2）：UI 侧接受的每个字段值必须能
 * 原样通过本函数的形状校验（UI 接受集 ⊆ relay 接受集）——否则被本函数丢弃的字段
 * 会让发送端与其它端静默分歧。该关系由 test/prefs-sync.test.mjs 的「A-2 同构」
 * 断言钉住（穷举 UI 全部 choices + 同组坏样本逐字段对账）；改形状规则时两边同看。
 */
function cleanPrefsSubset(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const key of PREFS_FIELDS) {
    const v = raw[key];
    if (key === "size") {
      if (typeof v === "number" && Number.isInteger(v) && v >= 10 && v <= 32) out.size = v;
    } else if (key === "mobileNav") {
      // P11 additive：移动导航双模式；只接受 list/drawer（旧 relay 无此字段 → 客户端保默认 list）
      if (v === "list" || v === "drawer") out.mobileNav = v;
    } else if (typeof v === "string" && v.length >= 1 && v.length <= 32 && FIELD_VALUE_RE.test(v)) {
      out[key] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

function fsyncFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    fs.fsyncSync(fd);
    return true;
  } catch (e) {
    log("prefs fsync 失败（数据可能只在页缓存）:", file, e.message);
    return false;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

/** 落盘记录形状校验：坏文件/坏行当作无记录，不让一份坏偏好挡住整个通道。 */
function cleanRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const subset = cleanPrefsSubset(raw.subset);
  const rev = typeof raw.rev === "number" && Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : null;
  if (!subset || rev == null) return null;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
  return { subset, rev, updatedAt };
}

class PrefsStore {
  /** @param {string} accountsDir 与 AccountIndex 同根（data/accounts） */
  constructor(accountsDir) {
    this.dir = accountsDir;
    /** @type {Map<string, {subset: object, rev: number, updatedAt: number} | null>} 账号 → 记录（null = 已查过、无记录） */
    this.cache = new Map();
  }

  _file(accountId) {
    return path.join(this.dir, safeKey(accountId), "prefs.json");
  }

  /** 当前记录（没有返回 null）。首次访问懒读盘，之后全走内存。 */
  get(accountId) {
    if (this.cache.has(accountId)) return this.cache.get(accountId);
    let rec = null;
    try {
      rec = cleanRecord(JSON.parse(fs.readFileSync(this._file(accountId), "utf8")));
    } catch (e) {
      if (!e || e.code !== "ENOENT") log("prefs 落盘记录读失败（按无记录处理）:", accountId, e && e.message);
    }
    this.cache.set(accountId, rec);
    return rec;
  }

  /**
   * 写入一份子集。旧客户端按整份替换上行（五字段齐全），新客户端只上行变化字段
   * （P11 的 {mobileNav}）——这里按字段合并：缺席字段沿用当前值，避免"只改 mobileNav
   * 就把别端同步过来的外观字段清空"（报告 relay 低-25）。整份上行时合并结果与
   * 整份替换一致，LWW 裁决不变。
   * baseRev 只作观测/诊断：落后仍按到达顺序裁决（既有兼容口径），但会记一行日志，
   * 不再出现"版本号收了却完全没用"。
   * rev 在现有值上 +1（无记录从 1 起），updatedAt 由 relay 时钟打（不信客户端时钟）。
   * 先更内存再试落盘：落盘失败只降级、不回滚——同步语义以内存态为准，重启恢复尽力而为。
   * 返回裁决后的记录。
   */
  set(accountId, subset, now = Date.now(), baseRev = null) {
    const cur = this.get(accountId);
    const merged = cur && cur.subset ? { ...cur.subset, ...subset } : { ...subset };
    if (cur && Number.isInteger(baseRev) && baseRev >= 0 && baseRev < cur.rev) {
      log("prefs 同步：baseRev 落后（baseRev=" + baseRev + "，当前 rev=" + cur.rev + "），按字段合并后仍以到达顺序裁决");
    }
    const rec = { subset: merged, rev: (cur ? cur.rev : 0) + 1, updatedAt: now };
    this.cache.set(accountId, rec);
    this._persist(accountId, rec);
    return rec;
  }

  _persist(accountId, rec) {
    const file = this._file(accountId);
    const tmp = file + ".tmp";
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(rec) + "\n", { encoding: "utf8", mode: 0o600 });
      if (!fsyncFile(tmp)) throw new Error("tmp fsync 失败");
      fs.renameSync(tmp, file);
    } catch (e) {
      log("prefs 落盘失败（降级纯内存态，同步不受影响）:", accountId, e.message);
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

module.exports = { PrefsStore, cleanPrefsSubset, PREFS_FIELDS };
