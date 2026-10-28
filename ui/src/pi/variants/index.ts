/**
 * 三套 UI 的组件注册表（P1 架构线；brief §架构契约 1–4）。纯元数据与校验在 ./types.ts，这里只做「id → 组件」。
 *
 * - `cursor`：现有 Cursor 风格界面，**静态 import、不过 React.lazy**（首屏不能闪；外观/行为与 P1 之前完全一致，
 *   唯一差别是根节点多了 `data-pi-ui="cursor"` 标记）。
 * - `claude` / `codex`：`React.lazy(() => import(...))`，首次切到该变体时才拉 chunk；骨架由本线提供，P2 两条线替换成正式实现。
 * - 变体目录（variants/<id>/）之间禁止互相 import，也不 import 本文件（反向依赖会成环）；测试
 *   test/pi-ui-variants.test.mjs 静态扫描盯住。
 * - 画廊（#/live 的 ?ui=）与生产入口（PiApp 按 prefs.ui）共用这份注册表，两条路径看到的是同一棵展示树。
 */
import { createElement, lazy, type ComponentType, type LazyExoticComponent } from "react"
import type { PiTheme } from "@/components/pi/shared/viewport"
import { CursorApp } from "./cursor/CursorApp"
import { variantFallbackTheme } from "./fallback"
import {
  PI_UI_VARIANT_IDS,
  PI_UI_VARIANT_META,
  piUiVariantOf,
  type PiUiVariant,
  type PiUiVariantMeta,
  type VariantAppProps,
} from "./types"

export * from "./types"

/** 变体入口组件：cursor 是普通组件，claude/codex 是 React.lazy（渲染时包在 <Suspense> 里） */
export type PiVariantComponent = ComponentType<VariantAppProps> | LazyExoticComponent<ComponentType<VariantAppProps>>

/** 注册表的一项：元数据（id / 显示名 / 描述 / testid）+ 入口组件 */
export interface PiUiVariantDef extends PiUiVariantMeta {
  Component: PiVariantComponent
}

/**
 * claude / codex 的 chunk 名（`ui-claude` / `ui-codex`）：Vite 按 import() 自动拆包，构建后能直接看出两套设计各自的体积。
 * 骨架阶段只有几个组件；P2 线替换实现时不用改这里。
 */
const LazyClaudeApp = lazy(() => import("./claude/ClaudeApp").then((m) => ({ default: m.ClaudeApp })))
const LazyCodexApp = lazy(() => import("./codex/CodexApp").then((m) => ({ default: m.CodexApp })))

/** 注册表（顺序 = PI_UI_VARIANT_IDS = 设置页卡片顺序） */
export const PI_UI_VARIANT_REGISTRY: readonly PiUiVariantDef[] = [
  { ...PI_UI_VARIANT_META.cursor, Component: CursorApp },
  { ...PI_UI_VARIANT_META.claude, Component: LazyClaudeApp },
  { ...PI_UI_VARIANT_META.codex, Component: LazyCodexApp },
]

const BY_ID = Object.fromEntries(PI_UI_VARIANT_REGISTRY.map((def) => [def.id, def])) as Record<PiUiVariant, PiUiVariantDef>

/** id → 注册表项；非法 / 缺失回退 cursor（和 prefs 的迁移规则同一个入口 piUiVariantOf） */
export function piVariantDefOf(id: unknown): PiUiVariantDef {
  return BY_ID[piUiVariantOf(id)]
}

/** 某个变体的入口组件（cursor 同步、claude/codex 惰性） */
export function piVariantComponentOf(id: unknown): PiVariantComponent {
  return piVariantDefOf(id).Component
}

/**
 * 首次切到 claude/codex、chunk 还没到时的占位（PiApp / 画廊的 Suspense fallback）。
 * 带 data-pi-ui 根标记，CSS 作用域与测试断言在加载期也能对上变体；颜色只用公共 token，不加载变体 CSS。
 *
 * 主题（UI 低危：切皮肤深色首屏闪）：旧变体卸载时 PiRoot 会清掉 <html data-pi-theme>，
 * 这层覆盖不在 PiRoot 里，只读 :root 的 --cw-bg 会在深色模式整屏刷白。这里显式带上
 * data-pi-root + data-pi-theme，让共享深色 token 直接落在自己的根节点上；主题由
 * variantFallbackTheme 按与首帧脚本相同的规则取（DOM 属性 → prefs → 系统）。
 */
export function PiVariantLoading({ variant, theme }: { variant: PiUiVariant; theme?: PiTheme }) {
  const label = PI_UI_VARIANT_META[variant]?.label ?? variant
  const resolved = theme ?? variantFallbackTheme()
  return createElement("div", {
    "data-pi-ui": variant,
    "data-pi-variant-loading": variant,
    "data-pi-root": "",
    "data-pi-theme": resolved,
    // a11y（R4）：加载占位不是纯装饰，读屏应知道「界面正在加载」
    role: "status",
    "aria-live": "polite",
    "aria-label": `正在加载${label}界面`,
    className: "fixed inset-0 bg-(--cw-bg)",
    style: { colorScheme: resolved },
  })
}

/** 注册表完整性自检（测试与开发画廊用；返回问题清单，空 = 通过） */
export function piVariantRegistryProblems(): string[] {
  const problems: string[] = []
  if (PI_UI_VARIANT_REGISTRY.length !== PI_UI_VARIANT_IDS.length) problems.push("注册表项数与 PI_UI_VARIANT_IDS 不一致")
  for (const id of PI_UI_VARIANT_IDS) {
    const def = BY_ID[id]
    if (!def) problems.push(`缺变体 ${id}`)
    else if (def.id !== id) problems.push(`变体 ${id} 的 id 不一致`)
    else if (!def.label || !def.description || !def.testId) problems.push(`变体 ${id} 缺显示名 / 描述 / testid`)
    else if (typeof def.Component !== "function" && typeof (def.Component as { $$typeof?: unknown }).$$typeof !== "symbol") problems.push(`变体 ${id} 没有入口组件`)
  }
  if (PI_UI_VARIANT_REGISTRY[0]?.id !== "cursor") problems.push("注册表第一项必须是 cursor（默认变体）")
  return problems
}
