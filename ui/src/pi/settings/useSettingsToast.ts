/**
 * 设置页内轻提示的状态（桌面 / 手机共用）；渲染见 toast.tsx。
 *
 * 设置是盖住整个外壳的全屏层：宿主的通知槽、状态行和输入框状态行都在它下面，
 * act.notify 的结果（设为默认、导出、清缓存、写入失败等）必须在设置页里自己露出来。
 */
import { useCallback, useEffect, useRef, useState } from "react"

export type SettingsToastTone = "ok" | "warn" | "bad"

export interface SettingsToastState {
  key: number
  text: string
  tone: SettingsToastTone
  leaving: boolean
}

const SHOW_MS = 3200
const SHOW_BAD_MS = 5200
/** 与退场动效时长一致（motion：进 160ms / 出 120ms）。 */
const LEAVE_MS = 120

export function useSettingsToast(): {
  toast: SettingsToastState | null
  show: (text: string, tone?: "warn" | "bad") => void
} {
  const [toast, setToast] = useState<SettingsToastState | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const id of pending) window.clearTimeout(id)
    }
  }, [])

  const show = useCallback((text: string, tone?: "warn" | "bad") => {
    for (const id of timers.current.splice(0)) window.clearTimeout(id)
    if (!text) {
      setToast(null)
      return
    }
    const nextTone: SettingsToastTone = tone ?? "ok"
    setToast((prev) => ({ key: (prev?.key ?? 0) + 1, text, tone: nextTone, leaving: false }))
    const life = nextTone === "bad" ? SHOW_BAD_MS : SHOW_MS
    timers.current.push(
      window.setTimeout(() => setToast((prev) => (prev ? { ...prev, leaving: true } : prev)), life),
      window.setTimeout(() => setToast(null), life + LEAVE_MS),
    )
  }, [])

  return { toast, show }
}
