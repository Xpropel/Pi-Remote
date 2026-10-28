/**
 * 设置页与显示选项的偏好口径（plan §7.3 settings / quick-settings、P5.5 c 线；design §1.13、决定 10）。纯函数，node --test 直接加载。
 * 新界面的偏好在 model/prefs.ts（pi_remote_pi_prefs）；有三项真正生效的读者还在旧键 pi_remote_style（style/prefs.ts）里，不改那些 hook：
 *   - 完成提示音：useCompletionSound 响的那一刻现读 loadStyle().completionSound（P5.7 原样复用）；
 *   - 网页回答确认框：useRelay 按 useStylePrefs().dialogRemoteAnswer 下达 dialog_answer_switch；
 *   - 排队消息"立即发送"时打断 / 等工具结束：旧键 queueSend（steer = 等当前工具结束，interrupt = 打断）。
 * 所以这三项读旧键（真正生效的值），改的时候新旧两边一起写。忙时默认投递读写 relay.sendMode（输入框下面的选择器同一个值）。
 */
import type { PiUiVariant } from "../variants/types.ts"
import type { PiPrefs } from "./prefs.ts"

/** 与 components/pi/composer 的 CPrefs 同形 */
export type PiSettingsPrefs = {
  /** 界面变体（PI-UI-REFS 架构线）：设置页「外观 › 界面」三张卡片 */
  ui: PiUiVariant
  theme: "system" | "light" | "dark"
  fontSize: "small" | "standard" | "large"
  density: "compact" | "balanced" | "detailed"
  busyDelivery: "steer" | "follow_up"
  sendNow: "interrupt" | "after_tool"
  dialogRemote: boolean
  sound: boolean
  deviceFilter: string
  grouping: "device" | "flat"
}

/** 旧键里还在生效的三项 */
export type PiLegacyStylePrefs = { completionSound?: boolean; dialogRemoteAnswer?: boolean; queueSend?: "steer" | "interrupt" }

/** 字号三档在 model/prefs.ts 里还没有字段（lane-requests/p5-c.md）：先固定显示"标准" */
export const PI_FONT_SIZE_DEFAULT = "standard" as const

export function settingsPrefsOf(prefs: PiPrefs, legacy: PiLegacyStylePrefs, sendMode: string | null | undefined): PiSettingsPrefs {
  return {
    ui: prefs.ui,
    theme: prefs.theme,
    fontSize: PI_FONT_SIZE_DEFAULT,
    density: prefs.density,
    busyDelivery: sendMode === "follow_up" ? "follow_up" : "steer",
    sendNow: legacy.queueSend === "steer" ? "after_tool" : "interrupt",
    dialogRemote: legacy.dialogRemoteAnswer ?? prefs.dialogRemoteAnswer,
    sound: legacy.completionSound ?? prefs.completionSound,
    deviceFilter: prefs.deviceFilter ?? "all",
    grouping: prefs.grouping,
  }
}

export type PiSettingsWrite =
  | { kind: "pref"; key: Exclude<keyof PiPrefs, "v">; value: PiPrefs[Exclude<keyof PiPrefs, "v">] }
  | { kind: "legacy"; patch: PiLegacyStylePrefs }
  | { kind: "sendMode"; value: "steer" | "follow_up" }

/** 一次改动要写到哪里（同一项可能要写两处）；字号没有落点，返回空 */
export function settingsWritesOf(patch: Partial<PiSettingsPrefs>): PiSettingsWrite[] {
  const out: PiSettingsWrite[] = []
  if (patch.ui) out.push({ kind: "pref", key: "ui", value: patch.ui })
  if (patch.theme) out.push({ kind: "pref", key: "theme", value: patch.theme })
  if (patch.density) out.push({ kind: "pref", key: "density", value: patch.density })
  if (patch.grouping) out.push({ kind: "pref", key: "grouping", value: patch.grouping })
  if (patch.deviceFilter !== undefined) out.push({ kind: "pref", key: "deviceFilter", value: patch.deviceFilter === "all" || !patch.deviceFilter ? null : patch.deviceFilter })
  if (patch.busyDelivery) {
    out.push({ kind: "pref", key: "delivery", value: patch.busyDelivery })
    out.push({ kind: "sendMode", value: patch.busyDelivery })
  }
  if (patch.sendNow) out.push({ kind: "legacy", patch: { queueSend: patch.sendNow === "after_tool" ? "steer" : "interrupt" } })
  if (patch.sound !== undefined) {
    out.push({ kind: "pref", key: "completionSound", value: patch.sound })
    out.push({ kind: "legacy", patch: { completionSound: patch.sound } })
  }
  if (patch.dialogRemote !== undefined) {
    out.push({ kind: "pref", key: "dialogRemoteAnswer", value: patch.dialogRemote })
    out.push({ kind: "legacy", patch: { dialogRemoteAnswer: patch.dialogRemote } })
  }
  return out
}
