"use strict";
/** relay 公共小工具：日志开关、id 白名单、定时安全比较 */
const crypto = require("node:crypto");

/** room id 白名单（防路径穿越/怪文件名）；与 store.safeRoomId 一致 */
function safeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== "." && id !== "..";
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 公钥指纹（加密设计 §2.2）：公钥字节 SHA-256 的前 8 字节 = 16 位小写 hex，
 *  即帧与名册里的 keyFp/ackFp 形态（长度口径见协议 limits contentKeyFpChars）。
 *  入参可为 Buffer（spki der 字节）或 base64 串。两端须同源同算法，指纹对不上即钥不对。 */
function keyFingerprint(pub) {
  const buf = Buffer.isBuffer(pub) ? pub : Buffer.from(String(pub), "base64");
  return crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/** 指纹的人读形态：每 4 位 hex 一组空格分隔（"3f9a c41d …"），供名册展示与人工核对。 */
function formatFingerprint(fp) {
  const hex = String(fp).replace(/[^0-9a-f]/gi, "").toLowerCase();
  return hex.replace(/(.{4})(?=.)/g, "$1 ");
}

let QUIET = false;
function setQuiet(v) {
  QUIET = !!v;
}
function log(...a) {
  if (QUIET) return;
  console.log(new Date().toISOString(), "[relay]", ...a);
}

module.exports = { safeId, safeEqual, keyFingerprint, formatFingerprint, setQuiet, log };
