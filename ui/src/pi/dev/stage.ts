import { useEffect, useLayoutEffect, useState } from "react"
import { piLayoutOf } from "@/components/pi/shared/viewport"
import { PI_KEYBOARD_H, PI_STAGE, type PiTheme, type PiStageSize } from "./registry"

/*
 * 舞台的公共件（从 PiStage.tsx 拆出来，P4 的可交互路由 #/play 也用）：就绪标记、舞台变量、<html> 镜像。
 * 照 replica 的 app/useReady.ts；行为和拆出来之前一样。错误边界在 ./ErrorBoundary.tsx。
 */

/**
 * 字体就绪 + 两帧 rAF 之后返回 true；舞台据此设 data-pi-ready，截图脚本等它再截图。
 * 兜底计时器：字体就绪 150ms 后无论 rAF 是否到达都视为就绪（截图脚本自己还会再等两帧 rAF）。
 */
export function useReady() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    let raf = 0
    let timer = 0
    const done = () => {
      if (!cancelled) setReady(true)
    }
    document.fonts.ready.then(() => {
      if (cancelled) return
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(done)
      })
      timer = window.setTimeout(done, 150)
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [])
  return ready
}

/** 舞台上的 CSS 变量：屏幕用它们留出状态栏、Home 指示条和屏幕键盘 */
export function stageVars(viewport: PiStageSize, keyboard: boolean) {
  const s = PI_STAGE[viewport]
  return {
    "--cw-pi-safe-top": `${s.safeTop}px`,
    "--cw-pi-safe-bottom": `${s.safeBottom}px`,
    "--cw-pi-keyboard-h": `${keyboard ? PI_KEYBOARD_H : 0}px`,
  }
}

/** 主题和 --cw-pi-* 变量同时挂到 <html> 上（data-pi-theme / data-pi-layout），portal 出去的弹层也能拿到；离开时清掉 */
export function useStageHtml(ok: boolean, viewport: PiStageSize, theme: PiTheme, keyboard: boolean) {
  useLayoutEffect(() => {
    if (!ok) return
    const el = document.documentElement
    const vars = stageVars(viewport, keyboard)
    el.setAttribute("data-pi-theme", theme)
    el.setAttribute("data-pi-layout", piLayoutOf(viewport))
    el.style.colorScheme = theme
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
    return () => {
      el.removeAttribute("data-pi-theme")
      el.removeAttribute("data-pi-layout")
      el.style.colorScheme = ""
      for (const k of Object.keys(vars)) el.style.removeProperty(k)
    }
  }, [ok, viewport, theme, keyboard])
}
