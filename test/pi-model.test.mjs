// P5.1 视图模型（ui/src/pi/model/*.ts）：design v1.3 §10 的签名与用例、plan §8.4 的清单。
// 纯 Node 测试：模型文件只 import .ts、相对路径带扩展名，node --test 直接加载。
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { rowMarkerOf, rowMarkerA11y, sessionRowName } from "../ui/src/pi/model/rowMarker.ts"
import { sidebarGroups, groupHeaderOf, sidebarGroupKey, PI_FLAT_GROUP_KEY } from "../ui/src/pi/model/sidebarGroups.ts"
import { trayItemsOf, queueSectionsOf, queueCountOf } from "../ui/src/pi/model/tray.ts"
import { composerButtonOf, composerBlockOf, composerButtonLabel } from "../ui/src/pi/model/composerButton.ts"
import { composerReasonOf } from "../ui/src/pi/model/composerReason.ts"
import { dialogCardState, PI_DIALOG_RECEIPT_MS } from "../ui/src/pi/model/dialogCard.ts"
import { phoneDockLayout, sheetLayout } from "../ui/src/pi/model/phoneDock.ts"
import { toolWeightOf, mergeExploreRuns, exploreSummaryOf } from "../ui/src/pi/model/toolWeight.ts"
import { turnReceipts } from "../ui/src/pi/model/receipts.ts"
import { diffRowsFromEdit, rowsFromPatch } from "../ui/src/pi/model/diffRows.ts"
import { changesOfSession } from "../ui/src/pi/model/changes.ts"
import { migratePiPrefs, setPiPref, DEFAULT_PI_PREFS } from "../ui/src/pi/model/prefs.ts"

const NOW = Date.UTC(2026, 9, 24, 8, 0, 0)
const MIN = 60_000
const H = 60 * MIN

/* ---------------- rowMarker ---------------- */

test("rowMarkerOf：6 种 kind 与优先级", () => {
  assert.equal(rowMarkerOf({ kind: "waiting" }, true, true, true), "waiting")
  assert.equal(rowMarkerOf({ kind: "error" }, true, true, true), "error")
  assert.equal(rowMarkerOf(null, true, true, true), "running")
  assert.equal(rowMarkerOf({ kind: "done" }, true, true, true), "running", "运行中优先于完成未读")
  assert.equal(rowMarkerOf({ kind: "done" }, false, true, true), "unread")
  assert.equal(rowMarkerOf(null, false, false, false), "unloaded")
  assert.equal(rowMarkerOf(null, false, true, true), "idle")
})

test("rowMarkerOf：边界与缺数据", () => {
  assert.equal(rowMarkerOf(null, true, false, true), "idle", "离线房间不算运行")
  assert.equal(rowMarkerOf({ kind: "device-offline" }, false, false, true), "idle", "设备掉线条目不落行标记")
  assert.equal(rowMarkerOf(undefined, false, true, true), "idle")
})

test("rowMarkerA11y：形状、role 与中文 label，idle 隐藏", () => {
  assert.deepEqual(rowMarkerA11y("idle"), { hidden: true })
  const expect = { waiting: "等你回答", error: "出错未读", unread: "完成未读", running: "运行中", unloaded: "未载入" }
  const shapes = new Set()
  for (const [kind, label] of Object.entries(expect)) {
    const a = rowMarkerA11y(kind)
    assert.equal(a.role, "img")
    assert.equal(a.label, label)
    shapes.add(a.shape)
  }
  assert.equal(shapes.size, 5, "五种形状各不相同（不只靠颜色）")
})

test("sessionRowName：标题，标记 label，时间全称；idle / 缺时间不写", () => {
  assert.equal(sessionRowName("退款对账脚本报错", "error", NOW - 38 * MIN, NOW), "退款对账脚本报错，出错未读，38 分钟前")
  assert.equal(sessionRowName("a", "idle", NOW - 2 * H, NOW), "a，2 小时前")
  assert.equal(sessionRowName("a", "running", null, NOW), "a，运行中")
  assert.equal(sessionRowName("a", "idle", 0, NOW), "a")
})

/* ---------------- sidebarGroups ---------------- */

const DEVICES = [
  { id: "d-mbp", name: "MacBook Pro", online: true, platform: "darwin", projects: ["/u/pi-remote", "/u/notes-app", "/u/dotfiles"] },
  { id: "d-win", name: "ThinkPad", online: false, platform: "win32", projects: ["C:\\code\\game-tools"] },
]
function sess(id, deviceId, cwd, updatedAt, extra = {}) {
  return { id, deviceId, cwd, title: `t-${id}`, online: true, busy: false, updatedAt, openable: true, ...extra }
}
const SESSIONS = [
  ...Array.from({ length: 12 }, (_, k) => sess(`p${k}`, "d-mbp", "/u/pi-remote", NOW - (k + 1) * MIN)),
  sess("n1", "d-mbp", "/u/notes-app", NOW - 5 * H),
  sess("g1", "d-win", "C:\\code\\game-tools", NOW - 27 * H, { online: false, openable: false }),
  sess("orphan", "d-gone", "/x", NOW),
]
const ATTENTION = [
  { key: "dialog:1", kind: "waiting", roomId: "p3", deviceId: "d-mbp", dialogId: "1", title: "t-p3", detail: "", at: NOW - MIN },
  { key: "turn:n1:1", kind: "error", roomId: "n1", deviceId: "d-mbp", dialogId: null, title: "t-n1", detail: "", at: NOW - 2 * MIN },
  { key: "device:d-win", kind: "device-offline", roomId: "", deviceId: "d-win", dialogId: null, title: "ThinkPad", detail: "", at: 0 },
]

test("sidebarGroups device：每组 5 行 + 更多 N、文件夹行、离线 dimmed", () => {
  const { groups, attentionRows, truncated } = sidebarGroups(SESSIONS, DEVICES, ATTENTION, {})
  assert.equal(truncated, false)
  assert.deepEqual(groups.map((g) => g.label), ["MacBook Pro/pi-remote", "MacBook Pro/notes-app", "MacBook Pro/dotfiles", "ThinkPad/game-tools"])
  const [pi, notes, dot, game] = groups
  assert.equal(pi.rows.length, 5)
  assert.equal(pi.more, 7)
  assert.equal(pi.expanded, undefined)
  assert.equal(pi.rows[0].id, "p0", "新到旧")
  assert.equal(pi.rows.find((r) => r.id === "p3").marker, "waiting")
  assert.equal(notes.rows[0].marker, "error")
  assert.equal(dot.folderOnly, true)
  assert.equal(game.offline, true)
  assert.equal(game.rows[0].dimmed, true)
  assert.equal(game.rows[0].marker, "unloaded", "离线只淡，标记照常")
  assert.ok(!groups.some((g) => g.rows.some((r) => r.id === "orphan")), "没有设备归属的会话不出现")
  assert.equal(attentionRows.length, 3)
  assert.deepEqual(attentionRows[2], { id: "device:d-win", title: "ThinkPad", marker: "idle", trailingText: "未连接", platform: "win32", deviceId: "d-win" })
})

test("P9 A：等你回答的行尾文字（waiting →「等你回答」；answerable=false →「等你在电脑上回答」）", () => {
  const rows = (attention) => sidebarGroups(SESSIONS, DEVICES, attention, {})
  // ATTENTION 里 p3 那条 waiting 没有 answerable（旧 relay / 实时 dialog 没给）：默认「等你回答」
  const plain = rows(ATTENTION)
  const p3 = plain.groups[0].rows.find((r) => r.id === "p3")
  assert.equal(p3.marker, "waiting")
  assert.equal(p3.trailingText, "等你回答")
  assert.equal(p3.trailingTone, "attention", "行尾上注意力色")
  const attentionRow = plain.attentionRows.find((r) => r.id === "p3")
  assert.equal(attentionRow.trailingText, "等你回答")
  assert.equal(attentionRow.trailingTone, "attention")
  // 这个网页不能直接答（只在电脑上答）：文案换成「等你在电脑上回答」
  const notAnswerable = ATTENTION.map((a) => (a.key === "dialog:1" ? { ...a, answerable: false } : a))
  const answerableRow = rows(notAnswerable).groups[0].rows.find((r) => r.id === "p3")
  assert.equal(answerableRow.trailingText, "等你在电脑上回答")
  // 不是 waiting 的行尾文案不受影响（出错未读那行不写 trailingText）
  const n1 = rows(notAnswerable).groups.flatMap((g) => g.rows).find((r) => r.id === "n1")
  assert.equal(n1.marker, "error")
  assert.equal(n1.trailingText, undefined)
})

test("sidebarGroups device：expanded 的组全部展开", () => {
  const key = sidebarGroupKey("d-mbp", "/u/pi-remote")
  const pi = sidebarGroups(SESSIONS, DEVICES, [], { expanded: [key] }).groups[0]
  assert.equal(pi.rows.length, 12)
  assert.equal(pi.more, undefined)
  assert.equal(pi.expanded, true)
  const notes = sidebarGroups(SESSIONS, DEVICES, [], { expanded: [sidebarGroupKey("d-mbp", "/u/notes-app")] }).groups[1]
  assert.equal(notes.expanded, undefined, "不足 5 行的组展开无意义")
})

test("sidebarGroups 筛选：只看一台设备，组头只写目录名", () => {
  const { groups } = sidebarGroups(SESSIONS, DEVICES, [], { filter: "d-win" })
  assert.deepEqual(groups.map((g) => g.label), ["game-tools"])
})

test("sidebarGroups flat：一个倒序列表、带副标题、不出文件夹行、离线行 dimmed", () => {
  const { groups } = sidebarGroups(SESSIONS, DEVICES, ATTENTION, { grouping: "flat" })
  assert.equal(groups.length, 1)
  const [flat] = groups
  assert.equal(flat.key, PI_FLAT_GROUP_KEY)
  assert.equal(flat.flat, true)
  assert.equal(flat.rows.length, 14)
  assert.equal(flat.more, undefined)
  assert.deepEqual(flat.rows.slice(0, 2).map((r) => r.id), ["p0", "p1"])
  assert.equal(flat.rows[0].subtitle, "MacBook Pro/pi-remote")
  const g = flat.rows.find((r) => r.id === "g1")
  assert.equal(g.subtitle, "ThinkPad/game-tools · 未连接")
  assert.equal(g.dimmed, true)
  const filtered = sidebarGroups(SESSIONS, DEVICES, [], { grouping: "flat", filter: "d-mbp" }).groups[0]
  assert.equal(filtered.rows[0].subtitle, "pi-remote", "筛选到一台时只写目录名")
})

test("sidebarGroups flat：200 截断", () => {
  const many = Array.from({ length: 230 }, (_, k) => sess(`m${k}`, "d-mbp", "/u/pi-remote", NOW - k * MIN))
  const model = sidebarGroups(many, DEVICES, [], { grouping: "flat" })
  assert.equal(model.groups[0].rows.length, 200)
  assert.equal(model.truncated, true)
  assert.equal(sidebarGroups(many.slice(0, 200), DEVICES, [], { grouping: "flat" }).truncated, false)
})

test("sidebarGroups 缺数据：空输入、没有时间戳的行不带 at", () => {
  assert.deepEqual(sidebarGroups([], [], [], { grouping: "flat" }), { attentionRows: [], groups: [], truncated: false })
  assert.deepEqual(sidebarGroups([], [], []), { attentionRows: [], groups: [], truncated: false })
  const row = sidebarGroups([sess("z", "d-mbp", "/u/pi-remote", 0)], DEVICES, []).groups[0].rows[0]
  assert.equal("at" in row, false)
})

test("groupHeaderOf：多设备 设备/目录，一台或已筛选只写目录", () => {
  const mbp = { name: "MacBook Pro" }
  assert.equal(groupHeaderOf(2, null, mbp, "/u/pi-remote"), "MacBook Pro/pi-remote")
  assert.equal(groupHeaderOf(1, null, mbp, "/u/pi-remote"), "pi-remote")
  assert.equal(groupHeaderOf(3, "d-mbp", mbp, "C:\\code\\game-tools"), "game-tools")
  assert.equal(groupHeaderOf(2, null, mbp, ""), "MacBook Pro")
  assert.equal(groupHeaderOf(1, null, mbp, ""), null)
})

/* ---------------- tray / queueSections ---------------- */

const OUTBOX = [{ cid: "c1", text: "hi", status: "queued" }]
const base = { linkOk: true, deviceOnline: true }
const queuePill = (items) => items.find((x) => x.kind === "queue")

test("trayItemsOf：三者都为 0 不出排队 pill；全空返回空数组", () => {
  assert.deepEqual(trayItemsOf({ ...base, remoteQueue: [], localQueue: { steering: [], followUp: [] }, outbox: [] }), [])
  assert.deepEqual(trayItemsOf({ linkOk: false, deviceOnline: false }), [])
})

test("trayItemsOf：只有 outbox 的三种连接情况", () => {
  assert.equal(queuePill(trayItemsOf({ ...base, outbox: OUTBOX })).label, "排队 1")
  assert.equal(queuePill(trayItemsOf({ linkOk: false, deviceOnline: true, outbox: OUTBOX })).label, "排队 1 · 等重连")
  assert.equal(queuePill(trayItemsOf({ linkOk: true, deviceOnline: false, outbox: OUTBOX })).label, "排队 1 · 等重连")
})

test("trayItemsOf：三者同时存在的计数；已注入远程条目不计；没有 outbox 时断线也不加后缀", () => {
  const input = {
    ...base,
    linkOk: false,
    remoteQueue: [{ status: "pending" }, { status: "injected" }, { status: "failed" }],
    localQueue: { steering: [{}], followUp: [{}, {}] },
    outbox: OUTBOX,
  }
  assert.equal(queueCountOf(input), 5)
  assert.equal(queuePill(trayItemsOf(input)).label, "排队 5 · 等重连")
  assert.equal(queuePill(trayItemsOf({ ...input, outbox: [] })).label, "排队 4")
  assert.equal(queuePill(trayItemsOf({ ...base, remoteQueue: [{ status: "injected" }] })), undefined)
})

test("trayItemsOf：任务、终端、改动 pill 与顺序", () => {
  const items = trayItemsOf({
    ...base,
    taskList: [{ status: "completed" }, { status: "completed" }, { status: "in_progress" }, { status: "pending" }],
    outbox: OUTBOX,
    terminals: [{ state: "running" }, { state: "succeeded" }],
    changes: { added: 12, removed: 4, files: [{}] },
  })
  assert.deepEqual(items.map((x) => x.kind), ["tasks", "queue", "terminal", "changes"])
  assert.deepEqual(items[0], { kind: "tasks", label: "任务 2/4", running: true })
  assert.deepEqual(items[2], { kind: "terminal", label: "终端 1", running: true })
  assert.deepEqual(items[3], { kind: "changes", label: "改动 +12 −4", added: 12, removed: 4 })
  assert.deepEqual(trayItemsOf({ ...base, terminals: [{ state: "failed" }] }), [{ kind: "terminal", label: "终端 1" }])
  assert.deepEqual(trayItemsOf({ ...base, changes: { added: 0, removed: 0, files: [] } }), [])
})

test("queueSectionsOf：三段顺序、空段省略", () => {
  const remote = [{ id: "r1", status: "pending", text: "a" }, { id: "r2", status: "injected", text: "b" }]
  const local = { steering: [{ role: "user", content: [{ type: "text", text: "插一句" }] }], followUp: ["等会儿"] }
  const s = queueSectionsOf(remote, local, OUTBOX, false, true)
  assert.deepEqual(s.map((x) => x.title), ["本页待发 · 等重连", "网页发的", "终端里排的 · 只读"])
  assert.deepEqual(s[1].items.map((x) => x.id), ["r1"])
  assert.deepEqual(s[2].items, [{ segment: "steer", text: "插一句" }, { segment: "follow_up", text: "等会儿" }])
  assert.deepEqual(queueSectionsOf([], null, [], true, true), [])
  assert.deepEqual(queueSectionsOf(null, local, null, true, true).map((x) => x.kind), ["local"])
  assert.deepEqual(queueSectionsOf(remote.slice(1), null, null, true, true), [], "只有已注入条目时整段不出")
})

test("queueSectionsOf：连接已恢复、outbox 只剩回放失败的行 → 段名不带后缀（R2-M-10）", () => {
  const failed = [{ cid: "c9", text: "x", status: "failed" }]
  assert.equal(queueSectionsOf([], null, failed, true, true)[0].title, "本页待发")
  assert.equal(queueSectionsOf([], null, failed, true, false)[0].title, "本页待发 · 等重连")
})

/* ---------------- composerButton / composerBlock ---------------- */

const STATES = ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]

test("composerButtonOf：S0–S7 → 黑圆钮四态（design §1.6 表）", () => {
  const v = (s, c = false) => composerButtonOf(s, c)
  assert.deepEqual(v("S0"), { variant: "send-muted", disabled: true, ghostStop: false })
  assert.deepEqual(v("S1", true), { variant: "send", disabled: false, ghostStop: false })
  assert.deepEqual(v("S2", true), { variant: "send", disabled: true, ghostStop: false })
  assert.deepEqual(v("S3"), { variant: "stop", disabled: false, ghostStop: false })
  assert.deepEqual(v("S4", true), { variant: "send", disabled: false, ghostStop: true })
  assert.deepEqual(v("S5", true), { variant: "send", disabled: false, ghostStop: false }, "S5 照常可发，进 outbox")
  assert.deepEqual(v("S5", false), { variant: "send-muted", disabled: true, ghostStop: false })
  assert.equal(v("S6", true).variant, "send")
  assert.equal(v("S6", false).variant, "send-muted")
  assert.deepEqual(v("S7", true), { variant: "send-muted", disabled: true, ghostStop: false })
})

test("composerButtonLabel：发送 / 停止 / 发送（不可用）", () => {
  assert.equal(composerButtonLabel(composerButtonOf("S1", true)), "发送")
  assert.equal(composerButtonLabel(composerButtonOf("S3", false)), "停止")
  assert.equal(composerButtonLabel(composerButtonOf("S0", false)), "发送（不可用）")
})

test("composerBlockOf：审批时 S3 → stop，S1 / S2 / S4 / S5 → send-muted，S4 裸停止保留，readOnly", () => {
  assert.equal(composerBlockOf("S3", "approval").button.variant, "stop")
  for (const s of ["S1", "S2", "S4", "S5"]) {
    const b = composerBlockOf(s, "approval", true)
    assert.equal(b.button.variant, "send-muted", s)
    assert.equal(b.button.disabled, true, s)
    assert.equal(b.readOnly, true, s)
    assert.equal(b.menusEnabled, false, s)
    assert.equal(b.hideModelOnPhone, true, s)
  }
  assert.equal(composerBlockOf("S4", "approval", true).button.ghostStop, true)
})

test("composerBlockOf：blockedBy 为 null / 缺省时与 composerButtonOf 一致；S7 只读", () => {
  for (const s of STATES) {
    for (const c of [true, false]) {
      assert.deepEqual(composerBlockOf(s, null, c).button, composerButtonOf(s, c), `${s}/${c}`)
      assert.deepEqual(composerBlockOf(s, undefined, c).button, composerButtonOf(s, c))
    }
  }
  assert.equal(composerBlockOf("S1", null, true).readOnly, false)
  assert.equal(composerBlockOf("S7", null).readOnly, true)
  assert.equal(composerBlockOf("S7", null).hideModelOnPhone, true)
  assert.deepEqual(composerBlockOf("S5", null).button, composerButtonOf("S5", false), "两参写法：hasContent 缺省 false")
})

/* ---------------- composerReason ---------------- */

const OK = { kind: "ok" }
const TP_OFF = { name: "ThinkPad", online: false }
const MBP = { name: "MacBook Pro", online: true }
const st = (state, extra = {}) => ({ state, ...extra })

test("composerReasonOf：默认", () => {
  assert.deepEqual(composerReasonOf(OK, MBP, st("S0"), null, true), { placeholder: "继续追问…", note: null, tone: "default", showDevice: true, live: true })
})

test("composerReasonOf：S5 断开 → 写好先排队、warn、showDevice true、live false", () => {
  for (const kind of ["waiting", "reconnecting"]) {
    assert.deepEqual(composerReasonOf({ kind }, MBP, st("S5"), null, true), {
      placeholder: "写好先排队",
      note: "未连接服务器 · 发送会排队",
      tone: "warn",
      showDevice: true,
      live: false,
    })
  }
})

test("composerReasonOf：S5 设备离线 → note 已含设备名，showDevice false（R2-D-01）、live true", () => {
  assert.deepEqual(composerReasonOf(OK, TP_OFF, st("S5"), null, true), {
    placeholder: "写好先排队",
    note: "ThinkPad 未连接 · 上线后发送",
    tone: "warn",
    showDevice: false,
    live: true,
  })
})

test("composerReasonOf：未载入 → 发送时载入、default、showDevice false（R2-D-01）", () => {
  assert.deepEqual(composerReasonOf(OK, { name: "Mac Studio", online: true }, st("S0"), null, false), {
    placeholder: "发送时载入",
    note: "Mac Studio · 未载入，发第一条时载入",
    tone: "default",
    showDevice: false,
    live: true,
  })
})

test("composerReasonOf：审批禁用、S7 撤销 / 只读、S2 慢 ack", () => {
  assert.deepEqual(composerReasonOf(OK, MBP, st("S3"), "approval", true), {
    placeholder: "输入已禁用",
    note: "先回答上面的问题",
    tone: "warn",
    showDevice: true,
    live: true,
  })
  assert.equal(composerReasonOf(OK, MBP, st("S7", { s7: "revoked" }), null, true).note, "这台设备已被撤销 · 到设置里重新配对")
  const ro = composerReasonOf(OK, MBP, st("S7", { s7: "readonly" }), null, true)
  assert.equal(ro.note, "这个会话只读 · 只能看历史")
  assert.equal(ro.placeholder, "输入已禁用")
  assert.equal(ro.tone, "warn")
  const slow = composerReasonOf(OK, MBP, st("S2", { slowAck: true }), null, true)
  assert.deepEqual([slow.placeholder, slow.note, slow.tone], ["继续追问…", "发送中…", "default"])
  assert.equal(composerReasonOf(OK, MBP, st("S2"), null, true).note, null, "200ms 内不写发送中")
})

test("composerReasonOf：优先级与缺数据", () => {
  assert.equal(composerReasonOf({ kind: "waiting" }, TP_OFF, st("S7", { s7: "readonly" }), "approval", false).note, "这个会话只读 · 只能看历史")
  assert.equal(composerReasonOf({ kind: "waiting" }, TP_OFF, st("S5"), "approval", true).note, "先回答上面的问题")
  assert.equal(composerReasonOf({ kind: "waiting" }, TP_OFF, st("S5"), null, false).note, "未连接服务器 · 发送会排队")
  assert.equal(composerReasonOf(OK, TP_OFF, st("S5"), null, false).note, "ThinkPad 未连接 · 上线后发送")
  const noName = composerReasonOf(OK, { name: "", online: false }, st("S5"), null, true)
  assert.equal(noName.note, "设备未连接 · 上线后发送")
  assert.equal(noName.showDevice, true)
  assert.equal(composerReasonOf(null, null, st("S0"), undefined, null).note, null, "不知道设备 / 载入状态时不编原因")
  assert.equal(composerReasonOf(OK, null, st("S0"), null, false).note, "未载入，发第一条时载入")
})

/* ---------------- dialogCard ---------------- */

const DIALOG = { dialogId: "d1", startedAt: NOW, timeout: 60_000, answerable: true }

test("dialogCardState：open 与剩余秒数", () => {
  assert.deepEqual(dialogCardState(DIALOG, null, NOW + 10_500), { state: "open", remainingSec: 50, observe: false, blocksComposer: true, hideAt: null })
  assert.equal(dialogCardState({ ...DIALOG, timeout: undefined }, null, NOW).remainingSec, null, "宿主没给超时不编倒计时")
})

test("dialogCardState：六态", () => {
  const r = (status, at = NOW + 1000) => ({ dialogId: "d1", status, at })
  assert.equal(dialogCardState(DIALOG, null, NOW).state, "open")
  const sending = dialogCardState(DIALOG, r("sending"), NOW + 2000)
  assert.deepEqual([sending.state, sending.blocksComposer], ["sending", true])
  const failed = dialogCardState(DIALOG, r("failed"), NOW + 2000)
  assert.deepEqual([failed.state, failed.blocksComposer, failed.remainingSec], ["failed", true, 58])
  for (const status of ["answered-elsewhere", "denied"]) {
    const v = dialogCardState(DIALOG, r(status), NOW + 2000)
    assert.deepEqual([v.state, v.blocksComposer, v.remainingSec, v.hideAt], [status, false, null, NOW + 1000 + PI_DIALOG_RECEIPT_MS])
  }
  const expired = dialogCardState(DIALOG, null, NOW + 60_000)
  assert.deepEqual(expired, { state: "expired", remainingSec: null, observe: false, blocksComposer: false, hideAt: NOW + 60_000 + 8000 })
  assert.equal(dialogCardState(DIALOG, r("failed"), NOW + 61_000).state, "expired", "失败后超时也算超时")
  assert.equal(dialogCardState(DIALOG, r("expired", NOW + 30_000), NOW + 31_000).state, "expired")
})

test("dialogCardState：answerable !== true → observe，不进 blockedBy；缺数据 / 别的卡的回执", () => {
  for (const answerable of [undefined, false]) {
    const v = dialogCardState({ ...DIALOG, answerable }, null, NOW)
    assert.equal(v.observe, true)
    assert.equal(v.blocksComposer, false)
  }
  assert.equal(dialogCardState(null, null, NOW), null)
  assert.equal(dialogCardState(DIALOG, { dialogId: "other", status: "denied", at: NOW }, NOW).state, "open")
})

/* ---------------- phoneDock / sheetLayout ---------------- */

test("phoneDockLayout：键盘收起 50%、开着 60%，审批卡开着键盘时限 40%", () => {
  assert.deepEqual(phoneDockLayout(844, false, 0), { dockMax: 422, approvalMax: 422, approvalHeight: 0 })
  assert.deepEqual(phoneDockLayout(508, true, 260), { dockMax: 305, approvalMax: 203, approvalHeight: 203 })
  assert.deepEqual(phoneDockLayout(508, true, 120), { dockMax: 305, approvalMax: 203, approvalHeight: 120 })
  assert.deepEqual(phoneDockLayout(844, false, 500), { dockMax: 422, approvalMax: 422, approvalHeight: 422 })
  assert.equal(phoneDockLayout(844, false, null).approvalHeight, 0)
  assert.equal(phoneDockLayout(0, true, 100), null)
  assert.equal(phoneDockLayout(Number.NaN, true, 100), null)
})

const SHEET = { vvHeight: 508, vvOffsetTop: 0, headerHeight: 56, footerHeight: 64, safeTop: 47 }

test("sheetLayout：内容矮于上限、超高被裁、offsetTop 平移", () => {
  assert.deepEqual(sheetLayout({ ...SHEET, contentHeight: 100 }), { top: 288, height: 220, bodyHeight: 100, compact: false })
  assert.deepEqual(sheetLayout({ ...SHEET, contentHeight: 900 }), { top: 71, height: 437, bodyHeight: 317, compact: false })
  assert.deepEqual(sheetLayout({ ...SHEET, vvOffsetTop: 120, contentHeight: 100 }), { top: 408, height: 220, bodyHeight: 100, compact: false })
})

test("sheetLayout：size full 固定 437，结果 < 160 时 compact", () => {
  assert.deepEqual(sheetLayout({ ...SHEET, contentHeight: 40, size: "full" }), { top: 71, height: 437, bodyHeight: 437 - 56 - 64, compact: false })
  const tiny = sheetLayout({ ...SHEET, vvHeight: 220, contentHeight: 300 })
  assert.deepEqual(tiny, { top: 71, height: 149, bodyHeight: 85, compact: true })
  assert.equal(sheetLayout({ ...SHEET, vvHeight: 0, contentHeight: 10 }), null)
})

/* ---------------- toolWeight / mergeExploreRuns ---------------- */

const tool = (name, extra = {}) => ({ kind: "tool", id: name + Math.random(), name, argsText: "", outputText: "", state: "output-available", ...extra })

test("toolWeightOf：line / terminal / diff / tray / subagent", () => {
  assert.equal(toolWeightOf("read", "balanced"), "line")
  assert.equal(toolWeightOf("grep", "compact"), "line")
  assert.equal(toolWeightOf("fetch", "detailed"), "line")
  assert.equal(toolWeightOf("bash", "balanced"), "terminal")
  assert.equal(toolWeightOf("PowerShell", "balanced"), "terminal")
  assert.equal(toolWeightOf("edit", "balanced"), "diff")
  assert.equal(toolWeightOf("write", "balanced"), "diff")
  assert.equal(toolWeightOf("todo_write", "balanced"), "tray")
  assert.equal(toolWeightOf("subagent", "balanced"), "subagent")
  assert.equal(toolWeightOf("", "balanced"), "line")
})

test("mergeExploreRuns：连续探索合并，别的块打断，单个不合并", () => {
  const blocks = [
    tool("grep"),
    tool("find", { outputText: "a.ts\nb.ts\n" }),
    tool("ls", { outputText: "c.ts" }),
    { kind: "text", text: "x" },
    tool("grep"),
    tool("bash"),
    tool("read"),
    tool("grep"),
  ]
  const runs = mergeExploreRuns(blocks)
  assert.deepEqual(runs.map((r) => r.kind), ["explore", "single", "single", "single", "single", "single"])
  assert.deepEqual(runs[0].summary, { files: 3, searches: 1, text: "查看了 3 个文件，搜索 1 次" })
  assert.deepEqual(mergeExploreRuns([]), [])
})

test("mergeExploreRuns：精简密度下 read 也合并；结果未到时写次数", () => {
  const runs = mergeExploreRuns([tool("read"), tool("read"), tool("grep")], "compact")
  assert.equal(runs.length, 1)
  assert.equal(runs[0].summary.text, "查看了 2 个文件，搜索 1 次")
  assert.equal(mergeExploreRuns([tool("read"), tool("read")], "balanced").length, 2)
  assert.equal(exploreSummaryOf([tool("find", { outputText: "" }), tool("ls", { outputText: "" })]).text, "查看了 2 次")
})

/* ---------------- turnReceipts ---------------- */

const user = (ts) => ({ kind: "user", key: "u", text: "q", images: [], timestamp: ts })
const asst = (extra = {}) => ({ kind: "assistant", key: "a", blocks: [{ kind: "text", text: "a" }], ...extra })

test("turnReceipts：用时与思考", () => {
  const thinking = asst({ blocks: [{ kind: "thinking", text: "…" }], timestamp: NOW + 1000, endedAt: NOW + 134_000 })
  assert.deepEqual(turnReceipts({ items: [user(NOW), thinking], thinkingObservedMs: 6200 }), { workedMs: 134_000, thinking: { text: "思考 6 秒", ms: 6200 } })
  assert.deepEqual(turnReceipts({ items: [user(NOW), thinking] }), { workedMs: 134_000, thinking: { text: "已思考", ms: null } })
  assert.deepEqual(turnReceipts({ items: [user(NOW), asst({ timestamp: NOW + 5000 })] }), { workedMs: 5000, thinking: null })
  assert.equal(turnReceipts({ items: [user(NOW), thinking], thinkingObservedMs: 200 }).thinking.text, "思考 1 秒")
})

test("turnReceipts：缺时间戳返回 null", () => {
  assert.equal(turnReceipts({ items: [user(undefined), asst({ timestamp: NOW })] }), null)
  assert.equal(turnReceipts({ items: [user(NOW), asst()] }), null)
  assert.equal(turnReceipts({ items: [user(NOW)] }), null, "只有用户消息没有用时")
  assert.equal(turnReceipts({ items: [] }), null)
  assert.equal(turnReceipts(null), null)
  const r = turnReceipts({ items: [user(undefined), asst({ blocks: [{ kind: "thinking", text: "" }], timestamp: NOW })] })
  assert.deepEqual(r, { workedMs: null, thinking: { text: "已思考", ms: null } })
})

/* ---------------- diffRows / changes ---------------- */

const PATCH = ["--- a/x.ts", "+++ b/x.ts", "@@ -10,3 +10,4 @@", " keep", "-old", "+new", "+more", " tail", "\\ No newline at end of file", ""].join("\n")

test("diffRowsFromEdit：details.patch 优先，行号与计数", () => {
  const r = diffRowsFromEdit({ path: "x.ts", oldText: "zzz", newText: "yyy" }, { patch: PATCH })
  assert.equal(r.source, "patch")
  assert.deepEqual(r.rows, [
    { kind: "context", n: 10, text: "keep" },
    { kind: "del", n: 11, text: "old" },
    { kind: "add", n: 11, text: "new" },
    { kind: "add", n: 12, text: "more" },
    { kind: "context", n: 13, text: "tail" },
  ])
  assert.deepEqual([r.added, r.removed], [2, 1])
})

test("diffRowsFromEdit：args 的 oldText / newText、edits[]、write content", () => {
  const e = diffRowsFromEdit({ path: "x", oldText: "a\nb\nc", newText: "a\nB\nc" }, null)
  assert.deepEqual(e.rows, [
    { kind: "context", n: null, text: "a" },
    { kind: "del", n: null, text: "b" },
    { kind: "add", n: null, text: "B" },
    { kind: "context", n: null, text: "c" },
  ])
  assert.equal(e.source, "args")
  const multi = diffRowsFromEdit({ path: "x", edits: [{ oldText: "1", newText: "2" }, { oldText: "3", newText: "" }, null] }, {})
  assert.deepEqual([multi.added, multi.removed], [1, 2])
  const w = diffRowsFromEdit({ path: "n.ts", content: "l1\nl2\n" }, undefined)
  assert.deepEqual(w.rows, [{ kind: "add", n: 1, text: "l1" }, { kind: "add", n: 2, text: "l2" }])
})

test("diffRowsFromEdit：缺数据返回 null；坏 patch 回落 args", () => {
  assert.equal(diffRowsFromEdit(null, null), null)
  assert.equal(diffRowsFromEdit({ path: "x" }, { patch: 42 }), null)
  assert.equal(rowsFromPatch("not a patch"), null)
  assert.equal(diffRowsFromEdit({ path: "x", oldText: "a", newText: "b" }, { patch: "garbage" }).source, "args")
})

test("changesOfSession：按文件汇总，只算成功的 edit / write，推不出的跳过", () => {
  const items = [
    user(NOW),
    asst({
      blocks: [
        tool("edit", { input: { path: "/r/a.ts", oldText: "x", newText: "y" } }),
        tool("write", { input: { path: "/r/b.ts", content: "1\n2\n3" } }),
        tool("edit", { input: { path: "/r/a.ts", oldText: "p", newText: "q\nr" } }),
        tool("edit", { input: { path: "/r/c.ts" } }),
        tool("edit", { state: "output-error", input: { path: "/r/d.ts", oldText: "1", newText: "2" } }),
        tool("bash", { input: { command: "rm x" } }),
        tool("edit", { input: { oldText: "1", newText: "2" } }),
      ],
    }),
  ]
  const c = changesOfSession(items)
  assert.deepEqual(c.files.map((f) => [f.path, f.added, f.removed, f.edits]), [["/r/a.ts", 3, 2, 2], ["/r/b.ts", 3, 0, 1]])
  assert.deepEqual([c.added, c.removed], [6, 2])
})

test("changesOfSession：没有改动 / 缺数据返回 null；带 details.patch 时用 patch", () => {
  assert.equal(changesOfSession([]), null)
  assert.equal(changesOfSession(null), null)
  assert.equal(changesOfSession([asst()]), null)
  const c = changesOfSession([asst({ blocks: [tool("edit", { input: { path: "x.ts" }, patch: PATCH })] })])
  assert.deepEqual([c.added, c.removed, c.files[0].rows[0].n], [2, 1, 10])
})

/* ---------------- prefs ---------------- */

test("migratePiPrefs：空存储给默认值（默认投递插入当前回合、分组按设备）", () => {
  assert.deepEqual(migratePiPrefs(null), DEFAULT_PI_PREFS)
  assert.equal(DEFAULT_PI_PREFS.delivery, "steer")
  assert.equal(DEFAULT_PI_PREFS.grouping, "device")
  assert.equal(DEFAULT_PI_PREFS.completionSound, false)
})

test("migratePiPrefs：新键逐字段校验（含 grouping），不合法回落默认、多余字段丢掉", () => {
  const p = migratePiPrefs(JSON.stringify({ v: 1, theme: "dark", density: "compact", grouping: "flat", deviceFilter: "d-mbp", delivery: "follow_up", completionSound: true, junk: 1 }))
  assert.deepEqual(p, { v: 1, ui: "cursor", uiPlatformTab: "all", deviceByPlatform: {}, theme: "dark", density: "compact", grouping: "flat", deviceFilter: "d-mbp", delivery: "follow_up", completionSound: true, dialogRemoteAnswer: false, sidebarWidth: 272, sidebarCollapsed: false, mobileNav: "list", sidebarPersistentSearch: false })
  const bad = migratePiPrefs({ theme: "claude", grouping: "tree", deviceFilter: "", completionSound: "yes" })
  assert.deepEqual([bad.theme, bad.grouping, bad.deviceFilter, bad.completionSound], ["system", "device", null, false])
  assert.deepEqual(migratePiPrefs("{broken"), DEFAULT_PI_PREFS)
})

test("migratePiPrefs：从旧 pi_remote_style 只搬两个开关；新键存在时不看旧键", () => {
  const legacy = JSON.stringify({ uiRevision: 4, theme: "claudeDark", queueSend: "steer", completionSound: true, dialogRemoteAnswer: true })
  assert.deepEqual(migratePiPrefs(null, legacy), { ...DEFAULT_PI_PREFS, completionSound: true, dialogRemoteAnswer: true })
  assert.equal(migratePiPrefs({ v: 1 }, legacy).completionSound, false)
  assert.deepEqual(migratePiPrefs(undefined, "nope"), DEFAULT_PI_PREFS)
})

test("setPiPref：改分组时要清展开状态", () => {
  const a = setPiPref(DEFAULT_PI_PREFS, "grouping", "flat")
  assert.deepEqual([a.prefs.grouping, a.clearExpanded], ["flat", true])
  assert.equal(setPiPref(DEFAULT_PI_PREFS, "grouping", "device").clearExpanded, false)
  assert.equal(setPiPref(DEFAULT_PI_PREFS, "theme", "dark").clearExpanded, false)
})

/* ---------------- piDuration / piRelativeTime（components/pi/shared/format.ts，P2 搬入；文件在才跑） ---------------- */

const FORMAT = new URL("../ui/src/components/pi/shared/format.ts", import.meta.url)
const hasFormat = existsSync(FORMAT)

test("piDuration：整点省掉 0 的第二个单位，2m 14s 不变", { skip: hasFormat ? false : "format.ts 还没搬入（P2），合并后自动启用" }, async () => {
  const { piDuration } = await import(FORMAT.href)
  assert.equal(piDuration(21 * H), "21h")
  assert.equal(piDuration(3 * MIN), "3m")
  assert.equal(piDuration(134_000), "2m 14s")
  assert.equal(piDuration(5 * H + 12 * MIN), "5h 12m")
  assert.equal(piDuration(42_000), "42s")
  assert.equal(piDuration(10), "1s")
})

test("piRelativeTime：五档", { skip: hasFormat ? false : "format.ts 还没搬入（P2），合并后自动启用" }, async () => {
  const { piRelativeTime } = await import(FORMAT.href)
  assert.equal(piRelativeTime(NOW - 10_000, NOW), "刚刚")
  assert.equal(piRelativeTime(NOW - 5 * MIN, NOW), "5m")
  assert.equal(piRelativeTime(NOW - 5 * H, NOW), "5h")
  assert.equal(piRelativeTime(NOW - 26 * H, NOW), "1d")
  const old = NOW - 10 * 24 * H
  const d = new Date(old)
  assert.equal(piRelativeTime(old, NOW), `${d.getMonth() + 1}/${d.getDate()}`)
})
