/**
 * 设置页 v2 · 对话框焦点管理（桌面 / 手机共用）。
 *
 * 设置是整页覆盖层，但对键盘与读屏来说是模态对话框：
 *   - 打开时把焦点移进设置（桌面：导航首项；手机：返回键），关闭时还给触发器；
 *   - Tab / Shift+Tab 在设置内循环，不逃到背景侧栏 / 输入框；
 *   - Esc 关闭（桌面直接回原会话；手机沿用首页 → 退出的分层返回）；
 *   - 设置里再打开的配对 / 诊断 / 菜单是更高一层：它们开着时焦点循环与 Esc 都让给它们，
 *     避免一次 Esc 连关两层。
 *
 * 只操作 DOM 焦点，不读业务数据；触发器按 aria-label 记忆，手机设置退出时
 * 顶栏按钮会重挂载，仍能把焦点还回同一入口。
 */
import { useEffect, useLayoutEffect, useRef } from "react"

export interface SettingsRootRef {
  readonly current: HTMLElement | null
}

/** 原生可聚焦控件；[tabindex="-1"]（页标题等程序化焦点）不参与 Tab 循环。 */
export const SETTINGS_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

/** 在设置根内真正能按 Tab 到、且看得见的元素；inert 子树整棵排除。 */
export function focusableWithin(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  const nodes = root.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR)
  const out: HTMLElement[] = []
  for (const node of nodes) {
    if (node.closest("[inert]")) continue
    if (node.getAttribute("aria-hidden") === "true") continue
    const style = window.getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden") continue
    const rect = node.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    out.push(node)
  }
  return out
}

/**
 * 设置之上还开着的浮层：配对 / 诊断 / 命令面板 / 菜单。
 * 设置根自身也是 role=dialog，必须排除；其余看得见的模态或菜单都算「更高一层」。
 */
export function hasOpenNestedOverlay(root: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false
  const nodes = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"], [data-pi-dialog]',
  )
  for (const node of nodes) {
    // 只排除设置根自身；设置内部再开的浮层（如果有）同样算更高一层。
    if (node === root) continue
    if (node.getClientRects().length > 0) return true
  }
  return false
}

/** 关闭后找触发器：原元素还在就用它；手机顶栏会重挂载，则按 aria-label 找回同一入口。 */
export function restoreTriggerOf(trigger: HTMLElement | null): HTMLElement | null {
  if (trigger && trigger.isConnected) {
    const rect = trigger.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return trigger
  }
  const label = trigger?.getAttribute("aria-label")
  if (!label || typeof document === "undefined") return null
  const candidates = document.querySelectorAll<HTMLElement>("button[aria-label], [role='button'][aria-label]")
  for (const candidate of candidates) {
    if (candidate.getAttribute("aria-label") !== label) continue
    const style = window.getComputedStyle(candidate)
    if (style.display === "none" || style.visibility === "hidden") continue
    const rect = candidate.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return candidate
  }
  return null
}

/**
 * 关闭后设置入口重新挂载（手机列表顶栏）时按 aria-label 找回来。
 * 打开设置的那一下可能已经把列表卸载掉、activeElement 掉到 body，此时没有 trigger 可记，
 * 但退出时入口会在同一个视图里重新出现。
 */
export function visibleSettingsTrigger(): HTMLElement | null {
  if (typeof document === "undefined") return null
  const candidates = document.querySelectorAll<HTMLElement>('button[aria-label^="设置"], [role="button"][aria-label^="设置"]')
  for (const candidate of candidates) {
    if (candidate.closest("[data-pi-settings]")) continue
    const style = window.getComputedStyle(candidate)
    if (style.display === "none" || style.visibility === "hidden") continue
    const rect = candidate.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return candidate
  }
  return null
}

/**
 * 触发器已随视图卸载（手机从列表进设置、退出回会话时列表顶栏不再挂载）时的兜底：
 * 把焦点交给当前视图第一个可见控件，而不是掉回 body。
 */
export function firstFocusableOutsideSettings(): HTMLElement | null {
  if (typeof document === "undefined") return null
  const candidates = document.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR)
  for (const candidate of candidates) {
    if (candidate.closest("[data-pi-settings]")) continue
    if (candidate.getAttribute("aria-hidden") === "true") continue
    const style = window.getComputedStyle(candidate)
    if (style.display === "none" || style.visibility === "hidden") continue
    const rect = candidate.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return candidate
  }
  return null
}

export interface SettingsDialogFocusOptions {
  rootRef: SettingsRootRef
  /** 打开后先聚焦谁；不传则设置内第一个可聚焦元素，再退设置根。 */
  initialFocusSelector?: string
  /** Esc / 返回动作（桌面 = 回原会话；手机 = 首页或退出）。 */
  onEscape: () => void
  /** 额外拦截 Esc（例如宿主自己的浮层状态）；与 DOM 浮层检测取并集。 */
  escapeBlocked?: () => boolean
}

export function useSettingsDialogFocus({
  rootRef,
  initialFocusSelector,
  onEscape,
  escapeBlocked,
}: SettingsDialogFocusOptions): void {
  const escapeRef = useRef(onEscape)
  const blockedRef = useRef(escapeBlocked)
  escapeRef.current = onEscape
  blockedRef.current = escapeBlocked
  const restoreFrame = useRef(0)
  const returnFocus = useRef<HTMLElement | null>(null)
  /** 捕获阶段先判断这一下 Esc 是不是给设置之上的浮层（有些浮层关自己时不 preventDefault）。 */
  const escapeClaimed = useRef(false)

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    // StrictMode 会 setup → cleanup → setup：第二次 setup 取消第一次 cleanup 排的还原帧。
    cancelAnimationFrame(restoreFrame.current)
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !root.contains(active)) {
      returnFocus.current = active
    }
    const first =
      (initialFocusSelector ? root.querySelector<HTMLElement>(initialFocusSelector) : null) ??
      focusableWithin(root)[0] ??
      root
    first.focus({ preventScroll: true })
    return () => {
      // 等宿主把视图切回去再还原：手机顶栏 / 桌面侧栏入口可能同一帧重挂载。
      restoreFrame.current = window.requestAnimationFrame(() => {
        const target =
          restoreTriggerOf(returnFocus.current) ?? visibleSettingsTrigger() ?? firstFocusableOutsideSettings()
        target?.focus({ preventScroll: true })
      })
    }
  }, [rootRef, initialFocusSelector])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    // 捕获阶段判定「按下时是否真有更高一层浮层」，并让设置在最上层时自己消费 Esc：
    //   - Codex 的 dialog 在自己的 onKeyDown 里关自己但不 preventDefault，等冒泡到 window 时
    //     DOM 已经没了；必须在捕获阶段记账。
    //   - 手机壳（Claude 的 usePhoneEsc）也会在 window 冒泡层响应 Esc；如果设置不先
    //     stopPropagation，就会一次 Esc 连退两层。设置是当前最上层，捕获阶段截住它。
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const target = event.target instanceof Element ? event.target : null
      // 快捷键录制 / 输入法组字：Esc 属于控件本身，不关设置。
      if (target?.closest('.settings-keycap-capture[aria-pressed="true"]') || event.isComposing) {
        escapeClaimed.current = true
        return
      }
      const claimed = blockedRef.current?.() === true || hasOpenNestedOverlay(root)
      escapeClaimed.current = claimed
      if (claimed || event.defaultPrevented) return
      event.preventDefault()
      // 阻止手机壳 / 桌面壳在 window 冒泡层再执行一次「退出设置」。
      event.stopPropagation()
      escapeRef.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 正常路径在捕获阶段已经处理（并 stopPropagation）；这里只清掉本次记账，
        // 防止更高一层浮层关掉后，冒泡阶段再关设置。
        escapeClaimed.current = false
        return
      }
      if (event.key !== "Tab") return
      // 更高一层浮层自己管焦点（Radix / Claude / Codex 对话框都有自己的陷阱）。
      if (hasOpenNestedOverlay(root)) return
      const focusables = focusableWithin(root)
      if (focusables.length === 0) {
        event.preventDefault()
        root.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement as HTMLElement | null
      const index = active ? focusables.indexOf(active) : -1
      if (event.shiftKey) {
        // 首项（或焦点已不在设置内）再 Shift+Tab → 末项。
        if (index <= 0) {
          event.preventDefault()
          focusables[focusables.length - 1].focus({ preventScroll: true })
        }
        return
      }
      // 末项（或焦点已不在设置内）再 Tab → 首项。
      if (index === -1 || index === focusables.length - 1) {
        event.preventDefault()
        focusables[0].focus({ preventScroll: true })
      }
    }
    window.addEventListener("keydown", onKeyDownCapture, true)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, true)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [rootRef])
}
