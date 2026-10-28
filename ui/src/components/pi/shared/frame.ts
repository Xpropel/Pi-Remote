import { createContext, useContext } from "react"
import type { PiPhoneDockLayout } from "@/pi/model/phoneDock"

/*
 * 视口帧（P6，p6-base）：PiRoot 产品模式的输入（PiDeviceFrame）、根节点交给部件的帧（usePiFrame），
 * 以及 PiPhonePage 交给 dock 里部件的高度上限（usePiDockLayout）。
 *
 * P2.5 headless：PiDeviceFrame / PiFrame / PiFrameContext / usePiFrame 已挪到 `@/pi/headless`（无视觉基础设施，变体 v2 可复用）；
 * 本文件只保留再导出（历史 import 全部不变）+ cursor 手机 dock 的 PiDockLayoutContext（cursor 专有，不给变体用）。
 */

export { PiFrameContext, usePiFrame } from "@/pi/headless/frame"
export type { PiDeviceFrame, PiFrame } from "@/pi/headless/frame"

export const PiDockLayoutContext = createContext<PiPhoneDockLayout | null>(null)

/**
 * dock 的高度上限（P6.3，design §4.2 规则 3–4）：PiPhonePage 按视口帧算好 phoneDockLayout(vvHeight, keyboardOpen, null)，
 * dock 里的部件只读结果（dockMax = 键盘收起 50% / 开着 60%，approvalMax = 开着 40%）。不在手机 dock 里时为 null。
 * 同样的数也写在 [data-pi-dock] 的 --cw-pi-dock-max / --cw-pi-approval-max 上（CSS 用）。
 */
export function usePiDockLayout(): PiPhoneDockLayout | null {
  return useContext(PiDockLayoutContext)
}
