import { useState } from "react"
import { usePiUiCapabilities } from "@/pi/extensions"
import { ClaudeBadge, ClaudeButton, ClaudeSheet } from "../primitives/ClaudePrimitives"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"

/**
 * P4 W3-A / CL-CODE-09：diff 行内评论 + 攒批提交面板。
 * 能力 `code-review-comments`：simulated（mock）下可添加评论、攒批提交（本地批次 + 回执），
 * provider actions 提供时同步调用；生产 unavailable 时整卡禁用 + 原因 + docsPath。
 */
export function ClaudeReviewCommentsSheet({ file, onClose }: { file: string; onClose: () => void }) {
  const caps = usePiUiCapabilities()
  const status = caps.statusOf("code-review-comments")
  const view = status === "unavailable" ? caps.disabledOf("code-review-comments") : null
  const threads = (caps.dataOf("code-review-comments")?.threads ?? []).filter((thread) => thread.path === file)
  const [draft, setDraft] = useState("")
  const [batch, setBatch] = useState<{ id: string; body: string }[]>([])
  const [receipt, setReceipt] = useState<string | null>(null)
  const writable = status !== "unavailable"
  const add = () => {
    if (!draft.trim() || !writable) return
    const item = { id: `local-${batch.length + 1}`, body: draft.trim() }
    setBatch((current) => [...current, item])
    setDraft("")
    setReceipt(`已加入待提交评论（${batch.length + 1} 条）`)
  }
  const submit = () => {
    if (batch.length === 0) return
    const threadId = threads[0]?.id
    if (threadId) caps.actionsOf("code-review-comments")?.reply?.(threadId, batch.map((item) => item.body).join("\n"))
    setReceipt(`已提交 ${batch.length} 条评论（${status === "simulated" ? "模拟演示 · 非真实" : "已接入"}）`)
    setBatch([])
  }
  return (
    <ClaudeSheet
      title="改动评论"
      subtitle={`${file} · ${status === "simulated" ? "模拟演示" : view ? "未接入" : "已接入"}`}
      onClose={onClose}
      footer={
        <>
          <ClaudeButton kind="outline" className="claude-btn-sm" onClick={onClose}>
            关闭
          </ClaudeButton>
          <ClaudeButton kind="primary" className="claude-btn-sm" disabled={!writable || batch.length === 0} onClick={submit} data-p4-action="review-submit">
            攒批提交（{batch.length}）
          </ClaudeButton>
        </>
      }
    >
      <div data-p4-surface="CL-CODE-09" data-p4-ready="" {...claudeCapabilityAttrs("code-review-comments", status)}>
        {view ? (
          <p className="claude-dialog-hint">
            {view.title}：{view.reason}；接入后即可评论 → {view.docsPath}
          </p>
        ) : (
          <>
            {receipt ? (
              <p className="claude-dialog-hint" role="status" data-p4-action="review-receipt">
                {receipt}
              </p>
            ) : null}
            {threads.length === 0 && batch.length === 0 ? <p className="claude-list-empty">这个文件还没有评论。</p> : null}
            {threads.map((thread) => (
              <div key={thread.id} className="claude-list-row" data-p4-row="">
                <div className="claude-row-body">
                  <span className="claude-row-label">
                    {thread.line != null ? `第 ${thread.line} 行` : thread.path}
                    {thread.resolved ? <ClaudeBadge>已解决</ClaudeBadge> : null}
                  </span>
                  <span className="claude-row-hint">{thread.comments.map((comment) => comment.body).join(" / ")}</span>
                </div>
              </div>
            ))}
            {batch.map((item) => (
              <div key={item.id} className="claude-list-row" data-p4-row="">
                <div className="claude-row-body">
                  <span className="claude-row-label">待提交</span>
                  <span className="claude-row-hint">{item.body}</span>
                </div>
              </div>
            ))}
            <div className="claude-approval-inputrow">
              <textarea
                className="claude-textarea"
                rows={2}
                value={draft}
                placeholder="在这份改动上留一条评论…"
                aria-label="改动评论"
                data-p4-action="review-input"
                onChange={(event) => setDraft(event.target.value)}
              />
              <ClaudeButton kind="outline" className="claude-btn-sm" disabled={!draft.trim()} onClick={add} data-p4-action="review-add">
                加入本批
              </ClaudeButton>
            </div>
          </>
        )}
      </div>
    </ClaudeSheet>
  )
}
