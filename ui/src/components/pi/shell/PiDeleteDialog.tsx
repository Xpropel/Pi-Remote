import { useState } from "react"
import { cn } from "@/lib/utils"
import { PiButton } from "@/components/pi/shared/PiButton"
import { PiDialog } from "@/components/pi/shared/PiOverlay"
import type { PiOverlayControl, PiReturnFocus } from "@/components/pi/shared/layers"
import type { PiLayout } from "@/components/pi/shared/viewport"

/**
 * 删除确认（G13，plan P5.3；replica 只写在 states 里，起点是 #/play 的 a 线版本）：PiDialog danger，"取消"标 data-pi-autofocus
 * （危险确认的焦点进"取消"）；当前会话不能删（菜单项已禁用）。关闭后焦点回行；行被删了回顶栏标题（[data-pi-focus-fallback]）。
 * 删除失败时弹窗不关，按钮行上方红字。
 *
 * 文案照事实写（design §1.9 诚实数据；P9 B，F-R7）：删除动作和 pi 里一样，先在设备上删文件（有 trash 时进废纸篓），
 * 设备确认成功以后 relay 再清掉服务器上的全部副本（名册里的离线房间、正文缓存与房间文件、会话库正文、索引里的旧行）。
 * 三轮写法按能力选：
 *  - relay 有 session.purge、设备有 trash：移到废纸篓，可恢复；服务器记录与副本一起清除；
 *  - relay 有 session.purge、设备没有 trash：直接删文件，删除后不能恢复；服务器记录与副本一起清除；
 *  - 旧 relay（没有 session.purge）：维持 R25 的事实——只删设备上的文件，服务器上的副本不跟着删。
 * 两种新写法都实测过（P9 验收 B），不写「永久删除」这种不准确的词。
 */
export interface PiDeleteDialogProps extends PiOverlayControl {
  viewport: PiLayout
  /** 会话标题 */
  title: string
  /** 会话所在设备的名字；不知道就写"这台设备" */
  deviceName?: string
  /** relay 有 session.purge（删除成功后服务器清副本并广播 session_removed）；缺省 false = 旧 relay */
  serverPurge?: boolean
  /** 设备 PATH 里有 trash（删除进废纸篓而不是直接删）；缺省 false */
  trash?: boolean
  /** 确认删除：返回 Promise 时按钮显示"删除中…"，失败（reject 一个 Error）时红字写 error.message，弹窗不关 */
  onConfirm?: () => void | Promise<void>
  returnFocus?: PiReturnFocus
}

export function PiDeleteDialog({ viewport, title, deviceName, serverPurge = false, trash = false, onConfirm, returnFocus, open, onOpenChange, static: staticProp }: PiDeleteDialogProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const confirm = async () => {
    if (pending || !onConfirm) return
    setPending(true)
    setError("")
    try {
      await onConfirm()
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "删除失败，请重试")
      setPending(false)
    }
  }
  const device = deviceName || "这台设备"
  const body = !serverPurge
    ? `「${title}」的会话文件会从 ${device} 上删除，没有回收站。服务器上缓存的副本不会跟着删除。`
    : trash
      ? `「${title}」会移到 ${device} 的废纸篓，和在 pi 里删除一样。服务器上的记录和副本会一起清除。`
      : `「${title}」的会话文件会从 ${device} 上删除，这台设备没有废纸篓，删除后不能恢复。服务器上的记录和副本会一起清除。`
  return (
    <PiDialog
      title="删除会话"
      danger
      viewport={viewport}
      width={360}
      static={staticProp}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={
        <>
          <PiButton kind="outline" variant={variant} className={phone ? "flex-1" : undefined} data-pi-autofocus="" onClick={() => onOpenChange?.(false)}>
            取消
          </PiButton>
          <PiButton variant={variant} className={phone ? "flex-1" : undefined} disabled={pending} data-cw-id="pi-delete-confirm" onClick={() => void confirm()}>
            {pending ? "删除中…" : "删除"}
          </PiButton>
        </>
      }
    >
      <p className={cn("m-0 text-(--cw-text-2)", phone ? "text-[15px] leading-[22px]" : "text-(length:--cw-text-md) leading-[19px]")}>
        {body}
      </p>
      {error ? (
        <p role="alert" className="mt-2 mb-0 text-(length:--cw-text-md) leading-[18px] text-(--cw-pi-error)">
          {error}
        </p>
      ) : null}
    </PiDialog>
  )
}
