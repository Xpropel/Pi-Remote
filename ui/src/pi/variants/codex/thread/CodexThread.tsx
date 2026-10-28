import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown } from "../icons/CodexIcons"
import type { Item } from "@/relay/transcript"
import type { VariantAppProps } from "@/pi/variants/types"
import { EMPTY_THINKING_CLOCK, historyTopLineOf, observeThinking, runningOf, subagentsOf, type PiThinkingClock } from "@/pi/model/transcriptView"
import { useNow, useStickToBottom } from "../hooks/useCodex"
import { codexSplitTurns, codexTurnWorkedMs } from "../logic/transcript"
import { piDuration } from "../logic/view"
import { CodexSpinner, CodexCentered } from "../primitives/primitives"
import { CodexRunningLine } from "./CodexStreamTail"
import { CodexTurn } from "./CodexTurn"
import { CodexLightbox } from "./CodexLightbox"
import { CodexThreadHead } from "./CodexThreadHead"

/**
 * Codex 对话流（[X-§1][X-图7③] / X-01-3）：正文列 768 居中、上 33 左右 24 下 32；原生滚动 + 贴底；
 * 回合结构由 CodexTurn 组装；历史/归档/快照行在此渲染。全部自写（不 import PiTranscript / TranscriptContainer）。
 */
export function CodexThread({ p, phone }: { p: VariantAppProps; phone: boolean }) {
  const { relay } = p
  const roomId = relay.roomId
  const liveItems = roomId ? relay.transcript.items : EMPTY
  const lazy = relay.lazySession && relay.lazySession.id === roomId ? relay.lazySession : null
  const archive = lazy && liveItems.length === 0 ? relay.sessionArchive(lazy.id) : null
  const source: readonly Item[] = liveItems.length > 0 ? liveItems : (archive?.items ?? EMPTY)
  const waiting = relay.dialogs.length > 0 || relay.uiPrompt != null
  const running = runningOf(source, relay.busy && !lazy, waiting)
  const subagents = useMemo(() => subagentsOf(relay.agentState), [relay.agentState])
  const [clock, setClock] = useState<{ room: string; items: readonly Item[]; clock: PiThinkingClock }>({ room: roomId, items: EMPTY, clock: EMPTY_THINKING_CLOCK })
  if (clock.items !== liveItems || clock.room !== roomId) {
    const base = clock.room === roomId ? clock.clock : EMPTY_THINKING_CLOCK
    setClock({ room: roomId, items: liveItems, clock: observeThinking(base, liveItems, Date.now()) })
  }
  const observed = clock.room === roomId ? clock.clock.done : EMPTY_THINKING_CLOCK.done
  const outbox = useMemo<Item[]>(() => {
    const shown = new Set<string>()
    for (const item of source) if (item.kind === "user" && item.cid) shown.add(item.cid)
    return relay.outbox
      .filter((entry) => entry.status !== "failed" && !shown.has(entry.cid))
      .map((entry) => ({ kind: "user", key: `outbox-${entry.cid}`, text: entry.text, images: [], timestamp: entry.at, from: "remote", cid: entry.cid, outbox: true }) as Item)
  }, [relay.outbox, source])
  const items = outbox.length > 0 ? [...source, ...outbox] : source
  const turns = useMemo(() => codexSplitTurns(items), [items])
  // R4 性能动作 3：长会话分块渲染（默认最近 80 回合；旧回合折叠成一行按钮，点击再展开 80）
  const CHUNK = 80
  const [visibleTurns, setVisibleTurns] = useState(CHUNK)
  useEffect(() => {
    setVisibleTurns(CHUNK)
  }, [roomId])
  const hiddenTurns = Math.max(0, turns.length - visibleTurns)
  const shownTurns = hiddenTurns > 0 ? turns.slice(hiddenTurns) : turns
  const scroller = useRef<HTMLDivElement>(null)
  const { atBottom, scrollToBottom } = useStickToBottom(scroller)
  const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null)
  const history = lazy ? null : historyTopLineOf(relay.history, roomId)
  const archiveLine = lazy ? `这是电脑上保存的记录，发第一条消息时在 ${relay.devices.find((d) => d.id === lazy.deviceId)?.name ?? "电脑"} 上载入` : null
  const now = useNow(1000)
  return (
    <div className="cx-thread" data-pi-ui-part="thread" data-p4-surface="CX-THREAD-01" data-p4-ready="" data-total-turns={turns.length} data-rendered-turns={shownTurns.length}>
      <div ref={scroller} className="cx-thread-scroll">
        <div className="cx-thread-col">
          {!phone && roomId ? <CodexThreadHead p={p} /> : null}
          <span className="cx-p4-marker" aria-hidden data-p4-surface="CX-XCUT-03" data-p4-ready="" />
          {archiveLine || (relay.snapshotPending && source.length === 0) || history ? (
            <div className="cx-thread-top">
              {history ? (
                <button type="button" className="cx-inline-link" onClick={() => void relay.loadEarlierHistory()}>
                  {history.actionText ?? history.text}
                </button>
              ) : null}
              {archiveLine ? (
                <div className="cx-thread-top-line">
                  <CodexSpinner size={11} />
                  <span>{archiveLine}</span>
                </div>
              ) : null}
              {relay.snapshotPending && source.length === 0 ? (
                <div className="cx-thread-top-line">
                  <CodexSpinner size={11} />
                  <span>正在载入会话…</span>
                </div>
              ) : null}
            </div>
          ) : null}
          {hiddenTurns > 0 ? (
            <div className="cx-thread-top">
              <button type="button" className="cx-inline-link" data-p4-action="show-earlier-turns" onClick={() => setVisibleTurns((count) => count + CHUNK)}>
                显示更早的 {Math.min(hiddenTurns, CHUNK)} 个回合（共 {turns.length}）
              </button>
            </div>
          ) : null}
          {shownTurns.map((turn, index) => (
            <CodexTurn
              key={turn.user?.key ?? `t${hiddenTurns + index}`}
              p={p}
              turn={turn}
              phone={phone}
              observed={observed}
              workedMs={codexTurnWorkedMs(turn)}
              running={hiddenTurns + index === turns.length - 1 && running != null}
              subagents={subagents}
              onOpenImage={setLightbox}
            />
          ))}
          {turns.length === 0 && !relay.snapshotPending ? <CodexCentered title="这个会话还没有消息" /> : null}
          {running && running.line !== false ? <CodexRunningLine elapsed={running.since != null ? piDuration(now - running.since, { zero: true }) : undefined} /> : null}
        </div>
      </div>
      {!atBottom ? (
        <button type="button" className="cx-scroll-down" onClick={scrollToBottom} aria-label="回到底部">
          <ArrowDown aria-hidden size={14} strokeWidth={1.75} />
        </button>
      ) : null}
      <CodexLightbox image={lightbox} onClose={() => setLightbox(null)} />
    </div>
  )
}

const EMPTY: readonly Item[] = []
