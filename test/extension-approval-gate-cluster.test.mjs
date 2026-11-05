// Approval-gate cluster fixes (2026-11-05):
//  1) the block reason distinguishes explicit refusal / bridge timeout /
//     cancelled instead of always claiming "用户拒绝了该工具调用";
//  2) the local (terminal) approval prompt runs through the A-1 safe
//     selector, so typing a message can no longer approve by accident;
//  3) ext_status carries the device-side switch state (switches), and a
//     switch change re-emits it, so viewers adopt device state on
//     connect instead of pushing their own stored prefs over it.
import test from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const LOG_PATH = path.join(os.tmpdir(), `pi-remote-approval-cluster-test-${process.pid}.log`)
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(os.tmpdir(), `pi-remote-attach-approval-cluster-${process.pid}-missing.json`)
process.env.PI_REMOTE_TOKEN = "approval-cluster-test-token"
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)
test.after(() => { try { fs.rmSync(LOG_PATH, { force: true }) } catch {} })

const EVENT = { type: "tool_call", toolName: "bash", input: { command: "rm -rf build" } }
const REJECTED = "用户拒绝了该工具调用"

function gateBridge() {
  const b = new ext.Bridge()
  b.pi = { getAllTools: () => [{ name: "bash", annotations: { destructiveHint: true } }] }
  b.emitEvent = () => {}
  b.setApprovalGate({ enabled: true, tier: "high-risk" })
  return b
}

/* ---------------- approvalBlockReason (pure) ---------------- */

test("审批门文案矩阵：只有明确拒绝才称「用户拒绝」", () => {
  assert.equal(ext.approvalBlockReason("拒绝", "answered"), REJECTED, "本机选中「拒绝」")
  assert.equal(ext.approvalBlockReason("拒绝", "local"), REJECTED)
  assert.equal(ext.approvalBlockReason(undefined, "denied"), REJECTED, "远程 deny 动作（含带理由拒绝）")
  const timeout = ext.approvalBlockReason(undefined, "timeout")
  assert.match(timeout, /超时/, "桥侧超时要说清是超时")
  assert.match(timeout, /无人应答/)
  assert.notEqual(timeout, REJECTED)
  for (const reason of ["local", "aborted", "answered", ""]) {
    const text = ext.approvalBlockReason(undefined, reason)
    assert.match(text, /未完成/, `reason=${reason || "(空)"} 落未完成口径`)
    assert.notEqual(text, REJECTED)
  }
})

/* ---------------- local path (no remote hold) ---------------- */

test("审批门本机路径：选中「拒绝」= 用户拒绝；Esc 取消 = 未完成（不再冒充拒绝）", async () => {
  const b = gateBridge()
  const denyUi = { select: async (title, options) => options[2], confirm: async () => true, input: async () => "x" }
  const blocked = await b.checkToolCallApproval(EVENT, { hasUI: true, mode: "rpc", ui: denyUi })
  assert.equal(blocked.block, true)
  assert.equal(blocked.reason, REJECTED)

  const cancelUi = { select: async () => undefined, confirm: async () => true, input: async () => "x" }
  const cancelled = await b.checkToolCallApproval(EVENT, { hasUI: true, mode: "rpc", ui: cancelUi })
  assert.equal(cancelled.block, true)
  assert.match(cancelled.reason, /未完成/)
  assert.notEqual(cancelled.reason, REJECTED)
  b.clearTimers()
})

test("审批门本机路径：允许一次放行；本会话都允许后同工具不再问", async () => {
  const b = gateBridge()
  let asks = 0
  const sessionUi = { select: async (title, options) => { asks += 1; return options[1] }, confirm: async () => true, input: async () => "x" }
  assert.equal(await b.checkToolCallApproval(EVENT, { hasUI: true, mode: "rpc", ui: sessionUi }), undefined)
  assert.equal(await b.checkToolCallApproval(EVENT, { hasUI: true, mode: "rpc", ui: sessionUi }), undefined)
  assert.equal(asks, 1, "本会话都允许只问一次")
  b.clearTimers()
})

/* ---------------- terminal safe selector (TUI custom component) ---------------- */

// A ui whose custom() mounts the component and hands the test its handle.
// Key chunks fed before the component mounts are queued and flushed on
// mount (the approval call reaches custom() a microtask after it starts).
function manualUi() {
  const calls = []
  const pending = []
  let comp = null
  const ui = {
    select: async () => { calls.push("select"); return undefined },
    confirm: async () => true,
    input: async () => "x",
    custom: (factory) => {
      calls.push("custom")
      return new Promise((resolve) => {
        comp = factory({ requestRender() {} }, {}, null, (v) => resolve(v))
        for (const chunk of pending.splice(0)) comp.handleInput(chunk)
      })
    },
  }
  return { ui, calls, feed: (chunk) => { if (comp) comp.handleInput(chunk); else pending.push(chunk) } }
}

test("审批门终端路径：打字 + 回车绝不误批（A-1 语义），Esc 后按未完成拦截", async () => {
  const b = gateBridge()
  const m = manualUi()
  const p = b.checkToolCallApproval(EVENT, { hasUI: true, mode: "tui", ui: m.ui })
  let done = false
  void p.then(() => { done = true })
  m.feed("这是一条新消息，不是批准")
  m.feed("\r")
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(done, false, "打了字再回车：审批不落定、更不许误批为「允许一次」")
  m.feed("\x1b") // Esc 取消
  const out = await p
  assert.equal(out.block, true)
  assert.match(out.reason, /未完成/)
  assert.deepEqual(m.calls, ["custom"], "终端只用安全选择器，不回宿主 select")
  b.clearTimers()
})

test("审批门终端路径：方向键明选「拒绝」= 用户拒绝；空缓冲回车选高亮（允许一次）放行", async () => {
  const b = gateBridge()
  const m1 = manualUi()
  const p1 = b.checkToolCallApproval(EVENT, { hasUI: true, mode: "tui", ui: m1.ui })
  m1.feed("\x1b[B")
  m1.feed("\x1b[B")
  m1.feed("\r")
  const denied = await p1
  assert.equal(denied.block, true)
  assert.equal(denied.reason, REJECTED)

  const m2 = manualUi()
  const p2 = b.checkToolCallApproval(EVENT, { hasUI: true, mode: "tui", ui: m2.ui })
  m2.feed("\r")
  assert.equal(await p2, undefined, "高亮停在「允许一次」、空缓冲回车 = 明示批准")
  b.clearTimers()
})

/* ---------------- held path (remote answer) ---------------- */

function heldBridge() {
  const b = gateBridge()
  const frames = []
  b.emitEvent = (ev) => frames.push(ev)
  const calls = []
  const ui = {
    select: async (title, options) => { calls.push(["select", title, options]); return options[0] },
    confirm: async () => { calls.push(["confirm"]); return true },
    input: async () => { calls.push(["input"]); return "x" },
    editor: async () => "",
    notify: () => {},
    setStatus: () => {},
    setWidget: () => {},
    setTitle: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
  }
  b.ctx = { hasUI: true, ui }
  b.roomId = "r"
  return { b, ui, frames, calls }
}

async function armHeld(b) {
  b.installDialogTap()
  await b.handle({ type: "dialog_answer_switch", enabled: true })
  await b.handle({ type: "dialog_gate", hasViewers: true })
}

test("审批门持留路径：远程 deny = 用户拒绝；提交「拒绝」选项同口径；本机零弹窗", async () => {
  const { b, ui, calls } = heldBridge()
  await armHeld(b)
  const ctx = { hasUI: true, mode: "tui", ui }

  const p1 = b.checkToolCallApproval(EVENT, ctx)
  assert.ok(b.dialogActiveId, "审批被持留等远程裁决")
  assert.equal(calls.length, 0, "持留时本机不弹窗")
  b.noteDialogAnswer({ aid: "a1", dialogId: b.dialogActiveId, action: "deny", note: "先别删" })
  const denied = await p1
  assert.equal(denied.block, true)
  assert.equal(denied.reason, REJECTED)

  const p2 = b.checkToolCallApproval(EVENT, ctx)
  b.noteDialogAnswer({ aid: "a2", dialogId: b.dialogActiveId, action: "submit", value: "拒绝" })
  const denied2 = await p2
  assert.equal(denied2.block, true)
  assert.equal(denied2.reason, REJECTED)

  const p3 = b.checkToolCallApproval(EVENT, ctx)
  b.noteDialogAnswer({ aid: "a3", dialogId: b.dialogActiveId, action: "submit", value: "允许一次" })
  assert.equal(await p3, undefined)
  b.uninstallDialogTap()
  b.clearTimers()
})

test("审批门持留路径：桥侧超时落定 = 超时无人应答，不是用户拒绝", async () => {
  const { b, ui } = heldBridge()
  await armHeld(b)
  const p = b.checkToolCallApproval(EVENT, { hasUI: true, mode: "tui", ui })
  const entry = [...b.dialogHeld.values()][0]
  assert.ok(entry, "持留条目在册")
  // 与 activateHeldDialog 里裁决计时器完全相同的调用（120 秒计时器本体不适合在测试里真等）
  b.settleHeldDialog(entry, undefined, "timeout")
  const out = await p
  assert.equal(out.block, true)
  assert.match(out.reason, /超时/)
  assert.notEqual(out.reason, REJECTED)
  b.uninstallDialogTap()
  b.clearTimers()
})

test("审批门持留路径：会话拆除（cancel 收尾）= 确认未完成", async () => {
  const { b, ui } = heldBridge()
  await armHeld(b)
  const p = b.checkToolCallApproval(EVENT, { hasUI: true, mode: "tui", ui })
  b.releaseAllHeldDialogs("cancel")
  const out = await p
  assert.equal(out.block, true)
  assert.match(out.reason, /未完成/)
  b.uninstallDialogTap()
  b.clearTimers()
})

/* ---------------- ext_status switch state ---------------- */

test("ext_status 带设备侧开关真值；开关变化补发新快照", async () => {
  const b = new ext.Bridge()
  const frames = []
  b.emitEvent = (ev) => frames.push(ev)
  b.roomId = "r"
  b.emitExtStatus()
  const first = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.deepEqual(first.switches, { dialogRemoteAnswer: false, approvalGate: { enabled: false, tier: "high-risk" }, askUserEnabled: true })

  await b.handle({ type: "approval_gate_switch", enabled: true, tier: "list" })
  const afterGate = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.deepEqual(afterGate.switches.approvalGate, { enabled: true, tier: "list" }, "审批门下达后补发新真值")

  await b.handle({ type: "dialog_answer_switch", enabled: true })
  const afterAnswer = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.equal(afterAnswer.switches.dialogRemoteAnswer, true, "远程应答开启后补发新真值")

  await b.handle({ type: "ask_user_switch", enabled: false })
  const afterAsk = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.equal(afterAsk.switches.askUserEnabled, false, "ask_user 下达后补发新真值")
  b.clearTimers()
})

/* ---------------- dispatch -> hold -> card frame (round 2) ---------------- */

test("审批门下达链（第 2 轮）: approval_gate_switch 开门后高危调用被持留且 dialog_open 帧发往观看端；观看端批准放行", async () => {
  const { b, ui, frames, calls } = heldBridge()
  // heldBridge arms the gate via gateBridge(); disarm it explicitly so
  // the test starts from the device-side OFF state the live check saw.
  b.setApprovalGate({ enabled: false, tier: "high-risk" })
  await armHeld(b)
  const ctx = { hasUI: true, mode: "tui", ui }

  // Gate OFF at the device: the same high-risk call runs free -- no
  // hold, no card (this is what the live bash call did while the
  // settings page showed a local ON).
  assert.equal(await b.checkToolCallApproval(EVENT, ctx), undefined, "设备门关：不持留")
  assert.equal(frames.filter((f) => f.type === "dialog_open").length, 0, "设备门关：无审批卡帧")

  // The viewer's explicit toggle arrives as the switch frame; the
  // bridge flips and re-reports, which is what viewers adopt.
  await b.handle({ type: "approval_gate_switch", enabled: true, tier: "high-risk" })
  const status = frames.filter((f) => f.type === "ext_status").at(-1)
  assert.equal(status.switches.approvalGate.enabled, true, "下达后 ext_status 报告门已开")

  const p = b.checkToolCallApproval(EVENT, ctx)
  assert.ok(b.dialogActiveId, "设备门开：高危调用被持留")
  const open = frames.filter((f) => f.type === "dialog_open").at(-1)
  assert.ok(open, "持留同时 dialog_open 帧已发出（卡片到达观看端的路径）")
  assert.equal(open.dialogId, b.dialogActiveId, "卡片帧与持留条目是同一 dialog")
  assert.equal(calls.length, 0, "持留时本机终端不弹窗")

  b.noteDialogAnswer({ aid: "g1", dialogId: b.dialogActiveId, action: "submit", value: "允许一次" })
  assert.equal(await p, undefined, "观看端批准后放行执行")
  b.uninstallDialogTap()
  b.clearTimers()
})

/* ---------------- ext_status delivery re-arm (round 3) ---------------- */

test("ext_status 送达再武装：注册完成补发全量快照；relay 索取帧应答当前真值；别房索取不理", async () => {
  const b = new ext.Bridge()
  const frames = []
  b.emitEvent = (ev) => frames.push(ev)
  b.roomId = "r"
  // Registration completing is the one moment that must end with a
  // fresh snapshot on the wire: emits fired earlier race the relay's
  // room-ownership check and are dropped, and an idle session may
  // never emit again (the live failure behind VERIFY2 item 3).
  await b.handle({ type: "room_registered", room: "r", msgCount: 0, rev: null, seq: 0 })
  const onRegister = frames.filter((f) => f.type === "ext_status")
  assert.equal(onRegister.length, 1, "room_registered 后恰补发一份 ext_status")
  assert.deepEqual(onRegister[0].switches, { dialogRemoteAnswer: false, approvalGate: { enabled: false, tier: "high-risk" }, askUserEnabled: true })

  // The relay asks when its per-room cache is empty: answer with the
  // full snapshot carrying the CURRENT truth (the gate was flipped
  // after registration; setApprovalGate's own change emit is counted
  // separately via `before`).
  b.setApprovalGate({ enabled: true, tier: "list" })
  const before = frames.filter((f) => f.type === "ext_status").length
  await b.handle({ type: "ext_status_request", room: "r" })
  const after = frames.filter((f) => f.type === "ext_status")
  assert.equal(after.length, before + 1, "索取帧恰应答一份")
  assert.deepEqual(after.at(-1).switches.approvalGate, { enabled: true, tier: "list" }, "应答带当前真值，不是注册时的旧值")

  // A request naming another room is not ours to answer.
  await b.handle({ type: "ext_status_request", room: "other-room" })
  assert.equal(frames.filter((f) => f.type === "ext_status").length, before + 1, "别房索取不补发")
  b.clearTimers()
})
