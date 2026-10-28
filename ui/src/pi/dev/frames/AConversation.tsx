import type { ReactNode } from "react"
import { CONVO_SHORT, NOW, TRAY_CHANGES } from "@/pi/dev/fixtures/gallery/b"
import { PiTranscript } from "@/components/pi/conversation/PiTranscript"
import { PiComposerDock, type PiComposerDockProps } from "@/components/pi/composer"
import { C_MODEL_LABEL } from "@/pi/dev/fixtures/gallery/c"
import type { PiItem } from "@/components/pi/shared"

/**
 * a 区屏幕里的当前会话（r-s1）主区：b 区的 PiTranscript（CONVO_SHORT = r-s1 最后一个回合）+ c 区的 PiComposerDock。
 * 只组合别区的导出件，不复制它们（design §6.6 第 4 条）。
 */
export interface ATranscriptProps {
  variant: "desktop" | "phone"
  items?: readonly PiItem[]
  topLine?: ReactNode
}

export function ATranscript({ variant, items = CONVO_SHORT, topLine }: ATranscriptProps) {
  return <PiTranscript items={items} variant={variant} now={NOW} topLine={topLine} />
}

export type ADockProps = Partial<Omit<PiComposerDockProps, "variant">> & { variant: "desktop" | "phone" }

/** r-s1 回合结束后的 dock：S0、tray 只有"改动 +28 −9"、框下"MacBook Pro · main"（与 b/conversation 一致） */
export function ADock({ variant, ...overrides }: ADockProps) {
  return (
    <PiComposerDock
      variant={variant}
      state="S0"
      model={C_MODEL_LABEL}
      tray={[TRAY_CHANGES]}
      status={{ device: "MacBook Pro", branch: "main" }}
      {...overrides}
    />
  )
}
