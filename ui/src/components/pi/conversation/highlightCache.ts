/**
 * 代码高亮的跨挂载缓存（UI 低危 19）：翻页 / 切视图回来时，同一个代码块（同 lang + 同 code）不再重新跑
 * shiki、也不再先闪一帧纯文本。
 *
 * 为什么不改 ui/src/pi/hooks/useHighlightLines.ts：那个 hook 只按当前挂载存结果，卸载即丢。缓存放在
 * 这里（conversation 自己的模块）后，PiCodeBlock / PiFilePane 换用它，其它消费方行为不变。
 *
 * 口径：
 *  - 只缓存成功的着色结果（不认识的语言 / shiki 加载失败返回 null，不缓存，下次还能重试）；
 *  - 键是 (lang, code)，语言不同的同一段代码各存一份；
 *  - 条数与源码字符数双上限，淘汰最久未用的；超过单条上限的大文件不缓存（缓存它不划算）；
 *  - 并发的相同请求共用同一个 Promise，避免一次重挂载把同一块着色两次；
 *  - 本模块不依赖 React / DOM，node --test 直接测（loader 可注入）。
 */
import { highlightToLines, type HighlightLine } from "../../../pi/model/highlight.ts"

/** 最多缓存多少块（按 lang + code 计） */
export const HIGHLIGHT_CACHE_MAX_ENTRIES = 32
/** 缓存源码字符总数上限（着色结果是它的若干倍，这里按源码计一个保守的账） */
export const HIGHLIGHT_CACHE_MAX_CHARS = 512 * 1024
/** 单块源码超过这个长度就不缓存（避免一块 256KB 的文件把整个缓存挤爆） */
export const HIGHLIGHT_CACHE_MAX_ENTRY_CHARS = 128 * 1024

export type HighlightLoader = (code: string, lang: string) => Promise<HighlightLine[] | null>

type CacheEntry = { code: string; lang: string; lines: HighlightLine[]; chars: number; used: number }

/** lang → (code → 结果)；嵌套 Map 让 code 原串直接当键（不拼接、不复制大字符串） */
const cache = new Map<string, Map<string, CacheEntry>>()
const entries: CacheEntry[] = []
let totalChars = 0
let clock = 0

/** 命中返回着色行（空数组也是命中）；未命中返回 undefined。不改变最近使用顺序（渲染期不写状态）。 */
export function cachedHighlight(code: string, lang: string): HighlightLine[] | undefined {
  return cache.get(lang)?.get(code)?.lines
}

/** 标记命中一次（hook 在 effect 里调，翻页回来时把这块挪到"最近使用"）。 */
export function touchCachedHighlight(code: string, lang: string): void {
  const entry = cache.get(lang)?.get(code)
  if (entry) entry.used = ++clock
}

function removeEntry(entry: CacheEntry): void {
  const bucket = cache.get(entry.lang)
  if (bucket?.get(entry.code) === entry) {
    bucket.delete(entry.code)
    if (!bucket.size) cache.delete(entry.lang)
  }
  const at = entries.indexOf(entry)
  if (at >= 0) entries.splice(at, 1)
  totalChars = Math.max(0, totalChars - entry.chars)
}

function evictOverflow(): void {
  while (entries.length > HIGHLIGHT_CACHE_MAX_ENTRIES || totalChars > HIGHLIGHT_CACHE_MAX_CHARS) {
    // 只有一条时也删：宁可下次重着色，也不让单块把上限顶穿
    let oldest = entries[0]
    for (const entry of entries) if (entry.used < oldest.used) oldest = entry
    removeEntry(oldest)
  }
}

/** 写入一份成功的着色结果；超单条上限的直接不缓存。 */
export function cacheHighlight(code: string, lang: string, lines: HighlightLine[]): void {
  if (code.length > HIGHLIGHT_CACHE_MAX_ENTRY_CHARS) return
  const existing = cache.get(lang)?.get(code)
  if (existing) {
    existing.lines = lines
    existing.used = ++clock
    return
  }
  const entry: CacheEntry = { code, lang, lines, chars: code.length, used: ++clock }
  let bucket = cache.get(lang)
  if (!bucket) {
    bucket = new Map()
    cache.set(lang, bucket)
  }
  bucket.set(code, entry)
  entries.push(entry)
  totalChars += entry.chars
  evictOverflow()
}

/** 清空（测试用；产品里不需要主动清） */
export function clearHighlightCache(): void {
  cache.clear()
  entries.length = 0
  totalChars = 0
  clock = 0
}

/** 缓存现状（测试断言条数/字符账用） */
export function highlightCacheStats(): { entries: number; chars: number } {
  return { entries: entries.length, chars: totalChars }
}

const inflight = new Map<string, Map<string, Promise<HighlightLine[] | null>>>()

/**
 * 取着色结果：先查缓存，未命中再调 loader（默认 shiki），并发的同键请求共用一次。
 * loader 失败 / 返回 null 时不写缓存（下次挂载还能重试），函数本身不抛。
 */
export function highlightLinesFor(code: string, lang: string, load: HighlightLoader = highlightToLines): Promise<HighlightLine[] | null> {
  const hit = cachedHighlight(code, lang)
  if (hit !== undefined) return Promise.resolve(hit)
  let bucket = inflight.get(lang)
  if (!bucket) {
    bucket = new Map()
    inflight.set(lang, bucket)
  }
  const running = bucket.get(code)
  if (running) return running
  const task = (async () => {
    try {
      const lines = await load(code, lang)
      if (lines) cacheHighlight(code, lang, lines)
      return lines
    } catch {
      return null
    }
  })()
  bucket.set(code, task)
  void task.finally(() => {
    const current = inflight.get(lang)
    if (current?.get(code) === task) {
      current.delete(code)
      if (!current.size) inflight.delete(lang)
    }
  })
  return task
}
