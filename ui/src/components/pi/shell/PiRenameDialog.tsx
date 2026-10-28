import { useState, type KeyboardEvent } from "react"
import { cn } from "@/lib/utils"
import { PiButton } from "@/components/pi/shared/PiButton"
import { PiDialog } from "@/components/pi/shared/PiOverlay"
import type { PiOverlayControl, PiReturnFocus } from "@/components/pi/shared/layers"
import type { PiLayout } from "@/components/pi/shared/viewport"

/**
 * 改名弹窗（G11，plan P5.3；replica 只写在 states 里，起点是 #/play 的 a 线版本）：桌面 PiDialog 360，手机全高 sheet
 * （键盘弹出时按 sheetLayout 摆，P6.3）。输入 + 黑色"保存"：去空白后非空才能保存，Enter = 保存，焦点进输入框、关闭后回行。
 * 保存失败时弹窗不关，按钮行上方红字（M-04 的口径）。
 */
export interface PiRenameDialogProps extends PiOverlayControl {
  viewport: PiLayout
  /** 现在的名字（输入框初值） */
  title: string
  /** 保存：返回 Promise 时按钮显示"保存中…"，失败（reject 一个 Error）时红字写 error.message，弹窗不关 */
  onSave?: (name: string) => void | Promise<void>
  /** 输入框上方的一行灰字（未载入会话："直接写入这个会话文件，不需要先载入"） */
  note?: string
  /** 关闭后焦点回哪（默认 = 打开前的焦点元素，不在了回顶栏标题） */
  returnFocus?: PiReturnFocus
}

const FIELD =
  "h-(--cw-pi-field-h) w-full min-w-0 rounded-(--cw-radius-input) border border-solid border-(--cw-border-strong) bg-(--cw-surface) px-2.5 text-(--cw-text) outline-none focus-visible:border-(--cw-pi-field-focus-border)"

export function PiRenameDialog({ viewport, title, onSave, note, returnFocus, open, onOpenChange, static: staticProp }: PiRenameDialogProps) {
  const [value, setValue] = useState(title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const phone = viewport === "phone"
  const variant = phone ? "phone" : "desktop"
  const next = value.trim()
  const save = async () => {
    if (!next || saving || !onSave) return
    setSaving(true)
    setError("")
    try {
      await onSave(next)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "改名失败，请重试")
      setSaving(false)
    }
  }
  return (
    <PiDialog
      title="重命名会话"
      viewport={viewport}
      width={360}
      static={staticProp}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={
        <>
          <PiButton kind="outline" variant={variant} className={phone ? "flex-1" : undefined} onClick={() => onOpenChange?.(false)}>
            取消
          </PiButton>
          <PiButton variant={variant} className={phone ? "flex-1" : undefined} disabled={!next || saving} data-cw-id="pi-rename-save" onClick={() => void save()}>
            {saving ? "保存中…" : "保存"}
          </PiButton>
        </>
      }
    >
      {note ? <p className="mt-0 mb-2 text-(length:--cw-text-sm) leading-(--cw-leading-sm) text-(--cw-pi-text-secondary)">{note}</p> : null}
      <input
        data-cw-id="pi-rename-input"
        aria-label="会话名称"
        value={value}
        spellCheck={false}
        disabled={saving}
        onChange={(event) => {
          setValue(event.target.value)
          setError("")
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return
          event.preventDefault()
          void save()
        }}
        onFocus={(event) => event.currentTarget.select()}
        className={cn(FIELD, phone ? "text-[16px]" : "text-(length:--cw-text-md)")}
      />
      {error ? (
        <p role="alert" className="mt-2 mb-0 text-(length:--cw-text-md) leading-[18px] text-(--cw-pi-error)">
          {error}
        </p>
      ) : null}
    </PiDialog>
  )
}
