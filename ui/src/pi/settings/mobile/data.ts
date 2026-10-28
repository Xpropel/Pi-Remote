/**
 * 手机端设置 · 主机只读命令 hook（页面共用）。
 *
 * 只封装 `relay.runCommand` 的一次只读调用；不缓存、不跨页共享。
 * 未认证 / 没有当前会话时命令为 null（不发送），页面按「读不到」显示 —，
 * 不把设计稿示例值当真实值。
 */
import { useEffect, useState } from "react"
import type { Relay } from "@/pi/containers/types"

export type HostCommandPhase = "idle" | "loading" | "ready" | "error"

export interface HostCommandState<T = unknown> {
  phase: HostCommandPhase
  data: T | undefined
  error: string
  reload: () => void
}

/** 当前会话已载入、设备命令能跑（与桌面 GeneralPage 的 ready 口径一致）。 */
export function hostCommandsReady(relay: Relay): boolean {
  return Boolean(
    relay.authed &&
      relay.browserOnline &&
      relay.online &&
      relay.roomId &&
      !(relay.lazySession && relay.lazySession.id === relay.roomId),
  )
}

function commandErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : ""
  return message || "读取失败"
}

/**
 * 跑一条只读命令。`enabled=false` 时保持 idle 且不发命令；
 * 卸载后晚到的回包丢弃。`key` 变化（换会话/设备）会重跑。
 * relay.runCommand 是 useCallback 稳定引用，放进依赖不会每帧重跑。
 */
export function useHostCommand(
  relay: Relay | null | undefined,
  command: string | null,
  enabled = true,
  key = "",
): HostCommandState {
  const run = relay?.runCommand
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{ phase: HostCommandPhase; data: unknown; error: string; sig: string }>({
    phase: command && enabled ? "loading" : "idle",
    data: undefined,
    error: "",
    sig: "",
  })
  const sig = `${command ?? ""}|${enabled ? "on" : "off"}|${key}|${nonce}`

  useEffect(() => {
    if (!command || !enabled || !run) return
    let alive = true
    // 新回包未到时由下方 fresh 判定直接给 loading，不在此同步 setState。
    // 通过事件循环把 runCommand 的同步抛错也收进 Promise 链。
    Promise.resolve()
      .then(() => run(command))
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
    // sig 已覆盖 command / enabled / key / nonce；run 是稳定引用。
  }, [run, command, enabled, sig])

  const reload = () => setNonce((value) => value + 1)
  if (!command || !enabled || !run) return { phase: "idle", data: undefined, error: "", reload }
  const fresh = state.sig === sig
  return { phase: fresh ? state.phase : "loading", data: fresh ? state.data : undefined, error: fresh ? state.error : "", reload }
}
