// P8 8.1b：正文搜索按房间并发（编排 10-25 22:20 决定，F-R6 的延伸）。
// 目标选择（每个 cwd 一个在线房间，没有在线房间才按设备）和结果合并（按会话文件路径去重、部分结果）都是纯函数，这里直接测；
// 最后两条是源码口径：useRelay 的接线、SearchContainer 把部分结果写出来。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { bodySearchTargetsOf, mergeBodySearchReplies } from "../ui/src/relay/bodySearch.ts"
import { RelayError, UNREGISTERED_DEVICE_ID } from "../ui/src/relay/devices.ts"
import { bodySearchErrorText, bodySearchPageOf, bodySearchPartialText, bodySearchTruncatedText } from "../ui/src/shell/searchModel.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")
const room = (id, cwd, lastActivity, extra = {}) => ({ id, cwd, lastActivity, online: true, deviceId: "mac", ...extra })
const hit = (session, mtime, matchCount = 1, extra = {}) => ({ session, id: session, title: session, cwd: "", mtime, matchCount, snippets: [{ text: "x" }], ...extra })
const page = (results, extra = {}) => ({ query: "STG", results, truncated: false, scannedFiles: 3, totalFiles: 3, ...extra })
const ok = (target, data) => ({ target, ok: true, data })
const bad = (target, error) => ({ target, ok: false, error })
const T1 = { kind: "room", roomId: "r1", cwd: "/tmp/proj" }
const T2 = { kind: "room", roomId: "r2", cwd: "/tmp/proj2" }
const T3 = { kind: "room", roomId: "r3", cwd: "/tmp/proj3" }

describe("目标选择 bodySearchTargetsOf", () => {
  test("每个不同的 cwd 选一个在线房间；同组取最近活动的；离线房间、别的设备的房间不算", () => {
    const rooms = [
      room("a1", "/tmp/proj", 100),
      room("a2", "/tmp/proj", 300),
      room("b1", "/tmp/proj2", 200),
      room("off", "/tmp/proj3", 900, { online: false }),
      room("other", "/tmp/proj4", 999, { deviceId: "linux" }),
    ]
    assert.deepEqual(bodySearchTargetsOf("mac", rooms), [
      { kind: "room", roomId: "a2", cwd: "/tmp/proj" },
      { kind: "room", roomId: "b1", cwd: "/tmp/proj2" },
    ])
  })
  test("打开的房间在它那组优先（即使不是最近活动的），并且排在最前；其余按最近活动新到旧", () => {
    const rooms = [room("a1", "/tmp/proj", 100), room("a2", "/tmp/proj", 300), room("b1", "/tmp/proj2", 500), room("c1", "/tmp/proj3", 50)]
    assert.deepEqual(
      bodySearchTargetsOf("mac", rooms, "a1").map((t) => t.roomId),
      ["a1", "b1", "c1"],
    )
    // 打开的房间离线时不算，那一组照常取在线里最近活动的
    const offlineOpen = [room("a1", "/tmp/proj", 100, { online: false }), room("a2", "/tmp/proj", 300)]
    assert.deepEqual(bodySearchTargetsOf("mac", offlineOpen, "a1").map((t) => t.roomId), ["a2"])
  })
  test("lastActivity 一样时取列表里更靠后的（同 pickEntryRoom）", () => {
    assert.deepEqual(bodySearchTargetsOf("mac", [room("x", "/p", 0), room("y", "/p", 0)]).map((t) => t.roomId), ["y"])
  })
  test("cwd 只统一斜杠和末尾斜杠（同一个目录）；大小写不同按两个目录（pi 的会话目录按 cwd 原文算）", () => {
    const rooms = [room("a", "/tmp/proj", 1), room("b", "/tmp/proj/", 2), room("c", "\\tmp\\proj", 3), room("d", "/tmp/Proj", 4)]
    assert.deepEqual(
      bodySearchTargetsOf("mac", rooms).map((t) => [t.roomId, t.cwd]),
      [
        ["d", "/tmp/Proj"],
        ["c", "\\tmp\\proj"],
      ],
    )
  })
  test("没有 cwd 的房间（旧扩展）不知道扫哪个目录，各算一个目标", () => {
    const rooms = [room("n1", null, 1), room("n2", null, 2)]
    assert.deepEqual(bodySearchTargetsOf("mac", rooms), [
      { kind: "room", roomId: "n2", cwd: "" },
      { kind: "room", roomId: "n1", cwd: "" },
    ])
  })
  test("这台设备一个在线房间都没有：只回按设备寻址的目标（原来的退路）", () => {
    assert.deepEqual(bodySearchTargetsOf("mac", []), [{ kind: "device", deviceId: "mac" }])
    assert.deepEqual(bodySearchTargetsOf("mac", [room("off", "/p", 1, { online: false }), room("l", "/p", 1, { deviceId: "linux" })]), [{ kind: "device", deviceId: "mac" }])
  })
  test("没登记设备的房间按 roomDeviceId 归到未登记设备（同侧栏的归属口径）", () => {
    const legacy = { id: "old", cwd: "/p", lastActivity: 1, online: true }
    assert.deepEqual(bodySearchTargetsOf(UNREGISTERED_DEVICE_ID, [legacy]), [{ kind: "room", roomId: "old", cwd: "/p" }])
    assert.deepEqual(bodySearchTargetsOf("mac", [legacy]), [{ kind: "device", deviceId: "mac" }])
  })
})

describe("结果合并 mergeBodySearchReplies", () => {
  test("两个项目的命中合在一起，按 mtime 新到旧；已扫 / 总数相加；任一页没扫完就算截断", () => {
    const merged = mergeBodySearchReplies("STG", [
      ok(T1, page([hit("/s/proj/a.jsonl", 10), hit("/s/proj/b.jsonl", 30)], { scannedFiles: 2, totalFiles: 2 })),
      ok(T2, page([hit("/s/proj2/c.jsonl", 20)], { truncated: true, scannedFiles: 5, totalFiles: 9 })),
    ])
    assert.equal(merged.ok, true)
    assert.deepEqual(merged.page.results.map((h) => h.session), ["/s/proj/b.jsonl", "/s/proj2/c.jsonl", "/s/proj/a.jsonl"])
    assert.equal(merged.page.scannedFiles, 7)
    assert.equal(merged.page.totalFiles, 11)
    assert.equal(merged.page.truncated, true)
    assert.equal(merged.page.query, "STG")
    assert.equal(merged.page.unanswered, undefined, "都回了就不是部分结果")
    assert.equal(bodySearchTruncatedText(merged.page), "已扫 7/11 个会话文件，结果可能不全")
  })
  test("同一个会话文件被两个目标回了：按路径去重（斜杠统一），留命中条数多的；一样多留 mtime 新的，再一样留先到的", () => {
    const merged = mergeBodySearchReplies("STG", [
      ok(T1, page([hit("/s/x.jsonl", 10, 1, { title: "少" }), hit("/s/y.jsonl", 10, 2, { title: "先到" }), hit("/s/z.jsonl", 5, 1, { title: "旧" })])),
      ok(T2, page([hit("\\s\\x.jsonl", 10, 3, { title: "多" }), hit("/s/y.jsonl", 10, 2, { title: "后到" }), hit("/s/z.jsonl", 8, 1, { title: "新" })])),
    ])
    assert.equal(merged.page.results.length, 3)
    const title = (path) => merged.page.results.find((h) => h.session.replace(/\\/g, "/") === path).title
    assert.equal(title("/s/x.jsonl"), "多")
    assert.equal(title("/s/y.jsonl"), "先到")
    assert.equal(title("/s/z.jsonl"), "新")
  })
  test("有房间超时：结果照常合并，页上带 unanswered（项目目录 + 错误码），文案写「部分结果」", () => {
    const merged = mergeBodySearchReplies("STG", [
      ok(T1, page([hit("/s/a.jsonl", 1)])),
      bad(T2, new RelayError("timeout", "命令超时")),
      bad(T3, new RelayError("result_unknown", "命令没有回应")),
    ])
    assert.equal(merged.ok, true)
    assert.equal(merged.page.results.length, 1)
    assert.deepEqual(merged.page.unanswered, [
      { cwd: "/tmp/proj2", code: "timeout" },
      { cwd: "/tmp/proj3", code: "result_unknown" },
    ])
    assert.equal(bodySearchPartialText(merged.page), "部分结果：proj2、proj3 没有及时回应")
  })
  test("回包形状不对的目标按失败算（bad_reply），不硬撑", () => {
    const merged = mergeBodySearchReplies("STG", [ok(T1, page([hit("/s/a.jsonl", 1)])), ok(T2, { nope: true })])
    assert.deepEqual(merged.page.unanswered, [{ cwd: "/tmp/proj2", code: "bad_reply" }])
    assert.equal(bodySearchPartialText(merged.page), "部分结果：proj2 搜索失败")
  })
  test("全部失败：返回第一个失败的原错误（协议码保留，SearchContainer 照码出文案）", () => {
    const first = new RelayError("timeout", "命令超时")
    const merged = mergeBodySearchReplies("STG", [bad(T1, first), bad(T2, new RelayError("no_room", "会话不存在"))])
    assert.equal(merged.ok, false)
    assert.equal(merged.error, first)
    assert.equal(bodySearchErrorText(merged.error.code, merged.error.message), "搜索超时，宿主没有及时回应，请重试")
    const shapes = mergeBodySearchReplies("STG", [ok(T1, null)])
    assert.equal(shapes.ok, false)
    assert.equal(shapes.error.code, "bad_reply")
    assert.equal(bodySearchErrorText(shapes.error.code, shapes.error.message), "正文搜索回包形状不对，请重试")
  })
  test("合并页过一遍 bodySearchPageOf（SearchContainer 的归一）以后，部分结果还在；单个扩展回包没有这个字段", () => {
    const merged = mergeBodySearchReplies("STG", [ok(T1, page([hit("/s/a.jsonl", 1)])), bad(T2, new RelayError("unsupported", "不支持"))])
    const again = bodySearchPageOf(JSON.parse(JSON.stringify(merged.page)))
    assert.deepEqual(again.unanswered, [{ cwd: "/tmp/proj2", code: "unsupported" }])
    assert.equal(bodySearchPartialText(again), "部分结果：proj2 的扩展不支持正文搜索")
    const single = bodySearchPageOf(page([hit("/s/a.jsonl", 1)]))
    assert.equal("unanswered" in single, false)
    assert.equal(bodySearchPartialText(single), null)
  })
  test("几种原因混在一起时分开写；没有 cwd 的目标写「一个项目」", () => {
    const text = bodySearchPartialText(
      page([], {
        unanswered: [
          { cwd: "/w/api", code: "timeout" },
          { cwd: "", code: "no_room" },
          { cwd: "C:\\w\\web", code: "timeout" },
        ],
      }),
    )
    assert.equal(text, "部分结果：api、web 没有及时回应；一个项目 搜索失败")
  })
})

describe("接线（源码口径）", () => {
  test("useRelay.searchSessionBodies：选目标 → 没有房间目标按设备 → 有就按房间并发、合并，全部失败抛第一个错", () => {
    const src = read("relay/useRelay.ts")
    const at = src.indexOf("const searchSessionBodies = useCallback(")
    const fn = src.slice(at, src.indexOf("const sessionNameForPath", at))
    assert.match(fn, /bodySearchTargetsOf\(deviceId, authedRef\.current \? roomsRef\.current : \[\], roomRef\.current\)/, "连接没认证时不按房间发")
    assert.match(fn, /Promise\.allSettled\(\s*roomTargets\.map\(\(target\) => channel\.command\(target\.roomId, "search_session_bodies", \{ query \}/)
    assert.match(fn, /mergeBodySearchReplies\(\s*query,/)
    assert.match(fn, /if \(!merged\.ok\) throw merged\.error\s*return merged\.page/)
  })
  test("SearchContainer 在内容匹配的说明里写出部分结果（role=status，和截断说明并列）", () => {
    const src = read("pi/containers/SearchContainer.tsx")
    assert.match(src, /const partial = bodySearchPartialText\(body\.page\)/)
    assert.match(src, /truncated \|\| partial \|\| bodyRows\.length === 0/)
    assert.match(src, /\{partial \? <span role="status">\{partial\}<\/span> : null\}/)
  })
})
