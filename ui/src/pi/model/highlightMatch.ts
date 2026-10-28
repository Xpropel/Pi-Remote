/**
 * 搜索命中词（plan §7.1 session-search、P5.3；design C10：命中词加粗、不用底色）。纯函数，node --test 直接加载。
 * 匹配口径同 shell/searchModel.ts：查询去空白、大小写不敏感的子串，用 indexOf（不拼正则，查询里的元字符不会出事）。
 * PiSessionRow 的 highlight 是"标题里要加粗的那一段原文"，所以这里返回原文里的写法（"Relay" 搜 "relay" 也能加粗）。
 */

export type PiHighlightMatch = { before: string; match: string; after: string }

/** 第一处命中切成三段；没有命中 / 查询为空时 null */
export function highlightMatch(text: string, query: string): PiHighlightMatch | null {
  const needle = query.trim().toLowerCase()
  if (!needle || !text) return null
  const at = text.toLowerCase().indexOf(needle)
  if (at < 0) return null
  return { before: text.slice(0, at), match: text.slice(at, at + needle.length), after: text.slice(at + needle.length) }
}

/** 给 PiSessionRowData.highlight 用：原文里第一处命中的那一段；没有命中时 undefined（不加粗） */
export function highlightPartOf(text: string, query: string): string | undefined {
  return highlightMatch(text, query)?.match
}
