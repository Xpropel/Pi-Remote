import { Search } from "../icons/CodexIcons"
import { useEffect, useMemo } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { sidebarDataOf } from "@/pi/model/sidebarSource"
import { piRelativeTime } from "../logic/view"
import { CodexSpinner } from "../primitives/primitives"

/** 搜索会话（[X-§6] 语言 / X-10 等价）：标题匹配 + Recent chats；Esc 退出；点行打开会话（正文搜索 v2 未接，标注差异） */
export function CodexSearchChats({ p, onOpenSession, onClose }: { p: VariantAppProps; onOpenSession: (id: string, deviceId: string) => void; onClose: () => void }) {
  const { relay, ui, act } = p
  const query = ui.search ?? ""
  const now = Date.now()
  const data = useMemo(
    () =>
      sidebarDataOf({
        devices: relay.devices,
        rooms: relay.rooms,
        sessionsByDevice: relay.sessionsByDevice,
        roomId: relay.roomId,
        dialogs: relay.dialogs,
        uiPrompt: relay.uiPrompt,
        turnEnd: relay.turnEnd,
        roomTurnEnds: relay.roomTurnEnds,
        selectedDevice: relay.selectedDevice,
      }),
    [relay.devices, relay.rooms, relay.sessionsByDevice, relay.roomId, relay.dialogs, relay.uiPrompt, relay.turnEnd, relay.roomTurnEnds, relay.selectedDevice],
  )
  const q = query.trim().toLowerCase()
  const hits = q ? data.sessions.filter((s) => s.title.toLowerCase().includes(q)) : []
  // CX-DLG-02：Ctrl+1..9 直达（Recent chats 的前 9 条；与设计 [X-§6] 一致）
  const shortcutRows = q ? hits.slice(0, 9) : recentRowsOf(data.sessions)
  const recent = recentRowsOf(data.sessions)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const digit = Number(event.key)
      if (!Number.isInteger(digit) || digit < 1 || digit > 9) return
      const row = shortcutRows[digit - 1]
      if (!row) return
      event.preventDefault()
      onOpenSession(row.id, row.deviceId)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [shortcutRows, onOpenSession])
  return (
    <div className="cx-search" data-pi-ui-part="search" data-p4-surface="CX-DLG-02" data-p4-ready="">
      <label className="cx-search-field">
        <Search aria-hidden size={14} strokeWidth={1.5} />
        <input
          value={query}
          autoFocus
          placeholder="搜索会话…"
          aria-label="搜索会话"
          onChange={(event) => act.setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              act.setSearch(null)
              onClose()
            }
            if (event.key === "Enter" && hits[0]) onOpenSession(hits[0].id, hits[0].deviceId)
          }}
        />
      </label>
      <div className="cx-search-body">
        {q ? (
          hits.length === 0 ? (
            <p className="cx-search-note">没有匹配的会话（v2 暂只匹配标题）</p>
          ) : (
            <ul className="cx-search-list">
              {hits.map((session, index) => (
                <li key={session.id}>
                  <button type="button" className="cx-row" onClick={() => onOpenSession(session.id, session.deviceId)}>
                    <span className="cx-search-index">{index < 9 ? index + 1 : ""}</span>
                    <span className="cx-row-title">{session.title}</span>
                    <span className="cx-row-trailing">{piRelativeTime(session.updatedAt, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            <div className="cx-search-group-label">Recent chats</div>
            <ul className="cx-search-list">
              {recent.map((session, index) => (
                <li key={session.id}>
                  <button type="button" className="cx-row" onClick={() => onOpenSession(session.id, session.deviceId)}>
                    <span className="cx-search-index">{index + 1}</span>
                    <span className="cx-row-title">{session.title}</span>
                    <span className="cx-row-trailing">{piRelativeTime(session.updatedAt, now)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <p className="cx-search-note">Ctrl+1..9 直达 · Enter 打开 · Esc 关闭 · 当前支持标题搜索</p>
      <CodexSpinner size={0} />
    </div>
  )
}

/** Recent chats 的前 4 条（Ctrl+1..9 也按这份顺序取前 9） */
function recentRowsOf<T extends { id: string; deviceId: string; updatedAt: number }>(sessions: readonly T[]): T[] {
  return sessions.filter((s) => s.updatedAt > 0).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 9)
}
