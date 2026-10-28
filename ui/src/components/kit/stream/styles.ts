/**
 * stream family 共享的样式片段（只放 class 字符串，不放组件）。
 *
 * 对话列里的块分两组（specs/ch2 §2.2、ch1 §2.3 实测）：
 * - 撑满列宽：UserMessage、TerminalCard、InlineDiffCard、ActionPillRow、Composer
 * - 内缩一档（约 8 CSS px）：AgentProse、ReceiptLine、ToolLine、ThinkingBlock、VideoCard、MediaImage、TurnSummary
 * 内缩量由 ChatColumn 写进 CSS 变量 --stream-inset；不在 ChatColumn 里时变量不存在，margin 退回 0。
 *
 * 块间距靠各块自己的 margin-block + 普通块级流的 margin 折叠：
 *   正文块 6（--cw-space-1-5）、卡片 10（--cw-space-2-5）、用户消息 16（--cw-space-4）。
 */

/** 正文字：14/21 SF Pro（tokens --cw-text-base / --cw-leading-base） */
export const STREAM_TEXT =
  "font-(family-name:--cw-font-sans) text-(length:--cw-text-base) leading-(--cw-leading-base) font-(--cw-weight-regular)"

/** 内缩组的水平外边距 */
export const STREAM_INSET = "mx-(--stream-inset)"

/** 单行块（收据行 / 工具行 / 思考块标题）之间的块间距 */
export const STREAM_LINE_GAP = "my-(--cw-space-1-5)"

/** 卡片类块（视频卡、内嵌截图）上下间距 */
export const STREAM_CARD_GAP = "my-(--cw-space-2-5)"

/**
 * 行内 chip 公共部分：等宽 --cw-text-code、4px 圆角、可在字符间折行且每段都有圆角底（#1 #9 #14 实测 CodeChip/FileChip 词中断行）。
 * leading-none：等宽字与 SF Pro 的上下伸部不同，继承 21px 行高会把含 chip 的行撑高 2–3px（base 比对 #1：
 * 含 chip 的行距 23–24 对源图 21）；line-height 1 让 chip 的行内框落在行高之内，底色仍按字框 + 内边距画。
 * 字号读 --cw-chip-code-size（tokens.local.css，默认 = --cw-text-code；kit-requests ch5 #3）。
 * 断行样式默认 clone；chip 的 decoration="slice" 改成断口两侧不带内边距（#12 #25 #27，kit-requests ch3 #6、ch5 #3）。
 * data-stream-chip 让 AgentProse 的标题把 chip 放大到 0.9em（#1 h2 里的 `main`）。
 */
export const CHIP_BASE =
  "rounded-(--cw-radius-xs) px-[0.25em] py-[0.1em] font-(family-name:--cw-font-mono) text-[length:var(--cw-chip-code-size,var(--cw-text-code))] leading-none box-decoration-clone break-all"

/** chip 在标题里使用时的字号（#1：18px 标题里的等宽字约 16.3px） */
export const CHIP_HEADING = "text-[0.9em]"
