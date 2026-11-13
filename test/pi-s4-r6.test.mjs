// S4 第六轮：新会话页（「打开那个会话」入口、最近目录全在运行时预选空闲的白名单目录）。纯函数直接跑；接线看源码。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { hasRunningRoom, newSessionDefaultsOf, runningRoomOf } from "../ui/src/pi/model/newSession.ts"

const read = (p) => fs.readFileSync(new URL(`../ui/src/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const between = (src, from, to) => {
  const at = src.indexOf(from)
  assert.ok(at >= 0, `找不到 ${from}`)
  return src.slice(at, to ? src.indexOf(to, at) : undefined)
}

describe("新会话：目录已有会话在运行时给「打开那个会话」", () => {
  const room = (id, cwd, extra = {}) => ({ id, cwd, online: true, deviceId: "pc", ...extra })
  test("runningRoomOf 交回那间房（和 hasRunningRoom 同一口径）；离线、别的设备、父目录都不算", () => {
    const rooms = [room("off", "D:\\w\\a", { online: false }), room("other", "D:\\w\\a", { deviceId: "mac" }), room("parent", "D:\\w"), room("hit", "D:\\w\\a")]
    assert.equal(runningRoomOf(rooms, "pc", "d:/w/a/")?.id, "hit")
    assert.equal(runningRoomOf(rooms, "pc", "D:\\w\\b"), null)
    assert.equal(hasRunningRoom(rooms, "pc", "D:\\w\\a"), true)
    assert.equal(hasRunningRoom(rooms.slice(0, 3), "pc", "D:\\w\\a"), false)
  })
  test("提示旁的按钮：先切设备（不同时）、再切房间、回会话视图；不动本页草稿和选择", () => {
    const src = code(read("pi/containers/NewSessionContainer.tsx"))
    const open = between(src, "const openRunning = (roomId: string) => {", "\n  }\n")
    assert.match(open, /if \(device && device\.id !== relay\.selectedDeviceId\) relay\.selectDevice\(device\.id\)\s*relay\.selectRoom\(roomId\)\s*act\.openSession\(\)/)
    assert.doesNotMatch(open, /setStore|setNewSessionDraft|setDraft/)
    const notes = between(src, "let note: ReactNode = null", "const pickSuggestion")
    const btn = between(between(notes, "} else if (runningRoom) {"), "<button", "</button>")
    assert.match(btn, /type="button"/)
    assert.match(btn, /data-cw-id="pi-new-open-running"/)
    assert.match(btn, /phone && TOUCH_44_DOWN/, "手机点击区 44，只向下外扩，不压输入框的钮")
    assert.match(btn, /onClick=\{\(\) => openRunning\(runningRoom\.id\)\}/)
    assert.match(btn, />\s*打开那个会话\s*$/)
  })
})

describe("新会话：最近目录全在运行时预选空闲的白名单目录", () => {
  const device = { id: "pc", name: "Windows", platform: "win32", online: true, projects: ["D:\\w\\a", "D:\\w\\b", "D:\\w\\c"], browseRoots: ["D:\\"] }
  const entry = (cwd, updatedAt) => ({ id: cwd, cwd, updatedAt })
  const room = (cwd, online = true) => ({ id: cwd, cwd, online, deviceId: "pc", lastActivity: 1 })
  const pick = (rooms, sessions, exclude) =>
    newSessionDefaultsOf({ devices: [device], rooms, sessionsByDevice: { pc: sessions }, selectedDeviceId: "pc" }, exclude).folder

  test("最近目录有空闲的：照旧取最近的空闲目录（不跳到白名单）", () => {
    assert.equal(pick([room("D:\\w\\a")], [entry("D:\\w\\a", 3), entry("D:\\pi\\x", 2)]), "D:\\pi\\x")
  })
  test("最近目录全在运行：取白名单里第一个没有在线会话的", () => {
    assert.equal(pick([room("D:\\w\\a"), room("D:\\pi\\x")], [entry("D:\\w\\a", 3), entry("D:\\pi\\x", 2)]), "D:\\w\\b")
    assert.equal(pick([room("D:\\w\\a"), room("D:\\w\\b")], [entry("D:\\w\\a", 3)]), "D:\\w\\c")
  })
  test("白名单也全在运行：退回最近的那个（框下会提示并给入口）；离线房间不算在运行", () => {
    const all = [room("D:\\w\\a"), room("D:\\w\\b"), room("D:\\w\\c")]
    assert.equal(pick(all, [entry("D:\\w\\b", 3)]), "D:\\w\\b")
    assert.equal(pick([room("D:\\w\\a", false)], [entry("D:\\w\\a", 3)]), "D:\\w\\a")
  })
  test("证实不存在的白名单目录不预选", () => {
    assert.equal(pick([room("D:\\w\\a")], [entry("D:\\w\\a", 3)], new Set(["d:/w/b"])), "D:\\w\\c")
  })
})
