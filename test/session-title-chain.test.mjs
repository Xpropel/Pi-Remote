// 会话标题链：会话名 → 首条消息 → 工作区名；设备标签（PI_REMOTE_LABEL，如「我的电脑」）永远不当会话名，
// 原始会话编号不进标题位。三段分别验：网页（titleText / devices / attention / lazySession / inboxView /
// sidebarSource 同一出口）、扩展（room_register / room_label 单列 sessionName）、relay（room_list.name 的来源），
// 以及旧扩展（label=设备标签、没有 sessionName）时网页的回落。
// Node ≥ 22.18 原生剥离 TS 类型，直接 import .ts 源文件。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { createJiti } from "jiti"
import { UNTITLED_SESSION_TITLE, sessionTitleOf } from "../ui/src/relay/titleText.ts"
import { mergeDeviceSessions } from "../ui/src/relay/devices.ts"
import { attentionRoomTitle } from "../ui/src/relay/attention.ts"
import { lazyRoomFromRow } from "../ui/src/relay/lazySession.ts"
import { inboxEntryTitleOf } from "../ui/src/pi/model/inboxView.ts"
import { attentionTitledBySessions, sidebarDataOf } from "../ui/src/pi/model/sidebarSource.ts"

const require = createRequire(import.meta.url)
const WebSocket = require("ws")
const { startRelay } = require("../relay/server.js")

// 扩展在模块加载时读环境变量：先把设备标签设成真实环境里的「我的电脑」再加载
process.env.PI_REMOTE_LABEL = "我的电脑"
process.env.PI_REMOTE_LOG = path.join(os.tmpdir(), "pi-remote-session-title-test.log")
process.env.PI_REMOTE_TOKEN = ""
delete process.env.PI_REMOTE_DEVICE_ID
delete process.env.PI_REMOTE_ACCOUNT
delete process.env.PI_REMOTE_DEVICE_NAME
delete process.env.PI_REMOTE_ALWAYS_ONLINE
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

const device = { id: "fc2f1b28", accountId: "admin", name: "Windows", platform: "windows", online: true, projects: [], lastAttachAt: 1 }
/** 旧扩展注册的房间：未命名时 label 是设备标签 */
const oldRoom = (id, extra = {}) => ({
  id, label: "我的电脑", name: null, cwd: "D:\\pi-e2e\\s3", online: true, busy: false, viewers: 0, deviceId: device.id, ...extra,
})
const entry = (id, extra = {}) => ({
  id, cwd: "D:\\pi-e2e\\s3", messageCount: 2, updatedAt: 5, active: false, online: false, ...extra,
})

/* ---------------- 网页：同一出口 ---------------- */

test("sessionTitleOf：会话名 → 首条消息（清洗）→ 工作区名 → 占位；label 和会话 id 都不是素材", () => {
  assert.equal(sessionTitleOf({ name: "登录重构", firstMessage: "帮我看看", cwd: "D:\\work\\app" }), "登录重构")
  assert.equal(sessionTitleOf({ name: "  ", firstMessage: "帮我\n  看看", cwd: "D:\\work\\app" }), "帮我 看看")
  assert.equal(sessionTitleOf({ firstMessage: "\u0007", cwd: "D:\\work\\app\\" }), "app")
  assert.equal(sessionTitleOf({ label: "我的电脑", id: "0f3c9a7e-5d1b-4c2a-9e8f-123456789abc" }), UNTITLED_SESSION_TITLE)
  assert.equal(sessionTitleOf(null, undefined), UNTITLED_SESSION_TITLE)
  // 多份素材逐档取：任一份的会话名都压过另一份的首条消息，与先后无关
  assert.equal(sessionTitleOf({ firstMessage: "首条" }, { name: "清单里的名字" }), "清单里的名字")
  assert.equal(sessionTitleOf({ cwd: "/w/a" }, { firstMessage: "首条" }), "首条")
})

test("旧扩展（label=「我的电脑」、没有会话名）：侧栏行与注意力标题是首条消息，其次工作区名", () => {
  const rooms = [
    oldRoom("a", { firstMessage: "修一下登录页" }),
    oldRoom("b", { firstMessage: "跑一遍测试", cwd: "D:\\pi-e2e\\s4" }),
    oldRoom("c", { cwd: "D:\\pi-e2e\\s6" }),
  ]
  const rows = mergeDeviceSessions(device, rooms, [])
  assert.deepEqual(
    rows.map((row) => [row.id, row.title]).sort(),
    [["a", "修一下登录页"], ["b", "跑一遍测试"], ["c", "s6"]],
  )
  assert.deepEqual(rooms.map(attentionRoomTitle), ["修一下登录页", "跑一遍测试", "s6"])
})

test("有会话名（/name 或网页改名）时处处是会话名：房间 name、清单条目 name 都算，label 不算", () => {
  const named = oldRoom("a", { label: "我的电脑", name: "登录重构", firstMessage: "修一下登录页" })
  assert.equal(mergeDeviceSessions(device, [named], [])[0].title, "登录重构")
  assert.equal(attentionRoomTitle(named), "登录重构")
  // 房间还没带上名字（旧 relay 索引未到）、清单条目已有：用清单条目的名字
  const rows = mergeDeviceSessions(device, [oldRoom("a", { firstMessage: "修一下登录页" })], [entry("a", { name: "清单改的名", firstMessage: "修一下登录页" })])
  assert.equal(rows[0].title, "清单改的名")
})

test("未载入会话的合成房间：推出来的标题不冒充会话名，后到的真名能接上", () => {
  const row = {
    id: "z", deviceId: device.id, title: "修一下登录页", firstMessage: "修一下登录页", cwd: "D:\\pi-e2e\\s3",
    online: false, busy: false, viewers: 0, messageCount: 2, updatedAt: 5, openable: false,
  }
  const lazy = lazyRoomFromRow(row)
  assert.equal(lazy.name, null)
  assert.equal(attentionRoomTitle(lazy), "修一下登录页")
  const merged = mergeDeviceSessions(device, [lazy], [entry("z", { name: "后来改的名", firstMessage: "修一下登录页" })])
  assert.equal(merged[0].title, "后来改的名")
  const namedLazy = lazyRoomFromRow({ ...row, title: "登录重构" })
  assert.equal(namedLazy.name, "登录重构", "和首条消息、目录名都对不上的标题才是会话名")
  assert.equal(attentionRoomTitle(namedLazy), "登录重构")
})

test("待答标题：先用侧栏行（含同目录同名的时间后缀），再用房间，最后设备名", () => {
  const item = { key: "turn:a:1", accountId: "admin", roomId: "a", deviceId: device.id, kind: "done", subkind: "turn", at: 1 }
  const rooms = new Map([["a", oldRoom("a", { firstMessage: "修一下登录页" })]])
  const rows = new Map([["a", { id: "a", title: "修一下登录页 · 14:05" }]])
  const devices = new Map([[device.id, device]])
  assert.equal(inboxEntryTitleOf(item, rooms, rows, devices), "修一下登录页 · 14:05")
  assert.equal(inboxEntryTitleOf(item, rooms, new Map(), devices), "修一下登录页")
  assert.equal(inboxEntryTitleOf(item, new Map(), new Map(), devices), "Windows")
  assert.equal(inboxEntryTitleOf({ ...item, deviceId: null }, new Map(), new Map(), new Map()), "会话")
})

test("侧栏注意力条目与同一会话的侧栏行同名：同目录同首条消息时带同样的时间后缀", () => {
  const twin = (id, createdAt, extra = {}) => oldRoom(id, { firstMessage: "跑一遍测试", createdAt, lastActivity: createdAt, ...extra })
  const rooms = [
    twin("a", Date.UTC(2026, 10, 13, 6, 5)),
    twin("b", Date.UTC(2026, 10, 13, 7, 30), { waiting: [{ dialogId: "d1", title: "确认删除？", startedAt: 9, answerable: true }] }),
  ]
  const data = sidebarDataOf({
    devices: [device], rooms, sessionsByDevice: {}, roomId: "a",
    dialogs: [], uiPrompt: null, turnEnd: null, roomTurnEnds: [], selectedDevice: device,
  })
  const row = data.sessions.find((s) => s.id === "b")
  assert.match(row.title, /^跑一遍测试 · /, "同目录同名的两个活会话带开始时间后缀")
  const waiting = data.attention.find((i) => i.roomId === "b" && i.kind === "waiting")
  assert.equal(waiting.title, row.title)
})

test("attentionTitledBySessions：设备掉线条目、设备对不上的行、没有行的条目都不改", () => {
  const items = [
    { key: "device:x", kind: "device-offline", roomId: "", deviceId: "x", dialogId: null, title: "Mac", detail: "", at: 0 },
    { key: "dialog:a:1", kind: "waiting", roomId: "a", deviceId: device.id, dialogId: "1", title: "旧标题", detail: "", at: 1 },
    { key: "dialog:b:1", kind: "waiting", roomId: "b", deviceId: "other", dialogId: "1", title: "别的设备", detail: "", at: 2 },
    { key: "turn:c:1", kind: "done", roomId: "c", deviceId: null, dialogId: null, title: "没有行", detail: "", at: 3 },
  ]
  const sessions = [
    { id: "a", deviceId: device.id, title: "行标题 a" },
    { id: "b", deviceId: device.id, title: "行标题 b" },
  ]
  assert.deepEqual(attentionTitledBySessions(items, sessions).map((i) => i.title), ["Mac", "行标题 a", "别的设备", "没有行"])
})

test("useRelay.roomTitle 只转调 sessionTitleOf（桌面/手机顶栏、标签页标题、切换提示共用）", () => {
  const src = fs.readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  assert.match(src, /export function roomTitle\(room: RoomInfo \| null\) \{\s*return room \? sessionTitleOf\(room\) : "选择一个会话"/)
})

/* ---------------- 扩展：label 不再带设备标签，会话名单列 ---------------- */

test("扩展：PI_REMOTE_LABEL 不进房间 label；room_register 与改名的 room_label 都单列 sessionName", () => {
  const bridge = new ext.Bridge()
  bridge.platform = "win32"
  bridge.roomId = "r1"
  bridge.cwd = "D:\\pi-e2e\\s3"
  const unnamed = bridge.roomPayload()
  assert.equal(unnamed.label, "s3", "未命名：目录名，不是「我的电脑」")
  assert.equal(unnamed.sessionName, null)
  bridge.sessionName = "登录重构"
  assert.equal(bridge.roomPayload().label, "登录重构")
  assert.equal(bridge.roomPayload().sessionName, "登录重构")

  const sent = []
  bridge.send = (frame) => {
    sent.push(frame)
    return true
  }
  bridge.emitEvent = () => {}
  bridge.syncOutboundQueue = () => {}
  bridge.enqueueManifest = () => {}
  bridge.authed = true
  bridge.forward({ type: "session_info_changed", name: "新名字" })
  assert.deepEqual(sent.find((f) => f.type === "room_label"), { type: "room_label", room: "r1", label: "新名字", sessionName: "新名字" })
})

/* ---------------- relay：room_list.name 的来源 ---------------- */

const LOCAL_TOKEN = "session-title-local-token-9f2c"
const VIEWER_TOKEN = "session-title-viewer-token-4b7e"

async function bootRelay(t) {
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-title-")),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
  })
  t.after(() => relay.close())
  return relay
}

/** 收帧客户端：wait 先看 from 之后已收到的帧，再等后到的 */
async function client(t, port, hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  const frames = []
  const waiters = []
  ws.on("message", (data) => {
    const frame = JSON.parse(data.toString())
    frames.push(frame)
    for (const w of [...waiters]) {
      if (!w.pred(frame)) continue
      waiters.splice(waiters.indexOf(w), 1)
      clearTimeout(w.timer)
      w.resolve(frame)
    }
  })
  await new Promise((resolve, reject) => {
    ws.once("open", resolve)
    ws.once("error", reject)
  })
  t.after(() => ws.terminate())
  const api = {
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    wait(pred, what = "frame", ms = 3000, from = 0) {
      const hit = frames.slice(from).find(pred)
      if (hit) return Promise.resolve(hit)
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error(`等待 ${what} 超时；已收到：${frames.map((f) => f.type).join(",")}`))
        }, ms) }
        waiters.push(w)
      })
    },
  }
  api.send(hello)
  await api.wait((f) => f.type === "auth_result", "auth_result")
  return api
}

const roomIn = (list, id) => (list.type === "room_list" && Array.isArray(list.rooms) ? list.rooms.find((r) => r.id === id) : undefined)

test("relay：新扩展声明的 sessionName 即时成为 room_list.name，改名走 room_label 不等清单", async (t) => {
  const relay = await bootRelay(t)
  const extension = await client(t, relay.localPort, { type: "auth", role: "local", token: LOCAL_TOKEN })
  extension.send({ type: "room_register", room: { id: "r-new", label: "登录重构", sessionName: "登录重构", cwd: "D:\\pi-e2e\\s3", epoch: 1, instance: "i-new" } })
  await extension.wait((f) => f.type === "room_registered", "room_registered")
  const viewer = await client(t, relay.viewerPort, { type: "auth", role: "viewer", token: VIEWER_TOKEN })
  viewer.send({ type: "list_rooms" })
  await viewer.wait((f) => roomIn(f, "r-new")?.name === "登录重构", "带会话名的 room_list")

  extension.send({ type: "room_label", room: "r-new", label: "新名字", sessionName: "新名字" })
  const renamed = await viewer.wait((f) => roomIn(f, "r-new")?.name === "新名字", "改名后的 room_list")
  assert.equal(roomIn(renamed, "r-new").label, "新名字")
})

test("relay：旧扩展（label=「我的电脑」、无 sessionName）与未声明会话名时，name 来自会话索引；label 原样透传", async (t) => {
  const relay = await bootRelay(t)
  const DEV = "dev-title"
  const win = await client(t, relay.localPort, {
    type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps: [],
    client: { kind: "attach", version: "4.0.0", platform: "windows" },
  })
  win.send({ type: "device_register", device: { id: DEV, name: "Windows", platform: "windows", projects: [] } })
  await win.wait((f) => f.type === "room_list", "设备窗口的 room_list")
  const beforeManifest = win.frames.length
  win.send({
    type: "session_manifest", deviceId: DEV, full: true, scope: "device", root: "/sessions", updatedAt: Date.now(),
    sessions: [
      { id: "s-old", path: "/sessions/--s3--/1700000000000_s-old.jsonl", cwd: "D:\\pi-e2e\\s3", name: "索引里的名字", firstMessage: "修一下登录页", updatedAt: Date.now() },
      { id: "s-null", path: "/sessions/--s3--/1700000000001_s-null.jsonl", cwd: "D:\\pi-e2e\\s3", name: "索引名", firstMessage: "跑一遍测试", updatedAt: Date.now() },
    ],
  })
  await win.wait((f) => f.type === "room_list", "清单后的 room_list", 3000, beforeManifest)

  const oldExt = await client(t, relay.localPort, { type: "auth", role: "local", token: LOCAL_TOKEN })
  oldExt.send({ type: "room_register", room: { id: "s-old", label: "我的电脑", cwd: "D:\\pi-e2e\\s3", deviceId: DEV, epoch: 1, instance: "i-old" } })
  await oldExt.wait((f) => f.type === "room_registered", "room_registered")
  const newExt = await client(t, relay.localPort, { type: "auth", role: "local", token: LOCAL_TOKEN })
  newExt.send({ type: "room_register", room: { id: "s-null", label: "s3", sessionName: null, cwd: "D:\\pi-e2e\\s3", deviceId: DEV, epoch: 1, instance: "i-null" } })
  await newExt.wait((f) => f.type === "room_registered", "room_registered")

  const viewer = await client(t, relay.viewerPort, { type: "auth", role: "viewer", token: VIEWER_TOKEN })
  viewer.send({ type: "list_rooms" })
  const list = await viewer.wait((f) => roomIn(f, "s-old")?.online === true && roomIn(f, "s-null")?.online === true, "两个房间都在线的 room_list")
  assert.equal(roomIn(list, "s-old").name, "索引里的名字")
  assert.equal(roomIn(list, "s-old").label, "我的电脑", "relay 不改 label，网页不拿它当标题")
  assert.equal(roomIn(list, "s-null").name, "索引名", "声明 null（拿不到会话名的旧 pi）不能盖掉索引里的名字")
})
