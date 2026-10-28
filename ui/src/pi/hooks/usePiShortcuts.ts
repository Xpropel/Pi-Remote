/**
 * Pi 新界面的桌面快捷键 hook（PLAN 4.2）。键位与规则全在 `pi/model/shortcuts.ts`，这里只做接线：
 * 在 window 上听 keydown（冒泡阶段），把事件交给 piShortcutOf / escTargetOf，再调用传入的回调。
 *
 * - 不依赖任何具体组件：动作全部通过回调传入；某个回调没传时，对应按键不拦截（不 preventDefault），
 *   浏览器默认行为保持不变。
 * - 冒泡阶段 + 跳过 defaultPrevented：Radix 的 Dialog / DropdownMenu 在 document 捕获阶段处理 Esc 并
 *   preventDefault，它们先关自己，这里不会再关一层或顺手停止生成。不走 Radix 的受控菜单（斜杠 / @ 等）
 *   如果自己在 onKeyDown 里处理了 Esc，也请 preventDefault；没处理的由 escState.menuOpen → onCloseMenu 兜住。
 * - 手机不挂：调用方在桌面布局下传 enabled = true。
 * - 旧界面的 shell/useShortcuts.ts 不动（P7.3 再删）。
 */
import { useEffect, useLayoutEffect, useRef } from "react"
import {
  escTargetOf,
  piPlatformOf,
  piShortcutAllowed,
  piShortcutOf,
  type PiEscState,
  type PiPlatform,
} from "../model/shortcuts.ts"

export interface PiShortcutHandlers {
  /** ⇧⌘O */
  onNewSession?: () => void
  /** ⌘K：只开命令面板（D-01） */
  onCommandPalette?: () => void
  /** ⌘B */
  onToggleSidebar?: () => void
  /** ⌘. */
  onTogglePane?: () => void
  /** ⌘, */
  onOpenSettings?: () => void
  /** Esc 第 1 层 */
  onCloseMenu?: () => void
  /** Esc 第 2 层 */
  onCloseOverlay?: () => void
  /** Esc 第 3 层（K06） */
  onStop?: () => void
}

export interface UsePiShortcutsOptions extends PiShortcutHandlers {
  enabled: boolean
  /** 当前的菜单 / 浮层 / 可停止状态；焦点位置由 hook 按 event.target 算 */
  escState: Omit<PiEscState, "focus">
  /** 默认按 navigator 判断 */
  platform?: PiPlatform
  /** 判断元素是否属于 composer；默认认 PiFollowUpComposer / PiEmptyComposer 的 data-slot */
  isComposerElement?: (element: Element) => boolean
}

const COMPOSER_SELECTOR = '[data-slot="pi-follow-up-composer"], [data-slot="pi-empty-composer"]'

type ElementLike = {
  tagName?: string
  isContentEditable?: boolean
  closest?: (selector: string) => unknown
}

/** 焦点元素是否可输入（input / textarea / select / contenteditable）。只用鸭子类型，方便 Node 单测。 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const element = target as ElementLike
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : ""
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (element.isContentEditable === true) return true
  return typeof element.closest === "function" && !!element.closest('[contenteditable="true"]')
}

function defaultIsComposer(element: Element): boolean {
  return !!(element as ElementLike).closest?.(COMPOSER_SELECTOR)
}

/** 焦点位置分三类，给 escTargetOf 用。 */
export function focusKindOf(
  target: unknown,
  isComposerElement: (element: Element) => boolean = defaultIsComposer,
): PiEscState["focus"] {
  if (!isEditableTarget(target)) return "other"
  return isComposerElement(target as Element) ? "composer" : "editable"
}

export function usePiShortcuts(options: UsePiShortcutsOptions): void {
  const latest = useRef(options)
  // 每次提交后同步最新的回调与状态；按键总发生在提交之后，读到的总是最新值
  useLayoutEffect(() => {
    latest.current = options
  })
  const { enabled } = options

  useEffect(() => {
    if (!enabled) return
    const platform = latest.current.platform ?? piPlatformOf(typeof navigator === "undefined" ? null : navigator)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const current = latest.current
      const action = piShortcutOf(
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          isComposing: event.isComposing,
          keyCode: event.keyCode,
          repeat: event.repeat,
        },
        current.platform ?? platform,
      )
      if (!action || !piShortcutAllowed(action, current.escState)) return

      let handler: (() => void) | undefined
      if (action === "escape") {
        const target = escTargetOf({
          ...current.escState,
          focus: focusKindOf(event.target, current.isComposerElement),
        })
        handler =
          target === "menu"
            ? current.onCloseMenu
            : target === "overlay"
              ? current.onCloseOverlay
              : target === "stop"
                ? current.onStop
                : undefined
      } else {
        handler = {
          "new-session": current.onNewSession,
          "command-palette": current.onCommandPalette,
          "toggle-sidebar": current.onToggleSidebar,
          "toggle-pane": current.onTogglePane,
          settings: current.onOpenSettings,
        }[action]
      }
      if (!handler) return
      event.preventDefault()
      handler()
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled])
}
