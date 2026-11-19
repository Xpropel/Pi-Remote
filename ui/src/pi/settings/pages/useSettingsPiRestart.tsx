/**
 * 设置 › Pi 重启 · React hook 与共享确认弹窗。
 *
 * 复用系统操作 `harness_restart` + `get_operation_status` / `get_host_diag` 轮询协议，
 * 在模块级维护按设备隔离的运行状态，确保同一时间各设置入口（左栏、页内提示条、
 * 通用、模型与会话）看到一致的「重启中 / 已生效 / 失败」状态且只跑一条轮询器。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { notifySettingsPiRestarted, useSettingsPendingRestart } from "./settingsWriteHooks.ts"
import {
  SETTINGS_PI_RESTART_TIMEOUT_TEXT,
  settingsPiRestartTargetOf,
  type SettingsPiRestartPhase,
  type SettingsPiRestartRelay,
  type SettingsPiRestartTarget,
} from "./settingsPiRestart.ts"
import { SystemOpsConfirm } from "./SystemOpsConfirm.tsx"
import {
  operationErrorTextOf,
  operationStatusReplyOf,
  systemOpsDiagOf,
  type OperationStatus,
} from "./systemOpsLogic.ts"

const POLL_MS = 2000
const MAX_WAIT_MS = 90_000

export interface PiRestartEntry {
  phase: SettingsPiRestartPhase
  error: string
  startedAt: number
}

const IDLE_ENTRY: PiRestartEntry = { phase: "idle", error: "", startedAt: 0 }

const entries = new Map<string, PiRestartEntry>()
const activePollers = new Map<string, () => void>()
const storeListeners = new Set<() => void>()
let storeEpoch = 0

function emitStore(): void {
  storeEpoch += 1
  for (const listener of storeListeners) listener()
}

function subscribeStore(listener: () => void): () => void {
  storeListeners.add(listener)
  return () => {
    storeListeners.delete(listener)
  }
}

function epochSnapshot(): number {
  return storeEpoch
}

function entryFor(deviceId: string | null): PiRestartEntry {
  if (!deviceId) return IDLE_ENTRY
  return entries.get(deviceId) ?? IDLE_ENTRY
}

function setEntry(deviceId: string, next: PiRestartEntry): void {
  entries.set(deviceId, next)
  emitStore()
}

function stopPoller(deviceId: string): void {
  const stop = activePollers.get(deviceId)
  if (!stop) return
  activePollers.delete(deviceId)
  stop()
}

function startPoller({
  deviceId,
  roomId,
  relayRef,
  notify,
}: {
  deviceId: string
  roomId: string | null | undefined
  relayRef: { current: SettingsPiRestartRelay | null | undefined }
  notify?: (message: string, tone?: "warn" | "bad") => void
}): void {
  stopPoller(deviceId)
  let cancelled = false
  const startedAt = Date.now()
  let seenRunning = false

  const finish = (phase: "succeeded" | "failed", error: string) => {
    if (cancelled) return
    cancelled = true
    activePollers.delete(deviceId)
    window.clearInterval(timer)
    setEntry(deviceId, { phase, error, startedAt })
    if (phase === "succeeded") {
      notifySettingsPiRestarted(deviceId, roomId)
      notify?.("Pi 已重启，已保存的设置已生效")
    } else if (error) {
      notify?.(error, "bad")
    }
  }

  const tick = async () => {
    if (cancelled) return
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      finish("failed", SETTINGS_PI_RESTART_TIMEOUT_TEXT)
      return
    }
    const runDevice = relayRef.current?.runDeviceCommand
    if (typeof runDevice !== "function") return

    let nextStatus: OperationStatus | null = null
    try {
      nextStatus = operationStatusReplyOf(await runDevice(deviceId, "get_operation_status"))
    } catch {
      // 设备重启或短暂离线阶段可能无响应，走下方 host_diag 回退或等下一轮。
    }
    if (!nextStatus && !cancelled) {
      try {
        const diag = systemOpsDiagOf(await runDevice(deviceId, "get_host_diag"))
        if (diag) nextStatus = diag.operationStatus
      } catch {
        // 预期中的重启断连窗口，等待下一轮。
      }
    }
    if (cancelled || !nextStatus) return
    if (nextStatus.kind !== "harness_restart") return
    if (nextStatus.state === "running") {
      seenRunning = true
      return
    }
    // 防止在旧重启状态残留、未经过 running 就立即读到上一次 succeeded 时误判，
    // 但若没有历史 finishedAt 或处于当前窗口内则直接收敛。
    if (!seenRunning && typeof nextStatus.startedAt === "number" && nextStatus.startedAt > 0) {
      if (startedAt - nextStatus.startedAt > 120_000) return
    }
    if (nextStatus.state === "succeeded") {
      finish("succeeded", "")
      return
    }
    if (nextStatus.state === "failed") {
      finish("failed", nextStatus.error || nextStatus.detail || "重启 Pi 失败")
    }
  }

  const timer = window.setInterval(() => {
    void tick()
  }, POLL_MS)
  activePollers.set(deviceId, () => {
    cancelled = true
    window.clearInterval(timer)
  })
}

export interface UseSettingsPiRestartResult {
  target: SettingsPiRestartTarget
  pendingRestart: boolean
  phase: SettingsPiRestartPhase
  error: string
  running: boolean
  confirmOpen: boolean
  setConfirmOpen: (open: boolean) => void
  requestRestart: () => void
  confirmRestart: () => Promise<void>
  resetFeedback: () => void
}

export function useSettingsPiRestart(
  relay: SettingsPiRestartRelay | null | undefined,
  notify?: (message: string, tone?: "warn" | "bad") => void,
): UseSettingsPiRestartResult {
  useSyncExternalStore(subscribeStore, epochSnapshot, epochSnapshot)
  const relayRef = useRef(relay)
  relayRef.current = relay
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  const target = settingsPiRestartTargetOf(relay)
  const pendingRestart = useSettingsPendingRestart(relay ?? {})
  const entry = entryFor(target.deviceId)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // 一旦在成功之后又有新的未生效写入（pendingRestart 由 false 变成 true），清理上次的「已重启」态。
  const prevPendingRef = useRef(pendingRestart)
  useEffect(() => {
    if (!prevPendingRef.current && pendingRestart && target.deviceId) {
      const current = entryFor(target.deviceId)
      if (current.phase === "succeeded") {
        setEntry(target.deviceId, IDLE_ENTRY)
      }
    }
    prevPendingRef.current = pendingRestart
  }, [pendingRestart, target.deviceId])

  const requestRestart = useCallback(() => {
    if (!target.canRestart || entry.phase === "running") return
    setConfirmOpen(true)
  }, [entry.phase, target.canRestart])

  const confirmRestart = useCallback(async () => {
    const currentRelay = relayRef.current
    const currentTarget = settingsPiRestartTargetOf(currentRelay)
    const deviceId = currentTarget.deviceId
    if (!deviceId || !currentTarget.canRestart || typeof currentRelay?.runDeviceCommand !== "function") {
      throw new Error(currentTarget.reason || "当前无法重启 Pi")
    }
    try {
      await currentRelay.runDeviceCommand(deviceId, "harness_restart")
    } catch (error: unknown) {
      throw new Error(operationErrorTextOf(error))
    }
    setEntry(deviceId, { phase: "running", error: "", startedAt: Date.now() })
    startPoller({
      deviceId,
      roomId: currentRelay.roomId,
      relayRef,
      notify: (msg, tone) => notifyRef.current?.(msg, tone),
    })
  }, [])

  const resetFeedback = useCallback(() => {
    if (!target.deviceId) return
    const current = entryFor(target.deviceId)
    if (current.phase === "running") return
    if (current.phase !== "idle" || current.error) {
      setEntry(target.deviceId, IDLE_ENTRY)
    }
  }, [target.deviceId])

  return {
    target,
    pendingRestart,
    phase: entry.phase,
    error: entry.error,
    running: entry.phase === "running",
    confirmOpen,
    setConfirmOpen,
    requestRestart,
    confirmRestart,
    resetFeedback,
  }
}

export function SettingsPiRestartDialog({
  viewport,
  restart,
}: {
  viewport: "desktop" | "phone"
  restart: Pick<UseSettingsPiRestartResult, "confirmOpen" | "setConfirmOpen" | "target" | "confirmRestart">
}) {
  return (
    <SystemOpsConfirm
      viewport={viewport}
      open={restart.confirmOpen}
      onOpenChange={restart.setConfirmOpen}
      kind="harness_restart"
      deviceName={restart.target.deviceName}
      busy={restart.target.busy}
      update={null}
      onConfirm={restart.confirmRestart}
    />
  )
}
