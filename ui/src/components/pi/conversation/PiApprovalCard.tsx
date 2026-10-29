import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import { Button, CodeChip, InlineLink, ReceiptLine } from "@/components/kit"
import { PiSpinner } from "@/components/pi/shared/PiSpinner"
import { usePiStatic } from "@/components/pi/shared/layers"
import { Check, CircleHelp } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { piClock, piDuration } from "@/components/pi/shared/format"
import {
  APPROVAL_ANNOUNCE_IDLE,
  APPROVAL_WARN_MS,
  approvalAnnounceStep,
  approvalQuestionOf,
  type ApprovalAnnounceState,
} from "@/pi/model/approvalAnnounce"
import { T_ATTENTION, T_ERROR, T_SECONDARY } from "./styles"
import type { PiDialogCard } from "@/components/pi/shared/types"

export type PiApprovalState = "open" | "sending" | "failed" | "answered-elsewhere" | "denied" | "expired"

/** 收成一行灰字的回执（已拒绝 / 已超时）停留多久后消失（§3.4、M-06） */
export const PI_APPROVAL_RECEIPT_MS = 8000
/** 剩这么多毫秒时读屏再播报一次"还剩 10 秒"（§4.7；= pi/model/approvalAnnounce.ts 的 APPROVAL_WARN_MS） */
export const PI_APPROVAL_WARN_MS = APPROVAL_WARN_MS

export interface PiApprovalCardProps {
  dialog: PiDialogCard
  now: number
  variant: "desktop" | "phone"
  state?: PiApprovalState
  /** failed 的原因 / denied 的理由 */
  note?: string
  /** sending 时正在发送的那个选项 */
  answering?: string
  /** 卡的最高高度（手机 dock ≤ 可视视口 50%，超出在卡内滚动） */
  maxHeight?: number
  /**
   * 可交互态（P5.4）：回答。select 点选项 = submit 选项原文；confirm "允许" = allow；input / editor "提交" = submit 输入的文字；
   * "拒绝并说明理由…" / confirm 的"拒绝"先展开理由输入框，"确认拒绝" = deny（理由可空，只给人看）。口径同 chat/composer/PromptWaiting.tsx。
   * 不传 = 只展示（画廊）
   */
  onAnswer?: (answer: PiApprovalAnswer) => void
  /** failed 时卡内"重试" */
  onRetry?: () => void
  className?: string
}

/** 一份回答（= PromptWaiting 的 DialogAnswer）；多选走 submit + values（选项原文集合） */
export type PiApprovalAnswer = { action: "allow" | "submit" | "deny"; value?: string; values?: string[]; note?: string }

/**
 * "等你回答"审批卡（PiApprovalCard；compose from kit: Button(solid-black), CodeChip, InlineLink, Spinner）。
 * 唯一常驻 dock 的卡（§1.7），放在 tray 上方、与对话列同宽，阴影比普通卡重一档（--cw-pi-approval-shadow）。整卡版式是推断。
 * select：整宽描边选项行；multiselect：复选行 + 已选计数 + 黑"确认"（未达最少选择数时不可点）；
 * confirm：黑"允许" + 描边"拒绝"；input / editor：输入框 + 黑"提交"。
 * 只读观察（answerable 为空）："只能在电脑上回答"。先答为准：别处答了就收成一行灰字。
 */
export function PiApprovalCard({
  dialog,
  now,
  variant,
  state = "open",
  note,
  answering,
  maxHeight,
  onAnswer,
  onRetry,
  className,
}: PiApprovalCardProps) {
  const phone = variant === "phone"
  const rowH = phone ? "min-h-12" : "min-h-9"
  const headId = `pi-approval-${useId().replace(/:/g, "")}`
  const remainingMs = dialog.timeout != null ? dialog.startedAt + dialog.timeout - now : null
  const announce = useApprovalAnnouncement(dialog, remainingMs, state)
  const scrollRef = useScrollFade()
  // 可交互态（P5.4）：真的能答。静态态（画廊）照冻结版画，不挂回调、输入框是占位
  const interactive = !usePiStatic() && !!onAnswer
  const [denying, setDenying] = useState(false)
  const [denyNote, setDenyNote] = useState("")
  const [text, setText] = useState(() => (dialog.kind === "editor" ? dialog.prefill || "" : ""))
  // 多选（multiselect）的勾选集：点选只改本地集，点「确认」才整份提交（区别于 select 的点即答）
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const sending = state === "sending"
  const answer = (a: PiApprovalAnswer) => {
    if (!sending) onAnswer?.(a)
  }

  if (state === "expired") {
    return <PiExpiredReceipt />
  }
  if (state === "answered-elsewhere") {
    return <ReceiptLine className={cn("mx-0", T_SECONDARY)}>已在其他设备回答</ReceiptLine>
  }
  if (state === "denied") {
    return (
      <ReceiptLine className={cn("mx-0", T_SECONDARY)}>
        已拒绝{note ? ` · 理由：${note}` : ""}
      </ReceiptLine>
    )
  }

  const remaining = remainingMs
  const waited = now - dialog.startedAt
  const answerable = dialog.answerable === true
  const kind = dialog.kind
  const options = dialog.options ?? []
  // 多选的选择数区间（桥侧组帧已钳制；这里再按实际选项数收一遍，防旧帧/坏帧）
  const minSel = Math.min(Math.max(0, dialog.minSelect ?? 1), options.length)
  const maxSel = Math.min(Math.max(minSel, dialog.maxSelect ?? options.length), options.length)
  const toggleChecked = (opt: string) => {
    setChecked((cur) => {
      const next = new Set(cur)
      if (next.has(opt)) next.delete(opt)
      else {
        if (next.size >= maxSel) return cur
        next.add(opt)
      }
      return next
    })
  }

  return (
    <section
      data-pi-part="approval-card"
      data-kind={kind}
      data-state={state}
      role="group"
      aria-labelledby={headId}
      className={cn(
        "flex w-full min-w-0 flex-col overflow-hidden rounded-(--cw-radius-bubble) bg-(--cw-surface)",
        "[box-shadow:var(--cw-pi-approval-shadow,0_0_0_.5px_rgba(0,0,0,.12),0_8px_24px_rgba(0,0,0,.14))]",
        className,
      )}
      style={maxHeight ? { maxHeight } : undefined}
    >
      <header className="flex shrink-0 items-center gap-2 px-3.5 pt-3 text-(length:--cw-text-md) leading-(--cw-leading-tight)">
        <CircleHelp aria-hidden size={16} strokeWidth={1.75} className={cn("shrink-0", T_ATTENTION)} />
        <span id={headId} className="min-w-0 flex-1 truncate font-(--cw-weight-semibold) text-(--cw-text)">
          pi 在等你回答
        </span>
        {/* 倒计时不逐秒播报（§4.7）：可见文字对读屏隐藏，播报只走下面的 live region */}
        <span aria-hidden className={cn("shrink-0 tabular-nums", T_SECONDARY)}>
          {remaining != null ? `剩余 ${piClock(remaining)}` : `已等 ${piDuration(waited, { zero: true })}`}
        </span>
        {/* 出现时播报一次标题和问题（polite），剩 10 秒时再播报一次 */}
        <span data-pi-part="approval-live" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announce}
        </span>
      </header>
      <div ref={scrollRef} className={cn("min-h-0 overflow-y-auto px-3.5 pt-2 pb-3", SCROLL_FADE)}>
        {dialog.title && (
          <div className="text-(length:--cw-text-base) leading-(--cw-leading-base) text-(--cw-text)">{dialog.title}</div>
        )}
        {dialog.message && (
          <div className="mt-1.5">
            <CodeChip className="text-(length:--cw-text-code) leading-[1.5]">{dialog.message}</CodeChip>
          </div>
        )}
        {!answerable ? (
          <div className={cn("mt-3 text-(length:--cw-text-md)", T_SECONDARY)}>只能在电脑上回答</div>
        ) : kind === "select" ? (
          <div className="mt-3 flex flex-col gap-1.5" role="listbox" aria-label="选项">
            {options.map((opt) => {
              const busy = state === "sending" && answering === opt
              return (
                <button
                  key={opt}
                  type="button"
                  role="option"
                  aria-selected={busy}
                  disabled={state === "sending"}
                  onClick={interactive ? () => answer({ action: "submit", value: opt }) : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-(--cw-radius-button) border border-(--cw-border) bg-(--cw-surface) px-3 text-left text-(length:--cw-text-md) text-(--cw-text)",
                    "hover:bg-(--cw-row-hover) disabled:text-(--cw-text-3)",
                    rowH,
                  )}
                >
                  <span className="min-w-0 flex-1">{opt}</span>
                  {busy && <PiSpinner size={12} tone="muted" label="发送中" />}
                </button>
              )
            })}
            {dialog.optionsTotal != null && dialog.optionsTotal > options.length && (
              <div className={cn("text-(length:--cw-text-sm)", T_SECONDARY)}>
                还有 {dialog.optionsTotal - options.length} 项没有传过来，请在电脑上选
              </div>
            )}
          </div>
        ) : kind === "multiselect" ? (
          <div className="mt-3 flex flex-col gap-1.5" role="group" aria-label="选项（可多选）">
            {options.map((opt) => {
              const on = checked.has(opt)
              const atMax = !on && checked.size >= maxSel
              return (
                <button
                  key={opt}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  disabled={state === "sending" || atMax}
                  onClick={interactive ? () => toggleChecked(opt) : undefined}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-(--cw-radius-button) border bg-(--cw-surface) px-3 text-left text-(length:--cw-text-md) text-(--cw-text)",
                    "hover:bg-(--cw-row-hover) disabled:text-(--cw-text-3)",
                    on ? "border-(--cw-pi-field-focus-border)" : "border-(--cw-border)",
                    rowH,
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      on ? "border-(--cw-text) bg-(--cw-text) text-(--cw-surface)" : "border-(--cw-border) text-transparent",
                    )}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span className="min-w-0 flex-1">{opt}</span>
                </button>
              )
            })}
            {dialog.optionsTotal != null && dialog.optionsTotal > options.length && (
              <div className={cn("text-(length:--cw-text-sm)", T_SECONDARY)}>
                还有 {dialog.optionsTotal - options.length} 项没有传过来，请在电脑上选
              </div>
            )}
            <div className="mt-1 flex items-center gap-2">
              <span className={cn("min-w-0 flex-1 text-(length:--cw-text-sm)", T_SECONDARY)}>
                已选 {checked.size} 项
                {minSel > 0 ? ` · 至少选 ${minSel} 项` : ""}
                {maxSel < options.length ? ` · 最多选 ${maxSel} 项` : ""}
              </span>
              <Button
                className={cn("shrink-0", phone ? "h-11 px-4" : "")}
                disabled={state === "sending" || checked.size < minSel}
                onClick={interactive ? () => answer({ action: "submit", values: options.filter((o) => checked.has(o)) }) : undefined}
              >
                确认
              </Button>
            </div>
          </div>
        ) : kind === "confirm" ? (
          <div className="mt-3 flex gap-2">
            <Button
              className={cn("flex-1", phone ? "h-12" : "h-9")}
              disabled={state === "sending"}
              onClick={interactive ? () => answer({ action: "allow" }) : undefined}
            >
              允许
            </Button>
            <button
              type="button"
              disabled={interactive && sending}
              onClick={interactive ? () => setDenying(true) : undefined}
              className={cn(
                "flex-1 rounded-(--cw-radius-button) border border-(--cw-border) bg-(--cw-surface) text-(length:--cw-text-md) text-(--cw-text)",
                phone ? "h-12" : "h-9",
              )}
            >
              拒绝
            </button>
          </div>
        ) : interactive && (kind === "input" || kind === "editor") ? (
          <div className="mt-3 flex flex-col gap-2">
            {kind === "editor" ? (
              <textarea
                data-pi-autofocus=""
                aria-label={dialog.title || "回答"}
                value={text}
                rows={4}
                disabled={sending}
                onChange={(e) => setText(e.target.value)}
                className={cn(INPUT, "min-h-20 resize-y", phone ? "text-[16px]" : "text-(length:--cw-text-md)")}
              />
            ) : (
              <input
                type="text"
                aria-label={dialog.title || "回答"}
                value={text}
                placeholder={dialog.placeholder || "输入回答…"}
                disabled={sending}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) answer({ action: "submit", value: text })
                }}
                className={cn(INPUT, phone ? "text-[16px]" : "text-(length:--cw-text-md)")}
              />
            )}
            <Button className={cn("self-end", phone ? "h-11 px-4" : "")} disabled={sending} onClick={() => answer({ action: "submit", value: text })}>
              提交
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            <div
              className={cn(
                "rounded-(--cw-radius-input) border border-(--cw-border) px-3 py-2 text-(--cw-text-4)",
                kind === "editor" ? "min-h-20" : "",
                phone ? "text-[16px]" : "text-(length:--cw-text-md)",
              )}
            >
              {dialog.prefill || dialog.placeholder || "输入回答…"}
            </div>
            <Button className={cn("self-end", phone ? "h-11 px-4" : "")}>提交</Button>
          </div>
        )}
        {interactive && answerable && denying && (
          // 拒绝并写理由（design approval-waiting states）：理由只给人看，不回传模型
          <div data-pi-part="approval-deny" className="mt-3 flex flex-col gap-2">
            <input
              type="text"
              aria-label="拒绝理由（可选）"
              value={denyNote}
              placeholder="拒绝理由（可选，只给人看）"
              maxLength={500}
              disabled={sending}
              onChange={(e) => setDenyNote(e.target.value)}
              className={cn(INPUT, phone ? "text-[16px]" : "text-(length:--cw-text-md)")}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={sending}
                onClick={() => setDenying(false)}
                className={cn(
                  "rounded-(--cw-radius-button) border border-(--cw-border) bg-(--cw-surface) px-3 text-(length:--cw-text-md) text-(--cw-text)",
                  phone ? "h-11" : "h-8",
                )}
              >
                取消
              </button>
              <Button
                className={phone ? "h-11 px-4" : "h-8"}
                disabled={sending}
                onClick={() => answer({ action: "deny", ...(denyNote.trim() ? { note: denyNote.trim() } : {}) })}
              >
                确认拒绝
              </Button>
            </div>
          </div>
        )}
        {state === "failed" && (
          <div className={cn("mt-2 text-(length:--cw-text-sm)", T_ERROR)}>
            没有发出去{note ? `：${note}` : ""} ·{" "}
            <InlineLink className="text-inherit underline" onClick={interactive ? onRetry : undefined}>
              重试
            </InlineLink>
          </div>
        )}
        {answerable && (
          <footer className="mt-3 flex items-center gap-2 text-(length:--cw-text-sm) leading-(--cw-leading-sm)">
            <span className={cn("min-w-0 flex-1 truncate", T_SECONDARY)}>任一设备先答为准</span>
            {kind !== "confirm" && (!interactive || !denying) && (
              <InlineLink className={cn("shrink-0", phone && "py-3")} onClick={interactive ? () => setDenying(true) : undefined}>
                拒绝并说明理由…
              </InlineLink>
            )}
          </footer>
        )}
      </div>
    </section>
  )
}

/** 可交互态的输入框（input / editor 型、拒绝理由）：和静态占位框同一个外观 */
const INPUT =
  "w-full rounded-(--cw-radius-input) border border-(--cw-border) bg-(--cw-surface) px-3 py-2 text-(--cw-text) placeholder:text-(--cw-text-4) disabled:text-(--cw-text-3) focus-visible:border-(--cw-pi-field-focus-border)"

/**
 * 卡内滚动区下面还藏着内容时底部 24px 渐隐（R2-B-m4：手机卡最高 264，「拒绝并说明理由…」要上滑才看到）；滚到底就撤掉。
 * 构建时 Lightning CSS 会补上 -webkit-mask-image。
 */
const SCROLL_FADE = "data-[pi-fade]:[mask-image:linear-gradient(to_bottom,black_calc(100%_-_24px),transparent)]"

/** 下面还有超过 1px 的内容就挂 data-pi-fade，否则摘掉 */
function syncFade(el: HTMLElement | null) {
  if (el) el.toggleAttribute("data-pi-fade", el.scrollHeight - el.clientHeight - el.scrollTop > 1)
}

/**
 * 滚动区的底部渐隐开关（返回给滚动区的 ref 回调）。直接改 DOM 属性，滚动时不重渲染；每次渲染后同步一次（内容、maxHeight 会变），
 * 滚动和滚动区尺寸变化（键盘、可视视口）由 scroll 监听和 ResizeObserver 接。滚动区挂上 / 摘下时接上 / 解开监听
 * （React 19 的 ref 回调可以返回清理函数），所以卡在回执态和可答态之间切换也不会漏。
 */
function useScrollFade() {
  const elRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => syncFade(elRef.current))
  return useCallback((el: HTMLDivElement | null) => {
    elRef.current = el
    if (!el) return
    const sync = () => syncFade(el)
    el.addEventListener("scroll", sync, { passive: true })
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync)
    ro?.observe(el)
    return () => {
      elRef.current = null
      el.removeEventListener("scroll", sync)
      ro?.disconnect()
    }
  }, [])
}

/** 卡出现后等这么久再把第一句填进 live region：读屏要先登记这个（空的）区域，挂载同时就有字的区域常常不读 */
const ANNOUNCE_DELAY_MS = 150

/**
 * 读屏播报文字（§4.7；规则在 pi/model/approvalAnnounce.ts）：卡出现后播报一次"pi 在等你回答：<标题>，<问题>"，
 * 剩 10 秒时换成"还剩 10 秒"再播报一次；换了一张卡重新来。剩余时间不逐秒播报（倒计时的可见文字 aria-hidden）。
 * 先渲染空的 live region、过 ANNOUNCE_DELAY_MS 再填字。依赖都是基本类型，父组件频繁重渲染也不会把定时器一直往后推。
 */
function useApprovalAnnouncement(dialog: PiDialogCard, remainingMs: number | null, state: PiApprovalState): string {
  const [said, setSaid] = useState<ApprovalAnnounceState>(APPROVAL_ANNOUNCE_IDLE)
  const active = state === "open" || state === "sending" || state === "failed"
  const next = approvalAnnounceStep(said, { dialogId: dialog.dialogId, active, question: approvalQuestionOf(dialog), remainingMs })
  const pending = next !== said
  const { dialogId, text, warned } = next
  const delay = said.dialogId !== dialogId ? ANNOUNCE_DELAY_MS : 0
  useEffect(() => {
    if (!pending) return
    const t = window.setTimeout(() => setSaid({ dialogId, text, warned }), delay)
    return () => window.clearTimeout(t)
  }, [pending, dialogId, text, warned, delay])
  return said.dialogId === dialog.dialogId ? said.text : ""
}

/** 超时回执（state "expired"，M-06）：一行灰字"已超时，pi 按默认处理"，8 秒后消失（下一张卡出现时由容器直接换掉） */
function PiExpiredReceipt() {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const t = window.setTimeout(() => setShown(false), PI_APPROVAL_RECEIPT_MS)
    return () => window.clearTimeout(t)
  }, [])
  if (!shown) return null
  return (
    <ReceiptLine data-pi-part="approval-expired" role="status" className={cn("mx-0", T_SECONDARY)}>
      已超时，pi 按默认处理
    </ReceiptLine>
  )
}

/** 旧式 ui_prompt 信号（F07；compose from kit: ReceiptLine）：只读一行 */
export function PiPromptSignal({ startedAt, now }: { startedAt: number; now: number }) {
  return (
    <ReceiptLine data-pi-part="prompt-signal" className={cn("mx-0 flex items-center gap-1.5", T_SECONDARY)}>
      <CircleHelp aria-hidden size={14} strokeWidth={1.75} className={T_ATTENTION} />
      电脑上有一个确认框在等待 · 已等 {piDuration(now - startedAt, { zero: true })}
    </ReceiptLine>
  )
}
