/**
 * 设置页 v2 → 宿主消费 · 纯逻辑（无 React / 无 DOM，node --test 直载）。
 *
 * 设置页只负责把本机偏好写进 `pi_remote_pi_settings_v2`；本文件把其中四类偏好
 * 变成宿主可执行的决定，供 `pi/hooks/usePiSettingsHost.ts` 接线：
 *   1. 默认设备：连接成功且当前无选中 / 当前选中离线时选回默认设备（手动选择后不再覆盖）；
 *   2. 通知：等待 / 出错 / 完成 × 仅页面外 / 总是 × 声音 / 角标 × 隐私模式；
 *   3. 快捷键：偏好键帽 ↔ 真实 KeyboardEvent 的匹配、浏览器保留键识别、输入框保护；
 *   4. 隐私：标题正文脱敏的判断（真实数据不动）。
 *
 * 本文件不读 storage（store 读取也在这里，但由调用方注入 storage），不碰 DOM，不改设置页。
 */
import { loadSettingsLocal } from "../settings/model.ts"
import { chordOf, chordSignature, SHORTCUT_ACTION_ROUTES } from "../settings/pages/shortcutsLogic.ts"
import type {
  SettingsPrefs,
  SettingsShortcutId,
  SettingsShortcutMap,
  SettingsStorage,
} from "../settings/types.ts"

/* ------------------------------------------------------------------ */
/* 1. 读取本机偏好                                                      */
/* ------------------------------------------------------------------ */

/** 从注入的 Storage 读取设置页 v2 偏好；缺失 / 坏数据回落默认值，绝不抛。 */
export function readPiSettingsPrefs(storage: SettingsStorage | null | undefined): SettingsPrefs {
  return loadSettingsLocal(storage).prefs
}

/* ------------------------------------------------------------------ */
/* 2. 默认设备                                                          */
/* ------------------------------------------------------------------ */

export interface PiDefaultDeviceInput {
  devices: readonly { id: string; online: boolean }[]
  selectedDeviceId: string | null
  defaultDeviceId: string
  /** 本会话内用户已经手动选过设备（任何手动选择都不再被默认设备覆盖）。 */
  manual: boolean
  /** 已经自动应用过的默认设备 id（同一个 id 只应用一次）。 */
  appliedDefaultId: string | null
}

/**
 * 默认设备决策：返回要自动选中的设备 id，null = 不动。
 * 条件（与设置 › 设备「默认设备」一致）：
 *   - 偏好里有 defaultDeviceId，且这台设备当前在线；
 *   - 当前没有选中设备，或选中的设备已离线 / 不在名册；
 *   - 用户本会话没有手动选过设备；同一个默认设备只自动应用一次。
 * 「新会话页优先级一致」由宿主自动选中后自然成立（NewSessionContainer 先看 selectedDeviceId）。
 */
export function defaultDevicePickOf(input: PiDefaultDeviceInput): string | null {
  const want = String(input.defaultDeviceId || "").trim()
  if (!want || input.manual || input.appliedDefaultId === want) return null
  const target = input.devices.find((device) => device.id === want)
  if (!target?.online) return null
  const selected = input.selectedDeviceId ? input.devices.find((device) => device.id === input.selectedDeviceId) : null
  if (selected?.online) return null
  return want
}

/* ------------------------------------------------------------------ */
/* 3. 通知                                                              */
/* ------------------------------------------------------------------ */

export type PiNotificationKind = "waiting" | "done" | "error"

/** 通知偏好的稳定快照；hook 每次偏好变化重新生成，纯函数只读它。 */
export interface PiNotificationGate {
  waiting: boolean
  error: boolean
  complete: boolean
  /** true = 仅当页面不在场（失焦 / 隐藏）；false = 总是提醒。 */
  onlyWhenAway: boolean
  sound: boolean
  badge: boolean
  privacy: boolean
}

export type PiNotificationPrefs = Pick<
  SettingsPrefs,
  "notifyWaiting" | "notifyError" | "notifyComplete" | "notifyOnlyWhenAway" | "notifySound" | "notifyBadge" | "privacyMode"
>

export function notificationGateOf(prefs: PiNotificationPrefs): PiNotificationGate {
  return {
    waiting: prefs.notifyWaiting,
    error: prefs.notifyError,
    complete: prefs.notifyComplete,
    onlyWhenAway: prefs.notifyOnlyWhenAway,
    sound: prefs.notifySound,
    badge: prefs.notifyBadge,
    privacy: prefs.privacyMode,
  }
}

/** 这一类事件本身是否打开（等待 / 出错 / 完成）。 */
export function notificationEventOn(gate: PiNotificationGate, kind: PiNotificationKind): boolean {
  if (kind === "waiting") return gate.waiting
  if (kind === "error") return gate.error
  return gate.complete
}

/** 页面在场时是否也提醒。 */
export function notificationAwayOk(gate: PiNotificationGate, away: boolean): boolean {
  return !gate.onlyWhenAway || away
}

/** 标签页标题 / favicon 角标是否该显示这一类通知。 */
export function notificationBadgeVisible(gate: PiNotificationGate, kind: PiNotificationKind, away: boolean): boolean {
  return gate.badge && notificationEventOn(gate, kind) && notificationAwayOk(gate, away)
}

/** 提示音是否该响。 */
export function notificationSoundVisible(gate: PiNotificationGate, kind: PiNotificationKind, away: boolean): boolean {
  return gate.sound && notificationEventOn(gate, kind) && notificationAwayOk(gate, away)
}

export interface PiNotificationNotice {
  level: "success" | "error" | "warning"
  title: string
}

/**
 * 应用内提醒文案：只写事件类型，不写会话标题 / 正文。
 * 隐私模式与非隐私模式都安全，正文永远不会进入提醒。
 */
export function notificationNoticeOf(gate: PiNotificationGate, kind: PiNotificationKind, away: boolean): PiNotificationNotice | null {
  if (!notificationEventOn(gate, kind) || !notificationAwayOk(gate, away)) return null
  if (kind === "waiting") return { level: "warning", title: "有任务等你确认" }
  return kind === "error" ? { level: "error", title: "回合出错" } : { level: "success", title: "任务完成" }
}

/**
 * 新出现的等待条目：上一份 key 集合 → 这一份里多出来的 key。
 * 首次快照（previous = null）一律返回空：页面打开时已经挂着的弹窗不补发提醒。
 * 「一个关了、另一个又开」时计数可能不变，但 key 集合能识别成新事件。
 */
export function freshWaitingKeys(previous: readonly string[] | null, current: readonly string[]): string[] {
  if (previous === null) return []
  const seen = new Set(previous)
  return current.filter((key) => !seen.has(key))
}

/**
 * 标签页标题里的会话名：隐私模式返回空串（由 pageTitle 回落成 "pi"），
 * 正常模式原样返回。不改真实数据。
 */
export function titleRoomOf(roomTitle: string, gate: PiNotificationGate): string {
  return gate.privacy ? "" : roomTitle
}

/** 「等你回答」前缀的输入：角标关闭或等待通知关闭时归零。 */
export function titleWaitingCountOf(gate: PiNotificationGate, waiting: number): number {
  return gate.waiting && gate.badge ? waiting : 0
}

/** 后台完成前缀 / 完成角标是否启用（还要结合 away / always）。 */
export function titleCompletionEnabled(gate: PiNotificationGate): boolean {
  return gate.complete && gate.badge
}

/** 出错前缀 / 出错角标是否启用。 */
export function titleErrorEnabled(gate: PiNotificationGate): boolean {
  return gate.error && gate.badge
}

/* ------------------------------------------------------------------ */
/* 4. 快捷键                                                            */
/* ------------------------------------------------------------------ */

export type PiShortcutPlatform = "mac" | "other"

export interface PiShortcutBinding {
  id: SettingsShortcutId
  route: string
  keys: readonly string[]
  signature: string
}

export interface PiShortcutEvent {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  keyCode?: number
  repeat?: boolean
}

export interface PiShortcutHit extends PiShortcutBinding {
  /** 与浏览器自带快捷键（新标签 / 新窗口 / 地址栏等）冲突：仍执行，但宿主提示用户改键。 */
  browserConflict: boolean
}

/** 偏好键位表 → 可比较的绑定列表；空键位 / 坏值跳过。 */
export function shortcutBindingsOf(map: SettingsShortcutMap): PiShortcutBinding[] {
  const out: PiShortcutBinding[] = []
  for (const [id, keys] of Object.entries(map || {}) as [SettingsShortcutId, readonly string[]][]) {
    if (!Array.isArray(keys) || keys.length === 0) continue
    const signature = chordSignature(keys)
    if (!signature) continue
    out.push({ id, route: SHORTCUT_ACTION_ROUTES[id] ?? id, keys: [...keys], signature })
  }
  return out
}

/** 浏览器自带快捷键（mac / 其他平台分开；只列会与网页冲突的常用组合）。 */
const BROWSER_RESERVED: Record<PiShortcutPlatform, readonly (readonly string[])[]> = {
  mac: [
    ["⌘", "N"],
    ["⌘", "T"],
    ["⌘", "W"],
    ["⌘", "Q"],
    ["⌘", "R"],
    ["⌘", "P"],
    ["⌘", "S"],
    ["⌘", "F"],
    ["⌘", "O"],
    ["⌘", "L"],
  ],
  other: [
    ["Ctrl", "N"],
    ["Ctrl", "T"],
    ["Ctrl", "W"],
    ["Ctrl", "R"],
    ["Ctrl", "P"],
    ["Ctrl", "S"],
    ["Ctrl", "F"],
    ["Ctrl", "O"],
    ["Ctrl", "L"],
  ],
}

/** 这组键帽是否与浏览器自带快捷键冲突（按平台）。 */
export function browserShortcutConflictOf(keys: readonly string[], platform: PiShortcutPlatform): boolean {
  const signature = chordSignature(keys)
  if (!signature) return false
  return BROWSER_RESERVED[platform].some((reserved) => chordSignature(reserved) === signature)
}

/**
 * 一次 keydown → 命中的偏好快捷键；没命中返回 null。
 * 忽略组字 / 长按重复 / 只按修饰键；按归一化签名匹配，所以用户存的修饰键顺序不影响。
 */
export function shortcutHitOf(map: SettingsShortcutMap, event: PiShortcutEvent, platform: PiShortcutPlatform): PiShortcutHit | null {
  if (event.isComposing || event.keyCode === 229 || event.repeat) return null
  const chord = chordOf(event)
  if (!chord) return null
  const signature = chordSignature(chord)
  const binding = shortcutBindingsOf(map).find((item) => item.signature === signature)
  if (!binding) return null
  return { ...binding, browserConflict: browserShortcutConflictOf(binding.keys, platform) }
}

/** 组合里是否带修饰键（⌘ / Ctrl / ⌥）；⇧ 单独不算——⇧+Enter 这类是输入框自己的编辑键。 */
export function shortcutHasStrongModifier(keys: readonly string[]): boolean {
  return keys.some((key) => key === "⌘" || key === "Ctrl" || key === "⌥")
}

export type PiShortcutFocus = "composer" | "editable" | "other"

/**
 * 焦点保护：
 *   - 输入框（非 composer）里：带强修饰键的组合照常分发；裸键 / 仅 ⇧ 的编辑键交给输入框；
 *   - composer 里：除了 Esc（停止生成，和既有 Esc 分层一致）和带强修饰键的组合，全部交给输入框
 *     （Enter / ⇧+Enter / ⌥+Enter 的发送 / 换行 / 排队由输入框自己处理）；
 *   - 其他位置：不受限。
 */
export function shortcutBlockedByFocus(keys: readonly string[], focus: PiShortcutFocus): boolean {
  if (focus === "other") return false
  if (shortcutHasStrongModifier(keys)) return false
  if (focus === "composer") {
    // Esc = 停止生成（既有 Esc 分层）；Tab / ⇧Tab = 焦点导航键，不产生文字（默认「循环思考档」就是 ⇧Tab）。
    return !(keys.includes("Esc") || keys.includes("Tab"))
  }
  return true
}

export interface PiShortcutOverlayState {
  menu: boolean
  sheet: boolean
  dialog: boolean
  palette: boolean
  /** 设置页是整页推入/覆盖层，自己处理键盘（含快捷键录制），宿主不抢。 */
  settings: boolean
}

/** 有菜单 / 弹窗 / 面板 / 设置页开着时，宿主的全局快捷键不抢键（交给浮层自己）。 */
export function shortcutBlockedByOverlay(state: PiShortcutOverlayState): boolean {
  return state.menu || state.sheet || state.dialog || state.palette || state.settings
}

/** 冲突提示文案（一次会话每个组合只提示一次，由 hook 去重）。 */
export function browserShortcutHintOf(binding: PiShortcutBinding): string {
  return `快捷键 ${binding.keys.join("")} 与浏览器默认快捷键冲突，可能被浏览器先处理；可在设置 › 快捷键改键`
}
