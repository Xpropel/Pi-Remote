/**
 * 设置页 v2 · 数据与隐私 / 关于两页共用的浏览器侧小工具。
 *
 * 边界：
 *   - 只碰**本机缓存**（草稿缓存、命令使用计数、CacheStorage 里本应用的缓存）；
 *   - 绝不碰 token、账号、旧版偏好键、`pi_remote_pi_settings_v2`、outbox（断线待发不是缓存）；
 *   - 导出文件由用户显式点击触发，不打印、不上传；会话索引只留 id / 标题 / 时间 / 设备 / 在线态，
 *     不带 cwd、路径、正文或任何凭据；
 *   - 纯函数（解析 / 组包 / 计量）不依赖 React 与 DOM，node --test 可直载。
 */
import { DEFAULT_SETTINGS_PREFS, normalizeSettingsPrefs } from "../model.ts"
import type { SettingsPrefs } from "../types.ts"

/** localStorage 里属于「可清缓存」的键；不含设置、token、outbox、侧栏置顶/归档。 */
export const LOCAL_CACHE_KEYS = ["pi_remote_drafts_v1", "pi_remote_slash_usage_v1"] as const

/** sessionStorage 里属于「可清缓存」的键。 */
export const SESSION_CACHE_KEYS = ["pi_remote_draft_images_v1"] as const

/** 导入文件上限：设置 JSON 正常 < 100KB，1MB 已经异常。 */
export const SETTINGS_IMPORT_MAX_CHARS = 1_000_000

export interface CacheStorageLike {
  getItem(key: string): string | null
  removeItem(key: string): void
}

function storageGet(storage: CacheStorageLike | null | undefined, key: string): string | null {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

function storageRemove(storage: CacheStorageLike | null | undefined, key: string): boolean {
  if (!storage) return false
  try {
    if (storage.getItem(key) == null) return false
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/** UTF-8 近似字节数；localStorage 实际按 UTF-16 存，这里统一用 UTF-8 便于和文件大小同一口径。 */
function byteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).length
  } catch {
    return text.length
  }
}

/** 本机缓存大小（不含设置 / token / outbox）。 */
export function measureCacheBytes(
  local: CacheStorageLike | null | undefined,
  session: CacheStorageLike | null | undefined,
): number {
  let total = 0
  for (const key of LOCAL_CACHE_KEYS) {
    const value = storageGet(local, key)
    if (value != null) total += byteLength(key) + byteLength(value)
  }
  for (const key of SESSION_CACHE_KEYS) {
    const value = storageGet(session, key)
    if (value != null) total += byteLength(key) + byteLength(value)
  }
  return total
}

/** 清掉本机缓存；返回是否至少删掉一项。 */
export function clearCacheStorage(
  local: CacheStorageLike | null | undefined,
  session: CacheStorageLike | null | undefined,
): boolean {
  let removed = false
  for (const key of LOCAL_CACHE_KEYS) removed = storageRemove(local, key) || removed
  for (const key of SESSION_CACHE_KEYS) removed = storageRemove(session, key) || removed
  return removed
}

/** 应用自己创建的 CacheStorage（名含 pi-remote / pi_remote）；其他站的缓存不碰。 */
function isOwnedCacheName(name: string): boolean {
  return /pi[-_]?remote/i.test(name)
}

/** CacheStorage 里本应用缓存的大小；不可用（无 API / 读取失败）返回 0。 */
export async function measureBrowserCacheBytes(): Promise<number> {
  try {
    if (typeof caches === "undefined") return 0
    let total = 0
    for (const name of await caches.keys()) {
      if (!isOwnedCacheName(name)) continue
      const cache = await caches.open(name)
      for (const request of await cache.keys()) {
        const response = await cache.match(request)
        if (!response) continue
        total += (await response.clone().blob()).size
      }
    }
    return total
  } catch {
    return 0
  }
}

/** 删掉本应用名下的 CacheStorage；失败静默（缓存不是核心功能）。 */
export async function clearBrowserCaches(): Promise<void> {
  try {
    if (typeof caches === "undefined") return
    const names = (await caches.keys()).filter(isOwnedCacheName)
    await Promise.all(names.map((name) => caches.delete(name)))
  } catch {
    // 隐私模式下没有 CacheStorage：忽略。
  }
}

/** 缓存大小文案：0 → "约 0 KB"；<1MB → KB；否则 MB。未知传 null → "—"。 */
export function formatCacheSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024 * 1024) return `约 ${Math.round(bytes / 1024)} KB`
  return `约 ${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const KNOWN_PREF_KEYS = new Set(Object.keys(DEFAULT_SETTINGS_PREFS))

export type SettingsImportResult =
  | { ok: true; prefs: SettingsPrefs }
  | { ok: false; error: string }

/**
 * 设置文件 → 合法偏好。
 * 接受两种输入：本页导出的信封 { v:1, prefs, updatedAt } 与裸偏好对象。
 * 版本不符 / 无任何已知字段 / 文件过大都明确报错，不静默套默认值。
 */
export function parseSettingsImport(text: string): SettingsImportResult {
  if (typeof text !== "string" || text.length > SETTINGS_IMPORT_MAX_CHARS) {
    return { ok: false, error: "文件过大，无法作为设置文件导入" }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: "文件不是合法的 JSON" }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "文件里没有设置对象" }
  }
  const record = raw as Record<string, unknown>
  if ("prefs" in record && "v" in record && record.v !== 1) {
    return { ok: false, error: "设置文件版本不兼容" }
  }
  const candidate = "prefs" in record ? record.prefs : record
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return { ok: false, error: "文件里没有设置对象" }
  }
  const keys = Object.keys(candidate as Record<string, unknown>)
  if (!keys.some((key) => KNOWN_PREF_KEYS.has(key))) {
    return { ok: false, error: "文件里没有可导入的设置项" }
  }
  return { ok: true, prefs: normalizeSettingsPrefs(candidate) }
}

export interface ExportSessionLike {
  id?: unknown
  title?: unknown
  updatedAt?: unknown
  deviceId?: unknown
  online?: unknown
}

export interface DataExportInput {
  prefs: SettingsPrefs
  sessions: readonly ExportSessionLike[]
  sessionText?: string | null
  sessionTruncated?: boolean
  appVersion: string
  now?: number
}

export interface DataExportFile {
  fileName: string
  mime: string
  text: string
  sessionCount: number
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  let out = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) out += char
  }
  return out.trim().slice(0, max)
}

function safeSessionRow(row: ExportSessionLike): Record<string, string | number | boolean> | null {
  const id = cleanText(row.id, 200)
  if (!id) return null
  const out: Record<string, string | number | boolean> = { id }
  const title = cleanText(row.title, 300)
  if (title) out.title = title
  if (typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) && row.updatedAt > 0) out.updatedAt = Math.round(row.updatedAt)
  const deviceId = cleanText(row.deviceId, 200)
  if (deviceId) out.deviceId = deviceId
  if (typeof row.online === "boolean") out.online = row.online
  return out
}

/**
 * 「导出我的数据」组包：本机设置 + 会话索引 + 当前会话正文（用户点导出时才带）。
 * 会话行只留白名单字段，绝不带 cwd / 路径 / 凭据 / 原始记录。
 */
export function buildDataExport(input: DataExportInput): DataExportFile {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now()
  const sessions = input.sessions
    .slice(0, 2000)
    .map(safeSessionRow)
    .filter((row): row is Record<string, string | number | boolean> => row != null)
  const text = typeof input.sessionText === "string" && input.sessionText.length > 0 ? input.sessionText : null
  const payload = {
    app: "Pi-Remote",
    format: "pi-remote-data.v1",
    exportedAt: new Date(now).toISOString(),
    appVersion: input.appVersion,
    settings: input.prefs,
    sessionIndex: sessions,
    session: text ? { text, truncated: input.sessionTruncated === true } : null,
  }
  const date = new Date(now)
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
  return {
    fileName: `pi-remote-data-${stamp}.json`,
    mime: "application/json",
    text: JSON.stringify(payload, null, 2),
    sessionCount: sessions.length,
  }
}

/** 浏览器下载（用户显式动作）。不可用环境返回 false。 */
export function downloadTextFile(fileName: string, text: string, mime = "application/json"): boolean {
  try {
    if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return false
    const blob = new Blob([text], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = fileName
    anchor.rel = "noopener"
    anchor.style.display = "none"
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    return true
  } catch {
    return false
  }
}
