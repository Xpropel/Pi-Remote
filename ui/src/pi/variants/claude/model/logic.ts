import { useEffect, useMemo, useState } from "react"
import type { PiContainerProps, Relay } from "@/pi/containers/types"
import { settingsWritesOf, type PiSettingsPrefs } from "@/pi/model/settingsView"
import { modelRowsOf, thinkingSegmentsOf } from "@/pi/model/models"
import { platformTabOfDeviceId } from "./platformUi"
import { setClaudeWorkspaceMode } from "./uiMemory"

/**
 * Claude v2 · 允许复用的纯逻辑适配（只借数据/计算方法，不借任何 cursor 可见组件）：
 * - useCommand：只读命令的一次性取数（等价 v1 cShared 的 useRelayCommand，自实现）
 * - useLegacyStyle / writeLegacyStyle：旧键 pi_remote_style 的三项（model/legacyStyle 纯函数）
 * - useSettingsPrefs / usePrefsWriter：设置页读写口径（model/settingsView 纯函数）
 * - useModelMenuData：模型 / 思考级别菜单数据（model/models 纯函数 + relay.runCommand）
 */

export type CommandPhase = "idle" | "loading" | "error" | "ready"

export interface CommandData {
  phase: CommandPhase
  data: unknown
  error: string
}

/** 跑一条只读命令拿回包：command 为 null 时不跑；key 变了重跑；晚到的旧回包丢弃 */
export function useCommand(run: Relay["runCommand"], command: string | null, args?: Record<string, unknown>, key = ""): CommandData {
  const [state, setState] = useState<{ phase: CommandPhase; data: unknown; error: string; sig: string }>({ phase: command ? "loading" : "idle", data: undefined, error: "", sig: "" })
  const argsKey = JSON.stringify(args ?? null)
  const sig = `${command ?? ""}|${argsKey}|${key}`
  useEffect(() => {
    if (!command) return
    let alive = true
    Promise.resolve()
      .then(() => run(command, args ?? undefined))
      .then(
        (data) => {
          if (alive) setState({ phase: "ready", data, error: "", sig })
        },
        (error: unknown) => {
          if (alive) setState({ phase: "error", data: undefined, error: error instanceof Error ? error.message : "命令失败", sig })
        },
      )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig])
  if (state.sig !== sig) return { phase: command ? "loading" : "idle", data: undefined, error: "" }
  return { phase: state.phase, data: state.data, error: state.error }
}

/* ---------------------------------------------------------------- 设置页读写 */

export function settingsPrefsFor(p: Pick<PiContainerProps, "ui" | "relay">): PiSettingsPrefs {
  return {
    ui: p.ui.prefs.ui,
    theme: p.ui.prefs.theme,
    fontSize: "standard",
    density: p.ui.prefs.density,
    busyDelivery: p.relay.sendMode === "follow_up" ? "follow_up" : "steer",
    // v2 独立性：不直接读写旧键 pi_remote_style（浏览器存储），"排队消息立即发送"的旧键档位不再提供开关
    sendNow: "interrupt",
    dialogRemote: p.ui.prefs.dialogRemoteAnswer,
    sound: p.ui.prefs.completionSound,
    deviceFilter: p.ui.prefs.deviceFilter ?? "all",
    grouping: p.ui.prefs.grouping,
  }
}

/** 偏好改动 → 写到该写的地方（新偏好键 / 旧键三项 / relay.sendMode）；口径来自 model/settingsView */
export function writePrefs(p: Pick<PiContainerProps, "act" | "relay">, patch: Partial<PiSettingsPrefs>) {
  for (const write of settingsWritesOf(patch)) {
    if (write.kind === "pref") (p.act.setPref as (key: string, value: unknown) => void)(write.key, write.value)
    else if (write.kind === "sendMode") p.relay.setSendMode(write.value)
    // 独立性约束：不直接碰浏览器存储（旧键 legacy 写入跳过；新偏好键已由上面的 pref 写入维护）
  }
}

/* ---------------------------------------------------------------- 模型菜单 */

export type ModelMenuData = {
  rows: ReturnType<typeof modelRowsOf>
  segments: { value: string; label: string }[]
  loading: boolean
}

/** 模型 / 思考级别菜单的数据（菜单打开时才拉；关掉时返回空但保留上次数据不闪） */
export function useModelMenuData(relay: Relay, open: boolean): ModelMenuData {
  const ready = open && relay.authed && relay.online && !!relay.roomId && !relay.lazySession
  const models = useCommand(relay.runCommand, ready ? "get_available_models" : null, undefined, relay.roomId)
  const levels = useCommand(relay.runCommand, ready ? "get_available_thinking_levels" : null, undefined, `${relay.roomId}|${relay.model}`)
  const rows = useMemo(
    () => (models.phase === "ready" ? modelRowsOf(models.data, { model: relay.model, modelMeta: relay.modelMeta }) : []),
    [models.phase, models.data, relay.model, relay.modelMeta],
  )
  const segments = useMemo(() => (levels.phase === "ready" ? thinkingSegmentsOf(levels.data) : []), [levels.phase, levels.data])
  return { rows, segments, loading: models.phase === "loading" || levels.phase === "loading" }
}

export function selectModel(relay: Relay, row: { provider?: string; modelId?: string; unconfigured?: boolean }) {
  if (row.unconfigured || !row.provider || !row.modelId) return
  void relay.runCommand("set_model", { provider: row.provider, modelId: row.modelId }).catch((error: unknown) => {
    relay.notify(`切换模型失败：${error instanceof Error ? error.message : "命令失败"}`, "warn")
  })
}

export function selectThinking(relay: Relay, level: string) {
  if (!level || level === relay.thinkingLevel) return
  void relay.runCommand("set_thinking_level", { level }).catch((error: unknown) => {
    relay.notify(`切换思考级别失败：${error instanceof Error ? error.message : "命令失败"}`, "warn")
  })
}

/** 只读命令错误的一句话（RelayError 的 message 已是中文） */
export function commandErrorText(error: unknown, fallback = "命令失败"): string {
  return (error instanceof Error ? error.message.trim() : "") || fallback
}

/** 复制到剪贴板，失败给一条通知 */
export function copyText(relay: Relay, text: string, done: string) {
  if (!navigator.clipboard) {
    relay.pushNotice({ level: "error", title: "浏览器不允许读写剪贴板" })
    return
  }
  navigator.clipboard.writeText(text).then(
    () => relay.pushNotice({ level: "success", title: done }),
    () => relay.pushNotice({ level: "error", title: "复制失败：浏览器不允许读写剪贴板" }),
  )
}

/** 绝对时间（会话信息 / 时间分隔条用）：今天 HH:mm / 昨天 HH:mm / M月d日 HH:mm */
export function dividerText(at: number, now = Date.now()): string {
  const d = new Date(at)
  const n = new Date(now)
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  if (sameDay) return `今天 ${time}`
  const yesterday = new Date(now - 24 * 60 * 60 * 1000)
  if (d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate()) return `昨天 ${time}`
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${time}`
  return d.getFullYear() === n.getFullYear() ? md : `${d.getFullYear()} 年 ${md}`
}

/** 会话状态点（§1.7：运行=陶土实点、待批=陶土空心、空闲=灰空心、离线=更淡） */
export function claudeDotOf(p: Pick<PiContainerProps, "relay">): "waiting" | "running" | "idle" | "offline" {
  const { relay } = p
  if (relay.dialogs.length > 0 || relay.uiPrompt != null) return "waiting"
  if (relay.busy) return "running"
  if (!relay.online) return "offline"
  return "idle"
}

/** get_git_branch（G11）：会话已载入、pi 在线时问一次，换会话 / 每轮结束再问；返回 "main" 这类短名或 null */
export function useGitBranch(relay: Relay, enabled: boolean): string | null {
  const ask = enabled && !!relay.roomId && relay.authed && relay.online && !relay.lazySession
  const seq = relay.turnEnd?.seq ?? 0
  const res = useCommand(relay.runCommand, ask ? "get_git_branch" : null, undefined, `${relay.roomId}|${seq}`)
  if (res.phase !== "ready" || !res.data || typeof res.data !== "object") return null
  const data = res.data as { branch?: unknown }
  return typeof data.branch === "string" && data.branch ? data.branch : null
}

/** 打开一行会话：别的设备先换过去；未载入的按列表行只本地点选 */
export function openSessionRowFor(relay: Relay, act: PiContainerProps["act"], row: { id: string; deviceId?: string; openable?: boolean } & Record<string, unknown>): void {
  // P4 Wave1：从任务/代码工作台点会话回到会话态；「记住上次设备」写共享偏好 prefs.deviceFilter（持久化由 relay 层负责）
  setClaudeWorkspaceMode("chat")
  if (row.deviceId) {
    (act.setPref as (key: string, value: unknown) => void)("deviceFilter", row.deviceId)
    // 台账 §3.2「与会话自动跟随」：从「全部」点开某平台的会话 → 平台标签自动切到该平台（prefs 契约字段）
    const platform = platformTabOfDeviceId({ relay }, row.deviceId)
    if (platform) act.setPref("uiPlatformTab", platform)
  }
  if (row.id !== relay.roomId) {
    if (row.deviceId && row.deviceId !== relay.selectedDeviceId) relay.selectDevice(row.deviceId)
    if (row.openable) relay.selectRoom(row.id)
    else relay.selectListedSession(row as never)
  }
  act.openSession()
}
