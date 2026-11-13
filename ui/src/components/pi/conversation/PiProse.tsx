import { createContext, Fragment, memo, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { AgentProse, CodeChip, FileChip, InlineLink } from "@/components/kit"
import { Square, SquareCheck } from "@/components/kit/icons"
import { cn } from "@/lib/utils"
import { piBaseName } from "@/components/pi/shared/format"
import { parseStreamingTail, splitStreamingMarkdown } from "@/components/ui/streaming-markdown-core"
import { looksLikeFilePath, normalizeFileTarget } from "@/shell/filePreview"
import { usePiTranscriptActions } from "./actions"
import { PiDisclosure } from "./PiCard"
import { PiCodeBlock } from "./PiCodeBlock"
import { closeOpenMarkdown, stableChunksOf } from "./streamChunks"
import { T_SECONDARY, TOUCH_44, TOUCH_44_TEXT } from "./styles"
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
 * 格里的行内代码 / 文件 chip 只在词边界断（正文里的 chip 任意处断）：列至少容下整个 chip，文件名不会断成 "cart.test.j / s"。
 */
const TABLE = "w-full border-collapse text-(length:--cw-text-md)"
const TABLE_CELL_MIN = "min-w-[7em]"
const CELL_CHIP = "[&_[data-stream-chip]]:[word-break:normal] [&_[data-stream-chip]]:[overflow-wrap:break-word]"
const TH = cn("py-1.5 pr-6 text-left font-(--cw-weight-semibold) text-(--cw-text-2) [overflow-wrap:anywhere]", TABLE_CELL_MIN, CELL_CHIP)
const TD = cn("py-1.5 pr-6 align-top [overflow-wrap:anywhere]", TABLE_CELL_MIN, CELL_CHIP)
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

function MdLink({ href, className, children }: { href?: string; className?: string; children?: ReactNode }) {
  const safe = safeHref(href)
  if (!safe) return <>{children}</>
  return (
    <InlineLink
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      onClick={() => window.open(safe, "_blank", "noopener,noreferrer")}
    >
      {children}
    </InlineLink>
  )
}

/**
 * 元素映射：# / ## = 节标题（h3，15/600，"改动""测试"这一档），### 及更深 = 小标题（h4，14/600，同 replica 的 h 节点）。
 * 对话里不用更大的字号：回复是一段对话，不是文档。围栏走 PiCodeBlock；表格、引用、任务清单同节点版
 */
const MD_COMPONENTS: Components = {
  h1: ({ children }) => <h3>{children}</h3>,
  h2: ({ children }) => <h3>{children}</h3>,
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

/* ---------------- 思考原文：同一条 Markdown 管线，换一套弱化、紧凑的元素映射 ---------------- */

/** 思考里的块：间距 6（正文同档，字小一号），首尾不往外撑 */
const THINKING_BLOCK = "my-(--cw-space-1-5) first:mt-0 last:mb-0"
/** 思考里的加粗 / 标题：同思考块的阶段小标题（600，--cw-thinking-phase），不跳到正文的满亮度 */
const THINKING_STRONG = "font-(--cw-weight-semibold) text-(--cw-thinking-phase)"
/** 思考里的代码：等宽、chip 底色减淡，字色随思考正文 */
const THINKING_CODE_BG = "bg-(--cw-code-chip-bg)/60"
const THINKING_LINK = "text-inherit underline decoration-(--cw-text-3) hover:text-(--cw-thinking-phase)"
const THINKING_CELL = "py-1 pr-4 text-left align-top [overflow-wrap:anywhere]"

/** 思考想完了（PiThinkingText 的 fold）：长代码段收起。流式中不收：新写的行要看得见，围栏闭合前后也不跳 */
const ThinkingFoldContext = createContext(false)
/** 思考里的代码段超过这么多行收起（同回复代码块，PiCodeBlock 的 foldAfter） */
const THINKING_CODE_FOLD = 12

/** 思考里的开合钮：一行灰字 + 箭头（思考是弱化的，不放卡底展开条），点击区 ≥ 44 */
function ThinkingFoldToggle({ open, onToggle, label }: { open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        "group/more mt-(--cw-space-1) flex cursor-pointer items-center gap-0.5 rounded-(--cw-radius-xs) text-(length:--cw-text-sm) leading-(--cw-leading-base) hover:text-(--cw-text-2)",
        T_SECONDARY,
        TOUCH_44_TEXT,
      )}
    >
      {label}
      <PiDisclosure open={open} sideways={false} className="group-hover/more:text-(--cw-text-2)" />
    </button>
  )
}

/** 思考里的代码段（也接流式中没闭合的围栏）：没有代码框头、高亮和复制钮，换行照留；想完以后超过 12 行收起，底部渐隐 */
function ThinkingCode({ text }: { text: string }) {
  const fold = useContext(ThinkingFoldContext)
  const [open, setOpen] = useState(false)
  const lines = fold ? text.split("\n").length : 0
  const foldable = lines > THINKING_CODE_FOLD
  const clipped = foldable && !open
  const pre = (
    <pre
      data-pi-part="thinking-code"
      className={cn(
        !foldable && THINKING_BLOCK,
        THINKING_CODE_BG,
        "rounded-(--cw-radius-xs) px-2 py-1.5 font-(family-name:--cw-font-mono) text-(length:--cw-text-code) leading-[1.5] whitespace-pre-wrap [overflow-wrap:anywhere]",
        clipped && "overflow-hidden",
      )}
      // 12 行 + 上下内边距（py-1.5）；lh = 这一段自己的行高
      style={clipped ? { maxHeight: `calc(${THINKING_CODE_FOLD}lh + 12px)`, maskImage: FOLD_MASK, WebkitMaskImage: FOLD_MASK } : undefined}
    >
      {text}
    </pre>
  )
  if (!foldable) return pre
  return (
    <div data-pi-part="thinking-code-fold" className={THINKING_BLOCK}>
      {pre}
      <ThinkingFoldToggle open={open} onToggle={() => setOpen(!open)} label={open ? "收起代码" : `展开代码（${lines} 行）`} />
    </div>
  )
}

/** 思考里的标题不当真标题（不进标题导航），写成一行加粗 */
const ThinkingHeading = ({ children }: { children?: ReactNode }) => <p className={cn(THINKING_BLOCK, THINKING_STRONG)}>{children}</p>

const THINKING_COMPONENTS: Components = {
  p: ({ children }) => <p className={THINKING_BLOCK}>{children}</p>,
  h1: ThinkingHeading,
  h2: ThinkingHeading,
  h3: ThinkingHeading,
  h4: ThinkingHeading,
  h5: ThinkingHeading,
  h6: ThinkingHeading,
  strong: ({ children }) => <strong className={THINKING_STRONG}>{children}</strong>,
  pre: ({ node }) => {
    const code = (node?.children ?? []).find((c) => c.type === "element" && c.tagName === "code") as HastNode | undefined
    return <ThinkingCode text={hastText(code).replace(/\n$/, "")} />
  },
  // 行内代码不分文件 chip：思考里不放蓝色可点的东西
  code: ({ children }) => <CodeChip className={cn(THINKING_CODE_BG, "text-inherit")}>{children}</CodeChip>,
  a: ({ href, children }) => (
    <MdLink href={href} className={THINKING_LINK}>
      {children}
    </MdLink>
  ),
  ul: ({ className, children }) => (
    <ul
      className={cn(
        THINKING_BLOCK,
        typeof className === "string" && className.includes("contains-task-list") ? "list-none" : "list-disc pl-4",
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ start, children }) => (
    <ol start={start} className={cn(THINKING_BLOCK, "list-decimal pl-5")}>
      {children}
    </ol>
  ),
  li: ({ className, node, children }) => {
    if (typeof className === "string" && className.includes("task-list-item")) {
      const box = (node?.children ?? []).find((c) => c.type === "element" && c.tagName === "input") as HastNode | undefined
      const done = !!box?.properties?.checked
      return (
        <li className="flex items-start gap-1.5 [&+li]:mt-0.5">
          <span className="mt-[calc((var(--cw-leading-base)-12px)/2)] inline-flex shrink-0 text-(--cw-text-3)">
            {done ? (
              <SquareCheck aria-label="已完成" size={12} strokeWidth={1.75} />
            ) : (
              <Square aria-label="未完成" size={12} strokeWidth={1.5} />
            )}
          </span>
          <span className="min-w-0">{children}</span>
        </li>
      )
    }
    return <li className="[&+li]:mt-0.5 [&>:is(ul,ol)]:my-0.5">{children}</li>
  },
  input: () => null,
  blockquote: ({ children }) => <blockquote className={cn(THINKING_BLOCK, "border-l-2 border-(--cw-divider) pl-2")}>{children}</blockquote>,
  hr: () => <hr className="my-(--cw-space-2) border-(--cw-divider) first:mt-0 last:mb-0" />,
  table: ({ children }) => (
    <div className={cn(THINKING_BLOCK, "overflow-x-auto")}>
      <table className="w-full border-collapse text-(length:--cw-text-sm) [&_tr]:border-b [&_tr]:border-(--cw-divider)">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className={cn(THINKING_CELL, "font-(--cw-weight-semibold)")}>{children}</th>,
  td: ({ children }) => <td className={THINKING_CELL}>{children}</td>,
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
}

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]

/** 一套 Markdown 外观：元素映射 + 流式中没闭合的围栏怎么画（lang = 围栏写的语言，可能还没写） */
type MarkdownLook = { components: Components; openCode: (text: string, lang: string) => ReactNode }
// 卡头语言名从围栏一开就写对（闭合前后不从「纯文本」跳成「TypeScript」）
const REPLY_LOOK: MarkdownLook = { components: MD_COMPONENTS, openCode: (text, lang) => <PiCodeBlock code={text} lang={lang} streaming /> }
const THINKING_LOOK: MarkdownLook = { components: THINKING_COMPONENTS, openCode: (text) => <ThinkingCode text={text} /> }
/** 回复正文与思考原文共用 MarkdownBlock / StreamingMarkdown，外观从这里取（默认回复） */
const LookContext = createContext<MarkdownLook>(REPLY_LOOK)

/** 一段 Markdown（memo：流式时稳定前缀不重复解析） */
const MarkdownBlock = memo(function MarkdownBlock({ content }: { content: string }) {
  const { components } = useContext(LookContext)
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {content}
    </ReactMarkdown>
  )
})

/**
 * 流式正文（D06）：streaming-markdown-core 切出稳定前缀（只在新的空行边界变化）+ 活动尾部；
 * 尾部最后是没闭合的围栏时，那一段按纯文本放进代码框（闭合后再交给正常 Markdown），不闪错结构【测试 streaming-markdown】。无光标竖条。
 * 稳定前缀再按顶层块切开（UI·perf 中-5）：前缀每推进一个空行边界只多解析新增的那一块，
 * 已经稳定的段落内容不变 → MarkdownBlock 的 memo 命中，不再整段重跑 markdown 管线。
 * 活动尾部的结尾先补成稳定的样子（closeOpenMarkdown）：没闭合的行内代码 / 加粗 / 删除线 / 链接补上闭合，写到一半的表格补分隔行，
 * 只敲了块标记的最后一行先不画 —— 字到齐前就按最终的结构画，不闪出孤立的 ` ** [ | 再跳成 chip / 加粗 / 链接 / 表格。
 */
function StreamingMarkdown({ text }: { text: string }) {
  const look = useContext(LookContext)
  const split = useMemo(() => splitStreamingMarkdown(text), [text])
  const chunks = useMemo(() => stableChunksOf(split.prefix), [split.prefix])
  const tail = useMemo(() => {
    const nodes = parseStreamingTail(split.tail)
    const last = [...nodes].reverse().find((n) => n.kind !== "space")
    if (last?.kind === "open-code" && split.tail.endsWith(last.raw)) {
      const head = split.tail.slice(0, split.tail.length - last.raw.length)
      // 围栏头那行（```ts）还没写完：先不出代码框，免得卡头先写「t」再变「TypeScript」
      if (!last.raw.includes("\n")) return { head, open: null, lang: "plain" }
      // 同闭合后 react-markdown 的 language-xxx：info string 的第一个词
      const lang = last.lang?.trim().split(/\s+/)[0] || "plain"
      // 收尾的围栏写到一半（` / ``）：那行不是代码，先不画（不然先露出反引号、闭合时又缩回去）
      const open = last.text.replace(last.raw.trimStart().startsWith("~") ? /(?:^|\n) {0,3}~+$/ : /(?:^|\n) {0,3}`+$/, "")
      return { head, open, lang }
    }
    return { head: closeOpenMarkdown(split.tail), open: null, lang: "plain" }
  }, [split.tail])
  return (
    <>
      {chunks.map((chunk, index) => (
        // 前缀只会在末尾追加新块，下标 key 因此稳定（老块不会换位）
        <MarkdownBlock key={index} content={chunk} />
      ))}
      {tail.head.trim() && <MarkdownBlock content={tail.head} />}
      {tail.open != null && look.openCode(tail.open, tail.lang)}
    </>
  )
}

/**
 * 思考原文（PiThinking 的正文）：和回复同一条 Markdown 管线（流式时同样是稳定前缀 + 活动尾部，不闪不跳），
 * 换一套弱化、紧凑的元素映射：字号 / 字色随思考块（--cw-thinking-body），加粗与标题同阶段小标题，
 * 行内代码与代码段等宽、底色减淡，没有代码框头、复制钮和蓝色文件 chip。换行照留（remark-breaks）。
 * cut：思考停在半路（停止生成 / 出错）时同样补成稳定的样子（closeOpenMarkdown）。
 * fold：想完了的思考（流式中不给）：超过 THINKING_FOLD_PX 收起、底部渐隐，下面一行「展开全文」；超过 12 行的代码段各自收起。
 */
export function PiThinkingText({ text, streaming, cut, fold }: { text: string; streaming?: boolean; cut?: boolean; fold?: boolean }) {
  const body = streaming ? <StreamingMarkdown text={text} /> : <MarkdownBlock content={cut ? closeOpenMarkdown(text) : text} />
  return (
    <LookContext.Provider value={THINKING_LOOK}>
      <div data-pi-part="thinking-text" className="min-w-0 [overflow-wrap:anywhere]">
        {fold ? (
          <ThinkingFoldContext.Provider value>
            <PiFold maxHeight={THINKING_FOLD_PX} auto toggle={(open, onToggle) => <ThinkingFoldToggle open={open} onToggle={onToggle} label={open ? "收起" : "展开全文"} />}>
              <div>{body}</div>
            </PiFold>
          </ThinkingFoldContext.Provider>
        ) : (
          body
        )}
      </div>
    </LookContext.Provider>
  )
}

export interface PiProseProps {
  /** 节点版正文（画廊 mock：replica 不解析 Markdown，design §3.4） */
  nodes?: readonly PiProseNode[]
  /** Markdown 原文（产品：text 块的 text）；给了就不看 nodes */
  markdown?: string
  /** 正在流式生成（isLiveText）：未闭合围栏按纯文本 */
  streaming?: boolean
  /** 回复停在半路（停止生成 / 出错 / 达到长度上限）的结尾：同流式的活动尾部补成稳定的样子（closeOpenMarkdown），不露出孤立的 ` / ** / [ */
  cut?: boolean
  /**
   * 长回复折叠（D16）：超过 maxHeight 时底部渐隐 + 居中 chevron（推断）。
   * auto：先量正文高度，明显超过（多出 40px 以上）才折叠，短的原样显示（产品用；画廊屏直接点名要折叠的块，不量）
   */
  fold?: { maxHeight: number; auto?: boolean }
  className?: string
}

/** 自动折叠时多出这么多才折（只多一两行不值得藏起来） */
const FOLD_SLACK = 40
/** 收起时底部 56px 渐隐 */
const FOLD_MASK = "linear-gradient(to bottom, black calc(100% - 56px), transparent)"
/** 想完的思考展开后最多这么高（约 12 行），再长收起（多出 FOLD_SLACK 才折） */
const THINKING_FOLD_PX = 240

/**
 * 长内容折叠（回复正文 D16、想完的思考）：超过 maxHeight 时收起、底部渐隐，下面一颗开合钮（toggle 画）。
 * auto：先量高度，明显超过（多出 FOLD_SLACK 以上）才折，短的原样显示；不 auto 就一律折（画廊屏点名要折的块，不量）。
 * 在 layout 阶段量（首帧前就收好，不先露全文再收），内容长高时 ResizeObserver 再量；children 是一个元素（量它的尺寸变化）。
 */
function PiFold({
  maxHeight,
  auto,
  toggle,
  children,
}: {
  maxHeight: number
  auto: boolean
  toggle: (open: boolean, onToggle: () => void) => ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
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
  const folding = !auto || tall
  const clipped = folding && !open
  return (
    <>
      <div
        ref={bodyRef}
        data-pi-fold={clipped ? "clipped" : folding ? "open" : undefined}
        className={cn(clipped && "overflow-hidden")}
        style={clipped ? { maxHeight, maskImage: FOLD_MASK, WebkitMaskImage: FOLD_MASK } : undefined}
      >
        {children}
      </div>
      {folding && toggle(open, () => setOpen(!open))}
    </>
  )
}

/** 助手正文（D05 / D06；compose from kit: AgentProse, CodeChip, FileChip, InlineLink）。流式时无光标竖条。 */
export function PiProse({ nodes, markdown, streaming, cut, fold, className }: PiProseProps) {
  const prose = (
    <AgentProse>
      {markdown != null ? (
        streaming ? (
          <StreamingMarkdown text={markdown} />
        ) : (
          <MarkdownBlock content={cut ? closeOpenMarkdown(markdown) : markdown} />
        )
      ) : (
        nodes?.map((n, i) => <Node key={i} node={n} />)
      )}
    </AgentProse>
  )
  return (
    <div data-pi-part="prose" className={cn("relative", className)}>
      {fold ? (
        <PiFold maxHeight={fold.maxHeight} auto={fold.auto === true} toggle={proseFoldToggle}>
          {prose}
        </PiFold>
      ) : (
        <div>{prose}</div>
      )}
    </div>
  )
}

/** 回复正文的开合钮：居中 chevron（D16） */
function proseFoldToggle(open: boolean, onToggle: () => void) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "收起" : "展开全文"}
      onClick={onToggle}
      // 视觉 40×24 不变，点击区 44×44（§4.4；B4）。z-[1]：点击区下沿伸到下一段正文上（下一个 PiProse 根是 relative，DOM 在后，
      // 默认会盖住这颗钮的 ::after；O-R2 表格换行后折叠出现在段落标题正上方时，ui-device E8 量到下沿那一点落在标题上），同 PiCodeBlock 的展开钮
      className={cn("group/fold z-[1] mx-auto -mt-1 flex h-6 w-10 cursor-pointer items-center justify-center", TOUCH_44)}
    >
      <PiDisclosure open={open} sideways={false} className="group-hover/fold:text-(--cw-text-2)" />
    </button>
  )
}
