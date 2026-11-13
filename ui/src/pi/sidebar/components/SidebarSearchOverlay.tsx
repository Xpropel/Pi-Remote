import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { FolderClosedIcon, SearchIcon } from "./icons"
import type { PiSessionTone, PiSidebarActions, PiSidebarData, PiSidebarSearchResult } from "../types"

type Option = { id: string; run: () => void }

/** 命中词加粗（不加底色）；query 已是小写 */
function highlight(label: string, query: string): ReactNode {
  if (!query) return label
  return label.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig")).map((part, index) =>
    part.toLowerCase() === query ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
  )
}

/**
 * P11-SIDE-14：侧栏搜索（盖住整条侧栏的搜索态，不是居中浮窗）。
 * P1 修复：共享核基于 PiSidebarData 本地过滤（会话标题/工作区名/cwd），不依赖宿主生成 results；
 * 最多 20 条，无匹配显示「没有匹配」。选中走 actions.selectSession；工作区结果展开该组并回到列表。
 * ↑↓ 在全部结果间移动（aria-activedescendant），Enter 打开，Esc 关闭。
 * A-3：宿主另给 data.search.body 时在本地结果下加「正文匹配 · 设备名」组（命中走
 * actions.selectBodyHit）；正文只搜选中设备的明文会话，加密房间由中继排除并写进 note。
 */
export function SidebarSearchOverlay({ data, actions }: { data: PiSidebarData; actions: PiSidebarActions }) {
  const query = data.search.query.trim().toLowerCase()
  const localResults = useMemo<PiSidebarSearchResult[]>(() => {
    if (!query) return []
    const out: PiSidebarSearchResult[] = []
    for (const group of data.groups) {
      if (group.kind === "workspace" && (group.label.toLowerCase().includes(query) || (group.cwd ?? "").toLowerCase().includes(query))) {
        out.push({ kind: "workspace", id: group.id, label: group.label, detail: group.cwd })
      }
      for (const session of group.sessions) {
        if (out.length >= 20) break
        if (session.title.toLowerCase().includes(query) || (session.cwd ?? "").toLowerCase().includes(query) || (session.repo ?? "").toLowerCase().includes(query)) {
          out.push({ kind: "session", id: session.key, label: session.title, detail: group.kind === "pinned" ? session.cwd : group.label })
        }
      }
      if (out.length >= 20) break
    }
    return out.slice(0, 20)
  }, [data.groups, query])
  const results = data.search.results && data.search.results.length > 0 ? data.search.results : localResults
  const body = data.search.body
  const toneOf = useMemo(() => {
    const map = new Map<string, PiSessionTone>()
    for (const group of data.groups) for (const session of group.sessions) map.set(session.key, session.status.tone)
    return map
  }, [data.groups])
  const sessions = results.filter((result) => result.kind !== "workspace")
  const workspaces = results.filter((result) => result.kind === "workspace")
  const openResult = (result: PiSidebarSearchResult) => {
    if (result.kind === "workspace") {
      const group = data.groups.find((g) => g.id === result.id)
      if (group?.collapsed) actions.toggleGroup(result.id)
      actions.closeSearch()
      return
    }
    actions.selectSession(result.id)
  }
  const options: Option[] = [
    ...sessions.map((result) => ({ id: `sb-search-s-${result.id}`, run: () => openResult(result) })),
    ...workspaces.map((result) => ({ id: `sb-search-w-${result.id}`, run: () => openResult(result) })),
    ...(body?.hits ?? []).map((hit) => ({ id: `sb-search-b-${hit.id}`, run: () => actions.selectBodyHit?.(hit.id) })),
  ]
  // 换关键词时高亮回到第一项（按 query 记，不用 effect 回写）
  const [activeState, setActiveState] = useState({ query, index: 0 })
  const active = activeState.query === query ? activeState.index : 0
  const setActive = (next: number | ((index: number) => number)) =>
    setActiveState({ query, index: typeof next === "function" ? next(active) : next })
  const activeId = options[Math.min(active, options.length - 1)]?.id
  const listRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!activeId) return
    listRef.current?.querySelector(`[id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest" })
  }, [activeId])
  if (!data.search.open) return null
  const optionProps = (id: string, run: () => void) => ({
    id,
    role: "option" as const,
    "aria-selected": id === activeId,
    "data-active": id === activeId ? "" : undefined,
    tabIndex: -1,
    onMouseMove: () => {
      const index = options.findIndex((option) => option.id === id)
      if (index >= 0 && index !== active) setActive(index)
    },
    onClick: run,
  })
  return (
    <div
      className="sb-search"
      data-p11-surface="P11-SIDE-14"
      role="dialog"
      aria-modal="true"
      aria-label="搜索会话"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          actions.closeSearch()
        }
      }}
    >
      <div className="sb-search-head">
        <label className="sb-search-input">
          <SearchIcon size={14} />
          <input
            autoFocus
            value={data.search.query}
            placeholder="搜索会话、工作区…"
            aria-label="搜索会话"
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={options.length > 0 ? "sb-search-list" : undefined}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            onChange={(event) => actions.setSearchQuery?.(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                if (options.length === 0) return
                event.preventDefault()
                const step = event.key === "ArrowDown" ? 1 : -1
                setActive((index) => (Math.min(index, options.length - 1) + step + options.length) % options.length)
                return
              }
              if (event.key === "Enter") {
                event.preventDefault()
                options.find((option) => option.id === activeId)?.run()
              }
            }}
          />
        </label>
        <button type="button" className="sb-search-close" onClick={actions.closeSearch} aria-label="关闭搜索" title="关闭搜索">
          <kbd className="sb-kbd">Esc</kbd>
        </button>
      </div>
      <div className="sb-search-body" ref={listRef}>
        {query === "" ? (
          <p className="sb-search-empty">输入关键词，搜索会话标题、工作区和目录</p>
        ) : (
          <>
            {options.length > 0 ? (
              <div id="sb-search-list" role="listbox" aria-label="搜索结果">
                {sessions.length > 0 ? (
                  <div className="sb-search-section" role="group" aria-label="会话">
                    <p className="sb-search-bodyhead" aria-hidden>会话</p>
                    {sessions.map((result) => (
                      <div key={`${result.kind}:${result.id}`} className="sb-search-result" {...optionProps(`sb-search-s-${result.id}`, () => openResult(result))}>
                        <span className="sb-search-marker" aria-hidden data-tone={toneOf.get(result.id) ?? "idle"} />
                        <span className="sb-search-result-text">
                          <span className="sb-search-result-label">{highlight(result.label, query)}</span>
                          {result.detail ? <span className="sb-search-result-detail">{result.detail}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {workspaces.length > 0 ? (
                  <div className="sb-search-section" role="group" aria-label="工作区">
                    <p className="sb-search-bodyhead" aria-hidden>工作区</p>
                    {workspaces.map((result) => (
                      <div key={`${result.kind}:${result.id}`} className="sb-search-result" {...optionProps(`sb-search-w-${result.id}`, () => openResult(result))}>
                        <FolderClosedIcon size={14} />
                        <span className="sb-search-result-text">
                          <span className="sb-search-result-label">{highlight(result.label, query)}</span>
                          {result.detail ? <span className="sb-search-result-detail">{result.detail}</span> : null}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {body && body.hits.length > 0 ? (
                  <div className="sb-search-section" role="group" aria-label="正文匹配">
                    <p className="sb-search-bodyhead" aria-hidden>{`正文匹配${body.deviceName ? ` · ${body.deviceName}` : ""}`}</p>
                    {body.hits.map((hit) => (
                      <div key={hit.id} className="sb-search-result" {...optionProps(`sb-search-b-${hit.id}`, () => actions.selectBodyHit?.(hit.id))}>
                        <span className="sb-search-marker" aria-hidden data-tone="idle" />
                        <span className="sb-search-result-text">
                          <span className="sb-search-result-label">{hit.label}</span>
                          <span className="sb-search-result-detail">{`${hit.snippet ? `${hit.snippet} · ` : ""}命中 ${hit.matchCount} 条`}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {results.length === 0 && !body ? <p className="sb-search-empty">没有匹配「{data.search.query.trim()}」的会话或工作区</p> : null}
            {body && body.hits.length === 0 ? <p className="sb-search-bodyhead">{`正文匹配${body.deviceName ? ` · ${body.deviceName}` : ""}`}</p> : null}
            {body?.note ? (
              <p className="sb-search-note" data-phase={body.phase} role="status">
                {body.note}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
