/**
 * Passphrase backup package for the viewer identity (design A section 6.2, tier 3).
 *
 * The package wraps the account content key (ACK) with a passphrase-derived key
 * (PBKDF2-HMAC-SHA256 via WebCrypto, then AES-256-GCM). It is a plain JSON
 * object so it can be downloaded as a file or copied as text. Restoring means:
 * enable a fresh viewer identity, register it, then open the package here and
 * hand the ACK to the identity core.
 *
 * Hygiene rules for this module:
 * - The passphrase is only ever a function argument. It is never stored,
 *   logged, or persisted anywhere.
 * - The raw ACK exists only as caller-owned bytes; this module keeps no copy
 *   after a call returns and writes nothing to storage.
 * - The header carries the ACK fingerprint (first 16 hex chars of SHA-256 over
 *   the raw ACK, matching the protocol `contentKeyFpChars` reconciliation
 *   digest). A fingerprint is a public digest, not key material; it lets the
 *   UI show which content key a backup belongs to before asking for the
 *   passphrase, and lets import verify the unwrapped key afterwards.
 *
 * No React, no DOM, no storage: node --test loads this file directly.
 */

export const BACKUP_PACKAGE_APP = "pi-remote"
export const BACKUP_PACKAGE_KIND = "identity-backup"
export const BACKUP_PACKAGE_VERSION = 1

/** OWASP-recommended PBKDF2-HMAC-SHA256 iteration count at time of writing. */
export const BACKUP_PBKDF2_DEFAULT_ITERATIONS = 600_000
/** Sanity bounds applied when reading a package back in (refuse absurd KDF work factors). */
export const BACKUP_PBKDF2_MIN_ITERATIONS = 100_000
export const BACKUP_PBKDF2_MAX_ITERATIONS = 5_000_000
export const BACKUP_SALT_BYTES = 16
export const BACKUP_IV_BYTES = 12
/** Minimum passphrase length accepted when creating a package. */
export const BACKUP_PASSPHRASE_MIN_LENGTH = 8
/** ACK size in bytes (design A section 2.2: 32-byte random content key). */
export const ACK_BYTES = 32
/** Hex chars of the ACK fingerprint (protocol limit `contentKeyFpChars`). */
export const ACK_FINGERPRINT_CHARS = 16

export type IdentityBackupErrorCode =
  | "no_webcrypto"
  | "weak_passphrase"
  | "bad_ack"
  | "bad_format"
  | "unsupported_version"
  | "bad_params"
  | "open_failed"

export class IdentityBackupError extends Error {
  readonly code: IdentityBackupErrorCode
  constructor(code: IdentityBackupErrorCode, message: string) {
    super(message)
    this.name = "IdentityBackupError"
    this.code = code
  }
}

/** JSON-safe backup package; this exact object is what gets downloaded. */
export interface IdentityBackupPackage {
  app: typeof BACKUP_PACKAGE_APP
  kind: typeof BACKUP_PACKAGE_KIND
  v: typeof BACKUP_PACKAGE_VERSION
  createdAt: number
  /** ACK fingerprint (public reconciliation digest, never key material). */
  ackFp: string
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string }
  cipher: { name: "AES-GCM"; iv: string }
  /** Base64 AES-GCM ciphertext (tag appended) over the JSON payload. */
  ct: string
}

/** Public binding metadata sealed inside the encrypted payload. */
export interface IdentityBackupMeta {
  accountId?: string
  viewerId?: string
}

export interface OpenedIdentityBackup extends IdentityBackupMeta {
  ack: Uint8Array
  ackFp: string
}

interface BackupPayload extends IdentityBackupMeta {
  ack: string
  ackFp: string
}

/* ------------------------------------------------------------------ */
/* Small byte helpers (no Buffer: this file ships to the browser).     */
/* ------------------------------------------------------------------ */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function isBase64(text: unknown): text is string {
  return typeof text === "string" && text.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0
}

function subtleOf(override?: SubtleCrypto): SubtleCrypto {
  const subtle = override ?? (globalThis.crypto as Crypto | undefined)?.subtle
  if (!subtle) throw new IdentityBackupError("no_webcrypto", "WebCrypto is not available in this environment")
  return subtle
}

function randomBytes(length: number): Uint8Array {
  const c = globalThis.crypto as Crypto | undefined
  if (!c?.getRandomValues) throw new IdentityBackupError("no_webcrypto", "WebCrypto is not available in this environment")
  return c.getRandomValues(new Uint8Array(length))
}

/* ------------------------------------------------------------------ */
/* Fingerprint                                                         */
/* ------------------------------------------------------------------ */

/** ACK fingerprint: first `ACK_FINGERPRINT_CHARS` hex chars of SHA-256 over the raw ACK bytes. */
export async function ackFingerprintOf(ack: Uint8Array, subtleOverride?: SubtleCrypto): Promise<string> {
  const subtle = subtleOf(subtleOverride)
  const digest = await subtle.digest("SHA-256", ack as BufferSource)
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  return hex.slice(0, ACK_FINGERPRINT_CHARS)
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

export interface CreateIdentityBackupInput {
  ack: Uint8Array
  meta?: IdentityBackupMeta
  passphrase: string
  /** Defaults to BACKUP_PBKDF2_DEFAULT_ITERATIONS; recorded in the package either way. */
  iterations?: number
  /** Injectable clock for tests; defaults to Date.now(). */
  now?: number
  /** Injectable SubtleCrypto for tests; defaults to globalThis.crypto.subtle. */
  subtle?: SubtleCrypto
}

async function deriveWrapKey(subtle: SubtleCrypto, passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await subtle.importKey("raw", new TextEncoder().encode(passphrase) as BufferSource, "PBKDF2", false, [
    "deriveKey",
  ])
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/**
 * Wrap the ACK into a downloadable backup package. The passphrase is used for
 * this call only and is never retained. The caller's ACK buffer is copied into
 * the sealed payload; no reference to it is kept after return.
 */
export async function createIdentityBackup(input: CreateIdentityBackupInput): Promise<IdentityBackupPackage> {
  const subtle = subtleOf(input.subtle)
  if (typeof input.passphrase !== "string" || input.passphrase.length < BACKUP_PASSPHRASE_MIN_LENGTH) {
    throw new IdentityBackupError("weak_passphrase", `Passphrase must be at least ${BACKUP_PASSPHRASE_MIN_LENGTH} characters`)
  }
  if (!(input.ack instanceof Uint8Array) || input.ack.length !== ACK_BYTES) {
    throw new IdentityBackupError("bad_ack", `ACK must be ${ACK_BYTES} bytes`)
  }
  const iterations = input.iterations ?? BACKUP_PBKDF2_DEFAULT_ITERATIONS
  if (!Number.isInteger(iterations) || iterations < BACKUP_PBKDF2_MIN_ITERATIONS || iterations > BACKUP_PBKDF2_MAX_ITERATIONS) {
    throw new IdentityBackupError(
      "bad_params",
      `PBKDF2 iterations must be between ${BACKUP_PBKDF2_MIN_ITERATIONS} and ${BACKUP_PBKDF2_MAX_ITERATIONS}`,
    )
  }
  const ackFp = await ackFingerprintOf(input.ack, subtle)
  const payload: BackupPayload = { ack: bytesToBase64(input.ack), ackFp }
  if (input.meta?.accountId) payload.accountId = input.meta.accountId
  if (input.meta?.viewerId) payload.viewerId = input.meta.viewerId
  const salt = randomBytes(BACKUP_SALT_BYTES)
  const iv = randomBytes(BACKUP_IV_BYTES)
  const key = await deriveWrapKey(subtle, input.passphrase, salt, iterations)
  const plain = new TextEncoder().encode(JSON.stringify(payload))
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plain as BufferSource)
  return {
    app: BACKUP_PACKAGE_APP,
    kind: BACKUP_PACKAGE_KIND,
    v: BACKUP_PACKAGE_VERSION,
    createdAt: typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now(),
    ackFp,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: bytesToBase64(salt) },
    cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
    ct: bytesToBase64(new Uint8Array(ct)),
  }
}

export function serializeIdentityBackup(pkg: IdentityBackupPackage): string {
  return JSON.stringify(pkg, null, 2)
}

/* ------------------------------------------------------------------ */
/* Parse + open                                                        */
/* ------------------------------------------------------------------ */

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/**
 * Validate the outer shape of a backup package from file text. Throws
 * IdentityBackupError with code bad_format / unsupported_version / bad_params;
 * the ciphertext itself is only authenticated later, by AES-GCM on open.
 */
export function parseIdentityBackup(text: string): IdentityBackupPackage {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new IdentityBackupError("bad_format", "Backup file is not valid JSON")
  }
  const pkg = recordOf(raw)
  if (!pkg || pkg.app !== BACKUP_PACKAGE_APP || pkg.kind !== BACKUP_PACKAGE_KIND) {
    throw new IdentityBackupError("bad_format", "This file is not a Pi-Remote identity backup")
  }
  if (pkg.v !== BACKUP_PACKAGE_VERSION) {
    throw new IdentityBackupError("unsupported_version", `Unsupported backup version: ${String(pkg.v)}`)
  }
  const kdf = recordOf(pkg.kdf)
  const cipher = recordOf(pkg.cipher)
  if (!kdf || kdf.name !== "PBKDF2" || kdf.hash !== "SHA-256" || !cipher || cipher.name !== "AES-GCM") {
    throw new IdentityBackupError("bad_params", "Backup uses unsupported KDF or cipher parameters")
  }
  const iterations = kdf.iterations
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < BACKUP_PBKDF2_MIN_ITERATIONS ||
    iterations > BACKUP_PBKDF2_MAX_ITERATIONS
  ) {
    throw new IdentityBackupError("bad_params", "Backup KDF iteration count is out of the accepted range")
  }
  if (!isBase64(kdf.salt) || base64ToBytes(kdf.salt).length !== BACKUP_SALT_BYTES) {
    throw new IdentityBackupError("bad_params", "Backup KDF salt is malformed")
  }
  if (!isBase64(cipher.iv) || base64ToBytes(cipher.iv as string).length !== BACKUP_IV_BYTES) {
    throw new IdentityBackupError("bad_params", "Backup cipher IV is malformed")
  }
  if (!isBase64(pkg.ct) || typeof pkg.ackFp !== "string" || !/^[0-9a-f]{16}$/.test(pkg.ackFp)) {
    throw new IdentityBackupError("bad_format", "Backup ciphertext or fingerprint is malformed")
  }
  return pkg as unknown as IdentityBackupPackage
}

/**
 * Unwrap a backup package with its passphrase. A wrong passphrase and a
 * tampered package are indistinguishable by design (AES-GCM authentication);
 * both surface as one clean `open_failed` error, never as partial data.
 */
export async function openIdentityBackup(
  pkg: IdentityBackupPackage,
  passphrase: string,
  subtleOverride?: SubtleCrypto,
): Promise<OpenedIdentityBackup> {
  const subtle = subtleOf(subtleOverride)
  const salt = base64ToBytes(pkg.kdf.salt)
  const iv = base64ToBytes(pkg.cipher.iv)
  const key = await deriveWrapKey(subtle, passphrase, salt, pkg.kdf.iterations)
  let plain: ArrayBuffer
  try {
    plain = await subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, base64ToBytes(pkg.ct) as BufferSource)
  } catch {
    throw new IdentityBackupError("open_failed", "Wrong passphrase or corrupted backup package")
  }
  let payload: BackupPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(plain)) as BackupPayload
  } catch {
    throw new IdentityBackupError("open_failed", "Wrong passphrase or corrupted backup package")
  }
  if (!isBase64(payload.ack)) throw new IdentityBackupError("open_failed", "Wrong passphrase or corrupted backup package")
  const ack = base64ToBytes(payload.ack)
  if (ack.length !== ACK_BYTES) throw new IdentityBackupError("open_failed", "Wrong passphrase or corrupted backup package")
  // Integrity cross-check: the sealed fingerprint must match the unwrapped key
  // and the package header, so a mismatched file can never import silently.
  const ackFp = await ackFingerprintOf(ack, subtle)
  if (ackFp !== payload.ackFp || ackFp !== pkg.ackFp) {
    throw new IdentityBackupError("open_failed", "Wrong passphrase or corrupted backup package")
  }
  const opened: OpenedIdentityBackup = { ack, ackFp }
  if (typeof payload.accountId === "string" && payload.accountId) opened.accountId = payload.accountId
  if (typeof payload.viewerId === "string" && payload.viewerId) opened.viewerId = payload.viewerId
  return opened
}
