/**
 * edit / write 工具 → diff 行（design §1.5 修 K10、§10）。纯函数，node --test 直接加载。
 * 数据优先取 patch（工具块上由 transcript 从 edit 的 details.patch 提升，G5；unified diff，口径同 replica b/patch.ts parsePatch：
 * 着色只看行首 + / −，不信 hunk 计数）；patch 被截断（patchTruncated）时照样用，结果带 truncated，计数只是下限；
 * 没有 patch 时用 args：edit 的 oldText / newText（或 edits[]），write 的 content（新文件，全是增行）。
 * 行结构与 kit DiffLine 同形；args 推出的 edit 行没有文件行号（不知道改在文件哪里），n 为 null，不编。
 */

export type PiDiffLine = { kind: "add" | "del" | "context"; n: number | null; text: string }
export type PiDiffRows = { rows: PiDiffLine[]; added: number; removed: number; source: "patch" | "args"; truncated?: true }
/** 改动数据：工具块上提升出来的 patch 字段（transcript Block 的 patch / patchTruncated） */
export type PiPatchSource = { patch?: unknown; patchTruncated?: unknown }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
/** LCS 的格子上限；超过就退化成"全删 + 全增"，免得大文件卡住界面 */
const LCS_CELLS = 250_000

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

function count(rows: PiDiffLine[], source: PiDiffRows["source"]): PiDiffRows {
  return { rows, added: rows.filter((r) => r.kind === "add").length, removed: rows.filter((r) => r.kind === "del").length, source }
}

/** unified diff 文本 → 行（文件头、"\ No newline" 跳过）；没有任何 hunk 时返回 null */
export function rowsFromPatch(patch: string): PiDiffRows | null {
  const rows: PiDiffLine[] = []
  let inHunk = false
  let o = 0
  let n = 0
  let newLeft = 0
  for (const raw of patch.split("\n")) {
    const h = HUNK.exec(raw)
    if (h) {
      inHunk = true
      o = Number(h[1])
      n = Number(h[3])
      newLeft = h[4] != null ? Number(h[4]) : 1
      continue
    }
    if (!inHunk || raw.startsWith("\\")) continue
    if (raw.startsWith("+")) {
      rows.push({ kind: "add", n: n++, text: raw.slice(1) })
      newLeft--
    } else if (raw.startsWith("-")) {
      rows.push({ kind: "del", n: o++, text: raw.slice(1) })
    } else if (raw.startsWith(" ") || raw === "") {
      // 空 context 行有些工具会去掉行首空格；超出 hunk 计数的末尾空串丢掉
      if (raw === "" && newLeft <= 0) continue
      rows.push({ kind: "context", n: n++, text: raw.slice(1) })
      o++
      newLeft--
    }
  }
  return inHunk ? count(rows, "patch") : null
}

function splitLines(text: string): string[] {
  if (text === "") return []
  return text.replace(/\n$/, "").split("\n")
}

/** 两段文字的行级 diff（LCS，先删后增）；没有文件行号 */
function lineDiff(before: string, after: string): PiDiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  if ((a.length + 1) * (b.length + 1) > LCS_CELLS) {
    return [...a.map((text) => ({ kind: "del" as const, n: null, text })), ...b.map((text) => ({ kind: "add" as const, n: null, text }))]
  }
  const L: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const rows: PiDiffLine[] = []
  let dels: PiDiffLine[] = []
  let adds: PiDiffLine[] = []
  const flush = () => {
    rows.push(...dels, ...adds)
    dels = []
    adds = []
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush()
      rows.push({ kind: "context", n: null, text: a[i] })
      i++
      j++
    } else if (j >= b.length || (i < a.length && L[i + 1][j] >= L[i][j + 1])) {
      dels.push({ kind: "del", n: null, text: a[i++] })
    } else {
      adds.push({ kind: "add", n: null, text: b[j++] })
    }
  }
  flush()
  return rows
}

/**
 * args（工具入参）+ 工具块上的 patch → diff 行。取不到任何改动数据时返回 null（整卡不出现）。
 * 有能解析的 patch 就用 patch；没有（旧版 pi / write / 坏 patch）回落到 args 推算。
 */
export function diffRowsFromEdit(args: Record<string, unknown> | null | undefined, source: PiPatchSource | null | undefined): PiDiffRows | null {
  const patch = str(source?.patch)
  if (patch) {
    const parsed = rowsFromPatch(patch)
    if (parsed) return source?.patchTruncated === true ? { ...parsed, truncated: true } : parsed
  }
  if (!args) return null
  const content = str(args.content)
  if (content !== null && str(args.oldText) === null && !Array.isArray(args.edits)) {
    return count(
      splitLines(content).map((text, k) => ({ kind: "add" as const, n: k + 1, text })),
      "args",
    )
  }
  const pairs: { oldText: string; newText: string }[] = []
  const oldText = str(args.oldText) ?? str(args.old_string)
  const newText = str(args.newText) ?? str(args.new_string)
  if (oldText !== null && newText !== null) pairs.push({ oldText, newText })
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== "object") continue
      const e = edit as Record<string, unknown>
      const o = str(e.oldText) ?? str(e.old_string)
      const n = str(e.newText) ?? str(e.new_string)
      if (o !== null && n !== null) pairs.push({ oldText: o, newText: n })
    }
  }
  if (pairs.length === 0) return null
  return count(
    pairs.flatMap((p) => lineDiff(p.oldText, p.newText)),
    "args",
  )
}
