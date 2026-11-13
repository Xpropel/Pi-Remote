/**
 * 审批卡状态（design §6.4 PiApprovalCard、§5「等你回答」、§10；v1.2 M-06 加 expired 与观察态）。纯函数，node --test 直接加载。
 */

/** 与 chat/composer/PromptWaiting.tsx 的 DialogCard 兼容，只取这里用到的字段 */
export type PiDialogLike = { dialogId: string; startedAt: number; timeout?: number; answerable?: boolean }

export type PiDialogCardStatus = "open" | "sending" | "failed" | "answered-elsewhere" | "denied" | "expired" | "stopped"

/**
 * 这张卡的回执（容器从 sendDialogAnswer 的进度、dialog_close 的 reason、dialogReceipts 拼出来）。
 * relay 现有的 DialogReceipt 只表示"已拒绝"，sending / failed / answered-elsewhere / expired / stopped（回合停止、没人答）由容器补。
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
  /** 结束回执（expired / denied / answered-elsewhere / stopped）的消失时刻；其余为 null */
  hideAt: number | null
}

/** 已超时 / 已拒绝的回执留 8 秒（或下一张卡出现时消失，由容器处理） */
export const PI_DIALOG_RECEIPT_MS = 8000

/** (b+) read-only copy for a sealed card this end cannot read: the key
 *  not having arrived yet and the key never matching are different
 *  states, so the copy differs. Single source for all three shells. */
export function dialogSealedBlockedText(blocked: "waiting" | "failed"): string {
  return blocked === "waiting" ? "已加密 · 等内容钥" : "已加密 · 无法解密"
}

/** The fields the approval-gate detection reads (structural subset of the
 *  dialog card types used by the three shells). */
export type PiDialogApprovalLike = { kind: string; title?: string; options?: string[]; message?: string }

const APPROVAL_OPTION_FIRST = "允许一次"
const APPROVAL_OPTION_DENY = "拒绝"
// The session-wide allow label exists in two spellings: the shipped bridge
// wording and the design-gallery wording. Both are gate-only labels.
const APPROVAL_OPTION_SESSION: readonly string[] = ["本会话都允许", "这个会话里都允许"]

/**
 * Approval-gate dialogs (the bridge's tool_call gate) arrive as ordinary
 * select dialogs; the only reliable marker is their fixed option triple
 * (allow once / allow for this session / deny). ask_user questions carry
 * arbitrary options, so they never match this.
 */
export function dialogIsApproval(card: PiDialogApprovalLike | null | undefined): boolean {
  if (!card || card.kind !== "select") return false
  const options = card.options ?? []
  return options.length === 3 && options[0] === APPROVAL_OPTION_FIRST && options[2] === APPROVAL_OPTION_DENY && APPROVAL_OPTION_SESSION.includes(options[1])
}

/**
 * Split a gate dialog into its question line and the command it asks
 * about. Shipped frames embed the summary in the title
 * ("允许执行 <tool>？ <summary>") and carry no message; gallery / legacy
 * frames carry the command in message under a free-form question title.
 */
export function approvalPartsOf(card: PiDialogApprovalLike): { question: string; command: string } {
  const title = card.title ?? ""
  const match = /^允许执行\s+(\S+?)？\s*([\s\S]*)$/.exec(title)
  if (match) {
    return { question: `允许执行 ${match[1]}？`, command: (card.message || match[2] || "").trim() }
  }
  return { question: title, command: (card.message ?? "").trim() }
}

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
  const final = state === "expired" || state === "denied" || state === "answered-elsewhere" || state === "stopped"
  return {
    state,
    remainingSec: final ? null : remainingSec,
    observe,
    blocksComposer: !observe && !final,
    hideAt: final && endedAt !== null ? endedAt + PI_DIALOG_RECEIPT_MS : null,
  }
}
