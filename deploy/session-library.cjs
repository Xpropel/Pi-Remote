"use strict";
/**
 * 读取本机 pi 会话目录（~/.pi/agent/sessions），整理成可放进单帧的正文摘要。
 * 不启动 pi。只保留用户/助手的可见文字；思考、工具原文和图片不进帧。
 * 超预算时留下较新的消息，并标明前面省略了多少条。
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const TEXT_BUDGET = 140_000;
const PER_MESSAGE = 8_000;
const SESSION_FILE_EXPORT_DEFAULT_BYTES = 512 * 1024;
const SESSION_FILE_EXPORT_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_FILE_TEXT_READ_MAX_BYTES = 8 * 1024 * 1024;
const SESSION_INFO_NAME_MAX = 200;

function diskError(code, message) {
  const err = new Error(message);
  err.code = code;
  err._structured = true;
  return err;
}

function fsToDiskError(err, action) {
  if (err && err._structured) return err;
  const code = err && typeof err.code === "string" ? err.code : "";
  const detail = String((err && err.message) || err || "未知错误");
  if (code === "ENOENT") return diskError("not_found", action + "失败：文件不存在（" + detail + "）");
  if (code === "EACCES" || code === "EPERM") return diskError("internal", action + "失败：没有权限（" + detail + "）");
  if (code === "EISDIR") return diskError("bad_args", action + "失败：目标是目录");
  return diskError("internal", action + "失败：" + detail);
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1048576) return (v / 1048576).toFixed(1) + " MB";
  if (v >= 1024) return Math.round(v / 1024) + " KB";
  return v + " B";
}

function writeAllSync(fd, chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!n) throw diskError("internal", "写入磁盘返回 0 字节");
    off += n;
  }
}

function textOf(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && block.text) parts.push(String(block.text));
    else if (block.type === "image") parts.push("[图片]");
    else if (block.type === "toolCall") parts.push("调用 " + String(block.name || "工具"));
  }
  return parts.join("\n");
}

function plainTextOf(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text")
    .map((b) => String(b.text || ""))
    .join("\n");
}

/**
 * 解析 JSONL 会话文本。
 * strict=true 用于磁盘写/导出操作（任何损坏行或缺失头直接报结构化错误）；
 * strict=false 用于 readArchive 容错扫盘。
 */
function parseSessionRaw(raw, { strict = false, action = "读取会话" } = {}) {
  const lines = String(raw || "").split(/\r?\n/);
  let header = null;
  let sawFirst = false;
  let name = "";
  let leafId = null;
  const entries = [];
  const byId = new Map();
  const labels = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      if (strict) throw diskError("internal", action + "失败：会话文件第 " + (i + 1) + " 行不是合法 JSON（文件可能损坏）");
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      if (strict) throw diskError("internal", action + "失败：会话文件第 " + (i + 1) + " 行不是 pi 会话条目（文件可能损坏）");
      continue;
    }
    if (!sawFirst) {
      sawFirst = true;
      if (strict) {
        if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id) {
          throw diskError("internal", action + "失败：不是有效的 pi 会话文件（缺少 session 头）");
        }
        header = entry;
        if (typeof entry.leafId === "string" && entry.leafId) leafId = entry.leafId;
        continue;
      }
    }
    if (entry.type === "session" && !header) {
      header = entry;
      if (typeof entry.leafId === "string" && entry.leafId) leafId = entry.leafId;
      continue;
    }
    entries.push(entry);
    if (entry.type === "leaf" && typeof (entry.leafId || entry.leaf) === "string") {
      leafId = String(entry.leafId || entry.leaf);
    }
    if (typeof entry.id === "string" && entry.id) {
      byId.set(entry.id, entry);
      leafId = entry.id;
    }
    if (entry.type === "session_info" && entry.name) {
      name = String(entry.name).trim();
    } else if (entry.type === "label" && typeof entry.targetId === "string" && entry.targetId) {
      if (typeof entry.label === "string" && entry.label) {
        labels.set(entry.targetId, { label: entry.label, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined });
      } else {
        labels.delete(entry.targetId);
      }
    }
  }
  if (strict && (!header || header.type !== "session" || typeof header.id !== "string" || !header.id)) {
    throw diskError("internal", action + "失败：不是有效的 pi 会话文件（缺少 session 头）");
  }
  return { header, entries, byId, leafId, name, labels };
}

/** 从 leafId 沿 parentId 走回根并反转为 root→leaf；旧格式/测试条目未带 parentId 或 id 时退回顺序列表。 */
function buildActiveBranch(entries, { byId = null, leafId = null } = {}) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const hasTree = entries.some(
    (e) => e && typeof e.id === "string" && e.id && Object.prototype.hasOwnProperty.call(e, "parentId"),
  );
  if (!hasTree) return [...entries];
  const map = byId instanceof Map ? byId : new Map();
  if (!(byId instanceof Map)) {
    for (const e of entries) {
      if (e && typeof e.id === "string" && e.id) map.set(e.id, e);
    }
  }
  let cur = leafId && map.has(leafId) ? map.get(leafId) : null;
  if (!cur) {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i] && typeof entries[i].id === "string" && entries[i].id) {
        cur = entries[i];
        break;
      }
    }
  }
  if (!cur) return [...entries];
  const out = [];
  const seen = new Set();
  while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? map.get(String(cur.parentId)) || null : null;
  }
  return out.reverse();
}

function traceBranchToId(byId, targetId) {
  if (!byId || !targetId) return [];
  let cur = byId.get(String(targetId)) || null;
  const out = [];
  const seen = new Set();
  while (cur && typeof cur.id === "string" && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? byId.get(String(cur.parentId)) || null : null;
  }
  return out.reverse();
}

function readStrictFile(file, action) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw fsToDiskError(err, action);
  }
  if (!stat.isFile()) throw diskError("bad_args", action + "失败：不是普通文件");
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw fsToDiskError(err, action);
  }
  return { stat, raw, parsed: parseSessionRaw(raw, { strict: true, action }) };
}

function readArchive(file, options = {}) {
  const budget = options.textBudget || TEXT_BUDGET;
  const perMessage = options.perMessage || PER_MESSAGE;
  const raw = fs.readFileSync(file, "utf8");
  const stat = fs.statSync(file);
  const { header, entries, byId, leafId, name } = parseSessionRaw(raw, { strict: false });
  const branch = buildActiveBranch(entries, { byId, leafId });
  const messages = [];
  for (const entry of branch) {
    if (!entry || entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    let text = textOf(entry.message).trim();
    if (!text) continue;
    if (text.length > perMessage) text = text.slice(0, perMessage) + "…";
    messages.push({
      id: String(entry.id || messages.length),
      role,
      text,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
    });
  }
  let used = 0;
  let start = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const next = messages[index].text.length;
    if (used + next > budget && start < messages.length) break;
    used += next;
    start = index;
  }
  const kept = messages.slice(start);
  const first = messages.find((item) => item.role === "user");
  const idFromName = path.basename(file).replace(/\.jsonl$/, "").split("_").pop();
  return {
    id: header && header.id ? String(header.id) : idFromName,
    path: file,
    cwd: header && header.cwd ? String(header.cwd) : "",
    name: name || null,
    firstMessage: first ? first.text.slice(0, 80) : null,
    messageCount: messages.length,
    modified: new Date(stat.mtimeMs).toISOString(),
    updatedAt: stat.mtimeMs,
    sizeBytes: stat.size,
    createdAt: header && typeof header.timestamp === "number" ? header.timestamp : stat.mtimeMs,
    parentSession: header && header.parentSession ? String(header.parentSession) : null,
    truncated: start > 0,
    omitted: start,
    messages: kept,
  };
}

function conversationTextFromEntries(branch) {
  const parts = [];
  for (const entry of branch) {
    if (!entry) continue;
    if (entry.type === "message" && entry.message) {
      const message = entry.message;
      const role = message.role;
      if (role === "user") {
        const text = plainTextOf(message);
        if (text) parts.push("[User]: " + text);
      } else if (role === "assistant") {
        const text = plainTextOf(message);
        if (text) parts.push("[Assistant]: " + text);
        const calls = Array.isArray(message.content)
          ? message.content.filter((b) => b && b.type === "toolCall").map((b) => {
            const args = b.arguments && typeof b.arguments === "object"
              ? Object.entries(b.arguments).map(([k, v]) => k + "=" + JSON.stringify(v)).join(", ")
              : "";
            return String(b.name || "tool") + "(" + args + ")";
          })
          : [];
        if (calls.length) parts.push("[Assistant tool calls]: " + calls.join("; "));
      } else if (role === "toolResult") {
        const text = plainTextOf(message);
        if (text) parts.push("[Tool result]: " + text);
      }
    } else if (entry.type === "branch_summary" && entry.summary) {
      parts.push("[Branch summary]: " + String(entry.summary));
    } else if (entry.type === "compaction" && entry.summary) {
      parts.push("[Compaction summary]: " + String(entry.summary));
    }
  }
  return parts.join("\n\n");
}

function renameSessionFileOnDisk(file, rawName, _options = {}) {
  const name = String(rawName == null ? "" : rawName).replace(/[\r\n]+/g, " ").trim();
  if (!name) throw diskError("bad_args", "rename_session_file 需要 name");
  if (name.length > SESSION_INFO_NAME_MAX) {
    throw diskError("bad_args", "会话名过长（上限 " + SESSION_INFO_NAME_MAX + " 字符）");
  }
  const { raw, parsed } = readStrictFile(file, "改名");
  const entryId = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const entry = {
    type: "session_info",
    id: entryId,
    parentId: parsed.leafId || null,
    timestamp: new Date().toISOString(),
    name,
  };
  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  let fd = null;
  try {
    fd = fs.openSync(file, "a");
    writeAllSync(fd, prefix + JSON.stringify(entry) + "\n");
    try { fs.fsyncSync(fd); } catch {}
  } catch (err) {
    throw fsToDiskError(err, "改名");
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
  const archive = readArchive(file);
  archive.name = name;
  const session = manifestRow(archive);
  return {
    ok: true,
    id: String(parsed.header.id),
    sessionPath: file.replace(/\\/g, "/"),
    name,
    previousName: parsed.name || null,
    entryId,
    session,
    archive,
  };
}

function exportSessionFileOnDisk(file, rawFormat = "text", options = {}) {
  const format = rawFormat === "jsonl" ? "jsonl" : rawFormat === "text" || rawFormat == null ? "text" : "";
  if (!format) throw diskError("bad_args", "export_session_file 的 format 只能是 text 或 jsonl");
  const requested = Number(options.maxBytes);
  const maxBytes = Math.max(
    16 * 1024,
    Math.min(
      SESSION_FILE_EXPORT_MAX_BYTES,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : SESSION_FILE_EXPORT_DEFAULT_BYTES,
    ),
  );
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw fsToDiskError(err, "导出");
  }
  if (!stat.isFile()) throw diskError("bad_args", "导出失败：不是普通文件");
  if (format === "jsonl" && stat.size > maxBytes) {
    throw diskError(
      "payload_too_large",
      "会话文件 " + formatBytes(stat.size) + "，超过 JSONL 导出上限 " + formatBytes(maxBytes) + "；请调大上限（最多 " + formatBytes(SESSION_FILE_EXPORT_MAX_BYTES) + "）",
    );
  }
  if (format === "text" && stat.size > SESSION_FILE_TEXT_READ_MAX_BYTES) {
    throw diskError(
      "payload_too_large",
      "会话文件 " + formatBytes(stat.size) + "，超过文本导出读取上限 " + formatBytes(SESSION_FILE_TEXT_READ_MAX_BYTES) + "；请改用 JSONL（上限 " + formatBytes(maxBytes) + "）",
    );
  }
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw fsToDiskError(err, "导出");
  }
  const parsed = parseSessionRaw(raw, { strict: true, action: "导出" });
  const text = format === "jsonl"
    ? raw
    : conversationTextFromEntries(buildActiveBranch(parsed.entries, { byId: parsed.byId, leafId: parsed.leafId }));
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) {
    throw diskError(
      "payload_too_large",
      "导出结果 " + formatBytes(bytes) + "，超过上限 " + formatBytes(maxBytes) + "；请调大 maxBytes（最多 " + formatBytes(SESSION_FILE_EXPORT_MAX_BYTES) + "）",
    );
  }
  return {
    ok: true,
    format,
    sessionId: String(parsed.header.id),
    sessionPath: file.replace(/\\/g, "/"),
    text,
    chars: text.length,
    bytes,
    totalBytes: stat.size,
    truncated: false,
  };
}

function forkSessionFileOnDisk(file, options = {}) {
  const { parsed } = readStrictFile(file, "分叉");
  const entryId = typeof options.entryId === "string" ? options.entryId.trim() : "";
  const rawPos = options.position;
  if (rawPos != null && rawPos !== "at" && rawPos !== "before") {
    throw diskError("bad_args", "fork_session_file 的 position 只能是 at 或 before");
  }
  const position = rawPos === "before" ? "before" : rawPos === "at" ? "at" : undefined;

  let targetEntry = null;
  let pathEntries;
  let allowEmptyBefore = false;
  if (entryId) {
    targetEntry = parsed.byId.get(entryId) || null;
    if (!targetEntry) throw diskError("not_found", "找不到分叉节点：" + entryId);
    if (position === "before") {
      allowEmptyBefore = true;
      pathEntries = targetEntry.parentId ? traceBranchToId(parsed.byId, targetEntry.parentId) : [];
    } else {
      pathEntries = traceBranchToId(parsed.byId, targetEntry.id);
    }
  } else {
    pathEntries = buildActiveBranch(parsed.entries, { byId: parsed.byId, leafId: parsed.leafId });
  }

  const isMessageEntry = (e) => e && e.type === "message" && e.message && (e.message.role === "user" || e.message.role === "assistant");
  if (!allowEmptyBefore) {
    if (!pathEntries.length) {
      const anyMessage = parsed.entries.some(isMessageEntry);
      if (!anyMessage) throw diskError("bad_args", "这个会话还没有用户/助手消息，没有可分叉的分支");
      throw diskError("bad_args", "这个会话没有活动分支");
    }
    if (!pathEntries.some(isMessageEntry)) {
      throw diskError("bad_args", "这个会话还没有用户/助手消息，没有可分叉的分支");
    }
  }

  const kept = [];
  const replacementByLabelId = new Map();
  const pendingLabelIds = [];
  let lastId = null;
  for (const entry of pathEntries) {
    if (entry.type === "label") {
      if (typeof entry.id === "string" && entry.id) pendingLabelIds.push(entry.id);
      continue;
    }
    if (typeof entry.id === "string" && entry.id) {
      for (const lid of pendingLabelIds) replacementByLabelId.set(lid, entry.id);
      lastId = entry.id;
    }
    pendingLabelIds.length = 0;
    kept.push(entry);
  }
  const pathIds = new Set(kept.map((e) => e.id).filter(Boolean));
  const extraLabels = [];
  let labelParent = lastId;
  for (const [targetId, label] of parsed.labels) {
    if (!pathIds.has(targetId)) continue;
    let lid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    while (pathIds.has(lid)) lid = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    pathIds.add(lid);
    extraLabels.push({
      type: "label",
      id: lid,
      parentId: labelParent,
      timestamp: label.timestamp || new Date().toISOString(),
      targetId,
      label: label.label,
    });
    labelParent = lid;
  }

  const newId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const fileName = timestamp.replace(/[:.]/g, "-") + "_" + newId + ".jsonl";
  const newFile = path.join(path.dirname(file), fileName);
  const cwd = String(parsed.header.cwd || options.cwd || process.cwd());
  const header = {
    type: "session",
    version: Number(parsed.header.version) || 3,
    id: newId,
    timestamp,
    cwd,
    parentSession: file,
  };

  let outFd = null;
  let created = false;
  try {
    outFd = fs.openSync(newFile, "wx");
    created = true;
    writeAllSync(outFd, JSON.stringify(header) + "\n");
    let nextParent = null;
    for (const entry of kept) {
      const copy = { ...entry, parentId: nextParent };
      if (entry.type === "compaction") {
        if (entry.firstKeptEntryId === entry.id) copy.firstKeptEntryId = entry.id;
        else copy.firstKeptEntryId = replacementByLabelId.get(String(entry.firstKeptEntryId)) || entry.firstKeptEntryId;
      }
      writeAllSync(outFd, JSON.stringify(copy) + "\n");
      if (typeof entry.id === "string" && entry.id) nextParent = entry.id;
    }
    for (const label of extraLabels) writeAllSync(outFd, JSON.stringify(label) + "\n");
    try { fs.fsyncSync(outFd); } catch {}
  } catch (err) {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch {} outFd = null; }
    if (created) { try { fs.unlinkSync(newFile); } catch {} }
    throw fsToDiskError(err, "写入新会话");
  } finally {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch {} }
  }

  const archive = readArchive(newFile);
  const session = manifestRow(archive);
  let forkText = null;
  if (position === "before" && targetEntry && targetEntry.type === "message" && targetEntry.message && targetEntry.message.role === "user") {
    forkText = plainTextOf(targetEntry.message).trim() || null;
  }
  return {
    ok: true,
    id: newId,
    sessionPath: newFile.replace(/\\/g, "/"),
    parentSession: file.replace(/\\/g, "/"),
    cwd,
    name: archive.name || null,
    firstMessage: archive.firstMessage || null,
    session,
    archive,
    ...(forkText ? { text: forkText } : {}),
  };
}

function listSessionFiles(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const abs = path.join(root, dir.name);
    let names = [];
    try {
      names = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(".jsonl")) out.push(path.join(abs, name));
    }
  }
  return out;
}

function defaultSessionRoot(home = process.env.HOME || process.env.USERPROFILE || "") {
  return path.join(home, ".pi", "agent", "sessions");
}

/** 清单行：给 session_manifest 用，不含正文。 */
function manifestRow(archive) {
  return {
    id: archive.id,
    path: archive.path,
    cwd: archive.cwd,
    name: archive.name,
    firstMessage: archive.firstMessage,
    messageCount: archive.messageCount,
    sizeBytes: archive.sizeBytes,
    createdAt: archive.createdAt,
    updatedAt: archive.updatedAt,
    parentSession: archive.parentSession,
    active: false,
  };
}

module.exports = {
  TEXT_BUDGET,
  readArchive,
  listSessionFiles,
  defaultSessionRoot,
  manifestRow,
  renameSessionFileOnDisk,
  exportSessionFileOnDisk,
  forkSessionFileOnDisk,
};
