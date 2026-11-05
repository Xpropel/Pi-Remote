/**
 * Device-owned switch sync (approval gate / remote dialog answering / ask_user tool).
 *
 * These switches live on the device (bridge memory); the relay only
 * stores the last value a viewer explicitly set. The old discipline --
 * every viewer pushes its locally stored prefs on every connect and
 * room entry -- made the device state flap whenever several viewers
 * with different stored values took turns connecting (last connector
 * wins, three flips in a minute were observed), and could silently
 * turn remote answering off for a room another viewer was actively
 * using, stranding approval prompts in the device terminal.
 *
 * The discipline here, per room and switch, driven by useRelay:
 *  - The device reports its current value in every ext_status
 *    (`switches`). A report is ADOPTED: it becomes the baseline and the
 *    local prefs are rewritten to match, so the settings page shows
 *    the device state, not a stale local copy.
 *  - A viewer pushes ONLY when its local value differs from the
 *    baseline -- i.e. after an explicit settings change, never merely
 *    for connecting. The baseline (`sent`) moves ONLY on a device
 *    report: a push records the in-flight value in `pushed` instead,
 *    so an unconfirmed push is never mistaken for device truth, and a
 *    report that disagrees (another viewer changed it, the bridge
 *    restarted to its default) re-baselines and is adopted. Exception:
 *    in legacy mode the bridge never reports, so a push still advances
 *    `sent` there (the pre-existing discipline for old bridges).
 *  - While a push is in flight (`pushed` set, no confirming report
 *    yet), a report carrying a different value does NOT overwrite the
 *    local value the user just chose -- the report predates the push;
 *    the confirming report settles it. The baseline still updates.
 *  - Until a room's first ext_status arrives the mode is "pending"
 *    and nothing is pushed: the cached snapshot replay right after
 *    joining settles it within a round-trip. A snapshot WITHOUT a
 *    switches block means an older bridge that cannot report; the
 *    room then runs in "legacy" mode (push on entry / on change,
 *    the pre-existing behavior for that bridge).
 *  - A report arriving in legacy mode upgrades the room to "device"
 *    mode (bridge updated mid-session); a snapshot without switches
 *    never downgrades a room already in device mode.
 *
 * Values are compared as opaque serialized strings; the serializers
 * live with the push effects in useRelay. Pure functions, node --test
 * loads this file directly.
 */

export type SwitchSyncMode = "pending" | "device" | "legacy"

export type SwitchSyncEntry = {
  mode: SwitchSyncMode
  /**
   * Baseline: the last device-reported value. In legacy mode (no
   * reports exist) it instead tracks the last successfully pushed
   * value, per the pre-existing discipline.
   */
  sent: string | null
  /**
   * Device mode only: the value this viewer pushed since the last
   * report, not yet confirmed by one. Cleared when a report confirms
   * it, or when a report wins over it (see switchSyncOnReport).
   */
  pushed?: string
}

export function switchSyncEntryInit(): SwitchSyncEntry {
  return { mode: "pending", sent: null }
}

/**
 * Fold one ext_status report into the entry. `reported` is the
 * serialized device value, or null when the snapshot carried no switch
 * state for this switch. `current` is the viewer's serialized local
 * value at fold time (optional; only used to protect an in-flight
 * push). Returns the next entry plus `adopt`: the value the caller
 * must write into the local prefs (null = leave them alone).
 */
export function switchSyncOnReport(
  entry: SwitchSyncEntry,
  reported: string | null,
  current?: string,
): { entry: SwitchSyncEntry; adopt: string | null } {
  if (reported === null) {
    if (entry.mode === "pending") return { entry: { mode: "legacy", sent: entry.sent }, adopt: null }
    return { entry, adopt: null }
  }
  if (entry.mode === "device" && entry.pushed !== undefined && entry.pushed !== reported && current === entry.pushed) {
    // A push is in flight and this report predates it (it carries the
    // pre-push device value): move the baseline, keep the local value
    // the user just chose, keep the push outstanding.
    return { entry: { mode: "device", sent: reported, pushed: entry.pushed }, adopt: null }
  }
  return { entry: { mode: "device", sent: reported }, adopt: reported }
}

/** May this viewer push `current` (its serialized local value) now? */
export function switchSyncShouldPush(entry: SwitchSyncEntry, current: string): boolean {
  if (entry.mode === "pending") return false
  if (entry.mode === "device" && entry.pushed !== undefined) return entry.pushed !== current
  return entry.sent !== current
}

/**
 * Record a successful push. Device mode: the baseline does NOT move --
 * the value is only in flight (`pushed`) until a device report
 * confirms it. Legacy mode: no report will ever come, so the pushed
 * value becomes the baseline, as before.
 */
export function switchSyncAfterPush(entry: SwitchSyncEntry, current: string): SwitchSyncEntry {
  if (entry.mode === "device") return { ...entry, pushed: current }
  return { mode: entry.mode, sent: current }
}

/* ------------------------------------------------------------------ */
/* Current-room view for settings surfaces                             */

/**
 * What a settings surface may present for the current room's switches:
 * the mode plus, in device mode, the device-reported values. In
 * pending mode the surface must not present a local value as settled
 * truth (the report has not arrived); in legacy mode there is no
 * device truth, so the local value remains the operative one and the
 * fields stay null (callers fall back to the local prefs).
 */
export type SwitchSyncView = {
  mode: SwitchSyncMode
  dialogRemoteAnswer: boolean | null
  approvalGateEnabled: boolean | null
  approvalGateTier: string | null
  askUserEnabled: boolean | null
}

export const SWITCH_SYNC_PENDING_VIEW: SwitchSyncView = {
  mode: "pending",
  dialogRemoteAnswer: null,
  approvalGateEnabled: null,
  approvalGateTier: null,
  askUserEnabled: null,
}

function reportedBool(entry: SwitchSyncEntry | undefined): boolean | null {
  if (!entry || entry.mode !== "device" || entry.sent === null) return null
  return entry.sent === "true"
}

/**
 * Derive the view from the current room's three sync entries. The
 * entries fold from the same reports, so their modes agree; the mode
 * is read from whichever entry is furthest along (device > legacy >
 * pending). The gate entry serializes as "enabled|tier".
 */
export function switchSyncViewFromEntries(
  dialog: SwitchSyncEntry | undefined,
  gate: SwitchSyncEntry | undefined,
  ask: SwitchSyncEntry | undefined,
): SwitchSyncView {
  const modes = [dialog?.mode, gate?.mode, ask?.mode]
  const mode: SwitchSyncMode = modes.includes("device") ? "device" : modes.includes("legacy") ? "legacy" : "pending"
  if (mode !== "device") return { ...SWITCH_SYNC_PENDING_VIEW, mode }
  let approvalGateEnabled: boolean | null = null
  let approvalGateTier: string | null = null
  if (gate && gate.sent !== null) {
    const cut = gate.sent.indexOf("|")
    if (cut > 0) {
      approvalGateEnabled = gate.sent.slice(0, cut) === "true"
      approvalGateTier = gate.sent.slice(cut + 1) || null
    }
  }
  return {
    mode,
    dialogRemoteAnswer: reportedBool(dialog),
    approvalGateEnabled,
    approvalGateTier,
    askUserEnabled: reportedBool(ask),
  }
}
