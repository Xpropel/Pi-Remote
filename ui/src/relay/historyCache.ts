/**
 * 历史补拉的客户端窗口缓存（UI·relay 中-5）：纯逻辑，不依赖 React / DOM。
 *
 * `get_entries({ limit })` 只能取**尾部窗口**，且 total 随会话增长；旧实现每点一次
 * 「加载更早」都重新请求一个覆盖到游标的整段尾窗（游标越旧 limit 越大，已加载的
 * 新段被反复下载+重新解析，整段补完是平方量级）。本模块把每次拿到的尾窗按全局下标
 * 合并成一份连续缓存：
 *  - 窗口重叠段按 entryId/下标复用原对象（不重新构造/解析）；
 *  - 只有缓存盖不住目标起点时才需要再请求，且请求窗口向前多留 margin，
 *    接下来若干页都命中缓存，不再发命令；
 *  - total 回退（存储重置）或 leafId 改变（换分支）时重建，绝不拿旧分支的条目拼页；
 *  - 超过上限从最旧一端裁剪（更早的历史仍可重新拉取）。
 *
 * 下标口径与 history.ts 一致：窗口起点 = total - entries.length，条目只在尾部追加、
 * 旧条目下标不漂移。
 */
import type { EntriesResult, RawEntry } from "./history.ts"

/** 缓存最多保留的原始条目数（足够覆盖一次补拉的多页窗口；更早的按需重拉）。 */
export const HISTORY_CACHE_MAX_ENTRIES = 16384
/** 每次真正发请求时，在目标起点之前多留的条目数：一页 60 条，384 条 ≈ 6 页不用再请求。 */
export const HISTORY_CACHE_FETCH_MARGIN = 384

export type HistoryCache = {
  /** 缓存归属房间；换房必须重建，不能跨房拼页。 */
  room: string
  /** 已知全量条目数（尾窗 total）。 */
  total: number
  leafId: string | null
  /** entries[0] 的全局下标；entries 是 [startIndex, total) 的连续段。 */
  startIndex: number
  entries: RawEntry[]
  /** entryId → 全局下标（按 entryId 复用/定位）。 */
  indexById: Map<string, number>
}

export function createHistoryCache(room: string): HistoryCache {
  return { room, total: 0, leafId: null, startIndex: 0, entries: [], indexById: new Map() }
}

function indexCache(cache: Omit<HistoryCache, "indexById">): HistoryCache {
  const indexById = new Map<string, number>()
  for (let i = 0; i < cache.entries.length; i += 1) {
    const id = cache.entries[i] && typeof cache.entries[i].id === "string" ? (cache.entries[i].id as string) : ""
    if (id) indexById.set(id, cache.startIndex + i)
  }
  return { ...cache, indexById }
}

function entryId(entry: RawEntry | undefined): string {
  return entry && typeof entry.id === "string" ? (entry.id as string) : ""
}

function parentId(entry: RawEntry | undefined): string {
  return entry && typeof entry.parentId === "string" ? (entry.parentId as string) : ""
}

/**
 * 把一份尾窗合并进缓存，返回新缓存（不改入参）。
 * 合并后只保留**从 total-1 往回连续**的一段：中间有洞就说明这段历史拿不到，
 * 更旧的缓存条目不能跳洞拼接（否则会把不属于当前分支/顺序的条目当成一页）。
 *
 * 换分支（fork/回写）识别：leafId 会随每次追加前移，不能单凭它重建；改为检查窗口接缝——
 * 重叠下标上 entryId 必须一致，无重叠时新窗首条的 parentId 必须指向缓存最后一条。
 * 对不上就重建，避免把旧分支的条目缝到新分支前面。
 */
export function mergeHistoryWindow(
  cache: HistoryCache | null,
  room: string,
  result: EntriesResult,
  maxEntries = HISTORY_CACHE_MAX_ENTRIES,
): HistoryCache {
  const total = Math.max(0, Math.trunc(Number(result.total) || 0))
  const rawEntries = Array.isArray(result.entries) ? result.entries : []
  const resultStart = Math.max(0, total - rawEntries.length)
  // 换房 / total 回退（存储被重置）：旧缓存不可信，整份重建。
  let rebuild = !cache || cache.room !== room || total < cache.total
  const byIndex = new Map<number, RawEntry>()
  if (!rebuild && cache) {
    for (let i = 0; i < cache.entries.length; i += 1) byIndex.set(cache.startIndex + i, cache.entries[i])
    // 接缝校验：重叠下标必须同一 entryId；紧邻扩展时新窗首条必须挂在缓存最后一条后面。
    for (let i = 0; i < rawEntries.length && !rebuild; i += 1) {
      const index = resultStart + i
      if (index < cache.startIndex || index >= cache.total) continue
      const cached = byIndex.get(index)
      const cachedId = entryId(cached)
      const nextId = entryId(rawEntries[i])
      if (cachedId && nextId && cachedId !== nextId) rebuild = true
    }
    if (!rebuild && rawEntries.length && resultStart === cache.total && cache.entries.length) {
      const lastId = entryId(cache.entries[cache.entries.length - 1])
      const parent = parentId(rawEntries[0])
      if (lastId && parent && parent !== lastId) rebuild = true
    }
  }
  // 接缝对不上：丢掉已经拷进来的旧窗口，只信本次回包（否则旧分支条目会被缝在新窗口前面）。
  if (rebuild) byIndex.clear()
  for (let i = 0; i < rawEntries.length; i += 1) {
    const index = resultStart + i
    const next = rawEntries[i]
    if (rebuild) {
      byIndex.set(index, next)
      continue
    }
    const prev = byIndex.get(index)
    // 同一全局下标、同一 entryId 的条目在 pi 里是追加写、不可变：直接复用缓存对象，
    // 只有 entryId 对不上（分支被重写/窗口错位）才用新回包覆盖。
    const prevId = entryId(prev)
    const nextId = entryId(next)
    if (prev !== undefined && prevId && nextId && prevId === nextId) continue
    byIndex.set(index, next)
  }
  // 从最新一条往回找连续段；若最新一条缺失（空回包）就得到空窗口。
  let start = total
  while (start > 0 && byIndex.has(start - 1)) start -= 1
  const max = Math.max(1, Math.trunc(maxEntries))
  if (total - start > max) start = total - max
  const entries: RawEntry[] = []
  for (let i = start; i < total; i += 1) {
    const entry = byIndex.get(i)
    if (entry !== undefined) entries.push(entry)
  }
  return indexCache({ room, total, leafId: result.leafId ?? null, startIndex: start, entries })
}

/** 缓存是否覆盖 [fromIndex, total)（fromIndex 会先夹到 0）。 */
export function historyCacheCovers(cache: HistoryCache | null, fromIndex: number): boolean {
  if (!cache || cache.total <= 0) return false
  const start = Math.max(0, Math.trunc(Number.isFinite(fromIndex) ? fromIndex : 0))
  return cache.startIndex <= start
}

/**
 * 从缓存切出以 fromIndex 为起点的尾窗（供 chainInWindow / slicePageBefore 使用）；
 * 缓存不够旧时从缓存最旧处开始（调用方可用 historyCacheCovers 判断是否需要补拉）。
 * 空缓存/非法起点返回 null。
 */
export function historyWindowFrom(cache: HistoryCache | null, fromIndex = 0): EntriesResult | null {
  if (!cache || cache.total <= 0 || !cache.entries.length) return null
  const requested = Math.max(0, Math.trunc(Number.isFinite(fromIndex) ? fromIndex : 0))
  const start = Math.max(cache.startIndex, Math.min(requested, cache.total))
  if (start >= cache.total) return null
  return { entries: cache.entries.slice(start - cache.startIndex), total: cache.total, leafId: cache.leafId }
}

/** 缓存里是否已有某个 entryId（诊断/测试用；分页仍以窗口下标为准）。 */
export function historyCacheHas(cache: HistoryCache | null, entryId: string): boolean {
  return !!cache && !!entryId && cache.indexById.has(entryId)
}
