import { memo } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

/** 代码块（[X-§7]：12 圆角、近黑底、等宽 12/19、语言头）；语法色 v2 首版用单色（shiki 留给打磨） */
export const CodexCodeBlock = memo(function CodexCodeBlock({ text, lang }: { text: string; lang?: string | null }) {
  return (
    <div className="cx-code-block" data-lang={lang ?? undefined}>
      {lang ? <div className="cx-code-lang">{lang}</div> : null}
      <pre>
        <code>{text.replace(/\n$/, "")}</code>
      </pre>
    </div>
  )
})

/** Markdown 组件映射置顶为常量：memo 后未变化的正文不会重复 parse（R4 性能动作 1） */
const MARKDOWN_COMPONENTS = {
  code: ({ className, children }: { className?: string; children?: React.ReactNode }) => {
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? null
    const value = String(children ?? "")
    if (value.includes("\n")) return <CodexCodeBlock text={value} lang={lang} />
    return <code className="cx-code-inline">{children}</code>
  },
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2>{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3>{children}</h3>,
  h4: ({ children }: { children?: React.ReactNode }) => <h4>{children}</h4>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="cx-table-wrap">
      <table>{children}</table>
    </div>
  ),
  hr: () => <hr />,
}

/** 助手正文（[X-§1][X-图7③]：14/22 系统栈、无边框直铺；行内 code/chip 自写映射）
 *  R4 性能动作 1：按 text 记忆化 + 稳定 Markdown 组件映射 —— 长会话旧消息不会在流式更新时重复 parse。 */
export const CodexAssistantProse = memo(function CodexAssistantProse({ text }: { text: string }) {
  return (
    <div className="cx-prose" data-pi-ui-part="thread">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
const REMARK_PLUGINS = [remarkGfm]
