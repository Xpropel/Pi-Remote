import { useState } from "react"
import { Check, ChevronDown, FolderOpen, Plus, Sparkles, Trash2 } from "lucide-react"
import type { PiContainerProps } from "@/pi/containers/types"
import { usePiUiCapabilities } from "@/pi/extensions"
import { claudeCapabilityAttrs } from "../model/capabilityAttrs"
import { ClaudeBadge, ClaudeIconButton } from "../primitives/ClaudePrimitives"
import { sessionHeadOf } from "../model/view"
import { setClaudeWorkspaceMode } from "../model/uiMemory"

/**
 * Cowork（任务）模式正文（台账 CL-COWORK-01/02/05/06）。
 * - 首页：闪电 + 衬线标题 + 建议卡（点卡把模板填进 composer 并切回会话模式）
 * - 任务会话骨架：文件夹 chip（当前会话 cwd）+ Progress 编号步骤卡
 * - Progress 卡：Pi `taskList`/契约 plan-pane 数据；增删/勾选步骤 = capability `plan-pane`（S 面，simulated 可操作），
 *   生产无 provider 时只读 + 禁用态说明（docsPath）。
 */
const TEMPLATES = [
  { title: "整理这个文件夹", prompt: "先扫一遍这个目录，列出可以清理/归档的文件和理由。" },
  { title: "写一份改动说明", prompt: "把当前分支相对主干的改动整理成一段发布说明。" },
  { title: "跑测试并修失败", prompt: "跑项目的测试命令，失败的话逐个定位并修复。" },
  { title: "生成每周摘要", prompt: "按会话和提交记录生成这一周的进展摘要。" },
  { title: "检查依赖风险", prompt: "检查依赖版本与已知风险，列出需要升级的包。" },
  { title: "补一轮文档", prompt: "给最近改动的模块补 README 与用法示例。" },
]

export function ClaudeCoworkPage({ p }: { p: PiContainerProps }) {
  const { relay } = p
  const caps = usePiUiCapabilities()
  const head = sessionHeadOf(relay)
  const plan = caps.dataOf("plan-pane")?.plan
  const planStatus = caps.statusOf("plan-pane")
  const planDisabled = planStatus === "unavailable" ? caps.disabledOf("plan-pane") : null
  const [steps, setSteps] = useState(() => plan?.steps ?? [])
  const [collapsed, setCollapsed] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [clarify, setClarify] = useState<string | null>(null)
  const editable = !!plan
  const toggleStep = (id: string) => {
    const step = steps.find((item) => item.id === id)
    const next = step?.status === "completed" ? ("pending" as const) : ("completed" as const)
    setSteps((current) => current.map((item) => (item.id === id ? { ...item, status: next } : item)))
    if (plan) caps.actionsOf("plan-pane")?.updateStep?.(plan.id, id, next)
  }
  const addStep = () => {
    const id = `step-local-${steps.length + 1}`
    setSteps((current) => [...current, { id, title: "新步骤（模拟演示）", status: "pending" as const }])
    setReceipt("已插入一个步骤（模拟演示 · 非真实）")
  }
  const removeStep = (id: string) => {
    setSteps((current) => current.filter((step) => step.id !== id))
    setReceipt("已删除一个步骤（模拟演示 · 非真实）")
  }
  const applyTemplate = (prompt: string) => {
    relay.setDraft(prompt)
    setClaudeWorkspaceMode("chat")
  }
  return (
    <div className="claude-cowork" data-p4-surface="CL-COWORK-01" data-p4-ready="">
      <header className="claude-cowork-hero">
        <p className="claude-cowork-eyebrow">
          <Sparkles size={14} strokeWidth={1.75} aria-hidden />
          任务 · 本机 pi 会话
        </p>
        <h1 className="claude-cowork-title">把任务交给这台设备上的 pi</h1>
        <p className="claude-cowork-sub">选一个文件夹作为工作目录，写清要做的事；pi 的产出会写回这里。</p>
      </header>
      <div className="claude-cowork-actions">
        <button type="button" className="claude-chip" data-p4-surface="CL-COWORK-03" data-p4-action="connect-folder" onClick={() => setClaudeWorkspaceMode("chat")}>
          <FolderOpen size={13} strokeWidth={1.75} aria-hidden />
          {head.cwd ? "更换文件夹…" : "连接文件夹…"}
        </button>
        <button type="button" className="claude-chip" data-p4-surface="CL-COWORK-08" data-p4-action="open-browser" title="设备端浏览器工具：需要设备端扩展；当前无 provider" onClick={() => setClaudeWorkspaceMode("code")}>
          设备端浏览器（需扩展）
        </button>
      </div>
      <section className="claude-cowork-outputs" data-p4-surface="CL-COWORK-07" data-p4-ready="" {...claudeCapabilityAttrs("artifacts", caps.statusOf("artifacts"))}>
        <h2 className="claude-card-title">产出物</h2>
        {(caps.dataOf("artifacts")?.artifacts ?? []).slice(0, 4).map((artifact) => (
          <p key={artifact.id} className="claude-list-row" data-p4-row="">
            <span className="claude-row-label">{artifact.title}</span>
            <ClaudeBadge>{artifact.kind}</ClaudeBadge>
          </p>
        ))}
        {(caps.dataOf("artifacts")?.artifacts ?? []).length === 0 ? (
          <p className="claude-list-empty">{caps.statusOf("artifacts") === "unavailable" ? "本机 pi 未提供产出物数据（DOC/74 #cap-artifacts）；deck 预览需扩展产物能力" : "还没有产出物。"}</p>
        ) : null}
      </section>
      {head.cwd ? (
        <div className="claude-cowork-folder" data-p4-surface="CL-COWORK-02" data-p4-action="connect-folder">
          <FolderOpen size={15} strokeWidth={1.75} aria-hidden />
          <span className="claude-cowork-folder-path">{head.cwd}</span>
          <ClaudeBadge>已连接</ClaudeBadge>
        </div>
      ) : null}
      <div className="claude-cowork-templates">
        {TEMPLATES.map((template) => (
          <button key={template.title} type="button" className="claude-cowork-template" data-p4-action="use-template" onClick={() => applyTemplate(template.prompt)}>
            <span className="claude-cowork-template-title">{template.title}</span>
            <span className="claude-cowork-template-desc">{template.prompt}</span>
          </button>
        ))}
      </div>
      <section className="claude-progress-card" data-p4-surface="CL-COWORK-05" {...claudeCapabilityAttrs("plan-pane", planStatus)}>
        <header className="claude-progress-head">
          <button type="button" className="claude-progress-toggle" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed} data-p4-action="toggle-progress">
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden data-rotated={collapsed ? "" : undefined} />
            Progress
            <span className="claude-progress-count">可编辑计划（plan-pane 扩展） · {steps.filter((step) => step.status === "completed").length}/{steps.length}</span>
          </button>
          {editable ? (
            <ClaudeIconButton label="插入步骤" icon={<Plus size={14} strokeWidth={2} />} className="claude-iconbtn" data-p4-action="add-step" onClick={addStep} />
          ) : null}
        </header>
        {collapsed ? null : (
          <ol className="claude-progress-list">
            {steps.map((step, index) => (
              <li key={step.id} className="claude-progress-step" data-status={step.status} data-p4-row="">
                <button type="button" className="claude-progress-step-main" disabled={!editable} data-p4-action="toggle-step" onClick={() => toggleStep(step.id)}>
                  <span className="claude-progress-index">{step.status === "completed" ? <Check size={12} strokeWidth={2.5} aria-hidden /> : index + 1}</span>
                  <span className="claude-progress-title">{step.title}</span>
                </button>
                {editable ? (
                  <ClaudeIconButton label="删除步骤" icon={<Trash2 size={13} strokeWidth={1.75} />} className="claude-iconbtn" data-p4-action="remove-step" onClick={() => removeStep(step.id)} />
                ) : null}
              </li>
            ))}
            {steps.length === 0 ? <li className="claude-list-empty">pi 还没给出计划步骤。</li> : null}
          </ol>
        )}
        {receipt ? <p className="claude-progress-receipt" role="status">{receipt}</p> : null}
        {planDisabled ? (
          <p className="claude-progress-note">
            只读步骤来自 pi `task_list_state`；可编辑计划/插话改计划需要 plan-pane 扩展（{planDisabled.docsPath}）。普通插话 = 插入当前回合（steer），不会改计划。
          </p>
        ) : null}
      </section>
      <section className="claude-progress-card" data-p4-surface="CL-COWORK-04" data-p4-ready="" {...claudeCapabilityAttrs("work-mode", caps.statusOf("work-mode"))}>
        <h2 className="claude-card-title">需要你澄清一下</h2>
        <p className="claude-card-sub">先扫一遍这个目录，列出可以清理的文件和理由。</p>
        <div className="claude-segment claude-segment-sm" role="radiogroup" aria-label="澄清选项">
          {[
            { id: "summary", label: "快速摘要" },
            { id: "detailed", label: "详细说明" },
            { id: "actions", label: "只要行动项" },
          ].map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={clarify === option.id}
              data-active={clarify === option.id ? "" : undefined}
              className="claude-segment-item"
              data-p4-action="clarify-option"
              onClick={() => {
                setClarify(option.id)
                setReceipt(`已选择「${option.label}」（模拟演示 · 非真实）`)
              }}
            >
              {index + 1}. {option.label}
            </button>
          ))}
        </div>
      </section>
      <p className="claude-cowork-status" data-p4-surface="CL-COWORK-06">
        <span className="claude-breath-dot" aria-hidden /> Building plan…（{planStatus === "simulated" ? "模拟演示 · 非真实" : "只读"})
      </p>
    </div>
  )
}
