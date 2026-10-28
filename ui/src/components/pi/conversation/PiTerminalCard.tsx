import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { ChevronDown, createLucideIcon, KitIcon } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { T_ATTENTION, T_ERROR, T_SECONDARY } from "./styles"

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
  /** 工具块 state = waiting_approval（数据源将来才给；推断）：卡在审批前，行尾蓝字"等你确认" */
  | "waiting"
  /** 工具块 state = queued：行尾灰字"排队中" */
  | "queued"

export interface PiTerminalCardProps {
  /** 人话短语（--cw-text-2）。pane 里不给，只显示命令 */
  phrase?: ReactNode
  /** 命令原文（等宽灰字；桌面单行截断，手机最多两行） */
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
  /** 输出区最高（CSS px），超出滚动并贴底跟随 */
  outputMaxHeight?: number
  /** 输出只露最后 N 行（流内详细密度 10 行） */
  tailLines?: number
  /** 手机：输出软换行（修 U-15）、卡头至少 44、命令最多两行；桌面：不折行、横滚、卡头 31 */
  wrap?: boolean
  lineNumbers?: boolean
  /** 输出被截断（上游截断或超过 200 行）：输出区顶部灰字 */
  truncated?: boolean
  className?: string
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
  outputMaxHeight = 200,
  tailLines,
  wrap,
  lineNumbers,
  truncated,
  className,
}: PiTerminalCardProps) {
  const [open, setOpen] = useState(!!openProp)
  const scroller = useRef<HTMLDivElement>(null)
  const outLines = output ? output.replace(/\n$/, "").split("\n") : []
  const errLines = stderr ? stderr.replace(/\n$/, "").split("\n") : []
  let lines = [...outLines.map((t) => ({ t, err: false })), ...errLines.map((t) => ({ t, err: true }))]
  if (tailLines != null && lines.length > tailLines) lines = lines.slice(-tailLines)
  const hasOutput = lines.length > 0

  // 贴底跟随：同步设置，截图时就在底部（舞台不允许依赖计时器）
  useLayoutEffect(() => {
    const el = scroller.current
    if (open && el) el.scrollTop = el.scrollHeight
  }, [open, output, stderr])

  const trailing = trailingText(status, exitCode, timeoutSec, elapsed)
  return (
    <div
      data-pi-part="terminal-card"
      data-state={status}
      data-open={open ? "" : undefined}
      className={cn(
        // relative：排在后面的卡压在前一行文字开关的 44 外扩区之上，卡头整条都点得到
        "relative my-(--cw-space-2) w-full min-w-0 overflow-hidden rounded-(--cw-radius-card) border border-(--cw-border) bg-(--cw-surface)",
        className,
      )}
    >
      <button
        type="button"
        aria-expanded={hasOutput ? open : undefined}
        onClick={() => hasOutput && setOpen(!open)}
        // 卡头是开关：手机（wrap）至少 44 高（§4.4；B2），长命令最多折成两行（R2-B-m3），单行时仍是 44；桌面保持 Cursor 的 31
        className={cn(
          wrap ? "min-h-11 py-[3px]" : "h-[31px]",
          "flex w-full min-w-0 items-center gap-[6px] pr-2.5 pl-[7px] text-left font-(family-name:--cw-font-sans) text-(length:--cw-text-base) leading-(--cw-leading-base) outline-none focus-visible:bg-(--cw-row-hover)",
        )}
      >
        {status === "running" ? (
          <span className="inline-grid size-[15px] shrink-0 place-items-center">
            <PiSpinner size={13} tone="muted" arc={0.5} label="运行中" />
          </span>
        ) : (
          <KitIcon icon={PiTerminalIcon} size={15} className="text-(--cw-text-3)" />
        )}
        {/* 手机没有悬停看全文：命令放不下时折到第二行（和输出区一样按字符折，两行装得最满），再长才省略（R2-B-m3）；桌面单行截断 */}
        <span className={cn("min-w-0 flex-1", wrap ? "line-clamp-2 break-all" : "truncate")}>
          {phrase != null && <span className="text-(--cw-text-2)">{phrase}</span>}
          <span
            className={cn(
              "font-(family-name:--cw-font-mono) text-(length:--cw-text-code)",
              // 命令段是要读的细节：secondary（§4.6；R2-B-01，浅 --cw-text-3 只有 3.78:1）
              phrase != null ? cn("ml-[6px]", T_SECONDARY) : "text-(--cw-text)",
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
        {hasOutput && (
          <ChevronDown
            aria-hidden
            size={14}
            strokeWidth={1.5}
            className={cn("shrink-0 text-(--cw-text-4) transition-transform", !open && "-rotate-90")}
          />
        )}
      </button>
      {open && hasOutput && (
        <div
          ref={scroller}
          data-pi-part="terminal-output"
          className={cn(
            "border-t border-(--cw-divider) bg-(--cw-code-chip-bg) px-3 py-2 font-(family-name:--cw-font-mono) text-(length:--cw-text-code) leading-[18px] text-(--cw-text-2)",
            wrap ? "overflow-y-auto" : "overflow-auto",
          )}
          style={{ maxHeight: outputMaxHeight }}
        >
          {truncated && <div className={cn("pb-1 font-(family-name:--cw-font-sans)", T_SECONDARY)}>只保留最后 200 行</div>}
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
                <span className="mr-3 w-6 shrink-0 text-right text-(--cw-diff-lineno) select-none">{i + 1}</span>
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
      return { text: "等你确认", attention: true }
    case "queued":
      return { text: "排队中" }
    case "failed":
      return { text: exitCode != null ? `失败 · 退出 ${exitCode}` : "失败", error: true }
    case "timed_out":
      return { text: timeoutSec != null ? `超时（${timeoutSec} 秒）` : "超时" }
    case "denied":
      return { text: "已拒绝" }
    case "aborted":
      return { text: "已取消" }
    case "unknown":
      return { text: "连接断开，结果未知" }
    case "running":
    case "succeeded":
      return elapsed ? { text: elapsed } : null
  }
}
