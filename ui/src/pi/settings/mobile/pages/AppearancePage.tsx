/**
 * 手机端设置 · 外观（手机版五组）。
 *
 * 本页全部 ○ 纯本地：偏好写 pi_remote_pi_settings_v2，改完即存。
 * 手机版删掉桌面专属的「内容列宽」与「字体」两组；保留界面风格 / 明暗 / 强调色 / 字号 /
 * 界面密度（动态效果并入密度卡片，仍可调，不再单独占一个分组标题）。
 *
 * 点选界面风格 / 明暗时同时通知外壳即时换肤（六套皮肤同源，只换 --st-* 令牌）；
 * 偏好本身持久化，下次打开仍按当前变体与系统主题起步。
 */
import { useEffect, useRef } from "react"
import { Check } from "lucide-react"
import type { CSSProperties } from "react"
import { useSettings } from "../../SettingsContext.tsx"
import {
  SETTINGS_ACCENT_LABELS,
  SETTINGS_ACCENTS,
  SETTINGS_DENSITY_LABELS,
  SETTINGS_DENSITIES,
  type SettingsAccent,
  type SettingsFontSize,
  type SettingsStyle,
  type SettingsThemePref,
} from "../../types.ts"
import { MobileGroup, MobileNote, MobilePageBody, MobileRow, MobileSegmented, MobileSwitch } from "../atoms.tsx"
import "./appearance.css"

/**
 * 设计册强调色五点 / 三张界面卡的身份色（外观页样例；不是皮肤基色，皮肤基色仍只走 --st-*）。
 * 字面色值集中在 appearance.css 的 --sm-* 变量里，组件只引变量（TSX 不写字面色值）。
 */
const ACCENT_SWATCH: Record<SettingsAccent, string> = {
  violet: "var(--sm-accent-violet)",
  blue: "var(--sm-accent-blue)",
  clay: "var(--sm-accent-clay)",
  green: "var(--sm-accent-green)",
  graphite: "var(--sm-accent-graphite)",
}

const STYLE_CARDS: readonly { value: SettingsStyle; name: string; sub: string; accent: string }[] = [
  { value: "cursor", name: "Cursor", sub: "中性玻璃 · 紫", accent: "var(--sm-style-accent-cursor)" },
  { value: "claude", name: "Claude", sub: "暖纸衬线 · 陶土", accent: "var(--sm-style-accent-claude)" },
  { value: "codex", name: "Codex", sub: "冷灰阶梯 · 蓝", accent: "var(--sm-style-accent-codex)" },
]

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

const DENSITY_OPTIONS = SETTINGS_DENSITIES.map((value) => ({ value, label: SETTINGS_DENSITY_LABELS[value] }))

/** 换皮肤时强调色回到该皮肤的身份色（口径与桌面 AppearancePage 一致）。 */
const IDENTITY_ACCENT: Record<SettingsStyle, SettingsAccent> = {
  cursor: "violet",
  claude: "clay",
  codex: "blue",
}

export function AppearancePage({
  onPreviewStyle,
  onPreviewTheme,
}: {
  onPreviewStyle?: (style: SettingsStyle) => void
  onPreviewTheme?: (theme: SettingsThemePref) => void
}) {
  const { p, prefs, act, style } = useSettings()

  // 当前皮肤来自宿主变体；首次进入时把外观偏好对齐，避免“页面是 Claude、卡片却选 Cursor”。
  // 只在 style 真的变化时写；别的标签页同步来的 appearanceStyle 不能被本页旧宿主皮肤盖回去。
  const hostStyle = useRef(style)
  const styleSynced = useRef(false)
  useEffect(() => {
    if (!styleSynced.current) {
      styleSynced.current = true
      if (prefs.appearanceStyle !== style) act.mergePrefs({ appearanceStyle: style, accent: IDENTITY_ACCENT[style] })
      return
    }
    if (hostStyle.current === style) return
    hostStyle.current = style
    if (prefs.appearanceStyle === style) return
    act.mergePrefs({ appearanceStyle: style, accent: IDENTITY_ACCENT[style] })
  }, [act, prefs.appearanceStyle, style])

  const selectStyle = (next: SettingsStyle) => {
    act.mergePrefs({ appearanceStyle: next, accent: IDENTITY_ACCENT[next] })
    p.act.setUiVariant(next)
    onPreviewStyle?.(next)
  }

  return (
    <MobilePageBody page="appearance">
      <MobileGroup label="界面风格" stacked>
        <div className="sm-style-cards" role="radiogroup" aria-label="界面风格">
          {STYLE_CARDS.map((card) => {
            const on = prefs.appearanceStyle === card.value
            return (
              <button
                key={card.value}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? "sm-style-card is-on" : "sm-style-card"}
                style={{ "--sm-style-accent": card.accent } as CSSProperties}
                onClick={() => selectStyle(card.value)}
              >
                <span className="sm-style-preview" aria-hidden="true">
                  <span className="sm-style-bar sm-style-bar--long" />
                  <span className="sm-style-bar sm-style-bar--short" />
                  {on ? null : <span className="sm-style-dot" />}
                </span>
                <span className="sm-style-name">{card.name}</span>
                <span className="sm-style-sub">{card.sub}</span>
                {on ? (
                  <span className="sm-style-check" aria-hidden="true">
                    <Check size={14} strokeWidth={2.6} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </MobileGroup>

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
            会话标题与正文
          </span>
        </div>
      </MobileGroup>

      <MobileGroup label="界面密度" footnote="影响列表与设置的行高">
        <div className="sm-pad">
          <MobileSegmented
            label="界面密度"
            value={prefs.density}
            options={DENSITY_OPTIONS}
            onChange={(value) => act.setPref("density", value)}
          />
        </div>
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
