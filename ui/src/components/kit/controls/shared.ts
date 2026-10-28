/**
 * controls family 内部共用的小工具（不是组件，不进 catalog）。
 */
export type { Forced } from "@/components/kit/types"

/**
 * 键盘焦点环。帧里没有拍到焦点态，这里是推断：确认蓝细环，只在键盘聚焦（:focus-visible）
 * 或静态强制 forced="focus" 时出现。
 */
export const focusRing =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--cw-blue) data-[forced=focus]:outline-2 data-[forced=focus]:outline-offset-1 data-[forced=focus]:outline-(--cw-blue)"
