/**
 * 根视口的无样式几何计算（P2.5 headless，从 PiRoot 抽出）。
 *
 * 口径与 P6.1 的 `PiRoot` 完全一致（舞台安全区 / 产品模式 env() 实测 / 键盘 frame），只是不含任何 React、CSS、className：
 * - cursor 的 PiRoot 用 `usePiRootGeometry`（./root.tsx）复用这里的计算；
 * - 变体 v2 用 `PiHeadlessRoot` + `usePiRootGeometry`，自己的根 DOM / 类名 / token 全部自写。
 *
 * 纯函数 + 纯常量：node --test 可直接加载（test/pi-ui-independence.test.mjs）。
 */
import type { PiLayout } from "@/components/pi/shared/viewport"
import type { PiDeviceFrame, PiFrame } from "./frame"

/** 与舞台一致的安全区（推断/估计，未在真机上量过；pi/shell-changes.md §3） */
export const PI_SAFE_AREA: Record<PiLayout, { top: number; bottom: number }> = {
  phone: { top: 47, bottom: 34 },
  desktop: { top: 0, bottom: 0 },
}

/** 舞台屏键盘占位高度（和开发画廊 PI_KEYBOARD_H 一致） */
export const PI_KEYBOARD_HEIGHT = 336

/** 舞台高（和开发画廊的 PI_STAGE 一致） */
export const PI_STAGE_HEIGHT: Record<PiLayout, number> = { phone: 844, desktop: 900 }

export interface PiRootGeometryInput {
  viewport: PiLayout
  /** 舞台屏幕的键盘标记（只在手机布局生效）；产品模式不读它，读 device.keyboard */
  keyboard?: boolean
  /** 产品模式视口帧；不给 = 舞台模式（画廊） */
  device?: PiDeviceFrame
  /** 产品模式实测安全区顶（ResizeObserver + env(safe-area-inset-top) 探针给；默认 0） */
  safeTop?: number
}

/** 根节点的几何计算结果（视觉无关，cursor 与变体 v2 共用） */
export interface PiRootGeometry {
  mode: "stage" | "product"
  product: boolean
  phone: boolean
  keyboardOpen: boolean
  /** 根节点底部被键盘盖住的高度（产品：布局视口底 − 可视视口底；舞台：PI_KEYBOARD_HEIGHT 或 0） */
  keyboardH: number
  /** 可视视口高 */
  vvHeight: number
  /** 可视视口顶边在布局视口里的偏移（产品模式键盘开着时根节点要平移的量） */
  vvOffsetTop: number
  /** 安全区顶：产品模式取探针实测值，舞台取 PI_SAFE_AREA */
  safeTop: number
  /** 交给 PiFrameContext 的帧（历史字段口径不变） */
  frame: PiFrame
}

/** 纯计算：输入视口 / 键盘 / 产品帧 / 实测安全区 → 根节点几何 + 视口帧。 */
export function piRootGeometry(input: PiRootGeometryInput): PiRootGeometry {
  const { viewport, keyboard = false, device, safeTop: probeTop = 0 } = input
  const product = device != null
  const phone = viewport === "phone"
  const keyboardOpen = product ? phone && device.keyboard : keyboard && phone
  const keyboardH = !keyboardOpen
    ? 0
    : product
      ? Math.max(0, Math.round(device.layoutHeight - device.offsetTop - device.height))
      : PI_KEYBOARD_HEIGHT
  const vvHeight = product ? device.height : PI_STAGE_HEIGHT[viewport] - keyboardH
  const vvOffsetTop = product && keyboardOpen ? device.offsetTop : 0
  const safeTop = product ? probeTop : PI_SAFE_AREA[viewport].top
  const mode = product ? ("product" as const) : ("stage" as const)
  return {
    mode,
    product,
    phone,
    keyboardOpen,
    keyboardH,
    vvHeight,
    vvOffsetTop,
    safeTop,
    frame: { mode, keyboardOpen, vvHeight, vvOffsetTop, safeTop, keyboardH },
  }
}
