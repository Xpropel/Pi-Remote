import type { VariantAppProps } from "@/pi/variants/types"
import { CodexReviewPanel } from "./CodexReviewPanel"

/** 右栏容器（桌面 aside / 手机整页推入）：`min(667px,44vw)`，可开合（[X-§5] / X-01-14） */
export function CodexPanel({ p, phone = false, onClose, onOpenTerminal }: { p: VariantAppProps; phone?: boolean; onClose?: () => void; onOpenTerminal?: () => void }) {
  return <CodexReviewPanel p={p} phone={phone} onClose={onClose} onOpenTerminal={onOpenTerminal} />
}
