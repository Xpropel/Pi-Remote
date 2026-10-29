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

/**
 * 核对字（防误批）：对裸码做带域分隔的 sha256，取摘要前两字节折成 00-99 的两位数（补零成 2 字符）。
 * 只由 relay 计算：pair_request_result 与 pair_lookup 的回包都带 checkDigits，终端与手机确认页同显
 * 这两位数供人工核对，展示端只显示、不许自己算——算法只此一份实现，避免三端各写一份日久漂移。
 */
function pairCheckDigits(code) {
  const digest = crypto.createHash("sha256").update("pair-check:" + String(code)).digest();
  return String((digest[0] * 256 + digest[1]) % 100).padStart(2, "0");
}

/**
 * 核对字 v2（SAS，加密设计 §3.2）：声明 crypto.auth 的配对把核对字改绑握手记录——
 * sha256("pair-check-v2:" + 裸码 + ":" + signPub + ":" + boxPub) 同法折 00–99。
 * 公钥被中间人替换时两端数字必然不一致；relay 仍是唯一计算方，展示端只显示不许自算。
 * 只在带 keys 的配对上用；未带 keys 的旧设备继续用 pairCheckDigits（v1），逐字节不变。
 */
function pairCheckDigitsV2(code, signPub, boxPub) {
  const digest = crypto.createHash("sha256").update("pair-check-v2:" + String(code) + ":" + String(signPub) + ":" + String(boxPub)).digest();
  return String((digest[0] * 256 + digest[1]) % 100).padStart(2, "0");
}

/* ---------------- 设备公钥（加密地基阶段 1，设计 §3） ----------------
 * 签名载荷的字节口径在此钉死（跨端契约，扩展/attach 必须同源实现、测试对拍）：
 * - pop（持有证明）：Ed25519 对「裸配对码」的 UTF-8 字节签名（裸码 = 归一后的大写无横线码）。
 * - auth：Buffer.concat(utf8("pi-remote-auth-v1"), utf8(deviceId), relayNonce 原始字节, clientNonce 原始字节)。
 * - key_update：Buffer.concat(utf8("pi-remote-keyupdate-v1"), utf8(deviceId), utf8(newSignPub), utf8(newBoxPub))，
 *   公钥按帧里的 base64 字符串形态签（避免 DER 重编码歧义）。 */

/** base64 串 → Buffer；非法/空返回 null。只接受标准 base64（含 +/ 与 = 填充），与两端编码器口径一致 */
function b64buf(v) {
  if (typeof v !== "string" || !v || v.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  try {
    const buf = Buffer.from(v, "base64");
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

/** 签名公钥（spki der base64）→ KeyObject；不是 Ed25519 返回 null */
function ed25519PubKey(signPub) {
  const der = b64buf(signPub);
  if (!der || der.length > PROTOCOL.limits.signPubKeyBytes) return null;
  try {
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

/** box 公钥（spki der base64）→ KeyObject；不是 P-256 返回 null */
function p256PubKey(boxPub) {
  const der = b64buf(boxPub);
  if (!der || der.length > PROTOCOL.limits.boxPubKeyBytes) return null;
  try {
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve === "prime256v1" ? key : null;
  } catch {
    return null;
  }
}

/** Ed25519 验签：公钥/签名/载荷任一不合规一律 false，不抛 */
function verifyEd25519(signPub, payload, sigB64) {
  const key = ed25519PubKey(signPub);
  const sig = b64buf(sigB64);
  if (!key || !sig || sig.length > PROTOCOL.limits.signatureMaxBytes) return false;
  try {
    return crypto.verify(null, payload, key, sig);
  } catch {
    return false;
  }
}

/**
 * 配对帧 keys 的白名单清洗（名册会落盘，进门前先按协议 limits 把尺寸钉死）：
 * {signPub, boxPub} 必须是可解析的 Ed25519 / P-256 spki 公钥。pop 在内时一并校验
 * 形状（验签由调用方对裸码做）。任一不合规返回 null，调用方拒绝整帧 keys。
 */
function cleanPubKeys(raw) {
  if (!raw || typeof raw !== "object") return null;
  const signPub = typeof raw.signPub === "string" ? raw.signPub : "";
  const boxPub = typeof raw.boxPub === "string" ? raw.boxPub : "";
  if (!ed25519PubKey(signPub) || !p256PubKey(boxPub)) return null;
  return { signPub, boxPub };
}

function cleanPairKeys(raw) {
  const pubs = cleanPubKeys(raw);
  if (!pubs) return null;
  const pop = raw && typeof raw.pop === "string" ? raw.pop : "";
  const sig = b64buf(pop);
  if (!sig || sig.length > PROTOCOL.limits.signatureMaxBytes) return null;
  return { ...pubs, pop };
}

/** pop 的签名载荷：裸配对码的 UTF-8 字节 */
function popPayload(code) {
  return Buffer.from(String(code), "utf8");
}

/** auth 签名载荷（§3.3 域分隔）：域串 ‖ deviceId ‖ relayNonce ‖ clientNonce（nonce 均为原始字节） */
function authPayload(deviceId, relayNonce, clientNonce) {
  return Buffer.concat([Buffer.from("pi-remote-auth-v1", "utf8"), Buffer.from(String(deviceId), "utf8"), relayNonce, clientNonce]);
}

/** key_update 签名载荷（§3.5 域分隔）：域串 ‖ deviceId ‖ 新 signPub ‖ 新 boxPub（公钥取帧内 base64 串形态） */
function keyUpdatePayload(deviceId, newSignPub, newBoxPub) {
  return Buffer.concat([Buffer.from("pi-remote-keyupdate-v1", "utf8"), Buffer.from(String(deviceId), "utf8"), Buffer.from(String(newSignPub), "utf8"), Buffer.from(String(newBoxPub), "utf8")]);
}

/* ---------------- Viewer identity keys (crypto Phase 2, design §3.2/§3.3/§7) ----------------
 * A viewer's signing key (VIK) and box key (VBK) are BOTH P-256, unlike devices whose
 * signing key is Ed25519. WebCrypto signs with ECDSA P-256 / SHA-256 and emits the
 * signature in IEEE P1363 form (r || s), so verification must use dsaEncoding
 * "ieee-p1363". The auth payload reuses authPayload() with the viewerId in place of
 * the deviceId — the domain string stays "pi-remote-auth-v1". */

/** P-256 signature verification (viewer VIK): any malformed input returns false, never throws. */
function verifyP256(signPub, payload, sigB64) {
  const key = p256PubKey(signPub);
  const sig = b64buf(sigB64);
  if (!key || !sig || sig.length > PROTOCOL.limits.signatureMaxBytes) return false;
  try {
    return crypto.verify("sha256", payload, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

/**
 * Viewer registration key whitelist: {signPub, boxPub} must both parse as P-256 spki
 * public keys. Both are bounded by boxPubKeyBytes (128) — the signPubKeyBytes limit (44)
 * is the Ed25519 spki length and does NOT apply to viewer keys.
 */
function cleanViewerPubKeys(raw) {
  if (!raw || typeof raw !== "object") return null;
  const signPub = typeof raw.signPub === "string" ? raw.signPub : "";
  const boxPub = typeof raw.boxPub === "string" ? raw.boxPub : "";
  if (!p256PubKey(signPub) || !p256PubKey(boxPub)) return null;
  return { signPub, boxPub };
}

/** Canonical JSON for admin signatures: object keys sorted recursively, array order
 *  preserved, no whitespace. Deterministic for any JSON-parsed frame, so the relay and
 *  the web end derive byte-identical payloads from the same logical frame. */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const parts = [];
  for (const k of Object.keys(value).sort()) parts.push(JSON.stringify(k) + ":" + canonicalJson(value[k]));
  return "{" + parts.join(",") + "}";
}

/**
 * adminSig payload (design §7; the canonicalization is fixed here and documented in
 * protocol/v4.json under crypto.auth): utf8("pi-remote-admin-v1") || utf8(frame.type) ||
 * utf8(canonicalJson(frame without the adminSig / adminToken / type fields)).
 * The signature itself is ECDSA P-256 / SHA-256, IEEE P1363, base64 — see verifyP256.
 */
function adminPayload(frame) {
  const src = frame && typeof frame === "object" ? frame : {};
  const rest = {};
  for (const k of Object.keys(src)) {
    if (k === "adminSig" || k === "adminToken" || k === "type") continue;
    rest[k] = src[k];
  }
  return Buffer.concat([
    Buffer.from("pi-remote-admin-v1", "utf8"),
    Buffer.from(String(src.type || ""), "utf8"),
    Buffer.from(canonicalJson(rest), "utf8"),
  ]);
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
 * 配对失败记账（ctx.pairFailures：来源 → 最近失败时间戳数组），pair / pair_request / pair_lookup 共用一本账。
 * pairSourceBlocked 只查不记：窗口内失败已达上限返回 true，调用方直接回 rate_limited（被限时不再追加记账，
 * 免得锁定窗口被自己的重试一直续命）。notePairFailure 记一次失败：先剪掉窗口外的旧账，
 * 再把来源挪到 Map 末尾（按最近出错排序），来源太多时挤掉最久没出错的。
 */
function pairSourceBlocked(failures, source, now) {
  const recent = (failures.get(source) || []).filter((t) => t > now - PAIR_FAIL_WINDOW_MS);
  return recent.length >= PAIR_FAIL_MAX;
}

function notePairFailure(failures, source, now) {
  const recent = (failures.get(source) || []).filter((t) => t > now - PAIR_FAIL_WINDOW_MS);
  failures.delete(source);
  failures.set(source, [...recent, now]);
  if (failures.size > PAIR_FAIL_SOURCES_MAX) failures.delete(failures.keys().next().value);
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

module.exports = { PAIR_FAIL_WINDOW_MS, PAIR_FAIL_MAX, PAIR_FAIL_SOURCES_MAX, PAIR_CODES_MAX, sha256hex, newPairCode, formatPairCode, normalizePairCode, pairCheckDigits, pairCheckDigitsV2, b64buf, ed25519PubKey, p256PubKey, verifyEd25519, verifyP256, cleanPubKeys, cleanPairKeys, cleanViewerPubKeys, popPayload, authPayload, keyUpdatePayload, adminPayload, pairSourceBlocked, notePairFailure, requestSource, checkDeviceToken };
