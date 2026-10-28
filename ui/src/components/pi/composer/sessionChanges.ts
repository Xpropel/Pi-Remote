// 相对导入（带 .ts）是刻意的：本模块是纯逻辑，node --test 直接加载（同 pi/model/** / relay/transcript.ts 的做法）；
// 类型导入同理，运行时会被类型剥离擦掉。
import { diffRowsFromEdit, type PiDiffRows } from "../../../pi/model/diffRows.ts"
import type { PiChangedFile, PiSessionChanges } from "@/pi/model/changes"
import type { Block, Item } from "@/relay/transcript"

/**
 * 会话改动（tray 上的「改动 +N −M」、改动 pane 的汇总）的**增量**派生（UI·perf 中-2）。
 *
 * 口径与 pi/model/changes.ts 的 `changesOfSession` 完全一致（权威定义在那边：只算成功的 edit / write / multi_edit、
 * 有路径、推得出 diff 的；同一文件多次编辑依次接上；工具块上的 patch 优先）。这里只多一层缓存：
 *
 * - 每条工具块的 diff 结果按**工具调用 id** 缓存，签名 = 状态 + input 对象身份 + patch 长度 + patchTruncated；
 *   流式时 items 每 50ms 换一次引用、还在长的那条助手消息连 blocks 都是新的，但已落定编辑的签名不变 →
 *   不再重跑行级 diff（旧实现每帧对每个历史 edit 重跑一次 LCS，长会话就卡在这儿）。
 * - 缓存只增不减会有上界：超过 PI_CHANGES_CACHE_MAX 条直接清空（会话里的编辑调用远达不到这个量级）。
 *
 * 纯逻辑，不碰 React：容器用 `useRef(createChangesCache())` 持有，测试直接对照 `changesOfSession`。
 */
export type PiChangesCache = {
  /** 工具调用 id → 该块的 diff 结果 */
  blocks: Map<string, { sig: string; diff: PiDiffRows | null }>
  /** 给 input 对象分身份用的 WeakMap（对象身份不变 = 参数没变） */
  inputs: WeakMap<object, number>
  nextInputId: number
  /** 真正重跑 diff 的次数（测试用来确认“没变就不重算”） */
  computes: number
  /** 签名命中、直接复用缓存的次数 */
  hits: number
}

/** 缓存条数上限：超过就整体清空（编辑类工具调用在单个会话里数量很小） */
export const PI_CHANGES_CACHE_MAX = 2048

const EDIT_TOOLS = new Set(["edit", "write", "multi_edit"])

export function createChangesCache(): PiChangesCache {
  return { blocks: new Map(), inputs: new WeakMap(), nextInputId: 0, computes: 0, hits: 0 }
}

function pathOf(input: Record<string, unknown> | undefined): string | null {
  const path = input?.path ?? input?.file_path
  return typeof path === "string" && path ? path : null
}

function inputIdOf(cache: PiChangesCache, input: Record<string, unknown> | null | undefined): number {
  if (!input) return 0
  const known = cache.inputs.get(input)
  if (known !== undefined) return known
  cache.nextInputId += 1
  cache.inputs.set(input, cache.nextInputId)
  return cache.nextInputId
}

/** 这条工具块的 diff 会不会变：状态、入参对象、patch 长度（patch 只在工具结束时整段到达一次） */
function signatureOf(cache: PiChangesCache, block: Extract<Block, { kind: "tool" }>): string {
  const patch = typeof block.patch === "string" ? block.patch : ""
  return `${block.state}\u0000${inputIdOf(cache, block.input)}\u0000${patch.length}\u0000${block.patchTruncated === true ? 1 : 0}`
}

function diffOf(cache: PiChangesCache, block: Extract<Block, { kind: "tool" }>): PiDiffRows | null {
  const sig = signatureOf(cache, block)
  const cached = block.id ? cache.blocks.get(block.id) : undefined
  if (cached && cached.sig === sig) {
    cache.hits += 1
    return cached.diff
  }
  cache.computes += 1
  const diff = diffRowsFromEdit(block.input, block)
  if (block.id) {
    if (cache.blocks.size >= PI_CHANGES_CACHE_MAX) cache.blocks.clear()
    cache.blocks.set(block.id, { sig, diff })
  }
  return diff
}

/**
 * 与 `changesOfSession` 同口径的增量版：返回形状、文件顺序、计数、truncated 标记全部一致。
 * 一条改动都没有时返回 null（整块 pill 不出现）。
 */
export function changesOfSessionCached(items: readonly Item[] | null | undefined, cache: PiChangesCache): PiSessionChanges | null {
  if (!items) return null
  const byPath = new Map<string, PiChangedFile>()
  for (const item of items) {
    if (item.kind !== "assistant") continue
    for (const block of item.blocks) {
      if (block.kind !== "tool" || block.state !== "output-available") continue
      if (!EDIT_TOOLS.has(block.name.trim().toLowerCase())) continue
      const path = pathOf(block.input)
      if (!path) continue
      const diff = diffOf(cache, block)
      if (!diff) continue
      const file = byPath.get(path) ?? { path, added: 0, removed: 0, rows: [], edits: 0 }
      file.added += diff.added
      file.removed += diff.removed
      file.rows.push(...diff.rows)
      file.edits++
      if (diff.truncated) file.truncated = true
      byPath.set(path, file)
    }
  }
  if (byPath.size === 0) return null
  const files = [...byPath.values()]
  return { files, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0) }
}
