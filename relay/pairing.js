"use strict";
/** 设备配对与令牌（device.token）：配对码、配对限速的来源、令牌校验 */
const crypto = require("node:crypto");
const net = require("node:net");
const PROTOCOL = require("./protocol.json");
const { safeEqual } = require("./util");
const { boundAccount } = require("./devices");

/* ---------------- 设备配对与令牌（device.token） ---------------- */
// 配对码 32^8 种、10 分钟有效，本来就猜不中；失败计数只为挡住刷接口，所以按来源记：一个来源一分钟错满 10 次
// 就停它一分钟，别的来源照常配对（全局计数的话，谁连上 7001 刷 10 个错码就能把所有人堵住）
const PAIR_FAIL_WINDOW_MS = 60 * 1000;
const PAIR_FAIL_MAX = 10;
const PAIR_FAIL_SOURCES_MAX = 1000; // 记账的来源数上限（只在内存里），满了挤掉最久没出错的
const PAIR_CODES_MAX = 20; // 同时有效的配对码上限（只在内存里）

function sha256hex(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

function newPairCode(taken) {
  const { pairCodeAlphabet: abc, pairCodeLength: len } = PROTOCOL.limits;
  for (;;) {
    let s = "";
    for (let i = 0; i < len; i++) s += abc[crypto.randomInt(abc.length)];
    if (!taken.has(s)) return s;
  }
}

/** 展示形式 XXXX-XXXX */
function formatPairCode(code) {
  const half = Math.ceil(code.length / 2);
  return code.slice(0, half) + "-" + code.slice(half);
}

/** 用户输入的配对码：不分大小写，忽略空格和短横线；长度或字符不对返回空串 */
function normalizePairCode(v) {
  if (typeof v !== "string") return "";
  const s = v.toUpperCase().replace(/[\s-]/g, "");
  const { pairCodeAlphabet: abc, pairCodeLength: len } = PROTOCOL.limits;
  return s.length === len && [...s].every((ch) => abc.includes(ch)) ? s : "";
}

/** 规整成裸 IP：去掉 IPv6 区域号和 IPv4 映射前缀（::ffff:1.2.3.4）；不是合法 IP 返回空串 */
function plainIp(v) {
  let s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s.includes("%")) s = s.slice(0, s.indexOf("%"));
  if (s.startsWith("::ffff:") && net.isIPv4(s.slice(7))) s = s.slice(7);
  return net.isIP(s) ? s : "";
}

/** IPv6 的前 64 位，形如 2001:db8:1:2::/64（结尾的点分 IPv4 占两组） */
function ipv6Prefix64(ip) {
  const width = (groups) => groups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const [head, tail] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const groups = tail === undefined ? a : [...a, ...Array(8 - width(a) - width(b)).fill("0"), ...b];
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/**
 * 配对限速按哪个来源记账：对端 IP。对端是回环又带 X-Forwarded-For（本机反代，比如 Caddy 把 wss 转到 127.0.0.1:7001）时
 * 取最后一跳——那一跳是反代自己填的，前面几跳客户端可以随便写；对端不是回环就不看这个头，否则谁都能换个头绕开限速。
 * IPv6 按 /64 记：一个用户手里通常是整段，按单个地址记等于不限。
 */
function requestSource(req) {
  const peer = plainIp(req && req.socket && req.socket.remoteAddress);
  let ip = peer;
  if (peer === "::1" || peer.startsWith("127.")) {
    const hops = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",");
    ip = plainIp(hops[hops.length - 1]) || peer;
  }
  if (!ip) return "unknown";
  return net.isIPv6(ip) && ip !== "::1" ? ipv6Prefix64(ip) : ip;
}

/**
 * v4 设备鉴权：令牌的 sha256 和账号下每一行做定时安全比较。
 * 令牌属于别的设备 → device_mismatch；属于这台但已作废 → device_revoked；对不上任何一行 → auth_failed。
 */
function checkDeviceToken(index, devices, cfg, deviceId, token) {
  const accountId = boundAccount(index, devices, deviceId, cfg.accountId);
  const hash = sha256hex(token);
  let hit = null;
  for (const row of index.deviceTokens(accountId)) {
    if (safeEqual(row.hash, hash)) { hit = row; break; }
  }
  if (!hit) return { ok: false, code: "auth_failed" };
  if (hit.deviceId !== deviceId) return { ok: false, code: "device_mismatch" };
  if (hit.revokedAt) return { ok: false, code: "device_revoked" };
  return { ok: true, accountId };
}

module.exports = { PAIR_FAIL_WINDOW_MS, PAIR_FAIL_MAX, PAIR_FAIL_SOURCES_MAX, PAIR_CODES_MAX, sha256hex, newPairCode, formatPairCode, normalizePairCode, requestSource, checkDeviceToken };
