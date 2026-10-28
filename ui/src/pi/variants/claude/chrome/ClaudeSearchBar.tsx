import { Search } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"

/**
 * Claude v2 自有搜索条（[C-图8③]）：999 胶囊输入（这里是入口按钮，点开命令面板 / 侧栏搜索态），右端 ⌘K 徽章。
 */

export function ClaudeSearchBar({ p, mobile = false }: { p: PiContainerProps; mobile?: boolean }) {
  const { act, ui } = p
  return (
    <button
      type="button"
      className={mobile ? "claude-searchbar claude-searchbar-phone" : "claude-searchbar"}
      aria-label="搜索会话、设备、命令"
      data-p4-surface="CL-SHELL-04"
      data-p4-action={mobile ? "open-search" : "open-palette"}
      onClick={() => (mobile ? act.setSearch("") : act.setPaletteOpen(true))}
    >
      <Search size={14} strokeWidth={1.75} aria-hidden />
      <span className="claude-searchbar-text">{ui.search != null ? "正在搜索…" : "搜索会话、设备、命令…"}</span>
      <span aria-hidden className="claude-kbd">
        ⌘K
      </span>
    </button>
  )
}
