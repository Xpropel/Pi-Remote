import { searchSessions } from "../../shell/searchModel.ts"
import type { PiSidebarGroup, PiSidebarSearchResult, PiSidebarSession } from "../sidebar/types.ts"

/**
 * 搜索结果里的会话（手机搜索页在用；桌面侧栏搜索给 data.search.results 时用同一份）。纯函数，node --test 直接加载。
 * - 命中照 shell/searchModel 的 searchSessions：标题 / 工作目录 / 首条消息（首条消息不在分组行上，宿主按行给）；
 * - 顺序照分组区从上到下（置顶组在前、组内原序，同桌面搜索浮层的本地结果），同一会话只列一次。
 */
export function sidebarSearchSessionsOf(
  groups: readonly PiSidebarGroup[],
  query: string,
  firstMessageOf: (session: PiSidebarSession) => string | undefined = () => undefined,
): PiSidebarSearchResult[] {
  if (!query.trim()) return []
  const seen = new Set<string>()
  const rows: { title: string; cwd: string; firstMessage?: string; result: PiSidebarSearchResult }[] = []
  for (const group of groups) {
    for (const session of group.sessions) {
      if (seen.has(session.key)) continue
      seen.add(session.key)
      rows.push({
        title: session.title,
        cwd: session.cwd,
        firstMessage: firstMessageOf(session),
        result: { kind: "session", id: session.key, label: session.title, detail: group.kind === "pinned" ? session.cwd : group.label },
      })
    }
  }
  return searchSessions(rows, query).map((row) => row.result)
}
