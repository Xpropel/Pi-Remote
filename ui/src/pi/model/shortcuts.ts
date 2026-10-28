/**
 * Pi 新界面的桌面快捷键（PLAN 4.2；design B14、§1.10、D-01、K06）。纯函数，不碰 DOM，
 * 由 `pi/hooks/usePiShortcuts.ts` 接到 window 上；Node 单测直接加载本文件。
 *
 * 键位（Windows / Linux 上 ⌘ 换成 Ctrl）：
 *   ⇧⌘O 新建会话（浏览器不让网页拦 ⌘N，§1.10）
 *   ⌘K  命令面板（只有这一个含义，D-01；侧栏"搜索"行不绑任何键）
 *   ⌘B  折叠 / 展开侧栏
 *   ⌘.  开关右 pane
 *   ⌘,  设置
 *   Esc 分层：先关菜单，再关浮层，最后停止生成（K06），见 escTargetOf
 *
 * 规则：
 * - 修饰键必须"只按平台主键"：mac 只认 ⌘（同时按 Ctrl 不算），其他平台只认 Ctrl（同时按 ⌘/Win 不算）；
 *   按着 Alt 一律不算（Alt 组合在各平台常被输入法 / 系统占用）。
 * - ⇧ 只属于 ⇧⌘O；⌘K / ⌘B / ⌘. / ⌘, 按着 ⇧ 时不触发（⇧⌘. 等留给浏览器）。
 * - 输入法组字（isComposing，或 Safari 的 keyCode 229）期间所有键都不触发，Esc 也不触发：
 *   组字时的 Esc 是取消候选，不能顺带关菜单或停止生成。
 * - 长按产生的重复按键（repeat）不触发，避免一次长按连开连关。
 * - 焦点在输入框（input / textarea / select / contenteditable）里时：五个 ⌘ 组合照样生效
 *   （它们在纯文本框里没有编辑含义，composer 打字时也能 ⌘K）；Esc 照样进入分层，
 *   但"停止生成"一层只在焦点位于 composer 或不在任何输入框时生效——
 *   改名框、搜索框里的 Esc 归这些框自己（清空 / 失焦），不能顺手停掉正在跑的回合。
 *   本界面没有不带修饰键的快捷键，所以不存在"只在输入框外生效"的单键。
 * - 有菜单或浮层（弹窗、sheet、命令面板、灯箱）开着时，五个 ⌘ 组合都不触发：
 *   焦点被浮层接管，键交给浮层；只有 Esc 走分层。
 *   这是推断：design 没写浮层打开时 ⌘ 组合怎么办，这里沿用旧界面 shell/useShortcuts.ts 的做法。
 */

export type PiPlatform = "mac" | "other"

/** 只取判断需要的字段；`editable` 由调用方根据 event.target 算出（见 usePiShortcuts）。 */
export interface PiKeyInput {
  key: string
  /** 物理键位（KeyO / Period / Comma …），key 被键盘布局改写时兜底 */
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
  /** Safari 组字时 keydown 的 isComposing 可能是 false，但 keyCode 是 229 */
  keyCode?: number
  repeat?: boolean
  /** 焦点是否在可输入元素里 */
  editable?: boolean
}

export type PiShortcutAction =
  | "new-session"
  | "command-palette"
  | "toggle-sidebar"
  | "toggle-pane"
  | "settings"
  | "escape"

/** 修饰键快捷键（不含 Esc） */
export type PiModShortcut = Exclude<PiShortcutAction, "escape">

/** 键位展示文案，命令面板行尾 / 设置页快捷键表用；与 piShortcutOf 的规则一致 */
export const PI_SHORTCUT_KEYS: Record<PiModShortcut, { mac: string; other: string }> = {
  "new-session": { mac: "⇧⌘O", other: "Ctrl+Shift+O" },
  "command-palette": { mac: "⌘K", other: "Ctrl+K" },
  "toggle-sidebar": { mac: "⌘B", other: "Ctrl+B" },
  "toggle-pane": { mac: "⌘.", other: "Ctrl+." },
  settings: { mac: "⌘,", other: "Ctrl+," },
}

const MAC_RE = /Mac|iPhone|iPad|iPod/i

/** 按 navigator 判断平台；拿不到时按非 mac 处理（Ctrl）。 */
export function piPlatformOf(nav?: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | null): PiPlatform {
  if (!nav) return "other"
  const hint = nav.userAgentData?.platform || nav.platform || nav.userAgent || ""
  return MAC_RE.test(hint) ? "mac" : "other"
}

function isComposing(event: PiKeyInput): boolean {
  return event.isComposing === true || event.keyCode === 229
}

/** 键事件 → 动作；不是本界面的快捷键时返回 null。 */
export function piShortcutOf(event: PiKeyInput, platform: PiPlatform): PiShortcutAction | null {
  if (isComposing(event) || event.repeat) return null

  if (event.key === "Escape") {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
    return "escape"
  }

  const mod = platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!mod || event.altKey) return null

  const key = event.key.toLowerCase()
  const code = event.code ?? ""

  if (event.shiftKey) {
    return key === "o" || code === "KeyO" ? "new-session" : null
  }
  if (key === "k" || code === "KeyK") return "command-palette"
  if (key === "b" || code === "KeyB") return "toggle-sidebar"
  if (key === "." || code === "Period") return "toggle-pane"
  if (key === "," || code === "Comma") return "settings"
  return null
}

/** Esc 分层的输入。 */
export interface PiEscState {
  /** 锚定菜单开着：会话菜单、+ 菜单、模型 / 投递 / 设备 / 目录菜单、斜杠 / @ 菜单、显示选项 */
  menuOpen: boolean
  /** 浮层开着：PiDialog、PiSheet、命令面板、灯箱、标题悬停卡 */
  overlayOpen: boolean
  /** 当前回合可以停止：composerBlockOf 的结果是 stop，或 S4 的裸停止钮在场 */
  canStop: boolean
  /** 焦点在哪：composer 输入框 / 其他输入框 / 别处 */
  focus: "composer" | "editable" | "other"
}

export type PiEscTarget = "menu" | "overlay" | "stop" | "none"

/**
 * Esc 一次只处理一层：菜单 → 浮层 → 停止生成（K06）→ 什么也不做。
 * 菜单排在浮层前面：sheet 里再开的菜单在最上层，先关它。
 * "停止"只在焦点位于 composer 或不在输入框时生效（见文件头）。
 */
export function escTargetOf(state: PiEscState): PiEscTarget {
  if (state.menuOpen) return "menu"
  if (state.overlayOpen) return "overlay"
  if (state.canStop && state.focus !== "editable") return "stop"
  return "none"
}

/** 有菜单或浮层开着时，⌘ 组合不触发（见文件头）；Esc 总是交给 escTargetOf。 */
export function piShortcutAllowed(action: PiShortcutAction, state: Pick<PiEscState, "menuOpen" | "overlayOpen">): boolean {
  if (action === "escape") return true
  return !state.menuOpen && !state.overlayOpen
}
