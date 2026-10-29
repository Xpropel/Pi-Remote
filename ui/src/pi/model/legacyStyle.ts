/**
 * 旧偏好键 pi_remote_style 里新界面还要读写的三项（model/settingsView.ts 的 PiLegacyStylePrefs）：完成提示音、网页回答确认框、
 * 排队"立即发送"的方式。真正读它们的还是旧代码（useCompletionSound 响的那一刻现读、useRelay 订阅），P7 B4 偏好迁移时一起换掉。
 * 新界面目录不 import @/style/*（test/pi-structure），所以这里按 style/prefs.ts 的存储口径只处理这三项：
 * - 读：同 loadStyle 的校验（不是布尔 / 不是 steer、interrupt 的值落默认，坏 JSON 落默认）；
 * - 写：在原 JSON 上合并这三项，其余字段原样保留（loadStyle 下次读时照常补默认、做迁移）；写完派发 "pi-style"，
 *   style/prefs.ts 的缓存和本页别的读者跟着刷新（同 saveStyle）。
 * test/pi-p5-c.test.mjs 拿 style/prefs.ts 的 loadStyle / defaultStyle 逐项对照。纯函数，node --test 直接加载。
 */
import type { PiApprovalGateTier, PiLegacyStylePrefs } from "./settingsView.ts"

export const LEGACY_STYLE_KEY = "pi_remote_style"
/** style/prefs.ts 的 saveStyle 派发的同一个事件 */
export const LEGACY_STYLE_EVENT = "pi-style"

/** 旧三项的生效值形状（钉死三项：pi-p5-c 逐项对照；G1/G2 开关不并入这里，见下面 askGatePrefsOf） */
export type PiLegacyStyle = { completionSound: boolean; dialogRemoteAnswer: boolean; queueSend: "steer" | "interrupt" }

/** = style/prefs.ts 的 defaultStyle 里这三项 */
export const LEGACY_STYLE_DEFAULTS: Readonly<PiLegacyStyle> = Object.freeze({ completionSound: false, dialogRemoteAnswer: false, queueSend: "interrupt" })

function parsed(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** 旧键的原始字符串 → 三项的生效值 */
export function legacyStyleOf(raw: string | null | undefined): PiLegacyStyle {
  const p = parsed(raw)
  if (!p) return { ...LEGACY_STYLE_DEFAULTS }
  return {
    completionSound: typeof p.completionSound === "boolean" ? p.completionSound : LEGACY_STYLE_DEFAULTS.completionSound,
    dialogRemoteAnswer: typeof p.dialogRemoteAnswer === "boolean" ? p.dialogRemoteAnswer : LEGACY_STYLE_DEFAULTS.dialogRemoteAnswer,
    queueSend: p.queueSend === "steer" || p.queueSend === "interrupt" ? p.queueSend : LEGACY_STYLE_DEFAULTS.queueSend,
  }
}

/** 要写回旧键的字符串：原 JSON（坏的当空）上合并 patch 里给了的项 */
export function legacyStyleWrite(raw: string | null | undefined, patch: PiLegacyStylePrefs): string {
  const next: Record<string, unknown> = { ...(parsed(raw) ?? {}) }
  if (patch.completionSound !== undefined) next.completionSound = patch.completionSound
  if (patch.dialogRemoteAnswer !== undefined) next.dialogRemoteAnswer = patch.dialogRemoteAnswer
  if (patch.queueSend !== undefined) next.queueSend = patch.queueSend
  if (patch.askUserEnabled !== undefined) next.askUserEnabled = patch.askUserEnabled
  if (patch.approvalGateEnabled !== undefined) next.approvalGateEnabled = patch.approvalGateEnabled
  if (patch.approvalGateTier !== undefined) next.approvalGateTier = patch.approvalGateTier
  return JSON.stringify(next)
}

/** G1/G2 开关在旧键里的生效值（useRelay 下达 ask_user_switch / approval_gate_switch 现读这里，与 dialogRemoteAnswer 同路）。
 *  不并入 legacyStyleOf：那三项的形状有逐项对照测试钉死，这里单独一个读者，互不影响。 */
export type PiAskGatePrefs = { askUserEnabled: boolean; approvalGateEnabled: boolean; approvalGateTier: PiApprovalGateTier }

export const ASK_GATE_DEFAULTS: Readonly<PiAskGatePrefs> = Object.freeze({ askUserEnabled: false, approvalGateEnabled: false, approvalGateTier: "high-risk" })

/** 旧键的原始字符串 → G1/G2 三项的生效值（校验口径同 legacyStyleOf：不是布尔 / 不是合法档位的值落默认） */
export function askGatePrefsOf(raw: string | null | undefined): PiAskGatePrefs {
  const p = parsed(raw)
  if (!p) return { ...ASK_GATE_DEFAULTS }
  return {
    askUserEnabled: typeof p.askUserEnabled === "boolean" ? p.askUserEnabled : ASK_GATE_DEFAULTS.askUserEnabled,
    approvalGateEnabled: typeof p.approvalGateEnabled === "boolean" ? p.approvalGateEnabled : ASK_GATE_DEFAULTS.approvalGateEnabled,
    approvalGateTier: p.approvalGateTier === "high-risk" || p.approvalGateTier === "all-non-readonly" || p.approvalGateTier === "list" ? p.approvalGateTier : ASK_GATE_DEFAULTS.approvalGateTier,
  }
}
