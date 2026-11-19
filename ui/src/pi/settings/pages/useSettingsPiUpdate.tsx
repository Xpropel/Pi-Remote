/**
 * 设置 › Pi 升级 · React hook 与共享确认弹窗。
 *
 * 复用系统操作 `get_pi_update_info` / `update_pi` / `get_operation_status` 轮询协议，
 * 在模块级维护按设备隔离的状态 store，确保通用 / 关于 / 左侧导航条共享同一份实时版本与升级进度，
 * 且同一设备同一时刻只发起一条检查或一条轮询。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { settingsPiRestartTargetOf, type SettingsPiRestartRelay, type SettingsPiRestartTarget } from "./settingsPiRestart.ts"
import { SETTINGS_PI_UPDATE_TIMEOUT_TEXT, settingsPiUpdateRowOf } from "./settingsPiUpdate.ts"
import { notifySettingsPiRestarted } from "./settingsWriteHooks.ts"
import { SystemOpsConfirm } from "./SystemOpsConfirm.tsx"
import {
  IDLE_OPERATION_STATUS,
  normalizePiUpdateInfo,
  operationErrorTextOf,
  operationStartedStatusOf,
  operationStatusReplyOf,
  systemOpsDiagOf,
  type OperationStatus,
  type PiUpdateInfo,
} from "./systemOpsLogic.ts"

const POLL_MS = 2000
const MAX_WAIT_MS = 10 * 60_000
const AUTO_CHECK_TTL_MS = 60_000

export interface PiUpdateEntry {
  checking: boolean
  checkedAt: number
  update: PiUpdateInfo | null
  checkError: string | null
  status: OperationStatus
}

const IDLE_ENTRY: PiUpdateEntry = {
  checking: false,
  checkedAt: 0,
  update: null,
  checkError: null,
  status: IDLE_OPERATION_STATUS,
}

const entries = new Map<string, PiUpdateEntry>()
const activeChecks = new Map<string, Promise<void>>()
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

function entryFor(deviceId: string | null): PiUpdateEntry {
  if (!deviceId) return IDLE_ENTRY
  return entries.get(deviceId) ?? IDLE_ENTRY
}

function patchEntry(deviceId: string, patch: Partial<PiUpdateEntry>): PiUpdateEntry {
  const next = { ...entryFor(deviceId), ...patch }
  entries.set(deviceId, next)
  emitStore()
  return next
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
  notifyRef,
}: {
  deviceId: string
  roomId: string | null | undefined
  relayRef: { current: SettingsPiRestartRelay | null | undefined }
  notifyRef: { current: ((message: string, tone?: "warn" | "bad") => void) | undefined }
}): void {
  if (activePollers.has(deviceId)) return
  let cancelled = false
  const startedAt = Date.now()
  let seenRunning = entryFor(deviceId).status.state === "running" && entryFor(deviceId).status.kind === "update_pi"

  const finish = (nextStatus: OperationStatus) => {
    if (cancelled) return
    cancelled = true
    activePollers.delete(deviceId)
    window.clearInterval(timer)
    patchEntry(deviceId, { status: nextStatus })
    if (nextStatus.state === "succeeded") {
      notifySettingsPiRestarted(deviceId, roomId)
      const targetVer = entryFor(deviceId).update?.latestVersion
      notifyRef.current?.(targetVer ? `Pi 已更新到 ${targetVer} 并完成重启` : "Pi 已完成更新并重启")
      void checkDevicePiUpdate(deviceId, relayRef.current, { silent: true })
    } else if (nextStatus.state === "failed") {
      const errMsg = nextStatus.error || nextStatus.detail || "更新 Pi 失败"
      notifyRef.current?.(errMsg, "bad")
    }
  }

  const tick = async () => {
    if (cancelled) return
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      finish({
        state: "failed",
        kind: "update_pi",
        phase: null,
        startedAt,
        finishedAt: Date.now(),
        detail: null,
        error: SETTINGS_PI_UPDATE_TIMEOUT_TEXT,
      })
      return
    }

    const runDevice = relayRef.current?.runDeviceCommand
    if (typeof runDevice !== "function") return

    let nextStatus: OperationStatus | null = null
    try {
      nextStatus = operationStatusReplyOf(await runDevice(deviceId, "get_operation_status"))
    } catch {
      // 重启 Pi 或短暂断连窗口时允许超时/失败，等下一轮
    }
    if (!nextStatus && !cancelled) {
      try {
        const diag = systemOpsDiagOf(await runDevice(deviceId, "get_host_diag"))
        if (diag) nextStatus = diag.operationStatus
      } catch {
        // 预期中的重启窗口
      }
    }
    if (cancelled || !nextStatus || nextStatus.kind !== "update_pi") return

    if (nextStatus.state === "running") {
      seenRunning = true
      patchEntry(deviceId, { status: nextStatus })
      return
    }
    // 若尚未观察到本轮进入 running，丢弃 2 分钟之前的历史终态
    if (!seenRunning && typeof nextStatus.startedAt === "number" && nextStatus.startedAt > 0) {
      if (startedAt - nextStatus.startedAt > 120_000) return
    }
    if (nextStatus.state === "succeeded" || nextStatus.state === "failed") {
      finish(nextStatus)
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

async function checkDevicePiUpdate(
  deviceId: string,
  relay: SettingsPiRestartRelay | null | undefined,
  {
    silent,
    notify,
    relayRef,
    notifyRef,
  }: {
    silent: boolean
    notify?: (message: string, tone?: "warn" | "bad") => void
    relayRef?: { current: SettingsPiRestartRelay | null | undefined }
    notifyRef?: { current: ((message: string, tone?: "warn" | "bad") => void) | undefined }
  },
): Promise<void> {
  const existing = activeChecks.get(deviceId)
  if (existing) return existing

  const runDevice = relay?.runDeviceCommand
  if (typeof runDevice !== "function") return

  const promise = (async () => {
    patchEntry(deviceId, { checking: true })
    const [infoRes, statusRes] = await Promise.allSettled([
      runDevice(deviceId, "get_pi_update_info"),
      runDevice(deviceId, "get_operation_status"),
    ])

    let nextUpdate: PiUpdateInfo | null = null
    let nextError: string | null = null
    if (infoRes.status === "fulfilled") {
      nextUpdate = normalizePiUpdateInfo(infoRes.value)
      if (!nextUpdate) nextError = "设备没有返回版本信息"
    } else {
      nextError = operationErrorTextOf(infoRes.reason)
    }

    const opStatus = statusRes.status === "fulfilled" ? operationStatusReplyOf(statusRes.value) : null
    const patch: Partial<PiUpdateEntry> = {
      checking: false,
      checkedAt: Date.now(),
      update: nextUpdate,
      checkError: nextError,
    }
    if (opStatus && opStatus.state !== "idle") {
      patch.status = opStatus
    }
    patchEntry(deviceId, patch)

    if (opStatus && opStatus.state === "running" && opStatus.kind === "update_pi" && relayRef && notifyRef) {
      startPoller({
        deviceId,
        roomId: relayRef.current?.roomId,
        relayRef,
        notifyRef,
      })
    }

    if (!silent && notify) {
      if (nextError) {
        notify(`检查 Pi 更新失败：${nextError}`, "warn")
      } else if (nextUpdate && nextUpdate.installMethod !== "npm-global") {
        notify("当前设备的 Pi 非 npm 全局安装，请在终端手动升级", "warn")
      } else if (nextUpdate && !nextUpdate.latestVersion) {
        notify(`检查 Pi 更新失败：${nextUpdate.checkError || "无法连接 npm 注册表"}`, "warn")
      } else if (nextUpdate && nextUpdate.canUpdate && nextUpdate.latestVersion) {
        notify(`发现 Pi 新版本 ${nextUpdate.latestVersion}（当前 ${nextUpdate.currentVersion || "—"}）`)
      } else if (nextUpdate) {
        notify(`当前 Pi ${nextUpdate.currentVersion || nextUpdate.latestVersion || "—"} 已是最新版本`)
      }
    }
  })()

  activeChecks.set(deviceId, promise)
  try {
    await promise
  } finally {
    activeChecks.delete(deviceId)
  }
}

export interface UseSettingsPiUpdateResult {
  target: SettingsPiRestartTarget
  checking: boolean
  update: PiUpdateInfo | null
  checkError: string | null
  status: OperationStatus
  running: boolean
  confirmOpen: boolean
  setConfirmOpen: (open: boolean) => void
  recheck: () => void
  requestUpdate: () => void
  confirmUpdate: () => Promise<void>
  triggerPrimaryAction: (otherRunning?: boolean) => void
}

export function useSettingsPiUpdate(
  relay: SettingsPiRestartRelay | null | undefined,
  notify?: (message: string, tone?: "warn" | "bad") => void,
  options?: { autoCheck?: boolean },
): UseSettingsPiUpdateResult {
  useSyncExternalStore(subscribeStore, epochSnapshot, epochSnapshot)
  const relayRef = useRef(relay)
  relayRef.current = relay
  const notifyRef = useRef(notify)
  notifyRef.current = notify

  const target = settingsPiRestartTargetOf(relay)
  const entry = entryFor(target.deviceId)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const autoCheck = options?.autoCheck !== false

  useEffect(() => {
    if (!autoCheck || !target.canRestart || !target.deviceId) return
    const current = entryFor(target.deviceId)
    if (current.checking) return
    if (current.checkedAt > 0 && Date.now() - current.checkedAt < AUTO_CHECK_TTL_MS) return
    void checkDevicePiUpdate(target.deviceId, relayRef.current, {
      silent: true,
      relayRef,
      notifyRef,
    })
  }, [autoCheck, target.canRestart, target.deviceId, entry.checkedAt])

  const recheck = useCallback(() => {
    const currentRelay = relayRef.current
    const currentTarget = settingsPiRestartTargetOf(currentRelay)
    const deviceId = currentTarget.deviceId
    if (!deviceId || !currentTarget.canRestart || entryFor(deviceId).checking) return
    void checkDevicePiUpdate(deviceId, currentRelay, {
      silent: false,
      notify: (msg, tone) => notifyRef.current?.(msg, tone),
      relayRef,
      notifyRef,
    })
  }, [])

  const requestUpdate = useCallback(() => {
    const currentTarget = settingsPiRestartTargetOf(relayRef.current)
    const current = entryFor(currentTarget.deviceId)
    if (!currentTarget.canRestart || current.status.state === "running") return
    setConfirmOpen(true)
  }, [])

  const confirmUpdate = useCallback(async () => {
    const currentRelay = relayRef.current
    const currentTarget = settingsPiRestartTargetOf(currentRelay)
    const deviceId = currentTarget.deviceId
    if (!deviceId || !currentTarget.canRestart || typeof currentRelay?.runDeviceCommand !== "function") {
      throw new Error(currentTarget.reason || "当前无法更新 Pi")
    }
    try {
      await currentRelay.runDeviceCommand(deviceId, "update_pi")
    } catch (error: unknown) {
      throw new Error(operationErrorTextOf(error))
    }
    stopPoller(deviceId)
    patchEntry(deviceId, { status: operationStartedStatusOf("update_pi", Date.now()) })
    startPoller({
      deviceId,
      roomId: currentRelay.roomId,
      relayRef,
      notifyRef,
    })
  }, [])

  const triggerPrimaryAction = useCallback(
    (otherRunning = false) => {
      const currentTarget = settingsPiRestartTargetOf(relayRef.current)
      const current = entryFor(currentTarget.deviceId)
      const row = settingsPiUpdateRowOf({
        target: currentTarget,
        checking: current.checking,
        update: current.update,
        checkError: current.checkError,
        status: current.status,
        otherRunning: otherRunning === true,
        now: Date.now(),
      })
      if (row.disabled) return
      if (row.actionKind === "update") requestUpdate()
      else if (row.actionKind === "recheck") recheck()
    },
    [recheck, requestUpdate],
  )

  return {
    target,
    checking: entry.checking,
    update: entry.update,
    checkError: entry.checkError,
    status: entry.status,
    running: entry.status.state === "running" && entry.status.kind === "update_pi",
    confirmOpen,
    setConfirmOpen,
    recheck,
    requestUpdate,
    confirmUpdate,
    triggerPrimaryAction,
  }
}

export function SettingsPiUpdateDialog({
  viewport,
  piUpdate,
}: {
  viewport: "desktop" | "phone"
  piUpdate: Pick<UseSettingsPiUpdateResult, "confirmOpen" | "setConfirmOpen" | "target" | "update" | "confirmUpdate">
}) {
  return (
    <SystemOpsConfirm
      viewport={viewport}
      open={piUpdate.confirmOpen}
      onOpenChange={piUpdate.setConfirmOpen}
      kind="update_pi"
      deviceName={piUpdate.target.deviceName}
      busy={piUpdate.target.busy}
      update={piUpdate.update}
      onConfirm={piUpdate.confirmUpdate}
    />
  )
}
