import { memo, useState } from "react"
import type { Block } from "@/relay/transcript"
import { CircleCheck, SquareTerminal, AlertTriangle, Loader, Search, Monitor, Database } from "../icons/CodexIcons"
import { codexToolTone, codexToolView } from "../model/tool"
import { CodexCaret, CodexDiffRows } from "./CodexDiffCard"

function Status({ tone }: { tone: "running" | "ok" | "fail" | "muted" }) {
  if (tone === "running")
    return (
      <span className="cx-tool-status" data-tone="running">
        <Loader aria-hidden size={11} strokeWidth={2} /> 运行中
      </span>
    )
  if (tone === "ok")
    return (
      <span className="cx-tool-status" data-tone="ok">
        <CircleCheck aria-hidden size={11} strokeWidth={2} /> 成功
      </span>
    )
  if (tone === "fail")
    return (
      <span className="cx-tool-status" data-tone="fail">
        <AlertTriangle aria-hidden size={11} strokeWidth={2} /> 失败
      </span>
    )
  return <span className="cx-tool-status" data-tone="muted">已结束</span>
}

/**
 * 工具行/卡（[X-图7⑥]）：
 * - `Ran <cmd>` + exit 0：终端卡，输出可展开；
 * - `Edited <file> +26 −1`：diff 卡（行号 + 红绿 + N 行未改动）；
 * - 其它工具：一行状态 + 可展开的入参/输出。
 * 渲染全部自写，数据由 model/tool.ts（diff 解析复用 @/pi/model/diffRows）。
 */
export const CodexToolRow = memo(function CodexToolRow({ block }: { block: Extract<Block, { kind: "tool" }> }) {
  const view = codexToolView(block)
  const tone = codexToolTone(view)
  const [open, setOpen] = useState(view.running || (view.edit && view.rows != null))
  const added = view.rows?.filter((r) => r.kind === "add").length ?? 0
  const removed = view.rows?.filter((r) => r.kind === "del").length ?? 0
  if (view.terminal) {
    const output = [view.output, view.stderr].filter(Boolean).join("\n")
    return (
      <div className="cx-tool-card" data-tone={tone} data-pi-ui-part="thread">
        <button type="button" className="cx-tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <CodexCaret open={open} />
          <SquareTerminal aria-hidden size={13} strokeWidth={1.5} className="cx-tool-icon" />
          <span className="cx-tool-label">
            Ran <code>{view.commandText || view.name}</code>
          </span>
          <span className="cx-tool-trailing">
            {view.exitCode != null ? (
              <span className="cx-tool-exit" data-ok={view.exitCode === 0 ? "" : undefined}>
                exit {view.exitCode}
              </span>
            ) : null}
            {view.stateNote ? <span className="cx-tool-note">{view.stateNote}</span> : null}
        <Status tone={tone} />
          </span>
        </button>
        {open && output ? (
          <pre className="cx-terminal-output" data-failed={tone === "fail" ? "" : undefined}>
            {output}
          </pre>
        ) : null}
      </div>
    )
  }
  if (view.kind === "search" || view.kind === "browser" || view.kind === "mcp") {
    const Icon = view.kind === "search" ? Search : view.kind === "browser" ? Monitor : Database
    const label = view.kind === "search" ? "Searched" : view.kind === "browser" ? "Browsed" : "MCP tool"
    return (
      <div className="cx-tool-line" data-tone={tone} data-pi-ui-part="thread" data-p4-surface="CX-THREAD-03" data-p4-ready="">
        <button type="button" className="cx-tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-p4-action="toggle-tool">
          <CodexCaret open={open} />
          <Icon aria-hidden size={13} strokeWidth={1.5} className="cx-tool-icon" />
          <span className="cx-tool-label">
            {label} {view.queryText || view.commandText ? <code>{view.queryText || view.commandText}</code> : <span className="cx-tool-path">{view.name}</span>}
          </span>
          <span className="cx-tool-trailing">
            {view.stateNote ? <span className="cx-tool-note">{view.stateNote}</span> : null}
        <Status tone={tone} />
          </span>
        </button>
        {open && (view.output || view.errorText) ? <pre className="cx-tool-detail">{view.output || view.errorText}</pre> : null}
      </div>
    )
  }
  if (view.edit && view.rows) {
    return (
      <div className="cx-tool-card cx-tool-edit" data-tone={tone} data-pi-ui-part="thread">
        <button type="button" className="cx-tool-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <CodexCaret open={open} />
          <span className="cx-tool-label">
            Edited <span className="cx-tool-path">{view.pathText ?? view.name}</span>
          </span>
          <span className="cx-tool-trailing">
            <span className="cx-add">+{added}</span> <span className="cx-del">−{removed}</span>
            {view.stateNote ? <span className="cx-tool-note">{view.stateNote}</span> : null}
        <Status tone={tone} />
          </span>
        </button>
        {open ? <CodexDiffRows rows={view.rows} /> : null}
        {view.patchTruncated ? <p className="cx-tool-note">改动太长，只显示前面一段，计数只是下限</p> : null}
      </div>
    )
  }
  const detail = [block.argsText, block.outputText, block.errorText].filter((s) => s && s.trim()).join("\n\n")
  return (
    <div className="cx-tool-line" data-tone={tone} data-pi-ui-part="thread">
      <button type="button" className="cx-tool-head cx-tool-head-line" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <CodexCaret open={open} />
        <span className="cx-tool-label">
          {view.name}
          {view.pathText ? <span className="cx-tool-path"> {view.pathText}</span> : null}
          {view.commandText && !view.pathText ? <code> {view.commandText}</code> : null}
        </span>
        {view.stateNote ? <span className="cx-tool-note">{view.stateNote}</span> : null}
        <Status tone={tone} />
      </button>
      {open && detail ? <pre className="cx-tool-detail">{detail}</pre> : null}
    </div>
  )
})

/** 任务清单（todo 工具提升出来的清单；[X-图11①] Progress 同族） */
export const CodexTaskList = memo(function CodexTaskList({ tasks }: { tasks: NonNullable<Extract<Block, { kind: "tool" }>["tasks"]> }) {
  return (
    <ul className="cx-task-list" data-pi-ui-part="thread">
      {tasks.map((task) => (
        <li key={task.id} data-status={task.status}>
          <span className="cx-task-mark" aria-hidden>
            {task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○"}
          </span>
          {task.content}
        </li>
      ))}
    </ul>
  )
})
