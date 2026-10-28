import { useEffect, useMemo, useState } from "react"
import type { PiSidebarSession } from "../sidebar/types.ts"
import { IconBack, IconSearch } from "./icons"
import type { PiMobileNavProps } from "./types.ts"

/** P11-MOB-11 列表式全屏搜索：输入即筛标题/摘要；抽屉式无搜索入口。搜索词由 actions.setSearchQuery 上抛。 */
export function MobileSearchPage({ data, actions, onOpenSession }: PiMobileNavProps) {
  const [localQuery, setLocalQuery] = useState(data.search.query)
  const query = data.search.query || localQuery
  const sessions = useMemo(() => {
    const all: PiSidebarSession[] = data.groups.flatMap((group) => group.sessions)
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((session) => session.title.toLowerCase().includes(q) || (session.summary ?? "").toLowerCase().includes(q))
  }, [data.groups, query])
  const close = () => actions.closeSearch()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [actions])
  return (
    <div className="pm-search-page" data-pi-mobile-surface="P11-MOB-11">
      <header className="pm-topbar pm-search-bar">
        <button type="button" className="pm-icon-btn" aria-label="关闭搜索" onClick={close}>
          <IconBack size={20} />
        </button>
        <label className="pm-search-field">
          <IconSearch size={17} />
          <input
            autoFocus
            type="search"
            className="pm-search-input"
            placeholder="搜索会话"
            aria-label="搜索会话"
            value={query}
            onChange={(event) => {
              const next = event.target.value
              setLocalQuery(next)
              actions.setSearchQuery?.(next)
            }}
          />
        </label>
      </header>
      <div className="pm-search-results">
        {sessions.length === 0 ? (
          <p className="pm-home-note">{query ? "没有匹配的会话" : "还没有会话"}</p>
        ) : (
          sessions.map((session) => (
            <button
              key={session.key}
              type="button"
              className="pm-search-row"
              onClick={() => {
                onOpenSession(session.key)
                close()
              }}
            >
              <span className="pm-search-row-main">
                <span className="pm-search-row-title">{session.title}</span>
                {session.summary ? <span className="pm-search-row-summary">{session.summary}</span> : null}
              </span>
              {session.timeLabel ? <span className="pm-search-row-time">{session.timeLabel}</span> : null}
            </button>
          ))
        )}
      </div>
    </div>
  )
}
