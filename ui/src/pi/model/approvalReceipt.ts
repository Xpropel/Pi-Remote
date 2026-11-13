/**
 * 审批卡的回执拼装（ApprovalContainer，PLAN 5.4 / §7.2 approval-waiting；design §5「等你回答」、M-06）。纯函数，node --test 直接加载。
 * relay 只有两样：dialogs（开着的卡）和 dialogReceipts（dialog_close reason = denied 的拒绝回执）。其余回执由本页拼：
 * - 本页的应答进度（sendDialogAnswer 的结果）：sending → sent（桥收下了、等关闭帧）/ answered-elsewhere（gone）/ failed（发送层失败）；
 * - 卡关掉了（从 dialogs 里消失）：拒绝回执优先（含本页拒绝的）；本页答过的直接消失；过了时限算超时；其余先记成在别处回答，
 *   显示时再看回合是不是被停止了（endedReceiptView）。
 */
import type { PiDialogLike, PiDialogReceiptView } from "./dialogCard.ts"
import { turnErrorOf } from "./turnError.ts"

/** 本页对一张卡的应答进度 */
export type PiLocalAnswer = { status: "sending" | "sent" | "failed" | "answered-elsewhere"; at: number }

/** 开着的卡 → dialogCardState 要的回执：sent 还在等关闭帧，按 sending 画（选项保持禁用）；没答过返回 null */
export function approvalReceiptOf(dialogId: string, mine: PiLocalAnswer | null | undefined): PiDialogReceiptView | null {
  if (!mine) return null
  return { dialogId, status: mine.status === "sent" ? "sending" : mine.status, at: mine.at }
}

/** 关闭帧和本地时钟差一点点：离时限 1 秒以内关掉的也算超时 */
export const APPROVAL_EXPIRE_SLACK_MS = 1000

/**
 * 卡从 dialogs 里消失了 → 留什么回执（null = 什么都不留，直接消失）。
 * denied：relay.dialogReceipts（dialog_close reason denied），带理由原文。
 */
export function approvalEndedOf(
  dialog: PiDialogLike,
  mine: PiLocalAnswer | null | undefined,
  denied: readonly { dialogId: string; note?: string }[],
  now: number,
): { receipt: PiDialogReceiptView; note?: string } | null {
  const deny = denied.find((r) => r.dialogId === dialog.dialogId)
  if (deny) return { receipt: { dialogId: dialog.dialogId, status: "denied", at: now }, ...(deny.note ? { note: deny.note } : {}) }
  if (mine && (mine.status === "sending" || mine.status === "sent")) return null
  const deadline = typeof dialog.timeout === "number" && dialog.timeout > 0 ? dialog.startedAt + dialog.timeout : null
  const status = deadline !== null && now >= deadline - APPROVAL_EXPIRE_SLACK_MS ? "expired" : "answered-elsewhere"
  return { receipt: { dialogId: dialog.dialogId, status, at: now } }
}

/** 转录条目里判断回合收尾要用的字段（relay Item 的子集） */
export type PiTurnEndLike = { kind: string; stopReason?: string; errorMessage?: string; startedAt?: number; timestamp?: number }

/** 卡关掉以后最多等这么久看回合是不是被停止了，还看不出来就按"已在其他设备回答"写 */
export const APPROVAL_REASON_WAIT_MS = 1000

/**
 * 停止收尾：aborted，或者 error + AbortSignal 原文。停在工具执行里（卡开着）时，pi 把紧接着的那次模型调用记成
 * stopReason "error"、errorMessage "The operation was aborted."；和转录尾行同一口径（turnErrorOf 判成"已停止生成"、不算出错）。
 */
function stopEnded(item: PiTurnEndLike): boolean {
  if (item.stopReason === "aborted") return true
  return item.stopReason === "error" && turnErrorOf("error", item.errorMessage)?.error === false
}

/** 开卡以后回合被停止了：流里最后一条助手消息是开卡以后的停止收尾（停止时 pi 先撤卡，收尾消息随后才到） */
export function stoppedAfter(dialog: PiDialogLike, items: readonly PiTurnEndLike[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== "assistant") continue
    const at = item.startedAt ?? item.timestamp
    return stopEnded(item) && typeof at === "number" && at >= dialog.startedAt - APPROVAL_EXPIRE_SLACK_MS
  }
  return false
}

/**
 * 关掉的卡现在写什么回执（每次渲染重算；null = 先不写）。"已在其他设备回答"是推断：关闭帧不带原因（观察到的卡）或 relay 没留原因，
 * 停止回合时也是卡先消失、停止收尾消息随后才到。所以出现了开卡以后的停止收尾 → "回合已停止"（stopped）；
 * 关掉不到 APPROVAL_REASON_WAIT_MS 还看不出来 → 先不写，免得先说"别处回答"再改口；过了才写"已在其他设备回答"。
 */
export function endedReceiptView(
  receipt: PiDialogReceiptView,
  dialog: PiDialogLike,
  items: readonly PiTurnEndLike[],
  now: number,
): PiDialogReceiptView | null {
  if (receipt.status !== "answered-elsewhere") return receipt
  if (stoppedAfter(dialog, items)) return { ...receipt, status: "stopped" }
  return now - receipt.at < APPROVAL_REASON_WAIT_MS ? null : receipt
}
