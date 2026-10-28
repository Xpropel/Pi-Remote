import type { ReactNode } from "react"
import { PiButton, PiDialog, usePiStatic, type PiOverlayControl, type PiReturnFocus } from "@/components/pi/shared"
import type { PiLayout } from "@/components/pi/shared/viewport"
import { cn } from "@/lib/utils"
import { PiDialogError, PiDialogNote } from "./PiDialogParts"

/** 弹窗家族共用的外层 props（P5.5） */
export interface PiFamilyDialogProps extends PiOverlayControl {
  viewport: PiLayout
  /** 关闭后焦点回哪（默认 = 打开前的焦点元素） */
  returnFocus?: PiReturnFocus
  /** 标题下一行灰字（会话名）；不给 = 不写 */
  subtitle?: ReactNode
}

/** 确认类弹窗（重新回答 G03 / 克隆 G09）的 props */
export interface PiConfirmDialogProps extends PiFamilyDialogProps {
  /** pi 正在输出：确认置灰并写原因 */
  busy?: boolean
  /** 会话不可用（没连上 / 没载入）：确认置灰并写原因 */
  offline?: string | null
  /** 已点确认、等回包 */
  working?: boolean
  /** 命令失败（按钮行上方红字，弹窗不关） */
  error?: string | null
  onConfirm?: () => void
}

/** 确认类弹窗的底部两颗按钮：取消（描边）+ 确认（黑） */
export function ConfirmFooter({
  phone,
  isStatic,
  confirm,
  working,
  workingText,
  disabled,
  onCancel,
  onConfirm,
}: {
  phone: boolean
  isStatic: boolean
  confirm: string
  working?: boolean
  workingText: string
  disabled?: boolean
  onCancel?: () => void
  onConfirm?: () => void
}) {
  const v = phone ? "phone" : "desktop"
  return (
    <>
      <PiButton kind="outline" variant={v} className={cn(phone && "flex-1")} disabled={working} onClick={isStatic ? undefined : onCancel}>
        取消
      </PiButton>
      <PiButton variant={v} className={cn(phone && "flex-1")} disabled={disabled || working} onClick={isStatic ? undefined : onConfirm}>
        {working ? workingText : confirm}
      </PiButton>
    </>
  )
}

/**
 * 重新回答（G03，design §2 H：PiReplyActions ↻ + PiDialog 确认，忙时禁用）。桌面 PiDialog 360；手机全高 sheet。版式推断。
 * 命令 regenerate：pi 丢掉上一条回答、按同一条用户消息重新生成。
 */
export function PiRegenerateDialog({ viewport, open, onOpenChange, static: staticProp, returnFocus, subtitle, busy, offline, working, error, onConfirm }: PiConfirmDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  return (
    <PiDialog
      title="重新回答"
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
          confirm="重新回答"
          working={working}
          workingText="正在重新回答…"
          disabled={busy || !!offline}
          onCancel={() => onOpenChange?.(false)}
          onConfirm={onConfirm}
        />
      }
    >
      <div data-slot="pi-regenerate-dialog" className="flex flex-col gap-2 pt-1">
        <PiDialogNote variant={v} tone="primary">
          让 pi 按上一条消息重新回答一次；现在这条回答会被换掉。
        </PiDialogNote>
        {busy && <PiDialogNote variant={v}>pi 正在输出，等这轮结束再重新回答。</PiDialogNote>}
        {offline && <PiDialogNote variant={v}>{offline}</PiDialogNote>}
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
