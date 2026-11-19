/**
 * 设置 › `settings_set` 写桥 · React 适配（页面共用；纯逻辑在 settingsWrite.ts）。
 *
 * - `useSettingsDocument`：只读 `get_settings`，保留错误分类（unknown_command / device_offline），
 *   页面据此显示「需更新扩展 / 需设备在线」并保持只读；
 * - `useSettingsWriter`：`relay.runCommand("settings_set", { patch })`，乐观更新 + 失败回滚 +
 *   「已保存，重启 pi 后生效」反馈。写成功后不重新拉 `get_settings`（DOC/76 §2.3）。
 * - 写成功的 applied 落进本地 overlay（`pi_remote_pi_settings_v2.write_overlay`）：运行中的 pi
 *   还读内存旧值时，页面仍显示已写入值；下一次 get_settings 读到新值 / 主机版本变化后自动收敛。
 *
 * 不写本机偏好（`pi_remote_pi_settings_v2`）；overlay 只存写桥白名单里的设置值，不打印正文 / token。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { useSettings } from "../SettingsContext.tsx"
import {
  SETTINGS_OVERLAY_STORAGE_KEY,
  SETTINGS_RESTART_APPLIED_TEXT,
  SETTINGS_WRITE_OFFLINE_TEXT,
  SETTINGS_WRITE_OK_TEXT,
  SETTINGS_WRITE_PENDING_RESTART_TEXT,
  SETTINGS_WRITE_RELOAD_FALLBACK,
  effectiveSettingsBoolOf,
  flattenSettingsPatch,
  mergeSettingsApplied,
  recordSettingsOverlayApplied,
  reconcileSettingsOverlay,
  settingsCommandsReady,
  settingsFallbackDeviceIdOf,
  settingsHostVersionOf,
  settingsOverlayAppliedOf,
  settingsOverlayBookOf,
  settingsOverlayEnvelopeOf,
  settingsOverlayTargetKey,
  settingsReadErrorOf,
  settingsRunCommand,
  isSettingsDocumentResponse,
  settingsFailureOf,
  settingsReadOnlyHintOf,
  settingsSetArgs,
  settingsSetResultOf,
  type SettingsApplied,
  type SettingsOverlayBook,
  type SettingsRelayLike,
  type SettingsSetSuccess,
  type SettingsWriteFailure,
} from "./settingsWrite.ts"

type Obj = Record<string, unknown>

/* ------------------------------------------------------------------ */
/* 待重启 overlay 的外部 store（localStorage 持久化 + 同页多 hook 同步） */
/* ------------------------------------------------------------------ */

let overlayBookCache: SettingsOverlayBook | null = null
const overlayListeners = new Set<() => void>()

function overlayStorage(): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
} | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

function overlayBookSnapshot(): SettingsOverlayBook {
  if (overlayBookCache) return overlayBookCache
  try {
    overlayBookCache = settingsOverlayBookOf(overlayStorage()?.getItem(SETTINGS_OVERLAY_STORAGE_KEY) ?? null)
  } catch {
    overlayBookCache = {}
  }
  return overlayBookCache
}

function commitOverlayBook(next: SettingsOverlayBook): void {
  if (next === overlayBookCache) return
  overlayBookCache = next
  try {
    const storage = overlayStorage()
    if (storage) {
      // 全部收敛后删除键，而不是留一份空信封。
      if (Object.keys(next).length === 0) storage.removeItem(SETTINGS_OVERLAY_STORAGE_KEY)
      else storage.setItem(SETTINGS_OVERLAY_STORAGE_KEY, settingsOverlayEnvelopeOf(next))
    }
  } catch {
    // 隐私模式 / 配额满：本会话内仍用内存 overlay，不阻断写设备设置。
  }
  for (const listener of overlayListeners) listener()
}

function subscribeOverlay(listener: () => void): () => void {
  overlayListeners.add(listener)
  return () => {
    overlayListeners.delete(listener)
  }
}

function commitOverlayApplied(target: string, applied: SettingsApplied): void {
  commitOverlayBook(recordSettingsOverlayApplied(overlayBookSnapshot(), target, applied))
}

/* ------------------------------------------------------------------ */
/* Pi 重启收敛信号：设置页触发 harness_restart 成功后，对齐状态与提示 */
/* ------------------------------------------------------------------ */

let restartEpoch = 0
let lastRestartedDeviceId = ""
const restartListeners = new Set<() => void>()
const restartedDeviceIds = new Set<string>()

function restartEpochSnapshot(): number {
  return restartEpoch
}

function subscribeRestart(listener: () => void): () => void {
  restartListeners.add(listener)
  return () => {
    restartListeners.delete(listener)
  }
}

/** 清除某个目标键下尚未生效的 overlay（例如 Pi 已完成重启后）。 */
export function clearSettingsOverlayTarget(target: string): void {
  if (!target) return
  const current = overlayBookSnapshot()
  if (!current[target]) return
  const next = { ...current }
  delete next[target]
  commitOverlayBook(next)
}

/** 通知所有设置 hook：指定设备上的 Pi 已完成重启，需要重新对齐运行态设置与提示。 */
export function notifySettingsPiRestarted(deviceId: string | null | undefined, roomId?: string | null): void {
  const id = (deviceId ?? "").trim()
  const rid = (roomId ?? "").trim()
  lastRestartedDeviceId = id
  if (id) {
    restartedDeviceIds.add(id)
    clearSettingsOverlayTarget(settingsOverlayTargetKey({ deviceId: id, roomId: rid || null }))
  }
  if (rid) {
    clearSettingsOverlayTarget(settingsOverlayTargetKey({ deviceId: null, roomId: rid }))
  }
  restartEpoch += 1
  for (const listener of restartListeners) listener()
}

/** 跨页面查询当前设置目标是否仍有「已写入待重启」的未生效变更。 */
export function useSettingsPendingRestart(relay: SettingsRelayLike): boolean {
  const target = overlayTargetOf(relay)
  const overlayBook = useSyncExternalStore(subscribeOverlay, overlayBookSnapshot, overlayBookSnapshot)
  return Object.keys(settingsOverlayAppliedOf(overlayBook, target)).length > 0
}

/** 目标标识：设置文件是设备级全局文件，优先按设备隔离，没设备时退回房间。 */
function overlayTargetOf(relay: SettingsRelayLike): string {
  const deviceId = relay.selectedDeviceId || settingsFallbackDeviceIdOf(relay)
  return settingsOverlayTargetKey({ deviceId, roomId: relay.roomId })
}

/**
 * 一次 get_settings 读完后收敛 overlay：先按运行中值移除已生效键，
 * 再（有 overlay 时）读主机版本，扩展 / pi 版本变了就整条作废。
 */
function reconcileOverlayAfterRead(
  target: string,
  data: unknown,
  isAlive: () => boolean,
  readHostDiag: (() => Promise<unknown> | null) | null,
): void {
  const current = overlayBookSnapshot()
  if (!current[target]) return
  const reconciled = reconcileSettingsOverlay({ book: current, target, data })
  if (reconciled.book !== current) commitOverlayBook(reconciled.book)
  if (!reconciled.book[target] || !readHostDiag) return

  let pending: Promise<unknown> | null = null
  try {
    pending = readHostDiag()
  } catch {
    pending = null
  }
  if (!pending) return
  void pending.then(
    (diag) => {
      if (!isAlive()) return
      const hostVersion = settingsHostVersionOf(diag)
      if (!hostVersion) return
      const latest = overlayBookSnapshot()
      if (!latest[target]) return
      const versioned = reconcileSettingsOverlay({ book: latest, target, data, hostVersion })
      if (versioned.book !== latest) commitOverlayBook(versioned.book)
    },
    () => {
      // 旧扩展 / 设备离线：没有版本签名就不做版本清除，overlay 仍按运行中值收敛。
    },
  )
}

export type SettingsDocumentPhase = "idle" | "loading" | "ready" | "error"

export interface SettingsDocumentState {
  phase: SettingsDocumentPhase
  data: unknown
  error: string
  failure: SettingsWriteFailure | null
  reload: () => void
}

/**
 * 读当前设备的全局设置。设备离线 / 无可用设备与房间时保持 idle 且不发命令。
 * 换设备 / 换会话 / 手动 reload 都会重跑；卸载后晚到的回包丢弃。
 */
export function useSettingsDocument(relay: SettingsRelayLike): SettingsDocumentState {
  const relayRef = useRef(relay)
  relayRef.current = relay
  const ready = settingsCommandsReady(relay)
  const fallbackDeviceId = settingsFallbackDeviceIdOf(relay)
  const run = useCallback(
    (command: string, args?: Record<string, unknown>) => settingsRunCommand(relayRef.current, command, args),
    [],
  )
  const key = `${relay.selectedDeviceId ?? fallbackDeviceId ?? ""}|${relay.roomId ?? ""}`
  const target = overlayTargetOf(relay)
  const restartedAt = useSyncExternalStore(subscribeRestart, restartEpochSnapshot, restartEpochSnapshot)
  const relayOnline = Boolean((relay as { online?: boolean }).online)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{
    phase: SettingsDocumentPhase
    data: unknown
    error: string
    failure: SettingsWriteFailure | null
    sig: string
  }>({ phase: "loading", data: undefined, error: "", failure: null, sig: "" })
  const sig = `${ready ? "on" : "off"}|${relayOnline ? "1" : "0"}|${key}|${nonce}|r${restartedAt}`

  useEffect(() => {
    if (!ready) return
    let alive = true
    Promise.resolve()
      .then(() => run("get_settings"))
      .then(
        (data) => {
          if (!alive) return
          if (!isSettingsDocumentResponse(data)) {
            const failure: SettingsWriteFailure = {
              kind: "error",
              code: "bad_response",
              text: "设置读取失败，暂时只读",
              detail: "设备回包缺少设置内容",
            }
            setState({ phase: "error", data: undefined, error: failure.text, failure, sig })
            return
          }
          setState({ phase: "ready", data, error: "", failure: null, sig })
          // 读成功才收敛 overlay；扩展内部读失败（settings:{} + error）不能当成「运行值已变」。
          // 版本探测走同一条房间命令，与 get_settings / settings_set 命中同一个 pi 进程。
          if (!settingsReadErrorOf(data)) {
            const resolvedDeviceId = (
              relayRef.current.selectedDeviceId ||
              settingsFallbackDeviceIdOf(relayRef.current) ||
              ""
            ).trim()
            if (resolvedDeviceId && restartedDeviceIds.has(resolvedDeviceId)) {
              clearSettingsOverlayTarget(target)
              restartedDeviceIds.delete(resolvedDeviceId)
            }
            reconcileOverlayAfterRead(target, data, () => alive, () => run("get_host_diag"))
          }
        },
        (error: unknown) => {
          if (!alive) return
          const failure = settingsFailureOf(error)
          setState({ phase: "error", data: undefined, error: failure.text, failure, sig })
        },
      )
    return () => {
      alive = false
    }
  }, [ready, run, sig, target])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  if (!ready) return { phase: "idle", data: undefined, error: "", failure: null, reload }
  const fresh = state.sig === sig
  return {
    phase: fresh ? state.phase : "loading",
    data: fresh ? state.data : undefined,
    error: fresh ? state.error : "",
    failure: fresh ? state.failure : null,
    reload,
  }
}

/** 宿主组件读取某个布尔设置（合并 get_settings 与待重启 overlay），无需处于 SettingsProvider 内。 */
export function useSettingsEffectiveBool(relay: SettingsRelayLike, path: string): boolean | null {
  const doc = useSettingsDocument(relay)
  const overlayBook = useSyncExternalStore(subscribeOverlay, overlayBookSnapshot, overlayBookSnapshot)
  const applied = settingsOverlayAppliedOf(overlayBook, overlayTargetOf(relay))
  return effectiveSettingsBoolOf(doc.data, applied, path)
}

/** 订阅当前设备最近一次已保存的默认模型键值，供新会话页在返回时即时重拉 get_available_models。 */
export function useAppliedDefaultModelKey(relay: SettingsRelayLike): string {
  const target = overlayTargetOf(relay)
  const book = useSyncExternalStore(subscribeOverlay, overlayBookSnapshot, overlayBookSnapshot)
  const applied = settingsOverlayAppliedOf(book, target)
  const p = typeof applied.defaultProvider === "string" ? applied.defaultProvider : ""
  const m = typeof applied.defaultModel === "string" ? applied.defaultModel : ""
  return p && m ? `${p}/${m}` : ""
}

export interface SettingsWriteFeedback {
  /** 触发保存的控件 id（同一页多组时用来把提示放在对应分组下）。 */
  id: string
  tone: "ok" | "warn" | "bad"
  text: string
  /** 重启说明（可点开看）；仅成功时有。 */
  hint?: string
  /** restartReason / 原始错误 message；仅作补充说明。 */
  detail?: string
}

/** 只取指定控件的反馈；其余分组的提示不在这里重复显示。 */
export function settingsFeedbackFor(
  feedback: SettingsWriteFeedback | null,
  ids: readonly string[],
): SettingsWriteFeedback | null {
  return feedback && ids.includes(feedback.id) ? feedback : null
}

export interface SettingsWriter {
  ready: boolean
  /** 正在保存的控件 id；非 null 时页面应禁用全部写控件。 */
  saving: string | null
  feedback: SettingsWriteFeedback | null
  /** 已确认写入（含跨页面持久化的 overlay）+ 本次保存中的乐观值；页面读值优先用它。 */
  applied: SettingsApplied
  /** 是否还有已写入但运行中的 pi 尚未生效的键（overlay 非空）。 */
  pendingRestart: boolean
  /** 已确认扩展不支持写入：整页保持只读并提示更新。 */
  unsupported: boolean
  canWrite: boolean
  save: (id: string, patch: Obj | null) => Promise<boolean>
}

/**
 * 写设备设置。`patch` 由 settingsWrite.ts 的映射函数生成；返回是否保存成功。
 * 失败一定回滚乐观值（不会把没写进去的值留在界面上，也不会写进 overlay）。
 */
export function useSettingsWriter(relay: SettingsRelayLike): SettingsWriter {
  const { act } = useSettings()
  const relayRef = useRef(relay)
  relayRef.current = relay
  const ready = settingsCommandsReady(relay)
  const fallbackDeviceId = settingsFallbackDeviceIdOf(relay)
  const key = `${relay.selectedDeviceId ?? fallbackDeviceId ?? ""}|${relay.roomId ?? ""}`
  const target = overlayTargetOf(relay)
  const overlayBook = useSyncExternalStore(subscribeOverlay, overlayBookSnapshot, overlayBookSnapshot)
  const overlayApplied = useMemo(() => settingsOverlayAppliedOf(overlayBook, target), [overlayBook, target])
  const [saving, setSaving] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<SettingsWriteFeedback | null>(null)
  // 只放本次保存中的乐观值；落盘确认的部分在 overlay（跨页面 / 刷新保留）。
  const [optimistic, setOptimistic] = useState<SettingsApplied>({})
  const [unsupported, setUnsupported] = useState(false)
  const [offline, setOffline] = useState(false)
  // 同一 tick 的连点也要拦住：state 更新要等下一次渲染，不能用 saving 单独兜底。
  const busyRef = useRef(false)
  const restartedAt = useSyncExternalStore(subscribeRestart, restartEpochSnapshot, restartEpochSnapshot)
  const prevRestartRef = useRef(restartedAt)
  const applied = useMemo(() => mergeSettingsApplied(overlayApplied, optimistic), [overlayApplied, optimistic])
  const pendingRestart = Object.keys(overlayApplied).length > 0

  // 换设备 / 换会话：上一台的乐观值不能留在这一台；overlay 按目标隔离，无需清。
  useEffect(() => {
    setSaving(null)
    setFeedback(null)
    setOptimistic({})
    setUnsupported(false)
    setOffline(false)
  }, [key])

  // 设置页触发 Pi 重启并成功后，将原本的「待重启」成功提示收敛为「已生效」。
  useEffect(() => {
    if (restartedAt === prevRestartRef.current) return
    prevRestartRef.current = restartedAt
    const currentDeviceId = (relayRef.current.selectedDeviceId || settingsFallbackDeviceIdOf(relayRef.current) || "").trim()
    if (lastRestartedDeviceId && currentDeviceId && lastRestartedDeviceId !== currentDeviceId) return
    setFeedback((prev) =>
      prev && prev.text === SETTINGS_WRITE_OK_TEXT
        ? {
            id: prev.id,
            tone: "ok",
            text: SETTINGS_RESTART_APPLIED_TEXT,
          }
        : prev,
    )
  }, [restartedAt])

  const save = useCallback(
    async (id: string, patch: Obj | null) => {
      if (!patch || Object.keys(patch).length === 0) {
        setFeedback({ id, tone: "warn", text: "没有可保存的改动" })
        return false
      }
      if (!ready) {
        setFeedback({ id, tone: "warn", text: SETTINGS_WRITE_OFFLINE_TEXT })
        return false
      }
      if (saving || busyRef.current) return false

      // 失败 / 结果未知时回到保存前的乐观快照；overlay 只在确认成功后追加。
      const before = optimistic
      busyRef.current = true
      const optimisticPatch = flattenSettingsPatch(patch)
      setOptimistic(mergeSettingsApplied(before, optimisticPatch))
      setSaving(id)
      setFeedback(null)

      let result: SettingsSetSuccess | null = null
      try {
        const data = await settingsRunCommand(relayRef.current, "settings_set", settingsSetArgs(patch))
        result = settingsSetResultOf(data)
        if (!result) {
          setOptimistic(before)
          setFeedback({ id, tone: "warn", text: "写入结果无法确认；请重启 pi 后检查设置是否生效" })
          act.notify("写入结果无法确认，请重启 pi 后检查设置", "warn")
          return false
        }
        // 回包没带 applied 但 ok:true 时，以实际发送的 patch 为准（扩展契约总是回 applied）。
        const confirmed = Object.keys(result.applied).length > 0 ? result.applied : optimisticPatch
        // 先落 overlay 再撤乐观值，避免中间一帧闪回 get_settings 的旧值。
        commitOverlayApplied(target, confirmed)
        setOptimistic(before)
        setFeedback({
          id,
          tone: "ok",
          text: SETTINGS_WRITE_OK_TEXT,
          hint: result.reloadHint || SETTINGS_WRITE_RELOAD_FALLBACK,
          detail: result.restartReason || undefined,
        })
        return true
      } catch (error: unknown) {
        const failure = settingsFailureOf(error)
        setOptimistic(before)
        if (failure.kind === "unsupported") setUnsupported(true)
        if (failure.kind === "offline") setOffline(true)
        setFeedback({
          id,
          tone:
            failure.kind === "unsupported" || failure.kind === "offline" || failure.kind === "unknown_result"
              ? "warn"
              : "bad",
          text: failure.text,
          detail: failure.detail && failure.detail !== failure.text ? failure.detail : undefined,
        })
        act.notify(failure.text, failure.kind === "unsupported" || failure.kind === "offline" ? "warn" : "bad")
        return false
      } finally {
        busyRef.current = false
        setSaving(null)
      }
    },
    [act, optimistic, ready, saving, target],
  )

  return useMemo(
    () => ({
      ready,
      saving,
      feedback,
      applied,
      pendingRestart,
      unsupported,
      canWrite: ready && !unsupported && !offline,
      save,
    }),
    [ready, saving, feedback, applied, pendingRestart, unsupported, offline, save],
  )
}

/**
 * 页面写桥说明：读失败 / 写不支持优先；都没有但 overlay 里还有待重启的键时，
 * 给一句常驻说明（重进页面后不会只剩「看起来已生效」的开关）。
 */
export function readOnlyHintOf(document: SettingsDocumentState, writer: SettingsWriter): string | null {
  const hint = settingsReadOnlyHintOf({
    ready: writer.ready,
    phase: document.phase,
    failure: document.failure,
    unsupported: writer.unsupported,
  })
  if (hint) return hint
  return writer.pendingRestart ? SETTINGS_WRITE_PENDING_RESTART_TEXT : null
}

export interface SettingsCommandState<T = unknown> {
  phase: SettingsDocumentPhase
  data: T | undefined
  error: string
  reload: () => void
}

/**
 * 执行一条设置只读命令：优先走当前在线房间，无开放房间时自动回落到选中/在线设备的 attach 通道。
 */
export function useSettingsCommand<T = unknown>(
  relay: SettingsRelayLike | null | undefined,
  command: string | null,
  enabled = true,
  extraKey = "",
): SettingsCommandState<T> {
  const relayRef = useRef(relay)
  relayRef.current = relay
  const ready = Boolean(relay && enabled && command && settingsCommandsReady(relay))
  const fallbackDeviceId = relay ? settingsFallbackDeviceIdOf(relay) : null
  const key = `${relay?.selectedDeviceId ?? fallbackDeviceId ?? ""}|${relay?.roomId ?? ""}|${extraKey}`
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{ phase: SettingsDocumentPhase; data: T | undefined; error: string; sig: string }>({
    phase: ready ? "loading" : "idle",
    data: undefined,
    error: "",
    sig: "",
  })
  const sig = `${command ?? ""}|${ready ? "on" : "off"}|${key}|${nonce}`

  useEffect(() => {
    if (!ready || !command) return
    const targetRelay = relayRef.current
    if (!targetRelay) return
    let alive = true
    Promise.resolve()
      .then(() => settingsRunCommand(targetRelay, command))
      .then(
        (data) => {
          if (alive) setState({ phase: "ready", data: data as T, error: "", sig })
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message.trim() : ""
          if (alive) setState({ phase: "error", data: undefined, error: message || "读取失败", sig })
        },
      )
    return () => {
      alive = false
    }
  }, [ready, command, sig])

  const reload = useCallback(() => setNonce((value) => value + 1), [])
  if (!ready || !command) return { phase: "idle", data: undefined, error: "", reload }
  const fresh = state.sig === sig
  return {
    phase: fresh ? state.phase : "loading",
    data: fresh ? state.data : undefined,
    error: fresh ? state.error : "",
    reload,
  }
}
