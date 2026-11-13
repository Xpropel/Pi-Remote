import { useEffect, useId, useState, type ReactNode } from "react"
import { Collapsible } from "radix-ui"
import { InlineLink, ReceiptLine, ThinkingBlock, ToolLine } from "@/components/kit"
import { STREAM_INSET, STREAM_LINE_GAP, STREAM_TEXT } from "@/components/kit/stream/styles"
import { piThinkSeconds } from "@/components/pi/shared/format"
import { usePiStatic } from "@/components/pi/shared/layers"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { ChevronRight, CircleAlert } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { PiDisclosure } from "./PiCard"
import { PiThinkingText } from "./PiProse"
import { T_ERROR, T_SECONDARY, TOUCH_44_TEXT } from "./styles"
import type { ExploreRow } from "./tools"
import "./stream.css"

/** 运行中的文字（动词、"思考中"）：可交互态扫亮带（stream.css），静态态就是原字色 */
function Shimmer({ on, children }: { on: boolean; children: ReactNode }) {
  return <span data-pi-shimmer={on ? "" : undefined}>{children}</span>
}

/** 行尾的小 "›"：可展开的提示（手机没有悬停，所以常显；推断）。展开后由各部件自己的 ∨ 接替 */
export function PiMore({ className }: { className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      size={14}
      strokeWidth={1.5}
      className={cn("ml-0.5 inline-block align-[-2px] text-(--cw-text-3)", className)}
    />
  )
}

/** 灰字收据行（PiReceipt；kit ReceiptLine）："用时 2m 14s"、"自动重试 2/3 · 5 秒后"、"已压缩上下文 · 132k → 18k ›" */
export function PiReceipt({
  children,
  spinner,
  more,
  tone = "muted",
  action,
  onAction,
  className,
}: {
  children: ReactNode
  spinner?: boolean
  more?: boolean
  tone?: "muted" | "error"
  /** 行尾文字按钮（InlineLink）："重试" */
  action?: string
  /** 可交互态（P5.4）：点了行尾文字按钮 */
  onAction?: () => void
  className?: string
}) {
  return (
    <ReceiptLine
      data-pi-part="receipt"
      className={cn(
        "flex items-center gap-1.5 text-(--cw-pi-text-secondary,var(--cw-text-3))",
        tone === "error" && "text-(--cw-pi-error,var(--cw-red))",
        className,
      )}
    >
      {spinner && <PiSpinner size={12} tone="muted" label="正在工作" />}
      <span className="min-w-0">
        {children}
        {more && <PiMore />}
      </span>
      {action && (
        <>
          <span aria-hidden>·</span>
          <InlineLink className={cn("shrink-0", TOUCH_44_TEXT)} onClick={onAction}>
            {action}
          </InlineLink>
        </>
      )}
    </ReceiptLine>
  )
}

/** 流末尾的运行行（F01；compose from kit: Spinner, ReceiptLine）："正在工作 42s"；不知道回合几时开始（没有时间戳）时不写用时 */
export function PiRunningLine({ label = "正在工作", elapsed }: { label?: string; elapsed?: string }) {
  return (
    <PiReceipt spinner>
      {elapsed != null ? `${label} ${elapsed}` : label}
    </PiReceipt>
  )
}

/**
 * 回合出错（D18；compose from kit: ReceiptLine, InlineLink）：行首 14px 警示图标 + 红字（人话原因）+ 灰字"详情 ›" + "重新回答"。
 * 折行不截断，图标对齐第一行。detail = 服务返回的原文：点"详情"在下面展开（等宽、对齐正文、太长自己滚），默认收起。
 */
export function PiTurnError({
  children,
  detail,
  action = "重新回答",
  onAction,
}: {
  children: ReactNode
  detail?: string
  action?: string | null
  onAction?: () => void
}) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  return (
    <div data-pi-part="turn-error">
      <ReceiptLine className="flex items-start gap-1.5 text-(--cw-pi-error,var(--cw-red))">
        <CircleAlert aria-hidden size={14} strokeWidth={1.5} className="mt-[calc((var(--cw-leading-base)_-_14px)/2)] shrink-0" />
        <span className="min-w-0">
          {children}
          {detail && (
            <>
              {" "}
              <button
                type="button"
                aria-expanded={open}
                aria-controls={detailId}
                onClick={() => setOpen((v) => !v)}
                className={cn("group/detail cursor-pointer whitespace-nowrap hover:text-(--cw-text-2)", T_SECONDARY, TOUCH_44_TEXT)}
              >
                详情
                <PiDisclosure open={open} className="ml-0.5 inline-block align-[-2px] group-hover/detail:text-(--cw-text-2)" />
              </button>
            </>
          )}
          {action && (
            <>
              {" "}
              <InlineLink className={cn("whitespace-nowrap", TOUCH_44_TEXT)} onClick={onAction}>
                {action}
              </InlineLink>
            </>
          )}
        </span>
      </ReceiptLine>
      {detail && (
        <div id={detailId} hidden={!open} data-pi-part="turn-error-detail" className={cn(STREAM_INSET, "pl-5")}>
          <pre
            tabIndex={0}
            className="mb-(--cw-space-1-5) max-h-60 overflow-y-auto rounded-(--cw-radius-input) bg-(--cw-code-chip-bg) px-2.5 py-2 font-(family-name:--cw-font-mono) text-(length:--cw-text-code) leading-[1.5] whitespace-pre-wrap text-(--cw-text-2) [overflow-wrap:anywhere]"
          >
            {detail}
          </pre>
        </div>
      )}
    </div>
  )
}

/** 流顶的一行：onAction = 可交互态点了行尾的"重试 / 加载" */
export type PiStreamTopLineItem = { text: ReactNode; action?: string; onAction?: () => void; tone?: "muted" | "error"; spinner?: boolean }

/** 流顶灰字（D02 / PiStreamTopLine）："更早的消息加载失败 · 重试"、"ThinkPad 未连接，只能看历史" */
export function PiStreamTopLine({ lines }: { lines: PiStreamTopLineItem[] }) {
  return (
    <div data-pi-part="stream-top" className="pb-(--cw-space-2)">
      {lines.map((l, i) => (
        <PiReceipt key={i} tone={l.tone} spinner={l.spinner} action={l.action} onAction={l.onAction}>
          {l.text}
        </PiReceipt>
      ))}
    </div>
  )
}

/** ThinkingBlock 的标题开关（Radix Collapsible.Trigger，根节点的直接子 button）外扩到 44 高 */
const TOUCH_44_TRIGGER =
  "[&>button]:relative [&>button]:after:absolute [&>button]:after:inset-x-0 [&>button]:after:top-1/2 [&>button]:after:h-11 [&>button]:after:-translate-y-1/2 [&>button]:after:content-['']"
/** 思考中已想了几秒：从容器观测到的开始时刻起自己每秒走一格（只重渲染这一小段）；不满 1 秒不写 */
function ThinkingElapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const ms = now - since
  return ms >= 1000 ? <span className={T_SECONDARY}>{piThinkSeconds(ms)}</span> : null
}

/** 思考块（PiThinking：kit ThinkingBlock 的薄包装）。done 收起 = "思考 6 秒 ›"；无时长 = "已思考 ›"；live = "思考中 3 秒 ∨" */
export function PiThinking({
  status,
  duration,
  since,
  phase,
  body,
  open,
  cut,
}: {
  status: "done" | "live"
  /** "6 秒"；没有实时观测到起止时不给 */
  duration?: string
  /** 思考中：观测到的开始时刻（ms），标题后写已想了几秒；没看到开始（打开页面时已经在想）不给 */
  since?: number
  phase?: ReactNode
  /** 思考原文：字符串按 Markdown 画（PiThinkingText），节点原样放 */
  body?: ReactNode
  open?: boolean
  /** 思考停在半路（回复被停止 / 出错，最后一块就是它）：补上没闭合的行内标记 */
  cut?: boolean
}) {
  const isStatic = usePiStatic()
  const live = status === "live"
  const label = live ? <Shimmer on={!isStatic}>思考中</Shimmer> : duration ? "思考" : "已思考"
  // 可交互（P5.4）：标题行点了能开合。open 是容器 / 部件给的默认（思考中展开、结束收起）；用户点过以后听用户的，
  // 直到状态变了（思考中 → 结束）再回到默认。静态态没人点，和冻结版一样
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [shownStatus, setShownStatus] = useState(status)
  if (shownStatus !== status) {
    setShownStatus(status)
    setUserOpen(null)
  }
  // 想完的块默认收起，不等整个回合结束（打开页面时已经想完的也一样）；静态态照容器给的默认，同冻结版各屏
  const effective = userOpen ?? (live || isStatic ? open : false)
  const shownDuration = live ? (since != null && !isStatic ? <ThinkingElapsed since={since} /> : undefined) : duration
  return (
    <ThinkingBlock
      data-pi-part="thinking"
      // 标题行是开关：视觉一行字，点击区外扩到 44 高（§4.4；B2）
      className={cn(body != null || phase != null ? TOUCH_44_TRIGGER : undefined)}
      status={status}
      label={label}
      // 时长是要读的灰字：--cw-pi-text-secondary（§4.6；kit 默认 --cw-text-3）
      duration={typeof shownDuration === "string" ? <span className={T_SECONDARY}>{shownDuration}</span> : shownDuration}
      // done 态收起时也画箭头（转成 "›"），展开后是 ∨（kit-requests pi b3）
      collapsedChevron
      phase={phase}
      open={effective}
      defaultOpen={open}
      onOpenChange={setUserOpen}
    >
      {/* 思考原文是模型写的 Markdown（段落、要点、行内代码、代码段）：弱化紧凑的一套外观，换行照留；流式中同回复正文的稳定前缀 + 活动尾部；
          想完以后长的收起（「展开全文」），长代码段各自收起 */}
      {typeof body === "string" ? <PiThinkingText text={body} streaming={live} cut={cut} fold={!live} /> : body}
    </ThinkingBlock>
  )
}

/** 展开后的明细区（工具行、思考块共用）：缩进一档、左边一条细竖线，字小一号 */
export const NESTED =
  "mt-(--cw-space-1) ml-1 border-l border-(--cw-divider) pl-3 text-(length:--cw-text-md) leading-(--cw-leading-base)"

/** 行尾灰字 / 红字（"已拒绝""失败"）：离前面的细节 8（flex 行里有 6 的 gap，只补 2） */
function TrailingText({ text, tone, inFlex }: { text: string; tone: "muted" | "error"; inFlex?: boolean }) {
  return <span className={cn("shrink-0", inFlex ? "ml-0.5" : "ml-2", tone === "error" ? T_ERROR : T_SECONDARY)}>{text}</span>
}

/**
 * 轻工具行（PiToolLine；compose from kit: ToolLine）。
 * 运行中 = 动词上扫亮带（"正在读取"，同 Cursor；不再用行首 spinner，跑完时整行不左右跳）；成功 = 无标记；
 * 已拒绝 / 超时 / 已取消 = 行尾灰字（推断，§1.5）。
 * - 给了 children（明细）：标题行是开关，收起时行尾 ›、展开 ∨，明细缩进一档列在下面（同思考块）。open = 默认开合，用户点过以后听用户的。
 * - 给了 onOpen：细节段（文件名）是按钮，点了打开文件视图，不展开。
 */
export function PiToolLine({
  verb,
  detail,
  running,
  trailing,
  trailingTone = "muted",
  open,
  onOpen,
  openLabel,
  children,
}: {
  verb: ReactNode
  detail?: ReactNode
  running?: boolean
  trailing?: string
  trailingTone?: "muted" | "error"
  open?: boolean
  onOpen?: () => void
  /** 细节按钮的悬停提示（完整路径）；可见文字就是按钮名 */
  openLabel?: string
  children?: ReactNode
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const isStatic = usePiStatic()
  const shimmer = !!running && !isStatic
  if (children != null) {
    const effective = userOpen ?? !!open
    return (
      <Collapsible.Root
        data-pi-part="tool-line"
        data-state={running ? "running" : "done"}
        open={effective}
        onOpenChange={setUserOpen}
        className={cn(STREAM_TEXT, STREAM_INSET, STREAM_LINE_GAP, TOUCH_44_TRIGGER)}
      >
        <Collapsible.Trigger className="group/tl inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 text-left">
          <span className="shrink-0 text-(--cw-text-2) group-hover/tl:text-(--cw-text)">
            <Shimmer on={shimmer}>{verb}</Shimmer>
          </span>
          {detail != null && <span className={cn("min-w-0 truncate", T_SECONDARY)}>{detail}</span>}
          {trailing && <TrailingText text={trailing} tone={trailingTone} inFlex />}
          <PiDisclosure open={effective} className="group-hover/tl:text-(--cw-text-2)" />
        </Collapsible.Trigger>
        <Collapsible.Content data-pi-part="tool-detail" className={NESTED}>
          {children}
        </Collapsible.Content>
      </Collapsible.Root>
    )
  }
  return (
    <ToolLine
      data-pi-part="tool-line"
      running={running}
      className="flex items-center gap-1.5"
      verb={<Shimmer on={shimmer}>{verb}</Shimmer>}
      detail={
        <>
          {/* 细节段是要读的灰字（"3 个文件，搜索 2 次""useMobileViewport.ts L1-92"）：--cw-pi-text-secondary（§4.6） */}
          {detail != null &&
            (onOpen ? (
              <button
                type="button"
                title={openLabel}
                onClick={onOpen}
                className={cn("cursor-pointer hover:text-(--cw-text-2) hover:underline hover:underline-offset-2", T_SECONDARY, TOUCH_44_TEXT)}
              >
                {detail}
              </button>
            ) : (
              <span className={T_SECONDARY}>{detail}</span>
            ))}
          {trailing && <TrailingText text={trailing} tone={trailingTone} />}
        </>
      }
    />
  )
}

/**
 * 探索行展开后的明细：一次调用一行。动词（--cw-text-2）+ 对象（等宽）+ 范围（灰）+ 行尾结果计数（灰，右对齐）。
 * 读取那一行的文件名可点（onOpenFile → 文件视图）。
 */
export function PiExploreRows({ rows, onOpenFile }: { rows: readonly ExploreRow[]; onOpenFile?: (path: string) => void }) {
  const isStatic = usePiStatic()
  return (
    <>
      {rows.map((r) => {
        const open = r.path && onOpenFile ? () => onOpenFile(r.path as string) : undefined
        return (
          <div key={r.id} data-pi-part="explore-row" className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-(--cw-text-2)">
              <Shimmer on={r.running && !isStatic}>{r.verb}</Shimmer>
              {/* 这里的动词不写"正在"，运行中另外念出来 */}
              {r.running && <span className="sr-only">（运行中）</span>}
            </span>
            {open ? (
              <button
                type="button"
                onClick={open}
                className="min-w-0 cursor-pointer truncate text-left text-(--cw-text-2) hover:underline hover:underline-offset-2"
              >
                {r.target}
              </button>
            ) : (
              <span className="min-w-0 truncate font-(family-name:--cw-font-mono) text-(length:--cw-text-code) text-(--cw-text-2)">{r.target}</span>
            )}
            {r.scope && <span className={cn("min-w-0 shrink-[2] truncate", T_SECONDARY)}>{r.scope}</span>}
            {(r.count || r.failed) && (
              <span className={cn("shrink-0 tabular-nums", T_SECONDARY)}>
                ·<span className={cn("ml-1.5", r.failed && T_ERROR)}>{r.failed ? "失败" : r.count}</span>
              </span>
            )}
          </div>
        )
      })}
    </>
  )
}
