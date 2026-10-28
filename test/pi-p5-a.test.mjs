// P5 a 线（外壳与列表，PLAN 5.3）的视图模型：boot、sessionInfo、sessionMenu、highlightMatch、侧栏数据源（G2 的离线设备注意力）、
// G3（relay/devices.ts roomRow 的条数 / 时间回落）。纯 Node 测试：模型只 import .ts、相对路径带扩展名，node --test 直接加载。
// 用 live fixture（ui/src/pi/dev/fixtures/live/*.ts）的原始状态跑真实函数，和 replica 屏对照。
import test from "node:test"
import assert from "node:assert/strict"
import { attentionItemsOf } from "../ui/src/relay/attention.ts"
import { mergeDeviceSessions } from "../ui/src/relay/devices.ts"
import { searchSessions } from "../ui/src/shell/searchModel.ts"
import { bootViewOf, listLoadingOf, relayHostOf, connectingText } from "../ui/src/pi/model/boot.ts"
import { cacheHitOf, gitBranchOf, gitBranchText, sessionModelLine } from "../ui/src/pi/model/sessionInfo.ts"
import { sessionMenuOf, sessionMenuCountText, sessionDeleteRouteOf, PI_MENU_REASON } from "../ui/src/pi/model/sessionMenu.ts"
import { highlightMatch, highlightPartOf } from "../ui/src/pi/model/highlightMatch.ts"
import { sidebarSessionsOf, attentionWithOfflineDevices, otherAttentionCount, sessionCountsOf } from "../ui/src/pi/model/sidebarSource.ts"
import { sidebarGroups } from "../ui/src/pi/model/sidebarGroups.ts"
import { liveRelayOf } from "../ui/src/pi/dev/fixtures/derive.ts"
import { MOCK_NOW } from "../ui/src/pi/dev/fixtures/types.ts"

const LIVE_DIR = new URL("../ui/src/pi/dev/fixtures/live/", import.meta.url)
const M = 60_000
async function load(id) {
  const mod = await import(new URL(`${id}.ts`, LIVE_DIR).href)
  return liveRelayOf(mod.default)
}
function bootOf(r) {
  const sessions = sidebarSessionsOf(r.devices ?? [], r.rooms ?? [], r.sessionsByDevice ?? {})
  return {
    token: r.token ?? "",
    authed: r.authed ?? false,
    everConnected: r.everConnected ?? false,
    deviceMode: r.deviceMode ?? false,
    devices: r.devices ?? [],
    rooms: r.rooms ?? [],
    sessionsLoading: r.sessionsLoading ?? false,
    sessionCount: sessions.length,
    canManageDevices: r.canManageDevices ?? false,
    roomId: r.roomId ?? "",
  }
}
/** 容器的注意力口径：attentionItemsOf（入参照 shell/Sidebar.tsx）+ G2 */
function attentionOf(r) {
  const items = attentionItemsOf({
    currentRoomId: r.roomId ?? "",
    rooms: r.rooms ?? [],
    dialogs: r.dialogs ?? [],
    uiPrompt: r.uiPrompt ?? null,
    turnEnd: r.turnEnd ?? null,
    roomTurnEnds: r.roomTurnEnds ?? [],
    selectedDevice: r.selectedDevice ?? null,
  })
  return attentionWithOfflineDevices(items, r.devices ?? [])
}

/* ---------------- boot ---------------- */

test("bootViewOf：首次连接 / 没有设备 / 都未连接 / 正常（口径同旧界面 firstDataReady）", async () => {
  assert.deepEqual(bootViewOf(bootOf(await load("boot-loading"))), { kind: "connecting" })
  assert.deepEqual(bootViewOf(bootOf(await load("no-devices"))), { kind: "no-devices", pairing: true })
  assert.deepEqual(bootViewOf(bootOf(await load("session-list"))), { kind: "ready" })
  // 断线重连（连上过）不回到首次连接：列表和流保留最后状态
  assert.deepEqual(bootViewOf(bootOf(await load("reconnecting"))), { kind: "ready" })
  // 没有 token 是登录页，不算首次连接
  assert.deepEqual(bootViewOf(bootOf(await load("login"))), { kind: "ready" })
  const base = bootOf(await load("session-list"))
  assert.deepEqual(bootViewOf({ ...base, roomId: "", devices: base.devices.map((d) => ({ ...d, online: false })) }), { kind: "all-offline", count: 3 })
  assert.deepEqual(bootViewOf({ ...bootOf(await load("no-devices")), canManageDevices: false }), { kind: "no-devices", pairing: false }, "relay 不支持设备令牌：不给配对")
})

test("listLoadingOf：首次连接、或清单在拉而手里一行都没有时才画骨架", async () => {
  assert.equal(listLoadingOf(bootOf(await load("boot-loading"))), true)
  const list = bootOf(await load("session-list"))
  assert.equal(listLoadingOf(list), false)
  assert.equal(listLoadingOf({ ...list, sessionsLoading: true }), false, "已经有行：刷新时不闪骨架")
  assert.equal(listLoadingOf({ ...list, sessionsLoading: true, sessionCount: 0 }), true)
})

test("relayHostOf / connectingText：口径同 useRelay 的 wsUrl", () => {
  assert.equal(relayHostOf(undefined, { host: "relay.example.com", protocol: "https:" }), "relay.example.com")
  assert.equal(relayHostOf("wss://relay.example.com:7002/", { host: "x", protocol: "https:" }), "relay.example.com:7002")
  assert.equal(relayHostOf(undefined, { host: "", protocol: "file:" }), "127.0.0.1:7002")
  assert.equal(connectingText("relay.example.com"), "正在连接 relay.example.com…")
  assert.equal(connectingText(""), "正在连接…")
})

/* ---------------- 侧栏数据源（G2）与 G3 ---------------- */

test("G2：每台非选中的离线设备补一条设备未连接，排序同 attention.ts；选中设备的那条不重复", async () => {
  const list = await load("session-list")
  const items = attentionOf(list)
  // replica 需要处理组 4 行：waiting r-s3（G1，拿不到）、error r-s6、device-offline ThinkPad、done r-s4
  assert.deepEqual(items.map((x) => `${x.kind}:${x.key}`), ["error:turn:r-s6:12", "device-offline:device:d-win", "done:turn:r-s4:7"])
  const thinkpad = items[1]
  assert.equal(thinkpad.title, "ThinkPad")
  assert.equal(thinkpad.roomId, "", "非选中设备没有房间归属")
  assert.equal(thinkpad.detail, "设备未连接，回电脑打开 attach 后恢复")
  // 选中的就是离线设备：attention.ts 已经出了那条，不再补
  const offline = await load("device-offline")
  const keys = attentionOf(offline).map((x) => x.key)
  assert.equal(keys.filter((k) => k === "device:d-win").length, 1)
  // 都在线：不补
  assert.deepEqual(attentionWithOfflineDevices([], [{ id: "a", name: "A", online: true }]), [])
  // 未登记设备没有身份，不补
  assert.deepEqual(attentionWithOfflineDevices([], [{ id: "未登记设备", name: "未登记设备", online: false }]), [])
})

test("G2：sidebarGroups 的需要处理组多出 ThinkPad 一行（设备图标、行尾未连接）", async () => {
  const r = await load("session-list")
  const model = sidebarGroups(sidebarSessionsOf(r.devices, r.rooms, r.sessionsByDevice), r.devices, attentionOf(r))
  assert.deepEqual(model.attentionRows.map((x) => `${x.id}:${x.marker}`), ["r-s6:error", "device:d-win:idle", "r-s4:unread"])
  assert.equal(model.attentionRows[1].trailingText, "未连接")
  assert.equal(model.attentionRows[1].platform, "win32")
})

test("手机返回键计数：不含当前会话、不含当前设备自己的掉线条目（background-alerts 是 3，replica 4 = 多 G1 的 r-s3）", async () => {
  const r = await load("background-alerts")
  assert.equal(otherAttentionCount(attentionOf(r), r.roomId, "d-mbp"), 3)
  const off = await load("device-offline")
  // r-s8 在 ThinkPad 上：ThinkPad 自己的掉线条目不计；剩 r-s6 出错、r-s4 完成
  assert.equal(otherAttentionCount(attentionOf(off), off.roomId, "d-win"), 2)
})

test("sidebarSessionsOf：逐台 mergeDeviceSessions、带 deviceId；每台设备的会话数", async () => {
  const r = await load("session-list")
  const sessions = sidebarSessionsOf(r.devices, r.rooms, r.sessionsByDevice)
  assert.equal(sessions.length, 17)
  assert.deepEqual(sessionCountsOf(sessions), { "d-mbp": 13, "d-studio": 3, "d-win": 1 })
  assert.ok(sessions.every((s) => typeof s.deviceId === "string"))
  assert.equal(sessions.find((s) => s.id === "r-s8").deviceId, "d-win")
})

test("G3：房间行的条数 / 时间回落到清单里同 id 的会话和房间的 lastActivity（取较新的）；都没有时仍是 0", async () => {
  const r = await load("session-list")
  const rows = mergeDeviceSessions(r.devices[0], r.rooms, r.sessionsByDevice["d-mbp"])
  const s1 = rows.find((x) => x.id === "r-s1")
  assert.equal(s1.openable, true)
  assert.equal(s1.messageCount, 48)
  assert.equal(s1.updatedAt, MOCK_NOW - 2 * M)
  const dev = { id: "d1", accountId: "a", name: "PC", platform: "linux", online: true, projects: ["/w"], lastAttachAt: 1, firstSeenAt: 1, windowExpiresAt: null, auth: null, paired: true }
  const room = { id: "s1", label: null, cwd: "/w", online: true, busy: false, viewers: 1, lastActivity: 500, deviceId: "d1" }
  const sess = { id: "s1", name: "会话", firstMessage: "", path: "/s/s1.jsonl", cwd: "/w", messageCount: 7, sizeBytes: 1, updatedAt: 300, active: true, online: true }
  assert.deepEqual(mergeDeviceSessions(dev, [room], [sess]).map((x) => [x.messageCount, x.updatedAt]), [[7, 500]], "房间更新：取 lastActivity")
  assert.deepEqual(mergeDeviceSessions(dev, [room], [{ ...sess, updatedAt: 900 }]).map((x) => [x.messageCount, x.updatedAt]), [[7, 900]], "会话文件更新：取 updatedAt")
  assert.deepEqual(mergeDeviceSessions(dev, [{ ...room, lastActivity: 0 }], []).map((x) => [x.messageCount, x.updatedAt]), [[0, 0]], "清单里没有、旧 relay 没有 lastActivity：仍是 0")
})

/* ---------------- 搜索 ---------------- */

test("highlightMatch：大小写不敏感、返回原文写法；查询为空或不中时 null", () => {
  assert.deepEqual(highlightMatch("修复手机键盘收起时输入框跳动", "键盘"), { before: "修复手机", match: "键盘", after: "收起时输入框跳动" })
  assert.equal(highlightPartOf("Relay 重启后", "relay"), "Relay")
  assert.equal(highlightPartOf("relay 重启后", "  "), undefined)
  assert.equal(highlightPartOf("relay 重启后", "键盘"), undefined)
  assert.equal(highlightPartOf("a.b(c)", ".b("), ".b(", "元字符照原样匹配")
})

test("session-search：标题匹配（所有设备，本地过滤）= r-s1、r-s10，命中词加粗「键盘」", async () => {
  const r = await load("session-search")
  const sessions = sidebarSessionsOf(r.devices, r.rooms, r.sessionsByDevice)
  const hits = searchSessions(sessions, "键盘").sort((a, b) => Number(b.online) - Number(a.online) || b.updatedAt - a.updatedAt)
  assert.deepEqual(hits.map((x) => x.id), ["r-s1", "r-s10"])
  assert.deepEqual(hits.map((x) => highlightPartOf(x.title, "键盘")), ["键盘", "键盘"])
})

/* ---------------- 会话菜单 ---------------- */

function menuInput(r, rowId, patch = {}) {
  const sessions = sidebarSessionsOf(r.devices, r.rooms, r.sessionsByDevice)
  const row = sessions.find((x) => x.id === rowId)
  const device = r.devices.find((d) => d.id === row.deviceId)
  return {
    row: { id: row.id, openable: row.openable, path: row.path, cwd: row.cwd },
    currentRoomId: r.roomId,
    lazySessionId: r.lazySession?.id ?? null,
    authed: r.authed,
    online: r.online,
    busy: r.busy,
    deviceMode: r.deviceMode,
    deviceOnline: !!device?.online,
    onSelectedDevice: row.deviceId === r.selectedDeviceId,
    // 同 SessionMenuContainer（P9 B）：目标运行 → 设备（session.purge+session.files）→ 同目录在线房间 → 原因
    deleteRoute: sessionDeleteRouteOf(row, r.rooms, r.roomId, device, false),
    ...patch,
  }
}
const disabledKeys = (model) => Object.entries(model.items).filter(([, v]) => v.disabled).map(([k]) => k)

test("sessionMenuOf：别的在线会话（r-s4）能打开；改名 / 分叉 / 导出等要先打开它；它正在运行，所以删除禁用（P8 R25）", async () => {
  const r = await load("session-menu")
  const model = sessionMenuOf(menuInput(r, "r-s4"))
  assert.equal(model.current, false)
  assert.equal(model.items.open.disabled, false)
  assert.equal(model.items.delete.disabled, true)
  assert.equal(model.items.delete.reason, PI_MENU_REASON.deleteRunning)
  assert.equal(model.items["copy-id"].disabled, false)
  assert.equal(model.items["copy-cwd"].disabled, false)
  assert.deepEqual(disabledKeys(model), ["rename", "fork", "clone", "export", "tree", "compact", "delete"])
  assert.equal(model.items.rename.reason, PI_MENU_REASON.openFirst)
})

test("sessionMenuOf：当前会话不能删、不能再打开；忙时改名 / 分叉 / 克隆 / 压缩禁用并写原因", async () => {
  const r = await load("session-menu")
  const cur = sessionMenuOf(menuInput(r, "r-s1"))
  assert.equal(cur.active, true)
  assert.deepEqual(disabledKeys(cur), ["open", "delete"])
  assert.equal(cur.items.delete.reason, PI_MENU_REASON.deleteCurrent)
  const busy = sessionMenuOf(menuInput(r, "r-s1", { busy: true }))
  assert.deepEqual(disabledKeys(busy), ["open", "rename", "fork", "clone", "compact", "delete"])
  assert.equal(busy.items.fork.reason, "pi 正忙，等这一轮结束")
  const down = sessionMenuOf(menuInput(r, "r-s1", { online: false }))
  assert.equal(down.items.tree.reason, PI_MENU_REASON.hostDown)
})

test("sessionMenuOf：未载入会话走文件级命令（设备在线、有路径、在选中设备上）；别的设备、离线设备各有原因", async () => {
  const r = await load("session-menu")
  const s12 = sessionMenuOf(menuInput(r, "s12"))
  assert.equal(s12.items.open.disabled, false, "启用会话")
  assert.deepEqual(disabledKeys(s12), ["clone", "tree", "compact"], "改名 / 分叉 / 导出走文件级命令；删除发给同目录的当前房间 r-s1")
  assert.deepEqual(menuInput(r, "s12").deleteRoute, { running: false, via: "room", roomId: "r-s1" })
  const s7 = sessionMenuOf(menuInput(r, "s7"))
  assert.equal(s7.items.rename.reason, PI_MENU_REASON.otherDevice, "Mac Studio 不是选中设备")
  assert.equal(s7.items.delete.reason, PI_MENU_REASON.deleteNoRoom, "Mac Studio 上 infra 目录没有在线房间")
  const s8 = sessionMenuOf(menuInput(r, "r-s8"))
  assert.equal(s8.items.open.reason, PI_MENU_REASON.deviceOffline)
  assert.equal(s8.items.rename.reason, PI_MENU_REASON.deviceOffline)
  const linkDown = sessionMenuOf(menuInput(r, "s12", { authed: false }))
  assert.equal(linkDown.items.rename.reason, PI_MENU_REASON.linkDown)
  assert.equal(sessionMenuCountText(31), "31 条")
  assert.equal(sessionMenuCountText(0), null, "清单里没有条数就不写")
})

/* ---------------- 会话信息 ---------------- */

test("sessionInfo：缓存命中 87%、模型行、get_git_branch 回包（G11：{ branch, repoRoot, detached }）", async () => {
  const r = await load("session-info")
  assert.equal(cacheHitOf(r.usage.tokens), 87)
  assert.equal(cacheHitOf({ input: 0, cacheRead: 0 }), null)
  assert.equal(cacheHitOf({ input: 10 }), null, "缺 cacheRead 不猜")
  assert.equal(cacheHitOf(null), null)
  assert.equal(sessionModelLine(r.modelMeta, r.model, r.thinkingLevel), "Claude Sonnet 4.5 · medium")
  assert.equal(sessionModelLine({}, "", "high"), null)
  assert.deepEqual(gitBranchOf(await r.runCommand("get_git_branch")), { branch: "main", detached: false })
  assert.deepEqual(gitBranchOf({ branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false }), { branch: "main", detached: false })
  assert.equal(gitBranchText(gitBranchOf({ branch: "3f2a9c1", repoRoot: "/r", detached: true })), "3f2a9c1（游离）")
  assert.equal(gitBranchOf({ branch: null, repoRoot: null, detached: false }), null, "不在仓库里：分支行整行不出现")
  assert.equal(gitBranchOf({ branch: null, repoRoot: null, detached: false, error: "EACCES" }), null)
  assert.equal(gitBranchOf("main"), null)
})
