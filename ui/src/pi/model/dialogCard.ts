/**
 * 审批卡状态（design §6.4 PiApprovalCard、§5「等你回答」、§10；v1.2 M-06 加 expired 与观察态）。纯函数，node --test 直接加载。
 */

/** 与 chat/composer/PromptWaiting.tsx 的 DialogCard 兼容，只取这里用到的字段 */
export type PiDialogLike = { dialogId: string; startedAt: number; timeout?: number; answerable?: boolean }

export type PiDialogCardStatus = "open" | "sending" | "failed" | "answered-elsewhere" | "denied" | "expired"

/**
 * 这张卡的回执（容器从 sendDialogAnswer 的进度、dialog_close 的 reason、dialogReceipts 拼出来）。
 * relay 现有的 DialogReceipt 只表示"已拒绝"，sending / failed / answered-elsewhere / expired 由容器补。
 */
export type PiDialogReceiptView = { dialogId: string; status: Exclude<PiDialogCardStatus, "open">; at: number }

export type PiDialogCardView = {
  state: PiDialogCardStatus
  /** 剩余秒数；宿主没给 timeout 时为 null（不编倒计时） */
  remainingSec: number | null
  /** answerable !== true：只读观察（卡底"只能在电脑上回答"，没有选项） */
  observe: boolean
  /** 这张卡让 composer 进 blockedBy: "approval"（可答、还没结束） */
  blocksComposer: boolean
  /** 结束回执（expired / denied / answered-elsewhere）的消失时刻；其余为 null */
  hideAt: number | null
}

/** 已超时 / 已拒绝的回执留 8 秒（或下一张卡出现时消失，由容器处理） */
export const PI_DIALOG_RECEIPT_MS = 8000

/** 卡片 + 回执 + now → 六态之一。dialog 缺失时返回 null。 */
export function dialogCardState(dialog: PiDialogLike | null | undefined, receipt: PiDialogReceiptView | null | undefined, now: number): PiDialogCardView | null {
  if (!dialog) return null
  const observe = dialog.answerable !== true
  const deadline = typeof dialog.timeout === "number" && dialog.timeout > 0 ? dialog.startedAt + dialog.timeout : null
  const mine = receipt && receipt.dialogId === dialog.dialogId ? receipt : null
  let state: PiDialogCardStatus = mine ? mine.status : "open"
  let endedAt = mine ? mine.at : null
  if ((state === "open" || state === "failed") && deadline !== null && now >= deadline) {
    state = "expired"
    endedAt = deadline
  }
  const remainingSec = deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000))
  const final = state === "expired" || state === "denied" || state === "answered-elsewhere"
  return {
    state,
    remainingSec: final ? null : remainingSec,
    observe,
    blocksComposer: !observe && !final,
    hideAt: final && endedAt !== null ? endedAt + PI_DIALOG_RECEIPT_MS : null,
  }
}
