/**
 * Unified diff 解析（纯函数，不依赖 React/DOM）。
 *
 * 只消费真实存在的文本：没有结构化 diff 时绝不构造示例文件、行号或统计。
 * 识别 git / 标准 unified diff：
 *   diff --git a/x b/x
 *   --- a/x / +++ b/x / --- /dev/null / +++ /dev/null
 *   @@ -old,count +new,count @@
 *   " " / "-" / "+" 行，\ No newline 标记，二进制声明，rename/new/deleted 头。
 *
 * 解析失败返回 null，由调用方保留普通 CodeBlock，不做半截渲染。
 */

export type DiffLineKind = "context" | "add" | "remove"

export type DiffLine = {
  kind: DiffLineKind
  text: string
  /** 旧文件行号；新增行为 null */
  oldLine: number | null
  /** 新文件行号；删除行为 null */
  newLine: number | null
}

export type DiffHunk = {
  /** 原始 @@ 头，含尾部 section 文本 */
  header: string
  /** @@ 之后的函数/区块提示（可能为空） */
  section: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export type DiffFileStatus = "modified" | "added" | "deleted" | "renamed" | "binary"

export type DiffFile = {
  /** 去掉 a/、b/ 前缀后的旧路径；/dev/null 为 null */
  oldPath: string | null
  /** 去掉 a/、b/ 前缀后的新路径；/dev/null 为 null */
  newPath: string | null
  status: DiffFileStatus
  binary: boolean
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

export type ParsedDiff = {
  files: DiffFile[]
  additions: number
  deletions: number
  hunkCount: number
  /** 二进制文件数量（不渲染行） */
  binaryFiles: number
}

export type FoldedDiffRow =
  | { kind: "line"; line: DiffLine }
  | { kind: "gap"; hidden: DiffLine[]; count: number }

type FileDraft = {
  oldPath: string | null
  newPath: string | null
  status: DiffFileStatus
  binary: boolean
  renameFrom?: string
  renameTo?: string
  hunks: DiffHunk[]
  sawOldHeader: boolean
  sawNewHeader: boolean
}

const GIT_PREFIX = "diff --git "
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/
const NO_NEWLINE = "\\ No newline at end of file"

function stripQuotes(value: string): string {
  const text = value.trim()
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    // git 的 C 风格转义只影响路径展示；去掉外层引号已足够避免把引号带进标题。
    return text.slice(1, -1).replace(/\\(["\\])/g, "$1")
  }
  return text
}

/** 去掉 a/ b/ 前缀；/dev/null 表示这一侧不存在。 */
function normalizeDiffPath(raw: string | undefined): string | null {
  if (!raw) return null
  const text = stripQuotes(raw).replace(/^\.\//, "")
  if (text === "/dev/null") return null
  if (text.startsWith("a/") || text.startsWith("b/") || text.startsWith("i/") || text.startsWith("w/")) {
    return text.slice(2)
  }
  return text
}

/** `--- a/x\t2026-...` / `+++ b/x` 只取路径部分。 */
function headerPath(rest: string): string | null {
  const field = rest.split("\t")[0].trim()
  return normalizeDiffPath(field)
}

function splitGitPaths(line: string): [string, string] | null {
  const rest = line.slice(GIT_PREFIX.length)
  const quoted = /^(".*?")\s+(".*?")$/.exec(rest)
  if (quoted) return [stripQuotes(quoted[1]), stripQuotes(quoted[2])]
  // 路径里可能有空格：用 " b/" 分界，而不是按空白切。
  const marker = rest.indexOf(" b/")
  if (marker > 0) return [rest.slice(0, marker), rest.slice(marker + 1)]
  const parts = rest.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return [parts[0], parts[1]]
  return null
}

function countLines(lines: DiffLine[], kind: DiffLineKind): number {
  let total = 0
  for (const line of lines) if (line.kind === kind) total += 1
  return total
}

function finalizeFile(draft: FileDraft): DiffFile {
  let status = draft.status
  if (draft.binary) status = "binary"
  else if (draft.renameFrom && draft.renameTo) status = "renamed"
  else if (draft.oldPath === null && draft.newPath !== null) status = "added"
  else if (draft.newPath === null && draft.oldPath !== null) status = "deleted"
  else if (draft.oldPath !== null && draft.newPath !== null && draft.oldPath !== draft.newPath && draft.hunks.length === 0) {
    status = "renamed"
  }
  const lines = draft.hunks.flatMap((hunk) => hunk.lines)
  return {
    oldPath: draft.oldPath,
    newPath: draft.newPath,
    status,
    binary: draft.binary,
    hunks: draft.hunks,
    additions: countLines(lines, "add"),
    deletions: countLines(lines, "remove"),
  }
}

function newDraft(): FileDraft {
  return {
    oldPath: null,
    newPath: null,
    status: "modified",
    binary: false,
    hunks: [],
    sawOldHeader: false,
    sawNewHeader: false,
  }
}

function parseHunk(lines: string[], start: number): { hunk: DiffHunk; next: number } | null {
  const head = HUNK_HEADER.exec(lines[start] ?? "")
  if (!head) return null
  const oldStart = Number(head[1])
  const oldCount = head[2] === undefined ? 1 : Number(head[2])
  const newStart = Number(head[3])
  const newCount = head[4] === undefined ? 1 : Number(head[4])
  if (![oldStart, oldCount, newStart, newCount].every(Number.isFinite)) return null
  if (oldCount === 0 && newCount === 0) return null

  let oldRemaining = oldCount
  let newRemaining = newCount
  let oldLine = oldStart
  let newLine = newStart
  const body: DiffLine[] = []
  let at = start + 1
  let guard = 0

  while (oldRemaining > 0 || newRemaining > 0) {
    if (at >= lines.length) return null
    const line = lines[at]
    if (line.startsWith("\\")) {
      at += 1
      continue
    }
    let kind: DiffLineKind
    if (line === "") {
      // 标准 diff 的上下文空行带一个空格；这里兼容省略了前缀的生产者。
      if (oldRemaining > 0 && newRemaining > 0) kind = "context"
      else return null
    } else if (line[0] === " ") kind = "context"
    else if (line[0] === "-") kind = "remove"
    else if (line[0] === "+") kind = "add"
    else return null

    const text = line === "" ? "" : line.slice(1)
    if (kind === "context") {
      if (oldRemaining <= 0 || newRemaining <= 0) return null
      body.push({ kind, text, oldLine, newLine })
      oldLine += 1
      newLine += 1
      oldRemaining -= 1
      newRemaining -= 1
    } else if (kind === "remove") {
      if (oldRemaining <= 0) return null
      body.push({ kind, text, oldLine, newLine: null })
      oldLine += 1
      oldRemaining -= 1
    } else {
      if (newRemaining <= 0) return null
      body.push({ kind, text, oldLine: null, newLine })
      newLine += 1
      newRemaining -= 1
    }
    at += 1
    guard += 1
    if (guard > oldCount + newCount + 8) return null
  }

  while (at < lines.length && lines[at].startsWith("\\")) at += 1
  if (at < lines.length && lines[at] === NO_NEWLINE) at += 1

  return {
    hunk: {
      header: lines[start],
      section: head[5] || "",
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines: body,
    },
    next: at,
  }
}

/**
 * 解析完整 unified diff。文本必须从 diff 头开始（允许前置空行）；
 * 任何无法归属的行都视为格式异常，避免把普通日志“猜”成 diff。
 */
export function parseUnifiedDiff(source: string): ParsedDiff | null {
  if (typeof source !== "string" || !source.trim()) return null
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")
  const lines = text.split("\n")
  while (lines.length && lines[0].trim() === "") lines.shift()
  if (!lines.length) return null
  const first = lines[0]
  if (!first.startsWith(GIT_PREFIX) && !first.startsWith("--- ")) return null

  const files: DiffFile[] = []
  let draft: FileDraft | null = null
  let index = 0

  const flush = () => {
    if (!draft) return
    const file = finalizeFile(draft)
    const hasFacts =
      file.hunks.length > 0 ||
      file.binary ||
      file.status === "added" ||
      file.status === "deleted" ||
      file.status === "renamed"
    if (hasFacts) files.push(file)
    draft = null
  }

  while (index < lines.length) {
    const line = lines[index]

    if (line === "") {
      index += 1
      continue
    }

    if (line.startsWith(GIT_PREFIX)) {
      flush()
      const paths = splitGitPaths(line)
      if (!paths) return null
      draft = newDraft()
      draft.oldPath = normalizeDiffPath(paths[0])
      draft.newPath = normalizeDiffPath(paths[1])
      index += 1
      continue
    }

    if (line.startsWith("--- ")) {
      if (draft && (draft.sawOldHeader || draft.sawNewHeader || draft.hunks.length > 0)) {
        flush()
      }
      if (!draft) draft = newDraft()
      draft.oldPath = headerPath(line.slice(4))
      draft.sawOldHeader = true
      index += 1
      continue
    }

    if (line.startsWith("+++ ")) {
      if (!draft) return null
      draft.newPath = headerPath(line.slice(4))
      draft.sawNewHeader = true
      index += 1
      continue
    }

    if (line.startsWith("@@ ")) {
      if (!draft) return null
      const parsed = parseHunk(lines, index)
      if (!parsed) return null
      draft.hunks.push(parsed.hunk)
      index = parsed.next
      continue
    }

    if (line.startsWith("new file mode ")) {
      if (!draft) return null
      draft.status = "added"
      index += 1
      continue
    }

    if (line.startsWith("deleted file mode ")) {
      if (!draft) return null
      draft.status = "deleted"
      index += 1
      continue
    }

    if (line.startsWith("rename from ")) {
      if (!draft) return null
      draft.renameFrom = normalizeDiffPath(line.slice("rename from ".length)) ?? undefined
      index += 1
      continue
    }

    if (line.startsWith("rename to ")) {
      if (!draft) return null
      draft.renameTo = normalizeDiffPath(line.slice("rename to ".length)) ?? undefined
      index += 1
      continue
    }

    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      if (!draft) return null
      draft.binary = true
      index += 1
      continue
    }

    if (line === "GIT binary patch") {
      if (!draft) return null
      draft.binary = true
      index += 1
      continue
    }

    if (
      line.startsWith("index ") ||
      line.startsWith("old mode ") ||
      line.startsWith("new mode ") ||
      line.startsWith("similarity index ") ||
      line.startsWith("dissimilarity index ") ||
      line.startsWith("copy from ") ||
      line.startsWith("copy to ") ||
      line.startsWith("Only in ")
    ) {
      index += 1
      continue
    }

    if (line.startsWith("\\")) {
      index += 1
      continue
    }

    // 未归属的内容：宁可降级为普通代码块，也不猜测。
    return null
  }

  flush()
  if (!files.length) return null

  let additions = 0
  let deletions = 0
  let hunkCount = 0
  let binaryFiles = 0
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
    hunkCount += file.hunks.length
    if (file.binary) binaryFiles += 1
  }
  return { files, additions, deletions, hunkCount, binaryFiles }
}

/** 给调用方一个只看“能不能解析”的入口，避免各自复制判断逻辑。 */
export function isUnifiedDiff(source: string): boolean {
  return parseUnifiedDiff(source) !== null
}

/** 轻量前置判断：只有以 git/标准 diff 头开头的文本才值得跑完整解析。 */
export function isDiffCandidate(source: string): boolean {
  if (typeof source !== "string") return false
  const trimmed = source.replace(/^\uFEFF/, "").trimStart()
  return trimmed.startsWith(GIT_PREFIX) || trimmed.startsWith("--- ")
}

/** 文件头显示路径：删除用旧路径，其余用新路径（重命名另有 old → new）。 */
export function diffFileLabel(file: DiffFile): string {
  if (file.status === "deleted") return file.oldPath || file.newPath || "(未知文件)"
  return file.newPath || file.oldPath || "(未知文件)"
}

/** 文件头中间省略：保留首段与末两段（§4.7.1）。 */
export function ellipsizeDiffPath(path: string, maxSegments = 3): string {
  const cleaned = path.replace(/\\/g, "/")
  const parts = cleaned.split("/").filter(Boolean)
  if (parts.length <= maxSegments) return cleaned
  const head = parts[0]
  const tail = parts.slice(-2)
  return `${head}/…/${tail.join("/")}`
}

/**
 * 上下文折叠：连续未变更行超过 2×context 时，保留首尾 context 行，
 * 中间变成可展开的 gap。展开状态由 DiffView 持有，模型保持纯函数。
 */
export function foldHunkLines(lines: DiffLine[], context = 3): FoldedDiffRow[] {
  const rows: FoldedDiffRow[] = []
  const keep = Math.max(0, Math.floor(context))
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.kind !== "context") {
      rows.push({ kind: "line", line })
      index += 1
      continue
    }
    let end = index
    while (end < lines.length && lines[end].kind === "context") end += 1
    const run = lines.slice(index, end)
    if (keep > 0 && run.length > keep * 2) {
      for (let i = 0; i < keep; i += 1) rows.push({ kind: "line", line: run[i] })
      rows.push({
        kind: "gap",
        hidden: run.slice(keep, run.length - keep),
        count: run.length - keep * 2,
      })
      for (let i = run.length - keep; i < run.length; i += 1) rows.push({ kind: "line", line: run[i] })
    } else {
      for (const contextLine of run) rows.push({ kind: "line", line: contextLine })
    }
    index = end
  }
  return rows
}

/** 单文件折叠阈值：变更行 >200，或一条消息里第 6 个文件起。 */
export function diffFileFoldsByDefault(file: DiffFile, fileIndex: number, fileCount: number): boolean {
  if (file.binary) return false
  if (file.status === "deleted" || file.newPath === null) return true
  if (fileIndex >= 5 && fileCount > 5) return true
  return file.additions + file.deletions > 200
}

/* ---------------------------------------------------------------------------
 * 词级高亮（3.5.4）
 *
 * 只在相邻的“删行块 / 增行块”内按行配对；相似度低于 0.5 的行不配对，
 * 不产生悬空高亮。高亮片段来自真实行文本，不构造任何新内容。
 * ------------------------------------------------------------------------- */

export type DiffWordSegment = { text: string; changed: boolean }

export type DiffWordPair = { old: DiffWordSegment[]; new: DiffWordSegment[] }

/** 拉丁词/数字整块保留，空白成块，其余（含 CJK）逐字符切。 */
function wordTokens(text: string): string[] {
  return text.match(/[A-Za-z0-9_]+|\s+|./gu) || []
}

function mergeWordSegments(segments: DiffWordSegment[]): DiffWordSegment[] {
  const out: DiffWordSegment[] = []
  for (const segment of segments) {
    if (!segment.text) continue
    const last = out[out.length - 1]
    if (last && last.changed === segment.changed) last.text += segment.text
    else out.push({ ...segment })
  }
  return out
}

/**
 * 一行删、一行增的词级差异：公共前缀/后缀保留，中间段标记 changed。
 * 相似度 = 公共字符 / 较长行字符；<0.5 视为重写，返回 null。
 */
export function wordDiffPair(oldText: string, newText: string): DiffWordPair | null {
  const oldTokens = wordTokens(oldText)
  const newTokens = wordTokens(newText)
  if (!oldTokens.length || !newTokens.length) return null

  let prefix = 0
  while (prefix < oldTokens.length && prefix < newTokens.length && oldTokens[prefix] === newTokens[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldTokens.length - prefix &&
    suffix < newTokens.length - prefix &&
    oldTokens[oldTokens.length - 1 - suffix] === newTokens[newTokens.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMiddle = oldTokens.slice(prefix, oldTokens.length - suffix).join("")
  const newMiddle = newTokens.slice(prefix, newTokens.length - suffix).join("")
  if (!oldMiddle && !newMiddle) return null

  const oldHead = oldTokens.slice(0, prefix).join("")
  const newHead = newTokens.slice(0, prefix).join("")
  const oldTail = suffix ? oldTokens.slice(oldTokens.length - suffix).join("") : ""
  const newTail = suffix ? newTokens.slice(newTokens.length - suffix).join("") : ""

  const longest = Math.max(oldText.length, newText.length, 1)
  const changed = Math.max(oldMiddle.length, newMiddle.length)
  const similarity = 1 - changed / longest
  if (similarity < 0.5) return null

  return {
    old: mergeWordSegments([
      { text: oldHead, changed: false },
      { text: oldMiddle, changed: true },
      { text: oldTail, changed: false },
    ]),
    new: mergeWordSegments([
      { text: newHead, changed: false },
      { text: newMiddle, changed: true },
      { text: newTail, changed: false },
    ]),
  }
}

/**
 * 给一个 hunk 的全部行建立词级片段表（以 DiffLine 对象为键）。
 * 只在相邻 remove-run / add-run 内配对，配对顺序按行序。
 */
export function buildHunkWordDiffs(lines: readonly DiffLine[]): Map<DiffLine, DiffWordSegment[]> {
  const map = new Map<DiffLine, DiffWordSegment[]>()
  let index = 0
  while (index < lines.length) {
    if (lines[index].kind === "context") {
      index += 1
      continue
    }
    const removes: DiffLine[] = []
    const adds: DiffLine[] = []
    let cursor = index
    while (cursor < lines.length && lines[cursor].kind === "remove") removes.push(lines[cursor++])
    while (cursor < lines.length && lines[cursor].kind === "add") adds.push(lines[cursor++])
    if (!removes.length && !adds.length) {
      // 少见的“先增后删”块：仍按行序配对，不产生悬空高亮。
      while (cursor < lines.length && lines[cursor].kind === "add") adds.push(lines[cursor++])
      while (cursor < lines.length && lines[cursor].kind === "remove") removes.push(lines[cursor++])
    }
    if (!removes.length && !adds.length) {
      index = cursor + 1
      continue
    }
    const pairs = Math.min(removes.length, adds.length)
    for (let i = 0; i < pairs; i += 1) {
      const pair = wordDiffPair(removes[i].text, adds[i].text)
      if (!pair) continue
      map.set(removes[i], pair.old)
      map.set(adds[i], pair.new)
    }
    index = cursor
  }
  return map
}
