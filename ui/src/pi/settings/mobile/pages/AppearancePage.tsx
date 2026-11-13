/**
 * 手机端设置 · 外观（手机版四组）。
 *
 * 本页全部 ○ 纯本地：偏好写 pi_remote_pi_settings_v2，改完即存。
 * 手机版删掉桌面专属的「内容列宽」与「字体」两组；保留明暗 / 强调色 / 字号 / 动态效果。
 * 界面密度只作用于桌面（侧栏、菜单、设置行），手机列表行高是固定的触控尺寸，所以手机版不提供。
 *
 * 点选明暗时同时通知外壳即时换 --st-* 令牌；偏好本身持久化，下次打开仍按系统主题起步。
 */
import type { CSSProperties } from "react"
import { useSettings } from "../../SettingsContext.tsx"
import {
  SETTINGS_ACCENT_LABELS,
  SETTINGS_ACCENTS,
  type SettingsAccent,
  type SettingsFontSize,
  type SettingsThemePref,
} from "../../types.ts"
import { MobileGroup, MobileNote, MobilePageBody, MobileRow, MobileSegmented, MobileSwitch } from "../atoms.tsx"
import "./appearance.css"

/**
 * 设计册强调色五点（外观页样例；不是界面基色，基色仍只走 --st-*）。
 * 字面色值集中在 appearance.css 的 --sm-* 变量里，组件只引变量（TSX 不写字面色值）。
 */
const ACCENT_SWATCH: Record<SettingsAccent, string> = {
  violet: "var(--sm-accent-violet)",
  blue: "var(--sm-accent-blue)",
  clay: "var(--sm-accent-clay)",
  green: "var(--sm-accent-green)",
  graphite: "var(--sm-accent-graphite)",
}

const THEME_OPTIONS = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
] as const satisfies readonly { value: SettingsThemePref; label: string }[]

const FONT_OPTIONS = [
  { value: "small", label: "小" },
  { value: "standard", label: "标准" },
  { value: "large", label: "大" },
] as const satisfies readonly { value: SettingsFontSize; label: string }[]

export function AppearancePage({ onPreviewTheme }: { onPreviewTheme?: (theme: SettingsThemePref) => void }) {
  const { p, prefs, act } = useSettings()

  return (
    <MobilePageBody page="appearance">
      <MobileGroup label="明暗">
        <div className="sm-pad">
          <MobileSegmented
            label="明暗"
            value={prefs.appearanceTheme}
            options={THEME_OPTIONS}
            onChange={(value) => {
              act.setPref("appearanceTheme", value)
              p.act.setPref("theme", value)
              onPreviewTheme?.(value)
            }}
          />
        </div>
      </MobileGroup>

      <MobileGroup label="强调色">
        <div className="sm-accent-row">
          <div className="sm-accent-title">强调色</div>
          <div className="sm-accent-line">
            <div className="sm-accent-dots" role="radiogroup" aria-label="强调色">
            {SETTINGS_ACCENTS.map((accent) => {
              const on = prefs.accent === accent
              return (
                <button
                  key={accent}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={SETTINGS_ACCENT_LABELS[accent]}
                  title={SETTINGS_ACCENT_LABELS[accent]}
                  className={on ? "sm-accent-dot is-on" : "sm-accent-dot"}
                  style={{ "--sm-dot": ACCENT_SWATCH[accent] } as CSSProperties}
                  onClick={() => act.setPref("accent", accent)}
                />
              )
            })}
            </div>
            <div className="sm-accent-desc">用于运行状态点与少量强调</div>
          </div>
        </div>
      </MobileGroup>

      <MobileGroup label="字号">
        <div className="sm-pad">
          <MobileSegmented
            label="字号"
            value={prefs.fontSize}
            options={FONT_OPTIONS}
            onChange={(value) => act.setPref("fontSize", value)}
          />
        </div>
        <div className="sm-preview-row">
          <span className="sm-preview-label">预览</span>
          <span className="sm-preview-text" data-size={prefs.fontSize}>
            对话里的正文与代码
          </span>
        </div>
      </MobileGroup>

      <MobileGroup label="动态效果">
        <MobileRow title="减少动态效果" description="关掉界面里的过渡与淡入动画">
          <MobileSwitch
            label="减少动态效果"
            checked={prefs.reducedMotion}
            onChange={(checked) => act.setPref("reducedMotion", checked)}
          />
        </MobileRow>
      </MobileGroup>

      <MobileNote>外观偏好只保存在这个浏览器里，切换立即生效。</MobileNote>
    </MobilePageBody>
  )
}
