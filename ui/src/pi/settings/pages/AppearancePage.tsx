/**
 * 设置 › 外观（设计册 §7 / 源码 settings-set-appearance.html）。
 *
 * 本页全部 ○ 纯本地：改完立即写 `pi_remote_pi_settings_v2`，没有确定 / 取消。
 * 界面风格与明暗同时落到宿主偏好（ui / theme），所以切换立即换皮肤与明暗；
 * 其余维度（字号 / 密度 / 动效 / 列宽 / 字体）先在本页即时呈现并持久化，等宿主接入全局消费。
 * 六套强调色只消费 --st-accent（选中徽标 / 预览行），不写死皮肤色；三张预览卡按设计稿的固定
 * 微缩配色呈现 Cursor / Claude / Codex 本体，不随当前皮肤串色。
 */
import { useEffect, useRef, type CSSProperties } from "react"
import { Check, Contrast, Moon, Sun } from "lucide-react"
import "@fontsource-variable/inter/wght.css"
import "@fontsource-variable/geist/wght.css"
import "@fontsource/jetbrains-mono/latin-400.css"
import { useSettings } from "../SettingsContext"
import {
  SETTINGS_ACCENT_LABELS,
  SETTINGS_CONTENT_WIDTH_MAX,
  SETTINGS_CONTENT_WIDTH_MIN,
  SETTINGS_DENSITIES,
  SETTINGS_DENSITY_LABELS,
  SETTINGS_FONT_SIZES,
  SETTINGS_MONO_FONTS,
  SETTINGS_UI_FONTS,
  type SettingsAccent,
  type SettingsDensity,
  type SettingsFontSize,
  type SettingsMonoFont,
  type SettingsStyle,
  type SettingsThemePref,
  type SettingsUiFont,
} from "../types"
import {
  SettingsColorDots,
  SettingsPageTitle,
  SettingsRow,
  SettingsSegmented,
  SettingsSelect,
  SettingsSwitch,
} from "../ui"
import "./appearance.css"

const STYLE_CARDS = [
  { id: "cursor", label: "Cursor", description: "中性玻璃 · 紫" },
  { id: "claude", label: "Claude", description: "暖纸衬线 · 陶土" },
  { id: "codex", label: "Codex", description: "冷灰阶梯 · 蓝" },
] as const satisfies readonly { id: SettingsStyle; label: string; description: string }[]

/** 换皮肤时强调色回到该皮肤的身份色；之后用户仍可自选。 */
const IDENTITY_ACCENT: Record<SettingsStyle, SettingsAccent> = {
  cursor: "violet",
  claude: "clay",
  codex: "blue",
}

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
const UI_FONT_STACKS: Record<SettingsUiFont, string> = {
  system:
    '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  inter: '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  geist: '"Geist Variable", Geist, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
}
const MONO_FONT_LABELS: Record<SettingsMonoFont, string> = {
  "jetbrains-mono": "JetBrains Mono",
  system: "系统等宽",
}
const MONO_FONT_STACKS: Record<SettingsMonoFont, string> = {
  "jetbrains-mono": '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  system: 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans CJK SC", monospace',
}

const UI_FONT_OPTIONS = SETTINGS_UI_FONTS.map((value) => ({ value, label: UI_FONT_LABELS[value] })) as readonly {
  value: SettingsUiFont
  label: string
}[]
const MONO_FONT_OPTIONS = SETTINGS_MONO_FONTS.map((value) => ({ value, label: MONO_FONT_LABELS[value] })) as readonly {
  value: SettingsMonoFont
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

function MiniPreview({ style }: { style: SettingsStyle }) {
  return (
    <span className="settings-appearance-mini" data-preview-style={style} aria-hidden="true">
      <span className="settings-appearance-mini-rail">
        <span className="settings-appearance-mini-bar" style={{ width: "78%" }} />
        <span className="settings-appearance-mini-row is-on">
          <span className="settings-appearance-mini-dot" />
          <span className="settings-appearance-mini-bar" />
        </span>
        <span className="settings-appearance-mini-bar is-dim" style={{ width: "64%" }} />
        <span className="settings-appearance-mini-bar is-dim" style={{ width: "82%" }} />
        <span className="settings-appearance-mini-bar is-dim" style={{ width: "55%" }} />
      </span>
      <span className="settings-appearance-mini-main">
        <span className="settings-appearance-mini-bar is-head" style={{ width: "46%" }} />
        <span className="settings-appearance-mini-bar is-dim" style={{ width: "88%", marginTop: 7 }} />
        <span className="settings-appearance-mini-bar is-dim" style={{ width: "70%", marginTop: 5 }} />
        <span className="settings-appearance-mini-composer" />
      </span>
    </span>
  )
}

export function AppearancePage() {
  const { p, style, prefs, act } = useSettings()

  // 宿主已换皮肤（别的入口切的）时，本页存储跟着当前皮肤走，避免卡片选中态与界面不一致。
  // 只在 style 真的变化时写：别的标签页改了 prefs.appearanceStyle 时，storage 同步会触发本 effect，
  // 若仍按「prefs != style 就写回」执行，会把 A 刚换的皮肤用 B 的旧宿主皮肤盖回去（MULTI-01 同类问题）。
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

  const themePref = p.ui.prefs.theme
  const selectStyle = (next: SettingsStyle) => {
    act.mergePrefs({ appearanceStyle: next, accent: IDENTITY_ACCENT[next] })
    p.act.setUiVariant(next)
  }
  const selectTheme = (next: SettingsThemePref) => {
    act.setPref("appearanceTheme", next)
    p.act.setPref("theme", next)
    const root = document.querySelector<HTMLElement>("[data-pi-settings]")
    if (root) root.dataset.piTheme = resolvedTheme(next)
  }
  const contentPercent =
    ((prefs.contentWidth - SETTINGS_CONTENT_WIDTH_MIN) / (SETTINGS_CONTENT_WIDTH_MAX - SETTINGS_CONTENT_WIDTH_MIN)) * 100
  const sliderStyle = { "--settings-slider-fill": `${Math.max(0, Math.min(100, contentPercent))}%` } as CSSProperties
  const pageStyle = {
    fontFamily: UI_FONT_STACKS[prefs.uiFont],
    "--st-font-mono": MONO_FONT_STACKS[prefs.monoFont],
  } as CSSProperties

  return (
    <div
      className="settings-page settings-appearance"
      data-settings-page="appearance"
      data-density={prefs.density}
      data-font-size={prefs.fontSize}
      data-reduced-motion={prefs.reducedMotion ? "true" : undefined}
      style={pageStyle}
    >
      <SettingsPageTitle title="外观" />

      <section className="settings-appearance-section settings-appearance-section--first">
        <h2 className="settings-group-label">界面风格</h2>
        <div className="settings-appearance-cards" role="radiogroup" aria-label="界面风格">
          {STYLE_CARDS.map((card) => {
            const selected = style === card.id
            return (
              <button
                key={card.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={card.label}
                className={selected ? "settings-appearance-card is-selected" : "settings-appearance-card"}
                data-appearance-style={card.id}
                onClick={() => selectStyle(card.id)}
              >
                {selected ? (
                  <span className="settings-appearance-check" aria-hidden="true">
                    <Check size={11} strokeWidth={3} />
                  </span>
                ) : null}
                <MiniPreview style={card.id} />
                <span className={card.id === "claude" ? "settings-appearance-name is-serif" : "settings-appearance-name"}>
                  {card.label}
                </span>
                <span className="settings-appearance-desc">{card.description}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="settings-appearance-section">
        <h2 className="settings-group-label">明暗</h2>
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
      </section>

      <section className="settings-appearance-section settings-appearance-accent">
        <span className="settings-appearance-row-copy">
          <span className="settings-appearance-row-title">强调色</span>
          <span className="settings-appearance-row-desc">用于运行状态点与少量强调</span>
        </span>
        <SettingsColorDots
          value={prefs.accent}
          options={ACCENT_SWATCHES}
          onChange={(value) => act.setPref("accent", value as SettingsAccent)}
        />
      </section>

      <section className="settings-appearance-section">
        <h2 className="settings-group-label">字号</h2>
        <SettingsSegmented
          label="字号"
          value={prefs.fontSize}
          options={FONT_SIZE_OPTIONS}
          onChange={(value) => act.setPref("fontSize", value)}
        />
        <p className="settings-appearance-preview">
          <span className="settings-appearance-preview-tag">预览</span>
          <span className="settings-appearance-preview-text">会话标题与正文的显示大小</span>
        </p>
      </section>

      <section className="settings-appearance-section">
        <h2 className="settings-group-label">界面密度</h2>
        <SettingsSegmented
          label="界面密度"
          value={prefs.density}
          options={DENSITY_OPTIONS}
          onChange={(value) => act.setPref("density", value)}
        />
        <p className="settings-group-description">影响列表与设置的行高</p>
      </section>

      <section className="settings-appearance-section">
        <h2 className="settings-group-label">动态效果</h2>
        <SettingsRow title="减少动态效果" description="关掉界面里的过渡与淡入动画">
          <SettingsSwitch
            label="减少动态效果"
            checked={prefs.reducedMotion}
            onChange={(checked) => act.setPref("reducedMotion", checked)}
          />
        </SettingsRow>
      </section>

      <section className="settings-appearance-section">
        <h2 className="settings-group-label">内容列宽</h2>
        <div className="settings-slider-row">
          <span className="settings-slider-end">窄</span>
          <input
            type="range"
            className="settings-slider"
            style={sliderStyle}
            aria-label="内容列宽"
            min={SETTINGS_CONTENT_WIDTH_MIN}
            max={SETTINGS_CONTENT_WIDTH_MAX}
            step={10}
            value={prefs.contentWidth}
            onChange={(event) => act.setPref("contentWidth", Number(event.target.value))}
          />
          <span className="settings-slider-end">宽</span>
          <output className="settings-slider-value">{prefs.contentWidth}</output>
        </div>
        <p className="settings-group-description">会话内容的居中列最大宽度</p>
      </section>

      <section className="settings-appearance-section">
        <h2 className="settings-group-label">字体</h2>
        <SettingsSelect
          label="界面字体"
          value={prefs.uiFont}
          options={UI_FONT_OPTIONS}
          onChange={(value) => act.setPref("uiFont", value)}
        />
        <SettingsSelect
          label="等宽字体"
          description="用于代码与终端内容"
          value={prefs.monoFont}
          options={MONO_FONT_OPTIONS}
          onChange={(value) => act.setPref("monoFont", value)}
        />
      </section>

      <p className="settings-note">切换立即应用到整个界面。</p>
    </div>
  )
}
