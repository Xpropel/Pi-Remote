/**
 * 设置页 v2 · 上下文与本机偏好 store。
 *
 * Provider 只负责把宿主输入（p / style / theme / page / setPage / prefs / act）发给页面；
 * 页面无需自己接 relay、浮层或 localStorage，只调用 useSettings()。
 *
 * 持久化：useSettingsLocalState() 每次 setPref/mergePrefs/resetPrefs 后同步写
 * `pi_remote_pi_settings_v2`（不写旧版偏好键），并派发 SETTINGS_PREFS_EVENT 让宿主
 * （隐私 / 发送键）在本帧内换用新偏好。设置项没有「确定 / 取消」。
 *
 * 多标签页（MULTI-01）：写入前先读存储里的最新偏好，只把本次 patch 合并进去再写回，
 * 不再整包覆盖别的标签页刚改的字段；storage 事件把别页的改动同步进本页 state（不回声写回）。
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  loadSettingsLocal,
  mergeSettingsPrefs,
  mergeSettingsShortcuts,
  resetSettingsPrefs,
  replaceSettingsLocal,
  saveSettingsLocal,
  SETTINGS_PREFS_EVENT,
  SETTINGS_STORAGE_KEY,
  setSettingsPref,
  settingsPrefsEqual,
} from "./model.ts"
import type {
  SettingsContextValue,
  SettingsPrefs,
  SettingsPrefsActions,
  SettingsShortcutMap,
  SettingsStorage,
} from "./types.ts"

export interface SettingsProviderProps extends SettingsContextValue {
  children: ReactNode
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ p, style, theme, page, setPage, prefs, act, children }: SettingsProviderProps) {
  const value = useMemo<SettingsContextValue>(
    () => ({ p, style, theme, page, setPage, prefs, act }),
    [p, style, theme, page, setPage, prefs, act],
  )
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

/** 设置页子页面唯一入口；不在 Provider 内是编码错误，直接抛而不是静默降级。 */
export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (!value) throw new Error("useSettings 必须在 <SettingsProvider> 内使用")
  return value
}

function browserStorage(): SettingsStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

export interface UseSettingsLocalStateOptions {
  /** 测试 / 预览可注入；不传用 window.localStorage。 */
  storage?: SettingsStorage | null
  /** 首次挂载时覆盖一部分默认值（只影响第一次渲染）。 */
  initial?: Partial<SettingsPrefs>
}

/**
 * 本机偏好 state + 持久化动作。值只在这里改，页面拿到的 setPref 类型安全。
 * 每次动作先合并存储里的最新值再写，所以刷新 / 关闭再打开立即恢复，也不会覆盖别的标签页。
 */
export function useSettingsLocalState(options: UseSettingsLocalStateOptions = {}): [SettingsPrefs, SettingsPrefsActions] {
  const { storage, initial } = options
  const target = useCallback(() => (storage === undefined ? browserStorage() : storage), [storage])
  const [prefs, setPrefs] = useState<SettingsPrefs>(() => {
    const stored = loadSettingsLocal(target()).prefs
    return initial ? mergeSettingsPrefs(stored, initial) : stored
  })
  // 事件处理里要读到刚写出的值（同一个 tick 连点两次时 state 还没重渲染）。
  const latestPrefs = useRef(prefs)

  /** 写存储 + 同标签页广播；state 先更新，宿主在点击当帧就能回读。 */
  const commit = useCallback(
    (next: SettingsPrefs) => {
      latestPrefs.current = next
      setPrefs(next)
      if (!saveSettingsLocal(target(), next)) return
      if (typeof window !== "undefined") window.dispatchEvent(new Event(SETTINGS_PREFS_EVENT))
    },
    [target],
  )

  /**
   * 读最新存储 → 合并 patch → 写回。setPref 的 patch 是单字段；mergePrefs 是显式批量。
   * shortcuts 额外按动作合并，避免两个标签页各改一个动作时互相回退。
   */
  const applyPatch = useCallback(
    (patch: Partial<SettingsPrefs>) => {
      const latest = loadSettingsLocal(target()).prefs
      let effective = patch
      if (patch.shortcuts) {
        effective = {
          ...patch,
          shortcuts: mergeSettingsShortcuts(latestPrefs.current.shortcuts, latest.shortcuts, patch.shortcuts),
        }
      }
      commit(mergeSettingsPrefs(latest, effective))
    },
    [commit, target],
  )

  // `initial` 只覆盖第一次渲染；照旧把它并进最新存储（别的标签页可能已经先写过）。
  const initialPatch = useRef(initial)
  useEffect(() => {
    const patch = initialPatch.current
    if (!patch) return
    initialPatch.current = undefined
    const latest = loadSettingsLocal(target()).prefs
    const next = mergeSettingsPrefs(latest, patch)
    if (!settingsPrefsEqual(next, latestPrefs.current)) commit(next)
  }, [commit, target])

  const setPref = useCallback(
    function setPrefValue<K extends keyof SettingsPrefs>(key: K, value: SettingsPrefs[K]) {
      if (key === "shortcuts") {
        const latest = loadSettingsLocal(target()).prefs
        const shortcuts = mergeSettingsShortcuts(
          latestPrefs.current.shortcuts,
          latest.shortcuts,
          value as SettingsShortcutMap,
        )
        commit(mergeSettingsPrefs(latest, { shortcuts }))
        return
      }
      const latest = loadSettingsLocal(target()).prefs
      commit(setSettingsPref(latest, key, value))
    },
    [commit, target],
  )

  const mergePrefs = useCallback((patch: Partial<SettingsPrefs>) => applyPatch(patch), [applyPatch])

  const resetPrefs = useCallback(() => {
    commit(replaceSettingsLocal(target(), resetSettingsPrefs()))
  }, [commit, target])

  // 别的标签页写完 storage 事件：同步本页 state。只读、不回写（否则两页会互相回声）。
  useEffect(() => {
    if (typeof window === "undefined") return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SETTINGS_STORAGE_KEY && event.key !== null) return
      const latest = loadSettingsLocal(target()).prefs
      if (settingsPrefsEqual(latest, latestPrefs.current)) return
      latestPrefs.current = latest
      setPrefs(latest)
      window.dispatchEvent(new Event(SETTINGS_PREFS_EVENT))
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [target])

  const actions = useMemo<SettingsPrefsActions>(
    () => ({ setPref, mergePrefs, resetPrefs }),
    [setPref, mergePrefs, resetPrefs],
  )

  return [prefs, actions]
}
