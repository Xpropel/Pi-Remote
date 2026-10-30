"use strict";
/** 设备名册：平台与路径规则、白名单清洗、账号绑定、room_list 的设备项 */
const { DEFAULT_ACCOUNT } = require("./index");
const { log, keyFingerprint } = require("./util");
const { normalizeAccount } = require("./config");

const UNREGISTERED_DEVICE = "未登记设备";

/** 设备平台统一成 windows / macos / linux：旧扩展在 macOS 上报的是 Node 的 "darwin"。不认识的照原样小写、截短。 */
const PLATFORM_ALIASES = {
  windows: "windows", win32: "windows", win: "windows",
  macos: "macos", darwin: "macos", mac: "macos", osx: "macos",
  linux: "linux",
};
const POSIX_PLATFORMS = new Set(["macos", "linux", "freebsd", "openbsd", "netbsd", "sunos", "aix", "android"]);
const MAX_DEVICE_NAME = 64;
const MAX_DEVICE_PROJECTS = 64;
const MAX_PROJECT_PATH = 1024;

function normalizePlatform(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "";
  return PLATFORM_ALIASES[raw] || raw.replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

/**
 * 按设备平台比较路径（与本机 attach 同一套规则）：Windows 反斜杠当分隔符、不分大小写；
 * macOS（APFS 默认）不分大小写；Linux 等区分大小写。平台未知（老设备）沿用最宽松的旧规则。
 */
function normPath(p, platform = "") {
  const posix = POSIX_PLATFORMS.has(platform);
  let s = String(p || "");
  if (!posix) s = s.replace(/\\/g, "/");
  // 根目录不能归一成空串：POSIX 的 "/" 去掉末尾斜杠后是 ""，会让 cwdAllowed(["/"], "/")
  // 与 underRoots(["/"], "/tmp/x") 永远为 false（报告 relay 低-26）。
  // Windows 盘根 "C:/" 去斜杠后是 "c:"，前缀判断会补成 "c:/"，本来就能匹配，保持原样。
  const rooted = s.startsWith("/");
  s = s.replace(/\/+$/, "");
  if (!s && rooted) s = "/";
  return !posix || platform === "macos" ? s.toLowerCase() : s;
}

/** cwd 必须与某个 project 精确相等（末尾斜杠不计，大小写按平台）。子目录不算，避免和本机 attach、网页各用一套规则。 */
function cwdAllowed(projects, cwd, platform = "") {
  const c = normPath(cwd, platform);
  if (!c) return false;
  return (Array.isArray(projects) ? projects : []).some((proj) => normPath(proj, platform) === c);
}

/** 浏览根目录判断（P9 C）：与 cwdAllowed 同口径（normPath），要求完全相等，
 *  或者前缀后面紧跟分隔符——`/Users/user/x` 不算在 `/Users/user` 下，`/Users/user/x` 算。 */
function underRoots(roots, cwd, platform = "") {
  const c = normPath(cwd, platform);
  if (!c || !Array.isArray(roots)) return false;
  for (const root of roots) {
    const r = normPath(root, platform);
    if (!r) continue;
    if (r === c) return true;
    const prefix = r.endsWith("/") ? r : r + "/";
    if (c.startsWith(prefix)) return true;
  }
  return false;
}

/** 设备上报的白名单：只收非空字符串，去重，单条和总数都有上限（名册会落盘，不能被一台设备撑大） */
function cleanProjects(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const p of list) {
    if (typeof p !== "string") continue;
    const s = p.trim();
    if (!s || s.length > MAX_PROJECT_PATH || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_DEVICE_PROJECTS) break;
  }
  return out;
}

function blankDevice(accountId, id) {
  return {
    accountId: accountId || DEFAULT_ACCOUNT,
    id,
    name: "",
    platform: "",
    projects: [],
    // 能力位与设备侧事实（P9 B/C）：features 是 attach 声明里 relay 关心的子集，
    // trash 是 PATH 里有没有 trash 命令，browseRoots 是允许浏览的根目录（device_register 时填）
    features: [],
    trash: false,
    browseRoots: [],
    conn: null,
    online: false,
    windowExpiresAt: null,
    lastAttachAt: 0,
    activeRoomId: null,
    startInFlight: false,
  };
}

/** 发给设备窗口的 room_list：只含这台设备自己的设备项和房间 */
function roomListForDevice(deviceId, devices, rooms) {
  const id = String(deviceId || "");
  return {
    type: "room_list",
    devices: (devices || []).filter((d) => d && String(d.id) === id),
    rooms: (rooms || []).filter((r) => r && String(r.deviceId) === id),
  };
}

/**
 * 设备归属的账号由服务端决定：已登记（内存或索引里有）的沿用原账号，否则绑定到本 relay 配置的账号。
 * 客户端上报的 accountId 一律不采信——持有 localToken 不能把设备/会话写进别的账号。
 */
function boundAccount(index, devices, deviceId, cfgAccount) {
  const id = typeof deviceId === "string" ? deviceId.trim() : "";
  if (id) {
    const dev = devices.get(id);
    if (dev && dev.accountId) return dev.accountId;
    try {
      const known = index.findDevice(id);
      if (known && known.accountId) return known.accountId;
    } catch {}
  }
  return normalizeAccount(cfgAccount);
}

/**
 * 首次连接时间：新索引行用持久 firstSeenAt；老行没有该字段时按 pairedAt → lastAttachAt 回退。
 * 都没有就返回 0（未知），不拿当前时间伪造。内存名册（索引写失败/尚未落盘）同理。
 */
function firstSeenOf(row, mem) {
  const candidates = [
    row && row.firstSeenAt,
    row && row.pairedAt,
    row && row.lastAttachAt,
    mem && mem.firstSeenAt,
    mem && mem.lastAttachAt,
  ];
  for (const value of candidates) {
    const at = Number(value);
    if (Number.isFinite(at) && at > 0) return at;
  }
  return 0;
}

function buildDeviceList(index, devices, rooms, accountId = DEFAULT_ACCOUNT) {
  let rows = [];
  try {
    rows = index.listDevices(accountId);
  } catch (e) {
    log("读取设备名册失败:", e.message);
  }
  const seen = new Set();
  const out = [];
  // device.token：auth = 在线窗口连接的鉴权方式（离线 null），paired = 有没有有效令牌
  const authOf = (mem) => (mem && mem.online && mem.conn && mem.conn._state ? mem.conn._state.auth || "legacy" : null);
  // 连接窗口到期时间：窗口在线时才可信；离线不编造（重连后 attach 会立刻重新登记）
  const windowOf = (mem) => (mem && mem.online && Number.isFinite(Number(mem.windowExpiresAt)) ? Number(mem.windowExpiresAt) : null);
  // P9 B/C：设备侧能力与事实只在线时可信（离线时 features/browseRoots 下发空，trash 沿用最后登记值）
  const featuresOf = (mem) => (mem && mem.online && Array.isArray(mem.features) ? mem.features : []);
  const trashOf = (mem) => !!(mem && mem.trash);
  const browseRootsOf = (mem) => (mem && mem.online && Array.isArray(mem.browseRoots) ? mem.browseRoots : []);
  // 设备↔relay 延迟（keepalive 的 ping/pong RTT，EMA 平滑）：只有在线且已有样本时给整数毫秒。
  // 离线 / 刚连上还没回 pong 时给 null —— 不外推、不拿别的连接/上次连接的值冒充。
  const latencyOf = (mem) => {
    const raw = mem && mem.online && mem.conn && mem.conn._state ? mem.conn._state.latencyMs : null;
    // 先判 null 再转数字：Number(null) === 0，会把「没有样本」伪装成 0ms 的真延迟
    if (raw == null) return null;
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.round(ms);
  };
  const pairedOf = (id) => {
    try {
      return index.hasDeviceToken(accountId, id);
    } catch {
      return false;
    }
  };
  // Bridge (extension) presence, per device: a room counts only while its
  // local end is a live, post-auth bridge socket (room.local is set solely by
  // the room_register handler after auth, and cleared on close). "online"
  // alone only proves the attach window is connected; a device whose pi
  // processes never brought a bridge up looks online yet cannot mirror or
  // deliver anything (defect A3-F1), so the roster exposes the distinction
  // and the UI renders it as a degraded state.
  const bridgeIds = new Set();
  if (rooms && rooms.map) {
    for (const r of rooms.map.values()) {
      if (r && r.deviceId && r.local) bridgeIds.add(String(r.deviceId));
    }
  }
  // 设备身份钥（加密设计 §3.5）：指纹与登记时间只来自索引行（公钥是公开数据），
  // 无钥设备不带这两个键。是否下发由发送侧按连接的 crypto.auth cap 裁剪
  // （rooms.devicesViewFor）——未声明 cap 的旧端设备条目逐字节不变。
  const keyFpOf = (row) => {
    const pub = row && row.keys && row.keys.sign && typeof row.keys.sign.pub === "string" ? row.keys.sign.pub : "";
    return pub ? keyFingerprint(pub) : null;
  };
  const keyAddedAtOf = (row) => {
    const at = row && row.keys && row.keys.sign ? Number(row.keys.sign.addedAt) : NaN;
    return Number.isFinite(at) && at > 0 ? at : null;
  };
  for (const row of rows) {
    seen.add(row.id);
    const mem = devices.get(row.id);
    const entry = {
      id: row.id,
      accountId: (mem && mem.accountId) || accountId,
      name: (mem && mem.name) || row.name || "",
      platform: normalizePlatform((mem && mem.platform) || row.platform || ""),
      online: !!(mem && mem.online),
      projects: (mem && mem.projects) || row.projects || [],
      lastAttachAt: (mem && mem.lastAttachAt) || row.lastAttachAt || 0,
      firstSeenAt: firstSeenOf(row, mem),
      windowExpiresAt: windowOf(mem),
      auth: authOf(mem),
      paired: pairedOf(row.id),
      features: featuresOf(mem),
      trash: trashOf(mem),
      browseRoots: browseRootsOf(mem),
      latencyMs: latencyOf(mem),
      bridgeOnline: bridgeIds.has(String(row.id)),
    };
    const keyFp = keyFpOf(row);
    if (keyFp) {
      entry.keyFp = keyFp;
      entry.keyAddedAt = keyAddedAtOf(row);
    }
    out.push(entry);
  }
  for (const [id, mem] of devices) {
    if (seen.has(id)) continue;
    if ((mem.accountId || DEFAULT_ACCOUNT) !== accountId) continue;
    out.push({
      id,
      accountId: mem.accountId || accountId,
      name: mem.name || "",
      platform: normalizePlatform(mem.platform || ""),
      online: !!mem.online,
      projects: mem.projects || [],
      lastAttachAt: mem.lastAttachAt || 0,
      firstSeenAt: firstSeenOf(null, mem),
      windowExpiresAt: windowOf(mem),
      auth: authOf(mem),
      paired: pairedOf(id),
      features: featuresOf(mem),
      trash: trashOf(mem),
      browseRoots: browseRootsOf(mem),
      latencyMs: latencyOf(mem),
      bridgeOnline: bridgeIds.has(String(id)),
    });
  }
  let unreg = false;
  for (const r of rooms.map.values()) {
    if (r.online && !r.deviceId) unreg = true;
  }
  // 契约 §4.2：未登记设备条目固定为 {id, online:false}。展示名/项目由前端自己补，relay 不多带字段
  // 未登记设备的在线状态由名下房间决定：ALWAYS_ONLINE/老扩展不报 deviceId 时，房间在线而伪设备永远
  // offline，设备模式下这些会话打不开也发不了消息（前端 composerGate 认 device.online）。
  if (unreg) out.push({ id: UNREGISTERED_DEVICE, online: unreg });
  return out;
}

module.exports = { UNREGISTERED_DEVICE, MAX_DEVICE_NAME, normalizePlatform, normPath, cwdAllowed, underRoots, cleanProjects, blankDevice, roomListForDevice, boundAccount, buildDeviceList };
