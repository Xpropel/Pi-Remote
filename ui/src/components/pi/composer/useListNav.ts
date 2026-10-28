import { useState, type KeyboardEvent } from "react"
import { activeOptionIndex, nextOptionIndex } from "@/pi/model/composerInput"

/**
 * listbox + aria-activedescendant 的选中行（P4，design §4.7：命令面板、模型菜单、目录选择、斜杠 / @ 菜单）。
 * 焦点留在宿主（搜索框 / 输入框 / listbox 本身）上，↑↓ / Home / End 只改选中行；Enter 选中由调用方处理。
 * enabled = 每一行能不能选（禁用行跳过）；wanted 不可选时落到第一个可选行。
 */
export function useListNav(enabled: readonly boolean[], initial = 0) {
  const [wanted, setWanted] = useState(initial)
  const active = activeOptionIndex(enabled, wanted)
  /** 处理了返回 true（已 preventDefault）。withHomeEnd = false 时 Home / End 留给输入框移光标 */
  const onKeyDown = (event: KeyboardEvent, withHomeEnd = false): boolean => {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false
    const key = event.key
    if (key !== "ArrowDown" && key !== "ArrowUp" && !(withHomeEnd && (key === "Home" || key === "End"))) return false
    const next = nextOptionIndex(enabled, active, key)
    if (next < 0) return false
    event.preventDefault()
    setWanted(next)
    return true
  }
  return { active, setActive: setWanted, onKeyDown }
}
