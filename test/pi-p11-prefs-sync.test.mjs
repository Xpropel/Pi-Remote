// P11 B0：prefs 增量 + mobileNav prefs-sync（additive）测试。
// 覆盖：PiPrefs 迁移默认/非法/clamp（不升版本）；cleanPrefsSubset 白名单 additive/枚举/旧字段兼容；
// 真 relay 双 viewer 跨设备同步（A 改 drawer → B 读到 → B 改 list → A 收到广播）；宽度/折叠不进同步子集；
// serverName additive（auth_result + healthz，旧 relay 缺失时 UI fallback 由 pi-p11-framework 覆盖）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const WebSocket = require("ws")
const { startRelay } = require("../relay/server.js")
const { cleanPrefsSubset } = require("../relay/prefs.js")
const prefs = await import("../ui/src/pi/model/prefs.ts")
const { serverInfo } = await import("../ui/src/relay/protocol.ts")

const LOCAL_TOKEN = "p11-test-local-token-00001"
const VIEWER_TOKEN = "p11-test-viewer-token-001"
const ADMIN_TOKEN = "p11-test-admin-token-0001"

function mkTemp() { return fs.mkdtempSync(path.join(os.tmpdir(), "pi-p11-prefs-")) }
async function bootRelay(dataDir, extra = {}) {
  return startRelay({
    localPort: 0, viewerPort: 0, dataDir, quiet: true, exitOnListenError: false,
    localToken: LOCAL_TOKEN, viewerToken: VIEWER_TOKEN, adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10, perMessageDeflate: false, ...extra,
  })
}
function viewerClient(port) {
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
          const w = { pred, resolve: (m) => { m.__taken = true; res(m) }, timer: setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`等待 ${what} 超时`)) }, ms) }
          waiters.push(w)
        })
      },
      type(t, extraPred = () => true, ms) { return this.wait((f) => f.type === t && extraPred(f), ms, t) },
      close() { try { ws.terminate() } catch {} },
    }))
  })
}
async function viewerAuth(relay) {
  const v = await viewerClient(relay.viewerPort)
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, proto: 4, caps: ["prefs.sync"] })
  const auth = await v.type("auth_result")
  assert.equal(auth.ok, true)
  return v
}

test("PiPrefs 增量：默认 list/272/展开/常驻搜索关；非法回落；clamp 宽度；不升版本", () => {
  assert.equal(prefs.PI_PREFS_VERSION, 1)
  const d = prefs.migratePiPrefs(null)
  assert.equal(d.mobileNav, "list")
  assert.equal(d.sidebarWidth, 272)
  assert.equal(d.sidebarCollapsed, false)
  assert.equal(d.sidebarPersistentSearch, false)
  const bad = prefs.migratePiPrefs({ mobileNav: "drawer2", sidebarWidth: 9999, sidebarCollapsed: "yes", sidebarPersistentSearch: 1 })
  assert.equal(bad.mobileNav, "list")
  assert.equal(bad.sidebarWidth, 360)
  assert.equal(bad.sidebarCollapsed, false)
  assert.equal(bad.sidebarPersistentSearch, false)
  assert.equal(prefs.migratePiPrefs({ mobileNav: "drawer", sidebarWidth: 100 }).mobileNav, "drawer")
  assert.equal(prefs.migratePiPrefs({ sidebarWidth: 100 }).sidebarWidth, 220)
  assert.equal(prefs.migratePiPrefs({ sidebarWidth: 288 }).sidebarWidth, 288)
  const changed = prefs.setPiPref(d, "mobileNav", "drawer")
  assert.equal(changed.prefs.mobileNav, "drawer")
  assert.deepEqual(prefs.prefsSyncSubsetOf({ mobileNav: "drawer" }), { mobileNav: "drawer" })
  assert.equal(prefs.mobileNavFromPrefsSubset({ mobileNav: "list" }), "list")
  assert.equal(prefs.mobileNavFromPrefsSubset({ mobileNav: "bogus" }), null)
  assert.equal(prefs.mobileNavFromPrefsSubset(undefined), null)
  assert.equal(prefs.mobileNavFromPrefsSubset({}), null)
})

test("relay cleanPrefsSubset（additive）：mobileNav 枚举放行、旧字段兼容、未知字段丢弃", () => {
  assert.deepEqual(cleanPrefsSubset({ mobileNav: "drawer" }), { mobileNav: "drawer" })
  assert.deepEqual(cleanPrefsSubset({ mobileNav: "list" }), { mobileNav: "list" })
  assert.equal(cleanPrefsSubset({ mobileNav: "drawer2" }), null)
  assert.equal(cleanPrefsSubset({ mobileNav: 1 }), null)
  assert.deepEqual(cleanPrefsSubset({ theme: "night", mobileNav: "list" }), { theme: "night", mobileNav: "list" }, "旧外观字段兼容")
  assert.deepEqual(cleanPrefsSubset({ theme: "night", sidebarWidth: 300, sidebarCollapsed: true, faces: "x" }), { theme: "night" }, "本设备字段/未知字段不入同步")
  assert.deepEqual(cleanPrefsSubset({ sidebarWidth: 300 }), null, "只有设备本地字段 → 无合法同步字段")
})

test("真 relay 跨设备：A 改 drawer → B 认证快照读到；B 改 list → A 收到 prefs_changed 广播", async () => {
  const dir = mkTemp()
  const relay = await bootRelay(dir)
  try {
    const a = await viewerAuth(relay)
    a.send({ type: "prefs_set", subset: { mobileNav: "drawer" } })
    const saved = await a.type("prefs_saved")
    assert.ok(saved.rev >= 1)
    // B 设备（另一个 viewer 连接）认证即读到账号级快照
    const b = await viewerAuth(relay)
    assert.equal(b.frames.find((f) => f.type === "auth_result").prefs.subset.mobileNav, "drawer")
    // B 改回 list → A 收到广播（发送端不收回声，A 是另一 socket）
    b.send({ type: "prefs_set", subset: { mobileNav: "list" } })
    const changed = await a.type("prefs_changed")
    assert.equal(changed.subset.mobileNav, "list")
    // B 断线重连（同账号）仍能从存储恢复
    b.close()
    const c = await viewerAuth(relay)
    assert.equal(c.frames.find((f) => f.type === "auth_result").prefs.subset.mobileNav, "list")
    a.close(); c.close()
  } finally {
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("serverName additive：auth_result 仅非空携带；healthz 带；旧 relay 缺失时 serverInfo 不报错", async () => {
  assert.deepEqual(serverInfo({ proto: 4, caps: [] }), { proto: 4, caps: [] })
  assert.equal(serverInfo({ proto: 4, caps: [], serverName: "上海中转" }).serverName, "上海中转")
  assert.equal(serverInfo({ proto: 4, caps: [], serverName: "   " }).serverName, undefined)
  assert.equal(serverInfo({ proto: 4, caps: [], serverName: "x".repeat(100) }).serverName.length, 64)
  const dir = mkTemp()
  const relay = await bootRelay(dir, { serverName: "上海中转" })
  try {
    const v = await viewerAuth(relay)
    assert.equal(v.frames.find((f) => f.type === "auth_result").serverName, "上海中转")
    const res = await fetch(`http://127.0.0.1:${relay.viewerPort}/healthz`)
    const body = await res.json()
    assert.equal(body.serverName, "上海中转")
    v.close()
  } finally {
    await relay.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  // 未配置 serverName：auth_result 不带字段（客户端回退 hostname）
  const dir2 = mkTemp()
  const relay2 = await bootRelay(dir2)
  try {
    const v = await viewerAuth(relay2)
    assert.equal("serverName" in v.frames.find((f) => f.type === "auth_result"), false)
    v.close()
  } finally {
    await relay2.close()
    fs.rmSync(dir2, { recursive: true, force: true })
  }
})


test("mobileNav 采用逻辑：只在服务端值变化时采用，不得把用户刚改的本地值打回旧服务端值", () => {
  const fs = require("node:fs")
  const path = require("node:path")
  const src = fs.readFileSync(path.join(process.cwd(), "ui/src/pi/PiApp.tsx"), "utf8")
  assert.match(src, /lastAdoptedNav/, "需要记录已采用的服务端值（防止本地点击被旧快照回滚）")
  assert.match(src, /localNavRef\.current = ui\.prefs\.mobileNav/, "采用 effect 用 ref 读本地当前值，避免把 mobileNav 放进依赖")
  assert.match(src, /if \(!syncedNav \|\| syncedNav === lastAdoptedNav\.current\) return/, "服务端值未变化时不重复采用")
  assert.doesNotMatch(src, /\}, \[syncedNav, ui\.prefs\.mobileNav, act\]\)/, "采用 effect 不得依赖本地 mobileNav（否则用户点击后立即回滚）")
})
