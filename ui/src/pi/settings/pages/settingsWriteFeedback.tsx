/**
 * 设置 › 写桥反馈（桌面 / 手机共用文案与结构）。
 *
 * 成功：`已保存，重启 pi 后生效`，`reloadHint` 放在可展开的「说明」里；
 * 失败：回滚由 useSettingsWriter 负责，这里只负责如实显示原因（需更新扩展 / 需设备在线 / 未写入）。
 * 没有反馈时的常驻说明分三种：读取中 / 只读原因 / 已写入待重启（不是只读）。
 * 语气写在 data-settings-write-feedback 上，底色与图标色由桌面 .settings-note、手机 .sm-note 各自按 --st-* 定义。
 */
import type { ReactNode } from "react"
import { CircleAlert, CircleCheck, Info, LoaderCircle, Lock, TriangleAlert, type LucideIcon } from "lucide-react"
import { SETTINGS_WRITE_PENDING_RESTART_TEXT, SETTINGS_WRITE_READING_TEXT } from "./settingsWrite.ts"
import type { SettingsWriteFeedback } from "./settingsWriteHooks.ts"

type NoteTone = SettingsWriteFeedback["tone"] | "pending" | "readonly" | "loading"
type NotePrefix = "settings-note" | "sm-note"

const TONE_ICON: Record<NoteTone, LucideIcon> = {
  ok: CircleCheck,
  warn: TriangleAlert,
  bad: CircleAlert,
  pending: Info,
  readonly: Lock,
  loading: LoaderCircle,
}

function fallbackTone(fallback: string): "pending" | "readonly" | "loading" {
  if (fallback === SETTINGS_WRITE_PENDING_RESTART_TEXT) return "pending"
  if (fallback === SETTINGS_WRITE_READING_TEXT) return "loading"
  return "readonly"
}

function Note({ prefix, tone, children }: { prefix: NotePrefix; tone: NoteTone; children: ReactNode }) {
  const Icon = TONE_ICON[tone]
  return (
    <div className={prefix} role={tone === "bad" ? "alert" : "status"} data-settings-write-feedback={tone}>
      <Icon size={14} strokeWidth={2} aria-hidden="true" className={`${prefix}-icon`} />
      <div className={`${prefix}-body`}>{children}</div>
    </div>
  )
}

function FeedbackBody({ feedback, prefix }: { feedback: SettingsWriteFeedback; prefix: NotePrefix }) {
  return (
    <>
      <span>{feedback.text}</span>
      {feedback.detail ? <span className={`${prefix}-detail`}> · {feedback.detail}</span> : null}
      {feedback.hint ? (
        <details className={`${prefix}-details`}>
          <summary>说明</summary>
          <span>{feedback.hint}</span>
        </details>
      ) : null}
    </>
  )
}

function WriteNote({
  prefix,
  feedback,
  fallback,
}: {
  prefix: NotePrefix
  feedback: SettingsWriteFeedback | null
  fallback?: string | null
}) {
  if (feedback) {
    return (
      <Note prefix={prefix} tone={feedback.tone}>
        <FeedbackBody feedback={feedback} prefix={prefix} />
      </Note>
    )
  }
  if (!fallback) return null
  return (
    <Note prefix={prefix} tone={fallbackTone(fallback)}>
      {fallback}
    </Note>
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
  return <WriteNote prefix="settings-note" feedback={feedback} fallback={fallback} />
}

export function MobileSettingsWriteNote({
  feedback,
  fallback,
}: {
  feedback: SettingsWriteFeedback | null
  fallback?: string | null
}) {
  return <WriteNote prefix="sm-note" feedback={feedback} fallback={fallback} />
}
