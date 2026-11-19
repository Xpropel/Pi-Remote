import { useEffect, useState } from "react"
import { commandErrorText } from "@/pi/containers/cShared"
import { useSettings } from "../SettingsContext.tsx"
import { parsePreventSleepData, preventSleepViewOf, type PreventSleepState } from "./deviceBehavior.ts"
import { settingsRunCommand, type SettingsRelayLike } from "./settingsWrite.ts"

export interface PreventSleepQueryLike {
  phase: "idle" | "loading" | "ready" | "error"
  data: unknown
  error?: string
  reload: () => void
}

export function usePreventSleepToggle(
  relay: SettingsRelayLike,
  ready: boolean,
  query: PreventSleepQueryLike,
) {
  const { act } = useSettings()
  const deviceKey = relay.selectedDeviceId ?? ""
  const [optimistic, setOptimistic] = useState<{ key: string; state: PreventSleepState } | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setOptimistic(null)
    setSaving(false)
  }, [deviceKey])

  const queryState = parsePreventSleepData(query.data)
  const effectiveState = optimistic?.key === deviceKey ? optimistic.state : queryState
  const view = preventSleepViewOf({
    ready,
    phase: query.phase,
    errorText: query.error || undefined,
    state: effectiveState,
    saving,
  })

  const toggle = async (nextEnabled: boolean) => {
    if (view.disabled) return
    setSaving(true)
    try {
      const result = await settingsRunCommand(relay, "set_prevent_sleep", { enabled: nextEnabled })
      const nextState = parsePreventSleepData(result) ?? {
        supported: true,
        enabled: nextEnabled,
        active: nextEnabled,
        tool: effectiveState?.tool ?? null,
      }
      setOptimistic({ key: deviceKey, state: nextState })
      query.reload()
      act.notify(nextEnabled ? "已开启被控设备防休眠" : "已关闭被控设备防休眠")
    } catch (error) {
      act.notify(`防休眠设置失败：${commandErrorText(error)}`, "bad")
    } finally {
      setSaving(false)
    }
  }

  return { ...view, toggle }
}
