import { PiButton, PiDialog, usePiStatic } from "@/components/pi/shared"
import { cn } from "@/lib/utils"
import { PiDialogError, PiDialogListRow, PiDialogNote, PiDialogStatus, type PiDialogPhase } from "./PiDialogParts"
import type { PiFamilyDialogProps } from "./PiRegenerateDialog"

export interface PiForkDialogProps extends PiFamilyDialogProps {
  /** pick = 已载入会话：从用户消息列表里选一条分叉（get_fork_messages）；cold = 未载入会话的冷分叉（fork_session_file，只复制当前分支） */
  mode?: "pick" | "cold"
  /** pick：可分叉的用户消息（entryId + 一行正文） */
  messages?: { id: string; text: string }[]
  phase?: PiDialogPhase
  /** 读取失败的原因（读 get_fork_messages） */
  loadError?: string | null
  onRetry?: () => void
  /** 正在分叉的那一条（pick）/ 正在冷分叉（cold） */
  pendingId?: string | null
  /** cold：会话文件名 */
  file?: string
  /** 命令失败（按钮行上方红字，弹窗不关） */
  error?: string | null
  onPick?: (entryId: string) => void
  onColdFork?: () => void
}

/**
 * 分叉（G08，design §2 H：PiDialog + 用户消息列表；被分叉的消息回填输入框）。桌面 PiDialog 480；手机全高 sheet。版式推断。
 * 已载入：点一条用户消息 → fork（新分支包含这条消息，原文放回输入框，修改后发送即从新分支继续）。
 * 未载入：冷分叉确认（后台读会话文件复制当前分支，不启动新的 pi，也不切换当前会话）。
 */
export function PiForkDialog({
  viewport,
  open,
  onOpenChange,
  static: staticProp,
  returnFocus,
  subtitle,
  mode = "pick",
  messages = [],
  phase = "ready",
  loadError,
  onRetry,
  pendingId,
  file,
  error,
  onPick,
  onColdFork,
}: PiForkDialogProps) {
  const isStatic = usePiStatic(staticProp)
  const phone = viewport === "phone"
  const v = phone ? "phone" : "desktop"
  const cold = mode === "cold"
  return (
    <PiDialog
      title={cold ? "分叉会话（未载入）" : "从消息分叉"}
      subtitle={subtitle ?? undefined}
      viewport={viewport}
      width={480}
      static={isStatic}
      open={open}
      onOpenChange={onOpenChange}
      returnFocus={returnFocus}
      footer={
        cold ? (
          <PiButton variant={v} className={cn(phone && "flex-1")} disabled={!!pendingId} onClick={isStatic ? undefined : onColdFork}>
            {pendingId ? "分叉中…" : "开始分叉"}
          </PiButton>
        ) : undefined
      }
    >
      <div data-slot="pi-fork-dialog" className="flex flex-col gap-3 pt-1">
        {cold ? (
          <>
            <PiDialogNote variant={v} tone="primary">
              在后台读取这个会话文件，把当前分支复制成一个新会话；不会启动新的 pi，也不会切换当前会话。
            </PiDialogNote>
            {file && <p className="m-0 font-(family-name:--cw-font-mono) text-(length:--cw-text-code) break-all text-(--cw-text-2)">{file}</p>}
          </>
        ) : (
          <>
            <PiDialogNote variant={v}>新分支包含所选消息；点一条会把它的原文放回输入框，改完发送就从新分支继续。</PiDialogNote>
            <PiDialogStatus variant={v} phase={phase} error={loadError} onRetry={onRetry} empty={phase === "ready" && messages.length === 0 ? "没有可分叉的用户消息" : null}>
              <div role="list" aria-label="可分叉的用户消息" className="-mx-2 flex flex-col">
                {messages.map((m) => (
                  <div role="listitem" key={m.id}>
                    <PiDialogListRow
                      variant={v}
                      title={m.text}
                      mark={pendingId === m.id ? "分叉中…" : undefined}
                      disabled={!!pendingId}
                      onClick={isStatic ? undefined : () => onPick?.(m.id)}
                    />
                  </div>
                ))}
              </div>
            </PiDialogStatus>
          </>
        )}
        <PiDialogError>{error}</PiDialogError>
      </div>
    </PiDialog>
  )
}
