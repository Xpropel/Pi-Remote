import type { ComponentType } from "react"
import type { PiTheme, PiLayout, PiStageSize } from "@/components/pi/shared/viewport"
import type { PiUiVariant } from "@/pi/variants/types"

/**
 * 开发画廊的屏幕注册（实施计划 P2.4、D6、D7）。照 replica 的 src/app/registry/pi.ts（类型、glob）和 piScreens.ts（校验、排序）
 * 合并重写；只在 gallery.html → dev/main.tsx 里用，不进生产包。约定见 R/pi/shell-changes.md §3–§4。
 *
 * 屏幕文件：src/pi/dev/screens/<area>/<screen-id>.tsx（area = a | b | c，可以再分子目录），必须导出
 *   export const piScreen: PiScreenMeta
 *   export default function Screen({ viewport, theme }: PiScreenProps) { … }
 * 路径里有下划线开头的段（例如 screens/b/_lightbox/lightbox.tsx）是开发屏：照样注册、路由能打开、#/pi 索引里列出，
 * 截图脚本只在 --screens 点名时处理，也不计入 32 屏。没有 piScreen 的下划线文件当作辅助文件，忽略。
 *
 * 路由：#/pi/<screen-id>?vp=1440x900|390x844&theme=light|dark
 */

export type { PiTheme, PiLayout, PiStageSize }

/** 设计区域：a 外壳与列表，b 对话流与右 pane，c composer、菜单、弹窗、设置 */
export type PiArea = "a" | "b" | "c"

/** 屏幕文件的 `export const piScreen` */
export interface PiScreenMeta {
  /** = 文件名（不含 .tsx），也用于路由与截图文件名：字母数字，用单个 - 或 _ 连接（不能有 --） */
  id: string
  area: PiArea
  /** 中文标题，画廊里显示 */
  title: string
  /** 出图的主题，默认 ["light"]；写了 "dark" 才出 --dark 截图 */
  themes?: PiTheme[]
  /** true：390×844 下舞台底部叠一块中性的屏幕键盘占位（约 336px，推断/估计），并设 --cw-pi-keyboard-h */
  keyboard?: boolean
  /** 这一屏呈现的设计状态（例如 design.md 的 "S0"、"P-08 键盘弹出"）：只在画廊和脚本汇总里列出，不产生额外路由或截图 */
  states?: string[]
  /** 备注：对应的设计编号、推断项等，画廊里显示 */
  notes?: string
}

/** 屏幕默认导出组件收到的 props */
export interface PiScreenProps {
  viewport: PiLayout
  theme: PiTheme
  /**
   * 画廊 ?ui= 参数（PI-UI-REFS 架构线；缺省 "cursor"）。
   * 屏幕自己的 PiRoot 可以转交给 PiRoot 的 ui 参数，让 data-pi-ui 根标记与静态 CSS 作用域对得上；
   * 不传也不影响现有 cursor 屏幕（它们不读这个字段）。
   */
  ui?: PiUiVariant
}

export interface PiScreenModule {
  piScreen: PiScreenMeta
  default: ComponentType<PiScreenProps>
}

/** 注册后补齐默认值的 meta（window.__PI_GALLERY__.screens 的一项） */
export interface PiScreenInfo extends PiScreenMeta {
  themes: PiTheme[]
  keyboard: boolean
  states: string[]
  /** 相对 src/pi/dev/screens/ 的路径，例如 "a/login.tsx" */
  file: string
  /** 路径里有下划线开头的段（开发屏，不计入 32 屏） */
  hidden: boolean
}

export interface PiGalleryProblem {
  where: string
  message: string
}

/** window.__PI_GALLERY__：给 R2/tools/ui-pi-shots.mjs 等脚本枚举屏幕 */
export interface PiGalleryExpose {
  screens: PiScreenInfo[]
  /** 注册阶段发现的问题（只 console.warn）；非空时截图脚本判失败 */
  errors: PiGalleryProblem[]
  /** 渲染时被 ErrorBoundary 接住的错误（同时 console.error，并留 [data-render-error] 标记） */
  renderErrors: PiGalleryProblem[]
}

declare global {
  interface Window {
    __PI_GALLERY__?: PiGalleryExpose
  }
}

export const PI_AREAS: readonly PiArea[] = ["a", "b", "c"]
export const PI_VIEWPORTS: readonly PiStageSize[] = ["1440x900", "390x844"]
export const PI_THEMES: readonly PiTheme[] = ["light", "dark"]

/** 舞台：CSS 尺寸与安全区。390×844 的 47 / 34 是 iPhone 12–15 竖屏的状态栏与 Home 指示条（推断/估计） */
export const PI_STAGE: Record<PiStageSize, { width: number; height: number; safeTop: number; safeBottom: number }> = {
  "1440x900": { width: 1440, height: 900, safeTop: 0, safeBottom: 0 },
  "390x844": { width: 390, height: 844, safeTop: 47, safeBottom: 34 },
}

/** 屏幕键盘占位高（推断/估计：iPhone 竖屏系统键盘带候选栏约 336pt，含底部 Home 指示条区域） */
export const PI_KEYBOARD_H = 336

export interface RegisteredPiScreen {
  meta: PiScreenInfo
  Component: ComponentType<PiScreenProps>
}

const modules = import.meta.glob<PiScreenModule>("./screens/**/*.tsx", { eager: true })

/** 注册问题：只 console.warn（dev/main.tsx），截图脚本读 window.__PI_GALLERY__.errors 判失败 */
export const piErrors: PiGalleryProblem[] = []

const NAME_RE = /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/
const list: RegisteredPiScreen[] = []

for (const [file, mod] of Object.entries(modules)) {
  const rel = file.replace(/^\.\/screens\//, "")
  const segments = rel.split("/")
  const hidden = segments.some((s) => s.startsWith("_"))
  const dirArea = segments.length > 1 && (PI_AREAS as string[]).includes(segments[0]) ? (segments[0] as PiArea) : null
  const where = `src/pi/dev/screens/${rel}`
  const err = (message: string) => piErrors.push({ where, message })
  const meta = mod?.piScreen
  if (!meta) {
    if (!hidden) err("屏幕文件必须 `export const piScreen: PiScreenMeta` 和 `export default function Screen(props: PiScreenProps)`；辅助文件放 src/components/pi/ 或用 _ 开头的文件名")
    continue
  }
  if (typeof mod.default !== "function") {
    err("缺 `export default function Screen(props: PiScreenProps)`")
    continue
  }
  const id = segments[segments.length - 1].replace(/\.tsx$/, "")
  if (meta.id !== id) err(`piScreen.id "${meta.id}" 与文件名 "${id}" 不一致`)
  if (!NAME_RE.test(meta.id ?? "")) err(`piScreen.id "${meta.id}" 只能是字母数字，用单个 - 或 _ 连接`)
  if (!(PI_AREAS as string[]).includes(meta.area)) {
    err(`piScreen.area "${meta.area}" 不是 a / b / c`)
    continue
  }
  if (dirArea && dirArea !== meta.area) err(`piScreen.area "${meta.area}" 与所在目录 ${dirArea}/ 不一致`)
  if (!dirArea && !hidden) err("屏幕文件要放在 src/pi/dev/screens/<a|b|c>/ 下（区域过滤按目录判断）")
  if (!meta.title) err("缺 piScreen.title（中文标题）")
  const themes = meta.themes?.length ? [...meta.themes] : (["light"] as PiTheme[])
  for (const t of themes) if (!(PI_THEMES as string[]).includes(t)) err(`themes 里的 "${t}" 不是 light / dark`)
  if (new Set(themes).size !== themes.length) err("themes 有重复")
  if (list.some((x) => x.meta.id === meta.id)) {
    err(`屏幕 id "${meta.id}" 重复`)
    continue
  }
  list.push({
    meta: { ...meta, themes, states: meta.states ? [...meta.states] : [], keyboard: !!meta.keyboard, file: rel, hidden },
    Component: mod.default,
  })
}

list.sort((a, b) => a.meta.area.localeCompare(b.meta.area) || a.meta.id.localeCompare(b.meta.id))

export const piScreens = list

export function findPiScreen(id: string) {
  return list.find((s) => s.meta.id === id)
}

export function piGalleryExpose(): PiGalleryExpose {
  return { screens: list.map((s) => s.meta), errors: [...piErrors], renderErrors: [] }
}
