"use strict";
/**
 * 读取本机 pi 会话目录（~/.pi/agent/sessions），整理成可放进单帧的正文摘要。
 * 不启动 pi。只保留用户/助手的可见文字；思考、工具原文和图片不进帧。
 * 超预算时留下较新的消息，并标明前面省略了多少条。
 */
const fs = require("node:fs");
const path = require("node:path");

const TEXT_BUDGET = 140_000;
const PER_MESSAGE = 8_000;

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

function readArchive(file, opts = {}) {
  const budget = opts.textBudget || TEXT_BUDGET;
  const perMessage = opts.perMessage || PER_MESSAGE;
  const raw = fs.readFileSync(file, "utf8");
  const stat = fs.statSync(file);
  let header = null;
  let name = "";
  const messages = [];
  for (const line of raw.split(/\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session") header = entry;
    else if (entry.type === "session_info" && entry.name) name = String(entry.name).trim();
    else if (entry.type === "message" && entry.message) {
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
  }
  let used = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const next = messages[i].text.length;
    if (used + next > budget && start < messages.length) break;
    used += next;
    start = i;
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
};
