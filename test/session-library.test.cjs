const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readArchive, listSessionFiles, manifestRow } = require("../deploy/session-library.cjs");
const { sanitizeArchive } = require("../relay/sessionArchive.js");

test("会话文件：读出用户和助手正文，跳过思考，超预算留下较新的", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-"));
  const file = path.join(dir, "s.jsonl");
  const lines = [
    JSON.stringify({ type: "session", id: "sess-1", timestamp: 10, cwd: "/work/app" }),
    JSON.stringify({ type: "session_info", name: "整理日志" }),
    JSON.stringify({
      type: "message",
      id: "u1",
      timestamp: 11,
      message: { role: "user", content: [{ type: "text", text: "先看目录" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "a1",
      timestamp: 12,
      message: { role: "assistant", content: [{ type: "thinking", text: "内部思考" }, { type: "text", text: "目录里有三个文件" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "u2",
      timestamp: 13,
      message: { role: "user", content: [{ type: "text", text: "很长".repeat(50) }] },
    }),
  ];
  fs.writeFileSync(file, lines.join("\n"));
  const full = readArchive(file);
  assert.equal(full.id, "sess-1");
  assert.equal(full.cwd, "/work/app");
  assert.equal(full.name, "整理日志");
  assert.equal(full.firstMessage, "先看目录");
  assert.equal(full.messages.length, 3);
  assert.equal(full.messages[1].text, "目录里有三个文件");
  assert.equal(full.truncated, false);

  const capped = readArchive(file, { textBudget: 40, perMessage: 100 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.omitted >= 1);
  assert.equal(capped.messages[capped.messages.length - 1].role, "user");
  const row = manifestRow(full);
  assert.equal(row.active, false);
  assert.equal(row.messageCount, 3);
  assert.equal("messages" in row, false);
});

test("会话目录：只收集子目录里的 jsonl", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-root-"));
  const child = path.join(root, "--work--");
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, "a.jsonl"), "");
  fs.writeFileSync(path.join(child, "note.txt"), "");
  fs.writeFileSync(path.join(root, "loose.jsonl"), "");
  const files = listSessionFiles(root);
  assert.deepEqual(files, [path.join(child, "a.jsonl")]);
});

test("中转净化：丢掉非法角色，超大正文不收下", () => {
  const ok = sanitizeArchive({
    id: "s1",
    messages: [
      { role: "user", text: "你好", timestamp: 1 },
      { role: "toolResult", text: "不要" },
      { role: "assistant", text: "  " },
    ],
  });
  assert.equal(ok.messages.length, 1);
  assert.equal(ok.messages[0].text, "你好");
  const clipped = sanitizeArchive({ id: "s2", messages: [{ role: "user", text: "x".repeat(9000) }] });
  assert.equal(clipped.messages[0].text.length, 8000);
  const huge = sanitizeArchive({
    id: "s3",
    messages: Array.from({ length: 40 }, (_, i) => ({ role: "user", text: "x".repeat(8000), id: String(i) })),
  });
  assert.equal(huge, null);
});
