/**
 * 视口帧（P2.5 headless，从 `components/pi/shared/frame.ts` 抽出；原文件改为再导出，历史 import 不变）。
 *
 * 这是**无视觉**的 Headless 基础设施：只有类型 + React Context，不含 className / JSX / CSS / token。
 * 变体 v2 允许 import `@/pi/headless`（brief「用户新增硬性要求」§3 可复用清单）；cursor 的 PiRoot 也走这里。
 */
import { createContext, useContext } from "react"

/**
 * 产品模式（P6.1）的视口：由 pi/hooks/usePiDevice 给出（useMobileViewport + window.innerHeight）。
 * PiApp 和开发路由的设备模式（#/live、#/play 的 vp=device）传给 PiHeadlessRoot.device。
 */
export interface PiDeviceFrame {
  /** 键盘开着（useMobileViewport.keyboard）；只在手机布局下生效 */
  keyboard: boolean
  /** 可视视口高：键盘开着 = visualViewport.height，否则 = window.innerHeight（useMobileViewport 的口径） */
  height: number
  /** visualViewport.offsetTop（键盘开着时；否则 0） */
  offsetTop: number
  /** 布局视口高（window.innerHeight） */
  layoutHeight: number
}

/**
 * 根节点交给部件的视口帧（PiFrameContext）：手机 dock 高度、sheet 让位、贴底滚动等只读这个帧。
 * 舞台：可视视口 = 舞台高（键盘屏 844 − 336 = 508），偏移 0，安全区 47 / 0；产品：来自 device 和 env(safe-area-inset-top) 的实测值。
 */
export interface PiFrame {
  mode: "stage" | "product"
  /** 手机布局下键盘开着 */
  keyboardOpen: boolean
  /** 可视视口高（CSS px） */
  vvHeight: number
  /** 可视视口顶边在布局视口里的位置（键盘开着时产品根节点已经平移到这里） */
  vvOffsetTop: number
  /** 安全区顶（env(safe-area-inset-top) 的实测值 / 舞台固定值） */
  safeTop: number
  /** 根节点底部被键盘盖住的高度 */
  keyboardH: number
}

/** 不在任何根里时的视口帧：键盘收起的舞台帧（和原 components/pi/shared/frame.ts 一致） */
export const DEFAULT_PI_FRAME: PiFrame = { mode: "stage", keyboardOpen: false, vvHeight: 844, vvOffsetTop: 0, safeTop: 0, keyboardH: 0 }

export const PiFrameContext = createContext<PiFrame>(DEFAULT_PI_FRAME)

/** 当前根节点的视口帧（不在根里时是 DEFAULT_PI_FRAME） */
export function usePiFrame(): PiFrame {
  return useContext(PiFrameContext)
}
