import type { PiContainerProps } from "@/pi/containers/types"
import { durationText } from "../model/format"

/**
 * 右栏「终端」面板（诚实数据）：显示 relay 的 terminalItems（工具命令事件派生的终端条目，只读）。
 * 产品没有网页侧可交互终端，这里只做只读日志视图，并写清事实。
 */
export function ClaudeTerminalPanel({ p }: { p: PiContainerProps }) {
  const items = p.relay.terminalItems ?? []
  return (
    <div className="claude-terminal-pane">
      <p className="claude-pane-caption">本会话的终端命令（只读；交互终端在电脑上）</p>
      {items.length === 0 ? <p className="claude-pane-empty">还没有终端命令</p> : null}
      {items.map((item, index) => (
        <div key={(item.id ?? "") + index} className="claude-terminal-entry" data-state={item.state}>
          <div className="claude-terminal-entry-head">
            <span className="claude-terminal-entry-command">{item.command || ""}</span>
            <span className="claude-terminal-entry-state">{item.state === "running" ? "运行中" : item.state === "succeeded" ? "完成" : item.state === "failed" ? "失败" : ""}</span>
          </div>
          {item.output ? <pre className="claude-terminal-entry-output">{item.output}</pre> : null}
          {item.durationMs != null ? <p className="claude-terminal-entry-meta">{durationText(item.durationMs)}</p> : null}
        </div>
      ))}
    </div>
  )
}
