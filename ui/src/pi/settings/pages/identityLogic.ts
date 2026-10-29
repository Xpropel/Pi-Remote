/**
 * Settings > Devices: viewer identity + authorized viewers, pure logic layer.
 *
 * Everything here is presentation shaping and user-facing copy: no React, no
 * DOM, no storage, no network. Inputs are `unknown` on purpose -- the identity
 * core (ui/src/relay/viewerIdentity.ts) and the relay roster reply are owned
 * by other modules, and this layer must degrade honestly instead of crashing
 * or inventing fields when their shapes drift.
 *
 * Copy rules that come straight from the design (do not soften them):
 * - Enabling identity must carry the unrecoverable-history warning verbatim
 *   in spirit: no backup + all key-holding devices lost + browser data
 *   cleared = history is gone, and neither the relay nor the admin token can
 *   bring it back (the admin token only restores access, never content keys).
 * - Revoking a viewer only removes access. The revoked viewer keeps its ACK
 *   copy and can still unwrap room keys sealed before the revocation; real
 *   removal requires an ACK rotation. The UI must say so, not imply otherwise.
 * - Phase 3 ships body encryption: conversation bodies are end-to-end
 *   encrypted and the relay only forwards and stores ciphertext. Tier-b
 *   honesty still applies: session metadata and dialog (ask/answer) text
 *   cross the relay in plaintext, and the copy must keep saying so.
 * - Keys that exist locally but were never registered with the relay (the
 *   registration was refused or never finished) are an error state, never
 *   the waiting-for-ACK state: an unregistered viewer has no roster row,
 *   so no ACK can ever be delivered to it.
 */
import { lastOnlineTextOf } from "./devicesLogic.ts"

/* ------------------------------------------------------------------ */
/* User-facing copy (product language: Chinese).                       */
/* ------------------------------------------------------------------ */

/** Plain-language explanation shown before the user enables viewer identity. */
export const IDENTITY_ENABLE_INTRO =
  "启用后，这个浏览器会生成一副专属的身份密钥：登录中转服务时用私钥签名证明身份，不再只靠一串谁拿到都能用的令牌。私钥由浏览器托管、不可导出，任何脚本都读不到它的字节；每个浏览器各有一副，互不通用。"

/** Mandatory warning shown in the enable confirmation step, before keys exist. */
export const IDENTITY_UNRECOVERABLE_WARNING =
  "务必先想清楚：如果所有持有内容钥的设备都丢失、这个浏览器的站点数据又被清空、同时你没有口令备份，那么历史记录将永久无法恢复——中转服务器和管理员令牌都救不回来。管理员令牌只能恢复接入（重新配对、撤销），它解不开内容钥。所以强烈建议：启用之后立刻创建一份口令备份，并把备份文件和口令分开保管。"

/** Strong backup prompt shown immediately after identity is enabled. */
export const IDENTITY_BACKUP_RECOMMENDATION =
  "身份已启用。现在就创建一份口令备份：将来浏览器数据丢失时，凭备份文件 + 口令就能把内容钥找回来；没有备份，就只能指望还有别的持钥设备在线交付。"

/** State copy while the identity exists but no content key has been delivered yet. */
export const IDENTITY_WAITING_ACK_TEXT =
  "本机身份已登记，但还没有拿到账号内容钥（ACK）。任一持钥设备在线时会自动交付；保持连接稍候即可。等不及也可以在下方导入一份口令备份，直接恢复内容钥。"

/** Honest notice attached to the viewer revoke confirmation. */
export const VIEWER_REVOKE_ACK_NOTICE =
  "注意：撤销只是让这个观看端无法再登录，它手里已经拿到的内容钥副本不会失效——撤销前包裹好的房间钥，它仍然解得开。想真正除名，必须再轮换账号内容钥（ACK 轮换）；这里先如实说明，本页不会假装撤销等于密码学除名。"

/** Phase-3 note: identity plus body encryption, with the tier-b caveats. */
export const IDENTITY_PHASE_NOTE =
  "设备与观看端都用密钥证明身份，对话正文已启用端到端加密：中转服务只能转发和保存密文，解不开正文。需要如实说明的是，本阶段的加密只覆盖正文——会话元数据（标题、时间等）和问答弹窗的文本仍会以明文经过中转服务。"

/**
 * Error copy for keys that exist locally but are NOT registered with the
 * relay: the registration was refused or never completed, so this viewer
 * has no roster row -- it cannot key-auth, and no ACK delivery can ever
 * reach it. Registration is an admin operation: it needs the admin token
 * saved through the pairing dialog (the "添加设备" flow on this page).
 */
export const IDENTITY_NOT_REGISTERED_TEXT =
  "本机身份密钥已经生成，但还没有在中转服务登记成功，因此现在还不能用密钥登录，也收不到内容钥（ACK）——请不要只是等待，登记不成功时 ACK 永远不会送达。登记需要管理员凭据：请先在本页「添加设备」的配对对话框里保存管理员令牌，再点下方「重新登记」。实在不行，也可以「忘记本机身份」清掉这副密钥，从头再来。"

/** One-line refusal reason for the not-registered state, from the core's lastError code. */
export function registrationErrorTextOf(view: IdentityStateView): string {
  if (view.phase !== "not-registered" || !view.lastError) return ""
  if (view.lastError === "admin_required") return "上次登记被中转服务拒绝：管理员凭据未通过（多半是还没保存管理员令牌，或令牌不对）。"
  return `上次登记没有成功（${view.lastError}）。`
}

/** Roster unavailable note (old relay or identity core not wired up yet). */
export const VIEWERS_UNSUPPORTED_TEXT = "当前连接没有提供观看端名册（旧版中转服务，或身份核心尚未接通），这里不会假装列出名单。"

/* ------------------------------------------------------------------ */
/* Identity state shaping                                              */
/* ------------------------------------------------------------------ */

export type ViewerIdentityPhase =
  /** Identity core module could not be loaded in this build. */
  | "unavailable"
  /** No identity in this browser yet; the enable flow is offered. */
  | "none"
  /**
   * Keys exist locally but the relay roster does NOT hold this identity:
   * the registration was refused or never completed. An error state with
   * recovery actions (re-register / forget), never a "just wait" state.
   */
  | "not-registered"
  /** Identity registered, but no ACK has been delivered to this browser. */
  | "waiting-ack"
  /** Identity registered and the ACK is held locally. */
  | "ready"

export interface IdentityStateView {
  phase: ViewerIdentityPhase
  viewerId: string | null
  /** This viewer's signing-key fingerprint (grouping applied at render time). */
  keyFp: string | null
  /** ACK fingerprint once held, else null. */
  ackFp: string | null
  accountId: string | null
  /** True only when the core states the relay roster holds this identity. */
  registered: boolean
  /** Last failure code worth surfacing (e.g. a refused registration), else null. */
  lastError: string | null
  /** True once a passphrase backup has been created from this browser. */
  backedUp: boolean
  backedUpAt: number | null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function timeOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Shape whatever the identity core reports into one honest view model.
 * `hasIdentity` falls back to "a viewerId exists"; `hasAck` falls back to
 * "an ackFp exists". Unknown or empty input reads as phase "none"; the
 * "unavailable" phase is decided by the caller (identity core failed to
 * load), never guessed from state contents.
 */
export function identityStateViewOf(raw: unknown): IdentityStateView {
  const state = recordOf(raw)
  const viewerId = state ? stringOf(state.viewerId ?? state.id) : null
  const ackFp = state ? stringOf(state.ackFp) : null
  const hasIdentity = state ? state.hasIdentity === true || viewerId !== null : false
  const hasAck = state ? state.hasAck === true || ackFp !== null : false
  // Registration is claimed ONLY when the core explicitly states it. Keys
  // without a confirmed registration derive the not-registered error state:
  // deriving waiting-ack here is what once presented a relay-refused
  // registration as "registered, just wait for the ACK".
  const registered = state ? state.registered === true : false
  const backedUpAt = state ? timeOf(state.backedUpAt) : null
  const phase: ViewerIdentityPhase = !hasIdentity ? "none" : !registered ? "not-registered" : hasAck ? "ready" : "waiting-ack"
  return {
    phase,
    viewerId,
    keyFp: state ? stringOf(state.keyFp ?? state.signFp) : null,
    ackFp,
    accountId: state ? stringOf(state.accountId) : null,
    registered,
    lastError: state ? stringOf(state.lastError) : null,
    backedUp: state ? state.backedUp === true || backedUpAt !== null : false,
    backedUpAt,
  }
}

/** One-line backup status for the identity card. */
export function backupStatusTextOf(view: IdentityStateView): string {
  if (view.phase !== "ready") return ""
  return view.backedUp ? "已建口令备份" : "尚未备份（建议立即创建）"
}

/* ------------------------------------------------------------------ */
/* Fingerprint display                                                 */
/* ------------------------------------------------------------------ */

/** Group a hex fingerprint in fours, e.g. "3f9a c41d 77b0 02e5" (display only). */
export function formatFingerprintText(fp: string | null | undefined): string {
  const value = (fp ?? "").trim()
  if (!value) return "—"
  if (!/^[0-9a-fA-F]+$/.test(value)) return value
  return value.toLowerCase().replace(/(.{4})(?=.)/g, "$1 ")
}

/* ------------------------------------------------------------------ */
/* Authorized viewers roster shaping                                   */
/* ------------------------------------------------------------------ */

export interface AuthorizedViewerRow {
  viewerId: string
  name: string
  keyFp: string | null
  admin: boolean
  createdAt: number | null
  revoked: boolean
  revokedAt: number | null
}

/**
 * Shape one roster row from the relay `viewer_list` reply. Rows without a
 * usable viewerId are dropped (null) instead of rendered as ghosts.
 */
export function authorizedViewerRowOf(raw: unknown): AuthorizedViewerRow | null {
  const row = recordOf(raw)
  if (!row) return null
  const viewerId = stringOf(row.viewerId ?? row.id)
  if (!viewerId) return null
  const revokedAt = timeOf(row.revokedAt)
  return {
    viewerId,
    name: stringOf(row.name) ?? viewerId,
    keyFp: stringOf(row.keyFp ?? row.signFp),
    admin: row.admin === true,
    createdAt: timeOf(row.createdAt),
    revoked: revokedAt !== null || row.revoked === true,
    revokedAt,
  }
}

/** Shape a whole `viewer_list` reply; accepts an array or a wrapping object. */
export function authorizedViewerRowsOf(raw: unknown): AuthorizedViewerRow[] {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(recordOf(raw)?.viewers)
      ? (recordOf(raw)?.viewers as unknown[])
      : Array.isArray(recordOf(recordOf(raw)?.data)?.viewers)
        ? (recordOf(recordOf(raw)?.data)?.viewers as unknown[])
        : []
  const rows: AuthorizedViewerRow[] = []
  for (const item of list) {
    const row = authorizedViewerRowOf(item)
    if (row) rows.push(row)
  }
  // Live viewers first (newest first), revoked ones sink to the bottom.
  return rows.sort((a, b) => Number(a.revoked) - Number(b.revoked) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

/** Roster row status: revoked / admin / plain member, plus registration time. */
export function viewerStatusTextOf(row: AuthorizedViewerRow, now: number): string {
  const parts: string[] = []
  if (row.revoked) parts.push("已撤销")
  else if (row.admin) parts.push("可管理")
  else parts.push("已授权")
  const created = row.createdAt ? lastOnlineTextOf(row.createdAt, now) : ""
  if (created) parts.push(`登记于 ${created}`)
  return parts.join(" · ")
}

/** True when the row describes this browser's own viewer identity. */
export function isSelfViewerRow(row: AuthorizedViewerRow, view: IdentityStateView): boolean {
  return view.viewerId !== null && row.viewerId === view.viewerId
}
