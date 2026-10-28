import type { ComponentPropsWithoutRef } from "react"
import { cn } from "@/lib/utils"
import { STREAM_INSET, STREAM_TEXT } from "./styles"

/**
 * 正文排版规则，全部挂在 :where(根) 下，特异性为 0：屏幕给子元素的普通 utility class 总能覆盖。
 * 数值来源：specs/ch2 §0.4（正文 14/21、块间距 6、列表缩进 28、项间距 6、圆点中心 +17）、
 * specs/ch1 #1（h2 18/600、分隔线、有序列表序号右对齐到文字左缘 −8）、tokens.md（h3 15/600、Summary/Testing 14/600）。
 */
const PROSE = [
  // 子块不再叠加对话列的内缩
  "[&>*]:[--stream-inset:0px]",
  // 行内
  "[:where(&)_:is(strong,b)]:font-(--cw-weight-semibold)",
  "[:where(&)_em]:italic",
  // 段落与列表：块间距 6（相邻 margin 折叠）
  "[:where(&)_:is(p,ul,ol)]:my-(--cw-space-1-5)",
  // 标题
  "[:where(&)_:is(h2,h3,h4)]:font-(--cw-weight-semibold) [:where(&)_:is(h2,h3,h4)]:text-(--cw-text)",
  "[:where(&)_h2]:mt-(--cw-space-3) [:where(&)_h2]:mb-(--cw-space-1-5) [:where(&)_h2]:text-(length:--cw-text-xl) [:where(&)_h2]:leading-[1.5]",
  "[:where(&)_h3]:my-(--cw-space-1-5) [:where(&)_h3]:text-(length:--cw-text-lg)",
  "[:where(&)_h4]:my-(--cw-space-1-5) [:where(&)_h4]:text-(length:--cw-text-base)",
  // 分隔线（#1：段落 → 线约 24，线 → 标题约 12）
  "[:where(&)_hr]:mt-(--cw-space-6) [:where(&)_hr]:mb-(--cw-space-3) [:where(&)_hr]:border-t [:where(&)_hr]:border-(--cw-divider)",
  // 列表
  "[:where(&)_:is(ul,ol)]:pl-[calc(var(--cw-space-6)_+_var(--cw-space-1))]",
  "[:where(&)_li]:relative [:where(&)_li+li]:mt-(--cw-space-1-5) [:where(&)_li_:is(ul,ol)]:mb-0",
  // 无序：4px 实心圆点，中心在文字左缘 −11，对齐首行
  "[:where(&)_ul>li]:before:absolute [:where(&)_ul>li]:before:left-[-13px] [:where(&)_ul>li]:before:top-[calc(var(--cw-leading-base)/2_-_1.5px)] [:where(&)_ul>li]:before:size-(--cw-space-1) [:where(&)_ul>li]:before:rounded-full [:where(&)_ul>li]:before:bg-current",
  // 有序：序号右对齐到文字左缘 −8（间距读 --cw-prose-ol-gap，默认 --cw-space-2；#23 是 4.8，kit-requests ch5 #14）
  "[:where(&)_ol]:[counter-reset:cw-ol] [:where(&)_ol>li]:[counter-increment:cw-ol]",
  "[:where(&)_ol>li]:before:absolute [:where(&)_ol>li]:before:top-0 [:where(&)_ol>li]:before:right-[calc(100%_+_var(--cw-prose-ol-gap,var(--cw-space-2)))] [:where(&)_ol>li]:before:content-[counter(cw-ol)'.']",
  // 有序列表的"标题项"：<li data-marker="heading">（#12 的 "1. frontend/app/lib/…" 序号加粗加大）
  "[:where(&)_ol>li[data-marker=heading]]:before:font-(--cw-weight-semibold) [:where(&)_ol>li[data-marker=heading]]:before:text-(length:--cw-text-lg)",
  // 标题里的 chip 随标题放大（#1 "what `main` already follows"）
  "[:where(&)_:is(h2,h3,h4)_[data-stream-chip]]:text-[0.9em]",
].join(" ")

export type AgentProseProps = ComponentPropsWithoutRef<"div">

/**
 * agent 回复正文：无框裸文本。直接写语义标签：
 *   <AgentProse>
 *     <p>So the “platform move” did not die on <CodeChip>main</CodeChip>; it was <strong>rolled back once</strong>…</p>
 *     <hr />
 *     <h2>Why the first move “failed”</h2>
 *     <ol><li><strong>Risk / timing</strong> — …</li></ol>
 *     <h4>Testing</h4>
 *     <ul><li>✅ Pre-commit hook ran …</li></ul>
 *   </AgentProse>
 * 标题：h2 = 18/600（#1），h3 = 15/600（"Walkthrough"），h4 = 14/600（"Summary"/"Testing"）。
 * ✅ / ⚠️ 直接写系统 emoji（帧里是 Apple Color Emoji，不用 lucide）。
 * 根节点是普通块级元素，子块的上下 margin 会和外面的 ReceiptLine、VideoCard 等折叠，节奏与帧一致。
 */
export function AgentProse({ className, ...rest }: AgentProseProps) {
  return <div className={cn(STREAM_TEXT, STREAM_INSET, "min-w-0 text-(--cw-text)", PROSE, className)} {...rest} />
}
