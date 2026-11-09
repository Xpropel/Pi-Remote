import { useState } from "react"
import type { ScheduleCreateInput } from "@/relay/schedule"

/**
 * Schedule creation form for the claude shell, mirroring the standard
 * PiQueuePanel's ScheduleCreateForm (same fields, same validation, same
 * payload). That form is not exported from PiQueuePanel, so the claude
 * variant carries this minimal copy styled with claude classes instead of
 * importing the standard panel wholesale. The segment is not chosen here:
 * it follows the composer's current delivery mode, shown read-only.
 */

const INTERVAL_CHIPS = [5, 10, 20, 30, 60]

/** Local-time string for a datetime-local input (YYYY-MM-DDTHH:mm). */
function toLocalInputValue(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ClaudeScheduleForm({
  segment,
  onCreate,
  onClose,
}: {
  segment: "steer" | "follow_up"
  onCreate: (input: ScheduleCreateInput) => Promise<unknown>
  onClose: () => void
}) {
  const [text, setText] = useState("")
  const [kind, setKind] = useState<"once" | "every">("once")
  const [when, setWhen] = useState(() => toLocalInputValue(Date.now() + 10 * 60 * 1000))
  const [minutes, setMinutes] = useState(20)
  const [customMinutes, setCustomMinutes] = useState("")
  const [maxFires, setMaxFires] = useState("")
  const [expireHours, setExpireHours] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = () => {
    if (saving) return
    const body = text.trim()
    if (!body) {
      setError("先写要定时发送的内容")
      return
    }
    const input: ScheduleCreateInput = { text: body, segment, kind }
    if (kind === "once") {
      const at = new Date(when).getTime()
      if (!Number.isFinite(at) || at <= Date.now()) {
        setError("目标时刻要选在未来")
        return
      }
      input.at = at
    } else {
      const m = customMinutes.trim() ? Number(customMinutes) : minutes
      if (!Number.isFinite(m) || m < 1) {
        setError("间隔至少 1 分钟")
        return
      }
      input.intervalMs = Math.round(m) * 60000
    }
    if (maxFires.trim()) {
      const n = Number(maxFires)
      if (!Number.isSafeInteger(n) || n < 1) {
        setError("触发上限要是正整数")
        return
      }
      input.maxFires = n
    }
    if (expireHours.trim()) {
      const h = Number(expireHours)
      if (!Number.isFinite(h) || h <= 0) {
        setError("到期小时数要大于 0")
        return
      }
      input.expireAt = Date.now() + h * 60 * 60 * 1000
    }
    setSaving(true)
    setError(null)
    onCreate(input).then(
      () => onClose(),
      (e: unknown) => {
        setSaving(false)
        setError(e instanceof Error && e.message ? e.message : "创建失败，请重试")
      },
    )
  }

  return (
    <div className="claude-schedule-form" data-slot="claude-schedule-form">
      <textarea
        className="claude-textarea claude-schedule-textarea"
        aria-label="定时发送的内容"
        rows={2}
        value={text}
        maxLength={100000}
        placeholder="到时要发送的消息"
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <div className="claude-schedule-row">
        <div className="claude-thinking-seg claude-schedule-seg">
          <button type="button" className="claude-thinking-seg-item" data-active={kind === "once" ? "" : undefined} onClick={() => setKind("once")}>
            一次
          </button>
          <button type="button" className="claude-thinking-seg-item" data-active={kind === "every" ? "" : undefined} onClick={() => setKind("every")}>
            每隔一段时间
          </button>
        </div>
        <span className="claude-queue-status">{segment === "follow_up" ? "回合结束后发送" : "插入当前回合"}</span>
      </div>
      {kind === "once" ? (
        <input type="datetime-local" aria-label="目标时刻" value={when} onChange={(event) => setWhen(event.currentTarget.value)} className="claude-input" />
      ) : (
        <>
          <div className="claude-schedule-row">
            {INTERVAL_CHIPS.map((m) => (
              <button
                key={m}
                type="button"
                className="claude-thinking-seg-item"
                data-active={!customMinutes.trim() && minutes === m ? "" : undefined}
                onClick={() => {
                  setMinutes(m)
                  setCustomMinutes("")
                }}
              >
                {m} 分钟
              </button>
            ))}
            <input aria-label="自定义间隔（分钟）" inputMode="numeric" placeholder="自定义分钟" value={customMinutes} onChange={(event) => setCustomMinutes(event.currentTarget.value)} className="claude-input claude-schedule-input-sm" />
          </div>
          <span className="claude-queue-status">每次触发都是一次真实发送，会消耗模型额度。</span>
        </>
      )}
      <div className="claude-schedule-row">
        <label className="claude-schedule-field">
          <span className="claude-queue-status">最多触发</span>
          <input aria-label="最多触发次数" inputMode="numeric" placeholder="不限" value={maxFires} onChange={(event) => setMaxFires(event.currentTarget.value)} className="claude-input claude-schedule-input-sm" />
        </label>
        <label className="claude-schedule-field">
          <span className="claude-queue-status">到期（小时）</span>
          <input aria-label="到期小时数" inputMode="numeric" placeholder="24" value={expireHours} onChange={(event) => setExpireHours(event.currentTarget.value)} className="claude-input claude-schedule-input-sm" />
        </label>
      </div>
      {error ? (
        <span role="alert" className="claude-schedule-error">
          {error}
        </span>
      ) : null}
      <div className="claude-schedule-actions">
        <button type="button" className="claude-link-btn" disabled={saving} onClick={submit}>
          {saving ? "创建中…" : "创建定时"}
        </button>
        <button type="button" className="claude-link-btn" disabled={saving} onClick={onClose}>
          收起
        </button>
      </div>
    </div>
  )
}
