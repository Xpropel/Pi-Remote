import { useState } from "react"
import { Copy, GitBranch } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { useCodexCapability } from "../logic/capability"

/** 完成回合末的小动作排（[X-图12①] Copy / Good / Bad / Fork → v2 首版 Copy + 元信息；其余回 P3 迭代） */
export function CodexReplyActions({ p, text, meta }: { p: VariantAppProps; text: string; meta?: string }) {
  const [copied, setCopied] = useState(false)
  const [feedback, setFeedback] = useState<"good" | "bad" | null>(null)
  const fork = useCodexCapability("thread-fork-feedback")
  const onFeedback = (vote: "good" | "bad") => {
    if (!fork.interactive) {
      p.relay.notify(`反馈需要 thread-fork-feedback 扩展：${fork.view?.reason ?? "本机 pi 未提供"}${fork.view ? `（见 ${fork.view.docsPath}）` : ""}`, "warn")
      return
    }
    setFeedback(vote)
    fork.actions?.sendFeedback?.(vote)
    p.relay.notify(vote === "good" ? "已标记好评（模拟演示）" : "已标记差评（模拟演示）")
  }
  const onFork = () => {
    if (!fork.interactive) {
      p.relay.notify(`分叉需要 thread-fork-feedback 扩展：${fork.view?.reason ?? "本机 pi 未提供"}${fork.view ? `（见 ${fork.view.docsPath}）` : ""}`, "warn")
      return
    }
    const branch = fork.data?.fork?.branches?.[0]?.id
    if (branch) fork.actions?.forkThread?.(branch)
    p.relay.notify("已从这条消息分叉（模拟演示）")
  }
  return (
    <div className="cx-reply-actions" data-p4-surface="CX-THREAD-07" data-p4-ready="" data-pi-ui-part="row">
      <button
        type="button"
        className="cx-ghost-icon"
        aria-label={copied ? "已复制" : "复制回复"}
        title={copied ? "已复制" : "复制回复"}
        onClick={() => {
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            })
            .catch(() => p.relay.pushNotice({ level: "error", title: "复制失败：浏览器不允许写剪贴板" }))
        }}
      >
        <Copy aria-hidden size={13} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        className="cx-reply-ghost"
        data-active={feedback === "good" ? "" : undefined}
        data-p4-action="feedback-good"
        data-capability-state={fork.status}
        data-pi-capability-disabled={fork.interactive ? undefined : ""}
        title={fork.interactive ? "标记好评（provider）" : fork.view?.reason}
        onClick={() => onFeedback("good")}
      >
        好评
      </button>
      <button
        type="button"
        className="cx-reply-ghost"
        data-active={feedback === "bad" ? "" : undefined}
        data-p4-action="feedback-bad"
        data-capability-state={fork.status}
        data-pi-capability-disabled={fork.interactive ? undefined : ""}
        title={fork.interactive ? "标记差评（provider）" : fork.view?.reason}
        onClick={() => onFeedback("bad")}
      >
        差评
      </button>
      <button
        type="button"
        className="cx-reply-ghost cx-reply-fork"
        data-p4-action="fork-thread"
        data-capability-state={fork.status}
        data-pi-capability-disabled={fork.interactive ? undefined : ""}
        title={fork.interactive ? "从这条消息分叉（provider）" : fork.view?.reason}
        onClick={onFork}
      >
        <GitBranch aria-hidden size={11} strokeWidth={1.5} />
        分叉
      </button>
      {meta ? <span className="cx-reply-meta">{meta}</span> : null}
    </div>
  )
}
