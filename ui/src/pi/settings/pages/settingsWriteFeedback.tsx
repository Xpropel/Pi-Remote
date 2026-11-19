/**
 * 设置 › 写桥反馈（桌面 / 手机共用文案与结构）。
 *
 * 成功：`已保存，重启 pi 后生效`，`reloadHint` 放在可展开的「说明」里；
 * 失败：回滚由 useSettingsWriter 负责，这里只负责如实显示原因（需更新扩展 / 需设备在线 / 未写入）。
 * 没有反馈时的常驻说明分三种：读取中 / 只读原因 / 已写入待重启（不是只读）。
 * 语气写在 data-settings-write-feedback 上，底色与图标色由桌面 .settings-note、手机 .sm-note 各自按 --st-* 定义。
 */
import { useEffect, useState, type ReactNode } from "react"
import { CircleAlert, CircleCheck, Info, LoaderCircle, Lock, RotateCw, TriangleAlert, type LucideIcon } from "lucide-react"
import { useOptionalSettings } from "../SettingsContext.tsx"
import {
  SETTINGS_RESTART_APPLIED_TEXT,
  SETTINGS_WRITE_OK_TEXT,
  SETTINGS_WRITE_PENDING_RESTART_TEXT,
  SETTINGS_WRITE_READING_TEXT,
} from "./settingsWrite.ts"
import type { SettingsWriteFeedback } from "./settingsWriteHooks.ts"
import { SettingsPiRestartDialog, useSettingsPiRestart } from "./useSettingsPiRestart.tsx"

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
  viewport,
  feedback,
  fallback,
}: {
  prefix: NotePrefix
  viewport: "desktop" | "phone"
  feedback: SettingsWriteFeedback | null
  fallback?: string | null
}) {
  const settings = useOptionalSettings()
  const restart = useSettingsPiRestart(settings?.p.relay, settings?.act.notify)
  const [triggeredHere, setTriggeredHere] = useState(false)

  useEffect(() => {
    if (restart.phase === "idle") setTriggeredHere(false)
  }, [restart.phase])

  const feedbackNeedsRestart = Boolean(feedback && feedback.text === SETTINGS_WRITE_OK_TEXT)
  const fallbackNeedsRestart = !feedback && fallback === SETTINGS_WRITE_PENDING_RESTART_TEXT
  const needsRestart = feedbackNeedsRestart || fallbackNeedsRestart
  const showAction = settings !== null && (needsRestart || (triggeredHere && restart.phase === "failed"))

  let tone: NoteTone | null = null
  let content: ReactNode = null

  if (triggeredHere && restart.phase === "running") {
    tone = "loading"
    content = (
      <div className={`${prefix}-restart-row`}>
        <span>正在重启 Pi，完成后已保存的设置将自动生效…</span>
        <button
          type="button"
          className={`${prefix}-action`}
          data-settings-restart-pi=""
          disabled
        >
          <RotateCw size={12} strokeWidth={2} aria-hidden="true" />
          <span>重启中…</span>
        </button>
      </div>
    )
  } else if (!feedback && triggeredHere && restart.phase === "succeeded") {
    tone = "ok"
    content = <span>{SETTINGS_RESTART_APPLIED_TEXT}</span>
  } else if (feedback) {
    tone = showAction && restart.phase === "failed" ? "bad" : feedback.tone
    content = (
      <>
        <div className={`${prefix}-restart-row`}>
          <div className={`${prefix}-restart-copy`}>
            <FeedbackBody feedback={feedback} prefix={prefix} />
            {showAction && restart.phase === "failed" ? (
              <div className={`${prefix}-restart-error`}>
                重启 Pi 失败：{restart.error || "请在「设备 › 系统操作」检查状态"}
              </div>
            ) : !restart.target.canRestart && showAction && restart.target.reason ? (
              <div className={`${prefix}-restart-reason`}>{restart.target.reason}</div>
            ) : null}
          </div>
          {showAction ? (
            <button
              type="button"
              className={`${prefix}-action`}
              data-settings-restart-pi=""
              disabled={!restart.target.canRestart || restart.running}
              title={!restart.target.canRestart ? restart.target.reason : undefined}
              onClick={() => {
                setTriggeredHere(true)
                restart.requestRestart()
              }}
            >
              <RotateCw size={12} strokeWidth={2} aria-hidden="true" />
              <span>{restart.running ? "重启中…" : restart.phase === "failed" ? "重试重启" : "重启 Pi"}</span>
            </button>
          ) : null}
        </div>
      </>
    )
  } else if (fallback) {
    tone =
      showAction && restart.phase === "failed"
        ? "bad"
        : showAction && restart.running
          ? "loading"
          : fallbackTone(fallback)
    content = (
      <div className={`${prefix}-restart-row`}>
        <div className={`${prefix}-restart-copy`}>
          <span>{restart.running ? "正在重启 Pi，完成后已保存的设置将自动生效…" : fallback}</span>
          {showAction && restart.phase === "failed" ? (
            <div className={`${prefix}-restart-error`}>
              重启 Pi 失败：{restart.error || "请在「设备 › 系统操作」检查状态"}
            </div>
          ) : !restart.target.canRestart && showAction && restart.target.reason ? (
            <div className={`${prefix}-restart-reason`}>{restart.target.reason}</div>
          ) : null}
        </div>
        {showAction ? (
          <button
            type="button"
            className={`${prefix}-action`}
            data-settings-restart-pi=""
            disabled={!restart.target.canRestart || restart.running}
            title={!restart.target.canRestart ? restart.target.reason : undefined}
            onClick={() => {
              setTriggeredHere(true)
              restart.requestRestart()
            }}
          >
            <RotateCw size={12} strokeWidth={2} aria-hidden="true" />
            <span>{restart.running ? "重启中…" : restart.phase === "failed" ? "重试重启" : "重启 Pi"}</span>
          </button>
        ) : null}
      </div>
    )
  }

  if (!tone && !restart.confirmOpen) return null
  return (
    <>
      {tone ? (
        <Note prefix={prefix} tone={tone}>
          {content}
        </Note>
      ) : null}
      {settings ? <SettingsPiRestartDialog viewport={viewport} restart={restart} /> : null}
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
  return <WriteNote prefix="settings-note" viewport="desktop" feedback={feedback} fallback={fallback} />
}

export function MobileSettingsWriteNote({
  feedback,
  fallback,
}: {
  feedback: SettingsWriteFeedback | null
  fallback?: string | null
}) {
  return <WriteNote prefix="sm-note" viewport="phone" feedback={feedback} fallback={fallback} />
}
