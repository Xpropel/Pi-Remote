import { useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { useCodexCapability } from "../logic/capability"
import { CodexButton, CodexDialog } from "../primitives/primitives"
import { CodexExtensionNotice } from "../primitives/CodexCapability"

const WEEK = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"]

/**
 * Create automation 弹窗（CX-DLG-03 / [X-图5]）：Name / Workspaces chip / Prompt / Schedule（时间 + Mo–Su 圆钮）/ Create。
 * 能力 `automations`：生产禁用 + 契约说明；契约目前只暴露 runNow/toggle（无 create），模拟态 Create 也显式解释契约缺口。
 */
export function CodexAutomationDialog({ p, onClose }: { p: VariantAppProps; onClose: () => void }) {
  const cap = useCodexCapability("automations")
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [time, setTime] = useState("09:00")
  const [days, setDays] = useState<Set<string>>(() => new Set(["Mo", "Tu", "We", "Th", "Fr"]))
  const disabled = !cap.interactive
  const canCreate = !disabled && name.trim().length > 0 && prompt.trim().length > 0
  return (
    <CodexDialog
      title="新建自动化"
      onClose={onClose}
      width={520}
      footer={
        <>
          <CodexButton kind="outline" onClick={onClose}>
            取消
          </CodexButton>
          <CodexButton
            kind="primary"
            disabled={!canCreate}
            data-p4-action="automation-create"
            title={cap.view?.reason}
            onClick={() => {
              if (!canCreate) return
              p.relay.notify("计划任务创建需要扩展接入；当前只支持启停与运行已有任务", "warn")
            }}
          >
            创建
          </CodexButton>
        </>
      }
    >
      <div data-p4-surface="CX-DLG-03" data-capability-state={cap.status} data-p4-ready="">
        <CodexExtensionNotice view={cap.view} mock={cap.simulated} />
        <label className="cx-field">
          <span className="cx-field-label">Name</span>
          <input className="cx-field-input" value={name} placeholder="例如：每日测试失败汇总" onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="cx-field">
          <span className="cx-field-label">Workspaces</span>
          <span className="cx-automation-workspaces">
            <span className="cx-pill">当前设备</span>
            <span className="cx-pill">pi-remote</span>
            <button type="button" className="cx-pill cx-pill-add" disabled>
              +
            </button>
          </span>
        </label>
        <label className="cx-field">
          <span className="cx-field-label">Prompt</span>
          <textarea className="cx-field-input cx-automation-prompt" rows={3} value={prompt} placeholder="自动化运行时发给会话的提示…" onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <div className="cx-field">
          <span className="cx-field-label">Schedule</span>
          <div className="cx-automation-schedule">
            <input className="cx-field-input cx-automation-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} aria-label="触发时间" />
            <div className="cx-automation-days" role="group" aria-label="星期">
              {WEEK.map((day) => (
                <button
                  key={day}
                  type="button"
                  className="cx-automation-day"
                  data-active={days.has(day) ? "" : undefined}
                  aria-pressed={days.has(day)}
                  onClick={() =>
                    setDays((cur) => {
                      const next = new Set(cur)
                      if (next.has(day)) next.delete(day)
                      else next.add(day)
                      return next
                    })
                  }
                >
                  {day}
                </button>
              ))}
            </div>
          </div>
          <p className="cx-field-hint">时间与星期会随计划任务一起保存（接入扩展后生效）。</p>
        </div>
      </div>
    </CodexDialog>
  )
}
