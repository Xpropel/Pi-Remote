import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react"
import type { PiLayout, PiTheme } from "@/components/pi/shared/viewport"
import { PiFrameContext, type PiDeviceFrame } from "./frame"
import { piRootGeometry, type PiRootGeometry } from "./geometry"
import { usePiPrivacy } from "./privacyContext"

/**
 * Headless 根（P2.5）：把 PiRoot 里**与视觉无关**的产品布局逻辑抽出来，供 cursor（现有界面）与两套变体 v2 共用：
 * - 产品模式：根节点 fixed 铺满窗口、高 100dvh（不支持 dvh 的浏览器由变体 CSS 兜底），键盘开着时平移到 visualViewport.offsetTop；
 * - 舞台模式（开发画廊）：根节点 absolute inset-0 铺满舞台；
 * - 安全区顶实测：一个高 = env(safe-area-inset-top) 的隐形探针 + ResizeObserver（转屏重量）；
 * - 几何 / 键盘计算见 ./geometry.ts（纯函数）；`data-pi-theme` / `data-pi-layout` / `data-pi-mode` 镜像到 `<html>`；
 * - 通过 PiFrameContext 交出视口帧（PiFrame），供「手机 dock / sheet 让位 / 贴底滚动」这类纯行为读。
 *
 * 本模块**没有任何视觉**：不加 className、不定义 token、不引 CSS。变体 v2 的用法（自己写根 DOM 的类名 / 样式）：
 *
 * ```tsx
 * import { PiHeadlessRoot } from "@/pi/headless"
 *
 * export function ClaudeApp({ relay, ui, act, layout, theme, device, keyboardOpen }: VariantAppProps) {
 *   return (
 *     <PiHeadlessRoot ui="claude" viewport={layout} theme={theme} keyboard={keyboardOpen} device={device} className="claude-root">
 *       …自己的 DOM / CSS…
 *     </PiHeadlessRoot>
 *   )
 * }
 * ```
 *
 * 组件内部会调 usePiRootGeometry（探针 + 几何）；cursor 的 PiRoot 已经算过一次，可把 `geometry` / `probeRef` 传进来复用，
 * 组件不会重复渲染探针、重复测量（内部 hook 的 ref 不挂到元素上，空跑一次 effect，代价可忽略）。
 */

export interface PiHeadlessRootOptions {
  viewport: PiLayout
  theme: PiTheme
  /** 舞台屏幕的键盘标记（只在手机布局生效）；产品模式读 device.keyboard */
  keyboard?: boolean
  /** 产品模式视口帧；不给 = 舞台模式（开发画廊） */
  device?: PiDeviceFrame
}

/**
 * 产品模式实测安全区顶 + 根节点几何。纯行为 hook：不返回 JSX、不碰 className/style。
 * 探针元素由调用方（PiHeadlessRoot 或 cursor 的 PiRoot）渲染，ref 与 style 见 PiHeadlessRoot 的 `data-pi-safe-probe`。
 */
export function usePiRootGeometry(options: PiHeadlessRootOptions): { geometry: PiRootGeometry; probeRef: RefObject<HTMLDivElement | null> } {
  const { viewport, theme, keyboard = false, device } = options
  const product = device != null
  const probeRef = useRef<HTMLDivElement>(null)
  const [safeTop, setSafeTop] = useState(0)
  useLayoutEffect(() => {
    const el = probeRef.current
    if (!product || !el) return
    const read = () => setSafeTop(Math.round(el.getBoundingClientRect().height))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [product, theme, viewport])
  const geometry = useMemo(() => piRootGeometry({ viewport, keyboard, device, safeTop }), [viewport, keyboard, device, safeTop])
  return { geometry, probeRef }
}

export interface PiHeadlessRootProps extends PiHeadlessRootOptions {
  /** 根节点的变体标记（写 data-pi-ui；cursor 现有界面 = "cursor"） */
  ui?: string
  /** 已算好的几何（cursor PiRoot 传，避免二次测量）；不传 = 组件内部自己算 */
  geometry?: PiRootGeometry
  /** 与 geometry 配对的探针 ref；不传 = 组件内部自己建 */
  probeRef?: RefObject<HTMLDivElement | null>
  /** 视觉类名（变体自己的 CSS / Tailwind；headless 自己不产生类名） */
  className?: string
  /** 额外内联样式（cursor 用它传 --cw-pi-* 变量；变体一般不用） */
  style?: CSSProperties
  children?: ReactNode
}

export function PiHeadlessRoot(props: PiHeadlessRootProps) {
  const { viewport, theme, ui = "cursor", keyboard = false, device, geometry: presetGeometry, probeRef: presetProbeRef, className, style, children } = props
  const internal = usePiRootGeometry({ viewport, theme, keyboard, device })
  const geometry = presetGeometry ?? internal.geometry
  const probeRef = presetProbeRef ?? internal.probeRef
  const product = geometry.product
  // 隐私模式（P13 宿主消费线）：设置页只写本机偏好，宿主根写 data-pi-privacy；脱敏由 CSS 做，数据不动。
  const privacy = usePiPrivacy()
  // data-pi-theme / data-pi-layout / data-pi-mode / data-pi-privacy 镜像到 <html>（portal 出去的浮层 / 侧栏气泡也跟着变）；
  // 卸载时只清自己设的值
  useLayoutEffect(() => {
    const el = document.documentElement
    el.setAttribute("data-pi-theme", theme)
    el.setAttribute("data-pi-layout", viewport)
    if (product) el.setAttribute("data-pi-mode", "product")
    if (privacy) el.setAttribute("data-pi-privacy", "on")
    else el.removeAttribute("data-pi-privacy")
    return () => {
      if (el.getAttribute("data-pi-theme") === theme) el.removeAttribute("data-pi-theme")
      if (el.getAttribute("data-pi-layout") === viewport) el.removeAttribute("data-pi-layout")
      if (product && el.getAttribute("data-pi-mode") === "product") el.removeAttribute("data-pi-mode")
      if (el.getAttribute("data-pi-privacy") === "on") el.removeAttribute("data-pi-privacy")
    }
  }, [theme, viewport, product, privacy])
  // 产品模式：fixed 铺满 + 100dvh（不支持 dvh 的浏览器由调用方 CSS 的 100vh 兜底）；键盘开着时平移到可视视口顶、底边贴布局视口底。
  // 舞台模式：absolute inset-0 铺满舞台（画廊舞台 position: relative）。
  const rootStyle: CSSProperties = {
    ...(product
      ? {
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100dvh",
          ...(geometry.keyboardOpen ? { top: geometry.vvOffsetTop, bottom: 0, height: "auto" } : null),
        }
      : { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }),
    colorScheme: theme,
    ...style,
  }
  return (
    <div
      data-pi-root=""
      data-pi-ui={ui}
      data-pi-mode={product ? "product" : undefined}
      data-pi-theme={theme}
      data-pi-layout={viewport}
      data-pi-privacy={privacy ? "on" : undefined}
      data-pi-keyboard={geometry.keyboardOpen ? "" : undefined}
      className={className}
      style={rootStyle}
    >
      {product ? (
        <div
          ref={probeRef}
          aria-hidden
          data-pi-safe-probe=""
          style={{ position: "absolute", left: 0, top: 0, width: 0, height: "env(safe-area-inset-top, 0px)", visibility: "hidden", pointerEvents: "none" }}
        />
      ) : null}
      <PiFrameContext.Provider value={geometry.frame}>{children}</PiFrameContext.Provider>
    </div>
  )
}
