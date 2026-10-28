import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { AgentProse, CodeChip, FileChip, InlineLink } from "@/components/kit"
import { ChevronDown, Square, SquareCheck } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { piBaseName } from "@/components/pi/shared/format"
import { parseStreamingTail, splitStreamingMarkdown } from "@/components/ui/streaming-markdown-core"
import { looksLikeFilePath, normalizeFileTarget } from "@/shell/filePreview"
import { usePiTranscriptActions } from "./actions"
import { PiCodeBlock } from "./PiCodeBlock"
import { stableChunksOf } from "./streamChunks"
import { TOUCH_44 } from "./styles"
import type { PiInline, PiProseNode } from "@/components/pi/shared/types"

/**
 * 行内 FileChip 的点击区（R2-B-m2）：chip 视觉约 18 高，::after 以 chip 为中心上下外扩到正文行高（手机 22、桌面 21），
 * 填满它所在的那一行，不伸进上下相邻行。到不了 44：44 会压住上下两行的字（行内链接按 WCAG 2.5.8 的 inline 例外）。视觉不变。
 */
const FILE_CHIP_HIT =
  "relative after:absolute after:inset-x-0 after:top-1/2 after:h-(--cw-leading-base) after:-translate-y-1/2 after:content-['']"

/** 蓝色 FileChip（点开文件视图）：显示文件名，title 是完整路径 */
function PiFileChip({ path, label }: { path: string; label?: string }) {
  const actions = usePiTranscriptActions()
  const open = actions?.openFile
  return (
    <FileChip tone="blue" title={path} className={FILE_CHIP_HIT} onClick={open ? () => open(path) : undefined}>
      {label ?? piBaseName(path)}
    </FileChip>
  )
}

/** 行内节点 → kit 部件：CodeChip / 蓝色 FileChip（点开文件 pane）/ InlineLink / 加粗 */
export function PiInlines({ nodes }: { nodes: readonly PiInline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (typeof n === "string") return <Fragment key={i}>{n}</Fragment>
        if ("code" in n) return <CodeChip key={i}>{n.code}</CodeChip>
        if ("file" in n) return <PiFileChip key={i} path={n.file} label={n.label} />
        if ("link" in n) return <InlineLink key={i}>{n.link}</InlineLink>
        return <strong key={i}>{n.b}</strong>
      })}
    </>
  )
}

/** 任务清单的一行（勾选 = 蓝，规则 2：蓝 = 选中与确认；只读，不可点）。节点版和 Markdown 版共用 */
function TaskRow({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-[calc((var(--cw-leading-base)-14px)/2)] inline-flex shrink-0">
        {done ? (
          <SquareCheck aria-label="已完成" size={14} strokeWidth={1.75} className="text-(--cw-blue)" />
        ) : (
          <Square aria-label="未完成" size={14} strokeWidth={1.5} className="text-(--cw-text-3)" />
        )}
      </span>
      <span className={cn(done && "text-(--cw-text-2)")}>{children}</span>
    </div>
  )
}

const TASK_LIST = "my-(--cw-space-1-5) space-y-(--cw-space-1-5)"
const TABLE_WRAP = "my-(--cw-space-2-5) overflow-x-auto"
/**
 * 表格（O-R2）：放得下时照旧占满正文宽；放不下时单元格换行（不再一格一行地横向拖），每列至少 TABLE_CELL_MIN 宽；
 * 列多到最小列宽也放不下时，表格比容器宽，整块在 TABLE_WRAP 里横向滚动。长英文 / 路径在格内任意处断（overflow-wrap:anywhere），
 * 最小列宽由 min-width 兜住，不会被挤成一字一行。
 */
const TABLE = "w-full border-collapse text-(length:--cw-text-md)"
const TABLE_CELL_MIN = "min-w-[7em]"
const TH = cn("py-1.5 pr-6 text-left font-(--cw-weight-semibold) text-(--cw-text-2) [overflow-wrap:anywhere]", TABLE_CELL_MIN)
const TD = cn("py-1.5 pr-6 align-top [overflow-wrap:anywhere]", TABLE_CELL_MIN)
const QUOTE = "my-(--cw-space-1-5) border-l-2 border-(--cw-border-strong) pl-3 text-(--cw-text-2)"

function Node({ node }: { node: PiProseNode }): ReactNode {
  if ("p" in node) return <p><PiInlines nodes={node.p} /></p>
  if ("h" in node) return <h4><PiInlines nodes={node.h} /></h4>
  if ("ul" in node)
    return <ul>{node.ul.map((li, i) => <li key={i}><PiInlines nodes={li} /></li>)}</ul>
  if ("ol" in node)
    return <ol>{node.ol.map((li, i) => <li key={i}><PiInlines nodes={li} /></li>)}</ol>
  if ("task" in node)
    return (
      <div data-pi-part="task-list" className={TASK_LIST}>
        {node.task.map((t, i) => (
          <TaskRow key={i} done={t.done}>
            <PiInlines nodes={t.text} />
          </TaskRow>
        ))}
      </div>
    )
  if ("table" in node)
    return (
      // 独立横滚容器，只有横线（D05 / session-archived）
      <div data-pi-part="table" className={TABLE_WRAP}>
        <table className={TABLE}>
          <thead>
            <tr className="border-b border-(--cw-border)">
              {node.table.head.map((h, i) => (
                <th key={i} className={TH}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.table.rows.map((row, r) => (
              <tr key={r} className="border-b border-(--cw-divider)">
                {row.map((cell, c) => (
                  <td key={c} className={TD}><PiInlines nodes={[cell]} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  if ("quote" in node)
    return (
      <blockquote className={QUOTE}>
        <PiInlines nodes={node.quote} />
      </blockquote>
    )
  return <PiCodeBlock code={node.code} lang={node.lang ?? "plain"} />
}

/* ---------------- Markdown（产品：react-markdown + remark-gfm 渲染到同一套部件，design §6.4 / D05 / D06） ---------------- */

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

function hastText(node: HastNode | undefined): string {
  if (!node) return ""
  if (node.type === "text") return node.value ?? ""
  return (node.children ?? []).map(hastText).join("")
}

/** 围栏语言：`language-xxx` → xxx（带 - + # 的语言名照留）；没有就是纯文本 */
function fenceLang(className: unknown): string {
  const text = Array.isArray(className) ? className.join(" ") : typeof className === "string" ? className : ""
  const m = /(?:^|\s)language-(\S+)/.exec(text)
  return m ? m[1] : "plain"
}

/** 只放行 http(s) / mailto；别的协议（javascript: 等）只显示文字 */
function safeHref(href: string | undefined): string | null {
  const raw = (href ?? "").trim()
  if (!raw) return null
  try {
    const url = new URL(raw, "https://pi.invalid/")
    if (url.origin === "https://pi.invalid") return null
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? raw : null
  } catch {
    return null
  }
}

/** 行内代码：像文件路径的（shell/filePreview 的判定，和旧界面同一口径）= 蓝色 FileChip，其余 CodeChip */
function MdInlineCode({ children }: { children?: ReactNode }) {
  const text = String(children ?? "")
  if (looksLikeFilePath(text)) return <PiFileChip path={normalizeFileTarget(text)} />
  return <CodeChip>{children}</CodeChip>
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  const safe = safeHref(href)
  if (!safe) return <>{children}</>
  return (
    <InlineLink href={safe} target="_blank" rel="noopener noreferrer" onClick={() => window.open(safe, "_blank", "noopener,noreferrer")}>
      {children}
    </InlineLink>
  )
}

/** 元素映射：标题一律是小标题那一档（h4，14/600，同 replica 的 h 节点）；围栏走 PiCodeBlock；表格、引用、任务清单同节点版 */
const MD_COMPONENTS: Components = {
  h1: ({ children }) => <h4>{children}</h4>,
  h2: ({ children }) => <h4>{children}</h4>,
  h3: ({ children }) => <h4>{children}</h4>,
  h4: ({ children }) => <h4>{children}</h4>,
  h5: ({ children }) => <h4>{children}</h4>,
  h6: ({ children }) => <h4>{children}</h4>,
  // 围栏代码在 pre 里整块接管（PiCodeBlock 自己画框、高亮、复制）；剩下的 code 都是行内
  pre: ({ node }) => {
    const code = (node?.children ?? []).find((c) => c.type === "element" && c.tagName === "code") as HastNode | undefined
    const text = hastText(code).replace(/\n$/, "")
    return <PiCodeBlock code={text} lang={fenceLang(code?.properties?.className)} />
  },
  code: ({ children }) => <MdInlineCode>{children}</MdInlineCode>,
  a: ({ href, children }) => <MdLink href={href}>{children}</MdLink>,
  table: ({ children }) => (
    <div data-pi-part="table" className={TABLE_WRAP}>
      <table
        className={cn(
          TABLE,
          "[&_thead_tr]:border-b [&_thead_tr]:border-(--cw-border) [&_tbody_tr]:border-b [&_tbody_tr]:border-(--cw-divider)",
        )}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => <th className={TH}>{children}</th>,
  td: ({ children }) => <td className={TD}>{children}</td>,
  blockquote: ({ children }) => <blockquote className={QUOTE}>{children}</blockquote>,
  ul: ({ className, children }) =>
    typeof className === "string" && className.includes("contains-task-list") ? (
      <div data-pi-part="task-list" className={TASK_LIST}>
        {children}
      </div>
    ) : (
      <ul>{children}</ul>
    ),
  li: ({ className, node, children }) => {
    if (typeof className === "string" && className.includes("task-list-item")) {
      const box = (node?.children ?? []).find((c) => c.type === "element" && c.tagName === "input") as HastNode | undefined
      return <TaskRow done={!!box?.properties?.checked}>{children}</TaskRow>
    }
    return <li>{children}</li>
  },
  // 任务清单的勾选框由 TaskRow 画
  input: () => null,
  // 正文里的图片链接不内嵌（来源不明的外链图），只写替代文字
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

/** 一段 Markdown（memo：流式时稳定前缀不重复解析） */
const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MD_COMPONENTS}>
      {content}
    </ReactMarkdown>
  )
})

/**
 * 流式正文（D06）：streaming-markdown-core 切出稳定前缀（只在新的空行边界变化）+ 活动尾部；
 * 尾部最后是没闭合的围栏时，那一段按纯文本放进代码框（闭合后再交给正常 Markdown），不闪错结构【测试 streaming-markdown】。无光标竖条。
 * 稳定前缀再按顶层块切开（UI·perf 中-5）：前缀每推进一个空行边界只多解析新增的那一块，
 * 已经稳定的段落内容不变 → MarkdownBlock 的 memo 命中，不再整段重跑 markdown 管线。
 */
function StreamingMarkdown({ text }: { text: string }) {
  const split = useMemo(() => splitStreamingMarkdown(text), [text])
  const chunks = useMemo(() => stableChunksOf(split.prefix), [split.prefix])
  const tail = useMemo(() => {
    const nodes = parseStreamingTail(split.tail)
    const last = [...nodes].reverse().find((n) => n.kind !== "space")
    if (last?.kind === "open-code" && split.tail.endsWith(last.raw)) {
      return { head: split.tail.slice(0, split.tail.length - last.raw.length), open: last.text }
    }
    return { head: split.tail, open: null }
  }, [split.tail])
  return (
    <>
      {chunks.map((chunk, index) => (
        // 前缀只会在末尾追加新块，下标 key 因此稳定（老块不会换位）
        <MarkdownBlock key={index} content={chunk} />
      ))}
      {tail.head.trim() && <MarkdownBlock content={tail.head} />}
      {tail.open != null && <PiCodeBlock code={tail.open} lang="plain" />}
    </>
  )
}

export interface PiProseProps {
  /** 节点版正文（画廊 mock：replica 不解析 Markdown，design §3.4） */
  nodes?: readonly PiProseNode[]
  /** Markdown 原文（产品：text 块的 text）；给了就不看 nodes */
  markdown?: string
  /** 正在流式生成（isLiveText）：未闭合围栏按纯文本 */
  streaming?: boolean
  /**
   * 长回复折叠（D16）：超过 maxHeight 时底部渐隐 + 居中 chevron（推断）。
   * auto：先量正文高度，明显超过（多出 40px 以上）才折叠，短的原样显示（产品用；画廊屏直接点名要折叠的块，不量）
   */
  fold?: { maxHeight: number; auto?: boolean }
  className?: string
}

/** 自动折叠时多出这么多才折（只多一两行不值得藏起来） */
const FOLD_SLACK = 40

/** 助手正文（D05 / D06；compose from kit: AgentProse, CodeChip, FileChip, InlineLink）。流式时无光标竖条。 */
export function PiProse({ nodes, markdown, streaming, fold, className }: PiProseProps) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const auto = fold?.auto === true
  const maxHeight = fold?.maxHeight ?? 0
  useLayoutEffect(() => {
    if (!auto) return
    const el = bodyRef.current
    if (!el) return
    const measure = () => setTall(el.scrollHeight > maxHeight + FOLD_SLACK)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
  }, [auto, maxHeight])
  const folding = fold != null && (!auto || tall)
  const clipped = folding && !open
  return (
    <div data-pi-part="prose" className={cn("relative", className)}>
      <div
        ref={bodyRef}
        className={cn(clipped && "overflow-hidden")}
        style={
          clipped
            ? {
                maxHeight,
                maskImage: "linear-gradient(to bottom, black calc(100% - 56px), transparent)",
                WebkitMaskImage: "linear-gradient(to bottom, black calc(100% - 56px), transparent)",
              }
            : undefined
        }
      >
        <AgentProse>
          {markdown != null ? (
            streaming ? (
              <StreamingMarkdown text={markdown} />
            ) : (
              <MarkdownBlock content={markdown} />
            )
          ) : (
            nodes?.map((n, i) => <Node key={i} node={n} />)
          )}
        </AgentProse>
      </div>
      {folding && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "收起" : "展开全文"}
          onClick={() => setOpen(!open)}
          // 视觉 40×24 不变，点击区 44×44（§4.4；B4）。z-[1]：点击区下沿伸到下一段正文上（下一个 PiProse 根是 relative，DOM 在后，
          // 默认会盖住这颗钮的 ::after；O-R2 表格换行后折叠出现在段落标题正上方时，ui-device E8 量到下沿那一点落在标题上），同 PiCodeBlock 的展开钮
          className={cn("z-[1] mx-auto -mt-1 flex h-6 w-10 items-center justify-center text-(--cw-text-2)", TOUCH_44)}
        >
          <ChevronDown size={16} strokeWidth={1.5} aria-hidden className={cn(open && "rotate-180")} />
        </button>
      )}
    </div>
  )
}
