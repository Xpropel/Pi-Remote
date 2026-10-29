/**
 * 设置页与显示选项的偏好口径（plan §7.3 settings / quick-settings、P5.5 c 线；design §1.13、决定 10）。纯函数，node --test 直接加载。
 * 新界面的偏好在 model/prefs.ts（pi_remote_pi_prefs）；有三项真正生效的读者还在旧键 pi_remote_style（style/prefs.ts）里，不改那些 hook：
 *   - 完成提示音：useCompletionSound 响的那一刻现读 loadStyle().completionSound（P5.7 原样复用）；
 *   - 网页回答确认框：useRelay 按 useStylePrefs().dialogRemoteAnswer 下达 dialog_answer_switch；
 *   - G1/G2 开关：useRelay 按旧键里的 askUserEnabled / approvalGateEnabled / approvalGateTier 下达 ask_user_switch / approval_gate_switch（与上一条同路）；
 *   - 排队消息"立即发送"时打断 / 等工具结束：旧键 queueSend（steer = 等当前工具结束，interrupt = 打断）。
 * 所以这三项读旧键（真正生效的值），改的时候新旧两边一起写。忙时默认投递读写 relay.sendMode（输入框下面的选择器同一个值）。
 */
import type { PiUiVariant } from "../variants/types.ts"
import type { PiApprovalGateTier, PiPrefs } from "./prefs.ts"

export type { PiApprovalGateTier }

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
  /** G1：允许智能体用 ask_user 工具向我提问（默认关） */
  askUser: boolean
  /** G2：工具执行审批门（默认关；与远程应答开关分开） */
  approvalGate: boolean
  /** G2 审批档位（默认只问高危） */
  approvalGateTier: PiApprovalGateTier
  sound: boolean
  deviceFilter: string
  grouping: "device" | "flat"
}

/** 旧键里还在生效的项（三项旧的 + G1/G2 两组开关：useRelay 现读旧键下达桥，与 dialogRemoteAnswer 同路） */
export type PiLegacyStylePrefs = {
  completionSound?: boolean
  dialogRemoteAnswer?: boolean
  queueSend?: "steer" | "interrupt"
  askUserEnabled?: boolean
  approvalGateEnabled?: boolean
  approvalGateTier?: PiApprovalGateTier
}

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
    askUser: legacy.askUserEnabled ?? prefs.askUserEnabled,
    approvalGate: legacy.approvalGateEnabled ?? prefs.approvalGateEnabled,
    approvalGateTier: legacy.approvalGateTier ?? prefs.approvalGateTier,
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
  if (patch.askUser !== undefined) {
    out.push({ kind: "pref", key: "askUserEnabled", value: patch.askUser })
    out.push({ kind: "legacy", patch: { askUserEnabled: patch.askUser } })
  }
  if (patch.approvalGate !== undefined) {
    out.push({ kind: "pref", key: "approvalGateEnabled", value: patch.approvalGate })
    out.push({ kind: "legacy", patch: { approvalGateEnabled: patch.approvalGate } })
  }
  if (patch.approvalGateTier !== undefined) {
    out.push({ kind: "pref", key: "approvalGateTier", value: patch.approvalGateTier })
    out.push({ kind: "legacy", patch: { approvalGateTier: patch.approvalGateTier } })
  }
  return out
}
