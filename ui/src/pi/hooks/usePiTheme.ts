import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react"
import type { PiUiActions } from "@/pi/hooks/usePiUiState"
import { LEGACY_THEME_KEY, PI_PREFS_KEY, piThemePrefOf, resolvePiTheme, storedThemeOf, type PiThemePref } from "@/pi/model/prefs"

/*
 * 运行中的主题（PLAN 6.4，a 线；R2/p6-lanes.md §2.6）。首帧由 ui/index.html 的同步脚本按同一条规则写好，React 起来以后这里接手：
 *   偏好 = usePiUiState 的 prefs.theme（设置页、显示选项改的就是它，立刻生效）；"system" 时跟 matchMedia("(prefers-color-scheme: dark)")；
 *   别的标签页改了主题（storage 事件）由 usePiUiState 接进 prefs.theme（只接主题、不写回存储），这里照常跟着变；
 *   结果写到 <html data-pi-theme> 和 style.colorScheme（PiRoot 也会写同一个值），
 *   两个 theme-color 只留和主题一致的那一份生效（跟随系统时照原来的 media；design §4.3"状态栏颜色跟主题走"）。
 * 旧主题键 pi-remote.theme 的迁移：usePiUiState 只读新键，新键里没有合法 theme、旧键是 light / dark 时，
 * 第一次渲染就按旧键的值画（和首帧一致，不闪），再经 act.setPref 写回新键。
 */

const DARK_QUERY = "(prefers-color-scheme: dark)"

function darkQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(DARK_QUERY) : null
}

function subscribeDark(onChange: () => void): () => void {
  const mql = darkQuery()
  if (!mql) return () => {}
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }
  // 旧 Safari（< 14）
  mql.addListener(onChange)
  return () => mql.removeListener(onChange)
}

const readDark = () => darkQuery()?.matches === true

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 主题落到文档上（首帧脚本做的是同一件事） */
export function applyPiTheme(doc: Document, theme: "light" | "dark", pref: PiThemePref): void {
  const root = doc.documentElement
  root.setAttribute("data-pi-theme", theme)
  root.style.colorScheme = theme
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][data-pi-theme-color]')) {
    const own = meta.getAttribute("data-pi-theme-color")
    meta.setAttribute("media", pref === "system" ? `(prefers-color-scheme: ${own})` : own === theme ? "all" : "not all")
  }
}

/** 旧主题键要不要搬：新键里没有合法 theme、旧键是 light / dark 时返回旧键的值（规则同 piThemePrefOf） */
function legacyMigration(): PiThemePref | null {
  if (typeof window === "undefined") return null
  const stored = readStorage(PI_PREFS_KEY)
  if (storedThemeOf(stored)) return null
  const pref = piThemePrefOf(stored, readStorage(LEGACY_THEME_KEY))
  return pref === "system" ? null : pref
}

/** prefs.theme → 实际主题（"light" / "dark"），并接管 <html> 上的主题。act 引用要稳定（usePiUiState 的 act 就是） */
export function usePiTheme(pref: PiThemePref, act?: Pick<PiUiActions, "setPref">): "light" | "dark" {
  // 在 usePiUiState 把默认值写回存储之前读（第一次渲染）；写回新键以后（偏好不再是默认的 system）就不再用它
  const [migrating, setMigrating] = useState(legacyMigration)
  if (migrating && pref !== "system") setMigrating(null)
  useEffect(() => {
    if (migrating && pref === "system") act?.setPref("theme", migrating)
  }, [migrating, pref, act])
  const systemDark = useSyncExternalStore(subscribeDark, readDark, () => false)
  const effective = migrating ?? pref
  const theme = resolvePiTheme(effective, systemDark)
  useLayoutEffect(() => {
    applyPiTheme(document, theme, effective)
  }, [theme, effective])
  return theme
}
