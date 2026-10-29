/**
 * Content decryption for crypto Phase 3 (design 4.1, tier b): the viewer
 * side of the shared envelope. Pure WebCrypto, no React; the subtle handle
 * is injectable so node --test can drive it with the platform WebCrypto
 * and cross-check it against a node:crypto counterpart.
 *
 * Pinned constructions (shared with the extension and the relay store):
 *   envelope = { enc: 1, role?, h?, ct }
 *   ct       = base64( nonce(12) || AES-256-GCM(key, plaintext) || tag(16) )
 * Message envelopes are keyed by the per-room RCK. The RCK itself travels
 * as rckWrap = base64( nonce(12) || AES-256-GCM(ACK, RCK) || tag(16) ),
 * delivered in the snapshot frame's keyInfo. Session firstMessage
 * previews and sessionArchive payloads use the same ct construction keyed
 * by the ACK directly, with UTF-8 text as the plaintext.
 *
 * Raw key bytes never leave this module's unwrap call: the ACK arrives as
 * a non-extractable CryptoKey (viewerIdentity.ackCryptoKey) and RCKs are
 * imported non-extractable and held in memory only.
 */
import { base64ToBytes } from "./viewerIdentity.ts"
import type { AgentMessage, AssistantEvent } from "./transcript.ts"

export interface ContentEnvelope {
  enc: 1
  ct: string
  role?: string
  h?: string
  [key: string]: unknown
}

/** A value is a content envelope when it carries enc:1 and a string ct. */
export function isContentEnvelope(value: unknown): value is ContentEnvelope {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { enc?: unknown }).enc === 1 &&
    typeof (value as { ct?: unknown }).ct === "string"
  )
}

/**
 * Defensive form: some producers put the envelope JSON itself into a text
 * field (delta / content) instead of a dedicated ct field. Only strings
 * that parse as a full envelope object qualify -- ordinary text that
 * merely starts with "{" is not an envelope.
 */
export function envelopeFromTextField(value: unknown): ContentEnvelope | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isContentEnvelope(parsed) ? parsed : null
  } catch {
    return null
  }
}

const GCM_NONCE_BYTES = 12
const GCM_TAG_BYTES = 16
/** Room content keys are 32-byte AES-256 keys (design 2.2). */
export const ROOM_KEY_BYTES = 32

function defaultSubtle(subtle?: SubtleCrypto): SubtleCrypto {
  return subtle ?? globalThis.crypto.subtle
}

function splitSealed(ctB64: string): { iv: Uint8Array; data: Uint8Array } | null {
  const bytes = base64ToBytes(ctB64)
  if (!bytes || bytes.length <= GCM_NONCE_BYTES + GCM_TAG_BYTES) return null
  return { iv: bytes.subarray(0, GCM_NONCE_BYTES), data: bytes.subarray(GCM_NONCE_BYTES) }
}

/** AES-GCM open of one sealed blob under key; null on any failure (never throws). */
export async function openSealed(key: CryptoKey, ctB64: string, subtle?: SubtleCrypto): Promise<Uint8Array | null> {
  const sealed = splitSealed(ctB64)
  if (!sealed) return null
  try {
    const plain = await defaultSubtle(subtle).decrypt(
      { name: "AES-GCM", iv: sealed.iv as BufferSource },
      key,
      sealed.data as BufferSource,
    )
    return new Uint8Array(plain)
  } catch {
    return null
  }
}

/** Decrypt an envelope whose plaintext is a JSON object (a message). */
export async function decryptEnvelopeJson(
  key: CryptoKey,
  ctB64: string,
  subtle?: SubtleCrypto,
): Promise<Record<string, unknown> | null> {
  const plain = await openSealed(key, ctB64, subtle)
  if (!plain) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Decrypt a ct whose plaintext is UTF-8 text (streaming deltas, ACK-level text envelopes). */
export async function decryptCtText(key: CryptoKey, ctB64: string, subtle?: SubtleCrypto): Promise<string | null> {
  const plain = await openSealed(key, ctB64, subtle)
  return plain ? new TextDecoder().decode(plain) : null
}

/** A snapshot frame's keyInfo: the room's RCK wrap + the ACK fingerprint it belongs to. */
export interface SnapshotKeyInfo {
  ackFp: string
  rckWrap: string
}

/**
 * Extract the keyInfo a snapshot frame carries, or null when it carries
 * no usable one (missing, not an object, mistyped fields, empty wrap).
 * A pure function of the frame alone: it deliberately never consults
 * per-room state, so callers can -- and must -- run it before any
 * state-based shortcut (a room pre-flagged enc by a roster has no keyInfo
 * yet, but its snapshots are exactly where the keyInfo arrives).
 */
export function snapshotKeyInfoOf(frame: unknown): SnapshotKeyInfo | null {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null
  const keyInfo = (frame as { keyInfo?: unknown }).keyInfo
  if (!keyInfo || typeof keyInfo !== "object" || Array.isArray(keyInfo)) return null
  const { ackFp, rckWrap } = keyInfo as { ackFp?: unknown; rckWrap?: unknown }
  if (typeof ackFp !== "string" || typeof rckWrap !== "string" || !rckWrap) return null
  return { ackFp, rckWrap }
}

/**
 * Unwrap a room key: rckWrap is the raw RCK sealed under the account ACK.
 * The result is a non-extractable, decrypt-only CryptoKey.
 */
export async function unwrapRoomKey(ackKey: CryptoKey, rckWrapB64: string, subtle?: SubtleCrypto): Promise<CryptoKey | null> {
  const raw = await openSealed(ackKey, rckWrapB64, subtle)
  if (!raw || raw.length !== ROOM_KEY_BYTES) return null
  try {
    return await defaultSubtle(subtle).importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["decrypt"])
  } catch {
    return null
  }
}

/**
 * In-memory RCK cache keyed by (room, ackFp, rckWrap): a re-wrapped room
 * (new rckWrap under the same or a rotated ACK) unwraps afresh, an
 * unchanged wrap is never opened twice. Failed unwraps are cached too --
 * retrying a bad wrap cannot succeed and would only spam the failure
 * path; a different wrap or ACK fingerprint is a different cache key.
 */
export class RoomKeyCache {
  private readonly entries = new Map<string, Promise<CryptoKey | null>>()

  roomKey(roomId: string, ackFp: string, rckWrap: string, ackKey: CryptoKey, subtle?: SubtleCrypto): Promise<CryptoKey | null> {
    const cacheKey = `${roomId}\n${ackFp}\n${rckWrap}`
    let pending = this.entries.get(cacheKey)
    if (!pending) {
      pending = unwrapRoomKey(ackKey, rckWrap, subtle)
      this.entries.set(cacheKey, pending)
    }
    return pending
  }

  clear(): void {
    this.entries.clear()
  }
}

/** Placeholder copy for an entry that cannot be decrypted (design 4.1). */
export const UNDECRYPTABLE_LABEL = "无法解密"
export const UNDECRYPTABLE_TEXT = "这条消息无法解密（内容钥不匹配或密文损坏）"

/**
 * The message a failed envelope degrades to. user/assistant keep their
 * role so live-bubble replacement and grouping behave as with a real
 * message; every other role becomes a custom note in the same slot. The
 * entry is never dropped and the room never blanks (design 4.1).
 */
export function undecryptableMessage(role?: string): AgentMessage {
  if (role === "assistant") return { role: "assistant", content: [{ type: "text", text: UNDECRYPTABLE_TEXT }] }
  if (role === "user") return { role: "user", content: UNDECRYPTABLE_TEXT }
  return { role: "custom", customType: UNDECRYPTABLE_LABEL, content: UNDECRYPTABLE_TEXT }
}

export interface DecryptBatchResult {
  messages: AgentMessage[]
  failures: number
}

/**
 * Decrypt one snapshot entry under the room key; null when the entry
 * cannot be read. Message envelopes seal a JSON message object, but a
 * remote-echo envelope seals the bare prompt text instead (design 4.1:
 * the bridge seals the echo text itself so viewers can match it by h
 * against the real message when it lands). An echo therefore opens to
 * non-JSON text under role "user": rebuild the same user message the
 * plaintext snapshot carries for an echo (relay/store remoteJson,
 * marker fields preserved) rather than counting it as a failure. A ct
 * that does not open at all -- and non-JSON text under any other
 * role -- still returns null. The blob is opened exactly once either
 * way; decryptEnvelopeJson keeps its strict JSON-only contract for its
 * other callers (room events, tool payloads).
 */
async function decryptSnapshotEntry(
  key: CryptoKey,
  item: ContentEnvelope,
  subtle?: SubtleCrypto,
): Promise<Record<string, unknown> | null> {
  const plain = await openSealed(key, item.ct, subtle)
  if (!plain) return null
  const text = new TextDecoder().decode(plain)
  let parsed: unknown = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  if (item.role !== "user") return null
  // Remote-echo form: the sealed plaintext is the prompt itself, verbatim
  // (even when it happens to parse as a JSON scalar, the raw text is the
  // prompt). Mirror the plaintext echo record's shape and markers.
  const message: Record<string, unknown> = { role: "user", content: [{ type: "text", text }] }
  if (item.remote === true) message.remote = true
  if (typeof item.timestamp === "number" && Number.isFinite(item.timestamp)) message.timestamp = item.timestamp
  if (typeof item.cid === "string" && item.cid) message.cid = item.cid
  return message
}

/**
 * Map a snapshot/append message list for an enc room: envelope elements
 * decrypt under the room key, non-envelope elements pass through
 * untouched (plaintext and enc generations coexist during migration),
 * failed envelopes become in-place placeholders and are counted. A null
 * key (no ACK held / fingerprint mismatch) fails every envelope the
 * same way -- callers surface that as a room state, not per-item noise.
 */
export async function decryptSnapshotMessages(
  key: CryptoKey | null,
  messages: readonly unknown[],
  subtle?: SubtleCrypto,
): Promise<DecryptBatchResult> {
  const out: AgentMessage[] = []
  let failures = 0
  for (const item of messages) {
    if (!isContentEnvelope(item)) {
      out.push(item as AgentMessage)
      continue
    }
    const message = key ? await decryptSnapshotEntry(key, item, subtle) : null
    if (message) out.push(message as AgentMessage)
    else {
      failures += 1
      out.push(undecryptableMessage(item.role))
    }
  }
  return { messages: out, failures }
}

/**
 * Decrypt the sealed text of one streaming assistant event (message_update
 * payload). Returns the event with plaintext restored, or null when a
 * sealed field cannot be opened: a delta that cannot be decrypted must
 * not reach the live bubble (the authoritative message_end envelope
 * settles the message instead). Events without sealed fields pass
 * through by reference, so plaintext streaming is untouched.
 */
export async function decryptAssistantEvent(
  key: CryptoKey,
  event: AssistantEvent & Record<string, unknown>,
  subtle?: SubtleCrypto,
): Promise<(AssistantEvent & Record<string, unknown>) | null> {
  let out: (AssistantEvent & Record<string, unknown>) | null = null
  const editable = (): AssistantEvent & Record<string, unknown> => {
    if (!out) out = { ...event }
    return out
  }
  const ctField = typeof event.ct === "string" ? event.ct : null
  if (ctField !== null) {
    const text = await decryptCtText(key, ctField, subtle)
    if (text === null) return null
    const target = editable()
    delete target.ct
    if (event.type === "toolcall_end") {
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed && typeof parsed === "object") target.toolCall = parsed as AssistantEvent["toolCall"]
      } catch {
        return null
      }
    } else if (event.type === "text_end" || event.type === "thinking_end") {
      target.content = text
    } else {
      target.delta = text
    }
  }
  const deltaEnvelope = envelopeFromTextField(event.delta)
  if (deltaEnvelope) {
    const text = await decryptCtText(key, deltaEnvelope.ct, subtle)
    if (text === null) return null
    editable().delta = text
  }
  const contentEnvelope = envelopeFromTextField(event.content)
  if (contentEnvelope) {
    const text = await decryptCtText(key, contentEnvelope.ct, subtle)
    if (text === null) return null
    editable().content = text
  }
  return out ?? event
}

export interface RoomEventDecryptResult {
  /** The event with plaintext restored; envelope slots that failed hold placeholders. */
  event: Record<string, unknown>
  /** Sealed fields that failed to open (message/delta/tool payloads). */
  failures: number
  /** True when the whole event must be dropped (an undecryptable streaming delta). */
  drop: boolean
}

/**
 * Decrypt one room_event payload for an enc room before it reaches the
 * transcript reducer: message_start / message_end envelopes become real
 * messages (or in-place placeholders), streaming deltas are decrypted,
 * remote_message text envelopes become text, and tool_execution payloads
 * (args / result / partialResult) decrypt when they arrive as envelopes.
 * Fields that are not envelopes pass through untouched.
 */
export async function decryptRoomEvent(
  key: CryptoKey | null,
  event: Record<string, unknown>,
  subtle?: SubtleCrypto,
): Promise<RoomEventDecryptResult> {
  let out: Record<string, unknown> | null = null
  const editable = (): Record<string, unknown> => {
    if (!out) out = { ...event }
    return out
  }
  let failures = 0

  const message = event.message
  if (isContentEnvelope(message)) {
    const plain = key ? await decryptEnvelopeJson(key, message.ct, subtle) : null
    if (plain) editable().message = plain
    else {
      failures += 1
      editable().message = undecryptableMessage(message.role)
    }
  }

  const assistantEvent = event.assistantMessageEvent
  if (assistantEvent && typeof assistantEvent === "object" && !Array.isArray(assistantEvent)) {
    const inner = assistantEvent as AssistantEvent & Record<string, unknown>
    const sealed =
      typeof inner.ct === "string" || envelopeFromTextField(inner.delta) !== null || envelopeFromTextField(inner.content) !== null
    if (sealed) {
      const plain = key ? await decryptAssistantEvent(key, inner, subtle) : null
      if (plain) editable().assistantMessageEvent = plain
      else {
        failures += 1
        return { event: out ?? event, failures, drop: true }
      }
    }
  }

  const text = event.text
  if (isContentEnvelope(text)) {
    const plain = key ? await decryptCtText(key, text.ct, subtle) : null
    if (plain !== null) editable().text = plain
    else {
      failures += 1
      editable().text = UNDECRYPTABLE_TEXT
    }
  }

  for (const field of ["args", "result", "partialResult"] as const) {
    const value = event[field]
    if (!isContentEnvelope(value)) continue
    const plain = key ? await decryptEnvelopeJson(key, value.ct, subtle) : null
    if (plain) editable()[field] = plain
    else {
      failures += 1
      editable()[field] = undefined
    }
  }

  return { event: out ?? event, failures, drop: false }
}
