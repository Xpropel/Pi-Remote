import { marked } from "marked"

/**
 * 流式正文的“稳定前缀”再切成若干可独立 memo 的块（UI·perf 中-5）。
 *
 * 背景：`streaming-markdown-core.splitStreamingMarkdown` 给出一段稳定前缀（到最后一个不在围栏里的空行），
 * 流式推进时这段前缀每跨过一个空行边界就会变长。整段前缀交给一个 `MarkdownBlock` 的话，每次变长
 * 都要把前面已经稳定的段落重新走一遍 react-markdown（remark parse → hast → React 元素），越到尾越贵。
 *
 * 切块口径 = marked 的**顶层 token** 边界：列表、引用、围栏代码、表格在 token 里本来就是整块，
 * 所以不会把列表切成两半（编号从 1 重来）、也不会切进围栏。前缀增长只会**追加新 token**，
 * 已有 token 的 raw 一字不变 → 每块内容的字符串引用稳定 → `MarkdownBlock` 的 memo 命中，只解析新增段。
 *
 * 纯函数（不碰 React），node --test 直接加载。
 */
export function stableChunksOf(prefix: string): string[] {
  if (!prefix) return []
  const chunks: string[] = []
  for (const token of marked.lexer(prefix)) {
    // space token 只是块与块之间的空行：块内容离开它照样渲染，丢掉可以少一层组件
    if (token.type === "space") continue
    if (token.raw) chunks.push(token.raw)
  }
  return chunks
}
