/**
 * diff family 内部共用的小工具与样式片段（不是组件，不进 catalog）。
 *
 * 组件级变量（tokens.css 里还没有；先用 var(名, 已有 token) 兜底，base 可提升进 tokens.local.css）：
 * - --cw-diff-code-size     diff 代码与行号字号。五帧实测每字 7.68 CSS px ≈ 13px（specs/ch3 §0.2），兜底 --cw-text-code-block
 * - --cw-diff-row-h         diff 行高 21（兜底 --cw-leading-code）
 * - --cw-diff-gutter-w      行号栏宽 45（含 2px 行首竖条区；specs/ch3 §1.3 列结构 0–2 / 2–46）
 * - --cw-diff-lineno-pad    行号右缘到行号栏右缘 10（行号右对齐于 35–36）
 * - --cw-diff-code-pad      代码第 0 列到行号栏右缘 13.5（代码起于 59.5）；无行号时（流内卡）为 12
 * 屏幕要按帧微调时，在外层 style 里覆盖这些变量即可，例如 style={{ "--cw-diff-code-size": "12px" }}。
 */
import type { FileKind } from "./types"

/** 子元素的 data-cw-id：根节点 data-cw-id + 后缀（例："idc-1" → "idc-1-toggle"），交互步骤用它点中内部按钮 */
export function subId(rootProps: object, suffix: string): string | undefined {
  const id = (rootProps as Record<string, unknown>)["data-cw-id"]
  return typeof id === "string" && id ? `${id}-${suffix}` : undefined
}

/** 代码区：等宽、13px、行高 21（组件级变量见文件头） */
export const DIFF_CODE_TEXT =
  "font-(family-name:--cw-font-mono) text-[length:var(--cw-diff-code-size,var(--cw-text-code-block))] leading-[var(--cw-diff-row-h,var(--cw-leading-code))]"

/** pane 里的 UI 字：13px / 400 SF Pro（specs/ch3 §0.2） */
export const PANE_TEXT =
  "font-(family-name:--cw-font-sans) text-(length:--cw-text-md) leading-(--cw-leading-tight) font-(--cw-weight-regular)"

/** 按扩展名推文件类型（屏幕可用 fileKind 覆盖） */
export function fileKindOf(path: string): FileKind {
  const name = path.toLowerCase()
  if (name.endsWith(".json")) return "json"
  if (name.endsWith(".html") || name.endsWith(".htm")) return "html"
  if (name.endsWith(".tsx") || name.endsWith(".jsx")) return "tsx"
  if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name)) return "ts"
  if (/\.(txt|md|log|csv)$/.test(name)) return "txt"
  return "file"
}
