/**
 * 设置页内的轻提示（桌面 / 手机共用）；状态见 useSettingsToast.ts。
 * 颜色与位置由各端样式（settings.css 的 .settings-toast*、mobile.css 的 .sm-toast*）决定。
 */
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react"
import type { SettingsToastState } from "./useSettingsToast"

const TONE_ICON = { ok: CircleCheck, warn: TriangleAlert, bad: CircleAlert } as const

/** `prefix` 决定类名（桌面 settings-toast / 手机 sm-toast）；外层播报区常驻，读屏才能听到后来出现的内容。 */
export function SettingsToast({ toast, prefix }: { toast: SettingsToastState | null; prefix: "settings-toast" | "sm-toast" }) {
  const Icon = toast ? TONE_ICON[toast.tone] : null
  return (
    <div className={`${prefix}-region`} role="status" aria-live="polite" aria-atomic="true">
      {toast && Icon ? (
        <div key={toast.key} className={prefix} data-tone={toast.tone} data-leaving={toast.leaving ? "" : undefined}>
          <Icon size={15} strokeWidth={2} aria-hidden="true" className={`${prefix}-icon`} />
          <span className={`${prefix}-text`}>{toast.text}</span>
        </div>
      ) : null}
    </div>
  )
}
