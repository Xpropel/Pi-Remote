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

let QUIET = false;
function setQuiet(v) {
  QUIET = !!v;
}
function log(...a) {
  if (QUIET) return;
  console.log(new Date().toISOString(), "[relay]", ...a);
}

module.exports = { safeId, safeEqual, setQuiet, log };
