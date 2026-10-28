/**
 * P11 侧栏本机状态持久化（pin/archive/文件夹折叠；arch 冻结，纯函数，node --test 直载）。
 *
 * - 存储键（p11-spec §6.4 定名）：`pi_remote_pi_sidebar_local`
 * - 隔离（Lead 裁决）：按 **relay account + device** 命名空间，切账号/设备互不串；不写标题/路径/用户名。
 * - 结构：{ v:1, scopes: { "<account::device>": { pins:[], archives:[], folders:{groupId:bool}, updatedAt } } }
 * - 宽度/折叠属于 PiPrefs（设备本地，见 model/prefs.ts），不进本存储。
 * - 诚实边界：仅本机记忆；不写 pi/relay、不删会话文件；provider（session-pin）可用时由上层优先，本地作降级。
 */
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "./types.ts"

export const PI_SIDEBAR_LOCAL_STORAGE_KEY = "pi_remote_pi_sidebar_local"
export const PI_SIDEBAR_LOCAL_VERSION = 1
const MAX_KEYS_PER_SCOPE = 2000
const MAX_SCOPES = 64

export interface PiSidebarScopeState {
  pins: string[]
  archives: string[]
  /** 工作区分组折叠：groupId → collapsed */
  folders: Record<string, boolean>
  updatedAt: number
}

export interface PiSidebarLocalState {
  v: typeof PI_SIDEBAR_LOCAL_VERSION
  scopes: Record<string, PiSidebarScopeState>
}

export function emptySidebarLocalState(): PiSidebarLocalState {
  return { v: PI_SIDEBAR_LOCAL_VERSION, scopes: {} }
}

/** account::device 命名空间；空值用 anonymous/local，编码避免 `::` 注入。 */
export function sidebarStorageScope(accountId: string | undefined | null, deviceId: string | undefined | null): string {
  const account = encodeURIComponent(String(accountId || "").trim() || "anonymous").slice(0, 120)
  const device = encodeURIComponent(String(deviceId || "").trim() || "local").slice(0, 120)
  return `${account}::${device}`
}

/** 宽度 clamp（PiPrefs 迁移用）：非法/缺失 → 272。 */
export function clampSidebarWidth(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(n)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(n)))
}

function cleanKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== "string") continue
    const key = item.trim().slice(0, 200)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= MAX_KEYS_PER_SCOPE) break
  }
  return out
}

function cleanFolders(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out
  let count = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "boolean") continue
    const id = key.slice(0, 200)
    if (!id) continue
    out[id] = value
    if (++count >= MAX_KEYS_PER_SCOPE) break
  }
  return out
}

function cleanScope(raw: unknown): PiSidebarScopeState | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const pins = cleanKeys(rec.pins)
  const archives = cleanKeys(rec.archives)
  const folders = cleanFolders(rec.folders)
  const updatedAt = typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0
  if (!pins.length && !archives.length && !Object.keys(folders).length && !updatedAt) return null
  return { pins, archives, folders, updatedAt }
}

/** 存储内容（JSON 字符串或对象）→ 合法状态；坏数据逐项丢弃，永不抛。 */
export function parseSidebarLocalState(raw: unknown): PiSidebarLocalState {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return emptySidebarLocalState()
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptySidebarLocalState()
  const rec = value as Record<string, unknown>
  if (rec.v !== PI_SIDEBAR_LOCAL_VERSION) return emptySidebarLocalState()
  const scopes: Record<string, PiSidebarScopeState> = {}
  const rawScopes = rec.scopes
  if (rawScopes && typeof rawScopes === "object" && !Array.isArray(rawScopes)) {
    let count = 0
    for (const [scope, scopeRaw] of Object.entries(rawScopes as Record<string, unknown>)) {
      if (count >= MAX_SCOPES) break
      const clean = cleanScope(scopeRaw)
      if (!clean) continue
      scopes[scope.slice(0, 260)] = clean
      count += 1
    }
  }
  return { v: PI_SIDEBAR_LOCAL_VERSION, scopes }
}

export function serializeSidebarLocalState(state: PiSidebarLocalState): string {
  return JSON.stringify(parseSidebarLocalState(state))
}

export function sidebarScopeStateOf(state: PiSidebarLocalState, scope: string): PiSidebarScopeState {
  const rec = state.scopes[scope]
  return rec ? { pins: [...rec.pins], archives: [...rec.archives], folders: { ...rec.folders }, updatedAt: rec.updatedAt } : { pins: [], archives: [], folders: {}, updatedAt: 0 }
}

function withScope(state: PiSidebarLocalState, scope: string, scopeState: PiSidebarScopeState): PiSidebarLocalState {
  const next = parseSidebarLocalState(state)
  next.scopes[scope] = { pins: cleanKeys(scopeState.pins), archives: cleanKeys(scopeState.archives), folders: cleanFolders(scopeState.folders), updatedAt: scopeState.updatedAt || Date.now() }
  return next
}

/** 置顶 toggle：pin 时自动从 archives 移除；返回新状态（不可变）。 */
export function toggleSidebarPin(state: PiSidebarLocalState, scope: string, sessionKey: string, now = Date.now()): PiSidebarLocalState {
  const key = String(sessionKey || "").trim()
  if (!key) return parseSidebarLocalState(state)
  const cur = sidebarScopeStateOf(state, scope)
  const pinned = !cur.pins.includes(key)
  cur.pins = pinned ? [...cur.pins, key] : cur.pins.filter((k) => k !== key)
  if (pinned) cur.archives = cur.archives.filter((k) => k !== key)
  cur.updatedAt = now
  return withScope(state, scope, cur)
}

/** 归档 toggle：archive 时自动从 pins 移除；归档只在本机隐藏，不删文件。 */
export function toggleSidebarArchive(state: PiSidebarLocalState, scope: string, sessionKey: string, now = Date.now()): PiSidebarLocalState {
  const key = String(sessionKey || "").trim()
  if (!key) return parseSidebarLocalState(state)
  const cur = sidebarScopeStateOf(state, scope)
  const archived = !cur.archives.includes(key)
  cur.archives = archived ? [...cur.archives, key] : cur.archives.filter((k) => k !== key)
  if (archived) cur.pins = cur.pins.filter((k) => k !== key)
  cur.updatedAt = now
  return withScope(state, scope, cur)
}

/** 工作区分组折叠持久化（按 groupId；与 pin/archive 同 scope）。 */
export function setSidebarFolderCollapsed(state: PiSidebarLocalState, scope: string, groupId: string, collapsed: boolean, now = Date.now()): PiSidebarLocalState {
  const id = String(groupId || "").trim()
  if (!id) return parseSidebarLocalState(state)
  const cur = sidebarScopeStateOf(state, scope)
  cur.folders[id] = collapsed === true
  cur.updatedAt = now
  return withScope(state, scope, cur)
}

/** 清理某 scope（账号切换/设备删除）；未知 scope 原样返回。 */
export function clearSidebarScope(state: PiSidebarLocalState, scope: string): PiSidebarLocalState {
  const next = parseSidebarLocalState(state)
  delete next.scopes[scope]
  return next
}

/** 已失效会话的本地记录清理（pin/archive 里保留太多旧 key 时）。 */
export function pruneSidebarScopeKeys(state: PiSidebarLocalState, scope: string, validKeys: readonly string[], now = Date.now()): PiSidebarLocalState {
  const valid = new Set(validKeys)
  const cur = sidebarScopeStateOf(state, scope)
  const pins = cur.pins.filter((key) => valid.has(key))
  const archives = cur.archives.filter((key) => valid.has(key))
  if (pins.length === cur.pins.length && archives.length === cur.archives.length) return parseSidebarLocalState(state)
  return withScope(state, scope, { ...cur, pins, archives, updatedAt: now })
}
