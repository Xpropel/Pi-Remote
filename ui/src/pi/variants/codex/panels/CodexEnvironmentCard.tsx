import { useMemo } from "react"
import { Database, Folder, GitBranch, GitCommitHorizontal, Settings2 } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { changesViewOf } from "@/pi/model/changesView"
import { gitBranchOf, gitBranchText } from "@/pi/model/sessionInfo"
import { contextReadout } from "@/relay/contextUsage"
import { useCodexCommand } from "../hooks/useCodex"
import { useCodexCapability } from "../logic/capability"
import { CircleCheck, CircleHelp, GitPullRequest, Loader } from "../icons/CodexIcons"
import { subagentsOf } from "@/pi/model/transcriptView"
import { commandsReady } from "../logic/view"
import { EnvironmentRing } from "./CodexSubagentsPanel"

/** Environment 式状态卡（[X-图11①] / X-11-5）：Changes / Local / Branch / Commit or push / Sources / Progress + 46px 上下文环 */
export function CodexEnvironmentCard({ p, onOpenPanel }: { p: VariantAppProps; onOpenPanel: () => void }) {
  const { relay } = p
  const prCap = useCodexCapability("pr-review")
  const gitCap = useCodexCapability("git-commit")
  const subagents = useMemo(() => subagentsOf(relay.agentState), [relay.agentState])
  const items = relay.roomId ? relay.transcript.items : EMPTY
  const changes = useMemo(() => changesViewOf(items), [items])
  const branchRes = useCodexCommand(relay.runCommand, commandsReady(relay) ? "get_git_branch" : null, undefined, relay.roomId)
  const branch = branchRes.phase === "ready" ? gitBranchText(gitBranchOf(branchRes.data)) : null
  const tasks = relay.taskList
  const done = tasks.filter((t) => t.status === "completed").length
  const ctx = contextReadout(relay.usage?.contextUsage)
  const device = relay.selectedDevice
  const total = changes ? { added: changes.added, removed: changes.removed } : { added: 0, removed: 0 }
  return (
    <section className="cx-env" data-pi-ui-part="statusline" aria-label="Environment" data-p4-surface="CX-PANEL-08" data-p4-ready="">
      <header className="cx-env-head">
        <span className="cx-env-title">环境</span>
        <button type="button" className="cx-env-gear" onClick={onOpenPanel} aria-label="打开审查面板">
          <Settings2 aria-hidden size={13} strokeWidth={1.5} />
        </button>
      </header>
      <div className="cx-env-row cx-env-row-static">
        <GitCommitHorizontal aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" />
        <span className="cx-env-label">改动</span>
        <span className="cx-env-value">
          <span className="cx-add">+{total.added}</span>
          <span className="cx-del">−{total.removed}</span>
        </span>
      </div>
      <div className="cx-env-row cx-env-row-static">
        <Folder aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" />
        <span className="cx-env-label">当前设备</span>
        <span className="cx-env-value cx-env-value-muted">{device ? `${device.name}${device.platform ? ` · ${device.platform}` : ""}` : "本机"}</span>
      </div>
      {branch ? (
        <div className="cx-env-row cx-env-row-static">
          <GitBranch aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" />
          <span className="cx-env-label">分支</span>
          <span className="cx-env-value cx-env-value-muted">{branch}</span>
        </div>
      ) : null}
      <button
        type="button"
        className="cx-env-row cx-env-action"
        data-p4-action="env-commit"
        data-capability-state={gitCap.status}
        data-pi-capability-disabled={gitCap.interactive ? undefined : ""}
        title={gitCap.interactive ? "在设备上提交（扩展）" : "提交与推送（需扩展）"}
        onClick={() => relay.notify(gitCap.interactive ? "已交给扩展提交（模拟演示）" : `提交与推送：${gitCap.view?.reason ?? "需要扩展接入"}${gitCap.view ? `（见 ${gitCap.view.docsPath}）` : ""}`, "warn")}
      >
        <GitCommitHorizontal aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" />
        <span className="cx-env-label">提交与推送（需扩展）</span>
      </button>
      <button
        type="button"
        className="cx-env-row cx-env-action"
        data-p4-action="env-pr-status"
        data-capability-state={prCap.status}
        data-pi-capability-disabled={prCap.interactive ? undefined : ""}
        title={prCap.interactive ? "PR 状态（扩展）" : "PR 状态（需扩展）"}
        onClick={() => relay.notify(prCap.interactive ? "已打开 PR 面板（simulated）" : `PR status：${prCap.view?.reason ?? "本机 pi 未提供 PR 能力"}${prCap.view ? `（见 ${prCap.view.docsPath}）` : ""}`, "warn")}
      >
        <GitPullRequest aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" />
        <span className="cx-env-label">PR 状态（需扩展）</span>
        <span className="cx-env-value cx-env-value-muted">{prCap.interactive ? "已接入" : "未接入"}</span>
      </button>
      <div className="cx-env-row cx-env-row-static">
        <Database aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" />
        <span className="cx-env-label">来源</span>
        <span className="cx-env-value cx-env-value-muted"><CircleCheck aria-hidden size={11} strokeWidth={1.75} /> 会话记录 · 终端</span>
      </div>
      <button type="button" className="cx-env-row cx-env-action" data-p4-surface="CX-PANEL-09" data-p4-action="env-subagents" data-capability-state="available" onClick={onOpenPanel}>
        {subagents.length > 0 ? <Loader aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" /> : <CircleHelp aria-hidden size={14} strokeWidth={1.5} className="cx-env-icon" />}
        <span className="cx-env-label">子 agent</span>
        <span className="cx-env-value cx-env-value-muted">{subagents.length > 0 ? `${subagents.length} 个活跃` : "无活跃"}</span>
      </button>
      <div className="cx-env-divider" aria-hidden />
      <div className="cx-env-progress-head">
        <span className="cx-env-title">进度</span>
        <span className="cx-env-progress-count">{tasks.length > 0 ? `${done}/${tasks.length}` : "—"}</span>
        <EnvironmentRing percent={ctx.percent} />
      </div>
      {tasks.length > 0 ? (
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
      ) : null}
    </section>
  )
}

const EMPTY: never[] = []
