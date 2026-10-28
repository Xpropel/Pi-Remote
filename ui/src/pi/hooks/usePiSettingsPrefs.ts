/**
 * 设置页 v2 · 宿主读取本机偏好（React 接线）。
 *
 * 设置页把 `pi_remote_pi_settings_v2` 写在 localStorage；设置页与宿主不在同一份 React
 * 状态里，所以宿主用「同标签页事件 + storage 事件 + 交互事件 + 轻量轮询」观察同一份键：
 *   - 同标签页：设置页写完立即派发 SETTINGS_PREFS_EVENT，宿主同步回读（隐私 / 发送键当帧生效）；
 *   - 跨标签页：storage 事件；
 *   - 兜底：1 秒轮询一次（只比较原始字符串，没变就不 setState）。
 *
 * 只读不写：宿主绝不修改设置页的偏好对象；默认值 / 坏值校验统一走 settings/model.ts。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { readPiSettingsPrefs } from "../model/settingsHost.ts"
import { SETTINGS_PREFS_EVENT, SETTINGS_STORAGE_KEY } from "../settings/model.ts"
import type { SettingsPrefs, SettingsStorage } from "../settings/types.ts"

function browserStorage(): SettingsStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

interface PrefsSnapshot {
  raw: string | null
  prefs: SettingsPrefs
}

function readRaw(storage: SettingsStorage | null): string | null {
  if (!storage) return null
  try {
    return storage.getItem(SETTINGS_STORAGE_KEY)
  } catch {
    return null
  }
}

function snapshotOf(storage: SettingsStorage | null): PrefsSnapshot {
  const raw = readRaw(storage)
  return { raw, prefs: readPiSettingsPrefs(storage) }
}

export interface UsePiSettingsPrefsOptions {
  /** 测试 / 预览可注入；不传用 window.localStorage。 */
  storage?: SettingsStorage | null
  /** 轮询间隔（ms）；0 = 不轮询（跨标签页 / 交互事件仍生效）。 */
  pollMs?: number
}

export function usePiSettingsPrefs(options: UsePiSettingsPrefsOptions = {}): SettingsPrefs {
  const { storage, pollMs = 1000 } = options
  const target = useCallback(() => (storage === undefined ? browserStorage() : storage), [storage])
  const [snapshot, setSnapshot] = useState<PrefsSnapshot>(() => snapshotOf(target()))
  const latest = useRef(snapshot)
  useLayoutEffect(() => {
    latest.current = snapshot
  }, [snapshot])

  useEffect(() => {
    const refresh = () => {
      const storage = target()
      const raw = readRaw(storage)
      if (raw === latest.current.raw) return
      const next = { raw, prefs: readPiSettingsPrefs(storage) }
      latest.current = next
      setSnapshot(next)
    }
    document.addEventListener("click", refresh, true)
    document.addEventListener("keydown", refresh, true)
    document.addEventListener("input", refresh, true)
    document.addEventListener("change", refresh, true)
    // 设置页写完存储后立即广播：不必等轮询，隐私属性 / 发送键在点击当帧换用新偏好。
    window.addEventListener(SETTINGS_PREFS_EVENT, refresh)
    window.addEventListener("storage", refresh)
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    const timer = pollMs > 0 ? window.setInterval(refresh, pollMs) : null
    return () => {
      document.removeEventListener("click", refresh, true)
      document.removeEventListener("keydown", refresh, true)
      document.removeEventListener("input", refresh, true)
      document.removeEventListener("change", refresh, true)
      window.removeEventListener(SETTINGS_PREFS_EVENT, refresh)
      window.removeEventListener("storage", refresh)
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
      if (timer != null) window.clearInterval(timer)
    }
  }, [target, pollMs])

  return snapshot.prefs
}
