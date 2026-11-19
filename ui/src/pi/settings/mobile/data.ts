/**
 * 手机端设置 · 主机只读命令 hook（页面共用）。
 *
 * 优先走当前在线房间，无开放房间时回落到选中/在线设备的 attach 通道。
 * 未认证或设备离线时保持 idle 且不发命令。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  settingsCommandsReady,
  settingsFallbackDeviceIdOf,
  settingsRunCommand,
  type SettingsRelayLike,
} from "../pages/settingsWrite.ts"

export type HostCommandPhase = "idle" | "loading" | "ready" | "error"

export interface HostCommandState<T = unknown> {
  phase: HostCommandPhase
  data: T | undefined
  error: string
  reload: () => void
}

/** 设置 / 主机只读命令是否可跑（支持活跃房间 + attach 设备级回落）。 */
export function hostCommandsReady(relay: SettingsRelayLike): boolean {
  return settingsCommandsReady(relay)
}

function commandErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ""
  return message || "读取失败"
}

/**
 * 跑一条只读命令。`enabled=false` 时保持 idle 且不发命令；
 * 卸载后晚到的回包丢弃。`key` 变化（换会话/设备）会重跑。
 */
export function useHostCommand(
  relay: SettingsRelayLike | null | undefined,
  command: string | null,
  enabled = true,
  key = "",
): HostCommandState {
  const relayRef = useRef(relay)
  relayRef.current = relay
  const canRun = Boolean(command && enabled && relay && settingsCommandsReady(relay))
  const deviceKey = relay ? (relay.selectedDeviceId ?? settingsFallbackDeviceIdOf(relay) ?? "") : ""
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{ phase: HostCommandPhase; data: unknown; error: string; sig: string }>({
    phase: canRun ? "loading" : "idle",
    data: undefined,
    error: "",
    sig: "",
  })
  const sig = `${command ?? ""}|${canRun ? "on" : "off"}|${deviceKey}|${key}|${nonce}`

  useEffect(() => {
    if (!command || !canRun) return
    const targetRelay = relayRef.current
    if (!targetRelay) return
    let alive = true
    Promise.resolve()
      .then(() => settingsRunCommand(targetRelay, command))
      .then(
        (data: unknown) => {
          if (alive) setState({ phase: "ready", data, error: "", sig })
        },
        (error: unknown) => {
          if (alive) setState({ phase: "error", data: undefined, error: commandErrorText(error), sig })
        },
      )
    return () => {
      alive = false
    }
  }, [command, canRun, sig])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  if (!command || !canRun) return { phase: "idle", data: undefined, error: "", reload }
  const fresh = state.sig === sig
  return { phase: fresh ? state.phase : "loading", data: fresh ? state.data : undefined, error: fresh ? state.error : "", reload }
}
