/**
 * P11 gallery 注入接口（arch 冻结；dev 画廊/验证线按此出六套截图）。
 * 只放"风格×明暗"预设与 token 无关的展示元数据；**不放 mock 会话数据**（dev fixture 在 pi/dev 下，task-37）。
 */
import { PI_SIDEBAR_STYLES, PI_SIDEBAR_THEMES, type PiSidebarStyle, type PiSidebarTheme } from "./types.ts"

export interface PiSidebarGalleryPreset {
  id: string
  style: PiSidebarStyle
  theme: PiSidebarTheme
  label: string
}

export const PI_SIDEBAR_GALLERY_PRESETS: readonly PiSidebarGalleryPreset[] = PI_SIDEBAR_STYLES.flatMap((style) =>
  PI_SIDEBAR_THEMES.map((theme) => ({
    id: `${style}-${theme}`,
    style,
    theme,
    label: `${style === "cursor" ? "Cursor" : style === "claude" ? "Claude" : "Codex"} · ${theme === "dark" ? "深色" : "浅色"}`,
  })),
)

export function piSidebarGalleryPresetOf(id: string): PiSidebarGalleryPreset | null {
  const key = String(id || "").trim()
  return PI_SIDEBAR_GALLERY_PRESETS.find((preset) => preset.id === key || preset.style === key) ?? null
}
