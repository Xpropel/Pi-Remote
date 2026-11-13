import type { ReactNode } from "react"
import { PiButton, PiDialog, usePiStatic, type PiOverlayControl, type PiReturnFocus } from "@/components/pi/shared"
import type { PiLayout } from "@/components/pi/shared/viewport"
import { cn } from "@/lib/utils"
import { PiDialogError, PiDialogNote } from "./PiDialogParts"
import type { PiRegenerateTarget } from "./regenerateTarget"

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
 * 命令 regenerate（扩展 cmdRegenerate）：把最后一条用户消息的文字再发一次（图片不重发），pi 在后面接着回答一轮；原来的回答留在对话里，不是替换。
 * resend：要重发的那条（灰字标题是会话名、常常就是第一条消息，所以把真正重发的原文引出来）；不给 = 只写说明。
 */
export function PiRegenerateDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  busy,
  offline,
  working,
  error,
  onConfirm,
  resend,
}: PiConfirmDialogProps & { resend?: PiRegenerateTarget | null }) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  const noText = !!resend && !resend.text
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
          disabled={busy || !!offline || noText}
          onCancel={() => onOpenChange?.(false)}
          onConfirm={onConfirm}
        />
      }
    >
      <div data-slot="pi-regenerate-dialog" className="flex flex-col gap-2 pt-1">
        <PiDialogNote variant={v} tone="primary">
          把上一条消息的文字再发一次，pi 会在后面重新回答一轮；原来的回答仍留在对话里。
        </PiDialogNote>
        {resend?.text && (
          <blockquote
            aria-label="将重发的消息"
            data-slot="pi-regenerate-quote"
            className={cn(
              "m-0 line-clamp-3 rounded-(--cw-radius-card) border border-solid border-(--cw-border) bg-(--cw-bg) px-3 py-2 break-words whitespace-pre-wrap text-(--cw-text)",
              phone ? "text-[15px] leading-[22px]" : "text-(length:--cw-text-md) leading-(--cw-leading-base)",
            )}
          >
            {resend.text}
          </blockquote>
        )}
        {resend?.text && resend.images > 0 && <PiDialogNote variant={v}>这条消息里的图片不会重发，只发文字。</PiDialogNote>}
        {noText && <PiDialogNote variant={v}>上一条消息只有图片，没有文字可重发。</PiDialogNote>}
        {busy && <PiDialogNote variant={v}>pi 正在输出，等这轮结束再重新回答。</PiDialogNote>}
        {offline && <PiDialogNote variant={v}>{offline}</PiDialogNote>}
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
