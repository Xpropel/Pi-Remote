// R3-1 注意力恢复通道·跨半集成（第 3 轮审查 A-4）：
// 此前 relay 半（relay.test.js 真 WS）与 UI 半（attention.test.mjs 手工复刻喂养顺序）
// 从不在同一条用例相遇，useRelay 的胶水（track 边沿 → seed 种子 → commit → 清单）
// 只有正则断言兜底。本文件起真 relay，用它产出的 room_attention 帧与 room_list
// 快照原样喂 UI 的种子合并入口（与 useRelay 归约完全同序同函数），终点断言
// attentionItemsOf 的清单条目：实时帧恢复 / 快照恢复 / 双路去重 / 清除不复活。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { startRelay } from "../relay/server.js"
import {
  attentionItemsOf,
  emptyRoomTurnTracker,
  forgetRoomTurnEnd,
  roomAttentionSeedOf,
  roomTurnEndsOf,
  roomTurnSeedsOf,
  seedRoomTurnEnds,
  trackRoomListEdges,
} from "../ui/src/relay/attention.ts"
import { parseRooms } from "../ui/src/relay/devices.ts"
import { authFrame } from "../ui/src/relay/protocol.ts"

const ROOM = "room-attn-1"
const CURRENT = "room-current" // 用户正坐在别的房间里看侧栏（别房落定才成条）
const LOCAL_TOKEN = "local-token-attn-integ-0001"
const VIEWER_TOKEN = "viewer-token-attn-integ-01"
const ADMIN_TOKEN = "admin-token-attn-integ-001"

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-attn-integ-"))
}

function boot() {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: tmpDir(),
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

/** 收帧客户端：与 relay.test.js 同款语义（wait 返回第一条未被取走且满足条件的帧）。 */
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
    ws,
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

async function local(relay) {
  const c = client(relay.localPort)
  await c.opened
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN })
  await c.type("auth_result")
  c.send({ type: "room_register", room: { id: ROOM, label: "t", cwd: "/tmp", epoch: 1, instance: "inst-a" } })
  await c.type("room_registered")
  return c
}

/** viewer 用网页端真实的 authFrame 握手（含 A-1 补声明的 room.attention cap）。 */
async function viewer(relay) {
  const v = client(relay.viewerPort)
  await v.opened
  v.send(authFrame(VIEWER_TOKEN))
  const auth = await v.type("auth_result")
  assert.equal(auth.ok, true)
  return { v, auth }
}

/** 与 useRelay 名册归约完全同序：先边沿记账，再把同一份原始名册的摘要种回。 */
function applyRoster(tracker, rawRooms, currentRoomId) {
  return seedRoomTurnEnds(
    trackRoomListEdges(tracker, parseRooms(rawRooms), currentRoomId),
    roomTurnSeedsOf(rawRooms),
    currentRoomId,
  )
}

/** 与 useRelay 暴露 roomTurnEnds 后 Sidebar 的消费同路：清单只看快照派生。 */
function turnItems(tracker, rooms) {
  return attentionItemsOf({
    currentRoomId: CURRENT,
    rooms,
    dialogs: [],
    uiPrompt: null,
    turnEnd: null,
    roomTurnEnds: roomTurnEndsOf(tracker),
    selectedDevice: null,
  }).filter((item) => item.kind === "done" || item.kind === "error")
}

test("真 relay 帧形 → UI 种子合并全链：实时帧恢复 / 快照恢复 / 双路去重 / 清除不复活", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const c = await local(relay)
  t.after(() => c.close())
  const { v } = await viewer(relay)
  t.after(() => v.close())

  const ev = (event) => c.send({ type: "event", room: ROOM, event })

  // —— 别房落定（done）：活动 → 助手终态 stop → settled，relay 广播真 room_attention 帧
  ev({ type: "agent_start" })
  ev({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "x" }], timestamp: 1, stopReason: "stop" },
  })
  ev({ type: "agent_settled" })
  const liveFrame = await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd && f.lastTurnEnd.kind === "done")

  // —— 路 A（实时帧）：空追踪器只吃这一帧的种子（useRelay 的 room_attention case 同路）
  let trackerA = emptyRoomTurnTracker()
  const parsed = roomAttentionSeedOf(liveFrame.room, liveFrame.lastTurnEnd)
  assert.ok(parsed && parsed.seed, "真帧能被 UI 侧提炼成种子")
  trackerA = seedRoomTurnEnds(trackerA, [parsed.seed], CURRENT)

  // 名册快照（真 relay 产出）解析成 UI 的 rooms，终点断言清单条目
  v.send({ type: "list_rooms" })
  const list1 = await v.type("room_list")
  const rooms = parseRooms(list1.rooms)
  const itemsA = turnItems(trackerA, rooms)
  assert.equal(itemsA.length, 1, "实时帧种子恢复出一条别房落定")
  assert.equal(itemsA[0].roomId, ROOM)
  assert.equal(itemsA[0].kind, "done")
  assert.equal(itemsA[0].at, liveFrame.lastTurnEnd.at, "条目时刻与 relay 摘要一致")

  // —— 去重：同一落定再经名册种子到达（useRelay 名册归约同序），仍只一条、记录不被改写
  const before = roomTurnEndsOf(trackerA)[0]
  trackerA = applyRoster(trackerA, list1.rooms, CURRENT)
  const after = roomTurnEndsOf(trackerA)
  assert.equal(after.length, 1, "双路到达只留一条")
  assert.deepEqual(after[0], before, "先到为准：键/时刻/序号都不被后到的种子改写")
  assert.equal(turnItems(trackerA, rooms).length, 1)

  // —— 路 B（刷新恢复）：全新追踪器从没见过实时帧，只吃同一份名册快照，照样恢复
  let trackerB = applyRoster(emptyRoomTurnTracker(), list1.rooms, CURRENT)
  const itemsB = turnItems(trackerB, rooms)
  assert.equal(itemsB.length, 1, "刷新后仅凭 room_list 快照恢复")
  assert.equal(itemsB[0].kind, "done")
  assert.equal(itemsB[0].at, liveFrame.lastTurnEnd.at)

  // —— 清除全链：另一 viewer 进房 → relay 清摘要并广播真 null 帧 → UI forget → 条目消失
  const { v: v2 } = await viewer(relay)
  t.after(() => v2.close())
  v2.send({ type: "subscribe", room: ROOM })
  await v2.type("subscribed")
  const clearFrame = await v.type("room_attention", (f) => f.room === ROOM && f.lastTurnEnd === null)
  const parsedClear = roomAttentionSeedOf(clearFrame.room, clearFrame.lastTurnEnd)
  assert.ok(parsedClear && parsedClear.seed === null, "null 帧是已清信号")
  trackerA = forgetRoomTurnEnd(trackerA, parsedClear.roomId)
  trackerB = forgetRoomTurnEnd(trackerB, parsedClear.roomId)
  assert.equal(turnItems(trackerA, rooms).length, 0, "清除后清单条目消失（路 A）")
  assert.equal(turnItems(trackerB, rooms).length, 0, "清除后清单条目消失（路 B）")

  // —— 不复活：清除后再来一份名册快照，摘要已是 null，种子为空，清过的记录不回来
  v.send({ type: "list_rooms" })
  const list2 = await v.type("room_list")
  assert.equal(roomTurnSeedsOf(list2.rooms).length, 0, "清除后快照里无可种摘要")
  trackerA = applyRoster(trackerA, list2.rooms, CURRENT)
  trackerB = applyRoster(trackerB, list2.rooms, CURRENT)
  assert.equal(turnItems(trackerA, parseRooms(list2.rooms)).length, 0)
  assert.equal(turnItems(trackerB, parseRooms(list2.rooms)).length, 0)
})

test("P9 A：网页握手声明 room.dialogs；room_waiting 帧按 useRelay 同序归约后派生「等你回答」", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const { v } = await viewer(relay)
  t.after(() => v.close())

  // 能力声明（A-6：声明必须与落地同轮）。relay 侧的 room_waiting 广播在 relay 线实现，
  // 本 worktree 的 relay/ 还没落；这里验网页声明 + 帧形归约，等 relay 落地后同一条用例
  // 换成真帧即可（帧形与协议 §3.2 一致）。
  const caps = authFrame(VIEWER_TOKEN).caps
  assert.ok(caps.includes("room.dialogs"), "网页声明 room.dialogs")
  assert.ok(caps.includes("session.purge"), "网页声明 session.purge（P9 B）")

  // 与 useRelay 的 room_waiting 分支同序：parseRooms([{id,online:true,waiting,waitingPrompt}])
  // → 整个替换该房间条目的摘要（每帧全量，不做增量）。
  const applyWaiting = (rooms, frame) => {
    const [patched] = parseRooms([{ id: frame.room, online: true, waiting: frame.waiting, waitingPrompt: frame.waitingPrompt }])
    return rooms.map((room) =>
      room.id === frame.room ? { ...room, waiting: patched?.waiting ?? [], waitingPrompt: patched?.waitingPrompt ?? null } : room,
    )
  }
  const items = (rooms) =>
    attentionItemsOf({
      currentRoomId: CURRENT,
      rooms,
      dialogs: [],
      uiPrompt: null,
      turnEnd: null,
      roomTurnEnds: [],
      selectedDevice: null,
    })

  const base = parseRooms([
    { id: CURRENT, online: true, name: "当前会话" },
    { id: ROOM, online: true, name: "退 款 对账" },
  ])
  assert.deepEqual(items(base), [], "别房没在等时清单为空")

  // 帧 1：别房弹出一个 confirm（全量摘要）
  const rooms1 = applyWaiting(base, {
    type: "room_waiting",
    room: ROOM,
    waiting: [{ dialogId: "dlg-9", kind: "confirm", title: "允许执行 npm test？", startedAt: 1234, answerable: true }],
    waitingPrompt: null,
  })
  const found = items(rooms1)
  assert.equal(found.length, 1)
  assert.deepEqual(
    [found[0].key, found[0].kind, found[0].roomId, found[0].title, found[0].detail, found[0].at, found[0].answerable],
    ["dialog:dlg-9", "waiting", ROOM, "退 款 对账", "允许执行 npm test？", 1234, true],
  )

  // 帧 2：同房 waiting 变空 = 不在等，条目消失（全量替换）
  assert.deepEqual(items(applyWaiting(rooms1, { type: "room_waiting", room: ROOM, waiting: [], waitingPrompt: null })), [])

  // 帧 3：waiting 为空时旧 ui_prompt 兜底信号成一条（answerable=false → 只能在电脑上答）
  const rooms3 = applyWaiting(rooms1, {
    type: "room_waiting",
    room: ROOM,
    waiting: [],
    waitingPrompt: { kind: "confirm", title: "电脑上有一个确认框在等待", at: 2000 },
  })
  const fallback = items(rooms3)
  assert.equal(fallback.length, 1)
  assert.deepEqual([fallback[0].key, fallback[0].at, fallback[0].answerable], [`prompt:${ROOM}`, 2000, false])

  // 离线房间（relay 保证 waiting 恒空）：即便帧里带非空 waiting，名册里 offline 的条目也不成条
  const offline = parseRooms([{ id: CURRENT, online: true, name: "当前" }, { id: ROOM, online: false, name: "别房", waiting: [{ dialogId: "x" }] }])
  assert.deepEqual(items(offline), [])
})
