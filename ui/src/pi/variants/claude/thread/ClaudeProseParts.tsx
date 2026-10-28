import { useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { ReactNode } from "react"
import { showEarlierText } from "@/pi/model/transcriptWindow"
import { ClaudeIconButton, ClaudeMark } from "../primitives/ClaudePrimitives"
import { Check, Copy } from "lucide-react"

/**
 * Claude v2 自有 Markdown 渲染（headless 库 react-markdown + remark-gfm；所有样式走自有 class，不使用 cursor 的 prose/kit 组件）。
 * 版式（§1.3 / §1.5）：助手正文 15/24 衬线；代码块 12/19 等宽、近纯黑底、12 圆角；表格 / 引用 / 列表按纸面语言。
 */

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="claude-codeblock">
      <div className="claude-codeblock-head">
        <span className="claude-codeblock-lang">{lang || "text"}</span>
        <ClaudeIconButton
          label={copied ? "已复制" : "复制代码"}
          icon={copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
          className="claude-codeblock-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1200)
            })
          }}
        />
      </div>
      <pre className="claude-codeblock-body">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function ClaudeMarkdown({ text }: { text: string }) {
  return (
    <div className="claude-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{children}</p>,
          h1: ({ children }) => <h1>{children}</h1>,
          h2: ({ children }) => <h2>{children}</h2>,
          h3: ({ children }) => <h3>{children}</h3>,
          h4: ({ children }) => <h4>{children}</h4>,
          h5: ({ children }) => <h5>{children}</h5>,
          h6: ({ children }) => <h6>{children}</h6>,
          ul: ({ children }) => <ul>{children}</ul>,
          ol: ({ children }) => <ol>{children}</ol>,
          li: ({ children }) => <li>{children}</li>,
          blockquote: ({ children }) => <blockquote>{children}</blockquote>,
          hr: () => <hr />,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="claude-table-wrap">
              <table>{children}</table>
            </div>
          ),
          strong: ({ children }) => <strong>{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          code: ({ className, children }) => {
            const raw = String(children ?? "").replace(/\n$/, "")
            const match = /language-([\w-]+)/.exec(className ?? "")
            const isBlock = match != null || raw.includes("\n")
            if (!isBlock) return <code className="claude-inline-code">{raw}</code>
            return <CodeBlock code={raw} lang={match?.[1] ?? ""} />
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

/** 一行系统收据（压缩 / 用时 / 回执）：衬线小字、左侧细线，不做成卡片 */
export function ClaudeReceipt({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <p className="claude-receipt" data-tone={tone}>
      {children}
    </p>
  )
}

/** 流顶提示（补拉 / 未载入 / 只读） */
export function ClaudeStreamTop({ text, actionText, onAction, spinner }: { text: string; actionText?: string; onAction?: () => void; spinner?: boolean }) {
  return (
    <p className="claude-stream-top" role="status">
      {spinner ? <span className="claude-spinner claude-spinner-sm" aria-hidden /> : null}
      <span>{text}</span>
      {actionText && onAction ? (
        <button type="button" className="claude-link-btn" onClick={onAction}>
          {actionText}
        </button>
      ) : null}
    </p>
  )
}

/**
 * 渲染窗的「显示更早的 N 条」（D01，和主界面 PiTranscript 同一口径、同一文案）：
 * 长会话一次只挂最近 300 条，流顶这一行点一次多挂一页；隐藏的条数写进 data 属性给测试用。
 */
export function ClaudeShowEarlier({ hidden, nextPage, onShow }: { hidden: number; nextPage: number; onShow: () => void }) {
  return (
    <p className="claude-stream-top" data-claude-window="earlier" data-hidden={hidden}>
      <button type="button" className="claude-link-btn" onClick={onShow}>
        {showEarlierText(nextPage)}
      </button>
    </p>
  )
}

/** 运行行 / 空态标记用的呼吸点 */
export function ClaudeRunningMark() {
  return <ClaudeMark size={13} className="claude-running-mark" />
}
