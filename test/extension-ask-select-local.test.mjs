// A-1: ask_user single-select at the terminal. pi's own selector drops
// typed characters and resolves any Enter as "confirm option 1", so a
// message typed while a question was pending vanished and answered the
// question by accident. These tests pin the safe local semantics: the
// pure key state machine, the custom component built on it, and
// executeAskUser's routing (custom component in TUI mode, host select
// everywhere else, remote hold unchanged).
import test from "node:test"
import assert from "node:assert/strict"
import { createJiti } from "jiti"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const LOG_PATH = path.join(os.tmpdir(), `pi-remote-ask-select-test-${process.pid}.log`)
process.env.PI_REMOTE_LOG = LOG_PATH
process.env.PI_REMOTE_ATTACH_FILE = path.join(os.tmpdir(), `pi-remote-attach-ask-select-${process.pid}-missing.json`)
process.env.PI_REMOTE_TOKEN = "ask-select-test-token"
const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)
test.after(() => { try { fs.rmSync(LOG_PATH, { force: true }) } catch {} })

const DISPLAY = ["面条", "米饭", ext.ASK_FREE_TEXT_SENTINEL]
const feedKeys = (state, display, chunks, allowFreeText, kb) => {
  let outcome = { type: "continue" }
  for (const chunk of chunks) {
    for (const key of ext.normalizeAskSelectKeys(chunk, kb)) {
      outcome = ext.askSelectApplyKey(state, display, key, allowFreeText)
      if (outcome.type !== "continue") return outcome
    }
  }
  return outcome
}

/* ---------------- normalizeAskSelectKeys ---------------- */

test("A-1 normalize: arrows / enter / esc / backspace map to semantic keys", () => {
  assert.deepEqual(ext.normalizeAskSelectKeys("\x1b[A"), [{ kind: "up" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\x1b[B"), [{ kind: "down" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\x1bOA"), [{ kind: "up" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\r"), [{ kind: "confirm" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\n"), [{ kind: "confirm" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\x1b"), [{ kind: "cancel" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\x03"), [{ kind: "cancel" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\x7f"), [{ kind: "backspace" }])
})

test("A-1 normalize: text chunks, batched trailing Enter, paste, ignored sequences", () => {
  assert.deepEqual(ext.normalizeAskSelectKeys("abc"), [{ kind: "chars", text: "abc" }])
  // send-keys style batch: text and Enter in one chunk still confirm after the text
  assert.deepEqual(ext.normalizeAskSelectKeys("abc\r"), [{ kind: "chars", text: "abc" }, { kind: "confirm" }])
  // bracketed paste: newlines become spaces, never a mid-paste confirm
  assert.deepEqual(ext.normalizeAskSelectKeys("\x1b[200~line1\nline2\x1b[201~"), [{ kind: "chars", text: "line1 line2" }])
  assert.deepEqual(ext.normalizeAskSelectKeys("\x1b[<0;10;20M"), [], "mouse sequence ignored")
  assert.deepEqual(ext.normalizeAskSelectKeys(""), [])
  // host keybindings win when provided
  const kb = { matches: (data, action) => data === "K_OK" && action === "tui.select.confirm" }
  assert.deepEqual(ext.normalizeAskSelectKeys("K_OK", kb), [{ kind: "confirm" }])
})

/* ---------------- askSelectApplyKey ---------------- */

test("A-1 machine: Enter on an empty buffer picks the highlighted option; arrows clamp", () => {
  const s = ext.createAskSelectState()
  assert.deepEqual(feedKeys(s, DISPLAY, ["\r"], true), { type: "pick", value: "面条" })
  const s2 = ext.createAskSelectState()
  assert.deepEqual(feedKeys(s2, DISPLAY, ["\x1b[B", "\x1b[B", "\x1b[B", "\r"], true), { type: "pick", value: ext.ASK_FREE_TEXT_SENTINEL }, "down clamps at the last row")
  const s3 = ext.createAskSelectState()
  feedKeys(s3, DISPLAY, ["\x1b[A"], true)
  assert.equal(s3.selectedIndex, 0, "up clamps at the first row")
})

test("A-1 machine: typed text + Enter is the free-text answer, never option 1", () => {
  const s = ext.createAskSelectState()
  const out = feedKeys(s, DISPLAY, ["先别答，我在打新消息", "\r"], true)
  assert.deepEqual(out, { type: "text", value: "先别答，我在打新消息" })
})

test("A-1 machine: without a free-text slot, typed Enter is ignored and the text stays editable", () => {
  const display = ["甲", "乙"]
  const s = ext.createAskSelectState()
  const out = feedKeys(s, display, ["误输入", "\r"], false)
  assert.equal(out.type, "continue", "Enter must not submit anything")
  assert.equal(s.typed, "误输入", "typed text is preserved, not swallowed into an answer")
  // backspace it away, then Enter picks explicitly again
  const out2 = feedKeys(s, display, ["\x7f", "\x7f", "\x7f", "\r"], false)
  assert.deepEqual(out2, { type: "pick", value: "甲" })
})

test("A-1 machine: j/k and leading digits are typed characters, not selection shortcuts", () => {
  const s = ext.createAskSelectState()
  feedKeys(s, DISPLAY, ["just wait"], true)
  assert.equal(s.selectedIndex, 0, "j must not move the highlight")
  assert.equal(s.typed, "just wait")
  const s2 = ext.createAskSelectState()
  const out = feedKeys(s2, DISPLAY, ["3 号方案", "\r"], true)
  assert.deepEqual(out, { type: "text", value: "3 号方案" }, "a digit-leading message must not select option 3/1")
})

test("A-1 machine: Esc cancels even with text in the buffer", () => {
  const s = ext.createAskSelectState()
  assert.deepEqual(feedKeys(s, DISPLAY, ["abc", "\x1b"], true), { type: "cancel" })
})

/* ---------------- the custom component (thin shell over the machine) ---------------- */

function runComponent(script, { display = DISPLAY, allowFreeText = true, opts = {} } = {}) {
  const factory = ext.askSelectComponentFactory("今晚吃什么？", display, opts, allowFreeText)
  let settled = false
  let value
  const comp = factory({ requestRender() {} }, {}, null, (v) => { settled = true; value = v })
  for (const chunk of script) comp.handleInput(chunk)
  return { settled, value, comp }
}

test("A-1 component: typing a message + Enter settles as free text (the A-1 repro)", () => {
  const { settled, value } = runComponent(["DEEPQ2B 后续消息", "\r"])
  assert.equal(settled, true)
  assert.deepEqual(value, { __askLocalFreeText: "DEEPQ2B 后续消息" })
  assert.equal(ext.isAskLocalFreeText(value), true)
})

test("A-1 component: bare Enter picks the highlight; arrows then Enter picks row 2; Esc cancels", () => {
  assert.equal(runComponent(["\r"]).value, "面条")
  assert.equal(runComponent(["\x1b[B", "\r"]).value, "米饭")
  const esc = runComponent(["\x1b"])
  assert.equal(esc.settled, true)
  assert.equal(esc.value, undefined)
})

test("A-1 component: render shows the typed buffer instead of hiding it", () => {
  const { comp } = runComponent(["你好"])
  const text = comp.render(80).join("\n")
  assert.ok(text.includes("输入中：你好"), "the user can see what they typed")
  assert.ok(text.includes("→ 面条"), "highlight still on row 1")
})

test("A-1 component: timeout settles as cancel (undefined), like pi's selector", async () => {
  const factory = ext.askSelectComponentFactory("q", DISPLAY, { timeout: 30 }, true)
  const value = await new Promise((resolve) => { factory({ requestRender() {} }, {}, null, resolve) })
  assert.equal(value, undefined)
})

/* ---------------- executeAskUser routing ---------------- */

// A ui whose custom() actually mounts the component and feeds it a key script.
function scriptedUi(script, extra = {}) {
  const calls = []
  const ui = {
    select: async (title, options) => { calls.push("select"); return extra.selectResult ? extra.selectResult(options) : options[0] },
    confirm: async () => { calls.push("confirm"); return true },
    input: async () => { calls.push("input"); return extra.inputResult ?? "自由文本" },
    custom: (factory) => {
      calls.push("custom")
      return new Promise((resolve) => {
        const comp = factory({ requestRender() {} }, {}, null, (v) => resolve(v))
        for (const chunk of script) comp.handleInput(chunk)
      })
    },
  }
  return { ui, calls }
}

test("A-1 execute: TUI typed message + Enter answers with the text; host select never runs", async () => {
  const b = new ext.Bridge()
  const { ui, calls } = scriptedUi(["先吃别的，这是新消息", "\r"])
  const r = await b.executeAskUser({ question: "今晚吃什么？", options: ["面条", "米饭"] }, { hasUI: true, mode: "tui", ui })
  assert.equal(r.details.answer, "先吃别的，这是新消息")
  assert.equal(r.details.kind, "select+input")
  assert.deepEqual(calls, ["custom"], "only the safe component is used")
  b.clearTimers()
})

test("A-1 execute: TUI bare Enter and arrow+Enter pick options through the component", async () => {
  const b = new ext.Bridge()
  const a = scriptedUi(["\r"])
  const r1 = await b.executeAskUser({ question: "q", options: ["面条", "米饭"] }, { hasUI: true, mode: "tui", ui: a.ui })
  assert.equal(r1.details.answer, "面条")
  assert.equal(r1.details.kind, "select")
  const c = scriptedUi(["\x1b[B", "\r"])
  const r2 = await b.executeAskUser({ question: "q", options: ["面条", "米饭"] }, { hasUI: true, mode: "tui", ui: c.ui })
  assert.equal(r2.details.answer, "米饭")
  b.clearTimers()
})

test("A-1 execute: TUI explicit sentinel pick still runs the two-stage input", async () => {
  const b = new ext.Bridge()
  const { ui, calls } = scriptedUi(["\x1b[B", "\x1b[B", "\r"], { inputResult: "手擀面" })
  const r = await b.executeAskUser({ question: "q", options: ["面条", "米饭"] }, { hasUI: true, mode: "tui", ui })
  assert.equal(r.details.answer, "手擀面")
  assert.equal(r.details.kind, "select+input")
  assert.deepEqual(calls, ["custom", "input"])
  b.clearTimers()
})

test("A-1 execute: RPC mode keeps the host select (custom is not usable there)", async () => {
  const b = new ext.Bridge()
  const { ui, calls } = scriptedUi(["\r"], { selectResult: (options) => options[1] })
  const r = await b.executeAskUser({ question: "q", options: ["面条", "米饭"] }, { hasUI: true, mode: "rpc", ui })
  assert.equal(r.details.answer, "米饭")
  assert.equal(r.details.kind, "select")
  assert.deepEqual(calls, ["select"], "no custom component in RPC mode")
  b.clearTimers()
})

test("A-1 execute: TUI host without custom(), or a host that swallows it, falls back to select", async () => {
  const b = new ext.Bridge()
  const noCustom = { select: async (t, options) => options[1], confirm: async () => true, input: async () => "x" }
  const r1 = await b.executeAskUser({ question: "q", options: ["面条", "米饭"] }, { hasUI: true, mode: "tui", ui: noCustom })
  assert.equal(r1.details.answer, "米饭")
  const swallow = {
    select: async (t, options) => options[1], confirm: async () => true, input: async () => "x",
    custom: async () => undefined, // host resolves without ever showing the component
  }
  const r2 = await b.executeAskUser({ question: "q", options: ["面条", "米饭"] }, { hasUI: true, mode: "tui", ui: swallow })
  assert.equal(r2.details.answer, "米饭", "a swallowed component must not fake a cancel")
  assert.equal(r2.details.cancelled, false)
  b.clearTimers()
})

test("A-1 execute: remote hold still wins in TUI mode; local renderers stay untouched", async () => {
  const b = new ext.Bridge()
  const sent = []
  b.ws = { bufferedAmount: 0, readyState: 1, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  b.connected = true
  b.roomId = "room-ask-select"
  b.dialogAnswerEnabled = true
  b.dialogGateHasViewers = true
  b.tapState = "ok"
  const { ui, calls } = scriptedUi(["\r"])
  const p = b.executeAskUser({ question: "q", options: ["面条", "米饭"] }, { hasUI: true, mode: "tui", ui })
  assert.ok(b.dialogActiveId, "the select is held for remote answer")
  assert.deepEqual(calls, [], "no local renderer while held")
  b.noteDialogAnswer({ aid: "a1", dialogId: b.dialogActiveId, action: "submit", value: "米饭" })
  const r = await p
  assert.equal(r.details.answer, "米饭")
  assert.equal(r.details.kind, "select")
  b.clearTimers()
})
