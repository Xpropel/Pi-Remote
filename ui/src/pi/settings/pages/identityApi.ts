/**
 * Settings > Devices: single integration seam to the viewer identity core.
 *
 * The identity core lives in ui/src/relay/viewerIdentity.ts and is owned by
 * another module (VIK/VBK in IndexedDB, viewer key auth, ACK storage, grant
 * send/receive). This adapter is the ONLY place in the settings surface that
 * knows about it. It loads the module dynamically and normalizes whichever
 * export shape the core settles on into the small bridge below, so the React
 * surface never imports the core directly.
 *
 * If the core cannot be loaded (a build where it is not wired up yet), the
 * loader returns null and the surface renders an honest "not connected"
 * state instead of pretending identity features work.
 *
 * Roster transport (list / revoke authorized viewers) is looked up in two
 * places, in order: methods on the identity core (it owns adminSig signing),
 * then same-named methods on the relay object (in case integration exposes
 * them there). When neither exists, the bridge reports them as null and the
 * UI disables the roster with an explanation instead of faking data.
 */

export interface IdentityBridge {
  /** Raw identity state as reported by the core; shape it with identityLogic. */
  getState: () => Promise<unknown>
  /** Generate this browser's identity keys and register them with the relay. */
  enable: () => Promise<unknown>
  /** Raw ACK bytes for backup export, or null when no ACK is held. */
  exportAck: () => Promise<Uint8Array | null>
  /** Store an ACK recovered from a backup package. */
  importAck: (ack: Uint8Array) => Promise<void>
  /** Best-effort: record that a passphrase backup was created at this time. */
  markBackedUp: (at: number) => Promise<void>
  /** Raw viewer_list reply, or null when no roster transport exists. */
  listViewers: (() => Promise<unknown>) | null
  /** Revoke one viewer by id, or null when no roster transport exists. */
  revokeViewer: ((viewerId: string) => Promise<void>) | null
}

type AnyFn = (...args: never[]) => unknown

function fnOf(source: Record<string, unknown> | null, names: readonly string[]): AnyFn | null {
  if (!source) return null
  for (const name of names) {
    const value = source[name]
    if (typeof value === "function") return value as AnyFn
  }
  return null
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

/** Normalize the many shapes an ACK export might take into raw bytes. */
export function ackBytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === "string" && value.length > 0) {
    try {
      const binary = atob(value)
      const out = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
      return out
    } catch {
      return null
    }
  }
  const record = recordOf(value)
  if (record) {
    for (const key of ["ack", "ackBytes", "ackB64", "bytes"]) {
      const nested = ackBytesOf(record[key])
      if (nested) return nested
    }
  }
  return null
}

async function loadIdentityModule(): Promise<Record<string, unknown> | null> {
  try {
    // Literal specifier on purpose: Vite and tsc resolve the "@" alias
    // statically, so the production bundle really contains the identity
    // core. A variable specifier would bypass alias resolution and
    // silently disable identity in production builds.
    const mod = (await import("@/relay/viewerIdentity")) as Record<string, unknown>
    return mod
  } catch {
    return null
  }
}

/**
 * Build the bridge. `relayLike` is the settings host's relay object, used
 * only as a fallback roster transport; it is never assumed to have the
 * roster methods.
 */
export async function loadIdentityBridge(relayLike?: unknown): Promise<IdentityBridge | null> {
  const mod = await loadIdentityModule()
  if (!mod) return null
  // The core may export a singleton object, a factory, or bare functions.
  const singleton = recordOf(mod.viewerIdentity) ?? recordOf(mod.identity) ?? recordOf(mod.default)
  const source: Record<string, unknown> = singleton ?? mod

  const getState = fnOf(source, ["getState", "getViewerIdentityState", "getIdentityState", "viewerIdentityState", "state"])
  const enable = fnOf(source, ["enable", "enableViewerIdentity", "enableIdentity", "createViewerIdentity", "generateViewerIdentity"])
  const exportAckFn = fnOf(source, ["exportAck", "exportAckForBackup", "exportAckBytes", "getAckBytes"])
  const importAckFn = fnOf(source, ["importAck", "importAckBytes", "importAckFromBackup", "setAck"])
  if (!getState || !enable || !exportAckFn || !importAckFn) return null

  const markBackedUpFn = fnOf(source, ["markBackedUp", "markIdentityBackedUp", "recordBackupAt"])
  const relayRecord = recordOf(relayLike)
  const listViewersFn =
    fnOf(source, ["listViewers", "listAuthorizedViewers", "fetchViewers"]) ??
    fnOf(relayRecord, ["listViewers", "listAuthorizedViewers"])
  const revokeViewerFn =
    fnOf(source, ["revokeViewer", "revokeAuthorizedViewer"]) ?? fnOf(relayRecord, ["revokeViewer", "revokeAuthorizedViewer"])

  return {
    getState: async () => getState(),
    enable: async () => enable(),
    exportAck: async () => ackBytesOf(await exportAckFn()),
    importAck: async (ack: Uint8Array) => {
      await importAckFn(ack as never)
    },
    markBackedUp: async (at: number) => {
      if (markBackedUpFn) await markBackedUpFn(at as never)
    },
    listViewers: listViewersFn ? async () => listViewersFn() : null,
    revokeViewer: revokeViewerFn
      ? async (viewerId: string) => {
          await revokeViewerFn(viewerId as never)
        }
      : null,
  }
}
