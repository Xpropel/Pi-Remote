/**
 * 设置 › 写桥反馈（桌面 / 手机共用文案与结构，样式沿用各自的 note 类）。
 *
 * 成功：`已保存，重启 pi 后生效`，`reloadHint` 放在可展开的「说明」里；
 * 失败：回滚由 useSettingsWriter 负责，这里只负责如实显示原因（需更新扩展 / 需设备在线 / 未写入）。
 * 无反馈但 overlay 还有待重启键时，显示常驻说明（不是只读）。
 * 颜色只用 --st-* 令牌，不写死色值。
 */
import { SETTINGS_WRITE_PENDING_RESTART_TEXT } from "./settingsWrite.ts"
import type { SettingsWriteFeedback } from "./settingsWriteHooks.ts"

/** 没有保存反馈时，说明行要么是只读原因，要么是「已写入待重启」的常驻提示。 */
function fallbackTone(fallback: string): "pending" | "readonly" {
  return fallback === SETTINGS_WRITE_PENDING_RESTART_TEXT ? "pending" : "readonly"
}

function toneColor(tone: SettingsWriteFeedback["tone"]): string | undefined {
  if (tone === "bad") return "var(--st-error)"
  if (tone === "warn") return "var(--st-wait)"
  return undefined
}

function FeedbackBody({ feedback }: { feedback: SettingsWriteFeedback }) {
  return (
    <>
      <span>{feedback.text}</span>
      {feedback.detail ? <span> · {feedback.detail}</span> : null}
      {feedback.hint ? (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer" }}>说明</summary>
          <span style={{ display: "block", marginTop: 2 }}>{feedback.hint}</span>
        </details>
      ) : null}
    </>
  )
}

export function SettingsWriteNote({
  feedback,
  fallback,
}: {
  feedback: SettingsWriteFeedback | null
  /** 读不到设置时的只读原因，或「已写入待重启」常驻说明；有反馈时让位给反馈。 */
  fallback?: string | null
}) {
  if (feedback) {
    return (
      <div
        className="settings-note"
        style={toneColor(feedback.tone) ? { color: toneColor(feedback.tone) } : undefined}
        role={feedback.tone === "bad" ? "alert" : "status"}
        data-settings-write-feedback={feedback.tone}
      >
        <FeedbackBody feedback={feedback} />
      </div>
    )
  }
  if (!fallback) return null
  return (
    <div className="settings-note" role="status" data-settings-write-feedback={fallbackTone(fallback)}>
      {fallback}
    </div>
  )
}

export function MobileSettingsWriteNote({
  feedback,
  fallback,
}: {
  feedback: SettingsWriteFeedback | null
  fallback?: string | null
}) {
  if (feedback) {
    return (
      <div
        className="sm-note"
        style={toneColor(feedback.tone) ? { color: toneColor(feedback.tone) } : undefined}
        role={feedback.tone === "bad" ? "alert" : "status"}
        data-settings-write-feedback={feedback.tone}
      >
        <FeedbackBody feedback={feedback} />
      </div>
    )
  }
  if (!fallback) return null
  return (
    <div className="sm-note" role="status" data-settings-write-feedback={fallbackTone(fallback)}>
      {fallback}
    </div>
  )
}
