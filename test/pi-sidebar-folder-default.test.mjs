// P11 调整：工作区分组默认折叠（未存 = 折叠）；首次点击展开并写 false；折叠时组头不显示会话数。
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(`../ui/src/pi/${path}`, import.meta.url), "utf8")

test("共享 hook：未存折叠时首次点击展开（?? true）", async () => {
  const hook = await read("sidebar/useSidebarLocal.ts")
  assert.equal(hook.includes("!(cur.folders[groupId] ?? true)"), true)
})

test("共享核：组头永远不渲染会话数量（展开/折叠都不显示）", async () => {
  const sections = await read("sidebar/components/SidebarSections.tsx")
  assert.equal(sections.includes("sb-wscount"), false)
  assert.equal(sections.includes("{group.count}"), false)
})

test("持久化语义：storage 纯函数只存显式 false/true，未存保持 undefined", async () => {
  const storage = await read("sidebar/storage.ts")
  assert.equal(storage.includes("setSidebarFolderCollapsed"), true)
})

// 第三轮（主控拍板）：仍默认折叠；没手动开合过的组里有「等你回答」/「出错」时自动展开，手动开合优先。
const model = await import("../ui/src/pi/sidebar/model.ts")
const row = (key, state = {}) => ({ key, id: key, title: key, status: model.sidebarStatusOf(state), pinned: false, archived: false })
const workspace = (id, sessions, collapsed = true) => ({ id, kind: "workspace", label: id, collapsed, sessions, count: sessions.length })
const collapsedOf = (groups, id) => groups.find((group) => group.id === id)?.collapsed

test("待处理自动展开：默认折叠不变，等你回答 / 出错才展开，运行中不算", () => {
  const groups = model.sidebarGroupsWithOverlay({
    folders: {},
    groups: [
      workspace("cwd:/idle", [row("d::a"), row("d::b", { running: true })]),
      workspace("cwd:/wait", [row("d::c"), row("d::w", { waiting: true })]),
      workspace("cwd:/err", [row("d::e", { error: true })]),
    ],
  })
  assert.equal(collapsedOf(groups, "cwd:/idle"), true)
  assert.equal(collapsedOf(groups, "cwd:/wait"), false)
  assert.equal(collapsedOf(groups, "cwd:/err"), false)
})

test("待处理自动展开：手动开合过的按存的来（收起的不被撑开，展开的不动）", () => {
  const groups = model.sidebarGroupsWithOverlay({
    folders: { "cwd:/shut": true, "cwd:/open": false },
    groups: [workspace("cwd:/shut", [row("d::w", { waiting: true })]), workspace("cwd:/open", [row("d::a")], false)],
  })
  assert.equal(collapsedOf(groups, "cwd:/shut"), true)
  assert.equal(collapsedOf(groups, "cwd:/open"), false)
  assert.equal(model.sidebarFolderCollapsedOf(undefined, false), true)
  assert.equal(model.sidebarFolderCollapsedOf(undefined, true), false)
  assert.equal(model.sidebarFolderCollapsedOf(true, true), true)
  assert.equal(model.sidebarFolderCollapsedOf(false, false), false)
})

test("待处理自动展开：置顶区里的、已归档的待处理行不撑开工作区组；不给 folders / 归档视图不变", () => {
  const input = { groups: [workspace("cwd:/p", [row("d::w", { waiting: true }), row("d::x", { error: true }), row("d::a")])] }
  const pinned = model.sidebarGroupsWithOverlay({ ...input, folders: {}, pins: ["d::w"], archives: ["d::x"] })
  assert.equal(pinned[0].id, "pinned")
  assert.equal(collapsedOf(pinned, "cwd:/p"), true)
  assert.equal(collapsedOf(model.sidebarGroupsWithOverlay(input), "cwd:/p"), true)
  const archived = model.sidebarGroupsWithOverlay({ groups: [workspace("cwd:/p", [row("d::x", { error: true })], false)], folders: {}, archives: ["d::x"], archiveView: true })
  assert.equal(collapsedOf(archived, "cwd:/p"), false)
})

test("待处理自动展开：开合按界面上的折叠态翻；手机接线传 folders", async () => {
  const hook = await read("sidebar/useSidebarLocal.ts")
  assert.equal(hook.includes("collapsedNow === undefined ? !(cur.folders[groupId] ?? true) : !collapsedNow"), true)
  const mobile = await read("mobile/useMobileSidebarData.ts")
  assert.equal(mobile.includes("folders: scopeState.folders"), true)
  assert.equal(mobile.includes("shown ? !shown.collapsed : !(current.folders[groupId] ?? true)"), true)
})

// 第四轮：排在第 5 行之后的待处理行不进「更多 N」，组才会自动展开、展开后也看得到它
const groupsModel = await import("../ui/src/pi/model/sidebarGroups.ts")
const DEVICE = { id: "d", name: "Mac", online: true, platform: "darwin", projects: ["/w/p"] }
const sessionAt = (id, k) => ({ id, deviceId: "d", cwd: "/w/p", title: id, online: true, busy: false, updatedAt: 10_000 - k, openable: true })
const EIGHT = Array.from({ length: 8 }, (_, k) => sessionAt(`s${k}`, k))
const waitingOn = (roomId) => ({ key: `dialog:${roomId}`, kind: "waiting", roomId, deviceId: "d", dialogId: "1", title: roomId, detail: "", at: 1 })
const erroredOn = (roomId) => ({ key: `turn:${roomId}:1`, kind: "error", roomId, deviceId: "d", dialogId: null, title: roomId, detail: "", at: 1 })

test("更多 N：排在后面的等你回答 / 出错行照样露出，原顺序；更多只数真正收起的", () => {
  const [plain] = groupsModel.sidebarGroups(EIGHT, [DEVICE], []).groups
  assert.deepEqual(plain.rows.map((r) => r.id), ["s0", "s1", "s2", "s3", "s4"])
  assert.equal(plain.more, 3)
  const doneOnly = [{ key: "turn:s7:1", kind: "done", roomId: "s7", deviceId: "d", dialogId: null, title: "s7", detail: "", at: 1 }]
  assert.equal(groupsModel.sidebarGroups(EIGHT, [DEVICE], doneOnly).groups[0].more, 3, "完成未读不算待处理")
  const [pending] = groupsModel.sidebarGroups(EIGHT, [DEVICE], [waitingOn("s7"), erroredOn("s5")]).groups
  assert.deepEqual(pending.rows.map((r) => `${r.id}:${r.marker}`), ["s0:idle", "s1:idle", "s2:idle", "s3:idle", "s4:idle", "s5:error", "s7:waiting"])
  assert.equal(pending.more, 1)
  assert.equal(pending.expanded, undefined)
  const [allPending] = groupsModel.sidebarGroups(EIGHT.slice(0, 6), [DEVICE], [waitingOn("s5")]).groups
  assert.equal(allPending.rows.length, 6)
  assert.equal(allPending.more, undefined, "收起的全是待处理行：不出「更多」")
  const [open] = groupsModel.sidebarGroups(EIGHT, [DEVICE], [waitingOn("s7")], { expanded: ["d:/w/p"] }).groups
  assert.equal(open.rows.length, 8)
  assert.equal(open.more, undefined)
  assert.equal(open.expanded, true)
})

test("更多 N：露出来的待处理行进了组，没开合过的组按它自动展开（桌面 / 手机同一份）", () => {
  const [group] = groupsModel.sidebarGroups(EIGHT, [DEVICE], [waitingOn("s7")]).groups
  const sessions = group.rows.map((r) => row(`d::${r.id}`, { waiting: r.marker === "waiting" }))
  const [shown] = model.sidebarGroupsWithOverlay({ folders: {}, groups: [workspace("d:/w/p", sessions)] })
  assert.equal(shown.collapsed, false)
  assert.equal(shown.sessions.some((s) => s.key === "d::s7"), true)
})
