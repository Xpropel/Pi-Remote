// 第二轮 relay / 扩展积压（S8）：停止信号转发、时间列与状态行同源、同分钟重名后缀、pi 版本上报、
// 名册拒绝错误码、工具名占位。扩展用 jiti 加载（同 extension.test.mjs），relay 起真 WS，网页数据层直接跑 .ts。
import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { startRelay } from "../relay/server.js"
import { emptyRoomTurnTracker, roomTurnEndsOf, trackRoomEventEdge, trackRoomListEdges } from "../ui/src/relay/attention.ts"
import { mergeDeviceSessions, parseRooms, roomActivityAt, viewerListRefusal } from "../ui/src/relay/devices.ts"
import { authFrame } from "../ui/src/relay/protocol.ts"
import { emptyTranscript, reduceTranscript } from "../ui/src/relay/transcript.ts"
import { sessionStatusLineOf } from "../ui/src/pi/model/sidebarSource.ts"
import { viewerRosterAdminOnlyOf } from "../ui/src/pi/settings/pages/identityLogic.ts"

const LOG_PATH = path.join(os.tmpdir(), `pi-remote-backlog-r2-${process.pid}.log`)
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(os.tmpdir(), `pi-remote-attach-backlog-r2-${process.pid}-missing.json`)
process.env.PI_REMOTE_TOKEN = ""
after(() => {
  for (const f of [LOG_PATH, LOG_PATH + ".old"]) fs.rmSync(f, { force: true })
})
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8")
const assistant = (stopReason, extra = {}) => ({ role: "assistant", content: [{ type: "text", text: "x" }], stopReason, timestamp: 1, ...extra })
const TURN_TYPES = new Set(["agent_start", "turn_start", "turn_stopped", "message_update", "message_end", "turn_end", "agent_settled"])

function bridgeWithSink() {
  const b = new ext.Bridge()
  b.roomId = "A"
  b.connected = true
  b.authed = true
  const sent = []
  b.ws = { bufferedAmount: 0, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  const events = () => sent.filter((f) => f.type === "event" && TURN_TYPES.has(f.event.type)).map((f) => f.event)
  return { b, events }
}

/* ---------------- 1. 停止信号：扩展 ---------------- */

test("停止信号（扩展）：远端停止先发 turn_stopped，这一轮的收尾事件带 stopped:true，新一轮 agent_start 才清", async () => {
  const { b, events } = bridgeWithSink()
  let idle = false
  b.ctx = { isIdle: () => idle, abort: () => { idle = true } }
  b.forward({ type: "agent_start" })
  b.busy = true
  await b.cmdAbort()
  // pi 的余波：被停的助手消息落成 aborted，随后又起一个 turn、以「请求被中断」收尾
  b.forward({ type: "message_end", message: assistant("aborted") })
  b.forward({ type: "turn_start" })
  b.forward({ type: "message_update", assistantMessageEvent: { type: "error", reason: "error", error: assistant("error", { errorMessage: "Request was aborted" }) } })
  b.forward({ type: "message_end", message: assistant("error", { errorMessage: "Request was aborted" }) })
  b.forward({ type: "turn_end", message: assistant("error") })
  b.forward({ type: "agent_settled" })
  const out = events()
  assert.deepEqual(out.map((e) => e.type), ["agent_start", "turn_stopped", "message_end", "turn_start", "message_update", "message_end", "turn_end", "agent_settled"])
  assert.equal(out[1].source, "remote")
  assert.equal(typeof out[1].at, "number")
  for (const e of out.slice(2)) {
    if (e.type === "turn_start") assert.equal(e.stopped, undefined, "非收尾事件不打标")
    else assert.equal(e.stopped, true, `${e.type} 要带 stopped`)
  }
  assert.equal(out.filter((e) => e.type === "turn_stopped").length, 1, "随后的 aborted 不再重复发 turn_stopped")

  b.forward({ type: "agent_start" })
  b.forward({ type: "message_end", message: assistant("stop") })
  b.forward({ type: "agent_settled" })
  const next = events().slice(out.length)
  assert.deepEqual(next.map((e) => [e.type, e.stopped]), [["agent_start", undefined], ["message_end", undefined], ["agent_settled", undefined]], "新一轮不再带停止标")
})

test("停止信号（扩展）：本机中断（终端 Esc）落成 aborted 后补发 turn_stopped(local)，余波同样打标", () => {
  const { b, events } = bridgeWithSink()
  b.ctx = { isIdle: () => false }
  b.forward({ type: "agent_start" })
  b.forward({ type: "message_end", message: assistant("aborted") })
  b.forward({ type: "turn_start" })
  b.forward({ type: "message_end", message: assistant("error", { errorMessage: "Request was aborted" }) })
  b.forward({ type: "agent_settled" })
  const out = events()
  assert.deepEqual(out.map((e) => e.type), ["agent_start", "message_end", "turn_stopped", "turn_start", "message_end", "agent_settled"])
  assert.equal(out[1].stopped, undefined, "aborted 本身就是停止的证据")
  assert.equal(out[2].source, "local")
  assert.equal(out[4].stopped, true)
  assert.equal(out[5].stopped, true)
})

test("停止信号（扩展）：空闲时停止不发 turn_stopped；raw abort 帧与 abort 命令同口径", async () => {
  const idle = bridgeWithSink()
  idle.b.ctx = { isIdle: () => true, abort: () => {} }
  await idle.b.cmdAbort()
  assert.equal(idle.events().some((e) => e.type === "turn_stopped"), false)

  const raw = bridgeWithSink()
  raw.b.ctx = { isIdle: () => false, abort: () => {} }
  raw.b.handle({ type: "abort", room: "A" })
  assert.deepEqual(raw.events().map((e) => [e.type, e.source]), [["turn_stopped", "remote"]])
  assert.equal(raw.b.turnStopped, true)
})

/* ---------------- 4. pi 版本：扩展 ---------------- */

test("pi 版本：单文件 pi（argv[1] 是内嵌虚拟路径）从可执行文件旁的 package.json 读出；注册帧与诊断同源", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-exe-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "7.7.7" }))
  const exe = path.join(root, "pi.exe")
  fs.writeFileSync(exe, "")
  assert.equal(ext.readPiVersion("B:/~BUN/root/pi.js", exe), "7.7.7")
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "not-pi", version: "1.0.0" }))
  assert.notEqual(ext.readPiVersion("B:/~BUN/root/pi.js", exe), "7.7.7", "别的包不认")

  const b = new ext.Bridge()
  b.roomId = "r"
  const payload = b.roomPayload()
  const diag = await b.executeCommand("get_host_diag", {})
  if (diag.piVersion) assert.equal(payload.piVersion, diag.piVersion, "注册帧与 get_host_diag 报同一个版本")
  else assert.equal("piVersion" in payload, false, "读不到版本时注册帧不带这个字段")
})

/* ---------------- relay：真 WS ---------------- */

const LOCAL_TOKEN = "local-token-backlog-r2-0001"
const VIEWER_TOKEN = "viewer-token-backlog-r2-01"
const ADMIN_TOKEN = "admin-token-backlog-r2-0001"

function boot() {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-backlog-r2-")),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
    persistTranscripts: true,
  })
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  const frames = []
  const waiters = []
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString())
    frames.push(msg)
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue
      msg.__taken = true
      waiters.splice(waiters.indexOf(w), 1)
      clearTimeout(w.timer)
      w.resolve(msg)
      break
    }
  })
  const api = {
    frames,
    opened: new Promise((resolve, reject) => {
      ws.once("open", resolve)
      ws.once("error", reject)
    }),
    send(obj) {
      ws.send(JSON.stringify(obj))
    },
    wait(pred, ms = 3000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f))
      if (hit) {
        hit.__taken = true
        return Promise.resolve(hit)
      }
      return new Promise((resolve, reject) => {
        const w = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1)
            reject(new Error(`等待 ${what} 超时；已收到：${frames.map((f) => f.type).join(",")}`))
          }, ms),
        }
        waiters.push(w)
      })
    },
    type(type, extra = () => true, ms) {
      return api.wait((f) => f.type === type && extra(f), ms, type)
    },
    close() {
      ws.terminate()
    },
  }
  return api
}

async function local(relay, room) {
  const c = client(relay.localPort)
  await c.opened
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN })
  await c.type("auth_result")
  c.send({ type: "room_register", room: { epoch: 1, instance: "inst-a", label: "t", cwd: "/tmp", ...room } })
  await c.type("room_registered")
  return c
}

async function viewer(relay) {
  const v = client(relay.viewerPort)
  await v.opened
  v.send(authFrame(VIEWER_TOKEN))
  const auth = await v.type("auth_result")
  assert.equal(auth.ok, true)
  return v
}

const entryOf = (frame, id) => frame.rooms.find((r) => r.id === id)
/** 之前收到的帧都不再参与匹配（登录时的初始名册也是 busy:false） */
const skipSeen = (c) => {
  for (const f of c.frames) f.__taken = true
}

test("停止信号（relay）：room_state / 名册 / 订阅 / 快照都说这一轮是停止的，既不记完成也不记出错；新一轮照常", async (t) => {
  const ROOM = "room-stop-1"
  const relay = await boot()
  t.after(() => relay.close())
  const c = await local(relay, { id: ROOM })
  t.after(() => c.close())
  const v = await viewer(relay)
  t.after(() => v.close())
  const side = await viewer(relay)
  t.after(() => side.close())
  v.send({ type: "subscribe", room: ROOM })
  await v.type("snapshot")

  const ev = (event) => c.send({ type: "event", room: ROOM, event })
  ev({ type: "agent_start" })
  c.send({ type: "state", room: ROOM, busy: true })
  const rise = await side.type("room_list", (f) => entryOf(f, ROOM)?.busy === true)
  assert.equal(entryOf(rise, ROOM).turnStopped, undefined)
  let tracker = trackRoomListEdges(emptyRoomTurnTracker(), parseRooms(rise.rooms), "elsewhere")

  skipSeen(side)
  ev({ type: "turn_stopped", source: "remote", at: Date.now() })
  ev({ type: "message_end", message: assistant("aborted"), stopped: true })
  ev({ type: "turn_start" })
  ev({ type: "message_end", message: assistant("error", { errorMessage: "Request was aborted" }), stopped: true })
  ev({ type: "agent_settled", stopped: true })
  c.send({ type: "state", room: ROOM, busy: false })

  assert.equal((await v.type("room_event", (f) => f.event.type === "turn_stopped")).event.source, "remote", "turn_stopped 原样转给订阅端")
  const state = await v.type("room_state", (f) => f.busy === false)
  assert.equal(state.turnStopped, true)
  const fall = await side.type("room_list", (f) => entryOf(f, ROOM)?.busy === false)
  assert.equal(entryOf(fall, ROOM).turnStopped, true, "busy 变化会广播名册，条目带 turnStopped")
  assert.equal(entryOf(fall, ROOM).lastTurnEnd, null, "停止的回合不记完成/出错摘要")
  tracker = trackRoomListEdges(tracker, parseRooms(fall.rooms), "elsewhere")
  assert.deepEqual(roomTurnEndsOf(tracker), [], "网页追踪器吃同一份名册：落沿不产记录")

  const late = await viewer(relay)
  t.after(() => late.close())
  late.send({ type: "subscribe", room: ROOM })
  assert.equal((await late.type("subscribed")).turnStopped, true, "重连/后到的端从订阅确认就知道是停止")
  assert.equal((await late.type("snapshot")).turnStopped, true)
  assert.equal(side.frames.some((f) => f.type === "room_attention" && f.room === ROOM && f.lastTurnEnd), false, "没有任何完成/出错摘要广播")

  skipSeen(side)
  ev({ type: "agent_start" })
  c.send({ type: "state", room: ROOM, busy: true })
  const again = await side.type("room_list", (f) => entryOf(f, ROOM)?.busy === true)
  assert.equal(entryOf(again, ROOM).turnStopped, undefined, "新一轮运行清掉停止标")
  ev({ type: "message_end", message: assistant("stop") })
  ev({ type: "agent_settled" })
  c.send({ type: "state", room: ROOM, busy: false })
  const done = await side.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd)
  assert.equal(done.lastTurnEnd.kind, "done")
})

test("时间列（relay）：eventAt 只随 pi 事件走，观看/订阅只动 lastActivity；busy 真变化才广播名册", async (t) => {
  const ROOM = "room-time-1"
  const relay = await boot()
  t.after(() => relay.close())
  const c = await local(relay, { id: ROOM })
  t.after(() => c.close())
  const v = await viewer(relay)
  t.after(() => v.close())

  v.send({ type: "list_rooms" })
  const first = entryOf(await v.type("room_list"), ROOM)
  assert.equal(first.eventAt, 0, "注册不算有意义的事件")

  await new Promise((resolve) => setTimeout(resolve, 15))
  v.send({ type: "subscribe", room: ROOM })
  await v.type("snapshot")
  v.send({ type: "list_rooms" })
  const viewed = entryOf(await v.type("room_list", (f) => entryOf(f, ROOM)?.lastActivity > first.lastActivity), ROOM)
  assert.equal(viewed.eventAt, 0, "订阅刷新了 lastActivity，但不动 eventAt")

  const before = Date.now()
  c.send({ type: "event", room: ROOM, event: { type: "message_end", message: { role: "user", content: "hi", timestamp: 1 } } })
  c.send({ type: "state", room: ROOM, busy: true })
  const busy = entryOf(await v.type("room_list", (f) => entryOf(f, ROOM)?.busy === true), ROOM)
  assert.ok(busy.eventAt >= before, "pi 事件刷新 eventAt；busy 变化自己就会推名册")

  const count = () => v.frames.filter((f) => f.type === "room_list").length
  const seen = count()
  c.send({ type: "state", room: ROOM, busy: true })
  c.send({ type: "event", room: ROOM, event: { type: "queue_update", steering: [], followUp: [] } })
  await v.type("room_event", (f) => f.event.type === "queue_update")
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(count(), seen, "busy 没变不重复广播")
})

test("pi 版本（relay）：注册帧的 piVersion 进名册；坏值 / 旧扩展不带", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const good = await local(relay, { id: "room-ver-1", piVersion: " 1.4.0 " })
  t.after(() => good.close())
  const bad = await local(relay, { id: "room-ver-2", piVersion: "1.4.0 <script>" })
  t.after(() => bad.close())
  const old = await local(relay, { id: "room-ver-3" })
  t.after(() => old.close())
  const v = await viewer(relay)
  t.after(() => v.close())
  v.send({ type: "list_rooms" })
  const list = await v.type("room_list", (f) => ["room-ver-1", "room-ver-2", "room-ver-3"].every((id) => entryOf(f, id)))
  assert.equal(entryOf(list, "room-ver-1").piVersion, "1.4.0")
  assert.equal("piVersion" in entryOf(list, "room-ver-2"), false)
  assert.equal("piVersion" in entryOf(list, "room-ver-3"), false)
  assert.equal(parseRooms(list.rooms).find((r) => r.id === "room-ver-1").piVersion, "1.4.0", "网页端解析出来")
})

test("名册拒绝（relay）：普通观看端读名册得到 ok:false + code admin_required", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const v = await viewer(relay)
  t.after(() => v.close())
  v.send({ type: "list_viewers", id: "vl_r2" })
  const ack = await v.type("ack", (f) => f.id === "vl_r2")
  assert.equal(ack.ok, false)
  assert.equal(ack.code, "admin_required")
})

/* ---------------- 网页数据层 ---------------- */

test("停止信号（网页追踪器）：别房 turn_stopped / stopped:true / 名册 turnStopped 都不产完成或出错记录；新一轮照常", () => {
  const cur = "room-current"
  let tr = trackRoomListEdges(emptyRoomTurnTracker(), [{ id: "r1", busy: false }], cur, 1)
  tr = trackRoomEventEdge(tr, "r1", { type: "agent_start" }, cur, 2)
  tr = trackRoomEventEdge(tr, "r1", { type: "turn_stopped" }, cur, 3)
  tr = trackRoomEventEdge(tr, "r1", { type: "turn_start" }, cur, 4)
  tr = trackRoomEventEdge(tr, "r1", { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Request was aborted" }, stopped: true }, cur, 5)
  tr = trackRoomEventEdge(tr, "r1", { type: "agent_settled", stopped: true }, cur, 6)
  assert.deepEqual(roomTurnEndsOf(tr), [])

  // 只收到带标的收尾事件（turn_stopped 那帧丢了）也一样
  tr = trackRoomEventEdge(tr, "r1", { type: "agent_start" }, cur, 7)
  tr = trackRoomEventEdge(tr, "r1", { type: "message_update", assistantMessageEvent: { type: "error" }, stopped: true }, cur, 8)
  tr = trackRoomEventEdge(tr, "r1", { type: "agent_settled", stopped: true }, cur, 9)
  assert.deepEqual(roomTurnEndsOf(tr), [])

  // 新一轮没有停止：照常记出错
  tr = trackRoomEventEdge(tr, "r1", { type: "agent_start" }, cur, 10)
  tr = trackRoomEventEdge(tr, "r1", { type: "message_end", message: { role: "assistant", stopReason: "error" } }, cur, 11)
  tr = trackRoomEventEdge(tr, "r1", { type: "agent_settled" }, cur, 12)
  assert.deepEqual(roomTurnEndsOf(tr).map((e) => [e.roomId, e.error]), [["r1", true]])

  // 名册边沿：relay 说停止 → 不记；旧 relay（不带字段）→ 照旧记完成
  let roster = trackRoomListEdges(emptyRoomTurnTracker(), [{ id: "r2", busy: true }, { id: "r3", busy: true }], cur, 1)
  roster = trackRoomListEdges(roster, [{ id: "r2", busy: false, turnStopped: true }, { id: "r3", busy: false }], cur, 2)
  assert.deepEqual(roomTurnEndsOf(roster).map((e) => [e.roomId, e.error]), [["r3", false]])
})

test("停止信号（网页 useRelay 接线）：turn_stopped / stopped:true 与本端按停止同一处理；订阅、快照、room_state、名册带 turnStopped 时不补报", () => {
  const relay = src("../ui/src/relay/useRelay.ts")
  const handleAt = relay.indexOf("const handleEvent = useCallback(")
  const head = relay.slice(handleAt, relay.indexOf('case "message_start": {', handleAt))
  assert.match(head, /event\.type === "turn_stopped" \|\| event\.stopped === true\) \{\s+stopRequestedRef\.current = true/)
  for (const anchor of ['if (type === "subscribed") {', 'if (type === "room_state") {']) {
    const at = relay.indexOf(anchor)
    const body = relay.slice(at, relay.indexOf("finishTurn()", at))
    assert.match(body, /msg\.turnStopped === true\) \{\s+stopRequestedRef\.current = true/, anchor)
  }
  assert.match(relay, /if \(msg\.turnStopped === true \|\| \(!msg\.busy && owesSignal && lastAssistantMessageStopped\(messages\)\)\) \{\s+stopRequestedRef\.current = true/, "快照：relay 标或旧 relay 的 aborted 终版消息")
  assert.match(relay, /if \(!current\.busy\) \{\s+if \(current\.turnStopped === true\) \{\s+stopRequestedRef\.current = true/, "当前房的名册落沿")
  assert.match(relay, /export function lastAssistantMessageStopped\(messages: readonly AgentMessage\[\]\): boolean \{[\s\S]{0,220}return message\.stopReason === "aborted"/)
})

test("时间列与状态行同源：新 relay 用 eventAt（观看/改名/重启不刷新）；还没见过事件用会话文件时间；旧 relay 维持原口径", () => {
  const M = 60_000
  const NOW = Date.UTC(2026, 10, 13, 8, 0, 0)
  const dev = { id: "d1", accountId: "a", name: "PC", platform: "linux", online: true, projects: ["/w"], browseRoots: [], lastAttachAt: 1, firstSeenAt: 1, windowExpiresAt: null, auth: null, paired: true }
  const room = { id: "s1", label: null, cwd: "/w", online: true, busy: false, viewers: 1, lastActivity: NOW - 4 * M, eventAt: NOW - 31 * M, deviceId: "d1" }
  const sess = { id: "s1", name: "会话", firstMessage: "", path: "/s/s1.jsonl", cwd: "/w", messageCount: 7, sizeBytes: 1, updatedAt: NOW - 35 * M, active: true, online: true }

  const [row] = mergeDeviceSessions(dev, [room], [sess])
  assert.equal(row.updatedAt, NOW - 31 * M, "观看刷新的 lastActivity（4 分钟前）不进时间列")
  assert.equal(mergeDeviceSessions(dev, [room], [{ ...sess, updatedAt: NOW - 2 * M }])[0].updatedAt, NOW - 31 * M, "会话文件被改名/重启写盘带新也不跟")
  assert.equal(sessionStatusLineOf({ room, session: row, turnEnd: null, now: NOW }).text, "空闲 · 31 分钟前")
  assert.equal(sessionStatusLineOf({ room, session: row, turnEnd: { seq: 1, at: NOW - 31 * M, roomId: "s1", error: false }, now: NOW }).text, "已完成 · 31 分钟前")
  assert.equal(sessionStatusLineOf({ room, session: null, turnEnd: null, now: NOW }).text, "空闲 · 31 分钟前", "没有清单行时直接取房间的同一时刻")

  assert.equal(mergeDeviceSessions(dev, [{ ...room, eventAt: 0 }], [sess])[0].updatedAt, NOW - 35 * M, "relay 刚启动还没见过事件：用会话文件时间，不用 lastActivity")
  const { eventAt: _eventAt, ...legacyRoom } = room
  assert.equal(roomActivityAt(legacyRoom), NOW - 4 * M)
  assert.equal(mergeDeviceSessions(dev, [legacyRoom], [sess])[0].updatedAt, NOW - 4 * M, "旧 relay：max(文件时间, lastActivity) 不变")

  const [parsed] = parseRooms([{ id: "s1", eventAt: 123, lastActivity: 456 }])
  assert.equal(parsed.eventAt, 123)
  assert.equal("eventAt" in parseRooms([{ id: "s2", lastActivity: 456 }])[0], false, "旧 relay 不带就不出现")
})

test("同分钟重名后缀：同分钟用 · HH:MM:SS，同一秒再加 id 末尾短码；不再出现 8 位会话编号", () => {
  const dev = { id: "d1", accountId: "a", name: "PC", platform: "linux", online: true, projects: ["/w"], browseRoots: [], lastAttachAt: 1, firstSeenAt: 1, windowExpiresAt: null, auth: null, paired: true }
  const at = (m, s) => new Date(2026, 0, 5, 9, m, s).getTime()
  const room = (id, createdAt) => ({ id, label: null, name: null, firstMessage: null, cwd: "/w/proj", online: true, busy: false, viewers: 1, lastActivity: 500, deviceId: "d1", createdAt })
  const ids = ["01a1d0d8-4d8c-7462-b7cc-c3f610473d17", "01a1d0d8-4d8c-7462-b7cc-c3f61047ab02", "01a1d0d8-4d8c-7463-8000-000000000001", "01a1d0d9-0000-7000-8000-000000000002"]
  const titles = new Map(mergeDeviceSessions(dev, [room(ids[0], at(30, 15)), room(ids[1], at(30, 15) + 400), room(ids[2], at(30, 40)), room(ids[3], at(31, 2))], []).map((x) => [x.id, x.title]))
  assert.equal(titles.get(ids[0]), "proj · 09:30:15 · 3d17")
  assert.equal(titles.get(ids[1]), "proj · 09:30:15 · ab02")
  assert.equal(titles.get(ids[2]), "proj · 09:30:40")
  assert.equal(titles.get(ids[3]), "proj · 09:31")
  assert.ok([...titles.values()].every((title) => !title.includes("01a1d0d8")), "8 位编号不再出现")

  // 末尾 4 位也撞：加长到能分开
  const twins = ["x-aaaa1234", "x-bbbb1234"]
  const wide = new Map(mergeDeviceSessions(dev, twins.map((id) => room(id, at(30, 15))), []).map((x) => [x.id, x.title]))
  assert.equal(wide.get(twins[0]), "proj · 09:30:15 · a1234")
  assert.equal(wide.get(twins[1]), "proj · 09:30:15 · b1234")
})

test("pi 版本（网页）：名册条目的 piVersion 解析出来（去空白、限长），缺省不出现", () => {
  const [withVersion, without] = parseRooms([{ id: "r1", piVersion: " 1.4.0 " }, { id: "r2" }])
  assert.equal(withVersion.piVersion, "1.4.0")
  assert.equal("piVersion" in without, false)
})

test("名册拒绝（网页）：relay 带了错误码就保留成 RelayError，设置页先按码判断「仅管理员可见」", () => {
  const coded = viewerListRefusal("Admin credentials required", "admin_required")
  assert.equal(coded.code, "admin_required")
  assert.equal(coded.message, "Admin credentials required")
  assert.equal(viewerRosterAdminOnlyOf(coded), true, "文案换了也按错误码认")
  const plain = viewerListRefusal("连接已断开")
  assert.equal("code" in plain, false)
  assert.equal(viewerRosterAdminOnlyOf(plain), false)
})

test("工具名占位：模型开始调用工具时没报名字就留空（不写 \"tool\"），名字到达后补上；空名不盖掉已知名字", () => {
  const toolBlocks = (s) => s.items.flatMap((item) => (item.kind === "assistant" ? item.blocks : [])).filter((b) => b.kind === "tool")
  let s = reduceTranscript(emptyTranscript(), { type: "message-start", message: { role: "assistant", content: [] } })
  s = reduceTranscript(s, { type: "message-update", event: { type: "toolcall_start", contentIndex: 0 } })
  assert.equal(toolBlocks(s)[0].name, "", "名字没到：不写占位")
  s = reduceTranscript(s, { type: "message-update", event: { type: "toolcall_delta", contentIndex: 0, delta: '{"command":"ls"}' } })
  s = reduceTranscript(s, { type: "message-update", event: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "t1", name: "bash", arguments: { command: "ls" } } } })
  assert.equal(toolBlocks(s)[0].name, "bash", "名字到了就更新")

  // 执行事件先到、不带名字：同样留空；之后带名字的更新补上；再来的空名不盖掉
  let r = reduceTranscript(emptyTranscript(), { type: "tool", id: "t2", patch: { name: "", state: "input-streaming" } })
  assert.equal(toolBlocks(r)[0].name, "")
  r = reduceTranscript(r, { type: "tool", id: "t2", patch: { name: "read", outputText: "a" } })
  r = reduceTranscript(r, { type: "tool", id: "t2", patch: { name: "", outputText: "ab" } })
  assert.equal(toolBlocks(r)[0].name, "read")
  r = reduceTranscript(r, { type: "message-end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t2", name: "", arguments: { path: "a" } }] } })
  assert.equal(toolBlocks(r).at(-1).name, "read", "定稿消息没带名字时用已知名字，不退回占位")

  assert.doesNotMatch(src("../ui/src/relay/transcript.ts"), /\|\| "tool"/, "数据层不再写占位名")
  assert.doesNotMatch(src("../ui/src/relay/useRelay.ts"), /toolName \|\| "tool"/)
  assert.match(src("../ui/src/components/pi/conversation/tools.ts"), /return !b\.name \|\| \(b\.name === "tool" && b\.input == null\) \? null : b\.name/, "界面把空名当「还没报名字」")
})
