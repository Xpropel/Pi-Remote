import { useState } from "react"
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react"
import { usePiUiCapabilities } from "@/pi/extensions"
import { ClaudeReviewCommentsSheet } from "../overlays/ClaudeReviewCommentsSheet"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"
import type { PiDiffLine } from "@/pi/model/diffRows"
import { cx } from "../model/cx"

/**
 * Claude v2 自有 diff 卡（§1.8 [C-图4] / [C-图13③]）：文件头（文件 + +N −N）+ 行级红绿。
 * 数据来自 @/pi/model/diffRows 的纯函数（工具块的 patch / args 推导），渲染与样式全部自有。
 */

export function ClaudeDiffCard({
  file,
  added,
  removed,
  rows,
  truncated,
}: {
  file: string
  added: number
  removed: number
  rows: readonly PiDiffLine[]
  truncated?: boolean
}) {
  const [open, setOpen] = useState(true)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const caps = usePiUiCapabilities()
  const reviewStatus = caps.statusOf("code-review-comments")
  const reviewDisabled = reviewStatus === "unavailable" ? caps.disabledOf("code-review-comments") : null
  return (
    <section className="claude-diffcard">
      <header className="claude-diffcard-head">
        <button type="button" className="claude-diffcard-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={13} strokeWidth={2} aria-hidden /> : <ChevronRight size={13} strokeWidth={2} aria-hidden />}
          <span className="claude-diffcard-file">{file}</span>
        </button>
        <span className="claude-diffstat">
          <span className="claude-diffstat-add">+{added}</span>
          <span className="claude-diffstat-del">−{removed}</span>
          {truncated ? <span className="claude-diffcard-trunc">截断</span> : null}
        </span>
        <button
          type="button"
          className="claude-icon-btn"
          aria-label="评论这份改动"
          data-p4-action="diff-comment"
          disabled={reviewDisabled != null}
          {...claudeCapabilityAttrs("code-review-comments", reviewStatus)}
          title={reviewDisabled ? `${reviewDisabled.title}：${reviewDisabled.reason}（${reviewDisabled.docsPath}）` : "行内评论 / 攒批提交"}
          onClick={() => setCommentsOpen(true)}
        >
          <MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden />
          {reviewStatus === "simulated" ? <span className="claude-badge">模拟演示</span> : null}
        </button>
      </header>
      {commentsOpen ? <ClaudeReviewCommentsSheet file={file} onClose={() => setCommentsOpen(false)} /> : null}
      {open ? (
        <div className="claude-diffcard-body">
          {rows.length === 0 ? <div className="claude-diff-fold">没有可显示的行</div> : null}
          {rows.map((row, i) => (
            <div key={`row-${i}`} className={cx("claude-diff-row", `claude-diff-row-${row.kind}`)}>
              <span className="claude-diff-lineno">{row.n ?? ""}</span>
              <span className="claude-diff-sign" aria-hidden>
                {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
              </span>
              <span className="claude-diff-code">{row.text || " "}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
