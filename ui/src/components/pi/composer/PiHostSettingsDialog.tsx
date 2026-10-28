import { PiDialog, usePiStatic } from "@/components/pi/shared"
import { PiDialogNote, PiDialogStatus, PiTextBlock, type PiDialogPhase } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"

export interface PiJsonDialogData {
  /** JSON 全文（≤ 200k 字符，dialogsData.jsonTextOf） */
  json?: string
  clipped?: boolean
  phase?: PiDialogPhase
  loadError?: string | null
  onRetry?: () => void
}

/**
 * 本机设置（G14，design §2 H：PiDialog + JSON；敏感键 *** 不变）。get_settings 的回包，扩展侧已脱敏，这里只读。
 * 桌面 PiDialog 560；手机全高 sheet。版式推断（design 写 PiCodeBlock(json)；这里用等宽可选中的文本块，不加高亮，免得为它加载 shiki）。
 */
export function PiHostSettingsDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  json = "",
  clipped,
  phase = "ready",
  loadError,
  onRetry,
}: PiFamilyDialogProps & PiJsonDialogData) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  return (
    <PiDialog
      title="本机设置"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={560}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
    >
      <div data-slot="pi-host-settings-dialog" className="flex flex-col gap-3 pt-1">
        <PiDialogNote variant={v}>敏感键已经脱敏成 ***。这里只读，要改请在电脑终端里改。</PiDialogNote>
        <PiDialogStatus variant={v} phase={phase} error={loadError} onRetry={onRetry}>
          <PiTextBlock variant={v} text={json} clipped={clipped} label="本机设置（JSON）" maxHeight={phone ? 480 : 360} />
        </PiDialogStatus>
      </div>
    </PiDialog>
  )
}
