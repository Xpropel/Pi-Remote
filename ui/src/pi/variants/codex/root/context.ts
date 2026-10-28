import { createContext, useContext } from "react"
import type { PiLayout, PiTheme } from "@/components/pi/shared/viewport"

/** 变体自己的 class 拼接（完全自包含，不 import @/lib/utils） */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" ")
}

/** 视口帧（变体自有）：舞台（画廊对图，无交互）或产品（真实浏览器） */
export interface CodexFrame {
  stage: boolean
  layout: PiLayout
  theme: PiTheme
  keyboardOpen: boolean
  vvHeight: number
  safeTop: number
  safeBottom: number
  keyboardH: number
}

export const CodexFrameContext = createContext<CodexFrame>({
  stage: true,
  layout: "desktop",
  theme: "light",
  keyboardOpen: false,
  vvHeight: 900,
  safeTop: 0,
  safeBottom: 0,
  keyboardH: 0,
})

export function useCodexFrame(): CodexFrame {
  return useContext(CodexFrameContext)
}

/** 静态态：舞台 = 不可交互（截图可复现） */
export function useCodexStage(): boolean {
  return useCodexFrame().stage
}
