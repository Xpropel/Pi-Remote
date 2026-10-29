// 扩展的窗口门控、room_register 设备字段、session_manifest、resend_snapshot。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const logFile = path.join(os.tmpdir(), "pi-remote-local-device-test.log");
process.env.PI_REMOTE_LOG = logFile;
process.env.PI_REMOTE_TOKEN = "";
delete process.env.PI_REMOTE_DEVICE_ID;
delete process.env.PI_REMOTE_ACCOUNT;
delete process.env.PI_REMOTE_DEVICE_NAME;
delete process.env.PI_REMOTE_PROJECTS;
delete process.env.PI_REMOTE_ALWAYS_ONLINE;
delete process.env.PI_REMOTE_ATTACH_FILE;

const jiti = createJiti(import.meta.url, { interopDefault: false });
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname);

function fakeWs(sent) {
  return {
    bufferedAmount: 0,
    send(s) {
      sent.push(JSON.parse(s));
    },
    close() {},
  };
}

function silence(bridge) {
  for (const key of ["syncTimer", "manifestTimer", "probeTimer", "reconnectTimer", "coalesceTimer"]) {
    if (bridge[key]) clearTimeout(bridge[key]);
    bridge[key] = null;
  }
}

test("deviceIdentity：account 缺省 admin，有 deviceId 才带上", () => {
  delete process.env.PI_REMOTE_ACCOUNT;
  delete process.env.PI_REMOTE_DEVICE_ID;
  delete process.env.PI_REMOTE_DEVICE_NAME;
  const bare = ext.deviceIdentity(process.env, "win32");
  assert.equal(bare.accountId, "admin");
  assert.equal(bare.deviceId, "");
  assert.equal(bare.deviceName, "Windows");
  assert.equal(bare.platform, "windows");
  assert.deepEqual(
    [ext.deviceIdentity(process.env, "darwin"), ext.deviceIdentity(process.env, "linux")].map((idn) => [idn.platform, idn.deviceName]),
    [["macos", "Mac"], ["linux", "Linux"]],
  );
  process.env.PI_REMOTE_ACCOUNT = "";
  process.env.PI_REMOTE_DEVICE_ID = "dev-9";
  process.env.PI_REMOTE_DEVICE_NAME = "台式";
  const named = ext.deviceIdentity(process.env, "darwin");
  assert.equal(named.accountId, "admin");
  assert.equal(named.deviceId, "dev-9");
  assert.equal(named.deviceName, "台式");
  assert.equal(named.platform, "macos");
  delete process.env.PI_REMOTE_DEVICE_ID;
  delete process.env.PI_REMOTE_DEVICE_NAME;
});

test("平台标识与 attach 的 device_register 一致；路径大小写规则按平台", async () => {
  const require = (await import("node:module")).createRequire(import.meta.url);
  const attach = require("../deploy/attach.cjs");
  for (const platform of ["win32", "darwin", "linux", "freebsd"]) {
    assert.equal(ext.platformId(platform), attach.platformId(platform), platform);
    assert.equal(ext.defaultDeviceName(platform), attach.defaultDeviceName(platform), platform);
  }
  assert.equal(ext.samePath("D:\\Work\\a.jsonl", "d:/work/a.jsonl", "win32"), true);
  assert.equal(ext.samePath("/Users/user/s.jsonl", "/users/user/s.jsonl", "darwin"), true);
  assert.equal(ext.samePath("/home/A/s.jsonl", "/home/a/s.jsonl", "linux"), false);
});

test("evaluateAttachWindow：缺文件、坏 JSON、过期、设备不符都关闭；ALWAYS_ONLINE 放行", () => {
  const env = { PI_REMOTE_DEVICE_ID: "dev-1" };
  const now = 5_000;
  assert.deepEqual(ext.evaluateAttachWindow(null, env, now), { ok: false, reason: "missing" });
  assert.equal(ext.evaluateAttachWindow("{", env, now).reason, "parse");
  assert.equal(ext.evaluateAttachWindow(JSON.stringify({ deviceId: "dev-1", expiresAt: now - 1 }), env, now).reason, "expired");
  assert.equal(ext.evaluateAttachWindow(JSON.stringify({ deviceId: "other", expiresAt: now + 10 }), env, now).reason, "device");
  assert.equal(ext.evaluateAttachWindow(JSON.stringify({ deviceId: "dev-1", expiresAt: now + 10 }), { PI_REMOTE_DEVICE_ID: "" }, now).reason, "device");
  const open = ext.evaluateAttachWindow(JSON.stringify({ deviceId: "dev-1", expiresAt: now }), env, now);
  assert.equal(open.ok, true);
  assert.equal(open.reason, "open");
  assert.equal(ext.evaluateAttachWindow(null, { PI_REMOTE_ALWAYS_ONLINE: "1" }, now).ok, true);
});

test("normalizeSessionEntry：SessionManager.list 的 Date 时间要转成毫秒，不能落成 0", () => {
  // pi 的 SessionManager.list 返回 { created: Date, modified: Date }。以前 toEpoch 只认
  // number/string，真机上所有会话的 updatedAt/createdAt 都是 0，清单排序和“最近会话”全失效。
  const row = ext.normalizeSessionEntry(
    {
      id: "abc",
      path: "/tmp/does-not-exist/abc.jsonl",
      cwd: "/Users/user/work",
      created: new Date("2026-10-21T13:42:33.417Z"),
      modified: new Date("2026-10-21T13:43:36.025Z"),
      messageCount: 3,
    },
    "/Users/user/work",
  );
  assert.equal(row.createdAt, Date.parse("2026-10-21T13:42:33.417Z"));
  assert.equal(row.updatedAt, Date.parse("2026-10-21T13:43:36.025Z"));
  // 字符串和秒级时间戳的老路径不能回归
  assert.equal(ext.normalizeSessionEntry({ id: "s", created: "2026-10-21T00:00:00Z" }, "/x").createdAt, Date.parse("2026-10-21T00:00:00Z"));
  assert.equal(ext.normalizeSessionEntry({ id: "n", updatedAt: 1792590000 }, "/x").updatedAt, 1792590000000);
});

test("fork 谱系（R3-3）：normalizeSessionEntry 透传 parentSession（双口径），清单帧带字段", () => {
  // SessionManager.list 口径：parentSessionPath
  const fromList = ext.normalizeSessionEntry(
    { id: "kid", path: "/tmp/x/kid.jsonl", cwd: "/w", parentSessionPath: "C:\\s\\parent.jsonl", messageCount: 1 },
    "/w",
  );
  assert.equal(fromList.parentSession, "C:/s/parent.jsonl");
  // 文件头/清单行口径：parentSession
  const fromHeader = ext.normalizeSessionEntry(
    { id: "kid2", path: "/tmp/x/kid2.jsonl", cwd: "/w", parentSession: "/s/parent.jsonl", messageCount: 1 },
    "/w",
  );
  assert.equal(fromHeader.parentSession, "/s/parent.jsonl");
  // 非 fork 会话：null，不编造
  assert.equal(ext.normalizeSessionEntry({ id: "solo", path: "/tmp/x/s.jsonl" }, "/w").parentSession, null);
  // 清单帧行带字段
  const frame = ext.buildSessionManifest({
    deviceId: "dev-1",
    sessions: [
      { id: "kid", path: "/tmp/x/kid.jsonl", cwd: "/w", parentSession: "/s/parent.jsonl", updatedAt: 2, messageCount: 1 },
      { id: "solo", path: "/tmp/x/s.jsonl", cwd: "/w", updatedAt: 1, messageCount: 1 },
    ],
    activeId: "",
    full: true,
    now: 3,
  });
  assert.equal(frame.sessions.find((s) => s.id === "kid").parentSession, "/s/parent.jsonl");
  assert.equal(frame.sessions.find((s) => s.id === "solo").parentSession, null);
});

test("buildSessionManifest：全量按 updatedAt 倒序，超过 200 截断，活动位只打在当前会话", () => {
  const sessions = Array.from({ length: 201 }, (_, i) => ({
    id: "s" + i,
    path: "C:/s/" + i + ".jsonl",
    name: i === 200 ? "当前" : null,
    cwd: "D:/work/app",
    firstMessage: "hello",
    messageCount: i,
    sizeBytes: 8,
    createdAt: 1,
    updatedAt: i + 1,
  }));
  const frame = ext.buildSessionManifest({
    accountId: "",
    deviceId: "dev-1",
    sessions,
    activeId: "s200",
    full: true,
    removed: ["gone"],
    now: 50,
    maxBatch: ext.MAX_MANIFEST_BATCH,
  });
  assert.equal(frame.accountId, "admin");
  assert.equal(frame.deviceId, "dev-1");
  assert.equal(frame.full, true);
  assert.equal(frame.updatedAt, 50);
  assert.equal(frame.truncated, true);
  assert.equal(frame.sessions.length, 200);
  assert.equal(frame.sessions[0].id, "s200");
  assert.equal(frame.sessions[0].active, true);
  assert.equal(frame.sessions[1].active, false);
  assert.equal(frame.sessions[199].id, "s1");
  assert.deepEqual(frame.removed, ["gone"]);
  const body = "正文".repeat(400);
  const preview = ext.buildSessionManifest({
    deviceId: "dev-1",
    sessions: [{ id: "s", firstMessage: body, updatedAt: 2, messageCount: 9 }],
    activeId: "s",
    full: true,
    now: 3,
  });
  assert.equal(preview.sessions[0].firstMessage.length, 200);
  assert.equal(preview.sessions[0].firstMessage, body.slice(0, 200));
  assert.equal(JSON.stringify(preview).includes(body), false);
  const exact = ext.buildSessionManifest({
    deviceId: "dev-1",
    sessions: sessions.slice(1),
    activeId: "s200",
    full: true,
    now: 1,
  });
  assert.equal(exact.truncated, undefined);
  assert.equal(exact.sessions.length, 200);
});

test("sessionId 从文件头读取，失败时用文件名里最后一个下划线后的 id", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sid-"));
  const file = path.join(dir, "2026-01-01T00-00-00-000Z_01a11921-ca94-71eb-acbb-d943e7096fd1.jsonl");
  fs.writeFileSync(file, '{"type":"session","id":"01a11921-ca94-71eb-acbb-d943e7096fd1","cwd":"D:\\\\work"}\n{"type":"message"}\n', "utf8");
  assert.equal(ext.sessionIdFromFile(file), "01a11921-ca94-71eb-acbb-d943e7096fd1");
  assert.equal(ext.sessionIdFromPath(file), "01a11921-ca94-71eb-acbb-d943e7096fd1");
  assert.equal(ext.sessionIdFromPath("C:/sessions/plain.jsonl"), "plain");
});

test("连上后 room_register 带账户和设备，第一次绑定发全量清单，换会话发增量", async () => {
  process.env.PI_REMOTE_DEVICE_ID = "dev-1";
  delete process.env.PI_REMOTE_ACCOUNT;
  delete process.env.PI_REMOTE_DEVICE_NAME;
  delete process.env.PI_REMOTE_PROJECTS;
  const sent = [];
  const bridge = new ext.Bridge();
  bridge.platform = "win32";
  bridge.connected = true;
  bridge.authed = true; // sends are gated on auth_result ok; simulate an authenticated connection
  bridge.ws = fakeWs(sent);
  bridge.sessionLister = async () => [
    { id: "B", path: "C:/B.jsonl", name: "旧名", firstMessage: "a", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-02T00:00:00.000Z", messageCount: 2, size: 11, deleted: false },
    { id: "C", path: "C:/C.jsonl", name: "新", firstMessage: "b", created: "2026-01-01T00:00:00.000Z", modified: "2026-01-03T00:00:00.000Z", messageCount: 5, sizeBytes: 22 },
    { id: "gone", path: "C:/gone.jsonl", modified: Date.now(), deleted: true, messageCount: 1 },
  ];
  try {
    bridge.bindSession({
      cwd: "D:\\work\\app",
      sessionManager: {
        sessionId: "B",
        cwd: "D:\\work\\app",
        getSessionName() {
          return "清单名";
        },
        getBranch() {
          return [];
        },
      },
    });
    silence(bridge);
    await bridge.flushManifest();
    const reg = sent.find((frame) => frame.type === "room_register");
    assert.equal(reg.room.accountId, "admin");
    assert.equal(reg.room.deviceId, "dev-1");
    assert.equal(reg.room.deviceName, "Windows");
    assert.equal(reg.room.platform, "windows");
    assert.equal(reg.room.id, "B");
    const full = sent.find((frame) => frame.type === "session_manifest");
    assert.equal(full.full, true);
    assert.equal(full.accountId, "admin");
    assert.equal(full.deviceId, "dev-1");
    assert.deepEqual(full.sessions.map((row) => row.id), ["C", "B"]);
    assert.equal(full.sessions.find((row) => row.id === "B").active, true);
    assert.equal(full.sessions.find((row) => row.id === "B").name, "清单名");
    assert.equal(full.sessions.find((row) => row.id === "C").active, false);
    assert.equal(full.sessions.find((row) => row.id === "B").messageCount, 2);
    assert.equal(full.sessions.find((row) => row.id === "B").sizeBytes, 11);
    assert.equal(full.sessions.find((row) => row.id === "B").createdAt, Date.parse("2026-01-01T00:00:00.000Z"));
    assert.equal(full.sessions.some((row) => row.id === "gone"), false);

    sent.length = 0;
    bridge.bindSession({
      cwd: "D:\\work\\app",
      sessionManager: {
        sessionId: "C",
        cwd: "D:\\work\\app",
        getSessionName() {
          return "新";
        },
        getBranch() {
          return [];
        },
      },
    });
    silence(bridge);
    await bridge.flushManifest();
    const delta = sent.find((frame) => frame.type === "session_manifest");
    assert.equal(delta.full, false);
    assert.equal(delta.sessions.find((row) => row.id === "C").active, true);
    assert.equal(delta.sessions.find((row) => row.id === "B").active, false);
    assert.ok(delta.sessions.find((row) => row.id === "C").updatedAt >= Date.parse("2026-01-03T00:00:00.000Z"));
    assert.ok(delta.sessions.find((row) => row.id === "B").updatedAt >= Date.parse("2026-01-02T00:00:00.000Z"));
  } finally {
    silence(bridge);
    delete process.env.PI_REMOTE_DEVICE_ID;
  }
});

test("删除发墓碑；agent_settled 60 秒内不重复上报", async () => {
  process.env.PI_REMOTE_DEVICE_ID = "dev-1";
  const sent = [];
  const bridge = new ext.Bridge();
  bridge.connected = true;
  bridge.authed = true;
  bridge.roomId = "live";
  bridge.cwd = "D:\\work\\app";
  bridge.ws = fakeWs(sent);
  bridge.sessionLister = async () => [];
  bridge.manifestArmed = true;
  try {
    bridge.enqueueManifest({ removed: ["dead-session"] });
    silence(bridge);
    await bridge.flushManifest();
    const tomb = sent.find((frame) => frame.type === "session_manifest");
    assert.equal(tomb.full, false);
    assert.deepEqual(tomb.removed, ["dead-session"]);

    sent.length = 0;
    bridge.noteManifestActivity();
    assert.equal(bridge.pendingManifest.activity, true);
    const stamped = bridge.lastActivityManifestAt;
    bridge.noteManifestActivity();
    assert.equal(bridge.lastActivityManifestAt, stamped);
    silence(bridge);
    bridge.lastActivityManifestAt = Date.now() - ext.MANIFEST_THROTTLE_MS - 5;
    bridge.noteManifestActivity();
    assert.ok(bridge.lastActivityManifestAt >= Date.now() - 1000);
    assert.equal(bridge.pendingManifest.activity, true);
  } finally {
    silence(bridge);
    delete process.env.PI_REMOTE_DEVICE_ID;
  }
});

test("resend_snapshot 立刻重推当前房间快照，房间不符则忽略", () => {
  const sent = [];
  const bridge = new ext.Bridge();
  bridge.roomId = "room-1";
  bridge.connected = true;
  bridge.authed = true;
  bridge.ws = fakeWs(sent);
  bridge.ctx = {
    sessionManager: {
      getBranch() {
        return [{ type: "message", message: { role: "user", content: "hi", timestamp: 1 } }];
      },
    },
  };
  bridge.handle({ type: "resend_snapshot", room: "room-1" });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].type, "snapshot");
  assert.equal(sent[0].room, "room-1");
  assert.equal(sent[0].messages.length, 1);
  // P1 §6：同一时刻补一份远程待发状态，relay 重启/缓存丢失后新观众也能恢复
  assert.equal(sent[1].type, "event");
  assert.equal(sent[1].event.type, "remote_queue_state");
  assert.deepEqual(sent[1].event.items, []);
  bridge.handle({ type: "resend_snapshot", room: "other" });
  assert.equal(sent.length, 2);
});

test("没有 deviceId 的 room_register 不带 deviceId，account 仍是 admin", () => {
  delete process.env.PI_REMOTE_DEVICE_ID;
  delete process.env.PI_REMOTE_ACCOUNT;
  const bridge = new ext.Bridge();
  bridge.platform = "win32";
  bridge.roomId = "abc";
  bridge.cwd = "D:\\work\\app";
  const room = bridge.roomPayload();
  assert.equal(room.accountId, "admin");
  assert.equal(room.platform, "windows");
  assert.equal(room.deviceName, "Windows");
  assert.equal("deviceId" in room, false);
  bridge.platform = "darwin";
  bridge.cwd = "/Users/user/CLI/Pi-Remote";
  const mac = bridge.roomPayload();
  assert.equal(mac.platform, "macos");
  assert.equal(mac.deviceName, "Mac");
  assert.equal(mac.label, process.env.PI_REMOTE_LABEL || "Pi-Remote", "没有会话名和 LABEL 时用目录名");
});

test("状态文件到期后即使还在磁盘上也会断开", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-expire-"));
  const file = path.join(dir, "remote-attach.json");
  process.env.PI_REMOTE_ATTACH_FILE = file;
  process.env.PI_REMOTE_DEVICE_ID = "dev-1";
  delete process.env.PI_REMOTE_ALWAYS_ONLINE;
  const bridge = new ext.Bridge();
  let connects = 0;
  bridge.connect = () => {
    connects += 1;
    bridge.connected = true;
    bridge.ws = { close() { bridge.connected = false; bridge.ws = null; } };
  };
  const expiresAt = Date.now() + 400;
  try {
    fs.writeFileSync(file, JSON.stringify({ deviceId: "dev-1", accountId: "admin", expiresAt }));
    bridge.armAttachWatch();
    bridge.evaluateGate("start");
    assert.equal(connects, 1);
    // 截止线 6.5s（R2-6 放宽 + 2026-10-22）：原 4s 短于产品 5s 兜底轮询周期，
    // 到期断开靠轮询发现时必然偶发超时——已裁决为纯时序 flake，只放宽时限，断言语义不变。
    const deadline = expiresAt + 6500;
    while (bridge.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(bridge.connected, false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(connects, 1);
  } finally {
    silence(bridge);
    bridge.stop();
    delete process.env.PI_REMOTE_ATTACH_FILE;
    delete process.env.PI_REMOTE_DEVICE_ID;
  }
});

test("握手完成时窗口已关则不发出认证", async () => {
  const orig = globalThis.WebSocket;
  let openGate = true;
  const sent = [];
  let closed = 0;
  globalThis.WebSocket = class {
    constructor() {
      openGate = false;
      queueMicrotask(() => {
        if (typeof this.onopen === "function") this.onopen();
      });
    }
    send(s) {
      sent.push(String(s));
    }
    close() {
      closed += 1;
    }
  };
  const bridge = new ext.Bridge();
  bridge.gateOpen = () => openGate;
  try {
    bridge.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, 0);
    assert.equal(bridge.connected, false);
    assert.ok(closed >= 1);
  } finally {
    globalThis.WebSocket = orig;
    silence(bridge);
    bridge.stop();
  }
});

test("窗口关闭时断开且不再重连；窗口打开才连接", () => {
  const bridge = new ext.Bridge();
  let connects = 0;
  bridge.connect = () => {
    connects += 1;
    bridge.ws = {};
    bridge.connected = true;
  };
  bridge.gateOpen = () => false;
  bridge.evaluateGate("test");
  assert.equal(connects, 0);
  bridge.gateOpen = () => true;
  bridge.connected = false;
  bridge.ws = null;
  bridge.evaluateGate("test");
  assert.equal(connects, 1);
  bridge.evaluateGate("test");
  assert.equal(connects, 1);
  let closed = 0;
  bridge.ws = {
    close() {
      closed += 1;
    },
  };
  bridge.connected = true;
  bridge.gateOpen = () => false;
  bridge.evaluateGate("test");
  assert.equal(closed, 1);
  assert.equal(bridge.connected, false);
  assert.equal(bridge.ws, null);
  bridge.scheduleReconnect();
  assert.equal(bridge.reconnectTimer, null);
});

test("状态文件出现后才连接，删除后立刻断开", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-gate-"));
  const file = path.join(dir, "remote-attach.json");
  process.env.PI_REMOTE_ATTACH_FILE = file;
  process.env.PI_REMOTE_DEVICE_ID = "dev-1";
  delete process.env.PI_REMOTE_ALWAYS_ONLINE;
  const bridge = new ext.Bridge();
  let connects = 0;
  bridge.connect = () => {
    connects += 1;
    bridge.connected = true;
    bridge.ws = {
      close() {
        bridge.connected = false;
      },
    };
  };
  try {
    bridge.armAttachWatch();
    bridge.evaluateGate("start");
    assert.equal(connects, 0);
    fs.writeFileSync(file, JSON.stringify({ deviceId: "dev-1", accountId: "admin", expiresAt: Date.now() + 60_000 }));
    // fs.watch 在 macOS 负载高时偶发晚于 2s：窗口放宽到 6s，避免把环境抖动当成回归
    const opened = Date.now() + 6000;
    while (connects < 1 && Date.now() < opened) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(connects, 1);
    fs.unlinkSync(file);
    const closedAt = Date.now() + 6000;
    while (bridge.connected && Date.now() < closedAt) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(bridge.connected, false);
    assert.equal(connects, 1);
  } finally {
    silence(bridge);
    bridge.stop();
    delete process.env.PI_REMOTE_ATTACH_FILE;
    delete process.env.PI_REMOTE_DEVICE_ID;
  }
});

test("buildSessionManifest：活动会话不在最新 200 条里时，截断也要把它保住", () => {
  const sessions = Array.from({ length: 201 }, (_, i) => ({
    id: "s" + i,
    cwd: "D:/work/app",
    messageCount: i,
    sizeBytes: 8,
    createdAt: 1,
    updatedAt: i + 1,
  }));
  // s0 是最旧的（updatedAt=1），正常会被 200 条截断切掉；它是当前会话，必须在
  const frame = ext.buildSessionManifest({
    deviceId: "dev-1",
    sessions,
    activeId: "s0",
    full: true,
    now: 50,
    maxBatch: ext.MAX_MANIFEST_BATCH,
  });
  assert.equal(frame.truncated, true);
  assert.equal(frame.sessions.length, 200);
  assert.equal(frame.sessions.filter((row) => row.id === "s0").length, 1, "活动会话不能被截断切掉");
  assert.equal(frame.sessions.find((row) => row.id === "s0").active, true);
  assert.equal(frame.sessions[0].id, "s200", "倒序不被破坏");
});

test("redactDeep：accessKey / signingKey / passphrase 一样打码，计数类设置不受影响", () => {
  const out = ext.redactDeep({
    accessKey: "ak-1",
    accessKeyId: "akid-2",
    signingKey: "sk-3",
    passphrase: "pp-4",
    maxTokens: 100,
    keepRecentTokens: 5,
    nested: { apiKey: "k", reserveTokens: 7 },
  });
  assert.equal(out.accessKey, "***");
  assert.equal(out.accessKeyId, "***");
  assert.equal(out.signingKey, "***");
  assert.equal(out.passphrase, "***");
  assert.equal(out.maxTokens, 100);
  assert.equal(out.keepRecentTokens, 5);
  assert.equal(out.nested.apiKey, "***");
  assert.equal(out.nested.reserveTokens, 7);
});

test("syntheticSession：查不到的非活动会话不再造假行；活动会话仍从实时状态生成", () => {
  process.env.PI_REMOTE_DEVICE_ID = "dev-1";
  delete process.env.PI_REMOTE_PROJECTS;
  const bridge = new ext.Bridge();
  bridge.roomId = "live";
  bridge.cwd = "D:\\work\\app";
  bridge.sessionName = "现在";
  bridge.ctx = { sessionManager: { getSessionFile: () => "D:\\work\\live.jsonl", getBranch: () => [] } };
  silence(bridge);
  assert.equal(bridge.syntheticSession("unknown"), null, "白名单外/已删的会话不能造 messageCount:0 的假行");
  const live = bridge.syntheticSession("live");
  assert.equal(live.id, "live");
  assert.equal(live.name, "现在");
  assert.equal(live.path, "D:/work/live.jsonl");
});

test("bashCwdAllowed：只放行会话目录 / 已登记项目（含子目录），别的一律拒绝", () => {
  process.env.PI_REMOTE_DEVICE_ID = "dev-1";
  process.env.PI_REMOTE_PROJECTS = "D:\\work\\other";
  const bridge = new ext.Bridge();
  bridge.platform = "win32";
  bridge.cwd = "D:\\work\\app";
  silence(bridge);
  assert.equal(bridge.bashCwdAllowed("D:\\work\\app"), true);
  assert.equal(bridge.bashCwdAllowed("d:/work/app/"), true, "大小写与末尾斜杠不计");
  assert.equal(bridge.bashCwdAllowed("D:\\work\\app\\src"), true, "子目录允许");
  assert.equal(bridge.bashCwdAllowed("D:\\work\\other"), true);
  assert.equal(bridge.bashCwdAllowed("D:\\work\\elsewhere"), false);
  assert.equal(bridge.bashCwdAllowed("D:\\work\\application"), false, "前缀相同的兄弟目录不算子目录");
  assert.equal(bridge.bashCwdAllowed(""), false);

  process.env.PI_REMOTE_PROJECTS = "/srv/Other";
  bridge.platform = "linux";
  bridge.cwd = "/srv/App";
  assert.equal(bridge.bashCwdAllowed("/srv/App/src"), true);
  assert.equal(bridge.bashCwdAllowed("/srv/app"), false, "Linux 区分大小写");
  assert.equal(bridge.bashCwdAllowed("/srv/Other/"), true);
  bridge.platform = "darwin";
  assert.equal(bridge.bashCwdAllowed("/srv/app/src"), true, "macOS 不分大小写");
  delete process.env.PI_REMOTE_PROJECTS;
});

test("bashCwdAllowed：本机 POSIX 上按真实路径比，项目里指向外面的符号链接不能当跳板", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-bashcwd-")));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, "escape"));
  fs.symlinkSync(project, path.join(root, "alias"));
  delete process.env.PI_REMOTE_PROJECTS;
  const bridge = new ext.Bridge();
  bridge.cwd = project;
  silence(bridge);
  assert.equal(bridge.bashCwdAllowed(path.join(project, "escape")), false, "链接指向项目外");
  assert.equal(bridge.bashCwdAllowed(path.join(root, "alias")), true, "链接指回项目本身");
  assert.equal(bridge.bashCwdAllowed(project), true);
});

test("jailSessionPath：盘符/目录大小写不同不算越界，真越界仍拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jail-"));
  const file = path.join(dir, "2026-01-01T00-00-00-000Z_abc.jsonl");
  fs.writeFileSync(file, "{}\n", "utf8");
  const bridge = new ext.Bridge();
  bridge.ctx = { sessionManager: { getSessionDir: () => dir } };
  assert.equal(bridge.jailSessionPath(file), file);
  if (process.platform === "win32") {
    const lower = file.charAt(0).toLowerCase() + file.slice(1);
    assert.equal(bridge.jailSessionPath(lower), lower, "盘符小写是同一路径");
  }
  assert.throws(() => bridge.jailSessionPath(path.join(os.tmpdir(), "nope.jsonl")), /越界|不存在/);
});

/** 假全局 WebSocket：记下每条 socket 发出的帧，构造后下一拍触发 onopen */
function fakeSocketClass(sockets) {
  return class {
    constructor() {
      this.sent = [];
      this.closed = 0;
      this.bufferedAmount = 0;
      sockets.push(this);
      queueMicrotask(() => {
        if (typeof this.onopen === "function") this.onopen();
      });
    }
    send(s) {
      this.sent.push(JSON.parse(s));
    }
    close() {
      this.closed += 1;
    }
    deliver(obj) {
      if (typeof this.onmessage === "function") this.onmessage({ data: JSON.stringify(obj) });
    }
  };
}

async function livenessBridge(sockets) {
  const bridge = new ext.Bridge();
  bridge.gateOpen = () => true;
  bridge.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ws = sockets[sockets.length - 1];
  ws.deliver({ type: "auth_result", ok: true, proto: 4, caps: ["sync.v3", "room.label"] });
  return { bridge, ws };
}

test("扩展存活检测：定时器晚到 30s 以上 = 刚睡醒，丢掉旧连接（先摘回调）立刻重连", async () => {
  const origWS = globalThis.WebSocket;
  const realNow = Date.now;
  const sockets = [];
  let now = realNow.call(Date);
  globalThis.WebSocket = fakeSocketClass(sockets);
  Date.now = () => now;
  const { bridge, ws } = await livenessBridge(sockets);
  try {
    bridge.lastTick = now;
    now += 10_000;
    assert.equal(bridge.checkLiveness(), "ok");
    now += 45_000;
    assert.equal(bridge.checkLiveness(), "wake");
    assert.equal(ws.closed, 1, "旧连接关掉");
    assert.equal(ws.onmessage, null, "旧 socket 的回调摘掉，迟到的帧和 close 不会再进来");
    assert.equal(ws.onclose, null);
    assert.equal(sockets.length, 2, "不等退避，立刻另起一条");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(bridge.ws, sockets[1]);
    assert.equal(bridge.connected, true);
    assert.equal(sockets[1].sent[0].type, "auth");
  } finally {
    Date.now = realNow;
    globalThis.WebSocket = origWS;
    silence(bridge);
    bridge.stop();
  }
});

test("扩展存活检测：空闲 60s 没收到 relay 帧就发 sync 探活，有回音算活着，20s 没回音就重连；未确认房间/忙时不探", async () => {
  const origWS = globalThis.WebSocket;
  const realNow = Date.now;
  const sockets = [];
  let now = realNow.call(Date);
  globalThis.WebSocket = fakeSocketClass(sockets);
  Date.now = () => now;
  const { bridge, ws } = await livenessBridge(sockets);
  const tick = (ms) => {
    now += ms;
    return bridge.checkLiveness();
  };
  try {
    bridge.lastTick = now;
    bridge.roomId = "r1";
    for (let i = 0; i < 7; i++) assert.equal(tick(10_000), "ok", "relay 还没确认这个房间归本连接：sync 不会回包，不能拿来探");

    ws.deliver({ type: "room_registered", room: "r1", msgCount: 0 });
    assert.equal(bridge.confirmedRoom, "r1");
    bridge.busy = true;
    for (let i = 0; i < 7; i++) assert.equal(tick(10_000), "ok", "忙时不探");
    bridge.busy = false;
    assert.equal(tick(10_000), "probe", "一空闲就补探：上次收到 relay 的帧已经是 80s 前");
    assert.deepEqual(ws.sent[ws.sent.length - 1], { type: "sync", room: "r1" });
    assert.equal(tick(10_000), "probing");
    ws.deliver({ type: "room_registered", room: "r1", msgCount: 0 });
    assert.equal(tick(10_000), "ok", "有回音就算活着");

    for (let i = 0; i < 4; i++) assert.equal(tick(10_000), "ok");
    assert.equal(tick(10_000), "probe", "又空闲满 60s，再探一次");
    assert.equal(tick(10_000), "probing");
    assert.equal(tick(10_000), "dead");
    assert.equal(ws.closed, 1);
    assert.equal(sockets.length, 2, "判死后立刻重连");
    assert.equal(bridge.confirmedRoom, null, "新连接要重新确认房间");
  } finally {
    Date.now = realNow;
    globalThis.WebSocket = origWS;
    silence(bridge);
    bridge.stop();
  }
});

test("扩展存活检测：没连上时不判；旧 relay 没声明 sync.v3 时只做睡醒检测，不发探活", async () => {
  const origWS = globalThis.WebSocket;
  const realNow = Date.now;
  const sockets = [];
  let now = realNow.call(Date);
  globalThis.WebSocket = fakeSocketClass(sockets);
  Date.now = () => now;
  const bridge = new ext.Bridge();
  try {
    bridge.lastTick = now;
    now += 120_000;
    assert.equal(bridge.checkLiveness(), "idle", "没有连接");
    bridge.gateOpen = () => true;
    bridge.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ws = sockets[0];
    ws.deliver({ type: "auth_result", ok: true });
    bridge.roomId = "r1";
    bridge.confirmedRoom = "r1";
    bridge.lastTick = now;
    for (let i = 0; i < 12; i++) {
      now += 10_000;
      assert.equal(bridge.checkLiveness(), "ok", "旧 relay（没声明 sync.v3）不发 sync");
    }
    assert.equal(ws.sent.some((f) => f.type === "sync"), false);
  } finally {
    Date.now = realNow;
    globalThis.WebSocket = origWS;
    silence(bridge);
    bridge.stop();
  }
});

test("退避只在认证成功后重置：onopen 与窗口轮询不清零；未回 auth 就断开按退避翻倍", async () => {
  const origWS = globalThis.WebSocket;
  const origAttach = process.env.PI_REMOTE_ATTACH_FILE;
  const sockets = [];
  globalThis.WebSocket = fakeSocketClass(sockets);
  process.env.PI_REMOTE_ATTACH_FILE = path.join(os.tmpdir(), `pi-remote-backoff-missing-${process.pid}.json`);
  const bridge = new ext.Bridge();
  bridge.gateOpen = () => true;
  try {
    bridge.backoff = 16000;
    bridge.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sockets.length, 1);
    assert.equal(bridge.backoff, 16000, "onopen 时还没认证，不能先把退避清零");
    assert.equal(bridge.connected, true);

    // 对端握手成功后立刻断开，且从未回 auth_result：模拟报告里的“握手成功即断开”
    assert.equal(typeof sockets[0].onclose, "function");
    sockets[0].onclose();
    assert.equal(bridge.connected, false);
    assert.equal(bridge.backoff, 20000, "按 16s 等待后翻倍到 20s 上限，而不是回到 1s");
    const timer = bridge.reconnectTimer;
    assert.ok(timer, "已安排退避重连");

    // 5 秒窗口轮询不能把等待中的退避清掉重来
    bridge.evaluateGate("expiry");
    assert.equal(bridge.reconnectTimer, timer);
    assert.equal(bridge.backoff, 20000);

    // 认证成功后才清零
    clearTimeout(bridge.reconnectTimer);
    bridge.reconnectTimer = null;
    bridge.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sockets.length, 2);
    sockets[1].deliver({ type: "auth_result", ok: true, proto: 4, caps: ["sync.v3"] });
    assert.equal(bridge.backoff, 1000);
    assert.equal(bridge.authed, true);
  } finally {
    globalThis.WebSocket = origWS;
    if (origAttach === undefined) delete process.env.PI_REMOTE_ATTACH_FILE;
    else process.env.PI_REMOTE_ATTACH_FILE = origAttach;
    silence(bridge);
    bridge.stop();
  }
});
