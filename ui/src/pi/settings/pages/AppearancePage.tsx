/**
 * 设置 › 外观（设计册 §7 / 源码 settings-set-appearance.html）。
 *
 * 本页全部 ○ 纯本地：改完立即写 `pi_remote_pi_settings_v2`，没有确定 / 取消。
 * 明暗同时落到宿主偏好（theme）；强调色 / 字号 / 密度 / 界面字体 / 动效由 PiSettingsHost 镜像到 <html>，
 * pi-theme.css 按属性改全局令牌，所以切换立即作用到整个界面。
 * 内容列宽、等宽字体没法在不改默认外观的前提下全局生效，不在本页提供（偏好字段仍保留）。
 */
import { Contrast, Moon, Sun } from "lucide-react"
import "@fontsource-variable/inter/wght.css"
import "@fontsource-variable/geist/wght.css"
import { useSettings } from "../SettingsContext"
import {
  SETTINGS_ACCENT_LABELS,
  SETTINGS_DENSITIES,
  SETTINGS_DENSITY_LABELS,
  SETTINGS_FONT_SIZES,
  SETTINGS_UI_FONTS,
  type SettingsAccent,
  type SettingsDensity,
  type SettingsFontSize,
  type SettingsThemePref,
  type SettingsUiFont,
} from "../types"
import {
  SettingsColorDots,
  SettingsGroup,
  SettingsNote,
  SettingsPageTitle,
  SettingsRow,
  SettingsSegmented,
  SettingsSelect,
  SettingsSwitch,
} from "../ui"
import "./appearance.css"

const ACCENT_SWATCHES = [
  { value: "violet", label: SETTINGS_ACCENT_LABELS.violet, color: "var(--ap-accent-violet)" },
  { value: "blue", label: SETTINGS_ACCENT_LABELS.blue, color: "var(--ap-accent-blue)" },
  { value: "clay", label: SETTINGS_ACCENT_LABELS.clay, color: "var(--ap-accent-clay)" },
  { value: "green", label: SETTINGS_ACCENT_LABELS.green, color: "var(--ap-accent-green)" },
  { value: "graphite", label: SETTINGS_ACCENT_LABELS.graphite, color: "var(--ap-accent-graphite)" },
] as const satisfies readonly { value: SettingsAccent; label: string; color: string }[]

const THEME_OPTIONS = [
  { value: "dark", label: "深色", icon: Moon },
  { value: "light", label: "浅色", icon: Sun },
  { value: "system", label: "跟随系统", icon: Contrast },
] as const satisfies readonly { value: SettingsThemePref; label: string; icon: typeof Moon }[]

const FONT_SIZE_OPTIONS = SETTINGS_FONT_SIZES.map((value) => ({
  value,
  label: value === "small" ? "小" : value === "large" ? "大" : "标准",
})) as readonly { value: SettingsFontSize; label: string }[]

const DENSITY_OPTIONS = SETTINGS_DENSITIES.map((value) => ({ value, label: SETTINGS_DENSITY_LABELS[value] })) as readonly {
  value: SettingsDensity
  label: string
}[]

const UI_FONT_LABELS: Record<SettingsUiFont, string> = {
  system: "系统默认",
  inter: "Inter",
  geist: "Geist",
}

const UI_FONT_OPTIONS = SETTINGS_UI_FONTS.map((value) => ({ value, label: UI_FONT_LABELS[value] })) as readonly {
  value: SettingsUiFont
  label: string
}[]

function systemTheme(): "light" | "dark" {
  try {
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch {
    return "light"
  }
}

function resolvedTheme(pref: SettingsThemePref): "light" | "dark" {
  return pref === "system" ? systemTheme() : pref
}

export function AppearancePage() {
  const { p, prefs, act } = useSettings()

  const themePref = p.ui.prefs.theme
  const selectTheme = (next: SettingsThemePref) => {
    act.setPref("appearanceTheme", next)
    p.act.setPref("theme", next)
    const root = document.querySelector<HTMLElement>("[data-pi-settings]")
    if (root) root.dataset.piTheme = resolvedTheme(next)
  }

  return (
    <div
      className="settings-page settings-appearance"
      data-settings-page="appearance"
      data-font-size={prefs.fontSize}
      data-reduced-motion={prefs.reducedMotion ? "true" : undefined}
    >
      <SettingsPageTitle title="外观" />

      <SettingsGroup label="主题" first>
        <SettingsRow title="明暗" description="跟随系统时，随电脑的浅色 / 深色自动切换">
          <div className="settings-segmented" role="radiogroup" aria-label="明暗">
            {THEME_OPTIONS.map((option) => {
              const Icon = option.icon
              const on = themePref === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={on ? "settings-segment is-on" : "settings-segment"}
                  onClick={() => {
                    if (!on) selectTheme(option.value)
                  }}
                >
                  <Icon size={13.5} strokeWidth={1.8} aria-hidden="true" className="settings-icon" />
                  <span>{option.label}</span>
                </button>
              )
            })}
          </div>
        </SettingsRow>
        <SettingsRow title="强调色" description="用于运行状态点与少量强调">
          <SettingsColorDots
            value={prefs.accent}
            options={ACCENT_SWATCHES}
            onChange={(value) => act.setPref("accent", value as SettingsAccent)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="文字与布局">
        <SettingsRow
          title="字号"
          description={
            <span className="settings-appearance-preview">
              <span className="settings-appearance-preview-tag">预览</span>
              <span className="settings-appearance-preview-text">会话标题与正文的显示大小</span>
            </span>
          }
        >
          <SettingsSegmented
            label="字号"
            value={prefs.fontSize}
            options={FONT_SIZE_OPTIONS}
            onChange={(value) => act.setPref("fontSize", value)}
          />
        </SettingsRow>
        <SettingsRow title="界面密度" description="影响列表与设置的行高">
          <SettingsSegmented
            label="界面密度"
            value={prefs.density}
            options={DENSITY_OPTIONS}
            onChange={(value) => act.setPref("density", value)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup label="字体">
        <SettingsSelect
          label="界面字体"
          value={prefs.uiFont}
          options={UI_FONT_OPTIONS}
          onChange={(value) => act.setPref("uiFont", value)}
        />
      </SettingsGroup>

      <SettingsGroup label="动态效果">
        <SettingsRow title="减少动态效果" description="关掉界面里的过渡与淡入动画">
          <SettingsSwitch
            label="减少动态效果"
            checked={prefs.reducedMotion}
            onChange={(checked) => act.setPref("reducedMotion", checked)}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsNote>切换立即应用到整个界面，只保存在这个浏览器里。</SettingsNote>
    </div>
  )
}
