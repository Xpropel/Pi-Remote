/**
 * reduced-motion 的 JS 分支（PLAN 4.5、design §4.7「减少动效」）。
 *
 * 用户系统设置了 `prefers-reduced-motion: reduce` 时，useReducedMotion() 为 true，下面四种运动由 JS 关掉
 * （调用方读 motionOf(reduced) 的结果，不要各自判断）：
 *   1. 240ms 页面转场（手机列表页 ↔ 会话页的推入 / 退出）：直接切换，pageTransitionMs = 0
 *   2. PiSheet 滑入：不做，sheetSlide = false（直接出现在终点）
 *   3. "已重新连接"等到时淡出的提示：到时直接消失，fadeOut = false（停留时长不变，只去掉淡出）
 *   4. 贴底滚动 / "回到底部"：scrollIntoView / scrollTo 用 behavior "auto"，scrollBehavior = "auto"
 * 不归这里管的：spinner 停转（显示静止半圆）、CSS 转场与淡出由 pi-theme.css 的
 * `@media (prefers-reduced-motion: reduce)` 负责，不需要 JS。
 *
 * 实现：matchMedia + useSyncExternalStore；没有 window / matchMedia（SSR、Node 单测）时按 false 处理。
 * 旧 Safari（< 14）的 MediaQueryList 没有 addEventListener，退回 addListener。
 *
 * In-app source (settings v2 `reducedMotion`): useReducedMotion() returns the OR of the
 * OS preference above and the in-app setting, so every consumer of usePiMotion() follows
 * both rails. The settings store is watched through its same-tab broadcast
 * (SETTINGS_PREFS_EVENT) plus cross-tab "storage" events, so toggling the setting in the
 * Appearance page applies live, without a reload. The CSS half of the in-app setting is
 * in pi-theme.css, keyed on the <html data-pi-reduced-motion="on"> attribute that
 * PiSettingsHost mirrors from the same pref.
 */
import { useSyncExternalStore } from "react"
import { loadSettingsLocal, SETTINGS_PREFS_EVENT, SETTINGS_STORAGE_KEY } from "../settings/model.ts"
import type { SettingsStorage } from "../settings/types.ts"

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)"

/** 正常动效下的页面转场时长（design §4.7） */
export const PAGE_TRANSITION_MS = 240

type MediaQueryListLike = {
  matches: boolean
  addEventListener?: (type: "change", listener: () => void) => void
  removeEventListener?: (type: "change", listener: () => void) => void
  addListener?: (listener: () => void) => void
  removeListener?: (listener: () => void) => void
}

export type MatchMediaLike = (query: string) => MediaQueryListLike

function defaultMatchMedia(): MatchMediaLike | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null
  return (query) => window.matchMedia(query)
}

/** 当前是否要求减少动效；拿不到 matchMedia 时为 false */
export function readReducedMotion(matchMedia: MatchMediaLike | null = defaultMatchMedia()): boolean {
  if (!matchMedia) return false
  try {
    return matchMedia(REDUCED_MOTION_QUERY).matches === true
  } catch {
    return false
  }
}

/** 订阅系统设置变化；返回取消订阅函数 */
export function subscribeReducedMotion(
  onChange: () => void,
  matchMedia: MatchMediaLike | null = defaultMatchMedia(),
): () => void {
  if (!matchMedia) return () => {}
  const mql = matchMedia(REDUCED_MOTION_QUERY)
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener?.("change", onChange)
  }
  if (typeof mql.addListener === "function") {
    mql.addListener(onChange)
    return () => mql.removeListener?.(onChange)
  }
  return () => {}
}

export interface PiMotion {
  /** 页面转场时长；0 = 直接切换 */
  pageTransitionMs: number
  /** sheet 是否滑入 */
  sheetSlide: boolean
  /** 到时消失的提示是否淡出 */
  fadeOut: boolean
  /** 贴底滚动的 behavior */
  scrollBehavior: "smooth" | "auto"
}

/** reduced → 四种运动的取值（见文件头） */
export function motionOf(reduced: boolean): PiMotion {
  return reduced
    ? { pageTransitionMs: 0, sheetSlide: false, fadeOut: false, scrollBehavior: "auto" }
    : { pageTransitionMs: PAGE_TRANSITION_MS, sheetSlide: true, fadeOut: true, scrollBehavior: "smooth" }
}

const subscribe = (onChange: () => void) => subscribeReducedMotion(onChange)
const getSnapshot = () => readReducedMotion()
const getServerSnapshot = () => false

/* ------------------------------------------------------------------ */
/* In-app setting source (settings v2 `reducedMotion`)                 */
/* ------------------------------------------------------------------ */

/** Storage of the settings v2 store; null when unavailable (SSR / Node tests / blocked). */
function settingsStorage(): SettingsStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

let inAppCache: { raw: string | null; reduced: boolean } | null = null

/** The in-app "reduce motion" pref from the settings v2 store; false when unreadable. */
function readInAppReducedMotion(): boolean {
  const storage = settingsStorage()
  if (!storage) return false
  let raw: string | null = null
  try {
    raw = storage.getItem(SETTINGS_STORAGE_KEY)
  } catch {
    return false
  }
  // getSnapshot runs on every render of every consumer; re-parse only when the raw value changed.
  if (inAppCache && inAppCache.raw === raw) return inAppCache.reduced
  const reduced = loadSettingsLocal(storage).prefs.reducedMotion === true
  inAppCache = { raw, reduced }
  return reduced
}

/** Watch the settings v2 store: same-tab writes broadcast SETTINGS_PREFS_EVENT; other tabs fire "storage". */
function subscribeInAppReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SETTINGS_STORAGE_KEY) onChange()
  }
  window.addEventListener(SETTINGS_PREFS_EVENT, onChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(SETTINGS_PREFS_EVENT, onChange)
    window.removeEventListener("storage", onStorage)
  }
}

const subscribeInApp = (onChange: () => void) => subscribeInAppReducedMotion(onChange)
const getInAppSnapshot = () => readInAppReducedMotion()

/** 系统是否要求减少动效；设置变化时组件重新渲染 */
export function useReducedMotion(): boolean {
  const system = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  // OR with the in-app setting (see the file header): either source reduces motion app-wide.
  const inApp = useSyncExternalStore(subscribeInApp, getInAppSnapshot, getServerSnapshot)
  return system || inApp
}

const MOTION_FULL = motionOf(false)
const MOTION_REDUCED = motionOf(true)

/** 部件直接用这个：当前的四种运动取值（= motionOf(useReducedMotion())，引用稳定） */
export function usePiMotion(): PiMotion {
  return useReducedMotion() ? MOTION_REDUCED : MOTION_FULL
}
