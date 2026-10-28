/**
 * 改动视图（PaneContainer 的"改动"，design §3.4 changes-pane、§7.2；G5）。纯函数，node --test 直接加载。
 * 有哪些文件、计数、合计照 changes.ts 的 changesOfSession（和 tray"改动 +N −M"同一个口径）；视图里的文件按最近一次改到它的先后排，
 * 最近改的在最上面（replica changes-pane 的排法：viewport 第 4 次编辑在最前，新测试文件第 1 次编辑在最后），部件默认展开第一个。
 * 这里还把每个文件的行按编辑先后分段，并补上"N 行未改动"折叠条：
 * - 折叠条按新文件行号的断档算（context / 增行写新号；删行写旧号，不参与），只在 patch 带行号时有；第一段改动之前的行也算。
 *   最后一段之后还有多少行不知道（patch 里没有文件总行数），不画。
 * - 同一文件编辑了几次，第 2 次起在前面放一条"第 N 次编辑"分隔条（design changes-pane states）。
 * - isNew（"New"徽标，推断）：这个文件在本会话里第一次出现是 write，而且之前没有 read / edit 过它。write 没有 details，
 *   覆盖写和新建分不出来，只能这样推；read 过再 write 的不算新文件。
 * - truncated：有一次编辑的 patch 超过 200k 字被截断（G5），计数只是下限，界面要写明。
 */
import type { Block, Item } from "../../relay/transcript.ts"
import { changesOfSession } from "./changes.ts"
import { diffRowsFromEdit, type PiDiffLine } from "./diffRows.ts"

/** 折叠条（形状同 kit DiffFold）：未改动的行用默认带把手的条；"第 N 次编辑"分隔条用 plain（不能展开，没有把手） */
export type PiFoldRow = { kind: "fold"; count: number; label: string; variant?: "plain" }
export type PiPaneDiffRow = PiDiffLine | PiFoldRow

export type PiChangedFileView = {
  path: string
  added: number
  removed: number
  isNew: boolean
  edits: number
  rows: PiPaneDiffRow[]
  truncated?: true
}

export type PiChangesView = { files: PiChangedFileView[]; added: number; removed: number; truncated: boolean }

type ToolBlock = Extract<Block, { kind: "tool" }>

const EDIT_TOOLS = new Set(["edit", "write", "multi_edit"])
const READ_TOOLS = new Set(["read", "read_file"])

function pathOf(input: Record<string, unknown> | undefined): string | null {
  const p = input?.path ?? input?.file_path
  return typeof p === "string" && p ? p : null
}

export function unmodifiedLabel(count: number): string {
  return `${count} 行未改动`
}

/** 一次编辑的行 → 补上"N 行未改动"折叠条（按新文件行号的断档；没有行号的行原样返回） */
export function foldRowsOf(rows: readonly PiDiffLine[]): PiPaneDiffRow[] {
  const out: PiPaneDiffRow[] = []
  /** 上一条带新行号的行（context / add）的行号；null = 还没遇到 */
  let last: number | null = null
  /** 上一条 context / add 行之后的位置：断档的折叠条插在这里（后面紧跟的删行属于下一段改动） */
  let insertAt = 0
  for (const row of rows) {
    if (row.kind === "del" || row.n == null) {
      out.push(row)
      continue
    }
    const gap = last === null ? row.n - 1 : row.n - last - 1
    if (gap > 0) out.splice(insertAt, 0, { kind: "fold", count: gap, label: unmodifiedLabel(gap) })
    out.push(row)
    last = row.n
    insertAt = out.length
  }
  return out
}

/** 会话条目 → 改动视图；一个文件都没有时返回 null（版头写"这个会话还没有编辑文件"由容器决定） */
export function changesViewOf(items: readonly Item[] | null | undefined): PiChangesView | null {
  const summary = changesOfSession(items)
  if (!summary || !items) return null
  /** 每个文件：第一次被碰到时是不是 write、之前读没读过；各次编辑的行；最近一次成功编辑的序号 */
  const firstTouch = new Map<string, "write" | "edit" | "read">()
  const edits = new Map<string, PiDiffLine[][]>()
  const lastEdit = new Map<string, number>()
  let seq = 0
  for (const item of items) {
    if (item.kind !== "assistant") continue
    for (const block of item.blocks) {
      if (block.kind !== "tool") continue
      const name = block.name.trim().toLowerCase()
      const path = pathOf(block.input)
      if (!path) continue
      if (READ_TOOLS.has(name)) {
        if (!firstTouch.has(path)) firstTouch.set(path, "read")
        continue
      }
      if (!EDIT_TOOLS.has(name)) continue
      if (!firstTouch.has(path)) firstTouch.set(path, name === "write" ? "write" : "edit")
      // 同 changesOfSession：只算成功的工具调用、推得出 diff 的
      if ((block as ToolBlock).state !== "output-available") continue
      const diff = diffRowsFromEdit(block.input, block)
      if (!diff) continue
      const list = edits.get(path) ?? []
      list.push(diff.rows)
      edits.set(path, list)
      lastEdit.set(path, seq++)
    }
  }
  const ordered = [...summary.files].sort((a, b) => (lastEdit.get(b.path) ?? -1) - (lastEdit.get(a.path) ?? -1))
  const files = ordered.map((f): PiChangedFileView => {
    const parts = edits.get(f.path) ?? [f.rows]
    const rows: PiPaneDiffRow[] = []
    parts.forEach((part, k) => {
      if (k > 0) rows.push({ kind: "fold", count: 0, label: `第 ${k + 1} 次编辑`, variant: "plain" })
      rows.push(...foldRowsOf(part))
    })
    return {
      path: f.path,
      added: f.added,
      removed: f.removed,
      isNew: firstTouch.get(f.path) === "write",
      edits: f.edits,
      rows,
      ...(f.truncated ? { truncated: true as const } : {}),
    }
  })
  return { files, added: summary.added, removed: summary.removed, truncated: files.some((f) => f.truncated) }
}
