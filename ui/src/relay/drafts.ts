/** 草稿落盘（P3-3 / 体验 N5）：输入框草稿只存本机浏览器 localStorage，零协议改动、不跨端。
 *
 *  - 一把总键存全房间的草稿表：{ [roomKey]: { text, at } }，roomKey = 房间 id（房间即会话身份）；
 *  - 写入由 useRelay 防抖（300ms）+ 切房同步落盘 + beforeunload 冲刷三路保证；
 *  - 配额/条数溢出按 at 最久未用淘汰，绝不动最近使用的；
 *  - 读写本身仍吞异常（隐私模式 / 配额满 / 存储被禁时输入功能不受影响），但**写失败不再静默**：
 *    saveRoomDraft 返回 false，并通过 onDraftPersistFailure 把同一房间的连续失败上报一次（UI 低危 16）。
 *  - 待发图片另存一份会话级 sessionStorage 副本（UI 低危 17）：草稿只存文本，图片若只留内存，
 *    刷新后静默消失、用户可能裸发正文。副本按房间 + 标签页隔离，刷新回来由 composer 恢复，
 *    恢复不了也会明确提示（见 DRAFT_IMAGES_STORAGE_KEY 一组函数）。
 */

import { MAX_PENDING_IMAGES, SEND_IMAGE_TOTAL_MAX_CHARS } from "../chat/composerTools.ts"
import { prepareSendImage, type SendImage } from "./transcript.ts"

export type DraftEntry = { text: string; at: number }
export type DraftTable = Record<string, DraftEntry>

export const DRAFTS_STORAGE_KEY = "pi_remote_drafts_v1"
/** 最多保留的房间数与总字数：草稿是短文本，超限只可能来自长期堆积。 */
export const DRAFTS_MAX_ROOMS = 40
export const DRAFTS_MAX_CHARS = 120_000

export type DraftStore = {
  get(key: string): string | null
  set(key: string, value: string): boolean
  remove(key: string): void
}

function browserStore(kind: "local" | "session" = "local"): DraftStore {
  const storage = () => (kind === "local" ? window.localStorage : window.sessionStorage)
  return {
    get(key) {
      try {
        return storage().getItem(key)
      } catch {
        return null
      }
    },
    set(key, value) {
      try {
        storage().setItem(key, value)
        return true
      } catch {
        return false
      }
    },
    remove(key) {
      try {
        storage().removeItem(key)
      } catch {}
    },
  }
}

let defaultStore: DraftStore | null = null
function store(): DraftStore {
  if (!defaultStore) defaultStore = browserStore()
  return defaultStore
}

/* ── 落盘失败上报（UI 低危 16） ─────────────────────────────────────────────
 * 以前 saveRoomDraft 把 localStorage 的异常吞掉：配额满 / 隐私模式 / 存储被禁时，用户照常输入、
 * 刷新后整段草稿消失且没有任何提示。数据层在这里把"同一房间的连续失败"上报一次（写到成功为止
 * 不会重复报），由 composer 用现有提示条告知；不改变读写语义，也不打断输入。 */

export type DraftPersistFailure = { roomKey: string }
export type DraftPersistFailureListener = (failure: DraftPersistFailure) => void

const persistFailureListeners = new Set<DraftPersistFailureListener>()
/** 已经报过、还没写成功的房间：连续失败只提示一次 */
const failingRooms = new Set<string>()

/** 订阅草稿落盘失败；返回退订函数。回调异常不影响落盘路径。 */
export function onDraftPersistFailure(listener: DraftPersistFailureListener): () => void {
  persistFailureListeners.add(listener)
  return () => {
    persistFailureListeners.delete(listener)
  }
}

function reportPersistFailure(roomKey: string): void {
  if (failingRooms.has(roomKey)) return
  failingRooms.add(roomKey)
  for (const listener of [...persistFailureListeners]) {
    try {
      listener({ roomKey })
    } catch {}
  }
}

function settlePersistFailure(roomKey: string): void {
  failingRooms.delete(roomKey)
}

export function parseDraftTable(raw: string | null): DraftTable {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const table: DraftTable = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key || !value || typeof value !== "object") continue
      const entry = value as { text?: unknown; at?: unknown }
      if (typeof entry.text !== "string" || !entry.text) continue
      table[key] = { text: entry.text, at: typeof entry.at === "number" && Number.isFinite(entry.at) ? entry.at : 0 }
    }
    return table
  } catch {
    return {}
  }
}

/** 超限淘汰：从最久未用开始删，直到房间数与总字数都回到限内；只剩一条时不再删。 */
export function pruneDraftTable(table: DraftTable): DraftTable {
  const keys = Object.keys(table)
  if (!keys.length) return table
  const byOldest = [...keys].sort((a, b) => (table[a].at || 0) - (table[b].at || 0))
  let total = keys.reduce((sum, key) => sum + table[key].text.length, 0)
  const next: DraftTable = { ...table }
  for (const key of byOldest) {
    if (Object.keys(next).length <= DRAFTS_MAX_ROOMS && total <= DRAFTS_MAX_CHARS) break
    if (Object.keys(next).length <= 1) break
    total -= next[key].text.length
    delete next[key]
  }
  return next
}

export function readDraftTable(s: DraftStore = store()): DraftTable {
  return parseDraftTable(s.get(DRAFTS_STORAGE_KEY))
}

/** 从一份原始 localStorage 值（如 storage 事件的 newValue）里读某房间草稿；没有返回 ""。 */
export function roomDraftFromRaw(raw: string | null, roomKey: string): string {
  if (!roomKey) return ""
  return parseDraftTable(raw)[roomKey]?.text ?? ""
}

/** 读某房间的落盘草稿；没有返回 ""。 */
export function readRoomDraft(roomKey: string, s: DraftStore = store()): string {
  if (!roomKey) return ""
  return readDraftTable(s)[roomKey]?.text ?? ""
}

/**
 * 写某房间的草稿（空文本 = 删除该房条目）。返回是否真的落到存储。
 * 失败不再静默：同一房间的连续失败只上报一次（onDraftPersistFailure）。
 */
export function saveRoomDraft(roomKey: string, text: string, s: DraftStore = store(), now: number = Date.now()): boolean {
  if (!roomKey) return false
  const table = readDraftTable(s)
  if (!text) {
    if (!(roomKey in table)) return true
    delete table[roomKey]
  } else {
    table[roomKey] = { text, at: now }
  }
  const pruned = pruneDraftTable(table)
  if (!Object.keys(pruned).length) {
    s.remove(DRAFTS_STORAGE_KEY)
    settlePersistFailure(roomKey)
    return true
  }
  const ok = s.set(DRAFTS_STORAGE_KEY, JSON.stringify(pruned))
  if (ok) settlePersistFailure(roomKey)
  else reportPersistFailure(roomKey)
  return ok
}

/* ── 待发图片的会话级副本（UI 低危 17） ─────────────────────────────────────
 * 图片（base64）不塞进 localStorage 的草稿表：一张图最大 128K 字符、5 张就接近 1MB，
 * 会把本来就宝贵的本地存储挤爆。这里只写 sessionStorage（同一标签页、关页即清），
 * 单槽记录当前房间的待发图片：刷新 / 崩溃恢复后由 composer 调 addPendingImages 恢复。
 * 换房或图片发完时清空，避免隔了很久“复活”一组图。全部读写吞异常，失败返回 false。 */

export const DRAFT_IMAGES_STORAGE_KEY = "pi_remote_draft_images_v1"

export type DraftImageRecord = { room: string; images: SendImage[]; at: number }

let defaultImageStore: DraftStore | null = null
function imageStore(): DraftStore {
  if (!defaultImageStore) defaultImageStore = browserStore("session")
  return defaultImageStore
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** 存盘/读盘共用的形状校验：只认 png/jpeg/gif/webp、单张 ≤ SEND_IMAGE_MAX_CHARS、合计预算内，
 *  最多 MAX_PENDING_IMAGES 张；坏条目丢弃而不是硬撑（与其它解析器口径一致）。 */
function draftImagesOf(value: unknown): SendImage[] {
  if (!Array.isArray(value)) return []
  const images: SendImage[] = []
  let total = 0
  // 只扫有意义的头部，坏数组不整段遍历
  for (const raw of value.slice(0, MAX_PENDING_IMAGES * 4)) {
    if (images.length >= MAX_PENDING_IMAGES) break
    if (!isRecord(raw)) continue
    const prepared = prepareSendImage({
      data: typeof raw.data === "string" ? raw.data : "",
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "",
    })
    if (!prepared.image) continue
    if (total + prepared.image.data.length > SEND_IMAGE_TOTAL_MAX_CHARS) break
    images.push(prepared.image)
    total += prepared.image.data.length
  }
  return images
}

function parseDraftImageRecord(raw: string | null): DraftImageRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || typeof parsed.room !== "string" || !parsed.room) return null
    const images = draftImagesOf(parsed.images)
    if (!images.length) return null
    return {
      room: parsed.room,
      images,
      at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0,
    }
  } catch {
    return null
  }
}

/** 写本标签页的待发图片副本；没有合法图片 = 清空。返回是否落盘（false 时调用方提示刷新会丢）。 */
export function saveDraftImages(roomKey: string, images: readonly SendImage[], s: DraftStore = imageStore(), now: number = Date.now()): boolean {
  if (!roomKey) return false
  const clean = draftImagesOf(images)
  if (!clean.length) {
    s.remove(DRAFT_IMAGES_STORAGE_KEY)
    return true
  }
  return s.set(DRAFT_IMAGES_STORAGE_KEY, JSON.stringify({ room: roomKey, images: clean, at: now }))
}

/** 读本标签页刷新前的待发图片；房间对不上 / 没有 / 坏值返回 []。 */
export function readDraftImages(roomKey: string, s: DraftStore = imageStore()): SendImage[] {
  if (!roomKey) return []
  const record = parseDraftImageRecord(s.get(DRAFT_IMAGES_STORAGE_KEY))
  return record && record.room === roomKey ? record.images : []
}

export function clearDraftImages(s: DraftStore = imageStore()): void {
  s.remove(DRAFT_IMAGES_STORAGE_KEY)
}

/* ── 跨标签页同步（UI 低危：草稿冲突） ──────────────────────────────────────
 * 同一房间可能在两个标签页同时打开。storage 事件把别的标签页刚写入的草稿带过来时：
 *  - 本页没有未落盘编辑（current === base，base = 最近一次与存储对齐的值）→ 采纳远端值；
 *  - 本页正在编辑（current !== base）→ 保留本地输入，交给防抖落盘按最后写入胜出；
 *  - 远端值与本地相同 → 只把 base 对齐，不触发重渲染。
 * 另外，切房/关页的同步落盘只在 current !== base 时写，避免陈旧标签页把另一页
 * 刚改好的草稿冲回旧版本。 */

export type RemoteDraftReconcile = {
  /** true = 采纳远端值（调用方 setDraft） */
  adopt: boolean
  draft: string
  /** 更新后的"与存储对齐"基线 */
  base: string
}

/** 收到别的标签页的草稿变更后，决定是否采纳（纯函数，node --test 直接测）。 */
export function reconcileRemoteDraft(current: string, base: string, remote: string): RemoteDraftReconcile {
  if (remote === current) return { adopt: false, draft: current, base: remote }
  if (current !== base) return { adopt: false, draft: current, base }
  return { adopt: true, draft: remote, base: remote }
}

/** 本地草稿与已落盘基线不同才需要写（防陈旧标签页覆盖另一页的新草稿）。 */
export function shouldPersistDraft(current: string, base: string): boolean {
  return current !== base
}

/* ── 新建会话页草稿（UI 低危：切皮肤丢草稿） ────────────────────────────────
 * 三套界面的新建页（cursor NewSessionContainer / claude ClaudeNewSession / codex CodexNewSession）
 * 共用这一份纯内存草稿：切换界面变体时旧页卸载、新页挂载，未发送的第一条消息不再丢。
 * 与上面按房间落盘的会话草稿分开：新建页还没有房间，不能按 roomKey 存，也不写 localStorage
 * （刷新即清是既有行为）；组件用 useSyncExternalStore 订阅。 */

let newSessionDraft = ""
const newSessionDraftListeners = new Set<() => void>()

/** 新建会话页当前未发送的草稿（空字符串 = 没有） */
export function newSessionDraftOf(): string {
  return newSessionDraft
}

/** 写新建页草稿；支持函数式更新。值没变不触发订阅。 */
export function setNewSessionDraft(next: string | ((prev: string) => string)): void {
  const value = typeof next === "function" ? next(newSessionDraft) : next
  if (value === newSessionDraft) return
  newSessionDraft = value
  for (const listener of [...newSessionDraftListeners]) listener()
}

/** 订阅新建页草稿变化（useSyncExternalStore 的 subscribe 参数）。 */
export function subscribeNewSessionDraft(listener: () => void): () => void {
  newSessionDraftListeners.add(listener)
  return () => {
    newSessionDraftListeners.delete(listener)
  }
}
