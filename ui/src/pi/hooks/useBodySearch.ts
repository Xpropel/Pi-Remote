import { useEffect, useRef, useState } from "react"
import { errorCode, mergeDeviceSessions, type Device, type ListedSession, type RoomInfo, type SessionEntry } from "../../relay/devices.ts"
import {
  BODY_SEARCH_QUERY_MIN,
  bodySearchErrorText,
  bodySearchPageOf,
  bodySearchPartialText,
  bodySearchTruncatedText,
  type BodySearchPage,
} from "../../shell/searchModel.ts"
import { paletteBodyHitsOf, type PiPaletteBodyHit } from "../model/palette.ts"
import { openSessionRow, type PiDeviceListedSession } from "../model/sidebarSource.ts"

/**
 * Body search for the live search surfaces (command palettes, sidebar search
 * overlay, phone search page) -- A-3. The pipeline itself (extension-side
 * scan of the session files on the device, relay fan-out + merge in
 * relay/bodySearch.ts) always existed, but no shipped surface invoked it:
 * every live surface filtered titles locally, so a word that only occurs in
 * a conversation body read as "does not exist".
 *
 * Scope, kept honest by construction: the search runs on the SELECTED device
 * only (relay.searchSessionBodies), over that device's plaintext session
 * files. Encrypted rooms never contribute: the relay answers their targets
 * with an explicit encrypted marker, which the merge layer surfaces as
 * partial/error text -- ciphertext is never searched anywhere.
 *
 * Trigger discipline: one run per settled query (debounce), never per
 * keystroke; the extension additionally caps files / bytes / time per run.
 * A result is keyed by (query, deviceId) -- changing either discards it, so
 * one device's hits are never shown under another device's name.
 */

/** Quiet period after the last query change before the device scan fires. */
export const BODY_SEARCH_DEBOUNCE_MS = 600

/** The slice of the relay object the body-search surfaces need. */
export interface BodySearchRelay {
  searchSessionBodies: (query: string) => Promise<unknown>
  selectedDeviceId: string | null
  selectedDevice?: { name?: string } | null
}

export type BodySearchUiState =
  | { phase: "idle" }
  | { phase: "searching"; query: string }
  | { phase: "done"; query: string; page: BodySearchPage }
  | { phase: "error"; query: string; text: string }

export interface BodySearch {
  deviceId: string | null
  deviceName: string
  state: BodySearchUiState
}

export function useBodySearch(relay: BodySearchRelay, query: string, active: boolean): BodySearch {
  const deviceId = relay.selectedDeviceId
  const deviceName = relay.selectedDevice?.name ?? ""
  const trimmed = query.trim()
  const usable = active && deviceId != null && trimmed.length >= BODY_SEARCH_QUERY_MIN
  const [result, setResult] = useState<{ query: string; deviceId: string | null; state: BodySearchUiState } | null>(null)
  const ticket = useRef(0)

  useEffect(() => {
    if (!usable) return
    const mine = ++ticket.current
    const timer = setTimeout(() => {
      setResult({ query: trimmed, deviceId, state: { phase: "searching", query: trimmed } })
      relay.searchSessionBodies(trimmed).then(
        (data) => {
          if (ticket.current !== mine) return
          const page = bodySearchPageOf(data)
          setResult({
            query: trimmed,
            deviceId,
            state: page
              ? { phase: "done", query: trimmed, page }
              : { phase: "error", query: trimmed, text: "正文搜索回包形状不对，请重试" },
          })
        },
        (error) => {
          if (ticket.current !== mine) return
          setResult({
            query: trimmed,
            deviceId,
            state: { phase: "error", query: trimmed, text: bodySearchErrorText(errorCode(error), error instanceof Error ? error.message : "") },
          })
        },
      )
    }, BODY_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      // Invalidate the in-flight run for the previous key: its late reply
      // must not land under the new query / device.
      ticket.current++
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, trimmed, deviceId])

  const state: BodySearchUiState =
    usable && result && result.query === trimmed && result.deviceId === deviceId ? result.state : usable ? { phase: "searching", query: trimmed } : { phase: "idle" }
  return { deviceId, deviceName, state }
}

/**
 * The status line for a finished body search: not-found (or "already listed
 * above" when every hit is also a title match), partial-result and truncated
 * notes, composed with the searchModel honest texts. Null when a done search
 * has hits and nothing caveated to say. Lives here (not in the surfaces) so
 * variant shells, which may not import @/shell, share the exact wording.
 */
export function bodySearchNoteOf(state: BodySearchUiState, shownHitCount: number): string | null {
  if (state.phase !== "done") return null
  const notes: string[] = []
  if (shownHitCount === 0) notes.push(state.page.results.length ? "正文命中的会话已在上面列出" : `正文里没有找到「${state.query}」`)
  const partial = bodySearchPartialText(state.page)
  if (partial) notes.push(partial)
  if (state.page.truncated) notes.push(bodySearchTruncatedText(state.page))
  return notes.length ? notes.join("；") : null
}

/** One display-ready body hit for the sidebar search overlay. */
export interface SidebarBodyBlockHit {
  id: string
  label: string
  snippet: string
  matchCount: number
}

/**
 * The sidebar overlay's body block (the PiSidebarSearchBody shape, kept
 * structural so this module stays below the sidebar contract): the host
 * hands it down as data.search.body and the shared overlay renders it.
 */
export interface SidebarBodyBlock {
  deviceName: string
  phase: "searching" | "done" | "error"
  hits: SidebarBodyBlockHit[]
  /** Status line: searching / error / partial / truncated / not found. */
  note?: string
}

/** Palette-shaped body hits for a finished search (title-matched sessions excluded); [] in every other phase. */
function paletteHitsOf(search: BodySearch, titleMatched: readonly { id: string; path?: string }[]): PiPaletteBodyHit[] {
  const { state, deviceId, deviceName } = search
  if (state.phase !== "done" || deviceId == null) return []
  return paletteBodyHitsOf(state.page, { id: deviceId, name: deviceName }, titleMatched)
}

/**
 * Assemble the sidebar overlay's body block from a body-search state.
 * Shared by every shell's sidebar container so the block (group header
 * device, hit rows, honest status line) cannot drift between shells --
 * the Claude/Codex containers shipped without it in the first A-3 round
 * precisely because each container assembled its search data by hand.
 * `titleMatched` is the caller's own title-match exclusion list (the
 * sessions its local results already show), as { id, path } pairs.
 */
export function sidebarBodyBlockOf(search: BodySearch, titleMatched: readonly { id: string; path?: string }[]): SidebarBodyBlock | undefined {
  const { state, deviceId, deviceName } = search
  if (state.phase === "idle" || deviceId == null) return undefined
  if (state.phase === "searching") {
    return { deviceName, phase: "searching", hits: [], note: deviceName ? `正在 ${deviceName} 上搜索正文…` : "正在搜索正文…" }
  }
  if (state.phase === "error") return { deviceName, phase: "error", hits: [], note: state.text }
  const hits = paletteHitsOf(search, titleMatched)
  return {
    deviceName,
    phase: "done",
    hits: hits.map((hit) => ({ id: hit.id, label: hit.title, snippet: hit.snippet, matchCount: hit.matchCount })),
    note: bodySearchNoteOf(state, hits.length) ?? undefined,
  }
}

/** Resolve a sidebar body hit back to its palette hit (for opening); null outside the done phase or for a stale id. */
export function bodyHitOf(search: BodySearch, titleMatched: readonly { id: string; path?: string }[], hitId: string): PiPaletteBodyHit | null {
  return paletteHitsOf(search, titleMatched).find((hit) => hit.id === hitId) ?? null
}

/** The slice of the relay object needed to open a body hit. */
export interface BodyHitOpenRelay {
  roomId: string
  selectedDeviceId: string | null
  devices: readonly Device[]
  rooms: readonly RoomInfo[]
  sessionsByDevice: Readonly<Record<string, readonly SessionEntry[]>>
  selectDevice: (id: string) => void
  selectRoom: (id: string) => void
  selectListedSession: (row: ListedSession) => void
}

/**
 * Open a body-search hit through the same path as a listed session row
 * (openSessionRow): a hit already in the device's session list opens as that
 * row (merged with the canonical mergeDeviceSessions, so title / openable /
 * enc semantics match the sidebar rows); a hit outside the listed window
 * (the list is capped) opens as a row synthesized from the search reply,
 * exactly like the sidebar search does.
 */
export function openBodySearchHit(relay: BodyHitOpenRelay, hit: { id: string; title: string; session: string; cwd: string; mtime: number; deviceId: string }, onOpened: () => void): void {
  const norm = (path: string) => path.replace(/\\/g, "/")
  const device = relay.devices.find((d) => d.id === hit.deviceId)
  const merged = device ? mergeDeviceSessions(device, [...relay.rooms], [...(relay.sessionsByDevice[hit.deviceId] ?? [])]) : []
  const listed = merged.find((x) => x.id === hit.id || (!!x.path && norm(x.path) === norm(hit.session)))
  if (listed) {
    const row: PiDeviceListedSession = { ...listed, deviceId: hit.deviceId }
    openSessionRow(relay, row, onOpened)
    return
  }
  const online = relay.rooms.some((r) => r.id === hit.id && r.online)
  openSessionRow(
    relay,
    {
      id: hit.id,
      title: hit.title,
      path: hit.session,
      cwd: hit.cwd,
      online,
      busy: false,
      viewers: 0,
      messageCount: 0,
      updatedAt: hit.mtime,
      openable: online,
      deviceId: hit.deviceId,
    },
    onOpened,
  )
}
