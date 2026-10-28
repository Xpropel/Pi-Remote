import { useCallback, useEffect, useState } from "react"
import { PiApprovalCard, PiPromptSignal, type PiApprovalAnswer } from "@/components/pi/conversation/PiApprovalCard"
import { usePiDockLayout } from "@/components/pi/shared/frame"
import { usePiStatic } from "@/components/pi/shared/layers"
import type { PiDialogCard } from "@/components/pi/shared/types"
import { useNow } from "@/pi/hooks/useNow"
import { approvalEndedOf, approvalReceiptOf, type PiLocalAnswer } from "@/pi/model/approvalReceipt"
import { dialogCardState, PI_DIALOG_RECEIPT_MS, type PiDialogReceiptView } from "@/pi/model/dialogCard"
import type { PiContainerProps } from "./types"

/** 本页对一张卡的应答进度 + 发出去的那份答案（失败后"重试"再发一次） */
type LocalAnswer = PiLocalAnswer & { answer: PiApprovalAnswer }

/** 关掉了的卡留下的回执（已拒绝 / 已超时 / 已在别处回答），8 秒后或下一张卡出现时消失 */
type Ended = { dialog: PiDialogCard; receipt: PiDialogReceiptView; note?: string }

/**
 * 静态态（#/live 对图）里手机审批卡在键盘收起时的最高高度：舞台口径，同画廊屏 b/approval-waiting（dock 其余部分约 148，卡最高 264），
 * 和设计图对得上（改成 dock 上限收出来的 266 时，L2 这张对 R 从 0.23% 变成 3.46%）。可交互（产品、设备模式）不用它，读 phoneDockLayout。
 */
const STAGE_CARD_MAX = 264

/**
 * 审批卡（plan §7.2 approval-waiting、P5.4，b 线）：relay.dialogs / uiPrompt / dialogReceipts / sendDialogAnswer / dismissDialogReceipt。
 * - 一次一张卡（relay.dialogs 的第一张，先开的先答）；dialogCardState 六态 + 只读观察态（answerable !== true，M-06）。
 * - 应答（PromptWaiting 的口径）：sendDialogAnswer 的结果 ok → 等关闭帧（选项保持禁用）；gone → 已在别处回答；error → 卡内红字 + 重试
 *   （relay 自己也会弹"答案发送失败"通知）。
 * - 卡关掉以后（dialog_close）的回执：pi/model/approvalReceipt.ts（拒绝 / 超时 / 别处回答；本页答的直接消失），8 秒后或下一张卡出现时消失。
 * - 没有对话框、只有旧式 ui_prompt 信号时：一行"电脑上有一个确认框在等待"（F07）。
 * 跨线契约（R2/p5-lanes.md §2）：c 的 ComposerContainer 把它放进 PiComposerDock 的 approval 槽；没有卡时什么都不画。
 * 有可答卡（blocksComposer）时 act.setBlockedBy("approval")，卡结束（已答、超时、别处回答）或卸掉立刻 null；观察态不写。
 */
export function ApprovalContainer(props: PiContainerProps) {
  const { relay, act, variant, keyboardOpen } = props
  const now = useNow(1000)
  // P6.3（c 线单项许可，design §4.2 规则 4）：手机审批卡限高 = phoneDockLayout 的 approvalMax（PiPhonePage 经 usePiDockLayout 给：
  // 键盘开着 40%，舞台 203；收起 = dock 上限 50%，422）；卡 + composer 的 dock 总高由 PiComposerDock 收在 dockMax 里。
  // 静态态键盘收起时用舞台口径 STAGE_CARD_MAX（对图）
  const dockLayout = usePiDockLayout()
  const isStatic = usePiStatic()
  const dialogs = relay.dialogs
  const dialog: PiDialogCard | null = dialogs[0] ?? null
  const [local, setLocal] = useState<Record<string, LocalAnswer>>({})
  const [ended, setEnded] = useState<Ended | null>(null)

  // 卡关掉了：按关闭的原因留回执（渲染期间调整 state，React 文档的写法：比较上一次看到的 dialogs）
  const [seen, setSeen] = useState(dialogs)
  if (seen !== dialogs) {
    setSeen(dialogs)
    if (dialogs.length > 0) {
      if (ended) setEnded(null)
    } else {
      const gone = seen.filter((d) => !dialogs.some((x) => x.dialogId === d.dialogId)).at(-1)
      const end = gone ? approvalEndedOf(gone, local[gone.dialogId], relay.dialogReceipts, now) : null
      if (gone && end) setEnded({ dialog: gone, ...end })
    }
  }

  const mine = dialog ? local[dialog.dialogId] : undefined
  const view = dialogCardState(dialog, dialog ? approvalReceiptOf(dialog.dialogId, mine) : null, now)
  const blocks = !!view?.blocksComposer

  // blockedBy：有可答卡 → "approval"；卡没了 / 结束 / 卸掉 → null（D-08）
  useEffect(() => {
    act.setBlockedBy(blocks ? "approval" : null)
  }, [act, blocks])
  useEffect(() => () => act.setBlockedBy(null), [act])

  // 回执到时消失；拒绝回执顺手从 relay 里清掉
  const dismiss = relay.dismissDialogReceipt
  const endedHideAt = ended ? ended.receipt.at + PI_DIALOG_RECEIPT_MS : null
  const endedId = ended?.receipt.dialogId ?? null
  const endedDenied = ended?.receipt.status === "denied"
  useEffect(() => {
    if (endedHideAt == null || endedId == null) return
    const t = window.setTimeout(
      () => {
        setEnded((cur) => (cur?.receipt.dialogId === endedId ? null : cur))
        if (endedDenied) dismiss(endedId)
      },
      Math.max(0, endedHideAt - Date.now()),
    )
    return () => window.clearTimeout(t)
  }, [endedHideAt, endedId, endedDenied, dismiss])

  const sendAnswer = relay.sendDialogAnswer
  const dialogId = dialog?.dialogId ?? null
  const answer = useCallback(
    (a: PiApprovalAnswer) => {
      if (!dialogId) return
      const put = (next: LocalAnswer) => setLocal((cur) => ({ ...cur, [dialogId]: next }))
      put({ status: "sending", at: Date.now(), answer: a })
      void Promise.resolve(sendAnswer(dialogId, a)).then((result) => {
        put({ status: result === "ok" ? "sent" : result === "gone" ? "answered-elsewhere" : "failed", at: Date.now(), answer: a })
      })
    },
    [dialogId, sendAnswer],
  )

  const maxHeight = variant !== "phone" ? undefined : isStatic && !keyboardOpen ? STAGE_CARD_MAX : dockLayout?.approvalMax
  if (dialog && view) {
    return (
      <PiApprovalCard
        key={dialog.dialogId}
        dialog={dialog}
        now={now}
        variant={variant}
        state={view.state}
        answering={mine && (mine.status === "sending" || mine.status === "sent") ? mine.answer.value : undefined}
        maxHeight={maxHeight}
        onAnswer={answer}
        onRetry={mine?.status === "failed" ? () => answer(mine.answer) : undefined}
      />
    )
  }
  if (ended) {
    return <PiApprovalCard key={ended.dialog.dialogId} dialog={ended.dialog} now={now} variant={variant} state={ended.receipt.status} note={ended.note} />
  }
  if (relay.uiPrompt) return <PiPromptSignal startedAt={relay.uiPrompt.startedAt} now={now} />
  return null
}
