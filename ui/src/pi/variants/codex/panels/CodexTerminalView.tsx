import { useState } from "react"
import { SquareTerminal } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { CodexCentered } from "../primitives/primitives"

/** 终端输出视图（[X-图2④] / X-11：本会话命令；输出折叠；行号开关留待打磨） */
export function CodexTerminalView({ p }: { p: VariantAppProps }) {
  const terminals = p.relay.terminalItems
  const [openId, setOpenId] = useState<string | null>(terminals.find((t) => t.state === "running")?.id ?? terminals[0]?.id ?? null)
  if (terminals.length === 0) return <CodexCentered title="这个会话还没有运行命令" body="结束的命令保留 30 秒（失败 60 秒）后移出" />
  return (
    <div className="cx-terminal-view">
      <div className="cx-terminal-view-head">本会话 {terminals.length} 条命令 · {terminals.filter((t) => t.state === "running").length} 条在运行</div>
      {terminals.map((terminal) => (
        <div className="cx-terminal-card" key={terminal.id} data-state={terminal.state}>
          <button type="button" className="cx-tool-head" onClick={() => setOpenId(openId === terminal.id ? null : terminal.id)} aria-expanded={openId === terminal.id}>
            <SquareTerminal aria-hidden size={13} strokeWidth={1.5} className="cx-tool-icon" />
            <span className="cx-tool-label">Ran {terminal.command}</span>
            <span className="cx-tool-status">{terminal.state === "running" ? "运行中" : terminal.exitCode != null ? `exit ${terminal.exitCode}` : "已结束"}</span>
          </button>
          {openId === terminal.id ? <pre className="cx-terminal-output">{terminal.output || terminal.stderr || ""}</pre> : null}
        </div>
      ))}
    </div>
  )
}
