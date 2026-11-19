import {
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { createLucideIcon, KitIcon } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { CARD, CARD_GAP, CARD_TERMINAL_HEAD_H, INSET_FOCUS, PiDisclosure } from "./PiCard"
import { ROW_HL_FOCUS, ROW_HL_HOVER, T_ATTENTION, T_ERROR, T_SECONDARY } from "./styles"

/** 横向终端图标（几何照 ch2/TerminalCard 的 TerminalWideIcon；不 import ch2，免得带进 ch2.css） */
export const PiTerminalIcon = createLucideIcon("PiTerminalWide", [
  ["rect", { x: "2.8", y: "4.4", width: "18.4", height: "15.2", rx: "2.6", key: "frame" }],
  ["path", { d: "m7.2 9.6 3.6 2.4-3.6 2.4", key: "chevron" }],
  ["path", { d: "M13.1 14.6h4.1", key: "cursor" }],
])

/**
 * 终端卡的状态：TerminalItem.state（running / succeeded / failed / timed_out / aborted）
 * 加上工具块结果性质（denied / timeout，§1.5）和连接断开后的 unknown。
 */
export type PiTerminalStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "aborted"
  | "denied"
  | "unknown"
  /** 工具块 state = waiting_approval（数据源将来才给；推断）：卡在审批前，行尾蓝字"等你批准" */
  | "waiting"
  /** 工具块 state = queued：行尾灰字"排队中" */
  | "queued"

export interface PiTerminalCardProps {
  /** 人话短语（--cw-text-2）。pane 里不给，只显示命令 */
  phrase?: ReactNode
  /** 命令原文（等宽灰字；单行水平滚动，悬停显示横向滑动条） */
  command: string
  status: PiTerminalStatus
  exitCode?: number
  /** 超时秒数（"超时（120 秒）"） */
  timeoutSec?: number
  /** 行尾灰字：运行中的已用时 / 结束后的耗时（pane 里显示；流内成功卡不显示） */
  elapsed?: string
  output?: string
  stderr?: string
  /** 展开输出区 */
  open?: boolean
  /** 展开/收起回调（受控模式时同步给外层） */
  onOpenChange?: (open: boolean) => void
  /** 输出区最高（CSS px），超出滚动并贴底跟随 */
  outputMaxHeight?: number
  /** 输出只露最后 N 行（流内详细密度 10 行） */
  tailLines?: number
  /** 手机：输出软换行（修 U-15）；命令头部始终单行不折行 */
  wrap?: boolean
  lineNumbers?: boolean
  /** 输出被截断（上游截断或超过 200 行）：输出区顶部灰字 */
  truncated?: boolean
  className?: string
}

interface CmdScrollThumb {
  trackLeft: number
  trackWidth: number
  thumbLeft: number
  thumbWidth: number
}

function useCmdScrollThumb(scrollerRef: RefObject<HTMLSpanElement | null>, depsKey: string): CmdScrollThumb | null {
  const [thumb, setThumb] = useState<CmdScrollThumb | null>(null)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) {
      setThumb(null)
      return
    }
    let cancelled = false
    const update = () => {
      if (cancelled) return
      const { scrollLeft, scrollWidth, clientWidth, offsetLeft } = el
      if (scrollWidth <= clientWidth + 1 || clientWidth <= 0) {
        setThumb(null)
        return
      }
      const trackWidth = clientWidth
      const thumbWidth = Math.min(trackWidth, Math.max(24, (trackWidth * clientWidth) / scrollWidth))
      const maxScroll = scrollWidth - clientWidth
      const maxThumbLeft = Math.max(0, trackWidth - thumbWidth)
      const thumbLeft = maxScroll > 0 ? (maxThumbLeft * scrollLeft) / maxScroll : 0
      setThumb((prev) =>
        prev &&
        Math.abs(prev.trackLeft - offsetLeft) < 0.5 &&
        Math.abs(prev.trackWidth - trackWidth) < 0.5 &&
        Math.abs(prev.thumbLeft - thumbLeft) < 0.5 &&
        Math.abs(prev.thumbWidth - thumbWidth) < 0.5
          ? prev
          : { trackLeft: offsetLeft, trackWidth, thumbLeft, thumbWidth },
      )
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.parentElement) ro.observe(el.parentElement)
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(update)
    }
    return () => {
      cancelled = true
      el.removeEventListener("scroll", update)
      ro.disconnect()
    }
  }, [scrollerRef, depsKey])
  return thumb
}

/**
 * 终端卡（PiTerminalCard；compose from kit: Spinner；参照 ch2/TerminalCard 的几何）。
 * 白底 1px 描边长条：终端图标 + 人话短语 + 灰色命令后缀（规则 6 medium）。
 * 运行 / 成功 / 失败 / 拒绝 / 超时整卡态 Cursor 没拍到（run-brief ⑦），按 §1.5 推断：
 * 运行中 = 行首半圆 spinner 代替图标；成功 = 无标记；失败 = 行尾红字"失败 · 退出 1"；拒绝 / 超时 / 取消 = 行尾灰字。
 * 展开：输出区等宽 12、--cw-code-chip-bg 底；stderr 行红字；贴底跟随（推断）。
 */
export function PiTerminalCard({
  phrase,
  command,
  status,
  exitCode,
  timeoutSec,
  elapsed,
  output = "",
  stderr,
  open: openProp,
  onOpenChange,
  outputMaxHeight = 200,
  tailLines,
  wrap,
  lineNumbers,
  truncated,
  className,
}: PiTerminalCardProps) {
  // open 是容器给的默认（运行中展开、跑完收起；失败的卡报错还要看时展开，见 liveExpandedOf），跟着它变。用户点过以后听用户的
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? !!openProp
  const scroller = useRef<HTMLDivElement>(null)
  const cmdScroller = useRef<HTMLSpanElement>(null)
  const pointerDownScrollLeft = useRef(0)
  const [dragging, setDragging] = useState(false)
  const dragCleanup = useRef<(() => void) | null>(null)
  const outLines = output ? output.replace(/\n$/, "").split("\n") : []
  const errLines = stderr ? stderr.replace(/\n$/, "").split("\n") : []
  const rawLines = [...outLines.map((t) => ({ t, err: false })), ...errLines.map((t) => ({ t, err: true }))]
  const lines = tailLines != null && rawLines.length > tailLines ? rawLines.slice(-tailLines) : rawLines
  const lineOffset = rawLines.length - lines.length
  const hasOutput = lines.length > 0

  useLayoutEffect(() => () => dragCleanup.current?.(), [])

  // 贴底跟随：同步设置，截图时就在底部（舞台不允许依赖计时器）
  useLayoutEffect(() => {
    const el = scroller.current
    if (open && el) el.scrollTop = el.scrollHeight
  }, [open, output, stderr])

  const trailing = trailingText(status, exitCode, timeoutSec, elapsed)
  const thumb = useCmdScrollThumb(
    cmdScroller,
    `${command}\n${typeof phrase === "string" ? phrase : ""}\n${status}\n${trailing?.text ?? ""}\n${hasOutput ? 1 : 0}`,
  )

  const onScrollbarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = cmdScroller.current
    const bar = e.currentTarget
    if (!el || !thumb) return
    e.preventDefault()
    e.stopPropagation()
    dragCleanup.current?.()
    const rect = bar.getBoundingClientRect()
    const maxScroll = el.scrollWidth - el.clientWidth
    const maxThumbLeft = Math.max(1, thumb.trackWidth - thumb.thumbWidth)
    const clickX = e.clientX - rect.left
    const hitThumb = clickX >= thumb.thumbLeft - 2 && clickX <= thumb.thumbLeft + thumb.thumbWidth + 2
    if (!hitThumb && maxScroll > 0) {
      const nextThumbLeft = Math.min(maxThumbLeft, Math.max(0, clickX - thumb.thumbWidth / 2))
      el.scrollLeft = (nextThumbLeft / maxThumbLeft) * maxScroll
    }
    const startX = e.clientX
    const startScroll = el.scrollLeft
    setDragging(true)
    bar.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      if (maxScroll <= 0) return
      const dx = ev.clientX - startX
      el.scrollLeft = Math.min(maxScroll, Math.max(0, startScroll + (dx / maxThumbLeft) * maxScroll))
    }
    const cleanup = (ev?: PointerEvent) => {
      if (ev && bar.hasPointerCapture(ev.pointerId)) bar.releasePointerCapture(ev.pointerId)
      bar.removeEventListener("pointermove", onMove)
      bar.removeEventListener("pointerup", cleanup)
      bar.removeEventListener("pointercancel", cleanup)
      dragCleanup.current = null
      setDragging(false)
    }
    dragCleanup.current = () => cleanup()
    bar.addEventListener("pointermove", onMove)
    bar.addEventListener("pointerup", cleanup)
    bar.addEventListener("pointercancel", cleanup)
  }

  return (
    <div
      data-pi-part="terminal-card"
      data-state={status}
      data-open={open ? "" : undefined}
      // relative（CARD）：排在后面的卡压在前一行文字开关的 44 外扩区之上，卡头整条都点得到
      className={cn(CARD, CARD_GAP, className)}
    >
      <button
        type="button"
        aria-expanded={hasOutput ? open : undefined}
        onPointerDown={() => {
          pointerDownScrollLeft.current = cmdScroller.current?.scrollLeft ?? 0
        }}
        onClick={() => {
          if (cmdScroller.current && Math.abs(cmdScroller.current.scrollLeft - pointerDownScrollLeft.current) > 4) return
          if (!hasOutput) return
          const next = !open
          if (openProp === undefined || onOpenChange === undefined) setUserOpen(!open)
          onOpenChange?.(next)
        }}
        // 卡头始终保持紧凑单行高（26px），命令超出时单行水平滚动
        className={cn(
          CARD_TERMINAL_HEAD_H,
          "flex w-full min-w-0 items-center gap-1.5 px-2.5 text-left font-(family-name:--cw-font-sans) text-(length:--cw-text-md) leading-[18px] outline-none",
          INSET_FOCUS,
          hasOutput ? cn(ROW_HL_HOVER, ROW_HL_FOCUS) : "cursor-default",
        )}
      >
        {status === "running" ? (
          <span className="inline-grid size-[13px] shrink-0 place-items-center">
            <PiSpinner size={11} tone="muted" arc={0.5} label="Running" />
          </span>
        ) : (
          <KitIcon icon={PiTerminalIcon} size={13} className="shrink-0 text-(--cw-text-3)" />
        )}
        <span
          ref={cmdScroller}
          data-pi-part="terminal-cmd-scroll"
          className="block min-w-0 flex-1 overflow-x-auto overflow-y-hidden whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {phrase != null && <span className="text-(--cw-text-2)">{phrase}</span>}
          <span
            className={cn(
              "font-(family-name:--cw-font-mono) text-(length:--cw-text-code)",
              // 命令段是要读的细节：secondary（§4.6；R2-B-01，浅 --cw-text-3 只有 3.78:1）
              phrase != null ? cn("ml-1.5", T_SECONDARY) : "text-[color:var(--cw-pi-stream-fg,var(--cw-text))]",
            )}
          >
            {command}
          </span>
        </span>
        {trailing && (
          <span
            className={cn(
              "shrink-0 text-(length:--cw-text-sm) whitespace-nowrap",
              trailing.error ? T_ERROR : trailing.attention ? T_ATTENTION : T_SECONDARY,
            )}
          >
            {trailing.text}
          </span>
        )}
        {hasOutput && <PiDisclosure open={open} />}
      </button>
      {thumb && (
        <div
          aria-hidden
          data-pi-part="terminal-cmd-scrollbar"
          data-dragging={dragging ? "" : undefined}
          style={{ left: thumb.trackLeft, width: thumb.trackWidth }}
          onPointerDown={onScrollbarPointerDown}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            data-pi-part="terminal-cmd-thumb"
            style={{ width: thumb.thumbWidth, transform: `translateX(${thumb.thumbLeft}px)` }}
          />
        </div>
      )}
      {open && hasOutput && (
        <div
          ref={scroller}
          data-pi-part="terminal-output"
          className={cn(
            "border-t border-(--cw-divider) bg-(--cw-code-chip-bg) px-2.5 py-1.5 font-(family-name:--cw-font-mono) text-(length:--cw-text-code) leading-[18px] text-(--cw-text-2)",
            wrap ? "overflow-y-auto" : "overflow-auto",
          )}
          style={{ maxHeight: outputMaxHeight }}
        >
          {truncated && <div className={cn("pb-1 font-(family-name:--cw-font-sans)", T_SECONDARY)}>Showing last 200 lines</div>}
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
                "flex min-h-[18px]",
                wrap ? "break-all whitespace-pre-wrap" : "w-max min-w-full whitespace-pre",
                l.err && T_ERROR,
              )}
            >
              {/* 行号和 diff 行号同一个 token（N1：浅色 --cw-text-3 在 --cw-code-chip-bg 上只有 3.11） */}
              {lineNumbers && (
                <span className="mr-3 min-w-6 shrink-0 text-right text-(--cw-diff-lineno) select-none">{lineOffset + i + 1}</span>
              )}
              <span className="min-w-0 flex-1">{l.t || " "}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function trailingText(
  status: PiTerminalStatus,
  exitCode: number | undefined,
  timeoutSec: number | undefined,
  elapsed: string | undefined,
): { text: string; error?: boolean; attention?: boolean } | null {
  switch (status) {
    case "waiting":
      return { text: "Awaiting approval", attention: true }
    case "queued":
      return { text: "Queued" }
    case "failed":
      return { text: exitCode != null ? `Failed · exit ${exitCode}` : "Failed", error: true }
    case "timed_out":
      return { text: timeoutSec != null ? `Timed out (${timeoutSec}s)` : "Timed out" }
    case "denied":
      return { text: "Denied" }
    case "aborted":
      return { text: "Cancelled" }
    case "unknown":
      return { text: "Disconnected · status unknown" }
    case "running":
    case "succeeded":
      return elapsed ? { text: elapsed } : null
  }
}
