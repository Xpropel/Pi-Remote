// R4-1 主题偏好跨设备同步：relay 托管（per-account 存储 + LWW + 单调 rev）与
// UI 半（prefs.ts 子集纯函数 + useRelay 接线）在同一文件里对账。
// relay 半起真 relay、走真 WS；cap 声明用 UI 的真实 authFrame 握手验证
// （声明与落地同轮，A-6 纪律）；UI 纯函数直接 import 真模块断言，
// 回声抑制的接线顺序用源码断言兜底（与 ui-sync 的 R3-1 接线断言同款）。
// P7 B4（plan §6.5「偏好同步的白名单相应缩小」、决定 17）：同步的外观五字段只属于旧界面的 style/prefs.ts，新界面不用，文件已删；
// 客户端不再参与同步，UI 半的 6 个用例（子集纯函数、远端裁决、useRelay 接线、A-1 竞态、A-2 同构）删掉，改成一条"不再上行 / 忽略帧"的接线断言。
// relay 半（PrefsStore、cleanPrefsSubset、双 viewer、LWW、旧端剥离、帧校验、重启恢复、日志）全部保留。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import WebSocket from "ws"
import { startRelay } from "../relay/server.js"
import { authFrame } from "../ui/src/relay/protocol.ts"

const require = createRequire(import.meta.url)
const proto = require("../protocol/v4.json")
const { RELAY_CAPS } = require("../relay/wire.js")
const { PrefsStore, cleanPrefsSubset } = require("../relay/prefs.js")
const { safeKey } = require("../relay/index.js")

// 测试夹具令牌（≥16 字符的生产下限）：拼词构造，避免静态长串被当作真密钥处理
const LOCAL_TOKEN = ["local", "token", "prefs", "sync", "test", "fixture", "alpha"].join("-")
const VIEWER_TOKEN = ["viewer", "token", "prefs", "sync", "test", "fixture", "beta"].join("-")
const ADMIN_TOKEN = ["admin", "token", "prefs", "sync", "test", "fixture", "gamma"].join("-")
const CAPS = ["err.v4", "msg.cid", "device.token", "dialog.respond", "room.attention", "prefs.sync"]
const SUBSET_A = { theme: "sea", chrome: "codex", font: "inter", size: 14, mono: "system" }
const SUBSET_B = { theme: "rose", chrome: "claude", font: "noto", size: 16, mono: "jetbrains" }

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-prefs-"))
}

function boot(dataDir = tmpDir()) {
  return startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir,
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
  })
}

/** 收帧客户端：wait 返回第一条未被取走且满足条件的帧（与 attention 集成测试同款语义）。 */
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
          timer: setTimeout(() => reject(new Error("等待帧超时: " + what)), ms),
        }
        waiters.push(w)
      })
    },
    type(t, pred = () => true) {
      return api.wait((f) => f.type === t && pred(f), 3000, t)
    },
    close() {
      try {
        ws.close()
      } catch {}
    },
  }
  return api
}

/** viewer 握手：caps 传数组 = 新端声明；不传 = 旧端（无任何 cap）。 */
async function viewer(relay, caps) {
  const c = client(relay.viewerPort)
  await c.opened
  const hello = { type: "auth", role: "viewer", token: VIEWER_TOKEN }
  if (Array.isArray(caps)) hello.caps = caps
  c.send(hello)
  const auth = await c.type("auth_result")
  assert.equal(auth.ok, true)
  return { c, auth }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 登记一致 ---------------- */

test("cap 三处登记一致：v4.json / RELAY_CAPS / VIEWER_CAPS + limits 上限", () => {
  assert.ok(proto.caps["prefs.sync"], "protocol/v4.json 须登记 prefs.sync")
  assert.equal(proto.limits.prefsSubsetMaxBytes, 2048, "子集帧大小上限落在 limits，不许散字面值")
  assert.ok(RELAY_CAPS.includes("prefs.sync"), "relay RELAY_CAPS 须声明 prefs.sync")
  assert.ok(authFrame("t").caps.includes("prefs.sync"), "UI authFrame 握手须声明 prefs.sync")
})

/* ---------------- relay 存储单元 ---------------- */

test("PrefsStore：rev 单调递增、整份替换、落盘恢复、文件 0o600", () => {
  const dir = tmpDir()
  const store = new PrefsStore(dir)
  assert.equal(store.get("admin"), null)
  const r1 = store.set("admin", { ...SUBSET_A }, 1000)
  assert.equal(r1.rev, 1)
  assert.equal(r1.updatedAt, 1000)
  const r2 = store.set("admin", { ...SUBSET_B }, 2000)
  assert.equal(r2.rev, 2)
  assert.deepEqual(store.get("admin").subset, SUBSET_B)
  // 换一个实例（模拟 relay 重启）：从盘上读回，rev 不回退
  const again = new PrefsStore(dir)
  const back = again.get("admin")
  assert.equal(back.rev, 2)
  assert.deepEqual(back.subset, SUBSET_B)
  const file = path.join(dir, safeKey("admin"), "prefs.json")
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "偏好落盘文件权限 0o600")
  // 别的账号互不干扰
  assert.equal(again.get("other"), null)
})

test("cleanPrefsSubset（relay 入口清洗）：白名单外字段丢弃、坏值丢弃、全坏返回 null", () => {
  const cleaned = cleanPrefsSubset({
    ...SUBSET_A,
    color: { thinking: "sea" },
    completionSound: true,
    dialogRemoteAnswer: true,
    thinking: "antd",
  })
  assert.deepEqual(cleaned, SUBSET_A, "只有五字段能过 relay 入口")
  assert.deepEqual(cleanPrefsSubset({ theme: "sea", size: "big" }), { theme: "sea" }, "size 非整数丢弃，其余保留")
  assert.equal(cleanPrefsSubset({ size: 99 }), null, "越界 size 丢弃后无合法字段 → null")
  assert.equal(cleanPrefsSubset({ theme: "has space" }), null)
  assert.equal(cleanPrefsSubset(null), null)
  assert.equal(cleanPrefsSubset("sea"), null)
  assert.equal(cleanPrefsSubset([1, 2]), null)
})

/* ---------------- relay 通道集成 ---------------- */

test("双 viewer 同步：A 改 → B 收 prefs_changed、A 只收 prefs_saved 回执（发送端不收广播）", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const a = await viewer(relay, CAPS)
  const b = await viewer(relay, CAPS)
  t.after(() => {
    a.c.close()
    b.c.close()
  })
  // relay 无记录时快照为 null（字段在、值为 null，UI 据此播种）
  assert.ok("prefs" in a.auth && a.auth.prefs === null)
  assert.ok("prefs" in b.auth && b.auth.prefs === null)

  // A 上行时故意多带白名单外字段：relay 清洗后才广播，白名单外的绝不上行下行
  a.c.send({ type: "prefs_set", subset: { ...SUBSET_A, color: { thinking: "rose" }, completionSound: true, thinking: "antd" }, baseRev: 0 })
  const saved = await a.c.type("prefs_saved")
  assert.equal(saved.rev, 1)
  assert.equal(typeof saved.updatedAt, "number")
  const changed = await b.c.type("prefs_changed")
  assert.equal(changed.rev, 1)
  assert.deepEqual(changed.subset, SUBSET_A, "广播子集只有五字段")
  await sleep(150)
  assert.equal(a.c.frames.filter((f) => f.type === "prefs_changed").length, 0, "发送端不收 prefs_changed（通道层断回声）")
})

test("LWW + rev 裁决：落后 baseRev 不拒绝、到达顺序定胜负、新连 viewer 快照拿到最终值", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const a = await viewer(relay, CAPS)
  const b = await viewer(relay, CAPS)
  t.after(() => {
    a.c.close()
    b.c.close()
  })

  a.c.send({ type: "prefs_set", subset: { ...SUBSET_A }, baseRev: 0 })
  assert.equal((await a.c.type("prefs_saved")).rev, 1)
  assert.equal((await b.c.type("prefs_changed")).rev, 1)

  // B 的 baseRev 还停在 0（没跟上 rev 1）：不拒绝，按到达顺序成为新胜者
  b.c.send({ type: "prefs_set", subset: { ...SUBSET_B }, baseRev: 0 })
  assert.equal((await b.c.type("prefs_saved")).rev, 2)
  const win = await a.c.type("prefs_changed", (f) => f.rev === 2)
  assert.deepEqual(win.subset, SUBSET_B)

  // A 再以过期 baseRev=1 上行：仍接受、rev 继续单调
  a.c.send({ type: "prefs_set", subset: { ...SUBSET_A }, baseRev: 1 })
  assert.equal((await a.c.type("prefs_saved")).rev, 3)

  // 新连 viewer（用 UI 的真实 authFrame 握手）→ auth 快照就是最终值
  const c = client(relay.viewerPort)
  await c.opened
  t.after(() => c.close())
  c.send(authFrame(VIEWER_TOKEN))
  const auth = await c.type("auth_result")
  assert.equal(auth.ok, true)
  assert.equal(auth.prefs.rev, 3)
  assert.deepEqual(auth.prefs.subset, SUBSET_A)
})

test("旧端剥离：未声明 cap 的 viewer 无 prefs 快照字段、不收广播、prefs_set 被拒", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const a = await viewer(relay, CAPS)
  const old = await viewer(relay) // 不带 caps = 旧端
  t.after(() => {
    a.c.close()
    old.c.close()
  })
  assert.ok(!("prefs" in old.auth), "旧端 auth_result 不带 prefs 字段（只剥新面）")
  assert.ok(Array.isArray(old.auth.rooms) && "devices" in old.auth, "既有面（rooms/devices）不剥")

  a.c.send({ type: "prefs_set", subset: { ...SUBSET_A }, baseRev: 0 })
  await a.c.type("prefs_saved")
  await sleep(150)
  assert.equal(old.c.frames.filter((f) => f.type === "prefs_changed").length, 0, "旧端不收 prefs_changed")

  old.c.send({ type: "prefs_set", id: "old-set-1", subset: { ...SUBSET_B }, baseRev: 0 })
  const err = await old.c.type("error", (f) => f.id === "old-set-1")
  assert.equal(err.code, "unsupported")
})

test("帧校验：超限帧 payload_too_large、全坏子集 bad_args、合法子集不受影响", async (t) => {
  const relay = await boot()
  t.after(() => relay.close())
  const a = await viewer(relay, CAPS)
  t.after(() => a.c.close())

  a.c.send({ type: "prefs_set", id: "big-1", subset: { ...SUBSET_A, pad: "x".repeat(3000) }, baseRev: 0 })
  const big = await a.c.type("error", (f) => f.id === "big-1")
  assert.equal(big.code, "payload_too_large")

  a.c.send({ type: "prefs_set", id: "bad-1", subset: { theme: 42, size: "huge" }, baseRev: 0 })
  const bad = await a.c.type("error", (f) => f.id === "bad-1")
  assert.equal(bad.code, "bad_args")

  // 两记拒绝不毒化通道：合法上行照常裁决（rev 从 1 起，说明前两帧没落值）
  a.c.send({ type: "prefs_set", subset: { ...SUBSET_A }, baseRev: 0 })
  assert.equal((await a.c.type("prefs_saved")).rev, 1)
})

test("relay 重启后新连 viewer 仍拿到最后值（落盘恢复）", async (t) => {
  const dir = tmpDir()
  const relay1 = await boot(dir)
  const a = await viewer(relay1, CAPS)
  a.c.send({ type: "prefs_set", subset: { ...SUBSET_B }, baseRev: 0 })
  assert.equal((await a.c.type("prefs_saved")).rev, 1)
  a.c.close()
  await relay1.close()

  const relay2 = await boot(dir)
  t.after(() => relay2.close())
  const b = await viewer(relay2, CAPS)
  t.after(() => b.c.close())
  assert.equal(b.auth.prefs.rev, 1)
  assert.deepEqual(b.auth.prefs.subset, SUBSET_B)
})

/* ---------------- UI 纯函数 ---------------- */




/* ---------------- useRelay 接线（回声抑制与帧处理位置） ---------------- */


/* ---------------- 第 4 轮审查修复（低 A-1 / A-2 / A-3） ---------------- */



test("A-3 日志通道：relay/prefs.js 的失败告警一律走 util log，无 console.* 直出", () => {
  const src = fs.readFileSync(new URL("../relay/prefs.js", import.meta.url), "utf8")
  assert.ok(!src.includes("console."), "prefs.js 不得绕过 relay 统一日志通道直出 console（fsync 失败告警曾走 console.warn）")
  assert.ok(src.includes('log("prefs fsync 失败'), "fsync 失败告警走 log 通道")
})
test("P11：客户端只参与 mobileNav additive 同步（不再复活外观五字段）；握手 cap 不变", () => {
  const relaySrc = fs.readFileSync(new URL("../ui/src/relay/useRelay.ts", import.meta.url), "utf8")
  // P11 重新接入 prefs-sync：只上行 {mobileNav}（单一字段），外观旧通道仍关闭
  assert.match(relaySrc, /type: "prefs_set"/)
  assert.match(relaySrc, /subset: \{ mobileNav: mode \}/)
  assert.doesNotMatch(relaySrc, /@\/style\/prefs/)
  assert.match(relaySrc, /mobileNavFromPrefsSubset/)
  assert.ok(authFrame("t").caps.includes("prefs.sync"), "VIEWER_CAPS 不改（协议不变）")
})
