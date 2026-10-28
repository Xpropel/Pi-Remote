import { createContext, useContext } from "react"

/**
 * 菜单内容关掉自己用的函数（P4）。放菜单内容的宿主提供：c 区的 PiCMenu（桌面锚定菜单）、可交互 PiSheet 的调用方（手机）。
 * 内容里不走 Radix Item 的选中（模型列表、目录列表这种 listbox + aria-activedescendant 的行）选中后调它；
 * Radix Item 的 onSelect 由 Radix 自己关菜单，不用它。没有宿主时为 null（静态态、画廊）。
 */
export const PiMenuCloseContext = createContext<(() => void) | null>(null)

export function usePiMenuClose(): (() => void) | null {
  return useContext(PiMenuCloseContext)
}
