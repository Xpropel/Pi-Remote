/**
 * "等你回答"审批卡的读屏播报（design §4.7 实时区域；PLAN 4.5）。纯函数，Node 单测直接测（test/pi-p4-b.test.mjs）。
 *
 * 规则：
 * - 卡出现时播报一次"pi 在等你回答：<标题>，<问题>"（polite）；剩余时间不逐秒播报。
 * - 剩 10 秒时再播报一次"还剩 10 秒"（秒数向上取整：时钟一秒一跳，第一次跳进 10 秒内时可能是 9.6 秒）。
 * - 卡出现时就已经不到 10 秒：两句并成一次播报，不再单独报"还剩 N 秒"。
 * - 换了一张卡（dialogId 变了）：重新播报，10 秒提醒也重新算。
 * - 卡不在可答态（已超时 / 别处已答 / 已拒绝，PiApprovalCard 收成一行回执）：不动，回执自己就是 role="status"。
 * PiApprovalCard 先挂一个空的 live region、再把这里算出的文字填进去，读屏才会把它当成变化读出来。
 */

/** 剩这么多毫秒时再播报一次 */
export const APPROVAL_WARN_MS = 10_000

export interface ApprovalAnnounceState {
  /** 已经播报过的卡；null = 还没播报过 */
  dialogId: string | null
  /** live region 里的文字 */
  text: string
  /** 这张卡的"还剩 N 秒"报过了没有 */
  warned: boolean
}

export const APPROVAL_ANNOUNCE_IDLE: ApprovalAnnounceState = Object.freeze({ dialogId: null, text: "", warned: false })

export interface ApprovalAnnounceInput {
  dialogId: string
  /** 可答态（open / sending / failed） */
  active: boolean
  /** approvalQuestionOf(dialog) */
  question: string
  /** 剩余毫秒；没有超时（只显示"已等 …"）时为 null */
  remainingMs: number | null
}

/** 卡头之后读的那句：标题和问题用"，"连起来；都没有时为空串 */
export function approvalQuestionOf(dialog: { title?: string; message?: string }): string {
  return [dialog.title, dialog.message].filter((s): s is string => !!s && s.trim() !== "").join("，")
}

const secondsLeft = (ms: number) => Math.max(1, Math.ceil(ms / 1000))
const inWarnWindow = (ms: number | null): ms is number => ms != null && ms > 0 && ms <= APPROVAL_WARN_MS

/** 下一个播报状态；没有变化时原样返回 prev（调用方据此判断要不要更新 live region） */
export function approvalAnnounceStep(prev: ApprovalAnnounceState, input: ApprovalAnnounceInput): ApprovalAnnounceState {
  if (!input.active) return prev
  const { dialogId, question, remainingMs } = input
  if (prev.dialogId !== dialogId) {
    const head = question ? `pi 在等你回答：${question}` : "pi 在等你回答"
    if (inWarnWindow(remainingMs)) return { dialogId, text: `${head}。还剩 ${secondsLeft(remainingMs)} 秒`, warned: true }
    return { dialogId, text: head, warned: false }
  }
  if (!prev.warned && inWarnWindow(remainingMs)) return { dialogId, text: `还剩 ${secondsLeft(remainingMs)} 秒`, warned: true }
  return prev
}
