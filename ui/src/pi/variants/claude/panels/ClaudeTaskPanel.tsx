import type { PiContainerProps } from "@/pi/containers/types"

/**
 * 任务面板（C-11 任务卡 / §1.8 Progress 语义）：relay.taskList 的只读清单（进行中 / 待办 / 完成）。
 * 产品口径：任务清单整帧来自扩展，不经前端加工。
 */
export function ClaudeTaskPanel({ p }: { p: PiContainerProps }) {
  const tasks = p.relay.taskList ?? []
  const done = tasks.filter((t) => t.status === "completed").length
  return (
    <div className="claude-taskpanel">
      <div className="claude-taskpanel-head">
        <span className="claude-card-title">任务</span>
        <span className="claude-taskcard-count">
          {done}/{tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? <p className="claude-pane-empty">没有任务清单</p> : null}
      <ul className="claude-taskcard-list">
        {tasks.map((task) => (
          <li key={task.id} data-status={task.status}>
            <span aria-hidden className="claude-taskcard-dot" />
            <span className={task.status === "completed" ? "claude-taskcard-done" : undefined}>{task.status === "in_progress" && task.activeForm ? task.activeForm : task.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
