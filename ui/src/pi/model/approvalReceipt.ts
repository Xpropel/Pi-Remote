/**
 * 审批卡的回执拼装（ApprovalContainer，PLAN 5.4 / §7.2 approval-waiting；design §5「等你回答」、M-06）。纯函数，node --test 直接加载。
 * relay 只有两样：dialogs（开着的卡）和 dialogReceipts（dialog_close reason = denied 的拒绝回执）。其余回执由本页拼：
 * - 本页的应答进度（sendDialogAnswer 的结果）：sending → sent（桥收下了、等关闭帧）/ answered-elsewhere（gone）/ failed（发送层失败）；
 * - 卡关掉了（从 dialogs 里消失）：拒绝回执优先（含本页拒绝的）；本页答过的直接消失；过了时限算超时；其余算在别处回答。
 */
import type { PiDialogLike, PiDialogReceiptView } from "./dialogCard.ts"

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
