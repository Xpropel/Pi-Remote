/**
 * Folder existence probes for the new-session picker (F3).
 *
 * The picker's defaults come from session history and the device allow-list
 * (folderAllowed), neither of which can tell a deleted folder from a live
 * one -- a workspace removed on the device kept being preselected. Existence
 * is probed through relay.listDirs for the folder itself: a successful
 * listing proves it exists, and ONLY an explicit fs_not_found answer proves
 * it is gone. Offline / capability / permission answers prove nothing, are
 * never cached, and must never exclude a folder.
 *
 * Results live in a module-level cache shared by all three shells (Cursor /
 * Claude / Codex new-session pages), keyed by device + normalized folder
 * path, so each folder is probed at most once per app run.
 */
import { useEffect, useMemo, useState } from "react"
import type { Device } from "../../relay/devices.ts"
import { browseAccessOf } from "./folderBrowser.ts"
import { folderKeyOf } from "./newSession.ts"

export type FolderExistence = "exists" | "missing"

type ListDirsFn = (deviceId: string, path: string) => Promise<unknown>

const cache = new Map<string, FolderExistence>()
/** Raw folder path per cache key, so callers get back the path as probed. */
const rawByKey = new Map<string, string>()
const inflight = new Map<string, Promise<FolderExistence | null>>()

const EMPTY_SET: ReadonlySet<string> = new Set()

function cacheKey(deviceId: string, folder: string): string {
  return `${deviceId}\n${folderKeyOf(folder)}`
}

/** Cached verdict for one folder, or null when it was never (successfully) probed. */
export function folderExistenceOf(deviceId: string, folder: string): FolderExistence | null {
  return cache.get(cacheKey(deviceId, folder)) ?? null
}

/** Every folder currently proven missing on one device (raw paths). */
export function missingFoldersOf(deviceId: string): ReadonlySet<string> {
  const prefix = `${deviceId}\n`
  const out = new Set<string>()
  for (const [key, verdict] of cache) {
    if (verdict !== "missing" || !key.startsWith(prefix)) continue
    const raw = rawByKey.get(key)
    if (raw) out.add(raw)
  }
  return out.size ? out : EMPTY_SET
}

/**
 * Probe one folder on one device. Resolves "exists" / "missing" for a
 * definitive answer, or null when the answer proves nothing (offline,
 * capability, permission, timeout) -- null is never cached, so a later
 * render may probe again.
 */
export function probeFolderExistence(deviceId: string, folder: string, listDirs: ListDirsFn): Promise<FolderExistence | null> {
  const key = cacheKey(deviceId, folder)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(key)
  if (pending) return pending
  const run = (async (): Promise<FolderExistence | null> => {
    try {
      await listDirs(deviceId, folder)
      cache.set(key, "exists")
      rawByKey.set(key, folder)
      return "exists"
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === "fs_not_found") {
        cache.set(key, "missing")
        rawByKey.set(key, folder)
        return "missing"
      }
      return null
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, run)
  return run
}

type ProbeDevice = Pick<Device, "id" | "online" | "browseRoots"> & { features?: readonly string[] }

/**
 * React seam for the new-session pages: probes the currently effective
 * folder (only when the device can browse at all) and returns the set of
 * folders proven missing on that device. When the effective folder turns
 * out missing, the caller recomputes its defaults with this set excluded,
 * which moves the effect to the next candidate -- the cascade walks down
 * the candidate list until a folder that exists is preselected.
 */
export function useMissingFolders(probe: { listDirs: ListDirsFn } | null, device: ProbeDevice | null, folder: string | null): ReadonlySet<string> {
  const [tick, setTick] = useState(0)
  const deviceId = device?.id ?? null
  const canBrowse = device ? browseAccessOf(device).canBrowse : false
  const listDirs = probe?.listDirs
  useEffect(() => {
    if (!listDirs || !deviceId || !folder || !canBrowse) return
    if (folderExistenceOf(deviceId, folder) !== null) return
    let live = true
    void probeFolderExistence(deviceId, folder, listDirs).then((result) => {
      if (live && result === "missing") setTick((n) => n + 1)
    })
    return () => {
      live = false
    }
  }, [listDirs, deviceId, folder, canBrowse])
  // The tick is the invalidation signal for the module-level cache: a probe
  // that lands "missing" bumps it and the set below is rebuilt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (deviceId ? missingFoldersOf(deviceId) : EMPTY_SET), [deviceId, tick])
}
