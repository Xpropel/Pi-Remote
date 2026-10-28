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
import type { Relay } from "@/pi/containers/types"
import { useSettings } from "../SettingsContext.tsx"
import {
  SETTINGS_OVERLAY_STORAGE_KEY,
  SETTINGS_WRITE_OFFLINE_TEXT,
  SETTINGS_WRITE_OK_TEXT,
  SETTINGS_WRITE_PENDING_RESTART_TEXT,
  SETTINGS_WRITE_RELOAD_FALLBACK,
  flattenSettingsPatch,
  mergeSettingsApplied,
  recordSettingsOverlayApplied,
  reconcileSettingsOverlay,
  settingsCommandsReady,
  settingsHostVersionOf,
  settingsOverlayAppliedOf,
  settingsOverlayBookOf,
  settingsOverlayEnvelopeOf,
  settingsOverlayTargetKey,
  settingsReadErrorOf,
  isSettingsDocumentResponse,
  settingsFailureOf,
  settingsReadOnlyHintOf,
  settingsSetArgs,
  settingsSetResultOf,
  type SettingsApplied,
  type SettingsOverlayBook,
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

/** 目标标识：设置文件是设备级全局文件，优先按设备隔离，没设备时退回房间。 */
function overlayTargetOf(relay: Pick<Relay, "selectedDeviceId" | "roomId">): string {
  return settingsOverlayTargetKey({ deviceId: relay.selectedDeviceId, roomId: relay.roomId })
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
 * 读当前设备的全局设置。设备离线 / 会话未载入时保持 idle 且不发命令。
 * 换设备 / 换会话 / 手动 reload 都会重跑；卸载后晚到的回包丢弃。
 */
export function useSettingsDocument(relay: Relay): SettingsDocumentState {
  const ready = settingsCommandsReady(relay)
  const run = relay.runCommand
  const key = `${relay.selectedDeviceId ?? ""}|${relay.roomId ?? ""}`
  const target = overlayTargetOf(relay)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{
    phase: SettingsDocumentPhase
    data: unknown
    error: string
    failure: SettingsWriteFailure | null
    sig: string
  }>({ phase: "loading", data: undefined, error: "", failure: null, sig: "" })
  const sig = `${ready ? "on" : "off"}|${key}|${nonce}`

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
export function useSettingsWriter(relay: Relay): SettingsWriter {
  const { act } = useSettings()
  const { runCommand } = relay
  const ready = settingsCommandsReady(relay)
  const key = `${relay.selectedDeviceId ?? ""}|${relay.roomId ?? ""}`
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
        const data = await runCommand("settings_set", settingsSetArgs(patch))
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
    [act, optimistic, ready, runCommand, saving, target],
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
