// P9 B（§4.7 网页 / §4.9 测试）：session_removed 的本地清理。纯函数在 ui/src/relay/sessionRemoved.ts，
// 帧校验、清单/名册/正文缓存/草稿的移除、被删会话的切走目标都在这里测；最后两条按源码口径核对
// useRelay 的接线（帧在房间过滤之前处理、purge 路径不写 localStorage 隐藏表）。
// node --test 直接加载 .ts（Node ≥22.18 类型剥离，相对导入带扩展名）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import {
  SESSION_REMOVED_MAX_IDS,
  archiveKeysOf,
  createPurgedSessionTable,
  fallbackSessionOf,
  parseSessionRemoved,
  purgedIdsOf,
  rememberPurgedSessions,
  removalTargetOf,
  withoutPurgedSessions,
  withoutRemovedDrafts,
  withoutRemovedRooms,
  withoutRemovedSessions,
} from "../ui/src/relay/sessionRemoved.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")

const room = (id, extra = {}) => ({ id, label: null, name: null, firstMessage: null, cwd: `/w/${id}`, online: true, busy: false, viewers: 1, lastActivity: 1, deviceId: "mac", ...extra })
const session = (id, extra = {}) => ({ id, updatedAt: 1, ...extra })

describe("parseSessionRemoved：帧校验", () => {
  test("合法帧：deviceId 非空、ids 去重保序", () => {
    assert.deepEqual(parseSessionRemoved({ deviceId: "mac", ids: ["s1", "s2", "s1"] }), { deviceId: "mac", ids: ["s1", "s2"] })
    assert.deepEqual(parseSessionRemoved({ deviceId: " mac ", ids: ["s1"] }), { deviceId: "mac", ids: ["s1"] }, "deviceId 去空白")
  })
  test("坏帧整帧丢掉：没有 deviceId / 没有合法 id / ids 不是数组", () => {
    assert.equal(parseSessionRemoved({ ids: ["s1"] }), null)
    assert.equal(parseSessionRemoved({ deviceId: "", ids: ["s1"] }), null)
    assert.equal(parseSessionRemoved({ deviceId: 42, ids: ["s1"] }), null)
    assert.equal(parseSessionRemoved({ deviceId: "mac" }), null)
    assert.equal(parseSessionRemoved({ deviceId: "mac", ids: [] }), null)
    assert.equal(parseSessionRemoved({ deviceId: "mac", ids: ["", 7, "has space", "bad/id"] }), null, "全是非法 id")
  })
  test("非法 id 单项跳过、合法的照收；最多认 SESSION_REMOVED_MAX_IDS 条", () => {
    const parsed = parseSessionRemoved({ deviceId: "mac", ids: ["ok", 7, "", "has space", "also-ok"] })
    assert.deepEqual(parsed, { deviceId: "mac", ids: ["ok", "also-ok"] })
    assert.equal(SESSION_REMOVED_MAX_IDS, 200)
    const many = Array.from({ length: 250 }, (_, k) => `s${k}`)
    assert.equal(parseSessionRemoved({ deviceId: "mac", ids: many }).ids.length, 200)
  })
})

describe("withoutRemovedSessions：会话清单移除", () => {
  test("去掉被删的 id，其余保序；引用不变时返回同一个数组", () => {
    const list = [session("s1"), session("s2"), session("s3")]
    assert.deepEqual(withoutRemovedSessions(list, new Set(["s2"])).map((x) => x.id), ["s1", "s3"])
    assert.equal(withoutRemovedSessions(list, new Set(["nope"])), list)
    assert.equal(withoutRemovedSessions(list, new Set()), list)
    assert.equal(withoutRemovedSessions(undefined, new Set(["s1"])), undefined)
  })
})

describe("withoutRemovedRooms：名册移除", () => {
  test("只去掉这台设备上的离线房间；在线房间、别的设备上的同 id 房间都留着", () => {
    const rooms = [
      room("s1", { online: false }),
      room("s2", { online: false, deviceId: "linux" }),
      room("s1", { online: true }),
      room("keep", { online: false }),
    ]
    assert.deepEqual(withoutRemovedRooms(rooms, "mac", new Set(["s1"])).map((r) => `${r.id}:${r.online}:${r.deviceId}`), [
      "s2:false:linux",
      "s1:true:mac",
      "keep:false:mac",
    ])
    assert.equal(withoutRemovedRooms(rooms, "mac", new Set(["nope"])), rooms, "没有要去的原样返回")
    assert.equal(withoutRemovedRooms([], "mac", new Set(["s1"])).length, 0)
  })
})

describe("archiveKeysOf + withoutRemovedDrafts：正文缓存键与草稿", () => {
  test("正文缓存键是 `${deviceId}\\n${id}`，与 useRelay 的 archivesRef 同写法", () => {
    assert.deepEqual(archiveKeysOf("mac", ["s1", "s2"]), ["mac\ns1", "mac\ns2"])
  })
  test("草稿表去掉被删房间的条目（只读 id 命中的）；引用不变时原样返回", () => {
    const table = { s1: { text: "给 s1 的草稿", at: 1 }, s2: { text: "留着的草稿", at: 2 } }
    assert.deepEqual(withoutRemovedDrafts(table, new Set(["s1"])), { s2: { text: "留着的草稿", at: 2 } })
    assert.equal(withoutRemovedDrafts(table, new Set(["nope"])), table)
    assert.equal(withoutRemovedDrafts({}, new Set(["s1"])).constructor, Object)
  })
})

describe("fallbackSessionOf：当前会话被删后切到哪", () => {
  test("优先还有房间的最近会话（清单已按 updatedAt 新到旧），否则取清单第一行；都没有返回 null", () => {
    const sessions = [session("gone"), session("recent-ended"), session("older-online"), session("oldest")]
    // 「最近」= 清单顺序：recent-ended 没有房间，older-online 有房间 → 选它（可打开）
    assert.equal(fallbackSessionOf(sessions, new Set(["older-online"]), new Set(["gone"])), "older-online")
    // 一个房间都没有：退而取第一行（打开后可能进空态，由 subscribe 的 no_room 再兜底）
    assert.equal(fallbackSessionOf(sessions, new Set(), new Set(["gone"])), "recent-ended")
    // 全被删
    assert.equal(fallbackSessionOf(sessions, new Set(["older-online"]), new Set(["gone", "recent-ended", "older-online", "oldest"])), null)
    assert.equal(fallbackSessionOf(undefined, new Set(), new Set(["x"])), null)
  })
})

describe("removalTargetOf：当前会话被删后的去向（切会话 / 进新建会话页）", () => {
  test("同设备还有会话 → switch（优先还有房间的）；一条都没有 / 全被删 → new-session", () => {
    const sessions = [session("gone"), session("ended"), session("online"), session("older")]
    assert.deepEqual(removalTargetOf(sessions, new Set(["online"]), new Set(["gone"])), { kind: "switch", id: "online" })
    assert.deepEqual(removalTargetOf(sessions, new Set(), new Set(["gone"])), { kind: "switch", id: "ended" }, "没有房间就取清单第一行")
    assert.deepEqual(removalTargetOf([session("gone")], new Set(), new Set(["gone"])), { kind: "new-session" })
    assert.deepEqual(removalTargetOf([], new Set(["x"]), new Set()), { kind: "new-session" })
    assert.deepEqual(removalTargetOf(undefined, new Set(), new Set(["x"])), { kind: "new-session" })
  })
})

describe("useRelay 的 session_removed 归约（与帧分支同序的纯函数链）", () => {
  test("一帧下来：清单/名册/正文缓存/草稿都清掉，被删会话切到同设备最近的会话", () => {
    const frame = parseSessionRemoved({ deviceId: "mac", ids: ["gone", "gone2"] })
    assert.ok(frame)
    const gone = new Set(frame.ids)
    // 输入：清单 4 行、名册 3 个房间（gone / gone2 离线、keep 在线）、正文缓存 2 条、草稿 2 条
    const sessions = [session("gone"), session("keep"), session("gone2"), session("older")]
    const rooms = [room("gone", { online: false }), room("gone2", { online: false }), room("keep", { online: true })]
    const archives = new Map(archiveKeysOf("mac", ["gone", "keep"]).map((k) => [k, { id: "x" }]))
    const drafts = { gone: { text: "写了一半", at: 1 }, keep: { text: "留着", at: 2 } }
    // 归约
    const keptSessions = withoutRemovedSessions(sessions, gone)
    const keptRooms = withoutRemovedRooms(rooms, frame.deviceId, gone)
    for (const key of archiveKeysOf(frame.deviceId, frame.ids)) archives.delete(key)
    const keptDrafts = withoutRemovedDrafts(drafts, gone)
    // 断言
    assert.deepEqual(keptSessions.map((x) => x.id), ["keep", "older"])
    assert.deepEqual(keptRooms.map((x) => x.id), ["keep"], "删掉的离线房间摘掉，keep 在线房间留着")
    assert.deepEqual([...archives.keys()], ["mac\nkeep"], "被删会话的正文缓存摘掉，别的留着")
    assert.deepEqual(Object.keys(keptDrafts), ["keep"], "被删会话的草稿删掉")
    // 当前会话是被删的 gone → 去同一台设备最近的会话（'keep' 有在线房间）
    const target = removalTargetOf(keptSessions, new Set(keptRooms.map((r) => r.id)), gone)
    assert.deepEqual(target, { kind: "switch", id: "keep" })
    // 同一帧把该设备最后一个会话也删掉：没有可切的了 → 进新建会话页（useRelay 发 purgedRoom 信号）
    assert.deepEqual(removalTargetOf([], new Set(), gone), { kind: "new-session" })
  })
})

/* ---------------- B1：在途 get_sessions 回包 vs session_removed 的整表覆盖竞态 ---------------- */

describe("B1 rememberPurgedSessions / purgedIdsOf：记录已 purge 会话", () => {
  test("按设备记 id；同一帧重复点名不变；纯函数不改入参，没有新增时返回原表", () => {
    const table0 = createPurgedSessionTable()
    const table1 = rememberPurgedSessions(table0, "mac", ["gone", "gone2"])
    assert.deepEqual([...purgedIdsOf(table1, "mac")], ["gone", "gone2"])
    assert.equal(table0.size, 0, "入参不被修改")
    assert.equal(rememberPurgedSessions(table1, "mac", ["gone"]), table1, "没有新增 → 原表")
    assert.equal(rememberPurgedSessions(table1, "mac", []), table1)
    assert.equal(rememberPurgedSessions(table1, "", ["x"]), table1)
    assert.equal(purgedIdsOf(table1, "linux"), undefined, "别的设备没有")
    assert.equal(purgedIdsOf(table1, "linux"), undefined)
    assert.equal(purgedIdsOf(rememberPurgedSessions(table0, " mac ", ["x"]), "mac").has("x"), true, "deviceId 去空白")
  })
  test("多设备互不影响；后来的帧只追加自己的设备", () => {
    let table = createPurgedSessionTable()
    table = rememberPurgedSessions(table, "mac", ["s1"])
    table = rememberPurgedSessions(table, "linux", ["s1"])
    table = rememberPurgedSessions(table, "mac", ["s2"])
    assert.deepEqual([...purgedIdsOf(table, "mac")], ["s1", "s2"])
    assert.deepEqual([...purgedIdsOf(table, "linux")], ["s1"])
  })
})

describe("B1 withoutPurgedSessions：回包落地前过滤已 purge 会话", () => {
  test("去掉这台设备已 purge 的行，其余保序；没有命中时引用不变", () => {
    const list = [session("gone"), session("keep"), session("gone2")]
    assert.deepEqual(withoutPurgedSessions(list, new Set(["gone", "gone2"])).map((x) => x.id), ["keep"])
    assert.equal(withoutPurgedSessions(list, new Set(["nope"])), list, "没有命中 → 同一个数组（跳过 setState）")
    assert.equal(withoutPurgedSessions(list, new Set()), list)
    assert.equal(withoutPurgedSessions(list, undefined), list)
    assert.equal(withoutPurgedSessions(undefined, new Set(["gone"])), undefined)
    assert.equal(withoutPurgedSessions([], new Set(["gone"])).length, 0)
  })

  test("B1 时序：请求发出 → 期间 session_removed → 回包才落地：已删行被过滤，不会整表写回", () => {
    // 1) 页面挂载时发出的 get_sessions：解析出的整表快照（还含即将被删的 target，也含别的设备行）
    const fetched = [session("target"), session("keep-a"), session("keep-b")]
    // 2) 回包在路上时收到 session_removed{mac,[target]}：先记进 purged 表（帧分支第一步）
    const purged = rememberPurgedSessions(createPurgedSessionTable(), "mac", ["target"])
    // 3) 回包落地：按落地当下的 purged 名单过滤后再写 sessionsByDevice
    const landed = withoutPurgedSessions(fetched, purgedIdsOf(purged, "mac"))
    assert.deepEqual(landed.map((x) => x.id), ["keep-a", "keep-b"], "target 不会被写回")
    // 4) 落地后仍是最终清单：再来一次（例如重连补拉）也不会出现
    assert.deepEqual(withoutPurgedSessions(fetched, purgedIdsOf(purged, "mac")).map((x) => x.id), ["keep-a", "keep-b"])
  })

  test("B1 时序（反方向）：快照先到、删除帧后到 —— 由 withoutRemovedSessions 清掉，两条路合起来都不会写回", () => {
    const fetched = [session("target"), session("keep")]
    const purgedBefore = createPurgedSessionTable() // 快照落地时还没有 purge
    const landed = withoutPurgedSessions(fetched, purgedIdsOf(purgedBefore, "mac"))
    assert.equal(landed, fetched, "先落地时原样收下（随后删除帧把它摘掉）")
    const afterFrame = withoutRemovedSessions(landed, new Set(["target"]))
    assert.deepEqual(afterFrame.map((x) => x.id), ["keep"])
  })

  test("别的设备上的同 id 会话不受影响（purged 表按设备存）", () => {
    const purged = rememberPurgedSessions(createPurgedSessionTable(), "mac", ["s1"])
    const linuxSnapshot = [session("s1"), session("s2")]
    assert.deepEqual(withoutPurgedSessions(linuxSnapshot, purgedIdsOf(purged, "linux")), linuxSnapshot)
  })
})

describe("B1 接线（源码口径）：purged 名单参与 get_sessions 落地", () => {
  test("useRelay：ref 初始化、session_removed 记名单、loadSessions 落地前过滤、写文件回包也跳过已 purge 行", () => {
    const src = read("relay/useRelay.ts")
    assert.match(src, /const purgedSessionsRef = useRef\(createPurgedSessionTable\(\)\)/)
    const removedAt = src.indexOf('if (type === "session_removed") {')
    assert.ok(removedAt > 0)
    const branch = src.slice(removedAt, src.indexOf('if (type === "error")', removedAt))
    assert.match(
      branch,
      /purgedSessionsRef\.current = rememberPurgedSessions\(purgedSessionsRef\.current, removed\.deviceId, removed\.ids\)/,
      "先记已 purge 名单，再清清单/名册/正文",
    )
    const loadAt = src.indexOf("const loadSessions = useCallback(")
    const load = src.slice(loadAt, src.indexOf("const clearPending = useCallback(", loadAt))
    assert.match(load, /withoutPurgedSessions\(fetched, purgedIdsOf\(purgedSessionsRef\.current, deviceId\)\)/, "整表回包落地前过滤")
    const fetchedAt = load.indexOf("const fetched = withoutDeletedSessions")
    const setAt = load.indexOf("setSessionsByDevice")
    assert.ok(fetchedAt > 0 && setAt > fetchedAt, "先过滤再写 sessionsByDevice")
    assert.match(load, /tickets\.isCurrent\(deviceId, ticket\)/, "每设备查询代次守卫照旧（最新请求才落地）")
    const upsertAt = src.indexOf("const upsertSessionRow = useCallback(")
    const upsert = src.slice(upsertAt, src.indexOf("// 扩展会在写文件后立刻发增量 manifest", upsertAt))
    assert.match(upsert, /if \(purgedIdsOf\(purgedSessionsRef\.current, deviceId\)\?\.has\(row\.id\)\) return/, "改名/fork 回包晚于 purge 也不写回")
  })
})

describe("接线（源码口径）", () => {
  test("useRelay：session_removed 在房间过滤之前处理，清五处，并在当前会话被删时清房/切走 + 提示", () => {
    const src = read("relay/useRelay.ts")
    const at = src.indexOf('if (type === "session_removed") {')
    assert.ok(at > 0, "有 session_removed 分支")
    const branch = src.slice(at, src.indexOf('if (type === "error")', at))
    assert.match(branch, /const removed = parseSessionRemoved\(msg\)/)
    assert.match(branch, /setSessionsByDevice\(\(prev\) => \(\{ \.\.\.prev, \[removed\.deviceId\]: keptSessions as SessionEntry\[\] \}\)\)/)
    assert.match(branch, /const keptRooms = withoutRemovedRooms\(roomsRef\.current, removed\.deviceId, gone\)/)
    assert.match(branch, /for \(const key of archiveKeysOf\(removed\.deviceId, removed\.ids\)\) archivesRef\.current\.delete\(key\)/)
    assert.match(branch, /for \(const id of removed\.ids\) saveRoomDraft\(id, ""\)/)
    assert.match(branch, /const target = removalTargetOf\(known, knownRoomIds, gone\)/)
    assert.match(branch, /if \(target\.kind === "switch"\) subscribeRef\.current\(target\.id, true\)/)
    assert.match(branch, /else setPurgedRoom\(\{ deviceId: removed\.deviceId, id: current \|\| lazy, at: Date\.now\(\) \}\)/)
    assert.match(branch, /draftHydratedRef\.current = false/, "先关草稿对账，避免写回被删会话")
    assert.match(branch, /setNotice\(\{ text: "这个会话已被删除", tone: "warn" \}\)/)
    const filterAt = src.indexOf("if (msg.room && msg.room !== roomRef.current) return", at)
    assert.ok(filterAt > at, "账户级帧，必须在房间过滤之前处理")
  })
  test("useRelay 暴露一次性信号 purgedRoom（state + 返回对象），供容器层切新建会话页", () => {
    const src = read("relay/useRelay.ts")
    assert.match(src, /const \[purgedRoom, setPurgedRoom\] = useState<\{ deviceId: string; id: string; at: number \} \| null>\(null\)/)
    assert.match(src, /^    purgedRoom,$/m, "Relay 返回对象带 purgedRoom")
  })
  test("PiAppBody：监听 purgedRoom，roomId 已清、界面在会话视图时 act.newSession()，按 at 只处理一次", () => {
    const src = read("pi/containers/PiAppBody.tsx")
    assert.match(src, /const \{ relay, ui, act \} = app/)
    assert.match(src, /const purge = relay\.purgedRoom/)
    assert.match(src, /if \(!purge \|\| purge\.at === handledPurgeAt\.current\) return/)
    assert.match(src, /if \(relay\.roomId\) return/, "房还没清完就等下一次 effect")
    assert.match(src, /if \(ui\.view !== "session"\) return/)
    assert.match(src, /handledPurgeAt\.current = purge\.at/)
    assert.match(src, /act\.newSession\(\)/)
    assert.match(src, /\[relay\.purgedRoom, relay\.roomId, ui\.view, act\]/, "信号 / 房间 / 视图变化都重新判一次")
  })
  test("useRelay：sessionsByDevice 有 ref 镜像（onmessage 闭包读最新清单）；purge 路径不写 localStorage 隐藏表（D6）", () => {
    const src = read("relay/useRelay.ts")
    assert.match(src, /const sessionsByDeviceRef = useRef\(sessionsByDevice\)/)
    assert.match(src, /sessionsByDeviceRef\.current = sessionsByDevice/)
    const at = src.indexOf("const deleteSession = useCallback(")
    const fn = src.slice(at, src.indexOf("\n  )\n", at))
    assert.match(fn, /if \(hasCap\(serverRef\.current, "session\.purge"\)\)/)
    assert.match(fn, /channel\.deviceCommand\(target, "delete_session", \{ sessionId: id \}/)
    assert.doesNotMatch(fn, /rememberDeletedSession\(/, "D6：有 session.purge 时不写隐藏表，等 relay 广播 session_removed")
  })
})
