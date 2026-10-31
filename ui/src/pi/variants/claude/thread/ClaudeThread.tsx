import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, Copy, Check, RotateCcw } from "lucide-react"
import type { Item } from "@/relay/transcript"
import type { PiContainerProps } from "@/pi/containers/types"
import { historyTopLineOf, outboxItemsOf, runningOf, subagentsOf } from "@/pi/model/transcriptView"
import { PI_TRANSCRIPT_WINDOW, transcriptWindowOf } from "@/pi/model/transcriptWindow"
import { ClaudeIconButton, ClaudeMark } from "../primitives/ClaudePrimitives"
import { useNow } from "../primitives/useClaude"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"
import { usePiUiCapabilities } from "@/pi/extensions"
import { durationText, modelShortName, relativeLong, tokensText } from "../model/format"
import { ClaudeMarkdown, ClaudeReceipt, ClaudeRunningMark, ClaudeShowEarlier, ClaudeStreamTop } from "./ClaudeProseParts"
import { ClaudeExpandToggle, ClaudeToolBlock, ImageStrip } from "./ClaudeToolParts"

/**
 * Claude v2 自有对话流（§1.5 / §1.7 / [C-图9]）：用户气泡（18 圆角、85%、右对齐）、助手衬线 15/24 长段、
 * Thinking 折叠行、工具状态行 / 终端卡 / diff 卡 / 任务卡、错误行、流式、回合间距 32、操作条、图片（含按需补拉）。
 * 数据来自 relay.transcript.items（@/relay/** 允许）；条目整理借 @/pi/model/transcriptView 的纯函数；渲染与样式全部自有。
 */

function itemText(item: Extract<Item, { kind: "assistant" }>): string {
  return item.blocks
    .filter((b): b is Extract<Item, { kind: "assistant" }>["blocks"][number] & { kind: "text" } => b.kind === "text")
    .map((b) => b.text)
    .join("\n\n")
}

/**
 * R4 性能：消息级 memo（id + 内容引用）。
 * - 静态消息的 `item` 引用在流式时保持不变 → 不重复 parse markdown / 重建块；
 * - `now` 只在「最后一条助手消息」或运行中项上参与比较，避免每秒时钟把整列消息全部重渲染；
 * - 流式帧只改列表最后一条的 item 引用 → 只有最后一条重渲染。
 */
const ItemView = memo(ItemViewBase, (prev, next) => {
  if (prev.item !== next.item) return false
  if (prev.expanded !== next.expanded) return false
  if (prev.isLastAssistant !== next.isLastAssistant) return false
  if (prev.onLoadImage !== next.onLoadImage) return false
  if (prev.relay !== next.relay || prev.roomId !== next.roomId) return false
  if (next.isLastAssistant && prev.now !== next.now) return false
  return true
})

export function ClaudeThread({ relay }: Pick<PiContainerProps, "relay">) {
  const now = useNow(1000)
  const caps = usePiUiCapabilities()
  const firstArtifact = caps.statusOf("artifacts") === "simulated" ? caps.dataOf("artifacts")?.artifacts[0] : null
  const reviewStatus = caps.statusOf("code-review-comments")
  const reviewThreads = caps.dataOf("code-review-comments")?.threads ?? []
  const reviewDisabled = reviewStatus === "unavailable" ? caps.disabledOf("code-review-comments") : null
  const [reviewReceipt, setReviewReceipt] = useState<string | null>(null)
  const roomId = relay.roomId
  const live = roomId ? relay.transcript.items : EMPTY_ITEMS
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [lightbox, setLightbox] = useState<string | null>(null)
  // 渲染窗（D01，和主界面同口径）：一次只挂最近 300 条，流顶「显示更早的 N 条」点一次多挂一页。
  // 换会话在渲染期间把窗收回 300（先 setState 再渲染，不会先挂上旧会话的整段历史）。
  const [limit, setLimit] = useState(PI_TRANSCRIPT_WINDOW)
  const [shownRoom, setShownRoom] = useState(roomId)
  if (roomId !== shownRoom) {
    setShownRoom(roomId)
    setLimit(PI_TRANSCRIPT_WINDOW)
  }
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [newCount, setNewCount] = useState(0)
  // Listed-session preview: while the open room is an on-device session whose
  // transcript has not loaded yet, the stream pins to the top instead of the
  // bottom (see the scroll effects below). Mirrored into a ref because the
  // scroll listener and the room-change effect need the current value.
  const previewRef = useRef(false)

  const toggle = useCallback((key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setAtBottom(true)
    setNewCount(0)
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      // In preview state the scroll position is managed (pinned to top); the
      // small forced overflow must not flip the stick-to-bottom state.
      if (previewRef.current) return
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      if (bottom !== atBottomRef.current) {
        atBottomRef.current = bottom
        setAtBottom(bottom)
        if (bottom) setNewCount(0)
      }
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  const waiting = relay.dialogs.length > 0 || relay.uiPrompt != null
  const running = runningOf(live, relay.busy && !relay.lazySession, waiting)
  const outbox = outboxItemsOf(relay.outbox ?? [], live)
  const subagents = subagentsOf(relay.agentState)
  const topLine = historyTopLineOf(relay.history, roomId)
  const lazy = relay.lazySession && relay.lazySession.id === roomId ? relay.lazySession : null
  // Preview state: a listed session is open but its transcript has not loaded.
  const previewOnly = lazy != null && live.length === 0
  previewRef.current = previewOnly
  const visible = useMemo<Item[]>(
    () => (live.length > 0 ? live : lazy?.firstMessage ? [{ kind: "user", key: `lazy-${lazy.id}`, text: lazy.firstMessage, images: [] }] : EMPTY_ITEMS),
    [live, lazy],
  )
  // 渲染窗：流式时 items 每 50ms 换引用，窗口本身不变，按 [visible, limit] 缓存切片结果
  const win = useMemo(() => transcriptWindowOf(visible, limit), [visible, limit])
  // 「显示更早」：记下离底部的距离，新的一页挂上后还原，视口里的内容不跳（同 PiTranscript 的 restore）
  const restoreRef = useRef<number | null>(null)
  const showEarlier = useCallback(() => {
    const el = scrollerRef.current
    restoreRef.current = el ? el.scrollHeight - el.scrollTop : null
    setLimit((l) => l + PI_TRANSCRIPT_WINDOW)
  }, [])
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (restoreRef.current == null || !el) return
    el.scrollTop = el.scrollHeight - restoreRef.current
    restoreRef.current = null
  }, [limit])

  // 新条目：贴底时跟随；离开底部时攒新消息数
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (previewOnly) {
      // Listed-session preview: keep the first line fully visible. The preview
      // content only overflows because the review header block sits above a
      // min-height:100% inner, so bottom-pinning would clip the top lines.
      el.scrollTop = 0
      return
    }
    if (atBottomRef.current) el.scrollTop = el.scrollHeight
    else setNewCount((n) => n + 1)
  }, [visible.length, live.length, outbox.length, relay.busy, previewOnly])

  useEffect(() => {
    // Room switch (display-only reset): collapse all blocks; loaded rooms go
    // to the bottom, a listed (not-yet-loaded) session stays at the top so
    // its first line is fully visible.
    // eslint-disable-next-line react/set-state-in-effect
    setExpanded(new Set())
    if (previewRef.current) {
      const el = scrollerRef.current
      if (el) el.scrollTop = 0
      atBottomRef.current = true
      setAtBottom(true)
      setNewCount(0)
    } else {
      scrollToBottom()
    }
  }, [roomId, scrollToBottom])

  let lastAssistant: Item | null = null
  for (let i = visible.length - 1; i >= 0; i--) {
    const item = visible[i]
    if (item.kind === "assistant") {
      lastAssistant = item
      break
    }
    if (item.kind === "user") break
  }

  const loadEarlier = relay.history && relay.history.status === "more" ? () => void relay.loadEarlierHistory?.() : undefined

  const loadImage = useCallback(
    (image: { entryId?: string; blockIndex?: number; data: string; mimeType: string }) => {
      if (image.entryId == null || image.blockIndex == null) return
      void relay.getImage(image.entryId, image.blockIndex).then((reply) => {
        const data = reply as { data?: string; mimeType?: string } | null
        if (data?.data) setLightbox(`data:${data.mimeType || image.mimeType};base64,${data.data}`)
      })
    },
    [relay],
  )

  return (
    <div className="claude-stream" ref={scrollerRef}>
      <section className="claude-review-card" data-p4-surface="CL-CODE-10" data-p4-ready="" {...claudeCapabilityAttrs("code-review-comments", reviewStatus)}>
        <header className="claude-review-card-head">
          <span className="claude-review-card-title">/code-review 结果</span>
          {reviewStatus === "simulated" ? <span className="claude-badge">模拟演示</span> : null}
        </header>
        {reviewDisabled ? (
          <p className="claude-row-hint">{reviewDisabled.title}：{reviewDisabled.reason}（{reviewDisabled.docsPath}）</p>
        ) : reviewThreads.length === 0 ? (
          <p className="claude-row-hint">没有待处理的审查评论。</p>
        ) : (
          [...new Set(reviewThreads.map((thread) => thread.path))].map((path) => {
            const group = reviewThreads.filter((thread) => thread.path === path)
            return (
              <div key={path} className="claude-review-group" data-p4-row="">
                <span className="claude-row-label">{path}</span>
                <span className="claude-row-hint">{group.length} 条评论</span>
                {group.map((thread) => (
                  <p key={thread.id} className="claude-row-hint">
                    第 {thread.line ?? "?"} 行：{thread.comments.map((comment) => comment.body).join(" / ")}
                  </p>
                ))}
                <div className="claude-review-actions">
                  <button
                    type="button"
                    className="claude-btn claude-btn-outline claude-btn-sm"
                    data-p4-action="review-apply-fixes"
                    disabled={reviewStatus === "unavailable"}
                    onClick={() => setReviewReceipt(`已应用 ${path} 的修复（${reviewStatus === "simulated" ? "模拟演示 · 非真实" : "已接入"}）`)}
                  >
                    应用修复（需扩展）
                  </button>
                </div>
              </div>
            )
          })
        )}
        {reviewReceipt ? <p className="claude-row-hint" role="status" data-p4-receipt="">{reviewReceipt}；不会自动修改工作区文件，需 code-review 扩展落地</p> : null}
      </section>
      {firstArtifact ? (
        <div className="claude-artifact-card" data-p4-surface="CL-CODE-22" data-p4-ready="" {...claudeCapabilityAttrs("artifacts", caps.statusOf("artifacts"))}>
          <span className="claude-artifact-card-name">{firstArtifact.title}</span>
          <span className="claude-artifact-card-meta">{firstArtifact.kind} · Artifact</span>
          <button type="button" className="claude-btn claude-btn-outline claude-btn-sm" data-p4-action="open-artifact-card" onClick={() => caps.actionsOf("artifacts")?.openArtifact?.(firstArtifact.id)}>
            打开产物
          </button>
        </div>
      ) : null}
      <div className="claude-stream-inner">
        {topLine ? (
          <ClaudeStreamTop
            text={topLine.text}
            actionText={topLine.action ? topLine.actionText : undefined}
            onAction={loadEarlier}
            spinner={topLine.spinner}
          />
        ) : relay.history && relay.history.status === "loading" ? (
          <ClaudeStreamTop text="正在加载更早的记录…" spinner />
        ) : null}
        {lazy ? <ClaudeReceipt>这个会话只在本机记录里，发送第一条后载入正文</ClaudeReceipt> : null}
        {win.hidden > 0 ? <ClaudeShowEarlier hidden={win.hidden} nextPage={win.nextPage} onShow={showEarlier} /> : null}

        {win.visible.map((item) => {
          const isTurnStart = item.kind === "user"
          return (
            <div key={item.key} className="claude-stream-item" data-turn-start={isTurnStart ? "" : undefined} data-kind={item.kind}>
              <ItemView
                item={item}
                now={now}
                expanded={expanded}
                onToggle={toggle}
                isLastAssistant={lastAssistant != null && item === lastAssistant}
                onLoadImage={loadImage}
                relay={relay}
                roomId={roomId}
              />
            </div>
          )
        })}

        {subagents.length > 0
          ? subagents.map((agent) => (
              <div key={`${agent.name}-${agent.startedAt}`} className="claude-subagent-row">
                <ClaudeMark size={12} />
                <span className="claude-subagent-name">{agent.name}</span>
                <span className="claude-subagent-task">{agent.task}</span>
                <span className="claude-subagent-time">{durationText(now - agent.startedAt, true)}</span>
              </div>
            ))
          : null}

        {outbox.map((entry) => (
          <div key={entry.key} className="claude-stream-item claude-stream-outbox" data-turn-start="">
            <div className="claude-bubble claude-bubble-outbox">
              <div className="claude-bubble-text">{entry.text}</div>
            </div>
            <p className="claude-bubble-status">等重连后发送</p>
          </div>
        ))}

        {running ? (
          <div className="claude-running-line" data-label={running.line === false ? "waiting" : "working"}>
            <ClaudeRunningMark />
            <span>{running.line === false ? "等你回答" : "正在工作"}</span>
            {running.since != null ? <span className="claude-running-time">{durationText(now - (running.since ?? now), true)}</span> : null}
          </div>
        ) : null}

        {visible.length === 0 && !lazy ? (
          <div className="claude-stream-empty">
            <p className="claude-stream-empty-title">开始这段对话</p>
            <p className="claude-stream-empty-body">在下面输入第一句，pi 会在电脑上接住。</p>
          </div>
        ) : null}

        <div aria-hidden className="claude-stream-end" />
      </div>

      {!atBottom ? (
        <button type="button" className="claude-scroll-down" onClick={scrollToBottom}>
          <ArrowDown size={14} strokeWidth={2} aria-hidden />
          {newCount > 0 ? <span>{newCount > 9 ? "9+" : newCount}</span> : null}
        </button>
      ) : null}

      {lightbox ? (
        <div className="claude-lightbox" role="dialog" aria-modal="true" aria-label="查看图片">
          <button type="button" className="claude-overlay-backdrop" aria-label="关闭图片" onClick={() => setLightbox(null)} />
          <img src={lightbox} alt="图片" className="claude-lightbox-img" />
        </div>
      ) : null}
    </div>
  )
}

const EMPTY_ITEMS: Item[] = []

function metaLine(item: Extract<Item, { kind: "assistant" }>, now: number): string {
  const end = item.endedAt ?? item.timestamp
  const parts = [end ? relativeLong(end, now) : "", item.model ? modelShortName(item.model) : "", item.usage?.totalTokens != null ? `${tokensText(item.usage.totalTokens)} tok` : ""]
  return parts.filter(Boolean).join(" · ")
}

function ItemViewBase({
  item,
  now,
  expanded,
  onToggle,
  isLastAssistant,
  onLoadImage,
  relay,
  roomId,
}: {
  item: Item
  now: number
  expanded: ReadonlySet<string>
  onToggle: (key: string) => void
  isLastAssistant: boolean
  onLoadImage: (image: { entryId?: string; blockIndex?: number; data: string; mimeType: string }) => void
  relay: PiContainerProps["relay"]
  roomId: string
}) {
  const [copied, setCopied] = useState(false)
  if (item.kind === "user") {
    // F4: a bubble whose cid matches a pending remote-queue entry is queued,
    // not "sending" -- say so and give it send-now / cancel right here (the
    // queue panel above the composer keeps edit and the full list).
    const queueEntry = item.cid ? relay.remoteQueue.items.find((entry) => entry.status === "pending" && entry.cid === item.cid) : undefined
    return (
      <div className="claude-turn-user">
        <div className="claude-bubble">
          {item.images.length > 0 ? <ImageStrip images={item.images} onLoad={onLoadImage} /> : null}
          {item.text ? <div className="claude-bubble-text">{item.text}</div> : null}
        </div>
        {item.failed ? (
          <p className="claude-bubble-status" data-tone="error">
            发送失败
            <button type="button" className="claude-link-btn" onClick={() => void relay.sendText(item.text)}>
              重试
            </button>
          </p>
        ) : queueEntry ? (
          <p className="claude-bubble-status">
            排队中
            <button type="button" className="claude-link-btn" onClick={() => void relay.queueSendNow(queueEntry.id)}>
              立即发送
            </button>
            <button type="button" className="claude-link-btn" onClick={() => void relay.queueCancel(queueEntry.id).catch(() => relay.notify("取消失败", "warn"))}>
              取消
            </button>
          </p>
        ) : item.status === "sending" ? (
          <p className="claude-bubble-status">发送中…</p>
        ) : null}
      </div>
    )
  }
  if (item.kind === "summary") {
    return <ClaudeReceipt>{item.title}</ClaudeReceipt>
  }
  if (item.kind === "bash") {
    return (
      <section className="claude-terminal-card">
        <header className="claude-terminal-head">
          <span className="claude-terminal-title">运行命令</span>
          <span className="claude-terminal-command">{item.command}</span>
        </header>
        <pre className="claude-terminal-body">{item.output || "（没有输出）"}</pre>
      </section>
    )
  }
  if (item.kind === "custom") {
    return (
      <>
        <ClaudeReceipt>{item.label}</ClaudeReceipt>
        <ClaudeMarkdown text={item.text} />
      </>
    )
  }
  // assistant
  const copy = () => {
    void navigator.clipboard?.writeText(itemText(item)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="claude-turn-assistant">
      {item.blocks.map((block, index) => {
        const key = `${item.key}:${index}`
        if (block.kind === "text") return <ClaudeMarkdown key={key} text={block.text} />
        if (block.kind === "thinking") {
          const open = expanded.has(key)
          const label = "已思考"
          return (
            <div key={key} className="claude-thinking" data-open={open ? "" : undefined}>
              <ClaudeExpandToggle open={open} onClick={() => onToggle(key)}>
                {label}
              </ClaudeExpandToggle>
              {open ? <div className="claude-thinking-body">{block.text}</div> : null}
            </div>
          )
        }
        return <ClaudeToolBlock key={key} block={block} live={item.live} onLoadImage={onLoadImage} />
      })}
      {item.errorMessage ? <ClaudeReceipt tone="error">这一轮出错了：{item.errorMessage}</ClaudeReceipt> : null}
      {isLastAssistant && !item.live ? (
        <div className="claude-actions">
          <ClaudeIconButton label={copied ? "已复制" : "复制回复"} icon={copied ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />} className="claude-action-btn" onClick={copy} />
          <ClaudeIconButton
            label="重新回答"
            icon={<RotateCcw size={14} strokeWidth={1.75} />}
            className="claude-action-btn"
            onClick={() => void relay.sendText("/regenerate")}
          />
          <span className="claude-actions-meta">{metaLine(item, now)}</span>
        </div>
      ) : null}
      {roomId && item.usage?.totalTokens != null && isLastAssistant ? null : null}
    </div>
  )
}
