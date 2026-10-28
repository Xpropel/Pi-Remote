/** 发送键偏好的 Provider（与 privacy.tsx 同法：context 在 .ts，组件单独一个 .tsx，Fast Refresh 不混导出）。 */
import type { ReactNode } from "react"
import { normalizeSendKey, type PiSendKey } from "./composerSendKey"
import { PiSendKeyContext } from "./sendKeyContext"

export interface PiSendKeyProviderProps {
  value: PiSendKey | string | null | undefined
  children: ReactNode
}

export function PiSendKeyProvider({ value, children }: PiSendKeyProviderProps) {
  return <PiSendKeyContext.Provider value={normalizeSendKey(value)}>{children}</PiSendKeyContext.Provider>
}
