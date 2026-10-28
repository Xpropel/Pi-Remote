import { useEffect, useMemo, useRef, useState } from "react"
import { Search } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { paletteSessionsOf, PI_PALETTE_COMMANDS } from "@/pi/model/palette"
import { attentionItemsOf } from "@/relay/attention"
import { useCodexFrame } from "../root/context"
import { CodexKbd } from "../primitives/primitives"

type Row = { kind: "command"; key: string; label: string } | { kind: "session"; id: string; label: string; deviceId: string; openable: boolean }

/**
 * 命令面板（[X-§6] / X-10）：Ctrl/⌘+K 打开；命令列表 + Recent chats；↑↓/Enter/Esc；
 * 呈现 100% 自写（不 import CommandPaletteContainer / PiCommandPalette）；命令/会话数据复用 @/pi/model/palette。
 */
export function CodexCommandPalette({ p, onClose }: { p: VariantAppProps; onClose: () => void }) {
  const { relay, act } = p
  const frame = useCodexFrame()
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const sessions = useMemo(() => {
    const attention = attentionItemsOf({
      currentRoomId: relay.roomId,
      rooms: relay.rooms,
      dialogs: relay.dialogs,
      uiPrompt: relay.uiPrompt,
      turnEnd: relay.turnEnd,
      roomTurnEnds: relay.roomTurnEnds,
      selectedDevice: relay.selectedDevice,
    })
    return paletteSessionsOf({ devices: relay.devices, rooms: relay.rooms, sessionsByDevice: relay.sessionsByDevice, attention, currentRoomId: relay.roomId })
  }, [relay.devices, relay.rooms, relay.sessionsByDevice, relay.roomId, relay.dialogs, relay.uiPrompt, relay.turnEnd, relay.roomTurnEnds, relay.selectedDevice])
  const q = query.trim().toLowerCase()
  const commands = PI_PALETTE_COMMANDS.filter((row) => !q || row.label.toLowerCase().includes(q))
  const sessionRows = sessions.slice(0, q ? 20 : 4).filter((row) => !q || row.title.toLowerCase().includes(q))
  const rows: Row[] = [
    ...commands.map((row) => ({ kind: "command" as const, key: row.key, label: row.label })),
    ...sessionRows.map((row) => ({ kind: "session" as const, id: row.id, label: row.title, deviceId: row.deviceId, openable: row.row.openable })),
  ]
  const active = Math.min(index, Math.max(0, rows.length - 1))
  const run = (row: Row) => {
    onClose()
    if (row.kind === "session") {
      const hit = sessions.find((s) => s.id === row.id)
      if (!hit) return
      if (hit.row.openable) relay.selectRoom(hit.id)
      else {
        if (relay.selectedDeviceId !== hit.deviceId) relay.selectDevice(hit.deviceId)
        relay.selectListedSession(hit.row)
      }
      act.openSession()
      return
    }
    if (row.key === "new") act.newSession()
    else if (row.key === "sidebar") act.toggleSidebar()
    else if (row.key === "pane") act.togglePane()
    else if (row.key === "settings") act.openSettings()
  }
  return (
    <div className="cx-palette-layer" role="presentation" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="cx-palette" role="dialog" aria-modal="true" aria-label="命令面板" data-pi-ui-part="dialog" data-p4-surface="CX-DLG-01" data-p4-ready="">
        <label className="cx-palette-search">
          <Search aria-hidden size={15} strokeWidth={1.5} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索命令和会话…"
            aria-label="搜索命令和会话"
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setIndex((i) => Math.min(i + 1, rows.length - 1))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setIndex((i) => Math.max(i - 1, 0))
              } else if (event.key === "Enter") {
                event.preventDefault()
                if (rows[active]) run(rows[active])
              } else if (event.key === "Escape") onClose()
            }}
          />
          <CodexKbd>{frame.layout === "phone" ? "⌘K" : "Ctrl K"}</CodexKbd>
        </label>
        <div className="cx-palette-list" role="listbox">
          {commands.length > 0 ? <div className="cx-palette-group">命令</div> : null}
          {commands.map((row, i) => (
            <button
              key={row.key}
              type="button"
              role="option"
              aria-selected={active === i}
              className="cx-palette-row"
              data-p4-action="palette-command"
              data-active={active === i ? "" : undefined}
              onPointerEnter={() => setIndex(i)}
              onClick={() => run({ kind: "command", key: row.key, label: row.label })}
            >
              <span>{row.label}</span>
            </button>
          ))}
          {sessionRows.length > 0 ? <div className="cx-palette-group">会话</div> : null}
          {sessionRows.map((row, i) => {
            const at = commands.length + i
            return (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={active === at}
                className="cx-palette-row"
                data-p4-action="palette-session"
                data-active={active === at ? "" : undefined}
                onPointerEnter={() => setIndex(at)}
                onClick={() => run({ kind: "session", id: row.id, label: row.title, deviceId: row.deviceId, openable: row.row.openable })}
              >
                <span>{row.title}</span>
                <span className="cx-palette-meta">{row.group}</span>
              </button>
            )
          })}
          {rows.length === 0 ? <div className="cx-palette-empty">没有匹配的命令或会话</div> : null}
        </div>
        <footer className="cx-palette-foot">↑↓ 选择 · Enter 执行 · Esc 关闭</footer>
      </div>
    </div>
  )
}
