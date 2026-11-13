/**
 * Settings > Devices > System operations -- state owner (one instance per
 * expanded device).
 *
 * Loads get_host_diag + get_pi_update_info on mount, sends the four mutating
 * commands through the existing device-command channel, and tracks the
 * attach-held operationStatus: while an operation runs it polls
 * get_operation_status every 2s -- the attach-direct read, because with an
 * active session get_host_diag is answered by the extension and its
 * fixed-shape reply carries no operationStatus (the diag field remains the
 * fallback for device builds without the status command). Polling tolerates
 * failures (restart_host / update_components take the device offline
 * mid-operation by design); on the terminal status it refreshes the update
 * info and the diag so the version block reflects the outcome. Unmounting
 * stops all polling; the persisted status is re-read on the next mount, so
 * closing and reopening the area loses nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { hostDiagErrorText } from "../../model/hostDiag.ts"
import type { DeviceLike } from "./devicesLogic.ts"
import {
  deviceBusyOf,
  IDLE_OPERATION_STATUS,
  normalizePiUpdateInfo,
  operationErrorTextOf,
  operationStartedStatusOf,
  operationStatusReplyOf,
  systemOpsDiagOf,
  SYSTEM_OPS_NO_COMMAND_TEXT,
  type DeviceBusy,
  type OperationKind,
  type OperationStatus,
  type PiUpdateInfo,
  type RoomBusyLike,
  type SystemOpsDiag,
} from "./systemOpsLogic.ts"

export interface SystemOpsRelayLike {
  runDeviceCommand?: (deviceId: string, command: string, args?: Record<string, unknown>) => Promise<unknown>
}

export interface SystemOpsDeviceLike extends DeviceLike {
  id: string
  features?: string[]
}

const POLL_MS = 2000

export interface UseSystemOps {
  loadPhase: "loading" | "ready" | "error"
  loadError: string
  diag: SystemOpsDiag | null
  update: PiUpdateInfo | null
  updateCheckError: string | null
  status: OperationStatus
  busy: DeviceBusy
  confirmKind: OperationKind | null
  setConfirmKind: (kind: OperationKind | null) => void
  /** Sends the confirmed command; rejects with a user-ready Error so the dialog can keep the error inside. */
  startOperation: (kind: OperationKind) => Promise<void>
  recheckUpdate: () => void
  reload: () => void
}

export function useSystemOps(relay: SystemOpsRelayLike, device: SystemOpsDeviceLike, rooms: readonly RoomBusyLike[]): UseSystemOps {
  const deviceId = device.id
  const relayRef = useRef(relay)
  relayRef.current = relay
  const aliveRef = useRef(true)
  const loadSeqRef = useRef(0)

  const [loadPhase, setLoadPhase] = useState<"loading" | "ready" | "error">("loading")
  const [loadError, setLoadError] = useState("")
  const [diag, setDiag] = useState<SystemOpsDiag | null>(null)
  const [update, setUpdate] = useState<PiUpdateInfo | null>(null)
  const [updateCheckError, setUpdateCheckError] = useState<string | null>(null)
  const [status, setStatus] = useState<OperationStatus>(IDLE_OPERATION_STATUS)
  const [confirmKind, setConfirmKind] = useState<OperationKind | null>(null)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const runCommand = useCallback(
    (command: string): Promise<unknown> => {
      const fn = relayRef.current.runDeviceCommand
      if (typeof fn !== "function") return Promise.reject(new Error(SYSTEM_OPS_NO_COMMAND_TEXT))
      return fn(deviceId, command)
    },
    [deviceId],
  )

  const fetchUpdate = useCallback(async () => {
    try {
      const info = normalizePiUpdateInfo(await runCommand("get_pi_update_info"))
      if (!aliveRef.current) return
      if (info) {
        setUpdate(info)
        setUpdateCheckError(null)
      } else {
        setUpdate(null)
        setUpdateCheckError("设备没有返回版本信息")
      }
    } catch (error) {
      if (!aliveRef.current) return
      setUpdate(null)
      setUpdateCheckError(operationErrorTextOf(error))
    }
  }, [runCommand])

  const loadAll = useCallback(
    async (initial: boolean) => {
      const seq = ++loadSeqRef.current
      const [diagResult] = await Promise.allSettled([
        runCommand("get_host_diag"),
        // The update check runs alongside; its failure is a row state, not a load failure.
        fetchUpdate(),
      ])
      if (!aliveRef.current || seq !== loadSeqRef.current) return
      if (diagResult.status === "fulfilled") {
        const next = systemOpsDiagOf(diagResult.value)
        if (next) {
          setDiag(next)
          // While an operation is tracked as running, a diag read that raced
          // its acceptance may still report the previous status; only adopt
          // statuses that belong to the same operation kind.
          setStatus((prev) => (prev.state === "running" && next.operationStatus.kind !== prev.kind ? prev : next.operationStatus))
          setLoadPhase("ready")
          setLoadError("")
          return
        }
      }
      if (initial) {
        setLoadPhase("error")
        setLoadError(diagResult.status === "rejected" ? hostDiagErrorText(diagResult.reason) : "没有可展示的设备数据")
      }
    },
    [runCommand, fetchUpdate],
  )

  // Initial load on mount / device change.
  useEffect(() => {
    setLoadPhase("loading")
    setDiag(null)
    setUpdate(null)
    setUpdateCheckError(null)
    setStatus(IDLE_OPERATION_STATUS)
    void loadAll(true)
  }, [loadAll])

  // One diag refresh, used when an operation lands: the version block and
  // the availability facts must reflect the post-operation device state.
  const refreshDiag = useCallback(async () => {
    try {
      const next = systemOpsDiagOf(await runCommand("get_host_diag"))
      if (next && aliveRef.current) setDiag(next)
    } catch {
      // The block keeps its last values; reopening the area reloads anyway.
    }
  }, [runCommand])

  // Poll the attach-held status while an operation runs.
  const running = status.state === "running"
  useEffect(() => {
    if (!running) return
    let cancelled = false
    const tick = async () => {
      let nextStatus: OperationStatus | null = null
      try {
        nextStatus = operationStatusReplyOf(await runCommand("get_operation_status"))
      } catch {
        // A device build without the status command, or the device is
        // mid-restart; the diag fallback below (or the next poll) covers it.
      }
      if (!nextStatus) {
        try {
          const nextDiag = systemOpsDiagOf(await runCommand("get_host_diag"))
          if (nextDiag) {
            if (!cancelled && aliveRef.current) setDiag(nextDiag)
            nextStatus = nextDiag.operationStatus
          }
        } catch {
          // Expected while restart_host / update_components hold the device
          // offline; the next poll reads the boot-completed status.
        }
      }
      if (cancelled || !aliveRef.current || !nextStatus) return
      setStatus(nextStatus)
      if (nextStatus.state === "succeeded" || nextStatus.state === "failed") {
        void fetchUpdate()
        void refreshDiag()
      }
    }
    const timer = window.setInterval(() => {
      void tick()
    }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [running, runCommand, fetchUpdate, refreshDiag])

  const startOperation = useCallback(
    async (kind: OperationKind) => {
      try {
        await runCommand(kind)
      } catch (error) {
        throw new Error(operationErrorTextOf(error))
      }
      if (!aliveRef.current) return
      setStatus(operationStartedStatusOf(kind, Date.now()))
    },
    [runCommand],
  )

  const recheckUpdate = useCallback(() => {
    setUpdate(null)
    setUpdateCheckError(null)
    void fetchUpdate()
  }, [fetchUpdate])

  const reload = useCallback(() => {
    void loadAll(loadPhase !== "ready")
  }, [loadAll, loadPhase])

  const busy = useMemo(() => deviceBusyOf(rooms, deviceId), [rooms, deviceId])

  return {
    loadPhase,
    loadError,
    diag,
    update,
    updateCheckError,
    status,
    busy,
    confirmKind,
    setConfirmKind,
    startOperation,
    recheckUpdate,
    reload,
  }
}
