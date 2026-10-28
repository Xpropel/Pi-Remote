import { CodexSpinner } from "../primitives/primitives"

/** 流式尾巴：按块追加（不逐字），尾光标 + 运行行「Working for Ns」 */
export function CodexStreamCaret({ live }: { live: boolean }) {
  if (!live) return null
  return <span className="cx-stream-caret" aria-hidden />
}

export function CodexRunningLine({ elapsed }: { elapsed?: string }) {
  return (
    <div className="cx-running-line" role="status" data-p4-surface="CX-THREAD-09" data-p4-ready="">
      <CodexSpinner size={12} />
      <span>Working{elapsed ? ` for ${elapsed}` : "…"}</span>
    </div>
  )
}

/** 子 agent 行（[X-图12] Thread activity 的对话流内一行） */
export function CodexSubagentRows({ agents }: { agents: readonly { name: string; task: string; startedAt: number }[] }) {
  if (agents.length === 0) return null
  return (
    <div className="cx-subagent-rows" data-pi-ui-part="thread">
      {agents.map((agent) => (
        <div className="cx-subagent-row" key={`${agent.name}:${agent.startedAt}`}>
          <span className="cx-subagent-dot" aria-hidden />
          <span className="cx-subagent-name">{agent.name}</span>
          <span className="cx-subagent-task">{agent.task}</span>
        </div>
      ))}
    </div>
  )
}
