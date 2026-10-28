/**
 * SidebarSearch 的纯逻辑（不依赖 React / DOM）。
 *
 * 本地匹配面（R4-2 定版）：标题 / 工作目录 / 首条用户消息预览（firstMessage）。
 * 三者都是协议里真实存在的字段（firstMessage 由扩展清单帧透传，见 devices.ts），
 * 匹配它不是拼假预览；协议没有“最后一条消息预览”字段，那个仍然不匹配、不显示。
 * 会话正文不在本地匹配面——正文只在宿主会话文件里，走 search_session_bodies
 * 设备命令在宿主侧搜（见 bodySearchPageOf 一组纯函数），本地不持有正文。
 */
export const SEARCH_DEBOUNCE_MS = 120

export type SearchRowLike = {
  title: string
  cwd: string
  firstMessage?: string
}

function needleOf(query: string): string {
  return query.trim().toLowerCase()
}

/** 大小写不敏感的子串匹配；中文按原样子串。空查询返回全部行。 */
export function searchSessions<T extends SearchRowLike>(rows: readonly T[], query: string): T[] {
  const needle = needleOf(query)
  if (!needle) return [...rows]
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      row.cwd.toLowerCase().includes(needle) ||
      (typeof row.firstMessage === "string" && row.firstMessage.toLowerCase().includes(needle)),
  )
}

/* ---------------- 正文搜索（search_session_bodies 回包归一与诚实态） ---------------- */

/** 搜索词长度口径与 protocol/v4.json limits 的 bodySearchQueryMin/Max 同值（协议是唯一事实源，这里是网页侧镜像）。 */
export const BODY_SEARCH_QUERY_MIN = 2
export const BODY_SEARCH_QUERY_MAX = 100

export type BodySearchSnippet = {
  text: string
  entryId?: string
}

export type BodySearchHit = {
  /** 会话文件路径（宿主侧，正斜杠口径）——UI 靠它对回本地清单行打开会话 */
  session: string
  id: string
  title: string
  cwd: string
  mtime: number
  /** 命中条目数（扩展侧按协议上限截断计数） */
  matchCount: number
  snippets: BodySearchSnippet[]
}

/** 按房间并发搜索时没拿到结果的目标（项目目录 + 错误码，relay/bodySearch.ts 合并时记下） */
export type BodySearchUnanswered = {
  cwd: string
  code: string
}

export type BodySearchPage = {
  query: string
  results: BodySearchHit[]
  /** 没扫完（文件数/字节/deadline/结果上限任一到限）：结果可能不全，必须明示 */
  truncated: boolean
  scannedFiles: number
  totalFiles: number
  /** 部分结果：并发搜索里有目标超时或失败（只有合并页才有；单个扩展回包没有这个字段） */
  unanswered?: BodySearchUnanswered[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** 扩展回包 → 类型化结果。形状不对的条目丢弃而不是硬撑：宁可少一条，不呈假数据。 */
export function bodySearchPageOf(data: unknown): BodySearchPage | null {
  if (!isRecord(data) || typeof data.query !== "string" || !Array.isArray(data.results)) return null
  const results: BodySearchHit[] = []
  for (const raw of data.results) {
    if (!isRecord(raw) || typeof raw.session !== "string" || !raw.session) continue
    const snippets: BodySearchSnippet[] = []
    if (Array.isArray(raw.snippets)) {
      for (const s of raw.snippets) {
        if (!isRecord(s) || typeof s.text !== "string" || !s.text) continue
        snippets.push(typeof s.entryId === "string" && s.entryId ? { text: s.text, entryId: s.entryId } : { text: s.text })
      }
    }
    results.push({
      session: raw.session,
      id: typeof raw.id === "string" && raw.id ? raw.id : raw.session,
      title: typeof raw.title === "string" && raw.title ? raw.title : raw.session,
      cwd: typeof raw.cwd === "string" ? raw.cwd : "",
      mtime: typeof raw.mtime === "number" && Number.isFinite(raw.mtime) ? raw.mtime : 0,
      matchCount: typeof raw.matchCount === "number" && raw.matchCount > 0 ? Math.floor(raw.matchCount) : snippets.length,
      snippets,
    })
  }
  const page: BodySearchPage = {
    query: data.query,
    results,
    truncated: data.truncated === true,
    scannedFiles: typeof data.scannedFiles === "number" ? data.scannedFiles : 0,
    totalFiles: typeof data.totalFiles === "number" ? data.totalFiles : 0,
  }
  const unanswered: BodySearchUnanswered[] = []
  if (Array.isArray(data.unanswered)) {
    for (const raw of data.unanswered) {
      if (isRecord(raw)) unanswered.push({ cwd: typeof raw.cwd === "string" ? raw.cwd : "", code: typeof raw.code === "string" ? raw.code : "" })
    }
  }
  if (unanswered.length) page.unanswered = unanswered
  return page
}

/** 正文搜索失败的诚实态文案：离线 / 无活动会话 / 超时三态分开说，不混成一句“失败”。 */
export function bodySearchErrorText(code: string, message: string): string {
  if (code === "device_offline" || code === "offline" || code === "no_device") return "设备未连接，暂时搜不了正文"
  if (code === "device_no_active_session") return "这台设备没有在运行的会话，暂时搜不了正文"
  if (code === "timeout" || code === "result_unknown") return "搜索超时，宿主没有及时回应，请重试"
  if (code === "unsupported" || code === "unknown_command" || code === "unknown_type") return "这台设备的扩展版本不支持正文搜索"
  return message || "正文搜索失败，请重试"
}

/** 截断诚实态文案：把已扫范围说清，不许只写“结果可能不全”而不给数。 */
export function bodySearchTruncatedText(page: BodySearchPage): string {
  return `已扫 ${page.scannedFiles}/${page.totalFiles} 个会话文件，结果可能不全`
}

/** 部分结果的诚实态文案：写明哪个项目没拿到结果、为什么（超时 / 扩展不支持 / 其他失败分开说）；没有就是 null。 */
export function bodySearchPartialText(page: BodySearchPage): string | null {
  const missing = page.unanswered ?? []
  if (!missing.length) return null
  const groups = new Map<string, string[]>()
  for (const item of missing) {
    const reason =
      item.code === "timeout" || item.code === "result_unknown"
        ? "没有及时回应"
        : item.code === "unsupported" || item.code === "unknown_command" || item.code === "unknown_type"
          ? "的扩展不支持正文搜索"
          : "搜索失败"
    const name = item.cwd.split(/[/\\]/).filter(Boolean).pop() || "一个项目"
    groups.set(reason, [...(groups.get(reason) ?? []), name])
  }
  return `部分结果：${[...groups].map(([reason, names]) => `${names.join("、")} ${reason}`).join("；")}`
}

export type HighlightPart = {
  text: string
  hit: boolean
}

/**
 * 命中片段拆分：不改字色字重，只给 UI 包一层 <mark>。
 * 用 indexOf 而不是正则，避免用户输入 / 路径里的正则元字符出问题。
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  const needle = needleOf(query)
  if (!text) return []
  if (!needle) return [{ text, hit: false }]
  const haystack = text.toLowerCase()
  const parts: HighlightPart[] = []
  let from = 0
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + needle.length), hit: true })
    from = at + needle.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts
}

export function searchCountLabel(count: number): string {
  return `找到 ${count} 个会话`
}
