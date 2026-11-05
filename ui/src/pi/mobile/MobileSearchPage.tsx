import { useEffect, useMemo, useState } from "react"
import type { PiSidebarSession } from "../sidebar/types.ts"
import { IconBack, IconSearch } from "./icons"
import type { PiMobileNavProps } from "./types.ts"

/** P11-MOB-11 列表式全屏搜索：输入即筛标题/摘要；抽屉式无搜索入口。搜索词由 actions.setSearchQuery 上抛。
 *  A-3：宿主另给 data.search.body 时在本地结果下加「正文匹配 · 设备名」组（命中走 actions.selectBodyHit）；
 *  正文只搜选中设备的明文会话，加密房间由中继排除并写进 note。 */
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
        {sessions.length === 0 && !data.search.body ? (
          <p className="pm-home-note">{query ? "没有匹配的会话" : "还没有会话"}</p>
        ) : (
          <>
            {sessions.map((session) => (
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
                {session.timeLabel ? <span className="pm-search-row-time" title={session.dateTimeLabel}>{session.timeLabel}</span> : null}
              </button>
            ))}
            {data.search.body ? (
              <>
                <p className="pm-search-bodyhead">{`正文匹配${data.search.body.deviceName ? ` · ${data.search.body.deviceName}` : ""}`}</p>
                {data.search.body.hits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    className="pm-search-row"
                    onClick={() => {
                      actions.selectBodyHit?.(hit.id)
                      close()
                    }}
                  >
                    <span className="pm-search-row-main">
                      <span className="pm-search-row-title">{hit.label}</span>
                      {hit.snippet ? <span className="pm-search-row-summary">{hit.snippet}</span> : null}
                    </span>
                    <span className="pm-search-row-time">{`命中 ${hit.matchCount} 条`}</span>
                  </button>
                ))}
                {data.search.body.note ? <p className="pm-home-note">{data.search.body.note}</p> : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
