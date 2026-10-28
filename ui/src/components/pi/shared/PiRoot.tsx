import type { CSSProperties, ReactNode } from "react"
import type { PiTheme, PiLayout } from "@/components/pi/shared/viewport"
import type { PiUiVariant } from "@/pi/variants/types"
import { PiHeadlessRoot, usePiRootGeometry } from "@/pi/headless"
import { PI_SAFE_AREA } from "@/pi/headless/geometry"
import { cn } from "@/lib/utils"
import type { PiDeviceFrame } from "@/pi/headless/frame"
import "./pi-theme.css"

/*
 * P2.5 headless：根节点的布局逻辑（写 <html> data 属性、产品模式 fixed / 100dvh 几何、安全区 / 键盘 frame、
 * PiFrameContext）已抽到 `@/pi/headless`（变体 v2 复用同一套语义）。本文件只剩 cursor 的**视觉**部分：
 * - 类名（overflow-hidden / --cw-* token / antialiased）与 pi-theme.css 完全保持原样；
 * - 舞台模式的 --cw-pi-safe-* / --cw-pi-keyboard-h 变量、产品模式的 --cw-pi-keyboard-h，pi-theme.css 的几何规则照旧生效；
 * - DOM 结构、data-pi-* 属性、类名零变化（多出的行内 position 几何值与原 pi-theme.css 计算值一致）。
 */

export { PI_KEYBOARD_HEIGHT, PI_SAFE_AREA, PI_STAGE_HEIGHT } from "@/pi/headless/geometry"

export interface PiRootProps {
  viewport: PiLayout
  theme: PiTheme
  /**
   * 变体根标记（P1 架构线，brief §架构契约 6）：写到根节点的 data-pi-ui 上，默认 "cursor"。
   * PiApp 按偏好传当前变体；claude / codex 的骨架根节点也经这个属性标出来。
   */
  ui?: PiUiVariant
  /** 舞台：屏幕的 piScreen.keyboard；只在 390×844 生效（--cw-pi-keyboard-h = 336px）。产品模式不读它，改读 device.keyboard */
  keyboard?: boolean
  /**
   * P6.1 产品模式：给了就是产品（PiApp、开发路由的设备模式），不给 = 舞台（画廊，L1 不变）。
   * 产品：根节点 fixed 铺满窗口，高 100dvh（100vh 回退，pi-theme.css）；--cw-pi-safe-* 取 env(safe-area-inset-*)（pi-theme.css）；
   * 手机布局下键盘开着时根节点平移到 visualViewport.offsetTop、底边贴布局视口底，--cw-pi-keyboard-h = 布局视口底 − 可视视口底
   * （iOS = 键盘高；Android resizes-content 已经缩了布局视口，所以是 0）。
   */
  device?: PiDeviceFrame
  className?: string
  children?: ReactNode
}

/**
 * 每个 Pi 屏幕的根（design §6.3、§7）：设 data-pi-theme / data-pi-layout（pi-theme.css 据此切深色与手机尺寸），
 * 并把这两个属性镜像到 <html>，portal 出去的菜单、悬停卡也跟着变。卸载时只清掉自己设的值（舞台同样会清）。
 * 舞台模式铺满舞台（absolute），安全区 / 键盘用舞台的固定值；产品模式见 device。两种模式都经 usePiFrame 交出视口帧。
 * P2.5：布局 / 视口帧全部委托 `@/pi/headless`（PiHeadlessRoot + usePiRootGeometry），这里只提供 cursor 的视觉 class 与 --cw-* 变量。
 */
export function PiRoot({ viewport, theme, ui = "cursor", keyboard = false, device, className, children }: PiRootProps) {
  const { geometry, probeRef } = usePiRootGeometry({ viewport, theme, keyboard, device })
  // 类名与原来逐字一致：产品模式 = base；舞台模式 = "absolute inset-0" + base。
  // 产品模式的定位 / 100dvh / 键盘平移由 headless 行内给；--cw-pi-* 变量供 pi-theme.css 与 cursor 部件读取。
  const base = "overflow-hidden bg-(--cw-bg) text-(length:--cw-text-base) leading-(--cw-leading-base) text-(--cw-text) antialiased"
  const style = geometry.product
    ? ({
        "--cw-pi-keyboard-h": `${geometry.keyboardH}px`,
        colorScheme: theme,
      } as CSSProperties)
    : ({
        "--cw-pi-safe-top": `${PI_SAFE_AREA[viewport].top}px`,
        "--cw-pi-safe-bottom": `${PI_SAFE_AREA[viewport].bottom}px`,
        "--cw-pi-keyboard-h": `${geometry.keyboardH}px`,
        colorScheme: theme,
      } as CSSProperties)
  return (
    <PiHeadlessRoot
      viewport={viewport}
      theme={theme}
      ui={ui}
      keyboard={keyboard}
      device={device}
      geometry={geometry}
      probeRef={probeRef}
      className={geometry.product ? cn(base, className) : cn("absolute inset-0", base, className)}
      style={style}
    >
      {children}
    </PiHeadlessRoot>
  )
}
