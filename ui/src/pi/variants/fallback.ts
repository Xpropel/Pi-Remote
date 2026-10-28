/**
 * 变体加载 / 报错屏的主题（UI 低危：深色模式整屏浅色，切皮肤首屏闪）。
 *
 * 变体切换时旧的 PiRoot 会卸载，它的 cleanup 把 `<html data-pi-theme>` 清掉；新的 lazy chunk
 * 还没到时 Suspense fallback（以及渲染错误后的错误边界）是整屏覆盖层，它不在 PiRoot 里，
 * 只有 `--cw-bg`（`:root` 的浅色值）可读 → 深色模式下整屏刷白。
 *
 * 这里按与首帧脚本 / usePiTheme 相同的规则取当前实际主题：
 *  1. 优先 `<html data-pi-theme>`（就在同一轮 render 里读，仍能读到旧根被删前的值）；
 *  2. 属性已被清掉（切皮肤的空窗）时读 prefs（新键 → 旧键）并跟随系统；
 *  3. 最后 `prefers-color-scheme` 兜底。
 * 纯函数，可传假 doc / storage 做 node 测试；结果只用于 fallback/错误屏自己的 data-pi-theme。
 */
import type { PiTheme } from "../../components/pi/shared/viewport.ts"
import { LEGACY_THEME_KEY, PI_PREFS_KEY, piThemePrefOf, resolvePiTheme } from "../model/prefs.ts"

type DocLike = { documentElement?: { getAttribute(name: string): string | null } | null } | null | undefined
type StorageLike = { getItem(key: string): string | null } | null | undefined

function systemDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches === true
}

function browserStorage(): StorageLike {
  try {
    return typeof window !== "undefined" ? window.localStorage : null
  } catch {
    return null
  }
}

function storedPref(storage: StorageLike): ReturnType<typeof piThemePrefOf> {
  if (!storage) return "system"
  try {
    return piThemePrefOf(storage.getItem(PI_PREFS_KEY), storage.getItem(LEGACY_THEME_KEY))
  } catch {
    return "system"
  }
}

/** 加载 / 报错屏当前应使用的实际主题（light / dark）。 */
export function variantFallbackTheme(
  doc: DocLike = typeof document !== "undefined" ? document : null,
  storage: StorageLike = browserStorage(),
  prefersDark: boolean = systemDark(),
): PiTheme {
  const attr = doc?.documentElement?.getAttribute("data-pi-theme")
  if (attr === "light" || attr === "dark") return attr
  return resolvePiTheme(storedPref(storage), prefersDark)
}
