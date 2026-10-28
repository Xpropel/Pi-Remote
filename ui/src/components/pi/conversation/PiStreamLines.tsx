import { useState, type ReactNode } from "react"
import { InlineLink, ReceiptLine, ThinkingBlock, ToolLine } from "@/components/kit"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { ChevronRight } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { T_SECONDARY, TOUCH_44_TEXT } from "./styles"

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

/** 回合出错（D18；compose from kit: ReceiptLine, InlineLink）：红字一行 + "重新回答"。折行不截断 */
export function PiTurnError({ children, action = "重新回答", onAction }: { children: ReactNode; action?: string | null; onAction?: () => void }) {
  return (
    <ReceiptLine data-pi-part="turn-error" className="text-(--cw-pi-error,var(--cw-red))">
      {children}
      {action && (
        <>
          {" "}
          <InlineLink className={cn("whitespace-nowrap", TOUCH_44_TEXT)} onClick={onAction}>
            {action}
          </InlineLink>
        </>
      )}
    </ReceiptLine>
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
/** 思考块（PiThinking：kit ThinkingBlock 的薄包装）。done 收起 = "思考 6 秒 ›"；无时长 = "已思考 ›"；live = "思考中 ∨" */
export function PiThinking({
  status,
  duration,
  phase,
  body,
  open,
}: {
  status: "done" | "live"
  /** "6 秒"；没有实时观测到起止时不给 */
  duration?: string
  phase?: ReactNode
  body?: ReactNode
  open?: boolean
}) {
  const live = status === "live"
  const label = live ? "思考中" : duration ? "思考" : "已思考"
  // 可交互（P5.4）：标题行点了能开合。open 是容器 / 部件给的默认（思考中展开、结束收起）；用户点过以后听用户的，
  // 直到状态变了（思考中 → 结束）再回到默认。静态态没人点，和冻结版一样
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [shownStatus, setShownStatus] = useState(status)
  if (shownStatus !== status) {
    setShownStatus(status)
    setUserOpen(null)
  }
  const effective = userOpen ?? open
  return (
    <ThinkingBlock
      data-pi-part="thinking"
      // 标题行是开关：视觉一行字，点击区外扩到 44 高（§4.4；B2）
      className={cn(body != null || phase != null ? TOUCH_44_TRIGGER : undefined)}
      status={status}
      label={label}
      // 时长是要读的灰字：--cw-pi-text-secondary（§4.6；kit 默认 --cw-text-3）
      duration={duration != null ? <span className={T_SECONDARY}>{duration}</span> : undefined}
      // done 态收起时也画箭头（转成 "›"），展开后是 ∨（kit-requests pi b3）
      collapsedChevron
      phase={phase}
      open={effective}
      defaultOpen={open}
      onOpenChange={setUserOpen}
    >
      {body}
    </ThinkingBlock>
  )
}

/**
 * 轻工具行（PiToolLine；compose from kit: ToolLine, Spinner）。
 * 运行中 = 行首半圆 spinner；成功 = 无标记；已拒绝 / 超时 / 已取消 = 行尾灰字（推断，§1.5）。
 */
export function PiToolLine({
  verb,
  detail,
  running,
  more,
  trailing,
  trailingTone = "muted",
}: {
  verb: ReactNode
  detail?: ReactNode
  running?: boolean
  more?: boolean
  trailing?: string
  trailingTone?: "muted" | "error"
}) {
  return (
    <ToolLine
      data-pi-part="tool-line"
      running={running}
      className="flex items-center gap-1.5"
      verb={
        <>
          {running && <PiSpinner size={12} tone="muted" arc={0.5} label="运行中" className="mr-1.5 align-[-1px]" />}
          {verb}
        </>
      }
      detail={
        <>
          {/* 细节段是要读的灰字（"3 个文件，搜索 2 次""useMobileViewport.ts L1-92"）：--cw-pi-text-secondary（§4.6） */}
          {detail != null && <span className={T_SECONDARY}>{detail}</span>}
          {more && <PiMore />}
          {trailing && (
            <span
              className={cn(
                "ml-2",
                trailingTone === "error" ? "text-(--cw-pi-error,var(--cw-red))" : "text-(--cw-pi-text-secondary,var(--cw-text-3))",
              )}
            >
              {trailing}
            </span>
          )}
        </>
      }
    />
  )
}
