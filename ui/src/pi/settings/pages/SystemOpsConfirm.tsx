/**
 * System operations confirm dialog: the PiDialog danger pattern (same family
 * as PiDeleteDialog) -- Cancel carries data-pi-autofocus, the confirm button
 * shows its pending label while the command is in flight, and a rejection
 * keeps the dialog open with the error above the footer. Body copy comes from
 * operationConfirmOf, written from the facts at hand (busy state, versions).
 */
import { useState } from "react"
import { cn } from "@/lib/utils"
import { PiButton } from "@/components/pi/shared/PiButton"
import { PiDialog } from "@/components/pi/shared/PiOverlay"
import type { PiLayout } from "@/components/pi/shared/viewport"
import {
  operationConfirmOf,
  type DeviceBusy,
  type OperationKind,
  type PiUpdateInfo,
} from "./systemOpsLogic.ts"

export interface SystemOpsConfirmProps {
  viewport: PiLayout
  open: boolean
  onOpenChange: (open: boolean) => void
  kind: OperationKind
  deviceName: string
  busy: DeviceBusy
  update: PiUpdateInfo | null
  /** Sends the command; a rejection's message is shown inside the dialog. */
  onConfirm: () => Promise<void>
}

export function SystemOpsConfirm({ viewport, open, onOpenChange, kind, deviceName, busy, update, onConfirm }: SystemOpsConfirmProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const copy = operationConfirmOf(kind, { deviceName, busy, update })

  const confirm = async () => {
    if (pending) return
    setPending(true)
    setError("")
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "操作没有被设备接受，请重试")
      setPending(false)
    }
  }

  return (
    <PiDialog
      title={copy.title}
      danger
      viewport={viewport}
      width={360}
      open={open}
      onOpenChange={onOpenChange}
      footer={
        <>
          <PiButton kind="outline" variant={variant} className={phone ? "flex-1" : undefined} data-pi-autofocus="" onClick={() => onOpenChange(false)}>
            取消
          </PiButton>
          <PiButton variant={variant} className={phone ? "flex-1" : undefined} disabled={pending} onClick={() => void confirm()}>
            {pending ? copy.pendingLabel : copy.confirmLabel}
          </PiButton>
        </>
      }
    >
      <p className={cn("m-0 text-(--cw-text-2)", phone ? "text-[15px] leading-[22px]" : "text-(length:--cw-text-md) leading-[19px]")}>
        {copy.body}
      </p>
      {error ? (
        <p role="alert" className="mt-2 mb-0 text-(length:--cw-text-md) leading-[18px] text-(--cw-pi-error)">
          {error}
        </p>
      ) : null}
    </PiDialog>
  )
}
