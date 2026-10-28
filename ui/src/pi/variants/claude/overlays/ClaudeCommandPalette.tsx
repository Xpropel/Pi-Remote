import { useEffect, useMemo, useState } from "react"
import { Search } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { attentionItemsOf } from "@/relay/attention"
import { paletteOfflineReasonOf, paletteSessionsOf, PI_PALETTE_COMMANDS, PALETTE_RECENT, type PiPaletteSession } from "@/pi/model/palette"
import { paletteMatches } from "@/pi/model/composerInput"
import { sessionLoaded } from "../model/view"
import { ClaudeMark } from "../primitives/ClaudePrimitives"
import { useNow } from "../primitives/useClaude"
import { useEscClose } from "../primitives/useClaude"
import { relativeShort } from "../model/format"

/**
 * Claude v2 自有命令面板（C-10 / [C-图8③]）：双环 popover 结果列表（标题匹配在上、正文匹配在下）、↑↓ 选中、Enter 执行、Esc 关闭。
 * 命令组与会话组的数据/过滤复用 @/pi/model/palette 纯函数；渲染、键盘与样式全部自有。
 */

type Row = { kind: "command"; key: string; label: string } | { kind: "session"; session: PiPaletteSession }

export function ClaudeCommandPalette({ p }: { p: PiContainerProps }) {
  const { relay, ui, act } = p
  const open = ui.paletteOpen
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const now = useNow(30_000)
  const close = () => {
    setQuery("")
    setIndex(0)
    act.setPaletteOpen(false)
  }
  useEscClose(open, close)

  const sessions = useMemo(() => {
    if (!open) return []
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
  }, [open, relay])

  const offline = paletteOfflineReasonOf({
    authed: relay.authed,
    browserOnline: relay.browserOnline,
    roomId: relay.roomId,
    online: relay.online,
    loaded: sessionLoaded(relay),
    deviceName: relay.selectedDevice?.name,
  })

  const rows: Row[] = useMemo(() => {
    if (!open) return []
    const q = query.trim()
    const commands: Row[] = PI_PALETTE_COMMANDS.filter((c) => !q || paletteMatches(q, c.label)).map((c) => ({ kind: "command" as const, key: c.key, label: c.label }))
    const wanted = q ? sessions.filter((s) => paletteMatches(q, s.title, s.group)) : sessions.slice(0, PALETTE_RECENT)
    return [...commands, ...wanted.map((session) => ({ kind: "session" as const, session }))]
  }, [open, query, sessions])

  useEffect(() => {
    // 结果条数变化后把选中项夹回范围（避免悬停/↑↓ 越界）
    // eslint-disable-next-line react/set-state-in-effect
    setIndex((cur) => (rows.length === 0 ? 0 : Math.min(cur, rows.length - 1)))
  }, [rows.length])

  const run = (row: Row) => {
    if (row.kind === "session") {
      close()
      const hit = row.session
      if (hit.row.openable) relay.selectRoom(hit.id)
      else {
        if (relay.selectedDeviceId !== hit.deviceId) relay.selectDevice(hit.deviceId)
        relay.selectListedSession(hit.row)
      }
      act.openSession()
      return
    }
    close()
    switch (row.key) {
      case "new":
        act.newSession()
        break
      case "sidebar":
        act.toggleSidebar()
        break
      case "pane":
        act.togglePane()
        break
      case "settings":
        act.openSettings()
        break
      default:
        relay.notify("这个命令在 Claude v2 里还没接入", "warn")
    }
  }

  if (!open) return null
  return (
    <div className="claude-overlay-layer claude-palette-layer" role="presentation">
      <button type="button" aria-label="关闭" className="claude-overlay-backdrop" onClick={close} />
      <div className="claude-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="claude-palette-inputrow">
          <Search size={15} strokeWidth={1.75} aria-hidden />
          <input
            className="claude-palette-input"
            autoFocus
            value={query}
            placeholder="搜索命令和会话…"
            aria-label="搜索命令和会话"
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setIndex((i) => (rows.length ? (i + 1) % rows.length : 0))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setIndex((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0))
              } else if (event.key === "Enter") {
                event.preventDefault()
                const row = rows[index]
                if (row) run(row)
              }
            }}
          />
          <span className="claude-kbd">Esc</span>
        </div>
        {offline ? <p className="claude-palette-note">{offline}</p> : null}
        <div className="claude-palette-list" role="listbox">
          {rows.map((row, i) => {
            if (row.kind === "command") {
              return (
                <button
                  key={`cmd-${row.key}`}
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  className="claude-palette-row"
                  data-active={i === index ? "" : undefined}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => run(row)}
                >
                  <ClaudeMark size={12} />
                  <span className="claude-palette-row-title">{row.label}</span>
                  <span className="claude-palette-row-group">命令</span>
                </button>
              )
            }
            return (
              <button
                key={`s-${row.session.id}`}
                type="button"
                role="option"
                aria-selected={i === index}
                className="claude-palette-row"
                data-active={i === index ? "" : undefined}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(row)}
              >
                <span className="claude-palette-row-title">{row.session.title}</span>
                <span className="claude-palette-row-group">{row.session.group}</span>
                {row.session.updatedAt ? <span className="claude-palette-row-time">{relativeShort(row.session.updatedAt, now)}</span> : null}
              </button>
            )
          })}
          {rows.length === 0 ? <p className="claude-palette-empty">没有匹配的命令或会话</p> : null}
        </div>
        <div className="claude-palette-foot">↑↓ 选择 · Enter 执行 · Esc 关闭</div>
      </div>
    </div>
  )
}
