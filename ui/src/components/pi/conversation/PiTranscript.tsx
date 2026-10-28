import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react"
import { SubagentRow } from "@/components/kit/stream/SubagentRow"
import { AgentProse, ChatColumn, InlineLink } from "@/components/kit"
import { cn } from "@/lib/utils"
import { piAgo, piDuration, piModelShort, piThinkSeconds, piTokens } from "@/components/pi/shared/format"
import { usePiStatic } from "@/components/pi/shared/layers"
import { usePiMotion } from "@/pi/hooks/useReducedMotion"
import { usePiStickToBottom } from "@/pi/hooks/usePiStickToBottom"
import { isOwnSendAppended, lastKeyOf, newItemsAfter, PI_TRANSCRIPT_WINDOW, showEarlierText, transcriptWindowOf } from "@/pi/model/transcriptWindow"
import { PiTranscriptActionsContext, usePiTranscriptActions, type PiTranscriptActions } from "./actions"
import { PiDiffCard } from "./PiDiffCard"
import { PiProse } from "./PiProse"
import { PiReceipt, PiRunningLine, PiThinking, PiToolLine, PiTurnError } from "./PiStreamLines"
import { PiTerminalCard } from "./PiTerminalCard"
import { PiImageGrid, PiReplyActions, PiUserTurn } from "./PiTurnParts"
import { T_SECONDARY, TOUCH_44_TEXT } from "./styles"
import {
  bashPhrase,
  exploreSummary,
  otherDetail,
  readDetail,
  splitThinking,
  stopReasonText,
  timeoutSeconds,
  toolCommand,
  toolPath,
  toolStatus,
  toolWeight,
} from "./tools"
import type { PiAssistantItem, PiBlock, PiDensity, PiImagePart, PiItem, PiSubagent, PiToolBlock } from "@/components/pi/shared/types"

/** PiTranscript 的命令（可交互态，ref 拿到）：tray 的"回到底部"钮调 scrollToBottom */
export interface PiTranscriptHandle {
  scrollToBottom: () => void
}

/** 吸底状态（可交互态，onStickChange 回调）：atBottom = 在底部（贴着跟随）；newCount = 离开底部后新来的条数（D21） */
export interface PiStickChange {
  atBottom: boolean
  newCount: number
}

/** 点了流里的一张图：images = 这一组图，index = 第几张，el = 被点的那张（灯箱关闭后焦点回它，design §4.7） */
export type PiOpenImage = (images: readonly PiImagePart[], index: number, el: HTMLElement) => void

export interface PiTranscriptProps {
  items: readonly PiItem[]
  variant: "desktop" | "phone"
  density?: PiDensity
  /** 流顶一行（PiStreamTopLine：补拉失败、离线只读、未载入说明…） */
  topLine?: ReactNode
  /**
   * 回合进行中：不出回合用时与操作行；流末尾"正在工作 42s"。
   * line: false = 回合仍在进行但不画运行行（等你回答时，状态只在审批卡一处表达，§5）
   * since: null = 不知道回合几时开始（没有时间戳），运行行不写用时（§1.9，P5.4）
   */
  running?: { since: number | null; line?: boolean } | null
  /** agent_state 上报的子智能体（没有上报就不传，不出现 subagent 行） */
  subagents?: readonly PiSubagent[]
  now: number
  /* ---- 以下是 b 区加的可选字段（§6.4：只许加可选字段） ---- */
  /** 展开的块：工具块 id、思考块 "<item.key>:<块下标>"、正文折叠块同样写法 */
  expanded?: readonly string[]
  /** 初始滚动：默认贴底 */
  scroll?: "bottom" | number
  /** centered = 对话列居中限宽 768；pane = 右 pane 打开时占满、左右 24 */
  layout?: "centered" | "pane"
  /** 长回复折叠（D16）：这些 text 块（"<item.key>:<块下标>"）超过 maxHeight 时收起 */
  folded?: readonly string[]
  /** 运行行的文字（默认"正在工作"；等审批时写"等你回答"） */
  runningLabel?: string
  className?: string
  /* ---- P4（PLAN 4.3；R2/p4-lanes.md §1） ---- */
  /** 静态态（画廊截图）：和冻结版逐像素一致，不挂滚动监听。不传时取 PiStaticProvider（画廊舞台 = true，产品 / #/play = false） */
  static?: boolean
  /** 会话标识：变了 = 切会话（渲染窗回到 300 条、回到底部、淡入） */
  sessionKey?: string
  /** 可交互态：吸底状态变化时回调（挂载时先报一次）。容器据此给 tray 传 scrollDown / newCount */
  onStickChange?: (state: PiStickChange) => void
  /** 可交互态：点了用户卡或 read 结果里的图（打开灯箱） */
  onOpenImage?: PiOpenImage
  /** 可交互态：scrollToBottom()（"回到底部"钮） */
  ref?: Ref<PiTranscriptHandle>
  /* ---- P5.4（容器接真实数据） ---- */
  /** 可交互态：流里各处点击的去处（文件 chip、发送失败重试、重新回答、复制回复、取原图），见 ./actions.ts。不传 = 都不可点 */
  actions?: PiTranscriptActions
  /** 没有 prose 节点的正文块（产品里都是 Markdown 原文）超过 maxHeight 时自动折叠（D16；容器在只读的本机记录里开） */
  foldLong?: boolean
}

type Turn = { user?: Extract<PiItem, { kind: "user" }>; rest: PiItem[] }

/** 按用户消息切回合：回合用时 = 用户消息时间戳 → 回合里最后一条消息的结束时间（§1.9，缺任一就不显示） */
function splitTurns(items: readonly PiItem[]): Turn[] {
  const turns: Turn[] = []
  for (const item of items) {
    if (item.kind === "user") turns.push({ user: item, rest: [] })
    else {
      if (turns.length === 0) turns.push({ rest: [] })
      turns[turns.length - 1].rest.push(item)
    }
  }
  return turns
}

function itemEnd(item: PiItem): number | undefined {
  if (item.kind === "assistant") {
    if (item.endedAt != null) return item.endedAt
    if (item.startedAt != null && item.durationMs != null) return item.startedAt + item.durationMs
  }
  return item.timestamp
}

/**
 * 对话流（PiTranscript；b 出、a / c 用）。外层是 kit ChatColumn（自带滚动区、底部渐隐）。
 * 版式：用户卡 → "用时 2m 14s" → 思考 → 轻工具行 / 终端卡 / diff 卡 → 正文 → 操作行（§3.4 conversation）。
 * 长会话只挂最近 300 条（D01，流顶"显示更早的 N 条"）。
 * 可交互态（PLAN 4.3）另有：吸底跟随、上滑松开（onStickChange 报 atBottom / newCount，D21）、ref.scrollToBottom()、
 * 切会话淡入、点图打开灯箱。静态态（画廊）照冻结版画，L1 像素不变。
 */
export function PiTranscript(props: PiTranscriptProps) {
  const isStatic = usePiStatic(props.static)
  const body = isStatic ? <PiTranscriptStatic {...props} /> : <PiTranscriptLive {...props} />
  return props.actions ? <PiTranscriptActionsContext.Provider value={props.actions}>{body}</PiTranscriptActionsContext.Provider> : body
}

/** 静态态：冻结版的样子（渲染窗照样生效；画廊的流都不到 300 条，所以没有"显示更早"）；不接点图 */
function PiTranscriptStatic(props: PiTranscriptProps) {
  const { items, variant, scroll = "bottom", layout = "centered", className } = props
  const win = transcriptWindowOf(items, PI_TRANSCRIPT_WINDOW)
  const content = <TranscriptContent src={props} items={win.visible} hidden={win.hidden} nextPage={win.nextPage} />
  if (variant === "phone") {
    // 手机：PiPhonePage 的 children 已经在唯一的滚动区里（shared-ready.md），这里只排版，不再套滚动容器
    return (
      <div data-pi-part="transcript" data-variant="phone" className={cn(PHONE_ROOT, className)} style={PHONE_STYLE}>
        {content}
      </div>
    )
  }
  return (
    <ChatColumn data-pi-part="transcript" data-variant="desktop" {...desktopColumn(layout)} scrollTop={scroll} className={className}>
      {content}
    </ChatColumn>
  )
}

const PHONE_ROOT = "flow-root px-4 pt-1 pb-3"
const PHONE_STYLE = { "--stream-inset": "4px" } as CSSProperties
/** 切会话淡入的时长（推断；减少动效时不做） */
const SWITCH_FADE_MS = 160

/** 桌面：PiDesktopShell 的正文盒是满高 relative 盒，正文自己滚动；列宽 / 留白跟 --cw-pi-chat-w / --cw-pi-chat-gutter */
function desktopColumn(layout: "centered" | "pane") {
  return {
    layout: "centered" as const,
    maxWidth: layout === "pane" ? "100%" : "var(--cw-pi-chat-w, 768px)",
    fade: 32,
    // 左右留白（kit-requests pi b4）：右 pane 里 24，主区跟 PiDesktopShell 的 --cw-pi-chat-gutter（40 / 24）
    gutter: layout === "pane" ? 24 : "var(--cw-pi-chat-gutter, 40px)",
    contentClassName: "pb-6",
  }
}

/**
 * 可交互态（PLAN 4.3）：
 * - 滚动容器用现成的：桌面 = ChatColumn 的 [data-cw-scroller]，手机 = PiPhonePage 唯一的 [data-pi-scroller]（不再套一层，
 *   overscroll-behavior 已是 contain，design §4.5）。use-stick-to-bottom 接在上面（usePiStickToBottom），ChatColumn 自己的
 *   "初始贴底后跟随内容变高"不再用（它只在滚轮 / 触摸后停，键盘上滑也会被拉回去）。
 * - 根节点 data-pi-stick="bottom" | "free"、data-pi-new-count：给 ui-interact 断言。
 */
function PiTranscriptLive(props: PiTranscriptProps) {
  const { items, variant, scroll = "bottom", layout = "centered", className, sessionKey, onStickChange, ref } = props
  const phone = variant === "phone"
  const stick = usePiStickToBottom()
  const { pageTransitionMs } = usePiMotion()
  const [limit, setLimit] = useState(PI_TRANSCRIPT_WINDOW)
  /** 离开底部时的最后一条：key + 当时的下标（key 被原位换掉时按下标数，O-R1） */
  const [mark, setMark] = useState<{ key: string; at: number } | null>(null)
  const [shownKey, setShownKey] = useState(sessionKey)
  // 切会话：渲染窗回到 300、新消息计数清零（渲染期间调整 state，React 文档的写法）
  const switched = sessionKey !== shownKey
  if (switched) {
    setShownKey(sessionKey)
    setLimit(PI_TRANSCRIPT_WINDOW)
    setMark(null)
  }
  // 离开底部时记下最后一条，回到底部时清掉（D21 的"N 条新消息"从记下的那条往后数）
  const lastKey = lastKeyOf(items)
  if (!switched && !stick.atBottom && mark == null && lastKey != null) setMark({ key: lastKey, at: items.length - 1 })
  if (stick.atBottom && mark != null) setMark(null)
  const newCount = stick.atBottom ? 0 : newItemsAfter(items, mark?.key ?? null, mark?.at)
  const win = transcriptWindowOf(items, limit)

  /** 手机 = 根节点；桌面 = 内容末尾的空锚点（ChatColumn 不给滚动容器的 ref，从锚点往上找） */
  const anchorRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const contentRef = useRef<HTMLElement | null>(null)
  const initialScroll = useRef(scroll)
  const { attach, release, scrollToBottom } = stick
  useLayoutEffect(() => {
    const el = anchorRef.current
    const scroller = el?.closest<HTMLElement>(phone ? "[data-pi-scroller]" : "[data-cw-scroller]") ?? null
    const content = phone ? el : (el?.parentElement ?? null)
    scrollerRef.current = scroller
    contentRef.current = content
    if (scroller) {
      // 打开时直接在目标位置（绘制之前设好，不闪一帧顶部）；数字 = 停在那里、不贴底
      const at = initialScroll.current
      if (at === "bottom") scroller.scrollTop = scroller.scrollHeight
      else {
        scroller.scrollTop = at
        release()
      }
    }
    attach(scroller, content)
    return () => {
      attach(null, null)
      scrollerRef.current = null
      contentRef.current = null
    }
  }, [phone, attach, release])

  // 切会话后：回到底部重新贴住，内容淡入（减少动效时不淡入）。只在 shownKey 真的变了时跑（开发模式 StrictMode 的二次挂载不算）
  const prevShown = useRef(shownKey)
  useLayoutEffect(() => {
    if (prevShown.current === shownKey) return
    prevShown.current = shownKey
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    scrollToBottom(true)
    if (pageTransitionMs > 0) contentRef.current?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: SWITCH_FADE_MS, easing: "ease-out" })
  }, [shownKey, scrollToBottom, pageTransitionMs])

  // 本页发出消息（O-R1）：回到底部重新贴住。离开底部（上滑、点开上面的图片）之后自己再发消息，流不该停在原处、计数也不该从那里数
  const sentLast = useRef(lastKey)
  useLayoutEffect(() => {
    const prev = sentLast.current
    sentLast.current = lastKey
    if (isOwnSendAppended(items, prev)) scrollToBottom()
  }, [items, lastKey, scrollToBottom])

  // 显示更早的一页：记下离底部的距离，新的一页挂上后还原，视口里的内容不跳
  const restore = useRef<number | null>(null)
  const showEarlier = useCallback(() => {
    const s = scrollerRef.current
    restore.current = s ? s.scrollHeight - s.scrollTop : null
    setLimit((l) => l + PI_TRANSCRIPT_WINDOW)
  }, [])
  useLayoutEffect(() => {
    const s = scrollerRef.current
    if (restore.current == null || !s) return
    s.scrollTop = s.scrollHeight - restore.current
    restore.current = null
  }, [limit])

  // 回调存在 ref 里：容器传内联函数也不会每次渲染都重报
  const onStick = useRef(onStickChange)
  useLayoutEffect(() => {
    onStick.current = onStickChange
  })
  useEffect(() => {
    onStick.current?.({ atBottom: stick.atBottom, newCount })
  }, [stick.atBottom, newCount])
  useImperativeHandle(ref, () => ({ scrollToBottom: () => scrollToBottom() }), [scrollToBottom])

  const stickData = { "data-pi-stick": stick.atBottom ? "bottom" : "free", "data-pi-new-count": String(newCount) }
  const content = (
    <TranscriptContent
      src={props}
      items={win.visible}
      hidden={win.hidden}
      nextPage={win.nextPage}
      onShowEarlier={showEarlier}
      onOpenImage={props.onOpenImage}
    />
  )
  if (phone) {
    return (
      <div ref={anchorRef} data-pi-part="transcript" data-variant="phone" {...stickData} className={cn(PHONE_ROOT, className)} style={PHONE_STYLE}>
        {content}
      </div>
    )
  }
  return (
    <ChatColumn data-pi-part="transcript" data-variant="desktop" {...stickData} {...desktopColumn(layout)} className={className}>
      {content}
      <div ref={anchorRef} aria-hidden data-pi-part="stream-end" />
    </ChatColumn>
  )
}

interface TranscriptContentProps {
  /** PiTranscript 收到的 props（只读其中的内容字段） */
  src: PiTranscriptProps
  /** 渲染窗里的那一段 */
  items: readonly PiItem[]
  /** 渲染窗外（更早）还有几条 */
  hidden: number
  /** "显示更早的 N 条"的 N */
  nextPage: number
  /** 可交互态：点"显示更早的 N 条" */
  onShowEarlier?: () => void
  /** 可交互态：点图（静态态不传） */
  onOpenImage?: PiOpenImage
}

/**
 * 没传展开 / 折叠集合时的缺省引用：**必须**是模块级常量。
 * 默认值写成 `= []` 会在每次渲染都造一个新数组，open / fold 的 useMemo 跟着失效，
 * ItemView 的 memo 就永远命不中（生产里 folded 一直没传，等于白加）。
 */
const NO_BLOCK_KEYS: readonly string[] = []

/** 流的内容（静态 / 可交互共用）：流顶一行 → "显示更早的 N 条" → 各回合 → 运行行 */
function TranscriptContent({ src, items, hidden, nextPage, onShowEarlier, onOpenImage: openImage }: TranscriptContentProps) {
  const {
    variant,
    density = "balanced",
    topLine,
    running,
    subagents,
    now,
    expanded = NO_BLOCK_KEYS,
    folded = NO_BLOCK_KEYS,
    runningLabel,
    foldLong = false,
  } = src
  const phone = variant === "phone"
  const turns = splitTurns(items)
  // 展开 / 折叠集合按 props 身份缓存：每秒的时钟 tick 和 50ms 的流式批次不再造出新 Set，
  // 否则 ItemView 的 memo 会被这两个 prop 每次打穿（UI·perf 中-1）。
  const open = useMemo(() => new Set(expanded), [expanded])
  const fold = useMemo(() => new Set(folded), [folded])
  const lastTurn = turns.length - 1
  return (
    <>
      {topLine}
      {hidden > 0 && (
        <div data-pi-part="show-earlier" data-hidden={hidden} className="pb-(--cw-space-2)">
          <PiReceipt>
            <InlineLink className={cn("whitespace-nowrap", TOUCH_44_TEXT)} onClick={onShowEarlier}>
              {showEarlierText(nextPage)}
            </InlineLink>
          </PiReceipt>
        </div>
      )}
      {turns.map((turn, ti) => {
        const isRunningTurn = ti === lastTurn && running != null
        const end = turn.rest.reduce<number | undefined>((acc, it) => {
          const e = itemEnd(it)
          return e != null && (acc == null || e > acc) ? e : acc
        }, undefined)
        const duration =
          !isRunningTurn && turn.user?.timestamp != null && end != null && turn.rest.some((r) => r.kind === "assistant")
            ? end - turn.user.timestamp
            : null
        const lastAssistant = [...turn.rest].reverse().find((r): r is PiAssistantItem => r.kind === "assistant")
        let subagentsPlaced = !isRunningTurn || !subagents || subagents.length === 0
        return (
          <div key={turn.user?.key ?? `t${ti}`} data-pi-part="turn">
            {turn.user && <PiUserTurn item={turn.user} imageHeight={phone ? 120 : 160} onOpenImage={openImage} />}
            {duration != null && duration > 0 && <PiReceipt>用时 {piDuration(duration, { zero: true })}</PiReceipt>}
            {turn.rest.map((item) => {
              let sub: ReactNode = null
              if (!subagentsPlaced && item.kind === "assistant") {
                subagentsPlaced = true
                sub = <SubagentRows subagents={subagents ?? []} now={now} />
              }
              return (
                <ItemView
                  key={item.key}
                  item={item}
                  variant={variant}
                  density={density}
                  open={open}
                  fold={fold}
                  foldLong={foldLong}
                  subagentSlot={sub}
                  replyMeta={!isRunningTurn && item === lastAssistant ? replyMeta(item, now) : null}
                  showRetry={ti === lastTurn}
                  onOpenImage={openImage}
                />
              )
            })}
            {!subagentsPlaced && <SubagentRows subagents={subagents ?? []} now={now} />}
          </div>
        )
      })}
      {running && running.line !== false && (
        <PiRunningLine label={runningLabel} elapsed={running.since != null ? piDuration(now - running.since, { zero: true }) : undefined} />
      )}
    </>
  )
}

function replyMeta(item: PiAssistantItem, now: number): string {
  const parts: string[] = []
  const end = itemEnd(item)
  if (end != null) parts.push(piAgo(end, now))
  if (item.model) parts.push(piModelShort(item.model))
  if (item.usage?.totalTokens != null) parts.push(`${piTokens(item.usage.totalTokens)} tok`)
  return parts.join(" · ")
}

function SubagentRows({ subagents, now }: { subagents: readonly PiSubagent[]; now: number }) {
  return (
    <>
      {subagents.map((s) => (
        <div key={s.name + s.startedAt} data-pi-part="subagent" className="flex min-w-0 items-baseline">
          <SubagentRow
            role={s.name}
            description={s.task}
            tone={s.name.toLowerCase() === "designer" ? "designer" : "explorer"}
            // 任务描述是要读的灰字：secondary（§4.6；B5）。角色色在 shared 主题层（见 shared-requests）
            className="min-w-0 flex-1 [&_[data-slot=subagent-description]]:text-(--cw-pi-text-secondary,var(--cw-text-3))"
          />
          <span className={cn("mr-(--stream-inset) shrink-0 pl-3 text-(length:--cw-text-sm) tabular-nums", T_SECONDARY)}>
            {piDuration(now - s.startedAt, { zero: true })}
          </span>
        </div>
      ))}
    </>
  )
}

interface ItemViewProps {
  item: PiItem
  variant: "desktop" | "phone"
  density: PiDensity
  open: Set<string>
  fold: Set<string>
  foldLong: boolean
  subagentSlot: ReactNode
  replyMeta: string | null
  showRetry: boolean
  onOpenImage?: PiOpenImage
}

/**
 * 单条消息的 memo（UI·perf 中-1）：每秒的时钟（now 只经 replyMeta 进最后一条回复）和每 50ms 的流式批次
 * 都不再重渲染整窗 300 条。属性全部按引用比较：
 * - item：流式只改最后一条的引用，静态条目引用不变 → 直接跳过；
 * - open / fold：由 TranscriptContent 按 expanded / folded 的身份缓存，时钟 tick 不会造新 Set；
 * - subagentSlot：只有运行中的那一回合的第一条助手消息是非 null，且它本来就每秒要动（子智能体用时）；
 * - replyMeta：只算给最后一条助手回复，分钟级变化才重渲染它。
 */
const ItemView = memo(function ItemView({ item, variant, density, open, fold, foldLong, subagentSlot, replyMeta, showRetry, onOpenImage }: ItemViewProps) {
  switch (item.kind) {
    case "user":
      return <PiUserTurn item={item} onOpenImage={onOpenImage} />
    case "summary": {
      const delta =
        item.tokensBefore != null && item.tokensAfter != null
          ? ` · ${piTokens(item.tokensBefore)} → ${piTokens(item.tokensAfter)}`
          : ""
      return (
        <PiReceipt more>
          {item.title}
          {delta}
        </PiReceipt>
      )
    }
    case "bash":
      // 本机终端里的 !cmd（D19）：同一张终端卡，短语写 label（"你运行了"）
      return (
        <PiTerminalCard
          phrase={item.label}
          command={item.command}
          status="succeeded"
          output={item.output}
          open={open.has(item.key)}
          wrap={variant === "phone"}
        />
      )
    case "custom":
      return (
        <div data-pi-part="custom">
          <PiReceipt>{item.label}</PiReceipt>
          <AgentProse>
            {item.text.split("\n\n").map((p, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {p}
              </p>
            ))}
          </AgentProse>
        </div>
      )
    case "receipt":
      return (
        <PiReceipt tone={item.tone} spinner={item.spinner} action={item.action}>
          {item.text}
        </PiReceipt>
      )
    case "assistant":
      return (
        <AssistantView
          item={item}
          variant={variant}
          density={density}
          open={open}
          fold={fold}
          foldLong={foldLong}
          subagentSlot={subagentSlot}
          replyMeta={replyMeta}
          showRetry={showRetry}
          onOpenImage={onOpenImage}
        />
      )
  }
})

function isLiveTail(blocks: readonly PiBlock[], index: number, live: boolean | undefined): boolean {
  if (!live) return false
  for (let k = index + 1; k < blocks.length; k++) {
    const b = blocks[k]
    if ((b.kind === "text" || b.kind === "thinking") && !b.text.trim()) continue
    return false
  }
  return true
}

function AssistantView({
  item,
  variant,
  density,
  open,
  fold,
  foldLong,
  subagentSlot,
  replyMeta,
  showRetry,
  onOpenImage,
}: Omit<ItemViewProps, "item"> & { item: PiAssistantItem }) {
  const phone = variant === "phone"
  const actions = usePiTranscriptActions()
  const out: ReactNode[] = []
  const blocks = item.blocks
  let placed = subagentSlot == null
  const placeSub = () => {
    if (!placed) {
      placed = true
      out.push(<div key="sub">{subagentSlot}</div>)
    }
  }
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]
    const key = `${item.key}:${i}`
    if (b.kind === "thinking") {
      if (!b.text.trim()) {
        i++
        continue
      }
      const live = isLiveTail(blocks, i, item.live)
      const { phase, body } = splitThinking(b.text)
      out.push(
        <PiThinking
          key={key}
          status={live ? "live" : "done"}
          duration={!live && b.observedMs != null ? piThinkSeconds(b.observedMs) : undefined}
          phase={phase}
          body={body}
          open={live || open.has(key)}
        />,
      )
      placeSub()
      i++
      continue
    }
    if (b.kind === "text") {
      if (!b.text.trim()) {
        i++
        continue
      }
      placeSub()
      const maxHeight = phone ? 220 : 180
      out.push(
        b.prose ? (
          <PiProse key={key} nodes={b.prose} fold={fold.has(key) ? { maxHeight } : undefined} />
        ) : (
          // 产品（P5.4）：text 块是 Markdown 原文，react-markdown 渲染；活动尾部按流式处理（未闭合围栏当纯文本）
          <PiProse
            key={key}
            markdown={b.text}
            streaming={isLiveTail(blocks, i, item.live)}
            fold={fold.has(key) ? { maxHeight } : foldLong ? { maxHeight, auto: true } : undefined}
          />
        ),
      )
      i++
      continue
    }
    placeSub()
    const w = toolWeight(b.name)
    const mergeRead = density === "compact"
    if (w === "explore" || (mergeRead && w === "read")) {
      const group: PiToolBlock[] = []
      let j = i
      while (j < blocks.length) {
        const nb = blocks[j]
        if (nb.kind !== "tool") break
        const nw = toolWeight(nb.name)
        if (!(nw === "explore" || (mergeRead && nw === "read"))) break
        group.push(nb)
        j++
      }
      const runningNow = group.some((g) => toolStatus(g) === "running")
      const reads = group.filter((g) => toolWeight(g.name) === "read").length
      const summary = exploreSummary(group.filter((g) => toolWeight(g.name) === "explore"))
      const detail = reads > 0 ? mergeReads(summary, reads) : summary
      out.push(
        <PiToolLine key={key} verb={runningNow ? "正在查看" : "查看了"} detail={detail} running={runningNow} more={!runningNow} />,
      )
      i = j
      continue
    }
    const status = toolStatus(b)
    if (w === "read") {
      out.push(
        <PiToolLine
          key={key}
          verb={status === "running" ? "正在读取" : "读取"}
          detail={readDetail(b)}
          running={status === "running"}
          more={density === "detailed"}
          trailing={status === "failed" ? "失败" : undefined}
          trailingTone="error"
        />,
      )
      // read 读到图片时工具结果带 images（过大的只有占位，D15）
      const images = b.images
      if (images && images.length > 0)
        out.push(
          <div key={`${key}:img`} className="mx-(--stream-inset) my-(--cw-space-2)">
            <PiImageGrid
              images={images}
              height={phone ? 120 : 160}
              onOpen={onOpenImage ? (index, el) => onOpenImage(images, index, el) : undefined}
            />
          </div>,
        )
    } else if (w === "terminal") {
      const command = toolCommand(b)
      if (status === "denied" || status === "timed_out" || status === "aborted") {
        // 没真正跑出结果的命令：一行灰字 + 行尾原因（§5 "已拒绝""超时（120 秒）"）
        const sec = timeoutSeconds(b)
        out.push(
          <PiToolLine
            key={key}
            verb={bashPhrase(command)}
            detail={command}
            trailing={status === "denied" ? "已拒绝" : status === "aborted" ? "已取消" : sec != null ? `超时（${sec} 秒）` : "超时"}
          />,
        )
      } else {
        out.push(
          <PiTerminalCard
            key={key}
            phrase={bashPhrase(command)}
            command={command}
            status={status}
            exitCode={b.exitCode}
            output={b.outputText}
            stderr={b.stderr}
            open={density !== "compact" && (open.has(b.id) || density === "detailed")}
            // 运行中的卡在流里只露最后 4 行（贴底跟随），完整输出在终端视图（§1.8：同一条命令只在一处展开）
            tailLines={status === "running" ? 4 : open.has(b.id) ? undefined : 10}
            outputMaxHeight={phone ? 160 : 180}
            wrap={phone}
          />,
        )
      }
    } else if (w === "diff") {
      const path = toolPath(b)
      const content = typeof b.input?.content === "string" ? b.input.content : undefined
      out.push(
        <PiDiffCard
          key={key}
          path={path}
          patch={b.details?.patch}
          content={b.details?.patch ? undefined : content}
          variant={variant}
          defaultOpen={open.has(b.id)}
          failed={status === "failed"}
        />,
      )
    } else if (w === "other") {
      out.push(
        <PiToolLine
          key={key}
          verb={status === "running" ? `正在调用 ${b.name}` : `调用 ${b.name}`}
          detail={otherDetail(b)}
          running={status === "running"}
          trailing={status === "failed" ? "失败" : status === "denied" ? "已拒绝" : undefined}
          trailingTone={status === "failed" ? "error" : "muted"}
        />,
      )
    }
    // todo 工具不进流（进 tray 的"任务"pill 与任务面板）
    i++
  }
  placeSub()
  const end = stopReasonText(item.stopReason, item.errorMessage)
  if (end)
    out.push(
      end.error ? (
        <PiTurnError key="stop" onAction={actions?.regenerate}>
          {end.text}
        </PiTurnError>
      ) : (
        <PiReceipt key="stop">{end.text}</PiReceipt>
      ),
    )
  if (replyMeta != null && !end?.error)
    out.push(<PiReplyActions key="actions" meta={replyMeta} retry={showRetry} variant={variant} item={actions ? item : undefined} />)
  return <div data-pi-part="assistant">{out}</div>
}

function mergeReads(summary: string, reads: number): string {
  // 精简密度：读取并进探索行，文件数相加
  const m = /^(\d+) 个文件(.*)$/.exec(summary)
  if (m) return `${Number(m[1]) + reads} 个文件${m[2]}`
  return `${reads} 个文件，${summary}`
}
