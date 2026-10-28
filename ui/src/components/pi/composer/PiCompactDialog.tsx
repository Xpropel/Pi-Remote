import { PiButton, PiDialog, usePiStatic } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { PiDialogError, PiDialogNote } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"
import { C_SECONDARY, inputText } from "./styles"

export interface PiCompactDialogProps extends PiFamilyDialogProps {
  /** 可选的总结要求（customInstructions） */
  instructions?: string
  onInstructionsChange?: (value: string) => void
  /** idle = 还没开始；working = 压缩中（compact 回包要等压缩落定）；done = 完成 */
  phase?: "idle" | "working" | "done"
  /** 完成后的一句（relay/compactionResult.ts 的 compactionResultText："已压缩：约 X tokens → Y tokens…"；回包没有数字时为空串 = 只写"压缩完成"） */
  result?: string
  /** pi 正在输出：开始压缩置灰并写原因 */
  busy?: boolean
  /** 会话不可用的原因 */
  offline?: string | null
  /** 命令失败（"压缩失败：pi 正忙"，按钮行上方红字，弹窗不关、按钮恢复可点） */
  error?: string | null
  onStart?: () => void
}

/**
 * 压缩上下文（G04，design §2 H：PiDialog（可选总结要求 + 黑色"开始压缩"）；完成后流内 PiReceipt）。桌面 PiDialog 480；手机全高 sheet。版式推断。
 * 压缩中按钮写"压缩中…"；完成写前后 token（compactionResultText）+ "完成"。
 * 手机上总结要求的输入框遇到键盘时，sheet 按 sheetLayout 摆（PiSheet 自己处理，P6.3）。
 */
export function PiCompactDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  instructions = "",
  onInstructionsChange,
  phase = "idle",
  result,
  busy,
  offline,
  error,
  onStart,
}: PiCompactDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  const done = phase === "done"
  const working = phase === "working"
  const footer = done ? (
    <PiButton variant={v} className={cn(phone && "flex-1")} onClick={isStatic ? undefined : () => onOpenChange?.(false)}>
      完成
    </PiButton>
  ) : (
    <PiButton variant={v} className={cn(phone && "flex-1")} disabled={working || busy || !!offline} onClick={isStatic ? undefined : onStart}>
      {working ? "压缩中…" : "开始压缩"}
    </PiButton>
  )
  return (
    <PiDialog
      title="压缩上下文"
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={480}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={footer}
    >
      <div data-slot="pi-compact-dialog" className="flex flex-col gap-3 pt-1">
        {done ? (
          <PiDialogNote variant={v} tone="primary">
            <span role="status">{result || "压缩完成"}</span>
          </PiDialogNote>
        ) : (
          <>
            <PiDialogNote variant={v} tone="primary">
              让模型把更早的对话总结成一段，腾出上下文；会消耗一次调用。
            </PiDialogNote>
            <label className="flex flex-col gap-1.5">
              <span className={cn("text-(length:--cw-text-sm)", C_SECONDARY)}>总结要求（可选）</span>
              <textarea
                data-cw-id="pi-compact-instructions"
                rows={phone ? 3 : 4}
                value={instructions}
                readOnly={isStatic}
                disabled={working}
                placeholder="例如：保留改过的文件和还没解决的问题"
                onChange={isStatic ? undefined : (event) => onInstructionsChange?.(event.currentTarget.value)}
                className={cn(
                  "w-full resize-none rounded-(--cw-radius-card) border border-solid border-(--cw-border) bg-(--cw-surface) px-3 py-2 text-(--cw-text) outline-none placeholder:text-(--cw-text-4) focus-visible:border-(--cw-pi-field-focus-border)",
                  inputText(v),
                )}
              />
            </label>
            {busy && <PiDialogNote variant={v}>pi 正在输出，压缩会被拒绝；等这轮结束再开始。</PiDialogNote>}
            {offline && <PiDialogNote variant={v}>{offline}</PiDialogNote>}
          </>
        )}
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
