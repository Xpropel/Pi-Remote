// UI·relay 中-5：历史补拉窗口缓存（纯函数；不联网）。
// 目标：尾窗重叠段按 entryId/下标复用；缓存覆盖目标窗口时零请求切页；
// 只有缓存盖不住时才补拉，且向前多留 margin；换分支/回退/换房一律重建。
import test from "node:test"
import assert from "node:assert/strict"
import { chainInWindow, slicePageBefore } from "../ui/src/relay/history.ts"
import {
  HISTORY_CACHE_FETCH_MARGIN,
  HISTORY_CACHE_MAX_ENTRIES,
  createHistoryCache,
  historyCacheCovers,
  historyCacheHas,
  historyWindowFrom,
  mergeHistoryWindow,
} from "../ui/src/relay/historyCache.ts"

/** e0 → e1 → … → e(n-1) 的单链会话（user/assistant 交替，全部可见）。 */
function chainOf(n) {
  const entries = []
  for (let i = 0; i < n; i += 1) {
    entries.push({
      id: `e${i}`,
      parentId: i ? `e${i - 1}` : null,
      type: "message",
      timestamp: 1700000000000 + i * 1000,
      message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }], timestamp: 1700000000000 + i * 1000 },
    })
  }
  return entries
}

const all = chainOf(30)
const tailWindow = (from, total = all.length) => ({ entries: all.slice(from), total, leafId: `e${total - 1}` })

test("合并尾窗：重叠段复用缓存对象（同 entryId 不重建），窗口起点按 total 推导", () => {
  let cache = createHistoryCache("room-1")
  cache = mergeHistoryWindow(cache, "room-1", tailWindow(20))
  assert.equal(cache.total, 30)
  assert.equal(cache.startIndex, 20)
  assert.deepEqual(cache.entries.map((entry) => entry.id), all.slice(20).map((entry) => entry.id))
  assert.equal(historyCacheCovers(cache, 25), true)
  assert.equal(historyCacheCovers(cache, 12), false)
  assert.equal(historyCacheHas(cache, "e21"), true)
  assert.equal(historyCacheHas(cache, "e2"), false)

  const firstTail = cache.entries.map((entry) => entry) // 引用快照
  cache = mergeHistoryWindow(cache, "room-1", tailWindow(0))
  assert.equal(cache.startIndex, 0)
  // 重叠段（20..29）必须是同一批对象，不重新构造
  for (let i = 0; i < 10; i += 1) assert.equal(cache.entries[20 + i], firstTail[i], `e${20 + i} 应复用缓存对象`)
  assert.deepEqual(historyWindowFrom(cache, 12)?.entries.map((entry) => entry.id), all.slice(12).map((entry) => entry.id))
})

test("只补新增窗口：缓存向前留 margin 后，多页补拉不再发请求", () => {
  let cache = createHistoryCache("room-1")
  cache = mergeHistoryWindow(cache, "room-1", tailWindow(0))
  // 模拟从游标 200 开始每次往旧翻 60 条（这里用 30 条的会话缩小规模）：缓存一次覆盖后全部命中
  assert.equal(historyCacheCovers(cache, 0), true)
  let cursor = 24
  for (let page = 0; page < 3; page += 1) {
    const fromIndex = Math.max(0, cursor - 4) // 每页窗口 4 条
    const win = historyCacheCovers(cache, fromIndex) ? historyWindowFrom(cache, fromIndex) : null
    assert.ok(win, `第 ${page + 1} 页必须命中缓存（不再请求 get_entries）`)
    const chain = chainInWindow(win, `e${cursor}`)
    const slice = slicePageBefore(chain, `e${cursor}`, 2)
    assert.ok(slice.messages.length > 0)
    cursor = slice.oldest.index
  }
  assert.equal(HISTORY_CACHE_FETCH_MARGIN, 384)
})

test("total 增长（leafId 前移）：接缝 parentId 对得上就拼接，重叠段复用缓存对象", () => {
  let cache = mergeHistoryWindow(createHistoryCache("room-1"), "room-1", tailWindow(20)) // [20..29], total 30
  const oldTail = cache.entries.slice()
  const grown = chainOf(40)
  cache = mergeHistoryWindow(cache, "room-1", { entries: grown.slice(25), total: 40, leafId: "e39" })
  assert.equal(cache.total, 40)
  assert.equal(cache.startIndex, 20, "新窗口与旧缓存重叠，20..39 连续")
  assert.equal(cache.leafId, "e39", "leafId 随追加前移，不是重建理由")
  assert.deepEqual(cache.entries.map((entry) => entry.id), grown.slice(20).map((entry) => entry.id))
  // 重叠段（20..29）复用旧对象，不因 leafId 前移重建
  for (let i = 0; i < 10; i += 1) assert.equal(cache.entries[i], oldTail[i], `e${20 + i} 应复用缓存对象`)
})

test("缓存盖不住时按新 total 补第二次：第一次 limit 以旧 total 算够不到目标起点", () => {
  let cache = mergeHistoryWindow(createHistoryCache("room-1"), "room-1", tailWindow(20)) // [20..29], total 30
  const grown = chainOf(40)
  const targetStart = 5
  const knownTotal = cache.total
  const limit1 = knownTotal - targetStart // 25
  // 第一次：实际尾窗 = 40 条里最后 25 条 → [15..39]，起点 15 > targetStart
  cache = mergeHistoryWindow(cache, "room-1", { entries: grown.slice(grown.length - limit1), total: 40, leafId: "e39" })
  assert.equal(cache.startIndex, 15)
  assert.equal(historyCacheCovers(cache, targetStart), false)
  // 第二次：useRelay 发现 cache.startIndex > targetStart 且 total 增长 → 按新 total 40 请求 → 覆盖目标起点
  const limit2 = cache.total - targetStart // 35
  cache = mergeHistoryWindow(cache, "room-1", { entries: grown.slice(grown.length - limit2), total: 40, leafId: "e39" })
  assert.equal(cache.startIndex, targetStart)
  assert.equal(historyCacheCovers(cache, targetStart), true)
})

test("上限裁剪：超过上限只留最靠近尾部的一段，更早的历史仍可重新拉取", () => {
  const cache = mergeHistoryWindow(createHistoryCache("room-1"), "room-1", tailWindow(0), 8)
  assert.equal(cache.entries.length, 8)
  assert.equal(cache.startIndex, all.length - 8)
  assert.equal(historyCacheCovers(cache, 10), false)
  assert.equal(historyCacheCovers(cache, 25), true)
  assert.equal(HISTORY_CACHE_MAX_ENTRIES, 16384)
})

test("重建条件：分支改写（接缝 entryId/parentId 对不上）/ total 回退 / 换房都不拿旧条目拼接", () => {
  const base = mergeHistoryWindow(createHistoryCache("room-1"), "room-1", tailWindow(10))
  const branch = mergeHistoryWindow(base, "room-1", { entries: [all[2], all[3]], total: 12, leafId: "other" })
  assert.equal(branch.leafId, "other")
  assert.equal(branch.startIndex, 10, "换分支只信新窗口")
  assert.deepEqual(branch.entries.map((entry) => entry.id), ["e2", "e3"])

  const shrunk = mergeHistoryWindow(base, "room-1", { entries: all.slice(0, 5), total: 5, leafId: base.leafId })
  assert.equal(shrunk.total, 5)
  assert.equal(shrunk.startIndex, 0)
  assert.equal(shrunk.entries.length, 5)

  const otherRoom = mergeHistoryWindow(base, "room-2", tailWindow(20))
  assert.equal(otherRoom.room, "room-2")
  assert.equal(otherRoom.startIndex, 20)
  assert.equal(historyCacheCovers(otherRoom, 10), false)

  // 无重叠的追加窗：首条 parentId 必须指向缓存最后一条，否则按新分支重建
  const forked = mergeHistoryWindow(base, "room-1", {
    entries: [
      { id: "x0", parentId: "elsewhere", type: "message", message: { role: "user", content: [] } },
      { id: "x1", parentId: "x0", type: "message", message: { role: "assistant", content: [] } },
    ],
    total: 32,
    leafId: "x1",
  })
  assert.equal(forked.startIndex, 30)
  assert.deepEqual(forked.entries.map((entry) => entry.id), ["x0", "x1"])
})

test("空回包 / 全空消息链：窗口为空但状态合法（不抛错、不伪造条目）", () => {
  const empty = mergeHistoryWindow(createHistoryCache("room-1"), "room-1", { entries: [], total: 0, leafId: null })
  assert.equal(empty.total, 0)
  assert.equal(empty.startIndex, 0)
  assert.deepEqual(empty.entries, [])
  assert.equal(historyWindowFrom(empty, 0), null)
  assert.equal(historyCacheCovers(empty, 0), false)
  // 尾窗为空但 total>0（服务端只回 total）：不产生假条目
  const headless = mergeHistoryWindow(empty, "room-1", { entries: [], total: 12, leafId: "e11" })
  assert.equal(headless.total, 12)
  assert.deepEqual(headless.entries, [])
  assert.equal(historyWindowFrom(headless, 0), null)
})

test("切页语义与旧实现一致：缓存窗口切出的消息与整段尾窗切页逐条相同", () => {
  const full = { entries: all, total: all.length, leafId: "e29" }
  const direct = slicePageBefore(chainInWindow(full, "e20"), "e20", 6)
  const cache = mergeHistoryWindow(createHistoryCache("room-1"), "room-1", tailWindow(14))
  const cached = slicePageBefore(chainInWindow(historyWindowFrom(cache, 14), "e20"), "e20", 6)
  assert.deepEqual(cached.messages, direct.messages)
  assert.equal(cached.oldest.id, direct.oldest.id)
  assert.equal(cached.itemCount, direct.itemCount)
})
