"use strict";
/**
 * ackFp reconciliation (design §3.5 / §7): keyed ends (devices and viewers) report the
 * fingerprint of the account content key (ACK) they hold after auth. The relay never
 * sees or stores the ACK itself — only 16-hex fingerprints, kept in memory only.
 * When the ends of one account disagree, every reporting end receives a key_mismatch
 * warning frame so the user can re-sync the key. Convergence clears the warned state,
 * so a later divergence warns again instead of being swallowed by the earlier one.
 */
const { errorFrame } = require("./wire");

/** A valid ackFp is exactly contentKeyFpChars lowercase hex characters. */
function isAckFp(v) {
  return typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
}

function createAckTracker() {
  // accountId -> Map(endId -> { ackFp, notify })
  const accounts = new Map();
  // accountId -> signature of the divergence that was already warned about
  // (the sorted distinct fingerprints joined), to avoid warning on every report
  // while the same disagreement persists.
  const warned = new Map();

  const distinctFps = (accountId) => {
    const ends = accounts.get(accountId);
    if (!ends) return [];
    return [...new Set([...ends.values()].map((e) => e.ackFp))].sort();
  };

  /** The one agreed fingerprint for an account, or null while unknown or diverged. */
  const knownAckFp = (accountId) => {
    const d = distinctFps(accountId);
    return d.length === 1 ? d[0] : null;
  };

  /**
   * Record (or refresh) one end's report. notify(frame) fires on every reporting end
   * of the account when a NEW divergence appears. Returns the consensus afterwards.
   */
  function report(accountId, endId, ackFp, notify) {
    if (!accountId || !endId || !isAckFp(ackFp) || typeof notify !== "function") return knownAckFp(accountId);
    let ends = accounts.get(accountId);
    if (!ends) {
      ends = new Map();
      accounts.set(accountId, ends);
    }
    ends.set(endId, { ackFp, notify });
    const distinct = distinctFps(accountId);
    if (distinct.length > 1) {
      const sig = distinct.join(",");
      if (warned.get(accountId) !== sig) {
        warned.set(accountId, sig);
        // The warning frame lists the conflicting fingerprints so each end can show
        // exactly which copies disagree; the ACK itself is never part of any frame.
        const frame = errorFrame("key_mismatch");
        frame.ackFps = distinct;
        for (const e of ends.values()) {
          try { e.notify(frame); } catch {}
        }
      }
    } else {
      warned.delete(accountId);
    }
    return knownAckFp(accountId);
  }

  /** Drop one end (disconnect / revoke). If the rest agree again afterwards, a future
   *  divergence must warn again, so the warned marker is cleared on convergence. */
  function forget(accountId, endId) {
    const ends = accounts.get(accountId);
    if (!ends) return;
    ends.delete(endId);
    if (!ends.size) {
      accounts.delete(accountId);
      warned.delete(accountId);
      return;
    }
    if (distinctFps(accountId).length <= 1) warned.delete(accountId);
  }

  return { report, forget, knownAckFp };
}

/** One tracker per relay process, lazily attached to the shared ctx so the local and
 *  viewer channels reconcile against the same per-account state. */
function ackTrackerOf(ctx) {
  if (!ctx.ackTracker) ctx.ackTracker = createAckTracker();
  return ctx.ackTracker;
}

module.exports = { createAckTracker, ackTrackerOf, isAckFp };
