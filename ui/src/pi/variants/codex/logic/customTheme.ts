/** 主题自定义默认值（P4 W3：Settings 的 theme-custom 色板初始值）。
 *  字面色值放在 .ts（TSX 字面色值规则只许减少）；视觉 token 仍由 styles/codex.css 的 --codex-* 提供。 */
export const DEFAULT_CUSTOM_THEME = { accent: "#2b7fd4", background: "#ffffff", foreground: "#1a1c1f" } as const
export type CodexCustomTheme = { accent: string; background: string; foreground: string }
