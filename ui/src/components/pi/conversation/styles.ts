/**
 * b 区共用的 class 片段。Pi 变量（--cw-pi-*）由 a 区的 shared/pi-theme.css 定义；这里都带 kit token 兜底，
 * 主题 CSS 没加载时也能看。
 */

/** 需要读的灰字（收据行、行尾状态、说明；design §4.6：比 --cw-text-3 深一档，推断） */
export const T_SECONDARY = "text-[color:var(--cw-pi-text-secondary,var(--cw-text-3))]"

/** 出错红字（= --cw-red，§1.4） */
export const T_ERROR = "text-[color:var(--cw-pi-error,var(--cw-red))]"

/** 等你回答（= --cw-blue，§1.4） */
export const T_ATTENTION = "text-[color:var(--cw-pi-attention,var(--cw-blue))]"

/** 手机最小点击区：视觉小、点击区 ≥ 44（§4.4）。给 position:relative 的按钮加一圈看不见的扩展区 */
export const TOUCH_44 =
  "relative after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
/**
 * 行内文字按钮 / 文字行开关（"重试""加载原图""思考 6 秒 ›"）：点击区至少 44×44（取 46，免得半像素取整后量成 43），比它宽的按自身宽度。
 * 视觉不变（看不见的 ::after 外扩，§4.4）；inline 元素也成立。
 */
export const TOUCH_44_TEXT =
  "relative after:absolute after:top-1/2 after:left-1/2 after:h-[46px] after:w-[max(100%,46px)] after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']"
/** 子元素里的 kit 图标钮（DiffFileRow 的 Open file、ChangesSummaryRow 的 Toggle changes）：同上，44×44 外扩 */
export const TOUCH_44_CHILD_BUTTON =
  "[&>button]:relative [&>button]:after:absolute [&>button]:after:top-1/2 [&>button]:after:left-1/2 [&>button]:after:size-11 [&>button]:after:-translate-x-1/2 [&>button]:after:-translate-y-1/2 [&>button]:after:content-['']"

/** 终端输出区：等宽 12、--cw-code-chip-bg 底 */
export const TERM_OUTPUT =
  "font-(family-name:--cw-font-mono) text-(length:--cw-text-code) leading-[18px] bg-(--cw-code-chip-bg) text-(--cw-text-2)"
