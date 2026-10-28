import { PiDialog, usePiStatic } from "@/components/pi/shared"
import { PiDialogStatus, PiKVRows, type PiDialogPhase } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"

export interface PiSessionStateDialogProps extends PiFamilyDialogProps {
  /** get_state 的键值行（dialogsData.sessionStateRowsOf） */
  rows?: readonly (readonly [string, string])[]
  phase?: PiDialogPhase
  loadError?: string | null
  onRetry?: () => void
}

/**
 * 当前状态（G17，/session；design §2 H：PiDialog 键值行，标签灰 / 数值黑右对齐）。get_state 的回包，只读。
 * 桌面 PiDialog 480；手机全高 sheet。版式推断。
 */
export function PiSessionStateDialog({ viewport, open, onOpenChange, static: staticProp, returnFocus, subtitle, rows = [], phase = "ready", loadError, onRetry }: PiSessionStateDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  return (
    <PiDialog
      title="当前状态"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={480}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
    >
      <div data-slot="pi-session-state-dialog" className="flex flex-col pt-1">
        <PiDialogStatus variant={v} phase={phase} error={loadError} onRetry={onRetry}>
          <PiKVRows variant={v} rows={rows} />
        </PiDialogStatus>
      </div>
    </PiDialog>
  )
}
