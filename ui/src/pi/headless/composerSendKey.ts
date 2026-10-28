/**
 * 发送消息键（设置 › 通用 › 发送消息）的纯决策。
 *
 * `pi_remote_pi_settings_v2.prefs.sendKey` 只由设置页写入； composer 的键盘路径统一
 * 经这里把「偏好 + 真实按键」变成动作，避免三套桌面 / 三套手机 composer 各写一份。
 *
 * 约束（与设置页文案一一对应）：
 *  - enter：Enter 发送；Ctrl/Cmd+Enter 换行；
 *  - ctrl-enter：Enter 换行；Ctrl/Cmd+Enter 发送；
 *  - Shift+Enter 恒换行（浏览器原生插入，不消费偏好）；
 *  - 输入法组字中（含 Safari 的 keyCode 229）绝不发送 / 换行；
 *  - 手机软键盘保持既有规则（无 Ctrl/Cmd 的 Enter 换行、按钮发送），不因桌面偏好改变；
 *  - 手机外接硬件键盘的 Ctrl/Cmd+Enter 仍按桌面偏好（enter = 换行、ctrl-enter = 发送），
 *    和桌面同一套语义；带 Shift 时仍按 Shift+Enter 恒换行；
 *  - Alt / 其它键不抢，交浏览器默认行为。
 *
 * 这里零 React / 零 DOM，node --test 可直接加载。
 */

export const PI_SEND_KEYS = ["enter", "ctrl-enter"] as const
export type PiSendKey = (typeof PI_SEND_KEYS)[number]
export const PI_SEND_KEY_DEFAULT: PiSendKey = "enter"

/** 任意存储值 → 合法偏好；缺失 / 坏值回落默认（与 settings/model 的逐字段校验同口径）。 */
export function normalizeSendKey(value: unknown): PiSendKey {
  return value === "ctrl-enter" ? "ctrl-enter" : PI_SEND_KEY_DEFAULT
}

/**
 * 按键动作：
 *  - send   ：调用发送；
 *  - newline：由 composer 在当前光标处插入换行（Ctrl/Cmd+Enter 在 Chrome 里不会原生换行）；
 *  - native ：不拦，交浏览器原生行为（Shift+Enter / 手机软键盘 Enter 都是原生换行）；
 *  - ignore ：不动（其它键 / 组字中 / Alt 组合）。
 */
export type ComposerEnterAction = "send" | "newline" | "native" | "ignore"

export interface ComposerEnterInput {
  key: string
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  /** React 合成事件的 nativeEvent.isComposing */
  isComposing?: boolean
  /** Safari 组字时 keydown 的 keyCode 是 229 */
  keyCode?: number
  /** 手机软键盘 / 手机外壳：无 Ctrl/Cmd 的 Enter 保持换行；Ctrl/Cmd+Enter 按桌面偏好 */
  mobile?: boolean
}

/**
 * Enter 的单一决策。顺序就是优先级：非 Enter → 组字 → 手机（无 Ctrl/Cmd）→ Shift → Alt →
 * Ctrl/Cmd → 裸 Enter。调用方只做三件事：send 时 preventDefault + 发送；
 * newline 时 preventDefault + 在光标处插入换行；native / ignore 时什么都不做。
 */
export function decideComposerEnter(input: ComposerEnterInput, sendKey: PiSendKey): ComposerEnterAction {
  if (input.key !== "Enter") return "ignore"
  if (input.isComposing === true || input.keyCode === 229) return "ignore"
  const modified = input.ctrlKey === true || input.metaKey === true
  // 手机 Enter 的原生行为就是换行；不把桌面偏好带进软键盘。
  // 例外：手机外接硬件键盘的 Ctrl/Cmd+Enter 没有原生换行，按桌面偏好处理（P3-1）。
  if (input.mobile === true && !modified) return "native"
  // Shift+Enter 恒换行：统一自己插（浏览器只在裸 Shift+Enter 时原生换行，
  // Ctrl/Cmd+Shift+Enter 不会；自己插还能保证三套外壳 / 三种浏览器一致）。
  if (input.shiftKey === true) return "newline"
  // Alt 组合与其它浏览器 / 输入法约定不抢。
  if (input.altKey === true) return "ignore"
  if (modified) return sendKey === "ctrl-enter" ? "send" : "newline"
  return sendKey === "ctrl-enter" ? "newline" : "send"
}

export interface ComposerNewlineResult {
  draft: string
  /** 换行插入后光标应在的位置（替换选区时也一样）。 */
  caret: number
}

/** 在 [start, end) 选区处插入一个换行；区间越界 / 反序自动夹紧。 */
export function insertComposerNewline(draft: string, start: number, end: number): ComposerNewlineResult {
  const length = draft.length
  const from = Math.max(0, Math.min(length, Number.isFinite(start) ? Math.floor(start) : length))
  const to = Math.max(from, Math.min(length, Number.isFinite(end) ? Math.floor(end) : from))
  return { draft: `${draft.slice(0, from)}\n${draft.slice(to)}`, caret: from + 1 }
}
