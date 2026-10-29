import { useCallback, useEffect, useState } from "react"
import { CircleHelp } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { approvalEndedOf, approvalReceiptOf, type PiLocalAnswer } from "@/pi/model/approvalReceipt"
import { dialogCardState, PI_DIALOG_RECEIPT_MS, type PiDialogReceiptView } from "@/pi/model/dialogCard"
import { piClock } from "../logic/view"
import { useNow } from "../hooks/useCodex"
import { CodexButton, CodexSpinner } from "../primitives/primitives"
import { CodexApprovalReceipt } from "./CodexApprovalReceipt"

type Dialog = NonNullable<VariantAppProps["relay"]["dialogs"]>[number]
type Answer = { action: "allow" | "submit" | "deny"; value?: string; values?: string[]; note?: string }
type LocalAnswer = PiLocalAnswer & { answer: Answer }
type Ended = { dialog: Dialog; receipt: PiDialogReceiptView; note?: string }

/**
 * Codex 审批卡（[X-§6] / X-07；[X-图10] 审批 capture）：对话流底部、非模态、12 圆角白卡；
 * 卡头 = 动作类型 /「需要批准」，问题句 14/22；Codex 语言分裂按钮：`拒绝` / `允许一次`（select 型把选项排成行 + 拒绝）。
 * 六态 / 倒计时 / 回执 / 发送逻辑复用 @/pi/model 的 dialogCard / approvalReceipt（单一事实来源），卡面 100% 自写。
 */
export function CodexApprovalDock({ p }: { p: VariantAppProps; phone: boolean }) {
  const { relay, act } = p
  const now = useNow(1000)
  const dialogs = relay.dialogs
  const dialog: Dialog | null = dialogs[0] ?? null
  const [local, setLocal] = useState<Record<string, LocalAnswer>>({})
  const [ended, setEnded] = useState<Ended | null>(null)
  const [seen, setSeen] = useState(dialogs)
  if (seen !== dialogs) {
    setSeen(dialogs)
    if (dialogs.length > 0) setEnded(null)
    else {
      const gone = seen.filter((d) => !dialogs.some((x) => x.dialogId === d.dialogId)).at(-1)
      const end = gone ? approvalEndedOf(gone, local[gone.dialogId], relay.dialogReceipts, now) : null
      if (gone && end) setEnded({ dialog: gone, ...end })
    }
  }
  const mine = dialog ? local[dialog.dialogId] : undefined
  const view = dialogCardState(dialog, dialog ? approvalReceiptOf(dialog.dialogId, mine) : null, now)
  const blocks = !!view?.blocksComposer
  useEffect(() => {
    act.setBlockedBy(blocks ? "approval" : null)
  }, [act, blocks])
  useEffect(() => () => act.setBlockedBy(null), [act])
  const dismiss = relay.dismissDialogReceipt
  const endedId = ended?.receipt.dialogId ?? null
  const endedDenied = ended?.receipt.status === "denied"
  useEffect(() => {
    if (!ended) return
    const timer = window.setTimeout(() => {
      setEnded(null)
      if (endedDenied && endedId) dismiss(endedId)
    }, Math.max(0, ended.receipt.at + PI_DIALOG_RECEIPT_MS - Date.now()))
    return () => window.clearTimeout(timer)
  }, [ended, endedDenied, endedId, dismiss])
  const sendAnswer = relay.sendDialogAnswer
  const dialogId = dialog?.dialogId ?? null
  const answer = useCallback(
    (a: Answer) => {
      if (!dialogId) return
      const put = (next: LocalAnswer) => setLocal((cur) => ({ ...cur, [dialogId]: next }))
      put({ status: "sending", at: Date.now(), answer: a })
      void Promise.resolve(sendAnswer(dialogId, a)).then((result) => {
        put({ status: result === "ok" ? "sent" : result === "gone" ? "answered-elsewhere" : "failed", at: Date.now(), answer: a })
      })
    },
    [dialogId, sendAnswer],
  )
  if (dialog && view) {
    return (
      <div className="cx-approval-slot" data-pi-ui-part="approval">
        <CodexApprovalCard dialog={dialog} state={view.state} sending={view.state === "sending"} failed={mine?.status === "failed"} onAnswer={answer} onRetry={() => mine && answer(mine.answer)} />
      </div>
    )
  }
  if (relay.uiPrompt) {
    return (
      <div className="cx-approval-slot">
        <div className="cx-approval-receipt" role="status">
          电脑上有一个确认框在等待（{piClock(now - relay.uiPrompt.startedAt)}）
        </div>
      </div>
    )
  }
  if (ended) {
    return (
      <div className="cx-approval-slot">
        <CodexApprovalReceipt status={ended.receipt.status as "denied" | "expired" | "answered-elsewhere"} note={ended.note} />
      </div>
    )
  }
  return null
}

/** 审批卡本体（Codex 语言：拒绝 / 允许一次 分裂按钮；select 型选项列表；只读观察） */
export function CodexApprovalCard({
  dialog,
  state,
  sending,
  failed,
  onAnswer,
  onRetry,
}: {
  dialog: Dialog
  state: NonNullable<ReturnType<typeof dialogCardState>>["state"]
  sending: boolean
  failed: boolean
  onAnswer: (answer: Answer) => void
  onRetry: () => void
}) {
  const [text, setText] = useState(dialog.kind === "editor" ? (dialog as Dialog & { prefill?: string }).prefill ?? "" : "")
  // 多选（multiselect）的勾选集：点选只改本地集，「提交」才整份回传 values
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const now = useNow(1000)
  const answerable = dialog.answerable === true
  const remainingMs = dialog.timeout != null ? dialog.startedAt + dialog.timeout - now : null
  const options = (dialog.options ?? []) as string[]
  const kind = dialog.kind
  // 多选的选择数区间（桥侧组帧已钳制；这里再按实际选项数收一遍）
  const minSel = Math.min(Math.max(0, dialog.minSelect ?? 1), options.length)
  const maxSel = Math.min(Math.max(minSel, dialog.maxSelect ?? options.length), options.length)
  const toggleChecked = (option: string) => {
    setChecked((cur) => {
      const next = new Set(cur)
      if (next.has(option)) next.delete(option)
      else {
        if (next.size >= maxSel) return cur
        next.add(option)
      }
      return next
    })
  }
  if (!dialog) return null
  if (state === "denied" || state === "expired" || state === "answered-elsewhere") return <CodexApprovalReceipt status={state as "denied" | "expired" | "answered-elsewhere"} />
  if (failed || state === "failed")
    return (
      <div className="cx-approval-card" data-p4-surface="CX-DLG-05" data-p4-ready="" data-state="failed" data-pi-ui-part="approval">
        <div className="cx-approval-error" role="alert">
          答案发送失败
          <button type="button" className="cx-inline-link" onClick={onRetry}>
            重试
          </button>
        </div>
      </div>
    )
  return (
    <section className="cx-approval-card" data-kind={kind} data-state={state} role="group" aria-label="需要批准" data-pi-ui-part="approval" data-p4-surface="CX-DLG-05" data-p4-ready="">
      <header className="cx-approval-head">
        <CircleHelp aria-hidden size={15} strokeWidth={1.75} className="cx-approval-icon" />
        <span className="cx-approval-title">需要批准</span>
        <span className="cx-approval-clock">{remainingMs != null ? `剩余 ${piClock(remainingMs)}` : "等待回答"}</span>
      </header>
      <div className="cx-approval-body">
        {dialog.title ? <div className="cx-approval-question">{dialog.title}</div> : null}
        {dialog.message ? <pre className="cx-approval-message">{dialog.message}</pre> : null}
        {!answerable ? <div className="cx-approval-readonly">只能在电脑上回答</div> : null}
        {answerable && kind === "select" && options.length > 0 ? (
          <div className="cx-approval-options">
            {options.map((option) => (
              <button key={option} type="button" className="cx-approval-option" disabled={sending} onClick={() => onAnswer({ action: "submit", value: option })}>
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {answerable && kind === "multiselect" && options.length > 0 ? (
          <div className="cx-approval-options">
            {options.map((option) => {
              const on = checked.has(option)
              return (
                <button
                  key={option}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  className="cx-approval-option"
                  disabled={sending || (!on && checked.size >= maxSel)}
                  onClick={() => toggleChecked(option)}
                >
                  {option}
                </button>
              )
            })}
            <div className="cx-approval-multicount">
              已选 {checked.size} 项{minSel > 0 ? ` · 至少选 ${minSel} 项` : ""}
              {maxSel < options.length ? ` · 最多选 ${maxSel} 项` : ""}
            </div>
          </div>
        ) : null}
        {answerable && (kind === "input" || kind === "editor") ? (
          kind === "editor" ? (
            <textarea className="cx-approval-input" rows={4} value={text} onChange={(event) => setText(event.target.value)} aria-label="回答内容" />
          ) : (
            <input className="cx-approval-input" value={text} onChange={(event) => setText(event.target.value)} aria-label="回答内容" />
          )
        ) : null}
        {answerable && kind !== "select" ? (
          <div className="cx-approval-actions">
            <CodexButton kind="ghost" disabled={sending} onClick={() => onAnswer({ action: "deny" })}>
              拒绝
            </CodexButton>
            {kind === "confirm" ? (
              <CodexButton kind="primary" disabled={sending} onClick={() => onAnswer({ action: "allow" })}>
                {sending ? <CodexSpinner size={12} /> : null}
                允许一次
              </CodexButton>
            ) : kind === "multiselect" ? (
              <CodexButton kind="primary" disabled={sending || checked.size < minSel} onClick={() => onAnswer({ action: "submit", values: options.filter((o) => checked.has(o)) })}>
                {sending ? <CodexSpinner size={12} /> : null}
                提交（已选 {checked.size}）
              </CodexButton>
            ) : kind === "input" || kind === "editor" ? (
              <CodexButton kind="primary" disabled={sending || !text.trim()} onClick={() => onAnswer({ action: "submit", value: text })}>
                {sending ? <CodexSpinner size={12} /> : null}
                提交
              </CodexButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {sending ? (
        <div className="cx-approval-sending" aria-live="polite">
          <CodexSpinner size={11} /> 正在发送答案
        </div>
      ) : null}
    </section>
  )
}
