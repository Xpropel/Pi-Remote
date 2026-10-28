/**
 * 改动视图的数据（design §3.4 changes-pane、§1.7 改动 pill、§10）。纯函数，node --test 直接加载。
 * 只根据本会话的 edit / write 工具记录，不是 git 状态（版头文案由部件写）。推不出改动的工具调用整行不出现。
 */
import type { Item } from "../../relay/transcript.ts"
import { diffRowsFromEdit, type PiDiffLine } from "./diffRows.ts"

/** truncated：有一次编辑的 patch 被截断（G5，200k 字上限），计数只是下限 */
export type PiChangedFile = { path: string; added: number; removed: number; rows: PiDiffLine[]; edits: number; truncated?: true }
export type PiSessionChanges = { files: PiChangedFile[]; added: number; removed: number }

const EDIT_TOOLS = new Set(["edit", "write", "multi_edit"])

function pathOf(input: Record<string, unknown> | undefined): string | null {
  const p = input?.path ?? input?.file_path
  return typeof p === "string" && p ? p : null
}

/**
 * 会话条目 → 按文件汇总的改动（文件顺序 = 第一次改到它的顺序；同一文件多次编辑的行依次接上）。
 * 只算成功的工具调用（output-available）；没有路径或推不出 diff 的跳过。一个文件都没有时返回 null。
 * 工具块上有 patch（transcript 从 edit 的 details.patch 提升，G5）时优先用它，带文件行号；没有时回落到入参推算。
 */
export function changesOfSession(items: readonly Item[] | null | undefined): PiSessionChanges | null {
  if (!items) return null
  const byPath = new Map<string, PiChangedFile>()
  for (const item of items) {
    if (item.kind !== "assistant") continue
    for (const block of item.blocks) {
      if (block.kind !== "tool" || block.state !== "output-available") continue
      if (!EDIT_TOOLS.has(block.name.trim().toLowerCase())) continue
      const path = pathOf(block.input)
      if (!path) continue
      const diff = diffRowsFromEdit(block.input, block)
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
  return { files, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) }
}
