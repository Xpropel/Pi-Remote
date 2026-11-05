// C-D1 回归：未载入（存储）会话的点选状态要跨重载/换壳恢复。
// 纯函数部分测 lazySession 的存取解析；useRelay 的接线按本仓惯例做源码断言
// （不启动浏览器、不依赖 React；Node 原生剥离 TS 类型直接 import .ts）。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  LAZY_SESSION_STORAGE_KEY,
  lazyRoomFromRow,
  lazySendCryptoBlocked,
  parseLazySelection,
  serializeLazySelection,
} from "../ui/src/relay/lazySession.ts"

const fullSelection = {
  id: "sess-seq-200",
  deviceId: "dev-b",
  title: "用 bash 输出 seq 1 200 并统计总和",
  firstMessage: "用 bash 输出 seq 1 200",
  path: "/home/u/.pi/sessions/sess-seq-200.jsonl",
  cwd: "/home/u/demo2",
  online: false,
  busy: false,
  viewers: 0,
  messageCount: 12,
  updatedAt: 1730000000000,
  openable: false,
}

test("parseLazySelection：serialize 的往返不丢展示字段，合成房间标题与点选时一致", () => {
  const parsed = parseLazySelection(serializeLazySelection(fullSelection))
  assert.deepEqual(parsed, fullSelection)
  // 恢复出的选择喂给 lazyRoomFromRow：标题链（title → firstMessage → cwd）与内存点选同结果
  assert.equal(lazyRoomFromRow(parsed).label, lazyRoomFromRow(fullSelection).label)
  assert.equal(lazyRoomFromRow(parsed).deviceId, "dev-b")
  assert.equal(LAZY_SESSION_STORAGE_KEY, "pi_lazy_session")
})

test("parseLazySelection：坏载荷一律恢复为空（不猜、不抛）", () => {
  assert.equal(parseLazySelection(null), null)
  assert.equal(parseLazySelection(""), null)
  assert.equal(parseLazySelection("{broken"), null)
  assert.equal(parseLazySelection("[]"), null)
  assert.equal(parseLazySelection("42"), null)
  assert.equal(parseLazySelection(JSON.stringify({ deviceId: "dev-b" })), null, "缺 id")
  assert.equal(parseLazySelection(JSON.stringify({ id: "sess-1" })), null, "缺 deviceId")
  assert.equal(parseLazySelection(JSON.stringify({ id: "", deviceId: "dev-b" })), null, "空 id")
  assert.equal(parseLazySelection(JSON.stringify({ id: "sess-1", deviceId: "" })), null, "空 deviceId")
})

test("parseLazySelection：类型不对的字段降级为中性值，不把脏数据带进界面", () => {
  const parsed = parseLazySelection(
    JSON.stringify({
      id: "sess-1",
      deviceId: "dev-a",
      title: 42,
      firstMessage: "第一条消息",
      cwd: "/work/demo",
      online: "yes",
      busy: 1,
      viewers: "3",
      messageCount: Number.NaN,
      updatedAt: "昨天",
      openable: "true",
      enc: "yes",
      encReason: "not-a-reason",
      parentLabel: 7,
    }),
  )
  assert.deepEqual(parsed, {
    id: "sess-1",
    deviceId: "dev-a",
    title: "",
    firstMessage: "第一条消息",
    cwd: "/work/demo",
    online: false,
    busy: false,
    viewers: 0,
    messageCount: 0,
    updatedAt: 0,
    openable: false,
  })
  // title 脏了就走 firstMessage 回落链，和侧栏行同一口径
  assert.equal(lazyRoomFromRow(parsed).label, "第一条消息")
})

test("parseLazySelection：合法的可选字段（enc / encReason / parentLabel）保留", () => {
  const parsed = parseLazySelection(
    JSON.stringify({ id: "sess-2", deviceId: "dev-a", title: "t", cwd: "/w", enc: true, encReason: "sealed", parentLabel: "源会话" }),
  )
  assert.equal(parsed.enc, true)
  assert.equal(parsed.encReason, "sealed")
  assert.equal(parsed.parentLabel, "源会话")
})

const relay = readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")

test("useRelay 接线：setLazySelection 是唯一写口，选入落盘、清除删键", () => {
  assert.match(
    relay,
    /if \(selection\) safeStore\.session\.set\(LAZY_SESSION_STORAGE_KEY, serializeLazySelection\(selection\)\)\s*\n\s*else safeStore\.session\.remove\(LAZY_SESSION_STORAGE_KEY\)/,
    "setLazySelection 必须同步维护 sessionStorage 副本",
  )
})

test("useRelay 接线：clearRoom 同时清 pi_room 与未载入选择的存档键", () => {
  const at = relay.indexOf("function clearRoom()")
  const body = relay.slice(at, at + 2400)
  assert.match(body, /safeStore\.session\.remove\("pi_room"\)/)
  assert.match(body, /safeStore\.session\.remove\(LAZY_SESSION_STORAGE_KEY\)/)
})

test("useRelay 接线：重载恢复——roomId 回落到存档的未载入会话 id，pi_room 在场时压制懒恢复", () => {
  assert.match(
    relay,
    /useState\(\(\) => safeStore\.session\.get\("pi_room"\) \|\| readStoredLazySelection\(\)\?\.id \|\| ""\)/,
    "roomId 初值：pi_room → 存档的未载入会话 → 空",
  )
  assert.match(
    relay,
    /useState<LazySelection \| null>\(\(\) =>\s*\n?\s*safeStore\.session\.get\("pi_room"\) \? null : readStoredLazySelection\(\),\s*\n?\s*\)/,
    "lazySession 状态初值从存档恢复，且 pi_room 在场时不恢复",
  )
  assert.match(
    relay,
    /useRef<LazySelection \| null>\(safeStore\.session\.get\("pi_room"\) \? null : readStoredLazySelection\(\)\)/,
    "lazySessionRef 与状态同源恢复（auth_result 的懒分支读的是 ref）",
  )
})

test("useRelay 接线：恢复时草稿归属与草稿初值都指向未载入会话（草稿随记录回来）", () => {
  assert.match(
    relay,
    /draftOwnerRef = useRef\(safeStore\.session\.get\("pi_room"\) \|\| readStoredLazySelection\(\)\?\.id \|\| ""\)/,
    "草稿归属初值回落到未载入会话 id，落盘防抖才写得回正确的槽",
  )
  assert.match(
    relay,
    /if \(safeStore\.session\.get\("pi_room"\)\) return ""\s*\n\s*const lazy = readStoredLazySelection\(\)\s*\n\s*return lazy \? readRoomDraft\(lazy\.id\) : ""/,
    "无 pi_room 时草稿初值从未载入会话的落盘槽读入（它不会被 subscribe 唤醒）",
  )
})

test("useRelay 接线：恢复的设备成为初始选中设备（applyRoster 仍可纠正）", () => {
  assert.match(
    relay,
    /safeStore\.session\.get\("pi_room"\) \? null : readStoredLazySelection\(\)\?\.deviceId \?\? null/,
    "selectedDeviceId 初值取存档选择的 deviceId",
  )
})

test("useRelay 接线：auth_result 的懒分支不订阅别的房间，且设备在线时按在线呈现", () => {
  const at = relay.indexOf("if (lazySessionRef.current) {")
  const body = relay.slice(at, relay.indexOf("} else if (!deviceModeRef.current) {", at))
  assert.match(body, /if \(lazyDevice\?\.online\) setOnline\(true\)/)
  assert.doesNotMatch(body, /subscribeRef\.current/, "懒分支里不能订阅任何房间")
})

// D-2 回归：无身份（令牌）观看端认领加密存储会话时，中继在 subscribe 处以
// crypto_required 拒绝且永不下发 subscribed/snapshot，惰性发送等不到 room-ready。
// 修复口径：拒绝命中待发队列时立即以真实原因失败，不再干等通用超时。
const mkSend = (phase, sessionId = "sess-enc") => ({ token: 7, sessionId, deviceId: "dev-b", phase, text: "hi", image: null, cid: "cid-1" })

test("D-2 lazySendCryptoBlocked：命中本房且未提交才判死", () => {
  assert.equal(lazySendCryptoBlocked(null, "sess-enc"), false)
  assert.equal(lazySendCryptoBlocked(mkSend("starting"), "sess-enc"), true)
  assert.equal(lazySendCryptoBlocked(mkSend("waiting"), "sess-enc"), true)
  // 已提交（room-ready 已过）：订阅拒绝只影响观看，不能误杀已发出的消息
  assert.equal(lazySendCryptoBlocked(mkSend("sending"), "sess-enc"), false)
  // 别房的拒绝与本队列无关
  assert.equal(lazySendCryptoBlocked(mkSend("waiting"), "sess-other"), false)
  assert.equal(lazySendCryptoBlocked(mkSend("waiting", "sess-other"), "sess-enc"), false)
  // 无房号（错误帧没带 room）不猜
  assert.equal(lazySendCryptoBlocked(mkSend("waiting"), ""), false)
})

test("D-2 useRelay 接线：crypto_required 分支对命中的待发惰性发送立即失败并给真实原因", () => {
  const at = relay.indexOf('if (code === "crypto_required")')
  assert.ok(at > 0, "crypto_required 分支存在")
  const body = relay.slice(at, relay.indexOf('if (type === "usage_state")', at))
  assert.match(body, /lazySendCryptoBlocked\(lazySendRef\.current, roomId\)/)
  assert.match(body, /failLazySendRef\.current\("这个会话已加密：请先在设置里启用观看端身份，再重新发送。"/)
  // 房间级加密状态记录保持在失败动作之前（观看面不受影响）
  assert.ok(body.indexOf("noteRoomCryptoStatus") < body.indexOf("lazySendCryptoBlocked"))
})
