import { useState } from "react"
import { useState as useLocalState } from "react"
import { Columns3, GripVertical, MoreHorizontal, Plus, X } from "lucide-react"
import { ClaudeMenu, ClaudeMenuItem } from "../primitives/ClaudePrimitives"
import type { PiContainerProps } from "@/pi/containers/types"
import { usePiUiCapabilities } from "@/pi/extensions"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"
import { ClaudeBadge, ClaudeButton, ClaudeIconButton } from "../primitives/ClaudePrimitives"

/**
 * Code（工作台）模式正文（台账 CL-CODE-02/03/05）。
 * - pane-workspace simulated：显示 mock 窗格列表，点 tab 切换窗格内容、可关闭（本地操作 + provider actions）；
 * - unavailable（生产）：显式禁用态（原因 + docsPath），不隐瞒；
 * - pane-dock-drag：拖拽/停靠能力单独门控，禁用态标注（simulated 时显示拖拽把手）。
 */
const PANE_KIND_LABEL: Record<string, string> = {
  changes: "Diff",
  files: "Files",
  terminal: "Terminal",
  browser: "Browser",
  plan: "Plan",
  "side-chat": "Side chat",
  custom: "Pane",
}

export function ClaudeCodePage({ p }: { p: PiContainerProps }) {
  const caps = usePiUiCapabilities()
  void p
  const paneStatus = caps.statusOf("pane-workspace")
  const paneData = caps.dataOf("pane-workspace")
  const paneDisabled = paneStatus === "unavailable" ? caps.disabledOf("pane-workspace") : null
  const dockStatus = caps.statusOf("pane-dock-drag")
  const dockDisabled = dockStatus === "unavailable" ? caps.disabledOf("pane-dock-drag") : null
  const [hidden, setHidden] = useState<string[]>([])
  const panes = [
    ...(paneData?.panes ?? []),
    { id: "claude-tasks-board", title: "Tasks 看板", kind: "custom" as const },
    { id: "claude-subagent-board", title: "Subagent 编排", kind: "custom" as const },
  ].filter((pane) => !hidden.includes(pane.id))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [dockSlot, setDockSlot] = useState("右")
  const [expanded, setExpanded] = useState(false)
  const active = panes.find((pane) => pane.id === activeId) ?? panes[0] ?? null
  const closePane = (id: string) => {
    setHidden((current) => [...current, id])
    caps.actionsOf("pane-workspace")?.closePane?.(id)
  }
  const focusPane = (id: string) => {
    setActiveId(id)
    caps.actionsOf("pane-workspace")?.focusPane?.(id)
  }
  return (
    <div className="claude-codepage" data-p4-surface="CL-CODE-02" data-p4-ready="" {...claudeCapabilityAttrs("pane-workspace", paneStatus)}>
      <section className="claude-codeopen-strip" data-p4-surface="CL-CODE-01" data-p4-ready="">
        <input className="claude-input" placeholder="说明要做的改动 / 粘贴文件路径，回车派活…" aria-label="Code 开局输入" data-p4-action="code-open-input" />
        <div className="claude-codeopen-chips">
          {[
            { id: "device", label: "当前设备" },
            { id: "folder", label: "选择文件夹…" },
            { id: "remote", label: "远端设备" },
            { id: "worktree", label: "隔离副本（worktree，需扩展）" },
          ].map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="claude-chip"
              data-p4-action="code-open-chip"
              data-p4-chip={chip.id}
              onClick={chip.id === "folder" ? () => p.act.newSession() : undefined}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </section>
      <header className="claude-codepage-head">
        <span className="claude-codepage-title">
          <Columns3 size={15} strokeWidth={1.75} aria-hidden />
          工作台
        </span>
        <span className="claude-codepage-sub">{paneStatus === "simulated" ? "模拟演示 · 非真实窗格数据" : paneStatus === "available" ? "已接入" : "未接入"}</span>
        <ClaudeMenu
          side="bottom"
          align="end"
          width={220}
          trigger={
            <button type="button" className="claude-icon-btn" aria-label="窗格开关" data-p4-surface="CL-CODE-06" data-p4-action="pane-menu">
              <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden />
            </button>
          }
        >
          {(paneData?.panes ?? []).map((pane) => (
            <ClaudeMenuItem key={pane.id} onClick={() => setHidden((current) => (current.includes(pane.id) ? current.filter((id) => id !== pane.id) : [...current, pane.id]))}>
              {hidden.includes(pane.id) ? "☐" : "☑"} {pane.title}
            </ClaudeMenuItem>
          ))}
        </ClaudeMenu>
        <span className="claude-codepage-dock" {...(dockDisabled ? claudeCapabilityAttrs("pane-dock-drag", dockStatus) : claudeCapabilityAttrs("pane-dock-drag", dockStatus))} data-p4-action="dock-hint">
          <GripVertical size={13} strokeWidth={1.75} aria-hidden />
          {dockDisabled ? "拖拽停靠未接入" : "可拖拽停靠"}
        </span>
      </header>
      {panes.length > 0 ? (
        <>
          <div className="claude-codepage-tabs" role="tablist" aria-label="窗格">
            {panes.map((pane) => (
              <button
                key={pane.id}
                type="button"
                role="tab"
                aria-selected={active?.id === pane.id}
                data-active={active?.id === pane.id ? "" : undefined}
                className="claude-codepage-tab"
                data-p4-action="pane-tab"
                data-p4-pane={pane.kind}
                onClick={() => focusPane(pane.id)}
              >
                {PANE_KIND_LABEL[pane.kind] ?? pane.title}
                {pane.kind === "changes" || pane.kind === "files" || pane.kind === "terminal" ? (
                  <span className="claude-plat-count">真实</span>
                ) : (
                  <span className="claude-plat-count" title="需要设备端/扩展 provider（browser/plan/subagent 等）">扩展</span>
                )}
                {pane.badge ? <ClaudeBadge>{pane.badge}</ClaudeBadge> : null}
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`关闭 ${pane.title}`}
                  className="claude-codepage-tab-x"
                  data-p4-action="pane-close"
                  onClick={(event) => {
                    event.stopPropagation()
                    closePane(pane.id)
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    event.stopPropagation()
                    closePane(pane.id)
                  }}
                >
                  <X size={11} strokeWidth={2.25} aria-hidden />
                </span>
              </button>
            ))}
            <ClaudeIconButton
              label="打开窗格"
              icon={<Plus size={13} strokeWidth={2} />}
              className="claude-iconbtn"
              data-p4-surface="CL-CODE-06" data-p4-action="pane-open"
              onClick={() => setHidden([])}
            />
          </div>
          <div className="claude-codepage-dockrow" data-p4-surface="CL-CODE-04" data-p4-ready="" {...claudeCapabilityAttrs("pane-dock-drag", dockStatus)}>
            {["左", "右", "下"].map((slot) => (
              <button key={slot} type="button" className="claude-chip" data-p4-action="dock-preset" onClick={() => setDockSlot(slot)}>
                应用内停靠 {slot}
              </button>
            ))}
            <button type="button" className="claude-chip" data-p4-surface="CL-CODE-05" data-p4-action="pane-expand" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "还原窗格" : "展开窗格"}
            </button>
            <span className="claude-codepage-statusitem">当前停靠：{dockSlot}</span>
          </div>
          <section className="claude-codepage-pane" data-p4-pane={active?.kind ?? "pane"} data-p4-surface={active?.kind === "side-chat" ? "CL-CODE-12" : active ? "CL-CODE-03" : undefined}>
            <header className="claude-codepage-pane-head">
              <span>{active?.title ?? "窗格"}</span>
              <span className="claude-codepage-pane-kind">{active ? PANE_KIND_LABEL[active.kind] : ""}</span>
            </header>
            {active?.kind === "browser" ? (
              <BrowserPaneBody />
            ) : active?.kind === "plan" ? (
              <PlanPaneBody />
            ) : active?.kind === "side-chat" ? (
              <SideChatPaneBody />
            ) : active?.title.includes("Task") ? (
              <TasksBoardBody />
            ) : active?.title.includes("Subagent") || active?.title.includes("Agent") ? (
              <SubagentPaneBody />
            ) : (
              <p className="claude-codepage-pane-body">
                {active ? `「${active.title}」窗格内容（${paneStatus === "simulated" ? "mock provider 数据 · 非真实" : "已接入"}）` : "没有打开的窗格。"}
              </p>
            )}
          </section>
        </>
      ) : paneDisabled ? (
        <div className="claude-codepage-disabled" data-p4-surface="CL-CODE-02">
          <p className="claude-codepage-disabled-title">{paneDisabled.title}</p>
          <p className="claude-codepage-disabled-body">
            {paneDisabled.reason}；接入后即可启用 → {paneDisabled.docsPath}
          </p>
          <p className="claude-codepage-disabled-hint">{paneDisabled.hint}</p>
        </div>
      ) : (
        <div className="claude-codeopen" data-p4-surface="CL-CODE-01" data-p4-ready="">
          <h2 className="claude-codeopen-title">从这里开始</h2>
          <div className="claude-codeopen-chips">
            {["当前设备", "选择文件夹…", "远端设备", "隔离副本（worktree，需扩展）"].map((chip) => (
              <button key={chip} type="button" className="claude-chip" data-p4-action="code-open-chip">{chip}</button>
            ))}
          </div>
          <textarea className="claude-codeopen-input" rows={3} placeholder="描述要做的改动，或粘贴一个文件路径…" aria-label="Code 开局 composer" data-p4-action="code-open-input" />
          <div className="claude-codeopen-suggestions">
            {["修一个失败测试", "解释这个目录", "补一份 README"].map((suggestion) => (
              <button key={suggestion} type="button" className="claude-chip" data-p4-action="code-open-suggestion">{suggestion}</button>
            ))}
          </div>
        </div>
      )}
      <SessionStatusRow />
    </div>
  )
}

/** CL-CODE-26/27：会话卡底部状态行（模型 + 改动统计 + Create PR 能力入口） */
function SessionStatusRow() {
  const caps = usePiUiCapabilities()
  const status = caps.statusOf("git-commit")
  const view = status === "unavailable" ? caps.disabledOf("git-commit") : null
  const [prReceipt, setPrReceipt] = useState<string | null>(null)
  const repoPath = caps.dataOf("git-commit")?.repos?.[0]?.repoPath ?? ""
  return (
    <footer className="claude-codepage-statusrow" data-p4-surface="CL-CODE-26" data-p4-ready="">
      <span className="claude-codepage-statusitem">审批策略：按会话审批（只读）</span>
      <span className="claude-codepage-statusitem">+12 −3</span>
      <span className="claude-codepage-statusitem">{status === "simulated" ? "模拟演示" : view ? "Create PR（未接入）" : "创建 PR"}</span>
      {prReceipt ? <span className="claude-codepage-statusitem" role="status" data-p4-receipt="">{prReceipt}</span> : null}
      <button
        type="button"
        className="claude-btn claude-btn-outline claude-btn-sm"
        data-p4-surface="CL-CODE-27"
        data-p4-action="create-pr"
        disabled={status === "unavailable"}
        {...claudeCapabilityAttrs("git-commit", status)}
        title={view ? `${view.title}：${view.reason}（${view.docsPath}）` : "创建 PR"}
        onClick={() => {
          caps.actionsOf("git-commit")?.createPr?.(repoPath)
          setPrReceipt(`已发起创建 PR（${repoPath || "当前会话目录"}；${status === "simulated" ? "模拟演示 · 非真实" : "已接入"}）`)
        }}
      >
        Create PR
      </button>
    </footer>
  )
}

/** CL-CODE-07：Tasks 看板（Running / Completed，mock 数据可操作） */
function TasksBoardBody() {
  const caps = usePiUiCapabilities()
  const tasks = caps.dataOf("background-tasks")?.tasks ?? []
  const running = tasks.filter((task) => task.status !== "done" && task.status !== "failed" && task.status !== "cancelled")
  const completed = tasks.filter((task) => task.status === "done" || task.status === "failed" || task.status === "cancelled")
  const row = (task: (typeof tasks)[number], canStop: boolean) => (
    <div key={task.id} className="claude-codepage-taskrow" data-p4-row="">
      <span className="claude-dot" data-dot={task.status === "running" ? "running" : task.status === "failed" ? "error" : "idle"} aria-hidden />
      <span className="claude-codepage-tasktitle">{task.title}</span>
      <ClaudeBadge>{task.status}</ClaudeBadge>
      {canStop ? (
        <ClaudeIconButton label={`停止 ${task.title}`} icon={<X size={12} strokeWidth={2.25} />} className="claude-iconbtn" data-p4-action="task-stop" onClick={() => caps.actionsOf("background-tasks")?.cancelTask?.(task.id)} />
      ) : null}
    </div>
  )
  return (
    <div className="claude-codepage-pane-body" data-p4-surface="CL-CODE-07">
      <p className="claude-codepage-pane-title">Running</p>
      {running.length === 0 ? <p className="claude-list-empty">没有运行中的任务。</p> : null}
      {running.map((task) => row(task, true))}
      <p className="claude-codepage-pane-title">Completed</p>
      {completed.length === 0 ? <p className="claude-list-empty">还没有完成的任务。</p> : null}
      {completed.map((task) => row(task, false))}
    </div>
  )
}

/** CL-CODE-25：Subagent 编排画布（unavailable 完整 UI + 只读 agents 列表） */
function SubagentPaneBody() {
  const caps = usePiUiCapabilities()
  const agents = caps.dataOf("subagents-panel")?.agents ?? []
  const status = caps.statusOf("subagent-orchestration")
  const view = status === "unavailable" ? caps.disabledOf("subagent-orchestration") : null
  return (
    <div className="claude-codepage-pane-body" data-p4-surface="CL-CODE-25" {...claudeCapabilityAttrs("subagent-orchestration", status)}>
      <p className="claude-codepage-pane-title">只读代理状态（subagents-panel）· 编排画布需多代理扩展</p>
      {agents.length === 0 ? <p className="claude-list-empty">没有子代理在跑。</p> : null}
      {agents.map((agent) => (
        <div key={agent.id} className="claude-codepage-taskrow" data-p4-row="">
          <span className="claude-dot" data-dot={agent.status === "running" ? "running" : agent.status === "failed" ? "error" : "idle"} aria-hidden />
          <span className="claude-codepage-tasktitle">{agent.name}</span>
          <span className="claude-codepage-statusitem">{agent.task ?? agent.status}</span>
        </div>
      ))}
      {view ? <p className="claude-dialog-hint">{view.title}：{view.reason}（{view.docsPath}）</p> : null}
    </div>
  )
}


/** CL-CODE Browser 窗格：mock tabs 切换 + URL 展示（actions.activateTab 优先） */
function BrowserPaneBody() {
  const caps = usePiUiCapabilities()
  const data = caps.dataOf("browser-pane")
  const [tabId, setTabId] = useLocalState<string | null>(null)
  const tabs = data?.tabs ?? []
  const active = tabs.find((tab) => tab.id === (tabId ?? data?.activeTabId)) ?? tabs[0] ?? null
  return (
    <div className="claude-codepage-pane-body" data-p4-surface="CL-CHAT-07">
      <div className="claude-codepage-tabs">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className="claude-codepage-tab"
            data-active={tab.id === active?.id ? "" : undefined}
            data-p4-action="browser-tab"
            onClick={() => {
              setTabId(tab.id)
              caps.actionsOf("browser-pane")?.activateTab?.(tab.id)
            }}
          >
            {tab.title}
          </button>
        ))}
      </div>
      {active ? <p className="claude-codepage-pane-url">{active.url}</p> : <p className="claude-list-empty">没有打开的页面。</p>}
    </div>
  )
}

/** CL-CODE Plan 窗格：mock 计划步骤，点步骤切换完成状态（updateStep actions 优先） */
function PlanPaneBody() {
  const caps = usePiUiCapabilities()
  const plan = caps.dataOf("plan-pane")?.plan
  const [steps, setSteps] = useLocalState(() => plan?.steps ?? [])
  const toggle = (id: string) => {
    const step = steps.find((item) => item.id === id)
    const next = step?.status === "completed" ? ("pending" as const) : ("completed" as const)
    setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: next } : item)))
    if (plan) caps.actionsOf("plan-pane")?.updateStep?.(plan.id, id, next)
  }
  return (
    <div className="claude-codepage-pane-body" data-p4-surface="CL-CODE-03">
      {plan ? <p className="claude-codepage-pane-title">{plan.title}</p> : null}
      {steps.map((step) => (
        <button key={step.id} type="button" className="claude-codepage-planstep" data-status={step.status} data-p4-action="plan-step" onClick={() => toggle(step.id)}>
          <span className="claude-progress-index" aria-hidden>{step.status === "completed" ? "✓" : ""}</span>
          {step.title}
        </button>
      ))}
      {steps.length === 0 ? <p className="claude-list-empty">还没有计划步骤。</p> : null}
    </div>
  )
}

/** CL-CODE Side chat 窗格：mock threads + 本地发送（sendMessage actions 优先） */
function SideChatPaneBody() {
  const caps = usePiUiCapabilities()
  const threads = caps.dataOf("side-chat")?.threads ?? []
  const thread = threads[0]
  const [draft, setDraft] = useLocalState("")
  const [sent, setSent] = useLocalState<string[]>([])
  const send = () => {
    const text = draft.trim()
    if (!text) return
    caps.actionsOf("side-chat")?.sendMessage?.(thread?.id ?? null, text)
    setSent((current) => [...current, text])
    setDraft("")
  }
  return (
    <div className="claude-codepage-pane-body" data-p4-surface="CL-CODE-12" data-p4-ready="">
      {thread?.messages.map((message) => (
        <p key={message.id} className="claude-codepage-sidemsg" data-role={message.role}>
          {message.text}
        </p>
      ))}
      {sent.map((text, index) => (
        <p key={`sent-${index}`} className="claude-codepage-sidemsg" data-role="user">
          {text}
        </p>
      ))}
      <div className="claude-approval-inputrow">
        <input className="claude-input" value={draft} placeholder="问点不影响主线程的问题…" data-p4-action="sidechat-input" onChange={(event) => setDraft(event.target.value)} />
        <ClaudeButton kind="outline" className="claude-btn-sm" disabled={!draft.trim()} data-p4-action="sidechat-send" onClick={send}>
          发送
        </ClaudeButton>
      </div>
    </div>
  )
}
