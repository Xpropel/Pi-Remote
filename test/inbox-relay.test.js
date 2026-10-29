// 收件箱账本 relay 集成（设计 D §1）：真起 relay、两条通道真实帧验证——
// cap 门控（auth/room_list/inbox_update 三面）、dialog 生命周期进出账、ui_prompt 兜底
// 让位 dialog、回合落定进账与 dismiss/进房清、waiting 拒清、重启恢复与补发对账（stale）。
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");
const { startRelay } = require("../relay/server.js");

const LOCAL_TOKEN = ["inbox", "local", "token"].join("-");
const VIEWER_TOKEN = ["inbox", "viewer", "token"].join("-");
const R1 = "room-inbox-1";
const CAPS = ["err.v4", "msg.cid", "dialog.respond", "room.dialogs", "room.attention", "room.inbox"];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-inbox-relay-"));
}

function boot(overrides = {}) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: true,
    inboxResyncGraceMs: 400,
    ...overrides,
  });
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    frames.push(msg);
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue;
      msg.__taken = true;
      waiters.splice(waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(msg);
      break;
    }
  });
  const api = {
    ws,
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    }),
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    wait(pred, ms = 3000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f));
      if (hit) {
        hit.__taken = true;
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`等待 ${what} 超时；已收到：${frames.map((f) => f.type).join(",")}`));
        }, ms) };
        waiters.push(w);
      });
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type);
    },
    close() {
      ws.terminate();
    },
  };
  return api;
}

async function extensionRoom(relay, roomId) {
  const c = client(relay.localPort);
  await c.opened;
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN });
  await c.type("auth_result");
  c.send({ type: "room_register", room: { id: roomId, label: roomId, cwd: "/tmp", epoch: 1, instance: "inst-" + roomId } });
  await c.type("room_registered");
  return c;
}

async function viewer(relay, caps) {
  const v = client(relay.viewerPort);
  await v.opened;
  const hello = { type: "auth", role: "viewer", token: VIEWER_TOKEN };
  if (Array.isArray(caps)) hello.caps = caps;
  v.send(hello);
  const auth = await v.type("auth_result");
  assert.equal(auth.ok, true);
  return { v, auth };
}

const ev = (room, event) => ({ type: "event", room, event });
const dialogOpen = (dialogId, extra = {}) => ({
  type: "dialog_open",
  dialogId,
  kind: "confirm",
  title: "允许执行 " + dialogId + "？",
  startedAt: 1000 + dialogId.length,
  timeout: 120000,
  ...extra,
});
const settleTurn = async (ext, room) => {
  ext.send(ev(room, { type: "agent_start" }));
  ext.send(ev(room, { type: "message_end", message: { role: "assistant", stopReason: "stop" } }));
  ext.send(ev(room, { type: "agent_settled" }));
};

const inboxUpdateWith = (pred) => (f) => f.type === "inbox_update" && pred(f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("cap 门控：未声明 room.inbox 的端 auth_result/room_list 都没有 inbox 字段", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const old = await viewer(relay, ["err.v4", "room.dialogs"]);
  t.after(() => old.v.close());
  assert.equal("inbox" in old.auth, false);
  old.v.send({ type: "list_rooms" });
  const list = await old.v.type("room_list");
  assert.equal("inbox" in list, false);

  const fresh = await viewer(relay, CAPS);
  t.after(() => fresh.v.close());
  assert.deepEqual(fresh.auth.inbox, []);
  fresh.v.send({ type: "list_rooms" });
  const list2 = await fresh.v.type("room_list");
  assert.deepEqual(list2.inbox, []);
});

test("dialog 生命周期：open 进账（快照+增量）、close{reason:answered} 出账且墓碑原因回填", async (t) => {
  const dataDir = tmpDir();
  const relay = await boot({ dataDir });
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());

  ext.send(ev(R1, dialogOpen("dlg-1", { answerable: true })));
  const upd = await v.type("inbox_update", inboxUpdateWith((f) => f.upserts.some((e) => e.key === "dialog:dlg-1")));
  const entry = upd.upserts.find((e) => e.key === "dialog:dlg-1");
  assert.equal(entry.kind, "waiting");
  assert.equal(entry.subkind, "dialog");
  assert.equal(entry.dialogKind, "confirm");
  assert.equal(entry.answerable, true);
  assert.equal("options" in entry, false, "账本不带正文面");

  v.send({ type: "list_rooms" });
  const list = await v.type("room_list", (f) => Array.isArray(f.inbox) && f.inbox.some((e) => e.key === "dialog:dlg-1"));
  assert.ok(list);

  ext.send(ev(R1, { type: "dialog_close", dialogId: "dlg-1", outcome: "resolved", reason: "answered" }));
  await v.type("inbox_update", inboxUpdateWith((f) => f.removed.includes("dialog:dlg-1")));
  // 墓碑原因：close 的 reason 经 observeRoomTurnEvent 回填为 answered（不是对账时的 resolved）
  const accountsDir = path.join(dataDir, "accounts");
  const sub = fs.readdirSync(accountsDir).find((n) => fs.existsSync(path.join(accountsDir, n, "inbox.json")));
  const raw = JSON.parse(fs.readFileSync(path.join(accountsDir, sub, "inbox.json"), "utf8"));
  assert.equal(raw.tombs["dialog:dlg-1"].goneReason, "answered");
  assert.deepEqual(raw.entries, []);
});

test("ui_prompt 兜底：无 dialog 时进账、dialog 出现即让位、end 后消账", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());

  ext.send(ev(R1, { type: "ui_prompt_start", kind: "confirm", title: "旧弹窗" }));
  const upd = await v.type("inbox_update", inboxUpdateWith((f) => f.upserts.some((e) => e.subkind === "prompt")));
  const promptKey = upd.upserts.find((e) => e.subkind === "prompt").key;
  assert.ok(promptKey.startsWith(`prompt:${R1}:`));

  // dialog 出现：prompt 条目被对账消项（与 attention 的去重纪律一致，下沉到账本层）
  ext.send(ev(R1, dialogOpen("dlg-9", { answerable: true })));
  await v.type("inbox_update", inboxUpdateWith((f) => f.removed.includes(promptKey) && f.upserts.some((e) => e.key === "dialog:dlg-9")));
  // prompt 信号还在但 dialog 在场时不许 prompt 条目复活：再触发一次对账（开第二个 dialog）后清单里仍只有 dialog
  ext.send(ev(R1, dialogOpen("dlg-10", { answerable: true })));
  await v.type("inbox_update", inboxUpdateWith((f) => f.upserts.some((e) => e.key === "dialog:dlg-10")));
  v.send({ type: "list_rooms" });
  const list = await v.type("room_list", (f) => Array.isArray(f.inbox) && f.inbox.some((e) => e.key === "dialog:dlg-10"));
  assert.deepEqual(list.inbox.filter((e) => e.subkind === "prompt"), []);
});

test("回合落定进账；waiting 不许 dismiss、done 可 dismiss；进房订阅清 turn 条目", async (t) => {
  const relay = await boot();
  t.after(() => relay.close());
  const ext = await extensionRoom(relay, R1);
  t.after(() => ext.close());
  const { v } = await viewer(relay, CAPS);
  t.after(() => v.close());

  ext.send(ev(R1, dialogOpen("dlg-2", { answerable: true })));
  await v.type("inbox_update", inboxUpdateWith((f) => f.upserts.some((e) => e.key === "dialog:dlg-2")));
  // waiting 拒清：发 dismiss 后不得出现 removed，且快照里仍在
  v.send({ type: "inbox_dismiss", key: "dialog:dlg-2" });
  await sleep(250);
  assert.equal(v.frames.some((f) => f.type === "inbox_update" && Array.isArray(f.removed) && f.removed.includes("dialog:dlg-2")), false);
  v.send({ type: "list_rooms" });
  const still = await v.type("room_list", (f) => Array.isArray(f.inbox));
  assert.ok(still.inbox.some((e) => e.key === "dialog:dlg-2"), "waiting 条目仍在账本");

  await settleTurn(ext, R1);
  const upd = await v.type("inbox_update", inboxUpdateWith((f) => f.upserts.some((e) => e.subkind === "turn" && e.kind === "done")));
  const turnKey = upd.upserts.find((e) => e.subkind === "turn").key;
  assert.ok(turnKey.startsWith(`turn:${R1}:`));

  v.send({ type: "inbox_dismiss", key: turnKey });
  await v.type("inbox_update", inboxUpdateWith((f) => f.removed.includes(turnKey)));

  // 再落定一回合，这次靠「进房即已读」清账（订阅该房 → relay 清账本 turn 条目）
  await settleTurn(ext, R1);
  const upd2 = await v.type("inbox_update", inboxUpdateWith((f) => f.upserts.some((e) => e.subkind === "turn")));
  const turnKey2 = upd2.upserts.find((e) => e.subkind === "turn").key;
  v.send({ type: "subscribe", room: R1 });
  await v.type("subscribed");
  await v.type("inbox_update", inboxUpdateWith((f) => f.removed.includes(turnKey2)));
});

test("重启对账：未读 turn 不丢、waiting 恢复挂账；补发确认的留下、没补发的转 stale", async (t) => {
  const dataDir = tmpDir();
  const relay1 = await boot({ dataDir });
  const ext1 = await extensionRoom(relay1, R1);
  ext1.send(ev(R1, dialogOpen("dlg-keep", { answerable: true })));
  ext1.send(ev(R1, dialogOpen("dlg-lost", { answerable: true })));
  await settleTurn(ext1, R1);
  await sleep(150); // 等账本落盘
  ext1.close();
  await relay1.close();

  const relay2 = await boot({ dataDir });
  t.after(() => relay2.close());
  const { v, auth } = await viewer(relay2, CAPS);
  t.after(() => v.close());
  const keys = auth.inbox.map((e) => e.key);
  assert.ok(keys.includes("dialog:dlg-keep"), "重启后 waiting 恢复挂账");
  assert.ok(keys.includes("dialog:dlg-lost"));
  assert.ok(keys.some((k) => k.startsWith(`turn:${R1}:`)), "未读 turn 跨重启不丢");

  // 房间回来，只补发 dlg-keep（dlg-lost 已在本机被处理、不会再报）
  const ext2 = await extensionRoom(relay2, R1);
  t.after(() => ext2.close());
  ext2.send(ev(R1, dialogOpen("dlg-keep", { answerable: true })));
  // 宽限（400ms）到期：dlg-lost 转 stale 出账，dlg-keep 与 turn 保留
  await v.type("inbox_update", inboxUpdateWith((f) => f.removed.includes("dialog:dlg-lost")), 5000);
  v.send({ type: "list_rooms" });
  // 谓词带否定条件：清扫前到达的广播 room_list 都还带着 dlg-lost，不会被误匹配成回复
  const list = await v.type("room_list", (f) => Array.isArray(f.inbox) && !f.inbox.some((e) => e.key === "dialog:dlg-lost") && f.inbox.some((e) => e.key === "dialog:dlg-keep"));
  const after = list.inbox.map((e) => e.key);
  assert.ok(after.includes("dialog:dlg-keep"), "补发确认的 waiting 留下");
  assert.equal(after.includes("dialog:dlg-lost"), false);
  assert.ok(after.some((k) => k.startsWith(`turn:${R1}:`)), "turn 不被清扫误伤");
});
