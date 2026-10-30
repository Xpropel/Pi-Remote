// Regression: opening a listed session left behind by a superseded device
// registration threw `TypeError: Cannot read properties of null (reading
// 'deviceId')` once per click in the Claude desktop sidebar.
//
// Root cause, two layers:
//  1. ClaudeUnifiedSidebar's selectSession action handed the bare session
//     id STRING to relay.selectListedSession, whose contract requires the
//     listed-session row object (every other call site resolves the row).
//  2. Inside selectListedSession, the already-selected guard read
//     `selected?.id === row.id && selected.deviceId === ...`: with a
//     string row (row.id undefined) and no lazy selection active
//     (selected null, so selected?.id also undefined), the first clause
//     passed on undefined === undefined and the second dereferenced null.
//
// Pure functions are imported from the .ts sources directly; the tsx /
// hook surfaces are covered by static source guards, matching the
// established test style in this repo.
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const sidebarSource = await import("../ui/src/pi/model/sidebarSource.ts")
const { sidebarRowForKey, openSessionRow } = sidebarSource

/* ------------------------------------------------------------- fixtures -- */

// The device as re-registered (online) and its superseded registration
// (still in the roster as an offline entry, its old sessions still listed).
const newDevice = { id: "dev-new", name: "UI测试机B", online: true, platform: "linux" }
const oldDevice = { id: "dev-old", name: "UI测试机B", online: false, platform: "linux" }
const devices = [newDevice, oldDevice]

const staleEntry = {
  id: "sess-stale",
  name: "",
  firstMessage: "请运行命令 echo TO-OLD",
  path: "/home/user/.pi/agent/sessions/old.jsonl",
  cwd: "/work/old",
  messageCount: 3,
  sizeBytes: 1024,
  updatedAt: 500,
  active: false,
  online: false,
}
const sessionsByDevice = { "dev-old": [staleEntry], "dev-new": [] }
const rooms = []

/* ------------------------------------------- key resolution (the fix) -- */

test("stale session: sidebar key resolves to the merged row of the superseded device", () => {
  const row = sidebarRowForKey(devices, rooms, sessionsByDevice, "dev-old::sess-stale")
  assert.ok(row, "row must resolve")
  assert.equal(row.id, "sess-stale")
  assert.equal(row.deviceId, "dev-old")
  // Offline device: the row is a listed session, not an openable room.
  assert.equal(row.openable, false)
  assert.equal(row.path, staleEntry.path)
})

test("stale session: bare session id (search overlay) resolves too", () => {
  const row = sidebarRowForKey(devices, rooms, sessionsByDevice, "sess-stale")
  assert.ok(row)
  assert.equal(row.deviceId, "dev-old")
})

test("stale session: unknown keys resolve to null instead of a fabricated row", () => {
  assert.equal(sidebarRowForKey(devices, rooms, sessionsByDevice, "dev-old::sess-gone"), null)
  assert.equal(sidebarRowForKey(devices, rooms, sessionsByDevice, "dev-old::"), null)
  assert.equal(sidebarRowForKey(devices, rooms, sessionsByDevice, ""), null)
})

/* --------------------------------- open path receives the row, not an id -- */

function fakeRelay(selectedDeviceId) {
  const calls = []
  return {
    calls,
    roomId: "",
    selectedDeviceId,
    selectDevice: (id) => calls.push(["selectDevice", id]),
    selectRoom: (id) => calls.push(["selectRoom", id]),
    selectListedSession: (row) => calls.push(["selectListedSession", row]),
  }
}

test("stale session: openSessionRow hands selectListedSession the row object", () => {
  const row = sidebarRowForKey(devices, rooms, sessionsByDevice, "dev-old::sess-stale")
  const relay = fakeRelay("dev-new")
  let opened = 0
  openSessionRow(relay, row, () => { opened += 1 })
  // Cross-device row: the device switches first, then the listed session
  // is selected locally with the FULL row object (never a bare string).
  assert.deepEqual(relay.calls.map((c) => c[0]), ["selectDevice", "selectListedSession"])
  assert.equal(relay.calls[0][1], "dev-old")
  const passed = relay.calls[1][1]
  assert.equal(typeof passed, "object")
  assert.equal(passed.id, "sess-stale")
  assert.equal(passed.deviceId, "dev-old")
  assert.equal(passed.path, staleEntry.path)
  assert.equal(opened, 1)
})

test("stale session: same-device listed row does not switch devices", () => {
  const row = sidebarRowForKey(devices, rooms, sessionsByDevice, "dev-old::sess-stale")
  const relay = fakeRelay("dev-old")
  openSessionRow(relay, row, () => {})
  assert.deepEqual(relay.calls.map((c) => c[0]), ["selectListedSession"])
})

/* ------------------------------------------------------- source guards -- */

test("guard: Claude desktop sidebar resolves the row before opening it", () => {
  const src = read("ui/src/pi/variants/claude/sidebar/ClaudeUnifiedSidebar.tsx")
  assert.ok(!src.includes("selectListedSession?.(id as never)"), "bare id must never reach selectListedSession")
  assert.ok(src.includes("sidebarRowForKey("), "selectSession must resolve the merged row")
  assert.ok(src.includes("openSessionRow(relay, row"), "selectSession must open through the shared row path")
})

test("guard: selectListedSession never dereferences the lazy selection after a ?. comparison", () => {
  const src = read("ui/src/relay/useRelay.ts")
  assert.ok(
    !src.includes("selected?.id === row.id && selected.deviceId"),
    "the ?. comparison can pass on undefined === undefined with selected === null",
  )
  assert.ok(src.includes("selected && selected.id === row.id && selected.deviceId === device.id"))
})
