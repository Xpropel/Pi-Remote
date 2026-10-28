import type { ReactNode } from "react"
import { PiPrivacyContext } from "./privacyContext"

/**
 * 隐私模式 Provider（P13 设置页 v2 宿主消费线）。
 *
 * 放在 headless 是为了让 cursor（PiRoot）与 claude / codex（PiHeadlessRoot）共用同一条通路，
 * 而不让视觉变体依赖设置页模块。真实数据不动，只把布尔值交给根节点写 data 属性。
 */
export interface PiPrivacyProviderProps {
  value: boolean
  children: ReactNode
}

export function PiPrivacyProvider({ value, children }: PiPrivacyProviderProps) {
  return <PiPrivacyContext.Provider value={value}>{children}</PiPrivacyContext.Provider>
}
