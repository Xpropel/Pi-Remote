import type { ReactNode } from "react"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { cn } from "@/lib/utils"
import { C_ERROR, C_SECONDARY, TOUCH_44, type CVariant } from "./styles"

/*
 * 弹窗家族（P5.5，design §2 H：G03 G04 G08–G10 G12 G14–G18）共用的小件：读取状态、按钮行上方的红字、键值行、JSON 块、列表行。
 * 版式推断：replica 只在 c/dialog-usage 的 states 里写了这些弹窗，没有做部件（plan 5.5「标推断」）。
 * 颜色只用 kit / Pi token（深浅两种主题都由 token 推导）。
 */

export type PiDialogPhase = "loading" | "error" | "ready"

/** 正文的读取状态：加载中（Spinner + 灰字）/ 读取失败（红字 + 重试）/ 空（灰字）/ 就绪（children） */
export function PiDialogStatus({
  variant,
  phase,
  error,
  empty,
  onRetry,
  children,
}: {
  variant: CVariant
  phase: PiDialogPhase
  error?: string | null
  empty?: string | null
  onRetry?: () => void
  children?: ReactNode
}) {
  const text = variant === "phone" ? "text-[15px] leading-[22px]" : "text-(length:--cw-text-md) leading-(--cw-leading-base)"
  if (phase === "loading") {
    return (
      <div data-slot="pi-dialog-status" data-phase="loading" className={cn("flex min-h-11 items-center gap-2", text, C_SECONDARY)}>
        <PiSpinner className="size-3.5" label="正在读取" />
        正在读取…
      </div>
    )
  }
  if (phase === "error") {
    return (
      <div data-slot="pi-dialog-status" data-phase="error" role="alert" className={cn("flex min-h-11 flex-wrap items-center gap-x-2", text, C_ERROR)}>
        <span className="min-w-0">读取失败{error ? ` · ${error}` : ""}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className={cn("shrink-0 font-(--cw-weight-medium) underline", variant === "phone" && TOUCH_44)}>
            重试
          </button>
        )}
      </div>
    )
  }
  if (empty) {
    return (
      <p data-slot="pi-dialog-status" data-phase="empty" className={cn("m-0 flex min-h-11 items-center", text, C_SECONDARY)}>
        {empty}
      </p>
    )
  }
  return <>{children}</>
}

/** 命令失败：按钮行上方一行红字，弹窗不关（M-04，例如"压缩失败：pi 正忙"）；放在正文最后 */
export function PiDialogError({ children }: { children?: ReactNode }) {
  if (children == null || children === "") return null
  return (
    <p role="alert" data-slot="pi-dialog-error" className={cn("m-0 mt-3 text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_ERROR)}>
      {children}
    </p>
  )
}

/** 说明文字：tone primary = 正文黑（弹窗的主说明），secondary = 灰（补充说明，默认） */
export function PiDialogNote({ variant, tone = "secondary", children, className }: { variant: CVariant; tone?: "primary" | "secondary"; children?: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "m-0",
        variant === "phone" ? "text-[15px] leading-[22px]" : "text-(length:--cw-text-md) leading-(--cw-leading-base)",
        tone === "primary" ? "text-(--cw-text)" : C_SECONDARY,
        className,
      )}
    >
      {children}
    </p>
  )
}

/** 键值行（标签灰、数值黑右对齐；空值写"—"） */
export function PiKVRows({ variant, rows }: { variant: CVariant; rows: readonly (readonly [string, string])[] }) {
  const phone = variant === "phone"
  return (
    <dl data-slot="pi-kv-rows" className="m-0 flex flex-col">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className={cn(
            "flex min-w-0 items-baseline justify-between gap-4 border-b border-solid border-(--cw-divider-soft) py-2 last:border-b-0",
            phone ? "min-h-11 text-[15px]" : "min-h-8 text-(length:--cw-text-md)",
          )}
        >
          <dt className={cn("shrink-0", C_SECONDARY)}>{label}</dt>
          <dd className="m-0 min-w-0 text-right break-all text-(--cw-text) tabular-nums">{value || "—"}</dd>
        </div>
      ))}
    </dl>
  )
}

/** JSON / 长文本块：等宽、可选中、框内滚动；截断时上方一行灰字 */
export function PiTextBlock({ variant, text, clipped, clippedNote, label, maxHeight = 320 }: { variant: CVariant; text: string; clipped?: boolean; clippedNote?: string; label: string; maxHeight?: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {clipped && (
        <p className={cn("m-0", variant === "phone" ? "text-[13px] leading-[18px]" : "text-(length:--cw-text-sm) leading-(--cw-leading-sm)", C_SECONDARY)}>
          {clippedNote ?? "内容很长，这里只显示前面一部分。"}
        </p>
      )}
      <pre
        tabIndex={0}
        aria-label={label}
        data-slot="pi-text-block"
        className={cn(
          "m-0 min-w-0 overflow-auto rounded-(--cw-radius-card) border border-solid border-(--cw-border) bg-(--cw-bg) p-3 font-(family-name:--cw-font-mono) text-(length:--cw-text-code) leading-[18px] whitespace-pre-wrap break-words text-(--cw-text) select-text",
        )}
        style={{ maxHeight }}
      >
        {text}
      </pre>
    </div>
  )
}

/** 列表行（分叉的用户消息、会话树节点）：整行是按钮；mark = 行尾灰字（"当前叶" / "分叉中…"） */
export function PiDialogListRow({
  variant,
  title,
  subtitle,
  mark,
  indent = 0,
  current,
  disabled,
  onClick,
}: {
  variant: CVariant
  title: ReactNode
  subtitle?: ReactNode
  mark?: ReactNode
  indent?: number
  current?: boolean
  disabled?: boolean
  onClick?: () => void
}) {
  const phone = variant === "phone"
  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={current ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 rounded-[7px] px-2 text-left hover:bg-(--cw-row-hover) disabled:hover:bg-transparent",
        phone ? "min-h-12 py-1.5 text-[15px]" : "min-h-8 py-1 text-(length:--cw-text-md)",
      )}
      style={indent ? { paddingLeft: 8 + Math.min(indent, 12) * 14 } : undefined}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("min-w-0 truncate text-(--cw-text)", current && "font-(--cw-weight-semibold)")}>{title}</span>
        {subtitle != null && <span className={cn("min-w-0 truncate text-(length:--cw-text-xs) leading-[16px]", C_SECONDARY)}>{subtitle}</span>}
      </span>
      {mark != null && <span className={cn("shrink-0 text-(length:--cw-text-sm)", C_SECONDARY)}>{mark}</span>}
    </button>
  )
}
