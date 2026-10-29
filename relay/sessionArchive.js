"use strict";
/** 设备在线时的会话正文：只留在内存里转给网页，不写入 data/。 */
const { send, broadcast } = require("./wire");

const ARCHIVE_MAX_BYTES = 200 * 1024;
// 每台设备最多缓存多少份会话正文（与 maxSessionsListed 默认值对齐）：
// 归档只进不出会让长命 relay 的内存随打开过的会话数线性涨，按 LRU 淘汰最久没被重推的。
const ARCHIVE_MAX_SESSIONS = 200;

/**
 * Crypto Phase 3 sealed form (design 4.1): the archive body travels as one
 * ACK-sealed blob -- { enc:1, ct } at session level with an empty messages
 * array outside, and firstMessage as its own { enc:1, ct } envelope. The
 * gate mirrors the web consumer (useRelay.decryptAndStoreArchive).
 */
function isSealedArchive(session) {
  return session.enc === 1 && typeof session.ct === "string" && session.ct.length > 0;
}

function sanitizeArchive(session) {
  if (!session || typeof session !== "object") return null;
  const id = typeof session.id === "string" ? session.id.trim() : "";
  if (!id || id.length > 200) return null;
  if (isSealedArchive(session)) {
    // Sealed passthrough: the relay holds no ACK and must not shape
    // ciphertext, so the envelope, the firstMessage envelope and the
    // messages array pass exactly as received -- no String() coercion, no
    // per-message filtering. The id is validated exactly like the plaintext
    // path, and the size cap applies to the sealed JSON as a whole:
    // oversize is rejected (null), never truncated, because a truncated ct
    // would be undecryptable garbage; storeSessionArchive then also evicts
    // any stale cached copy, the same as plaintext oversize.
    if (!Array.isArray(session.messages)) return null;
    let bytes = 0;
    try {
      bytes = Buffer.byteLength(JSON.stringify(session), "utf8");
    } catch {
      return null;
    }
    if (bytes > ARCHIVE_MAX_BYTES) return null;
    return session;
  }
  const messages = [];
  if (Array.isArray(session.messages)) {
    for (const item of session.messages) {
      if (!item || (item.role !== "user" && item.role !== "assistant")) continue;
      const text = typeof item.text === "string" ? item.text.slice(0, 8000) : "";
      if (!text.trim()) continue;
      const row = { id: String(item.id || messages.length).slice(0, 80), role: item.role, text };
      if (typeof item.timestamp === "number" && Number.isFinite(item.timestamp)) row.timestamp = item.timestamp;
      messages.push(row);
    }
  }
  const body = {
    id,
    cwd: typeof session.cwd === "string" ? session.cwd.slice(0, 500) : "",
    name: session.name ? String(session.name).slice(0, 200) : null,
    firstMessage: session.firstMessage ? String(session.firstMessage).slice(0, 80) : null,
    messageCount: Number(session.messageCount) || messages.length,
    truncated: session.truncated === true,
    omitted: Number(session.omitted) || 0,
    messages,
  };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > ARCHIVE_MAX_BYTES) return null;
  return body;
}

/** 归档键：与 sanitizeArchive 的 id 校验同口径；不合法返回 ""（不可能命中已有条目）。 */
function archiveKey(session) {
  const id = session && typeof session.id === "string" ? session.id.trim() : "";
  return id && id.length <= 200 ? id : "";
}

function storeSessionArchive(dev, session) {
  const body = sanitizeArchive(session);
  if (!dev) return null;
  if (!body) {
    // 新正文被拒（超 200KB 上限/非法 id）时，同 id 的旧副本必须一起丢掉：
    // 留着它 → 后打开的网页重放的是上一版正文，界面显示的内容与设备当前会话不一致
    // （报告：超限归档被拒后旧版本滞留）。删掉只是少一条缓存，网页会按需重新拉全文。
    const id = archiveKey(session);
    if (id && dev.archives) dev.archives.delete(id);
    return null;
  }
  if (!dev.archives) dev.archives = new Map();
  // 重新推同一份正文 = 最近使用：先删再写，Map 的插入顺序即 LRU 顺序。
  dev.archives.delete(body.id);
  dev.archives.set(body.id, body);
  while (dev.archives.size > ARCHIVE_MAX_SESSIONS) {
    const oldest = dev.archives.keys().next().value;
    if (oldest === undefined) break;
    dev.archives.delete(oldest);
  }
  return body;
}

function broadcastSessionArchive(rooms, deviceId, session, cfg) {
  // 实时路径也必须走 sanitize：调用方直接传原始对象时，200KB 上限与回放口径才一致
  // （报告 relay 中-6：广播原始对象会让上限形同虚设）。
  const body = sanitizeArchive(session);
  if (!body) return false;
  broadcast([...rooms.viewers], { type: "session_archive", deviceId, session: body }, cfg);
  return true;
}

/** 后打开的网页也要拿到已经读过的正文。一帧一帧让出事件循环，不挡住 auth_result。 */
function replaySessionArchives(ws, devices, cfg) {
  const frames = [];
  for (const dev of devices.values()) {
    if (!dev || !dev.archives || !dev.id) continue;
    for (const session of dev.archives.values()) frames.push({ type: "session_archive", deviceId: dev.id, session });
  }
  let index = 0;
  const step = () => {
    if (!ws || ws.readyState !== 1) return;
    const frame = frames[index++];
    if (!frame) return;
    send(ws, frame, cfg);
    if (index < frames.length) setImmediate(step);
  };
  if (frames.length) setImmediate(step);
}

module.exports = {
  ARCHIVE_MAX_BYTES,
  ARCHIVE_MAX_SESSIONS,
  isSealedArchive,
  sanitizeArchive,
  storeSessionArchive,
  broadcastSessionArchive,
  replaySessionArchives,
};
