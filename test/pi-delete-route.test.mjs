// P9 B（F-R7 + F-2）：删除三端一致。网页侧：
// - sessionDeleteRouteOf 的判序：目标正在运行 → 设备（session.purge + session.files）→ 同目录在线房间 →
//   设备离线（“设备未连接，连上后才能删除”）→ 新 relay 但 attach 旧（“这台设备的连接窗口（attach）需要更新”）/ 旧 relay 维持 R25 原因；
// - sessionMenuOf 的删除项用 via / reason 置灰；sessionDeleteErrorText 认三个新码；
// - 确认文案三种写法（旧 relay / 新 relay+trash / 新 relay 无 trash）；
// - 接线：SessionMenuContainer 调 relay.deleteSession，useRelay.deleteSession 有 session.purge 走设备命令、否则退回
//   deleteSessionFile；purge 路径不写 localStorage 隐藏表（D6，服务器广播 session_removed）。
// 纯函数 + 源码口径测试，node --test 直接加载 .ts。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { PI_MENU_REASON, sessionDeleteErrorText, sessionDeleteRouteOf, sessionMenuOf } from "../ui/src/pi/model/sessionMenu.ts"
import { RelayError, UNREGISTERED_DEVICE_ID } from "../ui/src/relay/devices.ts"
import {
  DELETED_SESSIONS_KEY,
  DELETED_SESSION_TTL_MS,
  readDeletedSessions,
  rememberDeletedSession,
  withoutDeletedRooms,
  withoutDeletedSessions,
} from "../ui/src/relay/deletedSessions.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")
const room = (id, cwd, lastActivity, extra = {}) => ({ id, cwd, lastActivity, online: true, deviceId: "mac", ...extra })
const target = (id, cwd, extra = {}) => ({ id, cwd, deviceId: "mac", ...extra })
/** 设备：online + attach 声明的 features（P9 B 用 features 判能不能走设备级删除） */
const device = (extra = {}) => ({ online: true, features: ["session.files"], ...extra })
const noDevice = null

describe("删除路由 sessionDeleteRouteOf（P9 B 判序）", () => {
  test("1. 目标有自己在线的房间 = 正在运行（via=null，由 sessionMenuOf 写 deleteRunning）", () => {
    const rooms = [room("s1", "/w/proj", 5), room("s2", "/w/proj", 1)]
    assert.deepEqual(sessionDeleteRouteOf(target("s1", "/w/proj"), rooms, "s2", device(), true), {
      running: true,
      via: null,
      roomId: null,
    })
    assert.equal(sessionDeleteRouteOf(target("s1", "/w/proj"), [room("s1", "/w/proj", 5, { online: false }), room("s2", "/w/proj", 1)], "s2", device(), true).running, false, "房间离线 = 没在运行")
  })
  test("2. relay 有 session.purge、设备在线且有 session.files：发设备级命令（不需要同目录房间）", () => {
    assert.deepEqual(sessionDeleteRouteOf(target("old", "/w/proj"), [], "", device(), true), { running: false, via: "device", roomId: null })
    // 设备在线但没有 session.files（attach 旧）：不走设备
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj"), [], "", device({ features: [] }), true).via, null)
    // 设备离线：也不走设备
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj"), [], "", device({ online: false }), true).via, null)
  })
  test("3. 没有设备能力但有同目录在线房间：走 R25 的 room 路（当前房间优先，否则最近活动的）", () => {
    const rooms = [room("cur", "/w/proj", 1), room("hot", "/w/proj", 900)]
    assert.deepEqual(sessionDeleteRouteOf(target("old", "/w/proj"), rooms, "cur", device({ features: [] }), true), {
      running: false,
      via: "room",
      roomId: "cur",
    })
    const other = [room("cur", "/w/proj", 999), room("a", "/w/proj2", 10), room("b", "/w/proj2", 30), room("c", "/w/proj2", 30)]
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj2"), other, "cur", device({ features: [] }), true).roomId, "c", "一样时取列表里更靠后的")
    // 离线房间、别的设备的房间不算
    const mixed = [room("off", "/w/proj2", 5, { online: false }), room("other", "/w/proj2", 9, { deviceId: "linux" })]
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj2"), mixed, "", device({ features: [] }), true).via, null)
  })
  test("4. 设备不在线且没有同目录在线房间：原因「设备未连接，连上后才能删除」", () => {
    const route = sessionDeleteRouteOf(target("old", "/w/proj"), [], "", device({ online: false }), true)
    assert.deepEqual(route, { running: false, via: null, roomId: null, reason: "设备未连接，连上后才能删除" })
    assert.equal(route.reason, PI_MENU_REASON.deleteDeviceOffline)
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj"), [], "", noDevice, true).reason, PI_MENU_REASON.deleteDeviceOffline, "设备不在名册里也按离线")
  })
  test("5. 设备在线但没有 session.files 也没有同目录房间：新 relay 说 attach 要更新；旧 relay 维持 R25", () => {
    assert.deepEqual(sessionDeleteRouteOf(target("old", "/w/proj"), [], "", device({ features: [] }), true), {
      running: false,
      via: null,
      roomId: null,
      reason: "这台设备的连接窗口（attach）需要更新",
    })
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj"), [], "", device({ features: [] }), true).reason, PI_MENU_REASON.deleteNeedsUpdate)
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj"), [], "", device(), false).reason, PI_MENU_REASON.deleteNoRoom, "旧 relay（没有 session.purge）不变")
  })
  test("目录比较同新建会话的 hasRunningRoom（cwdInProjects：斜杠、末尾斜杠、大小写都统一）", () => {
    assert.equal(sessionDeleteRouteOf(target("old", "/w/Proj/"), [room("r", "/w/proj", 1)], "", device({ features: [] }), true).roomId, "r")
    assert.equal(sessionDeleteRouteOf(target("old", "C:\\w\\proj"), [room("r", "c:/w/proj", 1)], "", device({ features: [] }), true).roomId, "r")
    assert.equal(sessionDeleteRouteOf(target("old", ""), [room("r", "/w/proj", 1)], "", device({ features: [] }), true).roomId, null)
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj"), [room("r", null, 1)], "", device({ features: [] }), true).roomId, null)
  })
  test("没登记设备的房间按 roomDeviceId 归到未登记设备（同侧栏的归属口径）", () => {
    const legacy = { id: "lg", cwd: "/w/proj", lastActivity: 1, online: true }
    assert.equal(sessionDeleteRouteOf({ id: "old", cwd: "/w/proj", deviceId: UNREGISTERED_DEVICE_ID }, [legacy], "", device({ features: [] }), true).roomId, "lg")
    assert.equal(sessionDeleteRouteOf(target("old", "/w/proj"), [legacy], "", device({ features: [] }), true).roomId, null)
  })
})

describe("删除的可用性 sessionMenuOf（items.delete）", () => {
  const base = {
    row: { id: "old", openable: false, path: "/s/old.jsonl", cwd: "/w/proj2" },
    currentRoomId: "cur",
    lazySessionId: null,
    authed: true,
    online: true,
    busy: false,
    deviceMode: true,
    deviceOnline: true,
    onSelectedDevice: true,
    deleteRoute: { running: false, via: "room", roomId: "r2" },
  }
  const del = (patch) => sessionMenuOf({ ...base, ...patch }).items.delete
  test("有路由（device 或 room）、目标没在运行：可以删（不再要求当前会话在线、在同一台设备上）", () => {
    assert.deepEqual(del({}), { disabled: false })
    assert.deepEqual(del({ deleteRoute: { running: false, via: "device", roomId: null } }), { disabled: false })
    assert.deepEqual(del({ online: false, lazySessionId: "cur" }), { disabled: false })
    assert.deepEqual(del({ onSelectedDevice: false }), { disabled: false }, "别的设备上的会话照样路由到那台设备")
  })
  test("目标正在运行：「会话正在运行，不能删除」", () => {
    assert.deepEqual(del({ deleteRoute: { running: true, via: null, roomId: null } }), { disabled: true, reason: "会话正在运行，不能删除" })
    assert.equal(del({ deleteRoute: { running: true, via: null, roomId: null } }).reason, PI_MENU_REASON.deleteRunning, "正在运行先说")
    // P9 第 1 轮审查 B3（a-waiting 探针发现）：运行中的会话是活动房间，列表行可能没有 path。
    // 「正在运行」必须先于「没有文件路径」判定，否则文案会错成「这个会话没有文件路径」。
    assert.deepEqual(
      del({ row: { id: "run", openable: false, path: "", cwd: "" }, deleteRoute: { running: true, via: null, roomId: null } }),
      { disabled: true, reason: "会话正在运行，不能删除" },
      "运行中的会话没有 path 时也要先说「会话正在运行」",
    )
  })
  test("via=null 时用 route.reason（设备离线 / attach 要更新 / 旧 relay 没有房间），缺 reason 回落 R25 文案", () => {
    const reason = (route) => del({ deleteRoute: { running: false, via: null, roomId: null, ...route } }).reason
    assert.equal(reason({ reason: PI_MENU_REASON.deleteDeviceOffline }), "设备未连接，连上后才能删除")
    assert.equal(reason({ reason: PI_MENU_REASON.deleteNeedsUpdate }), "这台设备的连接窗口（attach）需要更新")
    assert.equal(reason({ reason: PI_MENU_REASON.deleteNoRoom }), "这个项目里没有在运行的 pi，暂时删不了")
    assert.equal(reason({}), PI_MENU_REASON.deleteNoRoom)
  })
  test("原有的几条照旧在前面：当前会话、没有文件路径、服务器未连接", () => {
    assert.equal(del({ row: { ...base.row, id: "cur" } }).reason, PI_MENU_REASON.deleteCurrent)
    assert.equal(del({ row: { ...base.row, path: undefined } }).reason, PI_MENU_REASON.noPath)
    assert.equal(del({ authed: false }).reason, PI_MENU_REASON.linkDown)
    assert.equal(del({ authed: false, deleteRoute: { running: true, via: null, roomId: null } }).reason, PI_MENU_REASON.linkDown)
  })
})

describe("删除失败的文案 sessionDeleteErrorText", () => {
  const err = (code, message) => new RelayError(code, message)
  test("扩展拒绝（bad_args）：改写成中文，原文放在括号里", () => {
    const jail = "会话路径越界（必须在 /tmp/home/.pi/agent/sessions/--tmp-proj-- 内）"
    assert.equal(sessionDeleteErrorText(err("bad_args", jail)), `删除失败：会话不在可删范围内（${jail}）`)
    assert.equal(sessionDeleteErrorText(err("bad_args", "不能删除当前会话（先切换走再删）")), "删除失败：会话正在运行，不能删除（不能删除当前会话（先切换走再删））")
    assert.equal(sessionDeleteErrorText(err("bad_args", "只支持 .jsonl 会话文件")), "删除失败：这不是会话文件（只支持 .jsonl 会话文件）")
    assert.equal(sessionDeleteErrorText(err("bad_args", "怪原因")), "删除失败：电脑上的 pi 拒绝了这次删除（怪原因）")
  })
  test("文件不在了、pi 没准备好、删除出错（括号里不重复「删除失败：」）、没有权限", () => {
    assert.equal(sessionDeleteErrorText(err("not_found", "会话文件不存在：/s/a.jsonl")), "删除失败：会话文件已经不在了（会话文件不存在：/s/a.jsonl）")
    assert.equal(sessionDeleteErrorText(err("not_ready", "拿不到会话目录，拒绝切换会话")), "删除失败：这个项目的 pi 还没准备好（拿不到会话目录，拒绝切换会话）")
    assert.equal(sessionDeleteErrorText(err("internal", "删除失败：EBUSY: resource busy")), "删除失败：电脑上删除文件时出错（EBUSY: resource busy）")
    assert.equal(sessionDeleteErrorText(err("internal", "检查会话路径失败：没有权限（EACCES）")), "删除失败：没有权限删除这个文件（检查会话路径失败：没有权限（EACCES））")
  })
  test("P9 B 三个新码：session_running / device_update_required / device_offline（文案按 §4.1 表）", () => {
    assert.equal(sessionDeleteErrorText(err("session_running", "会话正在运行，不能删除")), "删除失败：会话正在运行，不能删除")
    assert.equal(sessionDeleteErrorText(err("device_update_required", "x")), "删除失败：这台设备的连接窗口（attach）需要更新")
    assert.equal(sessionDeleteErrorText(err("device_offline", "y")), "删除失败：设备未连接，连上后才能删除")
  })
  test("连接 / 超时这类照 deviceErrorText，前面加「删除失败：」；没有原文时不出空括号", () => {
    assert.equal(sessionDeleteErrorText(err("timeout", "x")), "删除失败：本机没有回应，请重试")
    assert.equal(sessionDeleteErrorText(err("room_offline", "本机未连接，无法执行")), "删除失败：本机未连接，无法执行")
    assert.equal(sessionDeleteErrorText(err("not_found", "")), "删除失败：会话文件已经不在了")
    assert.equal(sessionDeleteErrorText(new Error("")), "删除失败：失败")
  })
})

describe("删掉的会话的离线房间（localStorage 记录，编排 10-26 00:40）", () => {
  /** 内存版 localStorage（getItem 拿不到返回 null，同浏览器） */
  const memoryStorage = (init = {}) => {
    const data = new Map(Object.entries(init))
    return {
      data,
      getItem: (k) => (data.has(k) ? data.get(k) : null),
      setItem: (k, v) => data.set(k, String(v)),
      removeItem: (k) => data.delete(k),
    }
  }
  const NOW = 1_800_000_000_000
  const H = 3600 * 1000
  test("记下以后 6 小时内有效，写在 pi_remote_deleted_sessions 里（同一个浏览器的标签页读同一份）；过期的、坏的读的时候顺带清掉", () => {
    const s = memoryStorage()
    assert.equal(DELETED_SESSIONS_KEY, "pi_remote_deleted_sessions")
    assert.equal(DELETED_SESSION_TTL_MS, 6 * H)
    rememberDeletedSession(s, "s3", NOW)
    assert.deepEqual(JSON.parse(s.data.get(DELETED_SESSIONS_KEY)), { s3: NOW + 6 * H })
    assert.deepEqual([...readDeletedSessions(s, NOW + 6 * H - 1)], [["s3", NOW + 6 * H]])
    // 再记一条；先前那条已经过期：读的时候清掉，只剩新的
    rememberDeletedSession(s, "s2a", NOW + 6 * H)
    assert.deepEqual(JSON.parse(s.data.get(DELETED_SESSIONS_KEY)), { s2a: NOW + 12 * H })
    // 全部过期：键整个删掉
    assert.equal(readDeletedSessions(s, NOW + 12 * H).size, 0)
    assert.equal(s.data.has(DELETED_SESSIONS_KEY), false)
    // 坏的内容：不是对象、值不是数字 → 丢掉坏的、写回好的
    const bad = memoryStorage({ [DELETED_SESSIONS_KEY]: JSON.stringify({ ok: NOW + H, junk: "x", "": NOW + H }) })
    assert.deepEqual([...readDeletedSessions(bad, NOW)], [["ok", NOW + H]])
    assert.deepEqual(JSON.parse(bad.data.get(DELETED_SESSIONS_KEY)), { ok: NOW + H })
    const notJson = memoryStorage({ [DELETED_SESSIONS_KEY]: "{oops" })
    assert.equal(readDeletedSessions(notJson, NOW).size, 0)
    assert.equal(notJson.data.has(DELETED_SESSIONS_KEY), false)
    // 拿不到 localStorage（null / 抛错）：不落地、不抛，但照样返回这一次的记录，本页的名册照样去掉
    assert.deepEqual([...rememberDeletedSession(null, "x", NOW)], [["x", NOW + 6 * H]])
    assert.equal(readDeletedSessions(null, NOW).size, 0)
    const throwing = { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("denied") }, removeItem: () => {} }
    assert.equal(rememberDeletedSession(throwing, "x", NOW).get("x"), NOW + 6 * H, "写不进也照样返回这一次的记录")
  })
  test("名册里去掉删掉的会话的离线房间；在线房间、本页正打开的房间一律留着；没有要去掉的就原样返回同一个数组", () => {
    const rooms = [room("s3", "/w/proj", 1, { online: false }), room("s2a", "/w/proj2", 2, { online: false }), room("live", "/w/proj", 3), room("other", "/w/proj", 4, { online: false })]
    const deleted = new Map([["s3", NOW + H], ["s2a", NOW + H], ["live", NOW + H]])
    assert.deepEqual(withoutDeletedRooms(rooms, deleted).map((r) => r.id), ["live", "other"], "在线的 live 不隐藏")
    assert.deepEqual(withoutDeletedRooms(rooms, deleted, "s2a").map((r) => r.id), ["s2a", "live", "other"], "本页正打开的 s2a 留着")
    assert.equal(withoutDeletedRooms(rooms, new Map()), rooms)
    assert.equal(withoutDeletedRooms(rooms, new Map([["nope", NOW + H]])), rooms)
  })
  test("会话清单里也去掉（别的标签页手里的旧清单、索引还没更新时拉到的那一份）；没有要去掉的就原样返回", () => {
    const sessions = [{ id: "s3" }, { id: "keep" }]
    assert.deepEqual(withoutDeletedSessions(sessions, new Map([["s3", NOW + H]])), [{ id: "keep" }])
    assert.equal(withoutDeletedSessions(sessions, new Map()), sessions)
    assert.equal(withoutDeletedSessions(sessions, new Map([["nope", NOW + H]])), sessions)
  })
})

describe("接线（源码口径）", () => {
  test("SessionMenuContainer：用 sessionDeleteRouteOf(…device, serverPurge) 选路，经 relay.deleteSession 删除；成功提示分 trash / 其它", () => {
    const src = read("pi/containers/SessionMenuContainer.tsx")
    assert.match(src, /const serverPurge = relay\.serverCaps\.includes\("session\.purge"\)/)
    assert.match(src, /const deleteRoute = sessionDeleteRouteOf\(row, relay\.rooms, relay\.roomId, device, serverPurge\)/)
    assert.match(src, /deleteRoute,\n\s*\}\)/, "sessionMenuOf 拿同一份路由算禁用")
    assert.match(src, /await relay\.deleteSession\(\{ deviceId: t\.row\.deviceId, sessionId: t\.row\.id, sessionPath: t\.row\.path, roomId: route\.roomId \?\? "" \}\)/)
    assert.match(src, /throw new Error\(sessionDeleteErrorText\(error\)\)/)
    assert.match(src, /data\?\.method === "trash" \? `已移到 \$\{deleteDeviceName\} 的废纸篓` : `已从 \$\{deleteDeviceName\} 上删除`/)
    assert.match(src, /serverPurge=\{serverPurge\}/)
    assert.match(src, /trash=\{!!t\.device\?\.trash\}/)
    assert.doesNotMatch(src, /runCommand\("delete_session"/, "不再固定发给当前房间")
  })
  test("useRelay.deleteSession：有 session.purge 走设备级 delete_session（D6：不写 localStorage 隐藏表）；否则退回 deleteSessionFile", () => {
    const src = read("relay/useRelay.ts")
    const at = src.indexOf("const deleteSession = useCallback(")
    assert.ok(at > 0)
    // 只截 deleteSession 本体（到它自己的依赖数组收尾），别把后面的 storage 监听一起算进来
    const fn = src.slice(at, src.indexOf("\n  )\n", at))
    assert.match(fn, /if \(hasCap\(serverRef\.current, "session\.purge"\)\)/)
    assert.match(fn, /channel\.deviceCommand\(target, "delete_session", \{ sessionId: id \}/)
    assert.match(fn, /await deleteSessionFile\(\{ sessionId: id, sessionPath, roomId \}\)/)
    assert.doesNotMatch(fn, /rememberDeletedSession\(/, "D6：purge 路径不写隐藏表")
    assert.doesNotMatch(fn, /setSessionsByDevice\(/, "D6：purge 路径不手删，等 session_removed 帧")
  })
  test("useRelay：session_removed 帧处理在房间过滤之前，清清单/名册/正文缓存/草稿，当前会话被删时切走并提示", () => {
    const src = read("relay/useRelay.ts")
    const at = src.indexOf('if (type === "session_removed") {')
    assert.ok(at > 0, "有 session_removed 分支")
    const branch = src.slice(at, src.indexOf('if (type === "error")', at))
    assert.match(branch, /parseSessionRemoved\(msg\)/)
    assert.match(branch, /withoutRemovedSessions\(known, gone\)/)
    assert.match(branch, /withoutRemovedRooms\(roomsRef\.current, removed\.deviceId, gone\)/)
    assert.match(branch, /archiveKeysOf\(removed\.deviceId, removed\.ids\)/)
    assert.match(branch, /saveRoomDraft\(id, ""\)/)
    assert.match(branch, /const target = removalTargetOf\(known, knownRoomIds, gone\)/)
    assert.match(branch, /else setPurgedRoom\(\{ deviceId: removed\.deviceId, id: current \|\| lazy, at: Date\.now\(\) \}\)/, "无可切会话时发一次性信号给容器层进新建会话页")
    assert.match(branch, /setNotice\(\{ text: "这个会话已被删除", tone: "warn" \}\)/)
    const filterAt = src.indexOf("if (msg.room && msg.room !== roomRef.current) return", at)
    assert.ok(filterAt > at, "session_removed 在房间过滤之前处理（账户级帧，没有 room 字段）")
  })
  test("删除确认的文案照事实写：三种写法（旧 relay / 新 relay+trash / 新 relay 无 trash），不写「永久删除」", () => {
    const src = read("components/pi/shell/PiDeleteDialog.tsx")
    const shown = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    assert.doesNotMatch(shown, /永久删除|不可恢复/)
    assert.match(src, /const body = !serverPurge\n\s*\? `「\$\{title\}」的会话文件会从 \$\{device\} 上删除，没有回收站。服务器上缓存的副本不会跟着删除。`/)
    assert.match(src, /: trash\n\s*\? `「\$\{title\}」会移到 \$\{device\} 的废纸篓，和在 pi 里删除一样。服务器上的记录和副本会一起清除。`/)
    assert.match(src, /: `「\$\{title\}」的会话文件会从 \$\{device\} 上删除，这台设备没有废纸篓，删除后不能恢复。服务器上的记录和副本会一起清除。`/)
    // 画廊可交互版（#/play a 线）同步成新 relay + trash 的写法
    const play = read("pi/dev/play/a.tsx")
    assert.match(play, /会移到 \{deviceName\} 的废纸篓，和在 pi 里删除一样。服务器上的记录和副本会一起清除。/)
    assert.doesNotMatch(play, /没有回收站。服务器上缓存的副本不会跟着删除/)
  })
})
