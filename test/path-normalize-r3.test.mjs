// 第三轮（S8）：路径规范统一。
// 1. 会话启动时按平台统一 cwd 写法：attach 拉起目录、扩展房间注册与清单行、relay 入库与下发（Windows：盘符大写、反斜杠、去尾斜杠；macOS / Linux：去尾斜杠）。
// 2. 网页里的路径比较只有一套按设备平台的规则（pathKeyOf / samePath）：Windows 不分大小写、两种斜杠等价；macOS 不分大小写；Linux 区分大小写。
import test, { after } from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import attach from "../deploy/attach.cjs"
import { canonicalCwd as relayCanonicalCwd, normalizePlatform, normPath } from "../relay/devices.js"
import { startRelay } from "../relay/server.js"
import { bodySearchTargetsOf, mergeBodySearchReplies } from "../ui/src/relay/bodySearch.ts"
import { cwdInProjects, devicePlatformOf, findStartedRoom, folderAllowed, groupListedSessions, pathKeyOf, samePath, underRoots } from "../ui/src/relay/devices.ts"
import { authFrame } from "../ui/src/relay/protocol.ts"
import { breadcrumbOf, knownFoldersOf } from "../ui/src/pi/model/folderBrowser.ts"
import { folderExistenceOf, probeFolderExistence } from "../ui/src/pi/model/folderExistence.ts"
import { folderForDevice, hasRunningRoom, homeShort, newSessionDefaultsOf, recentFoldersOf, runningRoomOf } from "../ui/src/pi/model/newSession.ts"
import { paletteBodyHitsOf } from "../ui/src/pi/model/palette.ts"
import { sessionDeleteRouteOf } from "../ui/src/pi/model/sessionMenu.ts"
import { sidebarGroups } from "../ui/src/pi/model/sidebarGroups.ts"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-r3-"))
const LOG_PATH = path.join(TMP, "ext.log")
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(TMP, "missing-attach.json")
process.env.PI_REMOTE_TOKEN = ""
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, "sessions")
after(() => fs.rmSync(TMP, { recursive: true, force: true }))
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

const WIN = { id: "win", name: "Windows", online: true, platform: "windows", projects: ["D:\\pi-e2e\\s2"], browseRoots: ["D:\\pi-e2e"] }
const MAC = { id: "mac", name: "Mac", online: true, platform: "macos", projects: ["/Users/me/Work"], browseRoots: ["/Users/me"] }
const LNX = { id: "lnx", name: "Linux", online: true, platform: "linux", projects: ["/srv/App"], browseRoots: ["/srv"] }

/* ---------------- 网页：一套比较规则 ---------------- */

test("pathKeyOf / samePath（Windows）：两种斜杠、盘符与目录大小写、末尾斜杠都不计；盘根、UNC 照常", () => {
  for (const p of ["D:/pi-e2e/s2", "D:\\pi-e2e\\s2", "d:\\PI-E2E\\s2\\", "d:/pi-e2e/s2//"]) assert.equal(pathKeyOf(p, "windows"), "d:/pi-e2e/s2", p)
  assert.equal(samePath("D:/pi-e2e/s2", "D:\\pi-e2e\\s2", "windows"), true)
  assert.equal(samePath("D:\\pi-e2e\\s2", "D:\\pi-e2e\\s22", "windows"), false)
  assert.equal(samePath("D:\\", "d:/", "windows"), true)
  assert.equal(pathKeyOf("\\\\server\\share\\x\\", "windows"), "//server/share/x")
  assert.equal(samePath("", "", "windows"), false, "空路径和谁都不相等")
  assert.equal(samePath(null, undefined, "windows"), false)
})

test("pathKeyOf / samePath（macOS / Linux）：macOS 不分大小写；Linux 区分；两者反斜杠都是普通字符；根目录留 /", () => {
  assert.equal(samePath("/Users/Me/Work", "/users/me/work/", "macos"), true)
  assert.equal(samePath("/Users/me/a\\b", "/Users/me/a/b", "macos"), false)
  assert.equal(samePath("/srv/App", "/srv/app", "linux"), false)
  assert.equal(samePath("/srv/app/", "/srv/app", "linux"), true)
  assert.equal(samePath("/srv/a\\b", "/srv/a/b", "linux"), false)
  assert.equal(pathKeyOf("/", "linux"), "/")
  assert.equal(pathKeyOf("//", "macos"), "/")
})

test("pathKeyOf：平台未知（旧设备）沿用最宽松的旧规则；darwin / win32 等别名按 macos / windows", () => {
  assert.equal(samePath("D:/x", "d:\\X\\", ""), true)
  assert.equal(samePath("/Home/x", "/home/x", null), true)
  assert.equal(samePath("/Users/A", "/users/a", "darwin"), true)
  assert.equal(samePath("/Users/a\\b", "/Users/a/b", "darwin"), false)
  assert.equal(samePath("D:/x", "d:\\x", "win32"), true)
  assert.equal(devicePlatformOf([WIN, LNX], "lnx"), "linux")
  assert.equal(devicePlatformOf([WIN], "nope"), undefined)
  assert.equal(devicePlatformOf([WIN], null), undefined)
})

test("underRoots / cwdInProjects / folderAllowed：同一口径；前缀后必须紧跟分隔符", () => {
  assert.equal(underRoots(["D:\\pi-e2e"], "d:/pi-e2e/s7", "windows"), true)
  assert.equal(underRoots(["D:\\pi-e2e"], "D:\\pi-e2e-sandbox", "windows"), false)
  assert.equal(underRoots(["D:\\"], "d:/x", "windows"), true)
  assert.equal(underRoots(["/"], "/tmp/x", "linux"), true)
  assert.equal(underRoots(["/srv"], "/SRV/app", "linux"), false)
  assert.equal(underRoots(["/Users/me"], "/users/ME/x", "macos"), true)
  assert.equal(cwdInProjects(["D:\\pi-e2e\\s2"], "d:/pi-e2e/s2/", "windows"), true)
  assert.equal(cwdInProjects(["/srv/App"], "/srv/app", "linux"), false)
  assert.equal(cwdInProjects(["/srv/App"], "/srv/app"), true, "不给平台按宽松旧规则")
  assert.equal(folderAllowed(WIN, "d:/pi-e2e/s2"), true)
  assert.equal(folderAllowed({ ...LNX, browseRoots: [] }, "/srv/app"), false)
  assert.equal(folderAllowed({ ...LNX, browseRoots: [] }, "/srv/App/"), true)
})

test("最近目录 / 已知目录：Windows 同一目录几种写法只留最新的一条；macOS 同理；Linux 大小写不同是两个目录；排除集按同一口径", () => {
  const winSessions = [
    { cwd: "D:/pi-e2e/s2", updatedAt: 30 },
    { cwd: "D:\\pi-e2e\\s2", updatedAt: 20 },
    { cwd: "d:\\pi-e2e\\s2\\", updatedAt: 10 },
    { cwd: "D:\\pi-e2e\\s7", updatedAt: 5 },
  ]
  assert.deepEqual(recentFoldersOf(winSessions, WIN), ["D:/pi-e2e/s2", "D:\\pi-e2e\\s7"])
  const macSessions = [{ cwd: "/Users/me/Work", updatedAt: 2 }, { cwd: "/users/me/work/", updatedAt: 1 }]
  assert.deepEqual(recentFoldersOf(macSessions, MAC), ["/Users/me/Work"])
  const lnxSessions = [{ cwd: "/srv/App", updatedAt: 2 }, { cwd: "/srv/app", updatedAt: 1 }]
  assert.deepEqual(recentFoldersOf(lnxSessions, LNX), ["/srv/App", "/srv/app"])
  // F3 排除集写的是另一种写法也照样剔除
  assert.deepEqual(recentFoldersOf(winSessions, WIN, 5, new Set(["d:/PI-E2E/s2"])), ["D:\\pi-e2e\\s7"])
  assert.deepEqual(recentFoldersOf(lnxSessions, LNX, 5, new Set(["/srv/app"])), ["/srv/App"])
  assert.deepEqual(knownFoldersOf(WIN, winSessions), ["D:\\pi-e2e\\s2", "D:\\pi-e2e\\s7"])
  assert.deepEqual(knownFoldersOf(LNX, lnxSessions), ["/srv/App", "/srv/app"])
  assert.equal(folderForDevice(WIN, "d:/pi-e2e/s2", new Set(["D:\\pi-e2e\\s2"])), "D:\\pi-e2e", "所选目录（另一种写法）已证不存在、白名单里也是它：退回浏览根目录")
  assert.equal(folderForDevice(LNX, "/srv/App", new Set(["/srv/app"])), "/srv/App", "Linux 上排除的是另一个目录")
})

test("同目录已有会话：房间 cwd 与所选目录写法不同也认得出（Windows）；Linux 大小写不同不算；预选跳过有运行会话的目录", () => {
  const rooms = [{ id: "r1", online: true, deviceId: "win", cwd: "D:\\pi-e2e\\s2" }]
  assert.equal(runningRoomOf(rooms, "win", "d:/pi-e2e/s2/", "windows")?.id, "r1")
  assert.equal(hasRunningRoom(rooms, "win", "D:/pi-e2e/s2"), true, "不给平台按宽松旧规则")
  const lrooms = [{ id: "l1", online: true, deviceId: "lnx", cwd: "/srv/App" }]
  assert.equal(runningRoomOf(lrooms, "lnx", "/srv/app", "linux"), null)
  assert.equal(runningRoomOf(lrooms, "lnx", "/srv/App/", "linux")?.id, "l1")
  const defaults = newSessionDefaultsOf({
    devices: [WIN],
    rooms,
    sessionsByDevice: { win: [{ id: "a", cwd: "D:/pi-e2e/s2", updatedAt: 9 }, { id: "b", cwd: "D:\\pi-e2e\\s7", updatedAt: 1 }] },
    selectedDeviceId: "win",
  })
  assert.deepEqual(defaults, { deviceId: "win", folder: "D:\\pi-e2e\\s7" })
})

test("侧栏分组：同一目录的几种写法归成一组（Windows），组的 cwd / key 用白名单写法；Linux 大小写不同仍是两组", () => {
  const row = (id, cwd, updatedAt, deviceId) => ({ id, title: id, cwd, online: false, busy: false, updatedAt, openable: true, deviceId })
  const model = sidebarGroups(
    [row("a", "D:/pi-e2e/s2", 30, "win"), row("b", "d:\\pi-e2e\\s2\\", 20, "win"), row("c", "D:\\pi-e2e\\s7", 10, "win"), row("d", "D:/pi-e2e/s7", 5, "win")],
    [WIN],
    [],
  )
  assert.deepEqual(
    model.groups.map((g) => [g.key, g.cwd, g.label, g.rows.map((r) => r.id)]),
    [
      ["win:D:\\pi-e2e\\s2", "D:\\pi-e2e\\s2", "s2", ["a", "b"]],
      ["win:D:\\pi-e2e\\s7", "D:\\pi-e2e\\s7", "s7", ["c", "d"]],
    ],
  )
  const lmodel = sidebarGroups([row("x", "/srv/App/", 2, "lnx"), row("y", "/srv/app", 1, "lnx")], [LNX], [])
  assert.deepEqual(
    lmodel.groups.map((g) => [g.key, g.rows.map((r) => r.id)]),
    [
      ["lnx:/srv/App", ["x"]],
      ["lnx:/srv/app", ["y"]],
    ],
  )
  const listed = [{ id: "p", cwd: "D:/w" }, { id: "q", cwd: "d:\\W\\" }, { id: "r", cwd: "/srv/x" }]
  assert.deepEqual(groupListedSessions(listed, "windows").map((g) => [g.cwd, g.items.map((i) => i.id)]), [["D:/w", ["p", "q"]], ["/srv/x", ["r"]]])
})

test("启动后找房间、删除路由、正文搜索、命令面板去重：都按设备平台比", () => {
  const list = [{ id: "n", online: true, deviceId: "win", cwd: "D:\\pi-e2e\\s7", lastActivity: 1 }]
  assert.equal(findStartedRoom({ kind: "cwd", key: "d:/pi-e2e/s7/", seen: new Set() }, "win", list, "windows")?.id, "n")
  assert.equal(findStartedRoom({ kind: "cwd", key: "/srv/app", seen: new Set() }, "lnx", [{ id: "m", online: true, deviceId: "lnx", cwd: "/srv/App" }], "linux"), null)

  const delRooms = [{ id: "r1", online: true, deviceId: "win", cwd: "D:\\pi-e2e\\s2", lastActivity: 1 }]
  assert.deepEqual(sessionDeleteRouteOf({ id: "old", deviceId: "win", cwd: "d:/pi-e2e/s2" }, delRooms, "", { online: true, features: [], platform: "windows" }, false), { running: false, via: "room", roomId: "r1" })
  const lDel = sessionDeleteRouteOf({ id: "old", deviceId: "lnx", cwd: "/srv/app" }, [{ id: "l1", online: true, deviceId: "lnx", cwd: "/srv/App", lastActivity: 1 }], "", { online: true, features: [], platform: "linux" }, false)
  assert.equal(lDel.via, null)

  const rooms = [
    { id: "a", cwd: "D:\\pi-e2e\\s2", lastActivity: 1, online: true, deviceId: "win" },
    { id: "b", cwd: "d:/pi-e2e/s2", lastActivity: 2, online: true, deviceId: "win" },
  ]
  assert.deepEqual(bodySearchTargetsOf("win", rooms, null, "windows").map((t) => t.roomId), ["b"], "同一个会话目录只问一个房间")
  const lrooms = [
    { id: "x", cwd: "/srv/App", lastActivity: 1, online: true, deviceId: "lnx" },
    { id: "y", cwd: "/srv/app", lastActivity: 2, online: true, deviceId: "lnx" },
  ]
  assert.deepEqual(bodySearchTargetsOf("lnx", lrooms, null, "linux").map((t) => t.roomId), ["y", "x"])
  const T = { kind: "room", roomId: "a", cwd: "D:\\pi-e2e\\s2" }
  const hit = (session, matchCount) => ({ session, id: session, title: "t", cwd: "", mtime: 1, matchCount, snippets: [{ text: "x" }] })
  const page = (results) => ({ query: "q", results, truncated: false, scannedFiles: 1, totalFiles: 1 })
  const merged = mergeBodySearchReplies(
    "q",
    [
      { target: T, ok: true, data: page([hit("C:/Users/me/.pi/agent/sessions/--D--pi-e2e-s2--/a.jsonl", 1)]) },
      { target: T, ok: true, data: page([hit("C:\\Users\\me\\.pi\\agent\\sessions\\--d--pi-e2e-s2--\\a.jsonl", 2)]) },
    ],
    "windows",
  )
  assert.equal(merged.ok, true)
  assert.deepEqual(merged.page.results.map((r) => r.matchCount), [2])
  const lmerged = mergeBodySearchReplies(
    "q",
    [
      { target: T, ok: true, data: page([hit("/home/me/.pi/agent/sessions/--srv-App--/a.jsonl", 1)]) },
      { target: T, ok: true, data: page([hit("/home/me/.pi/agent/sessions/--srv-app--/a.jsonl", 2)]) },
    ],
    "linux",
  )
  assert.equal(lmerged.page.results.length, 2)

  const bodyPage = page([hit("/srv/app/s.jsonl", 1)])
  assert.equal(paletteBodyHitsOf(bodyPage, { id: "lnx", name: "Linux", platform: "linux" }, [{ id: "t", path: "/srv/App/s.jsonl" }]).length, 1)
  assert.equal(paletteBodyHitsOf(page([hit("D:\\s\\a.jsonl", 1)]), { id: "win", name: "Windows", platform: "windows" }, [{ id: "t", path: "d:/S/a.jsonl" }]).length, 0)
})

test("显示用前缀（~/）与面包屑：判断在不在根目录下按设备平台；显示保持原写法", () => {
  assert.equal(homeShort("d:/pi-e2e/s7", ["D:\\pi-e2e"], "windows"), "~/s7")
  assert.equal(homeShort("/Home/me/x", ["/home/me"], "linux"), "/Home/me/x")
  assert.equal(homeShort("/Home/me/x", ["/home/me"]), "~/x", "不给平台按宽松旧规则")
  assert.deepEqual(breadcrumbOf("D:\\pi-e2e\\s7\\sub", "d:/pi-e2e", "windows").map((c) => [c.label, c.path]), [["~", "d:/pi-e2e"], ["s7", "d:/pi-e2e/s7"], ["sub", "d:/pi-e2e/s7/sub"]])
  assert.deepEqual(breadcrumbOf("/srv/App/x", "/srv/app", "linux"), [{ label: "~", path: "/srv/app" }])
})

test("目录存在性缓存按设备平台判同一目录：Windows 另一种写法直接命中「已证不存在」；Linux 大小写不同是另一个目录，要另探", async () => {
  const notFound = async () => {
    throw Object.assign(new Error("gone"), { code: "fs_not_found" })
  }
  assert.equal(await probeFolderExistence("r3-win", "D:\\pi-e2e\\gone", notFound, "windows"), "missing")
  assert.equal(folderExistenceOf("r3-win", "d:/PI-E2E/gone/", "windows"), "missing")
  assert.equal(await probeFolderExistence("r3-lnx", "/srv/Gone", notFound, "linux"), "missing")
  assert.equal(folderExistenceOf("r3-lnx", "/srv/Gone/", "linux"), "missing")
  assert.equal(folderExistenceOf("r3-lnx", "/srv/gone", "linux"), null, "没探过")
})

/* ---------------- 启动时统一写法：relay / 扩展 / attach ---------------- */

const CANON_CASES = [
  ["d:/pi-e2e/s2/", "windows", "D:\\pi-e2e\\s2"],
  ["D:\\pi-e2e\\s2", "windows", "D:\\pi-e2e\\s2"],
  ["D:/pi-e2e/s2", "", "D:\\pi-e2e\\s2"],
  ["d:/", "windows", "D:\\"],
  ["D:\\\\", "win32", "D:\\"],
  ["//server/share/x/", "windows", "\\\\server\\share\\x"],
  ["/work", "windows", "/work"],
  ["/Users/me/Work/", "macos", "/Users/me/Work"],
  ["/", "linux", "/"],
  ["/srv/a\\b/", "linux", "/srv/a\\b"],
  ["C:/x", "linux", "C:/x"],
  ["/tmp/", "", "/tmp"],
]

test("relay canonicalCwd：Windows 盘符大写、反斜杠、去尾分隔符（盘根留 D:\\）；macOS / Linux 只去尾 /；比较结果与 normPath 一致", () => {
  for (const [input, platform, want] of CANON_CASES) assert.equal(relayCanonicalCwd(input, platform), want, `${input} @ ${platform || "未知"}`)
  for (const [input, platform] of CANON_CASES) assert.equal(normPath(relayCanonicalCwd(input, platform), platform), normPath(input, platform), `${input} 规范化前后比较口径不变`)
  assert.equal(relayCanonicalCwd(null, "windows"), null)
  assert.equal(relayCanonicalCwd("", "windows"), "")
})

test("网页 pathKeyOf 与 relay normPath 对拍：同一输入、同一平台（relay 侧平台先经 normalizePlatform）得到同一个比较键", () => {
  const paths = ["D:\\pi-e2e\\s2", "d:/PI-E2E/s2/", "D:\\", "C:/", "\\\\server\\Share\\x\\", "/Users/me/Work/", "/srv/App", "/srv/a\\b/", "/", "", "relative\\Dir/"]
  for (const platform of ["windows", "win32", "macos", "darwin", "linux", "freebsd", "", undefined]) {
    for (const p of paths) assert.equal(pathKeyOf(p, platform), normPath(p, normalizePlatform(platform)), `${JSON.stringify(p)} @ ${platform}`)
  }
})

test("扩展：房间注册与清单行的 cwd 按平台统一写法（与 relay 同一规则），会话文件路径口径不变", () => {
  const nodePlatform = { windows: "win32", win32: "win32", macos: "darwin", linux: "linux", "": "linux" }
  for (const [input, platform, want] of CANON_CASES) {
    if (platform === "") continue
    assert.equal(ext.canonicalCwd(input, nodePlatform[platform]), want, `${input} @ ${platform}`)
  }
  const row = ext.normalizeSessionEntry({ id: "s1", path: "C:\\Users\\me\\.pi\\s1.jsonl", cwd: "d:/pi-e2e/s2" }, "", "win32")
  assert.equal(row.cwd, "D:\\pi-e2e\\s2")
  assert.equal(row.path, "C:/Users/me/.pi/s1.jsonl")
  assert.equal(ext.normalizeSessionEntry({ id: "s2" }, "/srv/app/", "linux").cwd, "/srv/app")
  const b = new ext.Bridge()
  b.roomId = "R"
  b.platform = "win32"
  b.cwd = "d:\\pi-e2e\\s7\\"
  assert.equal(b.roomPayload().cwd, "D:\\pi-e2e\\s7")
  b.platform = "linux"
  b.cwd = "/srv/App/"
  assert.equal(b.roomPayload().cwd, "/srv/App")
})

test("attach：harness_start 的拉起目录盘符大写、反斜杠、去尾斜杠；按会话 id 续开时会话头里的小写盘符也一样", async () => {
  assert.equal(attach.launchDir("d:/pi-e2e/s7/", "win32"), "D:\\pi-e2e\\s7")
  assert.equal(attach.launchDir("D:\\", "win32"), "D:\\")
  assert.equal(attach.launchDir("/srv/app/", "linux"), "/srv/app")
  const dir = fs.mkdtempSync(path.join(TMP, "attach-"))
  const ctl = new attach.AttachController({
    platform: "win32",
    relay: "ws://127.0.0.1:7001",
    token: "tok",
    deviceId: "dev-1",
    accountId: "admin",
    deviceName: "Windows",
    projects: ["D:\\pi-e2e\\s7"],
    attachFile: path.join(dir, "remote-attach.json"),
    maxHours: 12,
    existsDir: () => true,
    exitHome: dir,
    launchWaitMs: 0,
    spawnImpl: () => ({ unref() {}, on() {} }),
    sessionLookup: async (id) => (id === "s1" ? { id: "s1", path: "C:\\sess\\t_s1.jsonl", cwd: "d:\\pi-e2e\\s7", deleted: false } : null),
    writeOut: () => {},
    exit: () => {},
    status: false,
  })
  const plan = await ctl.planLaunch({ cwd: "d:/pi-e2e/s7/", source: "remote" })
  assert.equal(plan.status, "spawn")
  assert.equal(plan.cwd, "D:\\pi-e2e\\s7")
  const resumed = await ctl.planLaunch({ sessionId: "s1", source: "remote" })
  assert.equal(resumed.status, "spawn")
  assert.equal(resumed.cwd, "D:\\pi-e2e\\s7")
})

/* ---------------- relay 真 WS：入库与下发 ---------------- */

const LOCAL_TOKEN = "local-token-path-r3-000001"
const VIEWER_TOKEN = "viewer-token-path-r3-0001"
const ADMIN_TOKEN = "admin-token-path-r3-000001"

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
    type(type, extra = () => true, ms = 3000) {
      const pred = (f) => f.type === type && extra(f)
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
            reject(new Error(`等待 ${type} 超时；已收到：${frames.map((f) => f.type).join(",")}`))
          }, ms),
        }
        waiters.push(w)
      })
    },
    close() {
      ws.terminate()
    },
  }
  return api
}

async function authedLocal(relay) {
  const c = client(relay.localPort)
  await c.opened
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN })
  assert.equal((await c.type("auth_result")).ok, true)
  return c
}

test("relay：房间注册与清单入库按设备平台统一 cwd；索引里的旧写法（D:/x）下发 session_list 时也统一，不改落盘", async (t) => {
  const relay = await startRelay({
    localPort: 0,
    viewerPort: 0,
    dataDir: fs.mkdtempSync(path.join(TMP, "relay-")),
    quiet: true,
    exitOnListenError: false,
    localToken: LOCAL_TOKEN,
    viewerToken: VIEWER_TOKEN,
    adminToken: ADMIN_TOKEN,
    flushIntervalMs: 10,
    perMessageDeflate: false,
  })
  t.after(() => relay.close())
  const win = await authedLocal(relay)
  t.after(() => win.close())
  win.send({ type: "device_register", device: { id: "dev-w", name: "Windows", platform: "windows", projects: ["D:\\pi-e2e\\s7"], windowExpiresAt: Date.now() + 3600e3 } })
  await new Promise((r) => setTimeout(r, 30))
  const accountId = relay.devices.get("dev-w").accountId
  // 旧 relay 已经落盘的写法：直接写进索引，模拟升级前的数据
  relay.index.applyManifest(accountId, "dev-w", { full: false, updatedAt: 1, sessions: [{ id: "legacy", name: "旧", cwd: "D:/pi-e2e/s7", updatedAt: 1 }] })

  const extc = await authedLocal(relay)
  t.after(() => extc.close())
  extc.send({ type: "room_register", room: { id: "R3", label: "s7", cwd: "d:/pi-e2e/s7/", deviceId: "dev-w", deviceName: "Windows", platform: "windows", epoch: 1, instance: "i" } })
  await extc.type("room_registered")
  assert.equal(relay.rooms.peek("R3").cwd, "D:\\pi-e2e\\s7")
  extc.send({
    type: "session_manifest",
    deviceId: "dev-w",
    full: false,
    updatedAt: 100,
    sessions: [
      { id: "R3", name: "", cwd: "D:/pi-e2e/s7", updatedAt: 20, active: true },
      { id: "old", name: "旧会话", cwd: "d:\\pi-e2e\\s7\\", updatedAt: 10 },
      { id: "nodrive", name: "x", cwd: "/work/", updatedAt: 5 },
    ],
  })
  await new Promise((r) => setTimeout(r, 40))
  const stored = Object.fromEntries(relay.index.listSessions(accountId, "dev-w").sessions.map((s) => [s.id, s.cwd]))
  assert.deepEqual(stored, { R3: "D:\\pi-e2e\\s7", old: "D:\\pi-e2e\\s7", nodrive: "/work", legacy: "D:/pi-e2e/s7" }, "入库统一；入库前的旧行不动")

  const v = client(relay.viewerPort)
  await v.opened
  t.after(() => v.close())
  v.send(authFrame(VIEWER_TOKEN))
  assert.equal((await v.type("auth_result")).ok, true)
  v.send({ type: "list_rooms" })
  const roster = await v.type("room_list", (f) => (f.rooms || []).some((r) => r.id === "R3"))
  assert.equal(roster.rooms.find((r) => r.id === "R3").cwd, "D:\\pi-e2e\\s7")
  v.send({ type: "get_sessions", id: "g1", deviceId: "dev-w" })
  const page = await v.type("session_list", (f) => f.id === "g1")
  assert.deepEqual(Object.fromEntries(page.sessions.map((s) => [s.id, s.cwd])), { R3: "D:\\pi-e2e\\s7", old: "D:\\pi-e2e\\s7", nodrive: "/work", legacy: "D:\\pi-e2e\\s7" })
})
