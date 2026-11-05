import { useMemo } from "react"
import { SearchIcon } from "./icons"
import type { PiSidebarActions, PiSidebarData, PiSidebarSearchResult } from "../types"

/**
 * P11-SIDE-14：搜索入口/浮层。
 * P1 修复：共享核基于 PiSidebarData 本地过滤（会话标题/工作区名/cwd），不依赖宿主生成 results；
 * 最多 20 条，无匹配显示「没有匹配」。选中走 actions.selectSession。
 * A-3：宿主另给 data.search.body 时在本地结果下加「正文匹配 · 设备名」组（命中走
 * actions.selectBodyHit）；正文只搜选中设备的明文会话，加密房间由中继排除并写进 note。
 */
export function SidebarSearchOverlay({ data, actions }: { data: PiSidebarData; actions: PiSidebarActions }) {
  const query = data.search.query.trim().toLowerCase()
  const localResults = useMemo<PiSidebarSearchResult[]>(() => {
    if (!query) return []
    const out: PiSidebarSearchResult[] = []
    for (const group of data.groups) {
      if (group.label.toLowerCase().includes(query) || (group.cwd ?? "").toLowerCase().includes(query)) {
        out.push({ kind: "workspace", id: group.id, label: group.label, detail: group.cwd })
      }
      for (const session of group.sessions) {
        if (out.length >= 20) break
        if (session.title.toLowerCase().includes(query) || (session.cwd ?? "").toLowerCase().includes(query) || (session.repo ?? "").toLowerCase().includes(query)) {
          out.push({ kind: "session", id: session.key, label: session.title, detail: session.cwd })
        }
      }
      if (out.length >= 20) break
    }
    return out.slice(0, 20)
  }, [data.groups, query])
  const results = data.search.results && data.search.results.length > 0 ? data.search.results : localResults
  const body = data.search.body
  if (!data.search.open) return null
  return (
    <div className="sb-search-scrim" data-p11-surface="P11-SIDE-14" role="dialog" aria-modal="true" aria-label="搜索会话"
      onKeyDown={(event) => { if (event.key === "Escape") actions.closeSearch() }}>
      <div className="sb-search-panel">
        <label className="sb-search-input">
          <SearchIcon size={14} />
          <input
            autoFocus
            value={data.search.query}
            placeholder="搜索会话、工作区…"
            aria-label="搜索会话"
            onChange={(event) => actions.setSearchQuery?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") actions.closeSearch()
              if (event.key === "Enter" && results[0]) {
                if (results[0].kind === "session") actions.selectSession(results[0].id)
              }
            }}
          />
          <button type="button" className="sb-search-close" onClick={actions.closeSearch} aria-label="关闭搜索">Esc</button>
        </label>
        {query === "" ? (
          <p className="sb-search-empty">输入关键词开始搜索</p>
        ) : (
          <>
            {results.length > 0 ? (
              <div className="sb-search-results" role="listbox" aria-label="搜索结果">
                {results.map((result) => (
                  <button
                    key={`${result.kind}:${result.id}`}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="sb-search-result"
                    onClick={() => {
                      if (result.kind === "session") actions.selectSession(result.id)
                    }}
                  >
                    <span className="sb-search-result-label">
                      {result.label.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig")).map((part, index) =>
                        part.toLowerCase() === query ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
                      )}
                    </span>
                    {result.detail ? <span className="sb-search-result-detail">{result.detail}</span> : null}
                  </button>
                ))}
              </div>
            ) : body ? null : (
              <p className="sb-search-empty">没有匹配</p>
            )}
            {body ? (
              <>
                <p className="sb-search-bodyhead">{`正文匹配${body.deviceName ? ` · ${body.deviceName}` : ""}`}</p>
                {body.hits.length > 0 ? (
                  <div className="sb-search-results" role="listbox" aria-label="正文搜索结果">
                    {body.hits.map((hit) => (
                      <button
                        key={hit.id}
                        type="button"
                        role="option"
                        aria-selected={false}
                        className="sb-search-result"
                        onClick={() => actions.selectBodyHit?.(hit.id)}
                      >
                        <span className="sb-search-result-label">{hit.label}</span>
                        <span className="sb-search-result-detail">{`${hit.snippet ? `${hit.snippet} · ` : ""}命中 ${hit.matchCount} 条`}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
                {body.note ? <p className="sb-search-empty">{body.note}</p> : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
