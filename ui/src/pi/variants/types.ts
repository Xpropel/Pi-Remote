/**
 * 三套 UI 变体的契约（P1 架构线，brief `.agents/tasks/pi-ui-refs-2026-10-26/brief.md` §架构契约 1–4 / 6）。
 *
 * - `PiUiVariant = "cursor" | "claude" | "codex"`：cursor = 现有 Cursor 风格界面（默认，原样保留、不能回归）；
 *   claude / codex 由 P2 的两条实现线各自在 `variants/claude/`、`variants/codex/` 里实现，本线只给骨架。
 * - 本文件是变体的**纯函数 + 元数据**部分：不 import React、不 import 任何运行时模块（只有 `import type`，编译后不存在），
 *   所以 node --test 能直接加载（test/pi-ui-variants.test.mjs）；组件注册表在 `./index.ts`（react.lazy 只在那里用）。
 * - 变体之间禁止互相 import；变体目录里的文件也不 import `variants/index.ts`（避免循环依赖）。两条都用静态扫描测试盯住。
 * - 变体自己的 CSS 只在 `[data-pi-ui="<id>"]` 根作用域内生效，token 命名空间 `--claude-*` / `--codex-*`（契约 §5）。
 */
import type { PiDeviceFrame } from "@/components/pi/shared/frame"
import type { PiTheme } from "@/components/pi/shared/viewport"
import type { PiAppProps, PiVariant } from "@/pi/containers/types"

/** 全部变体 id（顺序 = 设置页「界面」卡片的顺序；cursor 永远第一） */
export const PI_UI_VARIANT_IDS = ["cursor", "claude", "codex"] as const

/** 变体 id（持久化在 prefs.ui 里；见 pi/model/prefs.ts） */
export type PiUiVariant = (typeof PI_UI_VARIANT_IDS)[number]

/** 默认变体：现有 Cursor 风格界面（契约 §1「现有 UI 原样保留，不能回归」） */
export const DEFAULT_PI_UI_VARIANT: PiUiVariant = "cursor"

/** 存储 / URL 参数来的值是不是合法变体 id */
export function isPiUiVariant(value: unknown): value is PiUiVariant {
  return typeof value === "string" && (PI_UI_VARIANT_IDS as readonly string[]).includes(value)
}

/** 任意值 → 合法变体 id：缺失 / 非法一律回退默认值（prefs 迁移、画廊参数都走这里） */
export function piUiVariantOf(value: unknown): PiUiVariant {
  return isPiUiVariant(value) ? value : DEFAULT_PI_UI_VARIANT
}

/** 设置页「界面」卡片 / 画廊展示用的元数据（不含组件，node 测试可直接加载） */
export interface PiUiVariantMeta {
  id: PiUiVariant
  /** 卡片标题（设计代号，来自 brief 的变体表） */
  label: string
  /** 卡片副标题的一句话说明 */
  description: string
  /**
   * 设置页卡片的稳定 data-testid（验证线的 playwright / e2e 直接点它，不要按可见文字找）。
   * 命名固定为 `pi-ui-variant-<id>`，见 PI_UI_VARIANT_META。
   */
  testId: string
}

export const PI_UI_VARIANT_META: Record<PiUiVariant, PiUiVariantMeta> = {
  cursor: { id: "cursor", label: "Cursor", description: "现有界面（默认）", testId: "pi-ui-variant-cursor" },
  claude: { id: "claude", label: "Claude", description: "暖纸面 · 衬线门面 · 陶土橙", testId: "pi-ui-variant-claude" },
  codex: { id: "codex", label: "Codex", description: "聊天壳 · 代码审查面板 · 蓝强调", testId: "pi-ui-variant-codex" },
}

/** 按卡片顺序排好的元数据列表（设置页、画廊直接 map 它） */
export const PI_UI_VARIANT_LIST: readonly PiUiVariantMeta[] = PI_UI_VARIANT_IDS.map((id) => PI_UI_VARIANT_META[id])

/**
 * 变体入口组件收到的 props：= PiAppProps（relay / ui / act / keyboardOpen，relay 与界面状态由 PiApp 只创建一份）
 * + 展示层需要的三项。切换变体只换这棵展示树，PiApp 里的 useRelay/usePiUiState 不重跑，所以 room / 草稿 / 连接都保留（契约 §3）。
 */
export interface VariantAppProps extends PiAppProps {
  /** usePiTheme 解析后的实际主题（light / dark）；变体根节点写 data-pi-theme 用 */
  theme: PiTheme
  /** 布局：1024 断点，取值同 PiAppBody 内部分支（桌面 / 手机外壳语义保留，契约 §8） */
  layout: PiVariant
  /** 产品模式的视口帧（PiApp / 画廊 vp=device）；开发画廊舞台不传 = PiRoot 走舞台模式 */
  device?: PiDeviceFrame
}

/** `VariantAppProps` 的别名（任务/规格里两个写法都有，统一指向同一份契约） */
export type PiVariantAppProps = VariantAppProps
