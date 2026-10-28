import { useState } from "react"
import { Send } from "../icons/CodexIcons"
import { useComposerEnter } from "@/pi/headless/useComposerEnter"
import { CodexCapabilityBadge, CodexDisabledNote } from "../primitives/CodexCapability"
import { useCodexCapability } from "../logic/capability"

/**
 * Side chat 面板（CX-PANEL-11 / [X-§5]）：借当前上下文旁路提问，不打断主对话。
 * 能力 `side-chat`：生产无 provider → 完整 UI 禁用 + DOC/74#cap-side-chat；dev mock → 发送走 actions.sendMessage 并联动。
 */
export function CodexSideChat({ onClose }: { onClose?: () => void }) {
  const cap = useCodexCapability("side-chat")
  const threads = cap.data?.threads ?? []
  const thread = threads[0] ?? null
  const [draft, setDraft] = useState("")
  const disabled = !cap.interactive
  const send = () => {
    const text = draft.trim()
    if (!text || disabled) return
    cap.actions?.sendMessage?.(thread?.id ?? null, text)
    setDraft("")
  }
  const onComposerEnter = useComposerEnter({
    value: draft,
    setValue: (next) => setDraft(next),
    send,
    canSend: !!draft.trim() && !disabled,
    readOnly: disabled,
  })
  return (
    <section className="cx-sidechat" data-p4-surface="CX-PANEL-11" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-sidechat-head">
        <span className="cx-sidechat-title">Side chat</span>
        <CodexCapabilityBadge label={cap.simulated ? "模拟演示" : "可接入"} view={cap.view} />
        {onClose ? (
          <button type="button" className="cx-ghost-icon" aria-label="关闭侧聊" onClick={onClose}>
            ×
          </button>
        ) : null}
      </header>
      <div className="cx-sidechat-list">
        {(thread?.messages ?? []).map((message) => (
          <div className="cx-sidechat-msg" data-role={message.role} key={message.id}>
            {message.text}
          </div>
        ))}
        {(thread?.messages ?? []).length === 0 ? (
          <p className="cx-sidechat-empty">借当前会话上下文提问，不会打断主线。本机 pi 未提供侧聊能力；接入扩展后启用。</p>
        ) : null}
      </div>
      <div className="cx-sidechat-composer">
        <textarea
          className="cx-sidechat-input"
          rows={2}
          value={draft}
          disabled={disabled}
          readOnly={disabled}
          placeholder={disabled ? "接入扩展后可提问" : "借上下文提问…"}
          aria-label="侧聊输入"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onComposerEnter}
        />
        <button type="button" className="cx-send" data-variant={disabled || !draft.trim() ? "send-muted" : "send"} disabled={disabled || !draft.trim()} aria-label="发送侧聊" data-p4-action="sidechat-send" onClick={send}>
          <Send aria-hidden size={13} strokeWidth={2} />
        </button>
      </div>
      <CodexDisabledNote>侧聊历史与发送需要扩展接入；未接入时不可用。</CodexDisabledNote>
    </section>
  )
}
