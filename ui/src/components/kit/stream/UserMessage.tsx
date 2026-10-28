import type { ComponentPropsWithoutRef } from "react"
import type { Forced } from "@/components/kit/types"
import { ICON, Undo2 } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { STREAM_TEXT } from "./styles"
import { subId } from "./util"

export interface UserMessageProps extends ComponentPropsWithoutRef<"div"> {
  /**
   * card：白卡 + 1px 描边 + 极轻投影（#3 #6 #7 #9 #14 #15 #21 #25 #27 #28）；
   * bubble：无描边、只靠柔和投影浮在底色上（#1 吸顶气泡与 "Can we fix it?"；plan 里叫 gray-bubble）。
   */
  variant?: "card" | "bubble"
  /** stretch：撑满列宽（agent 对话）；right：按内容收缩并靠右（ch5 Projects #23 #24） */
  align?: "stretch" | "right"
  /** 末行右端的撤销图标 undo-2（#1 #4 #5 #28） */
  undo?: boolean
  onUndo?: () => void
  /** 单行紧凑：超出截断（#7 "Record a demo"、#9 单行消息） */
  compact?: boolean
  /** 卡底约 24px 渐隐截断（#4）。卡高由屏幕给（style.height / className） */
  fade?: boolean
  /** 吸顶（#1 #5 #28 首条消息）：true = top 0，数字 = top 偏移（CSS px） */
  sticky?: boolean | number
  /** 静态复现撤销图标的悬停/按下态 */
  forced?: Forced
  /** bubble 外再加一圈 1px --cw-divider-soft 细边（Projects #23 #24，kit-requests ch5 #12）；card 自带描边，不受影响 */
  outline?: boolean
}

/**
 * 用户消息。children 是消息内容（ch5 可在里面放 ImageAttachment / QuoteChip）。
 * 撤销按钮的 data-cw-id = 根节点 data-cw-id + "-undo"。
 */
export function UserMessage({
  variant = "card",
  align = "stretch",
  undo,
  onUndo,
  compact,
  fade,
  sticky,
  forced,
  outline,
  className,
  style,
  children,
  ...rest
}: UserMessageProps) {
  const stickyTop = sticky === true ? 0 : typeof sticky === "number" ? sticky : undefined
  return (
    <div
      data-variant={variant}
      className={cn(
        STREAM_TEXT,
        // 最小高 38 + 内容竖直居中（base 比对 #1：单行气泡 "Can we fix it?" 高 38、文字上距 8.5；两行吸顶气泡 54 = 42 + 6×2）
        "relative my-(--cw-space-4) flex min-h-[38px] flex-col justify-center rounded-(--cw-radius-bubble) bg-(--cw-user-bubble) text-(--cw-text)",
        variant === "card"
          ? "border border-(--cw-border) shadow-(--cw-shadow-composer)"
          : "shadow-(--cw-shadow-float)",
        variant === "bubble" && outline && "border border-(--cw-divider-soft)",
        align === "right" ? "ml-auto w-fit max-w-full" : "w-full",
        stickyTop !== undefined && "sticky z-10",
        fade && "flex flex-col overflow-hidden",
        className,
      )}
      style={stickyTop !== undefined ? { top: stickyTop, ...style } : style}
      {...rest}
    >
      <div
        className={cn(
          "flex items-end gap-(--cw-space-2) px-[calc(var(--cw-space-3)_+_var(--cw-space-0-5))]",
          variant === "card" ? "py-(--cw-space-2)" : "py-(--cw-space-1-5)",
          fade && "min-h-0 flex-1 items-stretch",
        )}
      >
        <div
          className={cn(
            "min-w-0 flex-1 [overflow-wrap:anywhere]",
            compact && "truncate",
            fade &&
              "overflow-hidden [mask-image:linear-gradient(to_bottom,black_calc(100%_-_var(--cw-space-6)),transparent)]",
          )}
        >
          {children}
        </div>
        {undo && (
          <button
            type="button"
            aria-label="Undo"
            data-cw-id={subId(rest, "undo")}
            data-forced={forced}
            onClick={onUndo}
            className={cn(
              "grid size-(--cw-leading-base) shrink-0 cursor-pointer place-items-center rounded-(--cw-radius-xs) text-(--cw-text-4)",
              "hover:bg-(--cw-row-hover) data-[forced=hover]:bg-(--cw-row-hover) data-[forced=pressed]:bg-(--cw-row-selected)",
              "outline-none focus-visible:ring-1 focus-visible:ring-(--cw-border-strong) data-[forced=focus]:ring-1 data-[forced=focus]:ring-(--cw-border-strong)",
              fade && "self-end",
            )}
          >
            <Undo2 aria-hidden size={ICON.sizeSm} strokeWidth={ICON.stroke} />
          </button>
        )}
      </div>
    </div>
  )
}
