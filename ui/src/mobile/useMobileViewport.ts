import { useEffect, useRef, useState } from "react"
import { isCompactHeight, isShortHeight } from "./model"

/**
 * 第 3 章 §3.3 的键盘/视口状态机（移动壳专用，不动桌面 useKeyboardFrame）。
 *
 * 判定：
 * - 只在文本输入聚焦时进入键盘模式；
 * - 相对聚焦时的基线高度缩水 >= 120px，或高度比 <= 0.82；
 * - 高度差 <= 48px 持续 120ms 或焦点离开才退出（滞回，避免地址栏/键盘动画抖动）；
 * - 普通浏览状态不改 100dvh；仅键盘模式把 --app-height 临时写成 vv.height。
 *
 * 定位：
 * - 键盘模式返回 visualViewport 的 height/offsetTop，壳用 fixed + top/height
 *   让 ComposerDock 底边正好贴在键盘顶边；
 * - 普通模式只返回 window.innerHeight 口径的可见高度，地址栏收展只让列表变高。
 */

export type MobileViewport = {
  width: number
  height: number
  offsetTop: number
  keyboard: boolean
  compactHeight: boolean
  shortHeight: boolean
}

const EXIT_GAP = 48
const EXIT_DELAY_MS = 120
const ENTER_GAP = 120
const ENTER_RATIO = 0.82

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return true
  if (!(target instanceof HTMLInputElement)) return false
  return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(target.type)
}

function viewportFrame(keyboard: boolean): Pick<MobileViewport, "width" | "height" | "offsetTop"> {
  const vv = window.visualViewport
  if (keyboard && vv) {
    return { width: Math.round(vv.width), height: Math.round(vv.height), offsetTop: Math.round(vv.offsetTop) }
  }
  return { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight), offsetTop: 0 }
}

function snapshot(keyboard: boolean): MobileViewport {
  const frame = viewportFrame(keyboard)
  return {
    ...frame,
    keyboard,
    compactHeight: isCompactHeight(frame.height),
    shortHeight: isShortHeight(frame.height),
  }
}

function same(a: MobileViewport, b: MobileViewport): boolean {
  return a.width === b.width && a.height === b.height && a.offsetTop === b.offsetTop && a.keyboard === b.keyboard && a.compactHeight === b.compactHeight && a.shortHeight === b.shortHeight
}

export function useMobileViewport(): MobileViewport {
  const [state, setState] = useState<MobileViewport>(() => snapshot(false))
  const keyboardRef = useRef(false)
  const focusedRef = useRef(false)
  const baselineRef = useRef(0)
  const exitTimerRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const root = document.documentElement

    const apply = (next: MobileViewport) => {
      keyboardRef.current = next.keyboard
      setState((prev) => (same(prev, next) ? prev : next))
      if (next.keyboard) {
        root.style.setProperty("--app-height", `${next.height}px`)
        root.style.setProperty("--kv-top", `${next.offsetTop}px`)
      } else {
        root.style.removeProperty("--app-height")
        root.style.removeProperty("--kv-top")
      }
    }

    const clearExit = () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }

    const evaluate = () => {
      rafRef.current = null
      const vv = window.visualViewport
      const layoutHeight = Math.round(window.innerHeight)
      const visualHeight = Math.round(vv?.height ?? layoutHeight)
      const focused = focusedRef.current

      if (!baselineRef.current) baselineRef.current = focused ? layoutHeight || visualHeight : layoutHeight || visualHeight
      if (!focused) {
        baselineRef.current = layoutHeight || visualHeight
        clearExit()
        if (keyboardRef.current) {
          apply(snapshot(false))
          window.scrollTo(0, 0)
        }
        return
      }

      const baseline = baselineRef.current || layoutHeight || visualHeight
      const gap = Math.max(baseline - visualHeight, baseline - layoutHeight)
      // 允许双指缩放；放大时 visualViewport 变小不能误判成键盘。
      const zoomed = (vv?.scale ?? 1) > 1.01
      const entering = !zoomed && (gap >= ENTER_GAP || visualHeight / baseline <= ENTER_RATIO)

      if (!keyboardRef.current) {
        if (!entering) {
          const frame = viewportFrame(false)
          apply({
            ...frame,
            keyboard: false,
            compactHeight: isCompactHeight(frame.height),
            shortHeight: isShortHeight(frame.height),
          })
          return
        }
        clearExit()
        apply(snapshot(true))
        return
      }

      // 已经在键盘模式：逐帧跟随 vv 的 height/offsetTop；退出走 120ms 滞回。
      if (gap <= EXIT_GAP) {
        if (exitTimerRef.current === null) {
          exitTimerRef.current = window.setTimeout(() => {
            exitTimerRef.current = null
            if (!focusedRef.current) return
            if (keyboardRef.current) {
              apply(snapshot(false))
              window.scrollTo(0, 0)
            }
          }, EXIT_DELAY_MS)
        }
      } else {
        clearExit()
        apply(snapshot(true))
      }
    }

    const schedule = () => {
      if (rafRef.current !== null) return
      rafRef.current = window.requestAnimationFrame(evaluate)
    }

    // 普通浏览时页面滚动会触发 vv.scroll；只有键盘模式才需要逐帧跟 offsetTop。
    const onVvScroll = () => {
      if (keyboardRef.current) schedule()
    }

    const onFocusIn = (event: FocusEvent) => {
      if (!isTextInput(event.target)) return
      focusedRef.current = true
      // 基线与「聚焦那一刻」比：Android resizes-content 会把 innerHeight 也一起缩小。
      baselineRef.current = Math.round(window.innerHeight) || Math.round(window.visualViewport?.height ?? 0)
      clearExit()
      schedule()
    }

    const onFocusOut = () => {
      // 焦点在输入框之间移动时不要退出键盘模式。
      window.setTimeout(() => {
        if (isTextInput(document.activeElement)) return
        focusedRef.current = false
        baselineRef.current = Math.round(window.innerHeight)
        clearExit()
        schedule()
      }, 0)
    }

    const onResize = () => {
      if (!focusedRef.current) baselineRef.current = Math.round(window.innerHeight)
      schedule()
    }

    document.addEventListener("focusin", onFocusIn, true)
    document.addEventListener("focusout", onFocusOut, true)
    window.addEventListener("resize", onResize)
    const vv = window.visualViewport
    vv?.addEventListener("resize", schedule)
    vv?.addEventListener("scroll", onVvScroll)

    apply(snapshot(false))
    return () => {
      document.removeEventListener("focusin", onFocusIn, true)
      document.removeEventListener("focusout", onFocusOut, true)
      window.removeEventListener("resize", onResize)
      vv?.removeEventListener("resize", schedule)
      vv?.removeEventListener("scroll", onVvScroll)
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current)
      clearExit()
      root.style.removeProperty("--app-height")
      root.style.removeProperty("--kv-top")
    }
  }, [])

  return state
}
