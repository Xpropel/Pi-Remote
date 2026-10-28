import type { PiDeviceFrame } from "@/components/pi/shared/frame"
import type { PiLayout } from "@/components/pi/shared/viewport"
import { useMobileViewport } from "@/mobile/useMobileViewport"
import { useDesktop } from "@/shell/breakpoints"

export interface PiDevice {
  /** ≥ 1024 走桌面外壳（shell/breakpoints.ts 的 isDesktop）；< 1024（含平板 768–1023）一律手机版式 */
  desktop: boolean
  /** 部件的 viewport（PiLayout：桌面 / 手机布局） */
  viewport: PiLayout
  /** 交给 PiRoot.device：键盘状态与可视视口几何 */
  frame: PiDeviceFrame
}

/**
 * 产品模式的视口（P6.1，design §4.2 / §4.5）：布局按 useDesktop()（1024 断点），键盘与可视视口按 useMobileViewport
 * （focusin + visualViewport 的 resize / scroll；缩水 ≥ 120 或高度比 ≤ 0.82 进入，差值 ≤ 48 持续 120ms 或焦点离开退出）。
 * PiApp 和开发路由的设备模式（#/live、#/play 的 vp=device）各调一次。桌面布局下键盘恒为收起。
 */
export function usePiDevice(): PiDevice {
  const desktop = useDesktop()
  const vp = useMobileViewport()
  const keyboard = !desktop && vp.keyboard
  return {
    desktop,
    viewport: desktop ? "desktop" : "phone",
    frame: {
      keyboard,
      height: vp.height,
      offsetTop: keyboard ? vp.offsetTop : 0,
      layoutHeight: typeof window === "undefined" ? vp.height : Math.round(window.innerHeight),
    },
  }
}
