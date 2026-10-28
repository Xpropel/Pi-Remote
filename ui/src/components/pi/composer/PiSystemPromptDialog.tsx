import { PiDialog, usePiStatic } from "@/components/pi/shared"
import { PiDialogNote, PiDialogStatus, PiTextBlock, type PiDialogPhase } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"

export interface PiSystemPromptDialogProps extends PiFamilyDialogProps {
  /** prompt = 全文（可能截断）；reason = 读不到时的原因（不支持 / 没返回） */
  view?: { kind: "prompt"; text: string; truncated: boolean; chars: number | null } | { kind: "reason"; text: string }
  /** 字数（截断时是全文字数） */
  chars?: number | null
  phase?: PiDialogPhase
  loadError?: string | null
  onRetry?: () => void
}

/**
 * 系统提示词（G15，design §2 H：PiDialog + 等宽全文；全文 + 字数 + 截断标记）。get_system_prompt 的回包，只读。
 * 桌面 PiDialog 560；手机全高 sheet。版式推断。
 */
export function PiSystemPromptDialog({ viewport, open, onOpenChange, static: staticProp, returnFocus, subtitle, view, chars, phase = "ready", loadError, onRetry }: PiSystemPromptDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  return (
    <PiDialog
      title="系统提示词"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={560}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
    >
      <div data-slot="pi-system-prompt-dialog" className="flex flex-col gap-3 pt-1">
        <PiDialogStatus variant={v} phase={phase} error={loadError} onRetry={onRetry}>
          {view?.kind === "reason" ? (
            <PiDialogNote variant={v} tone="primary">
              <span role="status">{view.text}</span>
            </PiDialogNote>
          ) : view ? (
            <>
              <PiDialogNote variant={v}>
                {chars != null ? `共 ${chars.toLocaleString("zh-CN")} 字` : ""}
                {view.truncated ? `${chars != null ? " · " : ""}已截断，这里只显示前面一部分` : ""}
              </PiDialogNote>
              <PiTextBlock variant={v} text={view.text} label="系统提示词全文" maxHeight={phone ? 480 : 380} />
            </>
          ) : null}
        </PiDialogStatus>
      </div>
    </PiDialog>
  )
}
