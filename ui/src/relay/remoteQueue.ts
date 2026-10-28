/** 远程自管待发缓冲（P1 §6）的纯逻辑：事件解析、标签与摘要。
 *
 *  - 只是 relay/扩展快照的镜像：不在这里合成任务、不改编辑内容；
 *  - `remote_queue_state` 是整份替换，`items: []` 合法表示清空；坏帧保留上一帧；
 *  - 编辑/取消只对 pending 开放；injected/failed 是终态。
 */

export type RemoteQueueSegment = "steer" | "follow_up"
export type RemoteQueueStatus = "pending" | "injected" | "failed"

export type RemoteQueueImage = { mimeType: string; bytes: number }

export type RemoteQueueItem = {
  id: string
  segment: RemoteQueueSegment
  source: string
  text: string
  /** 扩展投影把正文截到 4000 字时必带此标记（R3-3 第 1 项）：text 只是截断版，
   *  编辑前必须按 id 拉全文；拉不到就只读明示，不许拿截断版当编辑初值保存。 */
  truncated?: boolean
  /** truncated 时的全文长度（字数），供呈现层告知用户全文规模。 */
  textLen?: number
  /** 全文版本指纹（扩展对全文计算，投影截断与否同值）：编辑保存的乐观并发基线
   *  （queue_edit 的 baseHash）与全文缓存的失效判定都吃它；老扩展不带时为 undefined。 */
  textHash?: string
  images: RemoteQueueImage[]
  status: RemoteQueueStatus
  at: number
  cid?: string
  updatedAt?: number
  injectedAt?: number
  error?: string
  code?: string
}

export type RemoteQueueState = { rev: number; items: RemoteQueueItem[] }

export const EMPTY_REMOTE_QUEUE: RemoteQueueState = { rev: 0, items: [] }

export function emptyRemoteQueue(): RemoteQueueState {
  return { rev: 0, items: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function validSegment(value: unknown): value is RemoteQueueSegment {
  return value === "steer" || value === "follow_up"
}

function validStatus(value: unknown): value is RemoteQueueStatus {
  return value === "pending" || value === "injected" || value === "failed"
}

function parseImages(value: unknown): RemoteQueueImage[] {
  if (!Array.isArray(value)) return []
  const out: RemoteQueueImage[] = []
  for (const raw of value.slice(0, 16)) {
    if (!isRecord(raw)) continue
    const mimeType = typeof raw.mimeType === "string" ? raw.mimeType : ""
    if (!mimeType) continue
    const bytes = finiteNumber(raw.bytes)
    out.push({ mimeType, bytes: bytes != null && bytes >= 0 ? Math.floor(bytes) : 0 })
  }
  return out
}

function parseItem(raw: unknown): RemoteQueueItem | null {
  if (!isRecord(raw)) return null
  const id = typeof raw.id === "string" ? raw.id.trim() : ""
  const segment = raw.segment
  const status = raw.status
  if (!id || !validSegment(segment) || !validStatus(status)) return null
  const item: RemoteQueueItem = {
    id,
    segment,
    source: typeof raw.source === "string" && raw.source ? raw.source : "web",
    text: typeof raw.text === "string" ? raw.text : "",
    images: parseImages(raw.images),
    status,
    at: finiteNumber(raw.at) ?? 0,
  }
  if (typeof raw.truncated === "boolean") {
    // 显式 false 也要透传：全文回包靠它区分"已确认全文"与"老帧没带标记"。
    item.truncated = raw.truncated
    const len = finiteNumber(raw.textLen)
    if (len != null && len >= 0) item.textLen = Math.floor(len)
  }
  if (typeof raw.textHash === "string" && raw.textHash) item.textHash = raw.textHash
  if (typeof raw.cid === "string" && raw.cid) item.cid = raw.cid
  const updatedAt = finiteNumber(raw.updatedAt)
  if (updatedAt != null) item.updatedAt = updatedAt
  const injectedAt = finiteNumber(raw.injectedAt)
  if (injectedAt != null) item.injectedAt = injectedAt
  if (typeof raw.error === "string" && raw.error) item.error = raw.error
  if (typeof raw.code === "string" && raw.code) item.code = raw.code
  return item
}

/** 解析单条投影（queue_get 单条/full 回包）：形状不合法返回 null，口径与快照内单条一致。 */
export function parseRemoteQueueItem(raw: unknown): RemoteQueueItem | null {
  return parseItem(raw)
}

/**
 * 解析 remote_queue_state。
 * - `items` 不是数组：返回 null（忽略坏帧，保留上一帧）；
 * - 单条缺 id/segment/status 或枚举非法：跳过该条，不补默认值；
 * - 空数组是合法的清空。
 */
export function parseRemoteQueueState(event: unknown): RemoteQueueState | null {
  if (!isRecord(event) || !Array.isArray(event.items)) return null
  const items: RemoteQueueItem[] = []
  const seen = new Set<string>()
  for (const raw of event.items.slice(0, 200)) {
    const item = parseItem(raw)
    if (!item || seen.has(item.id)) continue
    seen.add(item.id)
    items.push(item)
  }
  const rev = finiteNumber(event.rev)
  return { rev: rev != null && rev >= 0 ? Math.floor(rev) : 0, items }
}

export function remoteQueuePendingCount(items: readonly RemoteQueueItem[]): number {
  return items.reduce((count, item) => count + (item.status === "pending" ? 1 : 0), 0)
}

export function remoteQueueSegmentLabel(segment: RemoteQueueSegment): string {
  return segment === "steer" ? "当前回合后" : "等结束后"
}

export function remoteQueueStatusLabel(status: RemoteQueueStatus): string {
  if (status === "pending") return "待发"
  if (status === "injected") return "已注入"
  return "失败"
}

export function remoteQueueSourceLabel(source: string): string {
  if (source === "web") return "网页"
  return source || "未知"
}

export function remoteQueueImagesLabel(images: readonly RemoteQueueImage[]): string {
  return images.length ? `${images.length} 张图` : ""
}

/** 列表里的单行摘要：压掉换行、截到 max（不改变真正要编辑的全文）。 */
export function remoteQueueTextSummary(text: string, max = 96): string {
  const oneLine = String(text || "").replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, max) + "…"
}

/** 是否还能编辑/取消：只有 pending 可以；终态由界面显示锁定原因。 */
export function canMutateRemoteQueueItem(item: RemoteQueueItem): boolean {
  return item.status === "pending"
}

/** 全文缓存的基线（C-2）：hash = 缓存里那份全文的指纹；frameHash = 写入缓存那一刻
 *  状态帧里该条目的指纹（自己保存后、新帧还没到时帧会暂时停在这里）。 */
export type QueueFullTextBase = { hash: string; frameHash: string }

/** 全文缓存是否已过期（C-2）：条目已不在清单 → 过期；帧指纹既不等于缓存内容指纹
 *  （帧还没跟上我方保存）、也不等于写入时的帧指纹（帧还停在我方保存前），而是变成
 *  第三个值 → 他端改过，缓存过期，必须丢弃重拉，绝不拿旧全文当下一次编辑的初值。
 *  任一侧没指纹（老扩展）→ 不判过期，无从比对时不假装能判。判错方向只有"多丢一次
 *  缓存、重拉一回"，不会把过期全文当新鲜用。 */
export function queueFullTextCacheStale(item: RemoteQueueItem | undefined, base: QueueFullTextBase | undefined): boolean {
  if (!item) return true
  if (!base || !base.hash || !item.textHash) return false
  if (item.textHash === base.hash) return false
  if (item.textHash === base.frameHash) return false
  return true
}
