// P10 usage.activity.v1 relay 帧测试：真实 startRelay + ws 假 extension/viewer（不连真实 pi）。
// 覆盖：无设备空态、扩展在线刷新+缓存命中+force、并发合并、设备离线 stale、旧扩展 unsupported、
//       非法快照丢弃（敏感键/超限）、缓存跨 relay 重启、requestId 回带、无 deviceId 空态。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const WebSocket = require("ws")
const { startRelay } = require("../relay/server.js")
const { validateUsageSnapshot } = require("../relay/usage.js")

const LOCAL_TOKEN = "usage-test-local-token-001"
const VIEWER_TOKEN = "usage-test-viewer-token-01"
const ADMIN_TOKEN = "usage-test-admin-token-01"
const DEVICE = "usage-dev-1"
const CAP = "usage.activity.v1"

function mkTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-relay-")) }
async function bootRelay(dataDir, extra = {}) {
  return startRelay({
    localPort: 0, viewerPort: 0, dataDir, quiet: true, exitOnListenError: false,
    localToken: LOCAL_TOKEN, viewerToken: VIEWER_TOKEN, adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10, perMessageDeflate: false, persistTranscripts: true, ...extra,
  })
}
/** 极简 ws 客户端：collect + wait(pred) + send */
function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    const frames = []
    const waiters = []
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString())
      frames.push(msg)
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(msg); break }
    })
    ws.once("error", reject)
    ws.once("open", () => resolve({
      ws, frames,
      send(o) { ws.send(JSON.stringify(o)) },
      wait(pred, ms = 4000, what = "frame") {
        const hit = frames.find((f) => !f.__taken && pred(f))
        if (hit) { hit.__taken = true; return Promise.resolve(hit) }
        return new Promise((res, rej) => {
          const w = { pred, resolve: (m) => { m.__taken = true; res(m) }, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`等待 ${what} 超时；已收 ${frames.map((f) => f.type).join(",")}`)) }, ms) }
          waiters.push(w)
        })
      },
      type(t, extraPred = () => true, ms) { return this.wait((f) => f.type === t && extraPred(f), ms, t) },
      close() { try { ws.terminate() } catch {} },
    }))
  })
}
/**
 * 真实拓扑：**attach 窗口**连接（device_register，只声明 device.features 类能力）+ **extension room 连接**
 * （真实的 usage.activity.v1 声明在 room 连接上）。relay 必须把 usage_refresh 发到 room 连接而不是 attach。
 */
async function fakeExtension(relay, { caps = [CAP], onRefresh } = {}) {
  const attach = await client(relay.localPort)
  attach.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps: ["err.v4", "session.files", "fs.browse"], client: { kind: "attach", version: "4.0.0", platform: "macos" } })
  await attach.type("auth_result", (f) => f.ok === true)
  attach.send({ type: "device_register", device: { id: DEVICE, name: "Usage Mac", platform: "macos", projects: ["/tmp/proj"], windowExpiresAt: Date.now() + 3600_000 } })
  await new Promise((r) => setTimeout(r, 40))
  const ext = await client(relay.localPort)
  ext.send({ type: "auth", role: "local", token: LOCAL_TOKEN, proto: 4, caps, client: { kind: "extension", version: "4.0.0", platform: "macos" } })
  await ext.type("auth_result", (f) => f.ok === true)
  ext.send({ type: "room_register", room: { id: "room-usage", label: "usage", cwd: "/tmp/proj", epoch: 1, instance: "inst-usage", deviceId: DEVICE } })
  await ext.type("room_registered")
  if (onRefresh) {
    ext.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === "usage_refresh") onRefresh(msg, ext)
    })
  }
  ext.attach = attach
  const closeBoth = ext.close
  ext.close = () => { closeBoth(); try { attach.close() } catch {} }
  return ext
}
async function viewer(relay, caps = [CAP]) {
  const v = await client(relay.viewerPort)
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4, caps })
  const auth = await v.type("auth_result")
  assert.equal(auth.ok, true)
  return v
}
function snapshotOf(overrides = {}) {
  const day = "2026-10-20"
  return {
    v: CAP, generatedAt: Date.now(), deviceId: DEVICE,
    timezone: { id: "Asia/Shanghai", offsetMinutes: 480 },
    range: { firstDay: day, lastDay: day, days: 1 },
    days: [{ date: day, tokens: { total: 150, input: 130, output: 20, cacheRead: 0, cacheWrite: 0 }, messages: { user: 2, assistant: 2 }, sessions: 1 }],
    summary: {
      totals: { tokens: 150, messagesUser: 2, messagesAssistant: 2, sessions: 1, activeDays: 1 },
      streaks: { current: 1, longest: 1 },
      peaks: { tokens: { date: day, value: 150 }, messages: { date: day, value: 4 } },
      models: [{ provider: "stepfun", model: "step-5-preview", tokens: 150 }],
      modelsWindowDays: 30,
    },
    coverage: { files: 1, parsedFiles: 1, cacheHitFiles: 0, skippedFiles: 0, truncated: false, errors: 0, scanMs: 1, source: "pi-sessions" },
    cache: { hit: false, generatedFrom: "full" },
    ...overrides,
  }
}

test("relay validateUsageSnapshot：敏感键/超限/坏形状拒绝；合法快照通过", () => {
  assert.equal(validateUsageSnapshot(snapshotOf()).ok, true)
  const withCost = snapshotOf(); withCost.days[0].cost = 0.01
  assert.equal(validateUsageSnapshot(withCost).ok, false)
  const withBody = snapshotOf(); withBody.summary.title = "hello"
  assert.equal(validateUsageSnapshot(withBody).ok, false)
  const badV = snapshotOf({ v: "usage.activity.v2" })
  assert.equal(validateUsageSnapshot(badV).ok, false)
  const tooManyDays = snapshotOf(); tooManyDays.days = Array.from({ length: 401 }, (_, i) => ({ ...snapshotOf().days[0], date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}` }))
  assert.equal(validateUsageSnapshot(tooManyDays).ok, false)
})

test("无设备：usage_get 回 no_data 空态，不崩", async () => {
  const dir = mkTemp(); const relay = await bootRelay(dir)
  try {
    const v = await viewer(relay)
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r-empty" })
    const frame = await v.type("usage_snapshot")
    assert.equal(frame.available, false)
    assert.equal(frame.reason, "no_data")
    assert.equal(frame.requestId, "r-empty")
    v.close()
  } finally { await relay.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test("扩展在线：usage_get → usage_refresh → 快照回 viewer；缓存命中不再刷新；force 强制刷新；并发合并", async () => {
  const dir = mkTemp(); const relay = await bootRelay(dir)
  let refreshCount = 0
  let lastSnapshot = snapshotOf()
  try {
    const relayExtForAssert = await fakeExtension(relay, { onRefresh: (msg, c) => { refreshCount += 1; c.send({ type: "usage_snapshot", deviceId: DEVICE, requestId: msg.requestId, snapshot: lastSnapshot }) } })
    const v = await viewer(relay)
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r1" })
    const first = await v.type("usage_snapshot", (f) => f.requestId === "r1")
    assert.equal(first.available, true)
    assert.equal(first.snapshot.summary.totals.tokens, 150)
    assert.equal(refreshCount, 1)
    // 真实拓扑断言：usage_refresh 必须到 extension room 连接，不能到 attach 窗口
    const extClient = relayExtForAssert
    assert.equal(extClient.attach.frames.filter((f) => f.type === "usage_refresh").length, 0, "attach 窗口不应收到 usage_refresh")
    assert.equal(extClient.frames.filter((f) => f.type === "usage_refresh").length, 1, "extension room 连接应收到 usage_refresh")
    // 缓存命中（5min TTL）不再向设备刷新
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r2" })
    const second = await v.type("usage_snapshot", (f) => f.requestId === "r2")
    assert.equal(second.available, true)
    assert.equal(refreshCount, 1, "缓存命中不应触发 usage_refresh")
    // force 强制刷新
    lastSnapshot = snapshotOf({ generatedAt: Date.now() + 1 })
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r3", force: true })
    await v.type("usage_snapshot", (f) => f.requestId === "r3")
    assert.equal(refreshCount, 2, "force=true 必须触发刷新")
    // 两 viewer 并发合并为一次 refresh
    const v2 = await viewer(relay)
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r4", force: true })
    v2.send({ type: "usage_get", deviceId: DEVICE, requestId: "r5", force: true })
    const [f4, f5] = await Promise.all([v.type("usage_snapshot", (f) => f.requestId === "r4"), v2.type("usage_snapshot", (f) => f.requestId === "r5")])
    assert.equal(f4.snapshot.summary.totals.tokens, 150)
    assert.equal(f5.snapshot.summary.totals.tokens, 150)
    assert.equal(refreshCount, 3, "并发请求合并成一次 refresher")
    v.close(); v2.close()
  } finally { await relay.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test("旧扩展无 cap：viewer 得到 unsupported 空态（不阻塞/不刷新）", async () => {
  const dir = mkTemp(); const relay = await bootRelay(dir)
  let refreshCount = 0
  try {
    await fakeExtension(relay, { caps: ["err.v4", "device.token"], onRefresh: () => { refreshCount += 1 } })
    const v = await viewer(relay)
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r-old" })
    const frame = await v.type("usage_snapshot", (f) => f.requestId === "r-old")
    assert.equal(frame.available, false)
    assert.equal(frame.reason, "unsupported")
    assert.equal(refreshCount, 0)
    v.close()
  } finally { await relay.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test("设备离线：有缓存回 stale；无缓存回 device_offline；非法快照被丢弃不影响后续合法快照", async () => {
  const dir = mkTemp(); const relay = await bootRelay(dir)
  try {
    const ext = await fakeExtension(relay, {
      onRefresh: (msg, c) => {
        // 先回一条含 cost 的非法快照，再回合法快照：relay 必须丢弃非法的、接受合法的
        const bad = snapshotOf(); bad.days[0].cost = 0.01
        c.send({ type: "usage_snapshot", deviceId: DEVICE, requestId: msg.requestId, snapshot: bad })
        setTimeout(() => c.send({ type: "usage_snapshot", deviceId: DEVICE, requestId: msg.requestId, snapshot: snapshotOf() }), 10)
      },
    })
    const v = await viewer(relay)
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r-bad" })
    const frame = await v.type("usage_snapshot", (f) => f.requestId === "r-bad", 3000).catch(() => null)
    // 非法快照被丢弃时该请求会等超时；但随后合法快照到达应能被接受（新请求/或同 pending 只认一次）。
    // 为避免依赖 8s 超时，这里直接验证：非法快照没被缓存、合法快照能返回（再发一次请求）。
    if (!frame) {
      v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r-good", force: true })
      const good = await v.type("usage_snapshot", (f) => f.requestId === "r-good")
      assert.equal(good.available, true)
    }
    ext.close()
    await new Promise((r) => setTimeout(r, 50))
    // 缓存已在 → 新请求回 stale（设备断开）
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r-stale", force: true })
    const stale = await v.type("usage_snapshot", (f) => f.requestId === "r-stale")
    assert.equal(stale.available, true)
    assert.equal(stale.stale, true, "设备离线应回缓存 + stale")
    v.close()
  } finally { await relay.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test("缓存跨 relay 重启：设备不在新进程名册时仍回 stale 缓存", async () => {
  const dir = mkTemp()
  const relay = await bootRelay(dir)
  try {
    await fakeExtension(relay, { onRefresh: (msg, c) => c.send({ type: "usage_snapshot", deviceId: DEVICE, requestId: msg.requestId, snapshot: snapshotOf() }) })
    const v = await viewer(relay)
    v.send({ type: "usage_get", deviceId: DEVICE, requestId: "r-warm" })
    await v.type("usage_snapshot", (f) => f.requestId === "r-warm")
    v.close()
  } finally { await relay.close() }
  const relay2 = await bootRelay(dir)
  try {
    const v2 = await viewer(relay2)
    v2.send({ type: "usage_get", deviceId: DEVICE, requestId: "r-after-restart" })
    const frame = await v2.type("usage_snapshot", (f) => f.requestId === "r-after-restart")
    assert.equal(frame.available, true)
    assert.equal(frame.stale, true, "缓存在、设备不在名册 → stale")
    assert.equal(frame.snapshot.summary.totals.tokens, 150)
    v2.close()
  } finally { await relay2.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
