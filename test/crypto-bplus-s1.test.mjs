// Dialog text encryption (crypto.dialog, (b+) slice S-1, web side): the
// viewer declares the cap on the key-auth frame only; the dialog resolve
// step opens textEnc packs / ACK titles / messageEnc / noteEnc ahead of
// the reducers or degrades the card honestly (sealedBlocked, no text, no
// answer surface, no ciphertext anywhere); answers to sealed dialogs are
// sealed under the room RCK as BARE ct strings (valueEnc / valuesEnc /
// noteEnc), and unsealed answers stay byte-identical plaintext frames.
import test from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { decryptCtText, sealCtText, unwrapRoomKey } from "../ui/src/relay/contentDecrypt.ts"
import {
  EXT_NOTIFY_SEALED_TEXT,
  dialogAnswerFrame,
  dialogEventHasSealedFields,
  resolveDialogEvent,
} from "../ui/src/relay/dialogCrypto.ts"
import { authFrame, viewerAuthFrame } from "../ui/src/relay/protocol.ts"
import { dialogReceiptOf, dialogsAfterEvent } from "../ui/src/chat/composer/promptModel.ts"
import { dialogSealedBlockedText } from "../ui/src/pi/model/dialogCard.ts"
import { parseRooms } from "../ui/src/relay/devices.ts"
import { applyInboxUpdate, parseInboxEntries } from "../ui/src/relay/inbox.ts"

const subtle = globalThis.crypto.subtle

/* ---- Node-crypto counterpart of the pinned constructions ---- */

function nodeSeal(keyRaw, plaintext) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", keyRaw, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64")
}

function nodeOpen(keyRaw, b64) {
  const raw = Buffer.from(b64, "base64")
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyRaw, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(raw.length - 16))
  return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()])
}

async function webKey(raw, usages = ["decrypt", "encrypt"]) {
  return subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, usages)
}

const ACK = crypto.randomBytes(32)
const RCK = crypto.randomBytes(32)
const WRONG = crypto.randomBytes(32)

const sealPack = (pack) => ({ enc: 1, ct: nodeSeal(RCK, Buffer.from(JSON.stringify(pack), "utf8")) })
const sealAckText = (text) => ({ enc: 1, ct: nodeSeal(ACK, Buffer.from(text, "utf8")) })

/* ---- 1. capability declaration ---- */

test("cap: the key-auth viewer frame declares crypto.dialog; the token frame does not", () => {
  const keyed = viewerAuthFrame({ viewerId: "v-1", keyFp: "fp", clientNonce: "nonce" })
  assert.ok(keyed.caps.includes("crypto.dialog"))
  assert.ok(keyed.caps.includes("crypto.content"))
  assert.ok(keyed.caps.includes("crypto.auth"))
  const token = authFrame("some-token")
  assert.ok(!token.caps.includes("crypto.dialog"))
  assert.ok(!token.caps.includes("crypto.content"))
})

/* ---- 2. seal primitive (answer side) ---- */

test("sealCtText: bare ct string, opens under the node counterpart; decryptCtText opens node-sealed text", async () => {
  const key = await webKey(RCK)
  const ct = await sealCtText(key, "答案：删除它")
  assert.equal(typeof ct, "string", "the wire form is a bare ct string, not an envelope object")
  assert.equal(nodeOpen(RCK, ct).toString("utf8"), "答案：删除它")
  assert.equal(await decryptCtText(key, nodeSeal(RCK, Buffer.from("桥侧密文", "utf8"))), "桥侧密文")
  assert.equal(await decryptCtText(await webKey(WRONG, ["decrypt"]), ct), null)
})

test("unwrapRoomKey: the unwrapped RCK can also seal (dialog answers are viewer-sealed)", async () => {
  const ackKey = await webKey(ACK, ["decrypt"])
  const rck = await unwrapRoomKey(ackKey, nodeSeal(ACK, RCK))
  assert.ok(rck)
  const ct = await sealCtText(rck, "sealed under the unwrapped room key")
  assert.ok(ct)
  assert.equal(nodeOpen(RCK, ct).toString("utf8"), "sealed under the unwrapped room key")
})

/* ---- 3. dialog_open resolve ---- */

const PACK = { title: "允许执行 rm -rf build？", options: [], message: "rm -rf build", placeholder: "", prefill: "" }

test("resolve: dialog_open textEnc opens under the RCK and refills the five text fields", async () => {
  const event = {
    type: "dialog_open",
    dialogId: "d1",
    kind: "confirm",
    answerable: true,
    titleEnc: sealAckText(PACK.title),
    textEnc: sealPack(PACK),
  }
  const { event: out, failures } = await resolveDialogEvent(
    { roomKey: await webKey(RCK, ["decrypt"]), ackKey: null, blockedReason: "failed" },
    event,
  )
  assert.equal(failures, 0)
  assert.equal(out.title, PACK.title)
  assert.equal(out.message, PACK.message)
  assert.deepEqual(out.options, [])
  assert.equal(out.sealed, true)
  assert.equal(out.sealedBlocked, undefined)
  assert.equal(out.answerable, true, "an opened sealed card stays answerable")
  assert.equal(out.textEnc, undefined)
  assert.equal(out.titleEnc, undefined)
})

test("resolve: unopenable textEnc degrades to a text-less blocked card (waiting vs failed), riding plaintext stripped", async () => {
  const base = {
    type: "dialog_open",
    dialogId: "d2",
    kind: "select",
    answerable: true,
    title: "同帧明文绝不能被信任",
    options: ["假选项"],
    textEnc: sealPack({ title: "真标题", options: ["甲", "乙"] }),
  }
  const waiting = await resolveDialogEvent({ roomKey: null, ackKey: null, blockedReason: "waiting" }, base)
  assert.equal(waiting.failures, 1)
  assert.equal(waiting.event.sealed, true)
  assert.equal(waiting.event.sealedBlocked, "waiting")
  assert.equal(waiting.event.answerable, undefined)
  assert.equal(waiting.event.title, undefined)
  assert.equal(waiting.event.options, undefined)
  assert.ok(!JSON.stringify(waiting.event).includes(base.textEnc.ct), "no ciphertext reaches the card model")

  const failed = await resolveDialogEvent(
    { roomKey: await webKey(WRONG, ["decrypt"]), ackKey: null, blockedReason: "failed" },
    base,
  )
  assert.equal(failed.event.sealedBlocked, "failed")
  assert.equal(failed.event.answerable, undefined)

  const malformed = await resolveDialogEvent(
    { roomKey: await webKey(RCK, ["decrypt"]), ackKey: null, blockedReason: "failed" },
    { ...base, textEnc: "not-an-envelope" },
  )
  assert.equal(malformed.event.sealedBlocked, "failed")
})

test("resolve: a plaintext dialog_open passes through by reference (regression line)", async () => {
  const event = { type: "dialog_open", dialogId: "d3", kind: "input", title: "明文标题", answerable: true }
  const { event: out, failures } = await resolveDialogEvent({ roomKey: null, ackKey: null, blockedReason: "failed" }, event)
  assert.equal(out, event)
  assert.equal(failures, 0)
})

/* ---- 4. dialog_close noteEnc / ui_prompt titleEnc / ext_notify messageEnc ---- */

test("resolve: dialog_close noteEnc opens into note (riding plaintext note is dropped); failure keeps the receipt note-less", async () => {
  const key = await webKey(RCK, ["decrypt"])
  const opened = await resolveDialogEvent(
    { roomKey: key, ackKey: null, blockedReason: "failed" },
    { type: "dialog_close", dialogId: "d1", reason: "denied", note: "明文理由不可信", noteEnc: nodeSeal(RCK, Buffer.from("活儿太糙", "utf8")) },
  )
  assert.equal(opened.failures, 0)
  assert.equal(opened.event.note, "活儿太糙")
  assert.equal(opened.event.noteEnc, undefined)

  const failed = await resolveDialogEvent(
    { roomKey: await webKey(WRONG, ["decrypt"]), ackKey: null, blockedReason: "failed" },
    { type: "dialog_close", dialogId: "d1", reason: "denied", noteEnc: nodeSeal(RCK, Buffer.from("理由", "utf8")) },
  )
  assert.equal(failed.failures, 1)
  assert.equal(failed.event.note, undefined)
  assert.equal(failed.event.noteEnc, undefined)

  const plain = { type: "dialog_close", dialogId: "d1", reason: "answered" }
  const untouched = await resolveDialogEvent({ roomKey: key, ackKey: null, blockedReason: "failed" }, plain)
  assert.equal(untouched.event, plain)
})

test("resolve: ui_prompt titleEnc opens under the ACK (start and end); without an ACK the signal stays title-less", async () => {
  const ackKey = await webKey(ACK, ["decrypt"])
  for (const type of ["ui_prompt_start", "ui_prompt_end"]) {
    const { event: out, failures } = await resolveDialogEvent(
      { roomKey: null, ackKey, blockedReason: "failed" },
      { type, kind: "select", titleEnc: sealAckText("选择一个环境") },
    )
    assert.equal(failures, 0)
    assert.equal(out.title, "选择一个环境")
    assert.equal(out.titleEnc, undefined)
  }
  const noAck = await resolveDialogEvent(
    { roomKey: null, ackKey: null, blockedReason: "waiting" },
    { type: "ui_prompt_start", kind: "select", title: "同帧明文", titleEnc: sealAckText("真标题") },
  )
  assert.equal(noAck.failures, 1)
  assert.equal(noAck.event.title, undefined)
})

test("resolve: ext_notify messageEnc opens; unopenable substitutes the fixed sealed copy, never ciphertext", async () => {
  const opened = await resolveDialogEvent(
    { roomKey: await webKey(RCK, ["decrypt"]), ackKey: null, blockedReason: "failed" },
    { type: "ext_notify", level: "info", messageEnc: { enc: 1, ct: nodeSeal(RCK, Buffer.from("构建完成", "utf8")) } },
  )
  assert.equal(opened.failures, 0)
  assert.equal(opened.event.message, "构建完成")
  assert.equal(opened.event.level, "info")

  const blocked = await resolveDialogEvent(
    { roomKey: null, ackKey: null, blockedReason: "waiting" },
    { type: "ext_notify", level: "warn", messageEnc: { enc: 1, ct: nodeSeal(RCK, Buffer.from("构建完成", "utf8")) } },
  )
  assert.equal(blocked.failures, 1)
  assert.equal(blocked.event.message, EXT_NOTIFY_SEALED_TEXT)
  assert.equal(blocked.event.messageEnc, undefined)
})

test("gate: dialogEventHasSealedFields detects every sealed form and nothing plaintext", () => {
  assert.equal(dialogEventHasSealedFields({ type: "dialog_open", textEnc: sealPack(PACK) }), true)
  assert.equal(dialogEventHasSealedFields({ type: "dialog_open", textEnc: "malformed" }), true)
  assert.equal(dialogEventHasSealedFields({ type: "dialog_close", noteEnc: "Y3Q=" }), true)
  assert.equal(dialogEventHasSealedFields({ type: "ext_notify", messageEnc: { enc: 1, ct: "eA==" } }), true)
  assert.equal(dialogEventHasSealedFields({ type: "ui_prompt_start", titleEnc: { enc: 1, ct: "eA==" } }), true)
  assert.equal(dialogEventHasSealedFields({ type: "dialog_open", title: "明文" }), false)
  assert.equal(dialogEventHasSealedFields({ type: "dialog_close", reason: "answered" }), false)
})

/* ---- 5. card model ---- */

test("model: opened / blocked / raw sealed events normalize to the right card shapes", () => {
  const opened = dialogsAfterEvent([], { type: "dialog_open", dialogId: "a", kind: "confirm", sealed: true, title: "标题", answerable: true }, 100)
  assert.equal(opened[0].sealed, true)
  assert.equal(opened[0].title, "标题")
  assert.equal(opened[0].answerable, true)

  const blocked = dialogsAfterEvent([], { type: "dialog_open", dialogId: "b", kind: "confirm", sealed: true, sealedBlocked: "waiting" }, 100)
  assert.equal(blocked[0].sealedBlocked, "waiting")
  assert.equal(blocked[0].title, undefined)
  assert.equal(blocked[0].answerable, undefined)

  // A raw textEnc that somehow reaches the reducer degrades to "failed",
  // never to an empty answerable shell, and its riding plaintext is dropped.
  const raw = dialogsAfterEvent([], { type: "dialog_open", dialogId: "c", kind: "select", title: "不可信", textEnc: { enc: 1, ct: "AAAA" } }, 100)
  assert.equal(raw[0].sealedBlocked, "failed")
  assert.equal(raw[0].title, undefined)
  assert.equal(raw[0].answerable, undefined)
})

test("model: the denied receipt reads the decrypted note the transform placed on the close event", () => {
  const [card] = dialogsAfterEvent([], { type: "dialog_open", dialogId: "a", kind: "confirm", sealed: true, title: "删除文件？", answerable: true }, 100)
  const receipt = dialogReceiptOf({ type: "dialog_close", dialogId: "a", reason: "denied", note: "活儿太糙" }, card, 200)
  assert.equal(receipt.title, "删除文件？")
  assert.equal(receipt.note, "活儿太糙")
  assert.equal(dialogSealedBlockedText("waiting"), "已加密 · 等内容钥")
  assert.equal(dialogSealedBlockedText("failed"), "已加密 · 无法解密")
})

/* ---- 6. answer frames ---- */

test("answer: an unsealed dialog's frame is the plaintext frame, field for field", async () => {
  assert.deepEqual(
    await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "submit", value: "选项甲" }, sealed: false, sealKey: null }),
    { type: "dialog_answer", room: "r1", dialogId: "d1", action: "submit", value: "选项甲" },
  )
  assert.deepEqual(
    await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "deny", note: "理由" }, sealed: false, sealKey: null }),
    { type: "dialog_answer", room: "r1", dialogId: "d1", action: "deny", note: "理由" },
  )
  assert.deepEqual(
    await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "allow" }, sealed: false, sealKey: null }),
    { type: "dialog_answer", room: "r1", dialogId: "d1", action: "allow" },
  )
})

test("answer: a sealed dialog's text rides as bare ct strings under the RCK, no plaintext fields", async () => {
  const key = await webKey(RCK)
  const value = await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "submit", value: "自由文本" }, sealed: true, sealKey: key })
  assert.equal(typeof value.valueEnc, "string")
  assert.equal(value.value, undefined)
  assert.equal(nodeOpen(RCK, value.valueEnc).toString("utf8"), "自由文本")

  const values = await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "submit", values: ["甲", "乙"] }, sealed: true, sealKey: key })
  assert.equal(typeof values.valuesEnc, "string")
  assert.deepEqual(JSON.parse(nodeOpen(RCK, values.valuesEnc).toString("utf8")), ["甲", "乙"])
  assert.equal(values.values, undefined)

  const deny = await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "deny", note: "不想跑" }, sealed: true, sealKey: key })
  assert.equal(typeof deny.noteEnc, "string")
  assert.equal(nodeOpen(RCK, deny.noteEnc).toString("utf8"), "不想跑")
  assert.equal(deny.note, undefined)
})

test("answer: sealed + no key fails closed (null) for text answers; action-only answers need no key", async () => {
  assert.equal(
    await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "submit", value: "x" }, sealed: true, sealKey: null }),
    null,
  )
  assert.deepEqual(
    await dialogAnswerFrame({ room: "r1", dialogId: "d1", answer: { action: "allow" }, sealed: true, sealKey: null }),
    { type: "dialog_answer", room: "r1", dialogId: "d1", action: "allow" },
  )
})

/* ---- 7. summary surfaces: waiting / inbox titleEnc parsing ---- */

test("summaries: waiting + waitingPrompt carry titleEnc (capped); a titleEnc-only prompt still counts as waiting", () => {
  const ct = nodeSeal(ACK, Buffer.from("等你确认", "utf8"))
  const [room] = parseRooms([
    {
      id: "r1",
      deviceId: "dev1",
      online: true,
      waiting: [{ dialogId: "d1", kind: "confirm", startedAt: 7, titleEnc: ct }],
      waitingPrompt: { kind: "select", titleEnc: ct, at: 9 },
    },
  ])
  assert.equal(room.waiting[0].titleEnc, ct)
  assert.equal(room.waiting[0].title, undefined)
  assert.equal(room.waitingPrompt.titleEnc, ct)

  const [capped] = parseRooms([
    { id: "r2", deviceId: "dev1", online: true, waiting: [{ dialogId: "d2", kind: "input", startedAt: 1, titleEnc: "x".repeat(1500) }] },
  ])
  assert.equal(capped.waiting[0].titleEnc.length, 1024)
})

test("summaries: inbox entries carry titleEnc (capped) and a titleEnc-only change is an update", () => {
  const ct = nodeSeal(ACK, Buffer.from("标题", "utf8"))
  const base = parseInboxEntries([{ key: "dialog:d1", roomId: "r1", kind: "waiting", subkind: "dialog", at: 5 }])
  assert.equal(base[0].titleEnc, undefined)
  const withEnc = parseInboxEntries([{ key: "dialog:d1", roomId: "r1", kind: "waiting", subkind: "dialog", at: 5, titleEnc: ct }])
  assert.equal(withEnc[0].titleEnc, ct)
  const merged = applyInboxUpdate(base, withEnc, [])
  assert.notEqual(merged, base, "a titleEnc change must register as an update")
  assert.equal(merged[0].titleEnc, ct)
  const capped = parseInboxEntries([{ key: "dialog:d2", roomId: "r1", kind: "waiting", subkind: "dialog", at: 6, titleEnc: "y".repeat(1500) }])
  assert.equal(capped[0].titleEnc.length, 1024)
})
