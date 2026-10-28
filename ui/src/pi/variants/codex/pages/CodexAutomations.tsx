import { CalendarClock, Play, Plus } from "../icons/CodexIcons"
import type { VariantAppProps } from "@/pi/variants/types"
import { useState } from "react"
import { CodexAutomationDialog } from "../overlays/CodexAutomationDialog"
import { CodexBadge, CodexCapabilityBadge, CodexDisabledNote, CodexExtensionNotice } from "../primitives/CodexCapability"
import { useCodexCapability } from "../logic/capability"
import { CodexButton } from "../primitives/primitives"

type AutomationRow = { id: string; name: string; schedule: string; prompt: string; enabled: boolean; lastRun: string; nextRun: string }

const AUTOMATION_ROWS: AutomationRow[] = [
  { id: "a-daily", name: "每日测试失败汇总", schedule: "每个工作日 09:00", prompt: "汇总昨天的测试失败，按目录分组，给出优先修复建议。", enabled: true, lastRun: "今天 09:00", nextRun: "明天 09:00" },
  { id: "a-pr", name: "PR 变更预审", schedule: "PR 打开时", prompt: "读 PR 描述与改动，检查风险点并生成审查意见。", enabled: false, lastRun: "—", nextRun: "—" },
  { id: "a-release", name: "发布前检查清单", schedule: "每周五 17:00", prompt: "运行 lint / build / npm test，输出发布检查清单。", enabled: true, lastRun: "上周五 17:00", nextRun: "本周五 17:00" },
]

// TODO(P4 契约 task-18 / mock task-19)：本页数据为临时本地列表，契约合并后改由 @/pi/extensions 的 provider 注入（生产默认禁用）。
/** 自动化页（Wave1 全量 surface：Automations 完整 UI；Pi 无调度能力 → 默认禁用 + 「可接入」） */
export function CodexAutomations({ p }: { p: VariantAppProps }) {
  const cap = useCodexCapability("automations")
  const [ranAt, setRanAt] = useState<Record<string, string>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const providerRows: AutomationRow[] = (cap.data?.automations ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    schedule: row.trigger,
    prompt: row.description ?? "",
    enabled: row.enabled,
    lastRun: row.lastRunAt != null ? new Date(row.lastRunAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—",
    nextRun: "—",
  }))
  const rows = cap.interactive && providerRows.length > 0 ? providerRows : AUTOMATION_ROWS
  const explain = (what: string) => p.relay.notify(`本机 pi 未提供自动化能力（${what}）；接入扩展调度端后可用${cap.view ? `（见 ${cap.view.docsPath}）` : ""}`, "warn")
  return (
    <div className="cx-local-page" data-page="automations" data-pi-ui-part="page" data-p4-surface="CX-PAGE-05" data-capability-state={cap.status} data-p4-ready="">
      <header className="cx-local-head">
        <div className="cx-local-title">
          <CalendarClock aria-hidden size={16} strokeWidth={1.75} />
          <h1>计划任务</h1>
          <CodexCapabilityBadge view={cap.view} />
          {cap.simulated ? <CodexBadge tone="warn">模拟演示</CodexBadge> : null}
        </div>
        <p className="cx-local-sub">按计划或在事件上触发会话；需要计划任务扩展接入。</p>
        <div className="cx-local-toolbar">
          <span className="cx-local-count">{rows.length} 个自动化</span>
          <CodexButton kind="primary" title={!cap.interactive ? (cap.view?.reason ?? "本机 pi 未提供自动化能力") : "dev mock：打开新建向导"} data-p4-action="automation-create" data-capability-state={cap.status} data-pi-capability-disabled={!cap.interactive ? "" : undefined} onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden size={13} strokeWidth={2} />
            新建自动化
          </CodexButton>
        </div>
      </header>
      <div className="cx-local-scroll">
        <div className="cx-ext-notice-wrap">
          <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        </div>
        <ul className="cx-automation-list">
          {rows.map((row) => (
            <li className="cx-automation" key={row.id} data-enabled={row.enabled ? "" : undefined}>
              <div className="cx-automation-main">
                <div className="cx-automation-head">
                  <span className="cx-automation-name">{row.name}</span>
                  <CodexBadge tone={row.enabled ? "ok" : "neutral"}>{row.enabled ? "已启用" : "已暂停"}</CodexBadge>
                  <span className="cx-automation-schedule">{row.schedule}</span>
                </div>
                <p className="cx-automation-prompt">{row.prompt}</p>
                <div className="cx-automation-meta">
                  <span>上次：{ranAt[row.id] ?? row.lastRun}</span>
                  <span>下次：{row.nextRun}</span>
                </div>
              </div>
              <div className="cx-automation-actions">
                <CodexButton
                  kind="outline"
                  disabled={!cap.interactive}
                  title={!cap.interactive ? "本机 pi 未提供自动化能力；接入扩展后可用" : "dev mock：立即运行占位"}
                  data-p4-action="automation-run"
                  data-capability-state={cap.status}
                  data-pi-capability-disabled={!cap.interactive ? "" : undefined}
                  onClick={() => {
                    if (!cap.interactive) {
                      explain("立即运行")
                      return
                    }
                    cap.actions?.runNow?.(row.id)
                    setRanAt((cur) => ({ ...cur, [row.id]: "刚刚（模拟演示）" }))
                    p.relay.notify(`已触发（模拟演示）：${row.name}`)
                  }}
                >
                  <Play aria-hidden size={12} strokeWidth={1.75} />
                  运行一次
                </CodexButton>
              </div>
            </li>
          ))}
        </ul>
        <section className="cx-auto-queue" data-p4-surface="CX-SIDE-08" data-capability-state={cap.status} data-p4-ready="">
          <h2 className="cx-auto-queue-title">结果 review queue</h2>
          <p className="cx-auto-queue-note">自动化的运行结果不进线程列表，在这里集中审阅（provider 提供结果后可见）。</p>
          <ul className="cx-auto-queue-list">
            {rows.map((row) => (
              <li key={row.id} className="cx-auto-queue-row">
                <span className="cx-auto-queue-name">{row.name}</span>
                <span className="cx-auto-queue-result">{row.lastRun}</span>
              </li>
            ))}
            {rows.length === 0 ? <li className="cx-panel-empty-note">还没有自动化结果</li> : null}
          </ul>
        </section>
        <CodexDisabledNote>创建 / 编辑 / 删除自动化同样需要调度扩展；当前提供完整表单占位（Wave3 接契约后补）。</CodexDisabledNote>
      </div>
      {createOpen ? <CodexAutomationDialog p={p} onClose={() => setCreateOpen(false)} /> : null}
    </div>
  )
}
