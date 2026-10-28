import { useMemo } from "react"
import { CircleHelp } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { subagentsOf } from "@/pi/model/transcriptView"
import { contextReadout } from "@/relay/contextUsage"

/** 46px 上下文环（[X-图11③]） */
export function EnvironmentRing({ percent }: { percent: number | null }) {
  const size = 46
  const r = (size - 5) / 2
  const c = 2 * Math.PI * r
  const f = percent == null ? 0 : Math.max(0, Math.min(1, percent))
  return (
    <span className="cx-env-ring" role="img" aria-label={percent == null ? "还没有上下文占用" : `上下文 ${Math.round(f * 100)}%`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="cx-ring-track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} />
        <circle className="cx-ring-fill" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} strokeLinecap="round" strokeDasharray={`${c * f} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <span className="cx-env-ring-text">{percent == null ? "—" : `${Math.round(f * 100)}%`}</span>
    </span>
  )
}

/** 子 agent / 任务面板（[X-图12] THREAD ACTIVITY + SUMMARY / X-11-6）：N working · M done、逐条状态、任务清单 */
export function CodexSubagentsPanel({ p }: { p: VariantAppProps }) {
  const { relay } = p
  const agents = useMemo(() => subagentsOf(relay.agentState), [relay.agentState])
  const tasks = relay.taskList
  const doneTasks = tasks.filter((t) => t.status === "completed").length
  const ctx = contextReadout(relay.usage?.contextUsage)
  return (
    <section className="cx-task-panel" aria-label="线程活动与任务" data-pi-ui-part="panel" data-p4-surface="CX-PANEL-09" data-p4-ready="">
      <header className="cx-task-panel-head">
        <CircleHelp aria-hidden size={14} strokeWidth={1.75} />
        <span className="cx-task-panel-title">线程活动</span>
        <span className="cx-task-panel-sum">
          {agents.length} 个运行中{tasks.length > 0 ? ` · 已完成 ${doneTasks}/${tasks.length}` : ""}
        </span>
        <EnvironmentRing percent={ctx.percent} />
      </header>
      <div className="cx-task-section-label">子 agent</div>
      {agents.length === 0 ? <p className="cx-task-empty">没有正在运行的子 agent</p> : null}
      <ul className="cx-env-agent-list">
        {agents.map((agent) => (
          <li className="cx-env-agent" key={`${agent.name}:${agent.startedAt}`}>
            <span className="cx-env-agent-dot" aria-hidden />
            <span className="cx-env-agent-text">{agent.name}</span>
            <span className="cx-env-agent-state">思考中</span>
          </li>
        ))}
      </ul>
      {tasks.length > 0 ? (
        <>
          <div className="cx-task-section-label">进度 · {doneTasks}/{tasks.length}</div>
          <ul className="cx-env-tasks">
            {tasks.map((task) => (
              <li className="cx-env-task" key={task.id} data-status={task.status}>
                <span className="cx-env-task-icon" aria-hidden>
                  {task.status === "completed" ? "✓" : task.status === "in_progress" ? "◐" : "○"}
                </span>
                <span className="cx-env-task-text">{task.status === "in_progress" && task.activeForm ? task.activeForm : task.content}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
