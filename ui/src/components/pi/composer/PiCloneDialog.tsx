import { PiDialog, usePiStatic } from "@/components/pi/shared"
import { PiDialogError, PiDialogNote } from "./PiDialogParts"
import { ConfirmFooter, type PiConfirmDialogProps } from "./PiRegenerateDialog"

/**
 * 克隆分支（G09，design §2 H：PiDialog 确认）。桌面 PiDialog 360；手机全高 sheet。版式推断。
 * 命令 clone：把当前分支复制成一个新会话，原会话不变；新会话出现在列表里。
 */
export function PiCloneDialog({ viewport, open, onOpenChange, static: staticProp, returnFocus, subtitle, busy, offline, working, error, onConfirm }: PiConfirmDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  return (
    <PiDialog
      title="克隆成新会话"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={360}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={
        <ConfirmFooter
          phone={phone}
          isStatic={isStatic}
          confirm="克隆"
          working={working}
          workingText="正在克隆…"
          disabled={busy || !!offline}
          onCancel={() => onOpenChange?.(false)}
          onConfirm={onConfirm}
        />
      }
    >
      <div data-slot="pi-clone-dialog" className="flex flex-col gap-2 pt-1">
        <PiDialogNote variant={v} tone="primary">
          把当前分支复制成一个新会话，原会话不变。新会话会出现在左侧列表里。
        </PiDialogNote>
        {busy && <PiDialogNote variant={v}>pi 正在输出，等这轮结束再克隆。</PiDialogNote>}
        {offline && <PiDialogNote variant={v}>{offline}</PiDialogNote>}
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
