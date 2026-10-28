/**
 * 设置 › 快捷键 · 纯逻辑（无 React / 无 DOM，node --test 直载）。
 *
 * 页面负责录制与持久化；本文件只管三件事：
 *   1. 键盘事件 → 键帽（修饰键顺序归一，便于比较）；
 *   2. 冲突检测（同一组合出现在两个动作上 → 两个动作都要提示）；
 *   3. 搜索过滤 + 动作到现有动作的映射表（施工接线时按这张表分发）。
 *
 * 与 pi 的 keybindings.json 无关：这是网页应用自己的键位体系（设计册 §10）。
 */

export interface ShortcutKeyInput {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "OS", "CapsLock"])

/** 归一后的修饰键顺序；只影响比较，不改用户已存的显示顺序。 */
const MODIFIER_ORDER = ["⌘", "Ctrl", "⌥", "⇧"]

export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/** 键帽文案：与 ui.tsx 的录制器保持同一口径。 */
export function keycapOf(key: string): string {
  switch (key) {
    case " ":
      return "Space"
    case "Escape":
      return "Esc"
    case "ArrowUp":
      return "↑"
    case "ArrowDown":
      return "↓"
    case "ArrowLeft":
      return "←"
    case "ArrowRight":
      return "→"
    case "Backspace":
      return "⌫"
    case "Delete":
      return "⌦"
    case "CapsLock":
      return "Caps Lock"
    default:
      return key.length === 1 ? key.toUpperCase() : key
  }
}

/**
 * 键盘事件 → 键帽数组；只按修饰键时返回 null（继续等主键）。
 * 最多 4 个键帽（与 model.ts 的持久化上限一致），超限时保主键、丢多余修饰键。
 */
export function chordOf(input: ShortcutKeyInput): string[] | null {
  if (!input.key || isModifierKey(input.key)) return null
  const modifiers: string[] = []
  if (input.metaKey) modifiers.push("⌘")
  if (input.ctrlKey) modifiers.push("Ctrl")
  if (input.altKey) modifiers.push("⌥")
  if (input.shiftKey) modifiers.push("⇧")
  const key = keycapOf(input.key)
  const keys = [...modifiers, key]
  return keys.length > 4 ? [modifiers[0], modifiers[1], modifiers[2], key] : keys
}

/** 冲突比较用的签名：修饰键按固定顺序、主键忽略大小写。 */
export function chordSignature(keys: readonly string[]): string {
  const modifiers = keys.filter((key) => MODIFIER_ORDER.includes(key)).sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b))
  const rest = keys.filter((key) => !MODIFIER_ORDER.includes(key)).map((key) => key.toLowerCase())
  return [...modifiers, ...rest].join("\u0000")
}

/**
 * 冲突表：id → 与它同键位的其它动作 id（不含自己）。
 * 空键位 / 坏值不参与比较；顺序按对象遍历顺序，渲染端再换成动作名。
 */
export function shortcutConflictsOf(map: Record<string, readonly string[]>): Record<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const [id, keys] of Object.entries(map)) {
    if (!Array.isArray(keys) || keys.length === 0) continue
    const signature = chordSignature(keys)
    if (!signature) continue
    const list = groups.get(signature)
    if (list) list.push(id)
    else groups.set(signature, [id])
  }
  const out: Record<string, string[]> = {}
  for (const ids of groups.values()) {
    if (ids.length < 2) continue
    for (const id of ids) out[id] = ids.filter((other) => other !== id)
  }
  return out
}

/** 搜索：动作名 / 分组名 / 当前键帽都能命中；空查询恒真。 */
export function matchesShortcutQuery(label: string, groupLabel: string, keys: readonly string[], query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${label} ${groupLabel} ${keys.join(" ")}`.toLowerCase().includes(needle)
}

/** 冲突提示文案：`与「全局搜索」冲突`；多个用顿号连接。 */
export function shortcutConflictTextOf(labels: readonly string[]): string {
  return `与「${labels.join("、")}」冲突`
}

/**
 * 动作 → 现有动作 / 命令的映射（施工接线用，不在本页直接分发）。
 * 前四项是 pi/model/shortcuts.ts 已实现的键位；其余对应现有 composer / relay / 侧栏动作。
 */
export const SHORTCUT_ACTION_ROUTES = {
  newSession: "new-session",
  globalSearch: "command-palette",
  archiveSession: "sidebar.archive",
  pinSession: "sidebar.pin",
  previousSession: "sidebar.previous",
  nextSession: "sidebar.next",
  toggleSidebar: "toggle-sidebar",
  openSettings: "settings",
  sendMessage: "composer.send",
  insertNewline: "composer.newline",
  stopGeneration: "abort",
  switchModel: "set_model",
  cycleThinkingLevel: "set_thinking_level",
  toggleThinkingBlock: "thinking.toggle",
  queueSend: "queue.send",
  steerSend: "queue.steer",
} as const
