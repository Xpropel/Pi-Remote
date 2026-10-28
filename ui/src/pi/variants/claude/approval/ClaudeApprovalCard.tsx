import { useCallback, useEffect, useState } from "react"
import { ChevronDown, CircleHelp, ShieldCheck } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { dialogCardState, PI_DIALOG_RECEIPT_MS, type PiDialogReceiptView } from "@/pi/model/dialogCard"
import { approvalEndedOf, approvalReceiptOf, type PiLocalAnswer } from "@/pi/model/approvalReceipt"
import { ClaudeBadge, ClaudeButton } from "../primitives/ClaudePrimitives"
import { useNow } from "../primitives/useClaude"
import { formatClock } from "../model/format"
import { cx } from "../model/cx"

/**
 * Claude v2 自有审批卡（§1.8 [C-图15]：卡头动作类型 + 来源 chip + 「等待授权」微标、陶土微晕边框、
 * 入参审查可折叠 JSON 区、底部右对齐三阶按钮：拒绝（红字）/ 次要（灰底）/ 单次批准（陶土实底墨字））。
 * 六态 / 倒计时 / 回执逻辑复用 @/pi/model/dialogCard + approvalReceipt 纯函数（允许），交互自写：
 * relay.dialogs / dialogReceipts / sendDialogAnswer / dismissDialogReceipt。
 */

type LocalAnswer = PiLocalAnswer & { answer: { action: "allow" | "submit" | "deny"; value?: string; note?: string } }
type Ended = { dialog: NonNullable<PiContainerProps["relay"]["dialogs"][number]>; receipt: PiDialogReceiptView; note?: string }

export function ClaudeApprovalCard({ p }: { p: PiContainerProps }) {
  const { relay, act } = p
  const now = useNow(500)
  const dialogs = relay.dialogs
  const dialog = dialogs[0] ?? null
  const [local, setLocal] = useState<Record<string, LocalAnswer>>({})
  const [ended, setEnded] = useState<Ended | null>(null)
  const [denying, setDenying] = useState(false)
  const [denyNote, setDenyNote] = useState("")
  const [text, setText] = useState("")

  // 卡关掉了：按关闭原因留回执（拒绝 / 超时 / 别处回答）
  const [seen, setSeen] = useState(dialogs)
  if (seen !== dialogs) {
    setSeen(dialogs)
    if (dialogs.length > 0) {
      if (ended) setEnded(null)
    } else {
      const gone = seen.filter((d) => !dialogs.some((x) => x.dialogId === d.dialogId)).at(-1)
      const end = gone ? approvalEndedOf(gone, local[gone.dialogId], relay.dialogReceipts ?? [], now) : null
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

  // 回执到时消失
  const dismiss = relay.dismissDialogReceipt
  const endedHideAt = ended ? ended.receipt.at + PI_DIALOG_RECEIPT_MS : null
  const endedId = ended?.receipt.dialogId ?? null
  useEffect(() => {
    if (endedHideAt == null || endedId == null) return
    const timer = window.setTimeout(() => {
      setEnded((cur) => (cur?.receipt.dialogId === endedId ? null : cur))
      if (ended?.receipt.status === "denied") dismiss(endedId)
    }, Math.max(0, endedHideAt - Date.now()))
    return () => window.clearTimeout(timer)
  }, [endedHideAt, endedId, ended?.receipt.status, dismiss])

  const sendAnswer = relay.sendDialogAnswer
  const dialogId = dialog?.dialogId ?? null
  const answer = useCallback(
    (payload: { action: "allow" | "submit" | "deny"; value?: string; note?: string }) => {
      if (!dialogId) return
      const put = (next: LocalAnswer) => setLocal((cur) => ({ ...cur, [dialogId]: next }))
      put({ status: "sending", at: Date.now(), answer: payload })
      void Promise.resolve(sendAnswer(dialogId, payload)).then((result) => {
        put({ status: result === "ok" ? "sent" : result === "gone" ? "answered-elsewhere" : "failed", at: Date.now(), answer: payload })
      })
    },
    [dialogId, sendAnswer],
  )

  if (ended) {
    const label =
      ended.receipt.status === "denied"
        ? `已拒绝${ended.note ? ` · 理由：${ended.note}` : ""}`
        : ended.receipt.status === "expired"
          ? "这张卡已超时"
          : "已在其他设备回答"
    return <p className="claude-approval-receipt">{label}</p>
  }
  if (!dialog || !view) {
    if (relay.uiPrompt) {
      return (
        <p className="claude-approval-receipt">
          电脑上有一个确认框在等待（{formatClock(relay.uiPrompt.startedAt)} 打开），请在电脑上回答。
        </p>
      )
    }
    return null
  }

  const sending = view.state === "sending"
  const observe = view.observe
  const options = dialog.options ?? []
  const source = dialog.kind === "confirm" ? "approval" : dialog.kind === "select" ? "choice" : "input"
  const sourceLabel = dialog.kind === "confirm" ? "工具确认" : dialog.kind === "select" ? "选择题" : dialog.kind === "editor" ? "长文本回答" : "输入回答"
  const payloadJson = JSON.stringify(
    { kind: dialog.kind, title: dialog.title ?? "", message: dialog.message ?? "", options, placeholder: dialog.placeholder ?? "" },
    null,
    2,
  )

  return (
    <section className="claude-approval" data-state={view.state} aria-label="审批卡">
      <header className="claude-approval-head">
        <CircleHelp size={15} strokeWidth={1.75} className="claude-approval-icon" aria-hidden />
        <span className="claude-approval-title">pi 在等你回答</span>
        <ClaudeBadge tone="clay">{sourceLabel}</ClaudeBadge>
        <span className="claude-approval-source">mcp://{source}</span>
        {view.remainingSec != null ? <span className="claude-approval-countdown">剩余 {Math.floor(view.remainingSec / 60)}:{String(view.remainingSec % 60).padStart(2, "0")}</span> : null}
        <ClaudeBadge tone="muted">等待授权</ClaudeBadge>
      </header>

      <div className="claude-approval-body">
        {dialog.title ? <p className="claude-approval-message">{dialog.title}</p> : null}
        {dialog.message ? <p className="claude-approval-detail">{dialog.message}</p> : null}

        {observe ? <p className="claude-approval-observe">只能在电脑上回答</p> : null}

        {!observe && dialog.kind === "select" ? (
          <div className="claude-approval-options" role="listbox" aria-label="选项">
            {options.map((option) => (
              <button
                key={option}
                type="button"
                role="option"
                className="claude-approval-option"
                disabled={sending}
                aria-selected={mine?.answer.value === option && sending}
                onClick={() => answer({ action: "submit", value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {!observe && (dialog.kind === "input" || dialog.kind === "editor") ? (
          <div className="claude-approval-inputrow">
            {dialog.kind === "editor" ? (
              <textarea className="claude-textarea" aria-label={dialog.title || "回答"} rows={4} value={text} disabled={sending} onChange={(e) => setText(e.target.value)} />
            ) : (
              <input
                className="claude-input"
                aria-label={dialog.title || "回答"}
                value={text}
                placeholder={dialog.placeholder || "输入回答…"}
                disabled={sending}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) answer({ action: "submit", value: text })
                }}
              />
            )}
          </div>
        ) : null}

        <details className="claude-approval-params">
          <summary>
            <ChevronDown size={12} strokeWidth={2} aria-hidden />
            入参审查
          </summary>
          <pre className="claude-approval-json">{payloadJson}</pre>
        </details>

        {view.state === "failed" ? (
          <p className="claude-approval-error" role="alert">
            没有发出去
            <button type="button" className="claude-link-btn" onClick={() => mine && answer(mine.answer)}>
              重试
            </button>
          </p>
        ) : null}

        {denying && !observe ? (
          <div className="claude-approval-denybox">
            <input
              className="claude-input"
              aria-label="拒绝理由（可选）"
              placeholder="拒绝理由（可选，只给人看）"
              maxLength={500}
              value={denyNote}
              disabled={sending}
              onChange={(e) => setDenyNote(e.target.value)}
            />
            <div className="claude-approval-actions">
              <ClaudeButton kind="ghost" onClick={() => setDenying(false)} disabled={sending}>
                取消
              </ClaudeButton>
              <ClaudeButton
                kind="danger"
                disabled={sending}
                onClick={() => {
                  setDenying(false)
                  answer({ action: "deny", ...(denyNote.trim() ? { note: denyNote.trim() } : {}) })
                }}
              >
                确认拒绝
              </ClaudeButton>
            </div>
          </div>
        ) : null}
      </div>

      {!observe && !(dialog.kind === "input" || dialog.kind === "editor") ? (
        <footer className="claude-approval-actions">
          {/* 三阶（§1.8 [C-图15]）：拒绝（红字）/ 次要（灰底）/ 单次批准（陶土实底墨字）。
              协议只有 allow/submit/deny 三种动作、没有 always-allow 粒度，第二阶按"次要动作"落地为
              「拒绝并说明理由…」（灰底，打开理由输入），第一阶是一键拒绝（红字文字钮）。 */}
          <button type="button" className="claude-approval-deny" disabled={sending} onClick={() => answer({ action: "deny" })}>
            拒绝
          </button>
          <ClaudeButton kind="secondary" disabled={sending} onClick={() => setDenying(true)}>
            拒绝并说明理由…
          </ClaudeButton>
          {dialog.kind === "confirm" ? (
            <ClaudeButton kind="primary" disabled={sending} onClick={() => answer({ action: "allow" })}>
              {sending ? "提交中…" : "单次批准"}
            </ClaudeButton>
          ) : null}
        </footer>
      ) : null}
      {!observe && (dialog.kind === "input" || dialog.kind === "editor") ? (
        <footer className="claude-approval-actions">
          <button type="button" className="claude-approval-deny" disabled={sending} onClick={() => answer({ action: "deny" })}>
            拒绝
          </button>
          <ClaudeButton kind="secondary" disabled={sending} onClick={() => setDenying(true)}>
            拒绝并说明理由…
          </ClaudeButton>
          <ClaudeButton kind="primary" disabled={sending || text.trim().length === 0} onClick={() => answer({ action: "submit", value: text })}>
            {sending ? "提交中…" : "提交回答"}
          </ClaudeButton>
        </footer>
      ) : null}
      {sending ? (
        <p className="claude-approval-sending">
          <ShieldCheck size={12} strokeWidth={1.75} aria-hidden /> 正在提交…
        </p>
      ) : null}
    </section>
  )
}

/** 手机审批卡（全宽、按钮更大；同一套逻辑） */
export function ClaudeApprovalCardPhone({ p }: { p: PiContainerProps }) {
  return (
    <div className={cx("claude-approval-phone")}>
      <ClaudeApprovalCard p={p} />
    </div>
  )
}
