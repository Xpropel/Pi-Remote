// P12 评审扩展面修复的回归用例（extension/pi-remote-sync.ts）：
//   中-1 取消打断等待中的待发消息后不得再注入
//   中-2 follow_up 送达确认：忙时不按 10 分钟墙钟误杀，空闲且超时未消费才失败
//   低-1 usage 扫描按文件流式解析，不再整文件 readFileSync
//   低-2 256KB~320KB 小会话文件头+尾已读全，不再误标 truncated
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

process.env.PI_REMOTE_LOG = path.join(os.tmpdir(), "pi-remote-extension-review-fixes-test.log");
process.env.PI_REMOTE_TOKEN = "";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname);

/** 最小 Bridge：连上房间 r1，pi.sendUserMessage 只记账不真跑模型。 */
function makeBridge({ idle = false, abort } = {}) {
  const sent = [];
  const delivered = [];
  const bridge = new ext.Bridge();
  bridge.connected = true;
  bridge.roomId = "r1";
  bridge.ws = { bufferedAmount: 0, send: (s) => sent.push(JSON.parse(s)), close() {} };
  bridge.pi = {
    sendUserMessage: (content, opts) => {
      delivered.push({ content, opts });
      return Promise.resolve();
    },
  };
  let isIdle = idle;
  bridge.ctx = {
    isIdle: () => isIdle,
    model: { id: "m" },
    hasPendingMessages: () => false,
    abort: abort || (() => { isIdle = true; return Promise.resolve(); }),
  };
  return { bridge, sent, delivered, setIdle: (value) => { isIdle = value; } };
}

const events = (sent, type) => sent.filter((f) => f.type === "event" && f.event.type === type).map((f) => f.event);
const failed = (sent) => events(sent, "remote_message_failed");

/* ---------- 中-1：取消打断等待中的待发消息 ---------- */

test("中-1：打断等待期间取消，等待结束后绝不注入；取消后旧引用也注入不了", async () => {
  let releaseAbort;
  const { bridge, delivered, setIdle } = makeBridge({
    idle: false,
    abort: () => new Promise((resolve) => { releaseAbort = resolve; }),
  });
  try {
    const item = bridge.enqueueRemoteMessage("steer", "取消我", [], "c-cancel");
    const sending = bridge.cmdQueueSend({ id: item.id });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bridge.remoteQueueInterrupting, true, "已进入打断等待窗口");
    assert.equal(bridge.remoteQueue.length, 1);

    const cancelled = bridge.cmdQueueCancel({ id: item.id });
    assert.equal(cancelled.ok, true);
    assert.equal(bridge.remoteQueue.length, 0, "取消先从队列移除");
    assert.equal(item.canceled, true, "内部终态标记：等待者能认出已取消");

    // 模拟打断完成：pi 空闲；若旧代码会继续把这条已取消的消息注入。
    setIdle(true);
    releaseAbort();
    const result = await sending;
    assert.equal(delivered.length, 0, "取消了的消息不能被发出");
    assert.equal(result.ok, true);
    assert.equal(result.canceled, true, "按取消成功收尾，不报误导性的发送失败");
    assert.equal(bridge.remoteQueueInterrupting, false, "打断标志已复位");

    // 防御：即便有人握着取消时的旧对象引用直接调注入，也必须被队列/状态复查拦下。
    bridge.injectRemoteQueueItem(item, true);
    assert.equal(delivered.length, 0);
  } finally {
    if (releaseAbort) releaseAbort();
    bridge.clearTimers();
  }
});

test("中-1：打断等待期间没有取消仍照常注入（回归正常立即发送）", async () => {
  const { bridge, delivered } = makeBridge({ idle: false });
  try {
    const item = bridge.enqueueRemoteMessage("steer", "立即发", [], "c-ok");
    const result = await bridge.cmdQueueSend({ id: item.id });
    assert.equal(result.ok, true);
    assert.equal(result.item.status, "injected");
    assert.deepEqual(delivered.map((d) => d.opts), [{ deliverAs: "steer" }]);
  } finally {
    bridge.clearTimers();
  }
});

/* ---------- 中-2：follow_up 送达确认不再按墙钟误杀长回合 ---------- */

test("中-2：pi 仍忙时超过 10 分钟继续续等，消息随后被消费即确认送达、不翻失败", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { bridge, sent } = makeBridge({ idle: false });
  try {
    bridge.watchDelivery("长回合里的消息", "c-long");
    // 10 分钟 + 15s：旧实现会在 10 分钟检查点把仍在忙的消息判 timeout。
    t.mock.timers.tick(10 * 60 * 1000 + 15000);
    assert.equal(bridge.pendingDeliveries.length, 1, "还在忙：必须继续等");
    assert.equal(failed(sent).length, 0, "忙时不许按墙钟报送达失败");

    // 长回合结束，pi 消费了这条消息：按正常送达结案，而不是先前的失败。
    bridge.trackDelivery({ type: "message_start", message: { role: "user", content: "长回合里的消息" } });
    assert.equal(bridge.pendingDeliveries.length, 0);
    assert.deepEqual(events(sent, "remote_message_delivered").map((e) => e.cid), ["c-long"]);
    assert.equal(failed(sent).length, 0);
  } finally {
    for (const p of bridge.pendingDeliveries.splice(0)) clearTimeout(p.timer);
  }
});

test("中-2：pi 已空闲且超过总等待仍未消费，才判 timeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { bridge, sent, setIdle } = makeBridge({ idle: false });
  try {
    bridge.watchDelivery("久等未消费", "c-idle");
    t.mock.timers.tick(10 * 60 * 1000);
    assert.equal(bridge.pendingDeliveries.length, 1, "忙时超 10 分钟不判失败");

    setIdle(true);
    t.mock.timers.tick(15000);
    assert.equal(bridge.pendingDeliveries.length, 0, "空闲且总等待超限：判失败收尾");
    const timeouts = failed(sent).filter((e) => e.cid === "c-idle");
    assert.equal(timeouts.length, 1);
    assert.equal(timeouts[0].code, "timeout");
  } finally {
    for (const p of bridge.pendingDeliveries.splice(0)) clearTimeout(p.timer);
  }
});

/* ---------- 低-1：usage 扫描流式读文件 ---------- */

const SESSION_DAY = Date.UTC(2026, 9, 20, 12, 0, 0);
const msg = (role, ts, opts = {}) => ({
  type: "message",
  id: opts.id ?? `m-${Math.random().toString(36).slice(2)}`,
  timestamp: new Date(ts).toISOString(),
  message: {
    role,
    timestamp: ts,
    ...(role === "assistant" ? { provider: opts.provider ?? "stepfun", model: opts.model ?? "step-5-preview" } : null),
    ...(opts.usage ? { usage: opts.usage } : null),
  },
});
const usageOf = (totalTokens) => ({ input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens });
const sessionRow = () => ({ type: "session", version: 3, id: "s-test", timestamp: new Date(SESSION_DAY).toISOString(), cwd: "/tmp/project" });

test("低-1：usage 扫描逐文件流式解析，不再 readFileSync 整份 .jsonl", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-stream-"));
  const write = (name, rows, trailingNewline = true) => {
    const dir = path.join(root, "--proj--");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.jsonl`), rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + (trailingNewline ? "\n" : ""), "utf8");
  };
  try {
    write("a", [sessionRow(), msg("user", SESSION_DAY), msg("assistant", SESSION_DAY + 1000, { usage: usageOf(100) })]);
    // 末行没有换行：流式解析也必须照常吃到最后一行
    write("b", [sessionRow(), msg("assistant", SESSION_DAY + 2000, { usage: usageOf(50) })], false);
    write("c", [sessionRow(), "{not json", msg("user", SESSION_DAY + 3000)]);

    const original = fs.readFileSync;
    let jsonlReads = 0;
    fs.readFileSync = function (file, ...args) {
      if (typeof file === "string" && file.endsWith(".jsonl")) {
        jsonlReads += 1;
        throw new Error("usage 扫描不应整文件 readFileSync：" + file);
      }
      return original.call(fs, file, ...args);
    };
    try {
      const { snapshot, diagnostics } = await ext.usageScanSnapshot({
        sessionRoot: root,
        cachePath: path.join(root, "cache.json"),
        useCache: false,
        now: SESSION_DAY + 3 * 86_400_000,
      });
      assert.equal(jsonlReads, 0, "会话文件只许流式读");
      assert.equal(diagnostics.parsedFiles, 3);
      assert.equal(diagnostics.errors, 1, "坏行仍计 errors");
      assert.equal(snapshot.summary.totals.tokens, 150);
      assert.equal(snapshot.summary.totals.messagesUser, 2);
      assert.equal(snapshot.summary.totals.messagesAssistant, 2);
      assert.equal(snapshot.summary.totals.sessions, 3);
    } finally {
      fs.readFileSync = original;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("低-1 补充：超出单文件上限被跳过时 coverage.truncated 必须为 true，不再静默漏整份会话", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-oversize-"));
  const dir = path.join(root, "--proj--");
  fs.mkdirSync(dir, { recursive: true });
  const lines = (name, rows) => fs.writeFileSync(
    path.join(dir, `${name}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  try {
    lines("small", [sessionRow(), msg("user", SESSION_DAY), msg("assistant", SESSION_DAY + 1000, { usage: usageOf(100) })]);
    // 超过测试指定的单文件上限（4096B）：内容本身合法，但扫描器应保持“跳过 + 诚实标截断”。
    lines("big", [sessionRow(), msg("assistant", SESSION_DAY + 2000, { usage: usageOf(999) })]);
    fs.appendFileSync(path.join(dir, "big.jsonl"), "x".repeat(4096));

    const { snapshot, diagnostics } = await ext.usageScanSnapshot({
      sessionRoot: root,
      cachePath: path.join(root, "cache.json"),
      useCache: false,
      maxFileBytes: 4096,
      now: SESSION_DAY + 86_400_000,
    });
    assert.equal(diagnostics.files, 2);
    assert.equal(diagnostics.parsedFiles, 1, "只解析未超限的那个文件");
    assert.equal(diagnostics.skippedFiles, 1, "超大会话文件被跳过");
    assert.equal(diagnostics.truncated, true);
    assert.equal(snapshot.coverage.files, 2);
    assert.equal(snapshot.coverage.skippedFiles, 1);
    assert.equal(snapshot.coverage.truncated, true, "漏掉整份会话必须标截断，不能静默");
    assert.equal(snapshot.summary.totals.tokens, 100, "被跳过的文件不贡献计数（扫描口径不变）");
    assert.equal(snapshot.summary.totals.sessions, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("顺带加固：usage 遍历上限只在真有多余 .jsonl 时标 truncated，不被同目录日志误标", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-walk-"));
  const dir = path.join(root, "--proj--");
  fs.mkdirSync(dir, { recursive: true });
  const writeSession = (name) => fs.writeFileSync(
    path.join(dir, `${name}.jsonl`),
    JSON.stringify({ type: "session", id: name, timestamp: new Date(SESSION_DAY).toISOString() }) + "\n" + JSON.stringify(msg("user", SESSION_DAY)) + "\n",
    "utf8",
  );
  try {
    writeSession("a");
    writeSession("b");
    fs.writeFileSync(path.join(dir, "zzz.log"), "not a session\n", "utf8");

    // readdir 顺序在文件系统间不保证：固定成 a,b,zzz.log，确保旧实现会在 zzz.log 处误标。
    const original = fs.readdirSync;
    fs.readdirSync = function (target, options) {
      const out = original.call(fs, target, options);
      if (Array.isArray(out) && out.every((e) => e && typeof e.name === "string")) {
        return out.slice().sort((x, y) => x.name.localeCompare(y.name));
      }
      return out;
    };
    try {
      const first = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), useCache: false, now: SESSION_DAY + 86_400_000, maxFiles: 2 });
      assert.equal(first.snapshot.coverage.files, 2);
      assert.equal(first.snapshot.coverage.truncated, false, "恰好 2 个会话文件 + 1 个日志：没有会话被漏掉，不许标截断");

      writeSession("c");
      const second = await ext.usageScanSnapshot({ sessionRoot: root, cachePath: path.join(root, "c.json"), useCache: false, now: SESSION_DAY + 86_400_000, maxFiles: 2 });
      assert.equal(second.snapshot.coverage.files, 2);
      assert.equal(second.snapshot.coverage.truncated, true, "真有第 3 个会话文件没装下：必须诚实标截断");
    } finally {
      fs.readdirSync = original;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ---------- 低-2：小会话文件 truncated 误标 ---------- */

function sessionFile(dir, name, targetBytes, nameLine) {
  const lines = [JSON.stringify({ type: "session", id: "small-1", timestamp: new Date(SESSION_DAY).toISOString(), cwd: "/w" })];
  let size = Buffer.byteLength(lines[0], "utf8") + 1;
  let messageCount = 0;
  while (size < targetBytes - (nameLine ? 4096 : 0)) {
    const line = JSON.stringify({ type: "message", id: `m${++messageCount}`, timestamp: new Date(SESSION_DAY + messageCount).toISOString(), message: { role: "user", content: "x".repeat(1000) } });
    lines.push(line);
    size += Buffer.byteLength(line, "utf8") + 1;
  }
  if (nameLine) lines.push(JSON.stringify({ type: "session_info", name: nameLine }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { file, messageCount };
}

test("低-2：256KB~320KB 小会话文件头+尾整份读完，truncated 不误标；真跳过中段才标", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-truncated-"));
  const bridge = new ext.Bridge();
  try {
    // 头 256KB + 尾 64KB 覆盖整份文件：没有中间段被跳过 → 不是截断，且尾部的名字能读到。
    const small = sessionFile(dir, "small.jsonl", 300 * 1024, "小会话名字");
    const smallStat = fs.statSync(small.file);
    assert.ok(smallStat.size > 256 * 1024 && smallStat.size <= 256 * 1024 + 64 * 1024, "夹具：落在头+尾全覆盖区间");
    const row = bridge.parseSessionFile(small.file, null);
    assert.equal(row.truncated, false, "整份已读完，不许误标 truncated");
    assert.equal(row.name, "小会话名字", "尾部 session_info 仍读到");
    assert.equal(row.messageCount, small.messageCount, "跨 256KB 边界的行也不能丢");

    // 超过头+尾（320KB）才真的漏掉中段 → truncated: true。
    const big = sessionFile(dir, "big.jsonl", 400 * 1024, null);
    assert.ok(fs.statSync(big.file).size > 256 * 1024 + 64 * 1024);
    assert.equal(bridge.parseSessionFile(big.file, null).truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
