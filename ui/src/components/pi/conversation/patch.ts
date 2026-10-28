/**
 * edit 工具的 details.patch（unified diff 文本）→ kit UnifiedDiff 的行（修 K10：patch 进 diff 卡）。
 * - 行号一列：context / add 写新文件行号，del 写旧文件行号（kit DiffLine 约定）。
 * - 着色只看行首 + / −，不信 hunk 头里的计数（修 U-10：计数不准也照样着色）。
 * - 词级高亮：一段连续删行紧跟一段连续增行时逐行配对，按词求公共前后缀，中间不同的部分标出；
 *   整行都不同（差异超过 70%）时不标，免得满行色块（推断，与常见 diff 工具的做法一致）。
 */
import type { DiffFold, DiffLine, DiffRow } from "@/components/kit"

export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface ParsedPatch {
  hunks: PatchHunk[]
  added: number
  removed: number
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parsePatch(patch: string): ParsedPatch {
  const hunks: PatchHunk[] = []
  let cur: PatchHunk | null = null
  let o = 0
  let n = 0
  let added = 0
  let removed = 0
  for (const raw of patch.split("\n")) {
    const h = HUNK.exec(raw)
    if (h) {
      cur = {
        oldStart: Number(h[1]),
        oldLines: h[2] != null ? Number(h[2]) : 1,
        newStart: Number(h[3]),
        newLines: h[4] != null ? Number(h[4]) : 1,
        lines: [],
      }
      hunks.push(cur)
      o = cur.oldStart
      n = cur.newStart
      continue
    }
    // 文件头（diff / index / --- / +++）和 "\ No newline at end of file" 不是代码行
    if (!cur || raw.startsWith("\\")) continue
    const tag = raw[0]
    if (tag === "+") {
      cur.lines.push({ kind: "add", n: n++, text: raw.slice(1) })
      added++
    } else if (tag === "-") {
      cur.lines.push({ kind: "del", n: o++, text: raw.slice(1) })
      removed++
    } else if (tag === " " || raw === "") {
      // 空的 context 行有些工具会去掉行首空格；补拉的末尾空串也落在这里，超出 hunk 计数时丢弃
      const used = cur.lines.filter((l) => l.kind !== "del").length
      if (raw === "" && used >= cur.newLines) continue
      cur.lines.push({ kind: "context", n: n++, text: raw.slice(1) })
      o++
    }
  }
  for (const hunk of hunks) markWords(hunk.lines)
  return { hunks, added, removed }
}

/** write 新文件：全部是增行 */
export function contentToRows(content: string): DiffLine[] {
  const lines = content.replace(/\n$/, "").split("\n")
  return lines.map((text, i) => ({ kind: "add" as const, n: i + 1, text }))
}

/**
 * 多个 hunk 拼成一份行表，hunk 之间、第一个 hunk 之前、（给了 totalNew 时）最后一个 hunk 之后插入"N 行未改动"折叠条。
 * 行数全部由 hunk 头和新文件总行数算出，不另填。
 */
export function hunksToRows(hunks: readonly PatchHunk[], fold?: Partial<DiffFold>, totalNew?: number): DiffRow[] {
  const rows: DiffRow[] = []
  let next = 1
  const sorted = [...hunks].sort((a, b) => a.newStart - b.newStart)
  const bar = (count: number): DiffFold => ({ kind: "fold", count, label: `${count} 行未改动`, ...fold })
  for (const hunk of sorted) {
    const gap = hunk.newStart - next
    if (gap > 0) rows.push(bar(gap))
    rows.push(...hunk.lines)
    next = hunk.newStart + hunk.newLines
  }
  if (totalNew != null && totalNew >= next) rows.push(bar(totalNew - next + 1))
  return rows
}

/**
 * 两个版本的文件 → unified patch 文本（LCS 行级 diff，上下文 3 行）。mock 用它从同一份文件内容推出
 * edit 的 details.patch、改动视图的汇总 diff 和 read 的输出，保证几个屏幕上的行号、计数彼此一致。
 */
export function unifiedPatch(path: string, a: readonly string[], b: readonly string[], context = 3): string {
  const n = a.length
  const m = b.length
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  type Op = { t: " " | "-" | "+"; text: string; o: number; n: number }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ t: " ", text: a[i], o: ++i, n: ++j })
    else if (j >= m || (i < n && L[i + 1][j] >= L[i][j + 1])) ops.push({ t: "-", text: a[i], o: ++i, n: j })
    else ops.push({ t: "+", text: b[j], o: i, n: ++j })
  }
  // 一段改动里先删后增（与 git 的输出一致）
  for (let s = 0; s < ops.length; ) {
    if (ops[s].t === " ") {
      s++
      continue
    }
    let e = s
    while (e < ops.length && ops[e].t !== " ") e++
    const block = ops.slice(s, e)
    ops.splice(s, e - s, ...block.filter((x) => x.t === "-"), ...block.filter((x) => x.t === "+"))
    s = e
  }
  const changed = ops.map((op, k) => (op.t !== " " ? k : -1)).filter((k) => k >= 0)
  if (changed.length === 0) return ""
  const out = [`--- a/${path}`, `+++ b/${path}`]
  let k = 0
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context)
    let end = Math.min(ops.length - 1, changed[k] + context)
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) {
      k++
      end = Math.min(ops.length - 1, changed[k] + context)
    }
    k++
    const slice = ops.slice(start, end + 1)
    const oldCount = slice.filter((x) => x.t !== "+").length
    const newCount = slice.filter((x) => x.t !== "-").length
    const first = slice[0]
    const oldStart = first.t === "+" ? first.o + 1 : first.o
    const newStart = first.t === "-" ? first.n + 1 : first.n
    out.push(`@@ -${oldCount === 0 ? oldStart - 1 : oldStart},${oldCount} +${newCount === 0 ? newStart - 1 : newStart},${newCount} @@`)
    for (const x of slice) out.push(`${x.t}${x.text}`)
  }
  return out.join("\n") + "\n"
}

/** 只要代码行（流内 diff 卡：没有折叠条） */
export function patchLines(patch: string): { rows: DiffLine[]; added: number; removed: number } {
  const p = parsePatch(patch)
  return { rows: p.hunks.flatMap((h) => h.lines), added: p.added, removed: p.removed }
}

/* ------------------------------------------------------------------ 词级高亮 */

const WORD = /(\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$])/g

function words(text: string): string[] {
  return text.match(WORD) ?? []
}

function markWords(lines: DiffLine[]) {
  let i = 0
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i++
      continue
    }
    const delStart = i
    while (i < lines.length && lines[i].kind === "del") i++
    const addStart = i
    while (i < lines.length && lines[i].kind === "add") i++
    const pairs = Math.min(addStart - delStart, i - addStart)
    for (let k = 0; k < pairs; k++) {
      const del = lines[delStart + k]
      const add = lines[addStart + k]
      const [dm, am] = diffMarks(del.text, add.text)
      if (dm) lines[delStart + k] = { ...del, marks: [dm] }
      if (am) lines[addStart + k] = { ...add, marks: [am] }
    }
  }
}

type Range = readonly [number, number]

function diffMarks(a: string, b: string): [Range | null, Range | null] {
  const wa = words(a)
  const wb = words(b)
  let pre = 0
  while (pre < wa.length && pre < wb.length && wa[pre] === wb[pre]) pre++
  let suf = 0
  while (suf < wa.length - pre && suf < wb.length - pre && wa[wa.length - 1 - suf] === wb[wb.length - 1 - suf]) suf++
  const range = (w: string[]): Range | null => {
    const start = w.slice(0, pre).join("").length
    const end = w.join("").length - w.slice(w.length - suf).join("").length
    if (end <= start) return null
    // 只差行首缩进时不标
    if (w.slice(pre, w.length - suf).join("").trim() === "") return null
    return [start, end]
  }
  const ra = range(wa)
  const rb = range(wb)
  const ratio = (r: Range | null, s: string) => (r ? (r[1] - r[0]) / Math.max(1, s.trim().length) : 0)
  if (ratio(ra, a) > 0.7 && ratio(rb, b) > 0.7) return [null, null]
  return [ra, rb]
}
