// (b+) S-2: extension-side sealing (dialog_open textEnc/titleEnc,
// ui_prompt titleEnc, ext_notify messageEnc at the emitEventNow out-gate),
// bridge-side answer opening (valueEnc/valuesEnc under the room RCK,
// noteEnc pass-through to dialog_close), and the relay's section-3.4
// answer-form check in viewer.js (sealed slot takes only *Enc fields,
// plaintext slot rejects them, plaintext value clamped on forward --
// INVENTORY 7.3). The bridge half drives a real Bridge wired like the
// Phase 3 content tests; the relay half drives a real relay over WS
// with hand-built sealed slots, like the S-0 tests.
import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createJiti } from "jiti"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const require = createRequire(import.meta.url)
const { startRelay } = require("../relay/server.js")
const WebSocket = require("ws")

const jiti = createJiti(import.meta.url, { interopDefault: false })
const ext = await jiti.import(new URL("../extension/pi-remote-sync.ts", import.meta.url).pathname)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bplus-s2-"))

/* ---------- bridge scaffolding (same shape as extension-crypto-content) ---------- */

function makeKeyData(deviceId = "dev-bplus-s2") {
  const sign = crypto.generateKeyPairSync("ed25519")
  const box = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
  const der = (k, type) => k.export({ format: "der", type }).toString("base64")
  return {
    v: 1, deviceId, createdAt: 1700000000000,
    sign: { alg: "ed25519", pub: der(sign.publicKey, "spki"), priv: der(sign.privateKey, "pkcs8") },
    box: { alg: "p256", pub: der(box.publicKey, "spki"), priv: der(box.privateKey, "pkcs8") },
  }
}
let keyFileSeq = 0
function loadKeyWithAck(ack) {
  const data = makeKeyData()
  if (ack) data.contentKeys = { admin: ack.toString("base64") }
  const file = path.join(TMP, `s2-${++keyFileSeq}.key.json`)
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  const r = ext.loadDeviceKey({ PI_REMOTE_DEVICE_KEY_FILE: file })
  assert.equal(r.status, "ok", r.warning || "")
  return r.key
}

/** A Bridge ready to seal interaction text: key auth, an ACK held, the
 *  relay advertising crypto.content AND crypto.dialog, one confirmed
 *  room, and the dialog-answer gate open. Pass { dialogCap:false } to
 *  model a pre-(b+) relay, or { ack:null } for a device holding no ACK. */
function sealBridge(roomId = "room-s2-enc", opts = {}) {
  const ack = opts.ack === null ? null : crypto.randomBytes(32)
  const bridge = new ext.Bridge()
  const sent = []
  bridge.ws = { bufferedAmount: 0, readyState: 1, send(s) { sent.push(JSON.parse(s)) }, close() {} }
  bridge.connected = true
  bridge.authed = true
  bridge.deviceKey = loadKeyWithAck(ack)
  bridge.relayAuth = "key"
  const caps = ["crypto.auth", "crypto.content"]
  if (opts.dialogCap !== false) caps.push("crypto.dialog")
  bridge.relayCaps = new Set(caps)
  bridge.roomId = roomId
  bridge.confirmedRoom = roomId
  bridge.dialogAnswerEnabled = true
  bridge.dialogGateHasViewers = true
  bridge.tapState = "ok"
  return { bridge, sent, ack, roomId }
}
const eventsOf = (sent, type) => sent.filter((f) => f.type === "event" && f.event && f.event.type === type)
const resultsOf = (sent) => sent.filter((f) => f.type === "dialog_answer_result")
const pending = (p, ms = 60) => Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), ms))])

/* ---------- 1) dialog_open sealing ---------- */

test("seal: dialog_open packs the five text fields into textEnc (RCK) + titleEnc (ACK), plaintext gone", async () => {
  const { bridge, sent, ack, roomId } = sealBridge()
  const p = bridge.beginDialog("select", ["Pick one BPLUS-Q", ["alpha", "beta"], {}], () => {})
  assert.ok(p, "beginDialog must take the dialog over")
  const opens = eventsOf(sent, "dialog_open")
  assert.equal(opens.length, 1)
  const ev = opens[0].event
  assert.equal(ev.answerable, true)
  assert.equal(ev.kind, "select")
  for (const f of ["title", "options", "message", "placeholder", "prefill"]) {
    assert.ok(!(f in ev), `sealed frame must not carry plaintext ${f}`)
  }
  const entry = bridge.ensureRoomKey(roomId)
  const pack = JSON.parse(ext.decryptTextCt(entry.rck, ev.textEnc.ct))
  assert.deepEqual(pack, { title: "Pick one BPLUS-Q", options: ["alpha", "beta"] })
  assert.equal(ext.decryptAckText(ack, ev.titleEnc), "Pick one BPLUS-Q")
  bridge.noteDialogAnswer({ aid: "a0", dialogId: ev.dialogId, action: "submit", value: "alpha" })
  assert.equal(await p, "alpha")
})

test("seal: confirm message and editor prefill ride the same pack; no title means no titleEnc", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const p1 = bridge.beginDialog("confirm", ["Delete it?", "This cannot be undone BPLUS-M"], () => {})
  const ev1 = eventsOf(sent, "dialog_open")[0].event
  assert.deepEqual(JSON.parse(ext.decryptTextCt(entry.rck, ev1.textEnc.ct)), { title: "Delete it?", message: "This cannot be undone BPLUS-M" })
  bridge.noteDialogAnswer({ aid: "a1", dialogId: ev1.dialogId, action: "allow" })
  assert.equal(await p1, true)
  const p2 = bridge.beginDialog("editor", ["Edit the draft", "prefill BPLUS-P"], () => {})
  const ev2 = eventsOf(sent, "dialog_open")[1].event
  assert.deepEqual(JSON.parse(ext.decryptTextCt(entry.rck, ev2.textEnc.ct)), { title: "Edit the draft", prefill: "prefill BPLUS-P" })
  bridge.noteDialogAnswer({ aid: "a2", dialogId: ev2.dialogId, action: "submit", value: "edited" })
  assert.equal(await p2, "edited")
})

test("seal condition matrix: no crypto.dialog from the relay, or no ACK held, keeps frames byte-identical plaintext", async () => {
  // (a) relay without the cap (old relay): device must not seal.
  const a = sealBridge("room-s2-a", { dialogCap: false })
  const pa = a.bridge.beginDialog("select", ["Plain Q", ["x", "y"], {}], () => {})
  const eva = eventsOf(a.sent, "dialog_open")[0].event
  assert.equal(eva.title, "Plain Q")
  assert.deepEqual(eva.options, ["x", "y"])
  assert.ok(!("textEnc" in eva) && !("titleEnc" in eva))
  a.bridge.noteDialogAnswer({ aid: "a", dialogId: eva.dialogId, action: "submit", value: "x" })
  assert.equal(await pa, "x")
  // (b) cap present but the device holds no ACK: encEntry is null, no seal.
  const b = sealBridge("room-s2-b", { ack: null })
  const pb = b.bridge.beginDialog("input", ["Your name?", "type here"], () => {})
  const evb = eventsOf(b.sent, "dialog_open")[0].event
  assert.equal(evb.title, "Your name?")
  assert.equal(evb.placeholder, "type here")
  assert.ok(!("textEnc" in evb) && !("titleEnc" in evb))
  b.bridge.noteDialogAnswer({ aid: "b", dialogId: evb.dialogId, action: "submit", value: "n" })
  assert.equal(await pb, "n")
})

test("seal: ui_prompt start AND end carry titleEnc only; ext_notify carries messageEnc only", () => {
  const { bridge, sent, ack } = sealBridge()
  bridge.emitEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Prompt title BPLUS-T" })
  bridge.emitEvent({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Prompt title BPLUS-T" })
  const starts = eventsOf(sent, "ui_prompt_start")
  const ends = eventsOf(sent, "ui_prompt_end")
  assert.equal(starts.length + ends.length, 2)
  for (const f of [...starts, ...ends]) {
    assert.ok(!("title" in f.event), "sealed ui_prompt must not carry plaintext title")
    assert.equal(ext.decryptAckText(ack, f.event.titleEnc), "Prompt title BPLUS-T")
  }
  bridge.noteUiObserve("notify", ["notify body BPLUS-N", "warning"])
  const notes = eventsOf(sent, "ext_notify")
  assert.equal(notes.length, 1)
  assert.ok(!("message" in notes[0].event))
  assert.equal(notes[0].event.level, "warning")
  const entry = bridge.ensureRoomKey(bridge.roomId)
  assert.equal(ext.decryptTextCt(entry.rck, notes[0].event.messageEnc.ct), "notify body BPLUS-N")
})

test("seal failure: frame goes out textless (structure kept, no text fields, no *Enc); no latch afterwards", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const goodRck = entry.rck
  const goodAck = bridge.accountAck.bind(bridge)
  // Sabotage both seal keys: a 3-byte RCK makes the RCK seals throw, a
  // stubbed 3-byte ACK makes the ACK seals throw. Seal conditions still
  // hold (caps + entries present), so this exercises the failure path,
  // not the condition matrix above.
  entry.rck = Buffer.alloc(3)
  bridge.accountAck = () => Buffer.alloc(3)
  try {
    const p = bridge.beginDialog("select", ["Secret question BPLUS-F", ["opt-a", "opt-b"], {}], () => {})
    const ev = eventsOf(sent, "dialog_open")[0].event
    assert.equal(ev.kind, "select")
    assert.ok(ev.dialogId, "structure field dialogId must survive")
    assert.equal(ev.answerable, true)
    for (const f of ["title", "options", "message", "placeholder", "prefill", "textEnc", "titleEnc", "messageEnc"]) {
      assert.ok(!(f in ev), `textless frame must not carry ${f}`)
    }
    assert.ok(!JSON.stringify(ev).includes("BPLUS-F") && !JSON.stringify(ev).includes("opt-a"), "no dialog text anywhere in the frame")
    bridge.noteDialogAnswer({ aid: "f0", dialogId: ev.dialogId, action: "deny" })
    await p // settle the held dialog (a select's cancel value is undefined)

    bridge.emitEvent({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Prompt secret BPLUS-F" })
    bridge.emitEvent({ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Prompt secret BPLUS-F" })
    for (const f of [...eventsOf(sent, "ui_prompt_start"), ...eventsOf(sent, "ui_prompt_end")]) {
      assert.equal(f.event.kind, "select")
      assert.ok(!("title" in f.event) && !("titleEnc" in f.event), "textless ui_prompt keeps neither title nor titleEnc")
      assert.ok(!JSON.stringify(f.event).includes("BPLUS-F"))
    }

    bridge.noteUiObserve("notify", ["notify secret BPLUS-F", "warning"])
    const note = eventsOf(sent, "ext_notify")[0].event
    assert.equal(note.level, "warning")
    assert.ok(!("message" in note) && !("messageEnc" in note), "textless ext_notify keeps neither message nor messageEnc")
    assert.ok(!JSON.stringify(note).includes("BPLUS-F"))
  } finally {
    entry.rck = goodRck
    delete bridge.accountAck
  }
  // No latch: with working keys the next dialog seals normally again.
  const p2 = bridge.beginDialog("input", ["Sealed again", ""], () => {})
  const ev2 = eventsOf(sent, "dialog_open").at(-1).event
  assert.ok(ev2.textEnc, "sealing must resume after a failure")
  assert.ok(!("title" in ev2))
  bridge.noteDialogAnswer({ aid: "f1", dialogId: ev2.dialogId, action: "submit", value: "ok" })
  assert.equal(await p2, "ok")
})

/* ---------- 2) answer opening ---------- */

test("answer: valueEnc ({enc:1,ct} and bare ct alike) opens under the room RCK and resolves", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const p1 = bridge.beginDialog("input", ["Say something", ""], () => {})
  const id1 = eventsOf(sent, "dialog_open")[0].event.dialogId
  bridge.noteDialogAnswer({ aid: "e1", dialogId: id1, action: "submit", valueEnc: { enc: 1, ct: ext.encryptTextCt(entry.rck, "sealed answer") } })
  assert.equal(await p1, "sealed answer")
  const p2 = bridge.beginDialog("input", ["Again", ""], () => {})
  const id2 = eventsOf(sent, "dialog_open")[1].event.dialogId
  bridge.noteDialogAnswer({ aid: "e2", dialogId: id2, action: "submit", valueEnc: ext.encryptTextCt(entry.rck, "bare ct answer") })
  assert.equal(await p2, "bare ct answer")
  assert.deepEqual(resultsOf(sent).map((r) => r.ok), [true, true])
})

test("answer: valuesEnc opens to the option list and is adjudicated against the table", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const p = bridge.beginDialog("multiselect", ["Pick many", ["a", "b", "c"], { minSelect: 1, maxSelect: 2 }], () => {})
  const id = eventsOf(sent, "dialog_open")[0].event.dialogId
  const ct = ext.encryptTextCt(entry.rck, JSON.stringify(["c", "a", "forged"]))
  bridge.noteDialogAnswer({ aid: "m1", dialogId: id, action: "submit", valuesEnc: { enc: 1, ct } })
  // Forged values are filtered by the existing adjudication, order kept.
  assert.deepEqual(await p, ["c", "a"])
})

test("answer: undecryptable valueEnc replies bad_args and the dialog stays answerable", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const p = bridge.beginDialog("input", ["Say something", ""], () => {})
  const id = eventsOf(sent, "dialog_open")[0].event.dialogId
  const foreign = ext.encryptTextCt(crypto.randomBytes(32), "not for this room")
  bridge.noteDialogAnswer({ aid: "x1", dialogId: id, action: "submit", valueEnc: { enc: 1, ct: foreign } })
  const res = resultsOf(sent)
  assert.equal(res.length, 1)
  assert.equal(res[0].ok, false)
  assert.equal(res[0].code, "bad_args")
  assert.equal(await pending(p), "pending", "a failed open must not settle the dialog")
  // The same dialog can still be answered correctly afterwards.
  bridge.noteDialogAnswer({ aid: "x2", dialogId: id, action: "submit", valueEnc: { enc: 1, ct: ext.encryptTextCt(entry.rck, "second try") } })
  assert.equal(await p, "second try")
})

test("answer: deny with noteEnc passes the bare ct through to dialog_close unopened", async () => {
  const { bridge, sent, roomId } = sealBridge()
  const entry = bridge.ensureRoomKey(roomId)
  const p = bridge.beginDialog("confirm", ["Run it?", "body"], () => {})
  const id = eventsOf(sent, "dialog_open")[0].event.dialogId
  const noteCt = ext.encryptTextCt(entry.rck, "deny reason BPLUS-D")
  bridge.noteDialogAnswer({ aid: "d1", dialogId: id, action: "deny", noteEnc: noteCt })
  assert.equal(await p, false)
  const closes = eventsOf(sent, "dialog_close")
  assert.equal(closes.length, 1)
  assert.equal(closes[0].event.noteEnc, noteCt, "noteEnc must pass through byte-identical")
  assert.ok(!("note" in closes[0].event), "sealed close must not carry a plaintext note")
  // An envelope-spelled noteEnc normalizes to the bare ct on the close frame.
  const p2 = bridge.beginDialog("confirm", ["Run again?", "body"], () => {})
  const id2 = eventsOf(sent, "dialog_open")[1].event.dialogId
  bridge.noteDialogAnswer({ aid: "d2", dialogId: id2, action: "deny", noteEnc: { enc: 1, ct: noteCt } })
  assert.equal(await p2, false)
  assert.equal(eventsOf(sent, "dialog_close")[1].event.noteEnc, noteCt)
})

test("answer: plaintext answers keep the pre-(b+) path exactly (unsealed dialog, mixed bridge state)", async () => {
  const { bridge, sent } = sealBridge("room-s2-plain", { dialogCap: false })
  const p = bridge.beginDialog("select", ["Plain Q", ["x", "y"], {}], () => {})
  const id = eventsOf(sent, "dialog_open")[0].event.dialogId
  bridge.noteDialogAnswer({ aid: "p1", dialogId: id, action: "submit", value: "y" })
  assert.equal(await p, "y")
  const p2 = bridge.beginDialog("confirm", ["Sure?", "b"], () => {})
  const id2 = eventsOf(sent, "dialog_open")[1].event.dialogId
  bridge.noteDialogAnswer({ aid: "p2", dialogId: id2, action: "deny", note: "plain reason" })
  assert.equal(await p2, false)
  const close = eventsOf(sent, "dialog_close")[1].event
  assert.equal(close.note, "plain reason")
  assert.ok(!("noteEnc" in close))
})

/* ---------- 3) relay section 3.4: answer-form check ---------- */

const LOCAL_TOKEN = "s2-local-" + "l".repeat(40)
const VIEWER_TOKEN = "s2-viewer-" + "v".repeat(40)
const FULL_CAPS = ["err.v4", "msg.cid", "dialog.respond", "dialog.multiselect", "room.dialogs", "room.inbox", "crypto.dialog"]
const TEXT_ENC = { enc: 1, ct: "S2-TEXT-CT" }
const TITLE_ENC = { enc: 1, ct: "S2-TITLE-CT" }

function bootRelay() {
  return startRelay({
    localPort: 0, viewerPort: 0,
    dataDir: fs.mkdtempSync(path.join(TMP, "relay-")),
    quiet: true, exitOnListenError: false,
    localToken: LOCAL_TOKEN, viewerToken: VIEWER_TOKEN,
    flushIntervalMs: 10, perMessageDeflate: false, persistTranscripts: true,
  })
}
function wsClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  const frames = []
  const waiters = []
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString())
    frames.push(msg)
    for (const w of [...waiters]) {
      if (!w.pred(msg)) continue
      msg.__taken = true
      waiters.splice(waiters.indexOf(w), 1)
      clearTimeout(w.timer)
      w.resolve(msg)
      break
    }
  })
  const api = {
    ws, frames,
    opened: new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject) }),
    send(obj) { ws.send(JSON.stringify(obj)) },
    wait(pred, ms = 3000, what = "frame") {
      const hit = frames.find((f) => !f.__taken && pred(f))
      if (hit) { hit.__taken = true; return Promise.resolve(hit) }
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1)
          reject(new Error(`timeout waiting for ${what}; got: ${frames.map((f) => f.type).join(",")}`))
        }, ms) }
        waiters.push(w)
      })
    },
    type(type, extra = () => true, ms) { return api.wait((f) => f.type === type && extra(f), ms, type) },
    close() { ws.terminate() },
  }
  return api
}
async function relayRoom(relay, roomId, openEvent) {
  const c = wsClient(relay.localPort)
  await c.opened
  c.send({ type: "auth", role: "local", token: LOCAL_TOKEN })
  await c.type("auth_result")
  c.send({ type: "room_register", room: { id: roomId, label: roomId, cwd: "/tmp", epoch: 1, instance: "inst-" + roomId } })
  await c.type("room_registered")
  const v = wsClient(relay.viewerPort)
  await v.opened
  v.send({ type: "auth", role: "viewer", token: VIEWER_TOKEN, caps: FULL_CAPS })
  const auth = await v.type("auth_result")
  assert.equal(auth.ok, true)
  v.send({ type: "subscribe", room: roomId })
  await v.type("snapshot")
  c.send({ type: "event", room: roomId, event: openEvent })
  await v.wait((f) => f.type === "room_event" && f.event && f.event.type === "dialog_open" && f.event.dialogId === openEvent.dialogId, 3000, "dialog_open live")
  return { c, v }
}
const sealedOpen = (dialogId) => ({
  type: "dialog_open", dialogId, kind: "input", startedAt: 4242, timeout: 120000,
  answerable: true, textEnc: TEXT_ENC, titleEnc: TITLE_ENC,
})
const plainOpen = (dialogId) => ({
  type: "dialog_open", dialogId, kind: "input", startedAt: 4242, timeout: 120000,
  answerable: true, title: "Plain question", placeholder: "type here",
})
const noAnswerForwarded = async (c, ms = 250) => {
  const before = c.frames.filter((f) => f.type === "dialog_answer").length
  await new Promise((r) => setTimeout(r, ms))
  return c.frames.filter((f) => f.type === "dialog_answer").length === before
}

test("relay 3.4: sealed slot rejects plaintext answers and malformed/oversized envelopes, forwards well-formed ones", async (t) => {
  const relay = await bootRelay()
  t.after(() => relay.close())
  const { c, v } = await relayRoom(relay, "room-s2-r1", sealedOpen("dlg-r1"))
  t.after(() => { c.close(); v.close() })

  // Plaintext value to a sealed slot: bad_args, nothing forwarded.
  v.send({ type: "dialog_answer", id: "q1", room: "room-s2-r1", dialogId: "dlg-r1", action: "submit", value: "plain leak" })
  const e1 = await v.wait((f) => f.type === "error" && f.id === "q1", 3000, "bad_args for plaintext answer")
  assert.equal(e1.code, "bad_args")
  assert.equal(await noAnswerForwarded(c), true)

  // Malformed envelope (enc !== 1): bad_args.
  v.send({ type: "dialog_answer", id: "q2", room: "room-s2-r1", dialogId: "dlg-r1", action: "submit", valueEnc: { enc: 2, ct: "zz" } })
  const e2 = await v.wait((f) => f.type === "error" && f.id === "q2", 3000, "bad_args for malformed envelope")
  assert.equal(e2.code, "bad_args")
  assert.equal(await noAnswerForwarded(c), true)

  // Oversized ct (> dialogTextEncMax): bad_args.
  v.send({ type: "dialog_answer", id: "q3", room: "room-s2-r1", dialogId: "dlg-r1", action: "submit", valueEnc: { enc: 1, ct: "x".repeat(12289) } })
  const e3 = await v.wait((f) => f.type === "error" && f.id === "q3", 3000, "bad_args for oversized ct")
  assert.equal(e3.code, "bad_args")
  assert.equal(await noAnswerForwarded(c), true)

  // Well-formed sealed answer: forwarded verbatim, no plaintext field added.
  v.send({ type: "dialog_answer", id: "q4", room: "room-s2-r1", dialogId: "dlg-r1", action: "submit", valueEnc: { enc: 1, ct: "S2-ANSWER-CT" } })
  const fwd = await c.wait((f) => f.type === "dialog_answer", 3000, "forwarded sealed answer")
  assert.deepEqual(fwd.valueEnc, { enc: 1, ct: "S2-ANSWER-CT" })
  assert.ok(!("value" in fwd))
  c.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-r1", ok: true })
  await v.wait((f) => f.id === "q4" && f.type !== "error", 3000, "answer ack")
})

test("relay 3.4: sealed deny carries noteEnc verbatim; plaintext note to a sealed slot is bad_args", async (t) => {
  const relay = await bootRelay()
  t.after(() => relay.close())
  const { c, v } = await relayRoom(relay, "room-s2-r2", sealedOpen("dlg-r2"))
  t.after(() => { c.close(); v.close() })

  v.send({ type: "dialog_answer", id: "q1", room: "room-s2-r2", dialogId: "dlg-r2", action: "deny", note: "plain reason" })
  const e1 = await v.wait((f) => f.type === "error" && f.id === "q1", 3000, "bad_args for plaintext note")
  assert.equal(e1.code, "bad_args")
  assert.equal(await noAnswerForwarded(c), true)

  v.send({ type: "dialog_answer", id: "q2", room: "room-s2-r2", dialogId: "dlg-r2", action: "deny", noteEnc: "S2-NOTE-CT" })
  const fwd = await c.wait((f) => f.type === "dialog_answer", 3000, "forwarded sealed deny")
  assert.equal(fwd.noteEnc, "S2-NOTE-CT")
  assert.ok(!("note" in fwd))
  c.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-r2", ok: true })
  await v.wait((f) => f.id === "q2" && f.type !== "error", 3000, "deny ack")
})

test("relay 3.4: plaintext slot rejects *Enc answers; plaintext value is clamped to dialogTextMax on forward (7.3)", async (t) => {
  const relay = await bootRelay()
  t.after(() => relay.close())
  const { c, v } = await relayRoom(relay, "room-s2-r3", plainOpen("dlg-r3"))
  t.after(() => { c.close(); v.close() })

  v.send({ type: "dialog_answer", id: "q1", room: "room-s2-r3", dialogId: "dlg-r3", action: "submit", valueEnc: { enc: 1, ct: "S2-X" } })
  const e1 = await v.wait((f) => f.type === "error" && f.id === "q1", 3000, "bad_args for sealed answer to plaintext slot")
  assert.equal(e1.code, "bad_args")
  assert.equal(await noAnswerForwarded(c), true)

  const long = "v".repeat(2000)
  v.send({ type: "dialog_answer", id: "q2", room: "room-s2-r3", dialogId: "dlg-r3", action: "submit", value: long })
  const fwd = await c.wait((f) => f.type === "dialog_answer", 3000, "forwarded clamped answer")
  assert.equal(fwd.value.length, 500, "value clamps to dialogTextMax like the other answer fields")
  c.send({ type: "dialog_answer_result", aid: fwd.aid, dialogId: "dlg-r3", ok: true })
  await v.wait((f) => f.id === "q2" && f.type !== "error", 3000, "answer ack")
})
