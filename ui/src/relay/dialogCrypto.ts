/**
 * Dialog text encryption (crypto.dialog, (b+)) on the viewer side: the
 * resolve step for dialog-family room events and the answer frame
 * builder. Pure logic over WebCrypto primitives from contentDecrypt.ts;
 * useRelay wires it into the per-room decrypt chain (the same chain body
 * content takes), so a dialog event reaches the synchronous reducers
 * already resolved -- opened, or honestly degraded, never ciphertext.
 *
 * Wire forms (protocol/v4.json, crypto.dialog cap; do not improvise):
 *   dialog_open.textEnc   {enc:1, ct} under the room RCK -- one packed
 *                         JSON of title/options/message/placeholder/prefill
 *   dialog_open.titleEnc  {enc:1, ct} under the ACK (cross-room surfaces)
 *   ui_prompt_*.titleEnc  {enc:1, ct} under the ACK
 *   ext_notify.messageEnc {enc:1, ct} under the room RCK
 *   dialog_close.noteEnc  bare ct string under the room RCK
 *   dialog_answer valueEnc / valuesEnc / noteEnc: bare ct strings under
 *                         the room RCK (valuesEnc seals a JSON array)
 *   waiting / inbox titleEnc: bare ct string under the ACK (useRelay
 *                         opens those through its preview-title pass)
 */
import { decryptCtText, decryptEnvelopeJson, isContentEnvelope, sealCtText } from "./contentDecrypt.ts"
import type { DialogAnswer } from "../chat/composer/promptModel.ts"

/** Why a sealed dialog cannot be read on this end: the content key has
 *  not arrived / is not held yet ("waiting"), or it will never open with
 *  the keys held here ("failed" -- mismatch or corrupt). The card copy
 *  differs because the remedies differ. */
export type DialogBlockedReason = "waiting" | "failed"

/** Fixed notice copy for an ext_notify whose messageEnc cannot be opened
 *  (design 3.6): the notification still surfaces, the ciphertext never
 *  does, and nothing is silently swallowed. */
export const EXT_NOTIFY_SEALED_TEXT = "扩展通知（已加密，缺内容钥）"

const DIALOG_TEXT_FIELDS = ["title", "options", "message", "placeholder", "prefill"] as const

/**
 * Frame-gate detection (companion to the body-envelope check in
 * useRelay): does this room event carry any (b+) sealed field? A room
 * not yet flagged enc must still route such events through the decrypt
 * chain instead of the synchronous plaintext path.
 */
export function dialogEventHasSealedFields(event: Record<string, unknown>): boolean {
  if (isContentEnvelope(event.textEnc) || isContentEnvelope(event.titleEnc) || isContentEnvelope(event.messageEnc)) return true
  // A textEnc present in any shape marks a sealed dialog: even a
  // malformed one must degrade in the chain, never reach the reducers as
  // an empty answerable shell.
  if (event.type === "dialog_open" && event.textEnc !== undefined && event.textEnc !== null) return true
  // dialog_close carries noteEnc as a bare ct string, not an envelope.
  if (event.type === "dialog_close" && typeof event.noteEnc === "string" && !!event.noteEnc) return true
  return false
}

export interface DialogEventKeys {
  /** The room RCK (null when unresolvable: no ACK, mismatch, no keyInfo). */
  roomKey: CryptoKey | null
  /** The account ACK as a CryptoKey (null when none is held). */
  ackKey: CryptoKey | null
  /** Degradation flavour for an unopenable card, from the room status. */
  blockedReason: DialogBlockedReason
}

export interface DialogResolveResult {
  /** The event to hand to the reducers (same reference when untouched). */
  event: Record<string, unknown>
  /** Sealed fields that could not be opened (diagnostics counter). */
  failures: number
}

/**
 * Resolve one dialog-family event ahead of the reducers:
 *  - dialog_open with textEnc: open the pack under the room key and
 *    refill the five text fields (the card then renders exactly like a
 *    plaintext card, plus the `sealed` marker its answers must follow).
 *    Unopenable (or malformed): a text-less read-only card marked
 *    `sealedBlocked`, answerable stripped. Plaintext fields riding along
 *    on a sealed frame are deleted either way -- the relay applies the
 *    same presence rule, and a sealed frame's plaintext is never data.
 *  - dialog_close with noteEnc: open the deny reason into `note` (the
 *    receipt path reads it from there); unopenable drops the reason, the
 *    receipt still lands without it.
 *  - ui_prompt_start/end with titleEnc: open under the ACK into `title`;
 *    unopenable leaves the signal title-less.
 *  - ext_notify with messageEnc: open under the room key into `message`;
 *    unopenable substitutes the fixed sealed-notice copy.
 *  Anything else passes through by reference (plaintext regression line).
 */
export async function resolveDialogEvent(
  keys: DialogEventKeys,
  event: Record<string, unknown>,
  subtle?: SubtleCrypto,
): Promise<DialogResolveResult> {
  const type = event.type
  if (type === "dialog_open") {
    if (event.textEnc === undefined || event.textEnc === null) return { event, failures: 0 }
    const out: Record<string, unknown> = { ...event }
    delete out.textEnc
    delete out.titleEnc
    for (const field of DIALOG_TEXT_FIELDS) delete out[field]
    out.sealed = true
    const pack =
      keys.roomKey && isContentEnvelope(event.textEnc) ? await decryptEnvelopeJson(keys.roomKey, event.textEnc.ct, subtle) : null
    if (!pack) {
      out.sealedBlocked = keys.blockedReason
      delete out.answerable
      return { event: out, failures: 1 }
    }
    if (typeof pack.title === "string") out.title = pack.title
    if (Array.isArray(pack.options)) out.options = pack.options
    if (typeof pack.message === "string") out.message = pack.message
    if (typeof pack.placeholder === "string") out.placeholder = pack.placeholder
    if (typeof pack.prefill === "string") out.prefill = pack.prefill
    return { event: out, failures: 0 }
  }
  if (type === "dialog_close") {
    if (typeof event.noteEnc !== "string" || !event.noteEnc) return { event, failures: 0 }
    const out: Record<string, unknown> = { ...event }
    delete out.noteEnc
    delete out.note
    const text = keys.roomKey ? await decryptCtText(keys.roomKey, event.noteEnc, subtle) : null
    if (text === null) return { event: out, failures: 1 }
    out.note = text
    return { event: out, failures: 0 }
  }
  if (type === "ui_prompt_start" || type === "ui_prompt_end") {
    if (!isContentEnvelope(event.titleEnc)) return { event, failures: 0 }
    const out: Record<string, unknown> = { ...event }
    delete out.titleEnc
    delete out.title
    const text = keys.ackKey ? await decryptCtText(keys.ackKey, event.titleEnc.ct, subtle) : null
    if (text === null) return { event: out, failures: 1 }
    out.title = text
    return { event: out, failures: 0 }
  }
  if (type === "ext_notify") {
    if (!isContentEnvelope(event.messageEnc)) return { event, failures: 0 }
    const out: Record<string, unknown> = { ...event }
    delete out.messageEnc
    const text = keys.roomKey ? await decryptCtText(keys.roomKey, event.messageEnc.ct, subtle) : null
    out.message = text ?? EXT_NOTIFY_SEALED_TEXT
    return { event: out, failures: text === null ? 1 : 0 }
  }
  return { event, failures: 0 }
}

/**
 * Build one dialog_answer frame. Unsealed dialogs reproduce today's
 * plaintext frame field-for-field. Sealed dialogs seal each text field
 * under the room key into the bare-ct *Enc fields (values as a JSON
 * array string) and carry no plaintext text at all; an action-only
 * answer (allow / deny without a note) has nothing to seal and passes
 * as-is. Returns null when sealing was required but impossible (no key,
 * or a seal failed) -- the caller must fail the answer honestly rather
 * than fall back to plaintext, which the relay would reject anyway.
 */
export async function dialogAnswerFrame(input: {
  room: string
  dialogId: string
  answer: DialogAnswer
  sealed: boolean
  sealKey: CryptoKey | null
  subtle?: SubtleCrypto
}): Promise<Record<string, unknown> | null> {
  const { room, dialogId, answer } = input
  const frame: Record<string, unknown> = { type: "dialog_answer", room, dialogId, action: answer.action }
  if (!input.sealed) {
    if (typeof answer.value === "string") frame.value = answer.value
    if (Array.isArray(answer.values)) frame.values = answer.values
    if (answer.action === "deny" && answer.note) frame.note = answer.note
    return frame
  }
  const key = input.sealKey
  if (typeof answer.value === "string") {
    if (!key) return null
    const ct = await sealCtText(key, answer.value, input.subtle)
    if (!ct) return null
    frame.valueEnc = ct
  }
  if (Array.isArray(answer.values)) {
    if (!key) return null
    const ct = await sealCtText(key, JSON.stringify(answer.values), input.subtle)
    if (!ct) return null
    frame.valuesEnc = ct
  }
  if (answer.action === "deny" && answer.note) {
    if (!key) return null
    const ct = await sealCtText(key, answer.note, input.subtle)
    if (!ct) return null
    frame.noteEnc = ct
  }
  return frame
}
