/**
 * sidebar family 内部共用的类名（不是组件，不进 catalog）。
 *
 * 行几何（#1 poster，s = 1.02，CSS px，相对行框左缘）：行框宽 253、底色块高 30、行距 --cw-row-h（31，帧里 30.8，
 * 屏幕可在 Sidebar 上覆盖 --cw-row-h 消除累积漂移）；16px 图标列中心 13、文字起点 31；行尾 14px 标记中心距右缘 16。
 * 文字宽度核对（Chrome SF Pro 13px/400）：带行尾标记的标题最宽 ≈ 194–197，无行尾标记 ≈ 206–206.8，与下面的内边距一致。
 */

/** 行框：底色块 = 行距 − 1px，再用 1px 下边距补回行距 */
export const ROW_BOX =
  "relative flex h-[calc(var(--cw-row-h)_-_1px)] mb-px w-full min-w-0 shrink-0 items-center rounded-(--cw-radius-row) pl-[5px] text-left text-(length:--cw-text-md) leading-(--cw-leading-tight) font-normal outline-none select-none"

/** 行首 16px 图标 / 标记列 */
export const ROW_LEAD = "flex size-4 shrink-0 items-center justify-center"

/** 标题（图标列后 10px 起），单行 */
export const ROW_TEXT = "ml-2.5 min-w-0 flex-1 overflow-hidden whitespace-nowrap"

/** 选中：--cw-row-selected 浅灰底 + --cw-text 字（字重不变：#1 选中行墨迹宽 141.2 = 400 的 142.1，500 会是 145.9） */
export const ROW_SELECTED = "data-[selected]:bg-(--cw-row-selected) data-[selected]:text-(--cw-text)"

/** 悬停（真实 :hover 由 data-hover / :hover 触发；静态帧用 forced="hover"）：未选中行换 --cw-sidebar-row-hover 底，字加深 */
export const ROW_HOVER =
  "data-[hover]:text-(--cw-text) data-[hover]:not-data-[selected]:bg-(--cw-sidebar-row-hover) focus-visible:not-data-[selected]:bg-(--cw-sidebar-row-hover)"
