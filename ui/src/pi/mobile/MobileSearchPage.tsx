import { useEffect, useMemo, useRef, useState } from "react"
import { searchSessions } from "@/shell/searchModel"
import type { PiSidebarSession } from "../sidebar/types.ts"
import { IconBack, IconClose, IconDot, IconSearch } from "./icons"
import type { PiMobileNavProps } from "./types.ts"

/** P11-MOB-11 全屏搜索（列表式从首页顶栏进、抽屉式从抽屉头进）：输入即筛。搜索词由 actions.setSearchQuery 上抛。
 *  会话结果照宿主给的 data.search.results（同桌面：searchSessions 命中标题 / 工作目录 / 首条消息，分组区顺序）；没给时本地按标题 / 工作目录筛。
 *  A-3：宿主另给 data.search.body 时在本地结果下加「正文匹配 · 设备名」组（命中走 actions.selectBodyHit）；
 *  正文只搜选中设备的明文会话，加密房间由中继排除并写进 note。 */
export function MobileSearchPage({ data, actions, onOpenSession }: PiMobileNavProps) {
  const [localQuery, setLocalQuery] = useState(data.search.query)
  const query = data.search.query || localQuery
  const sessions = useMemo(() => {
    const all: PiSidebarSession[] = data.groups.flatMap((group) => group.sessions)
    if (!query.trim()) return all
    const results = data.search.results
    if (!results) return searchSessions(all, query)
    const byKey = new Map(all.map((session) => [session.key, session]))
    return results.flatMap((result) => (result.kind === "session" ? (byKey.get(result.id) ?? []) : []))
  }, [data.groups, data.search.results, query])
  const inputRef = useRef<HTMLInputElement>(null)
  const setQuery = (next: string) => {
    setLocalQuery(next)
    actions.setSearchQuery?.(next)
  }
  const close = () => actions.closeSearch()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        actions.closeSearch()
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
            ref={inputRef}
            autoFocus
            type="search"
            enterKeyHint="search"
            className="pm-search-input"
            placeholder="搜索会话"
            aria-label="搜索会话"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // 输入即筛，回车只是收起键盘把结果让出来
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault()
                event.currentTarget.blur()
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="pm-search-clear"
              aria-label="清除搜索"
              onClick={() => {
                setQuery("")
                inputRef.current?.focus()
              }}
            >
              <IconClose size={14} />
            </button>
          ) : null}
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
                <span className="pm-row-dot pm-search-row-dot" data-marker={session.status.tone} aria-hidden>
                  <IconDot size={8} />
                </span>
                <span className="pm-search-row-main">
                  <span className="pm-search-row-title">{session.title}</span>
                  <span className="pm-search-row-summary">{session.summary || "\u00a0"}</span>
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
