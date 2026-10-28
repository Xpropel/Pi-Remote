/** 输入区 / 发送状态机 S0–S7 的纯逻辑（规范 5.2）。
 *
 *  这里只做「事实 → 可渲染状态」的推导，不依赖 React、DOM、时钟或网络：
 *  - `deriveComposer()` 是唯一的状态出口，UI 不再自己拼 `canSend` / `busy`；
 *  - `decideEnter()` / `decideEscape()` 是唯一的键盘分流，组件不得各判一遍；
 *  - `createSendLock()` 是同步的 in-flight 锁：同 tick 的第二次发送在取快照前就被拒绝。
 *
 *  S4 的投递方式来自用户的 sendMode（自动 / steer / follow_up）；
 *  省略 sendMode 时回落旧的 `follow_up`，只服务于旧调用与单测，产品路径始终显式传入。
 */

import { deliveryPlan } from "./composerTools.ts"
import type { DeliveryPlan, SendMode } from "./composerTools.ts"

/** 第 5 章交互数值的单一来源也从这里转出，调用方不必知道文件分层。 */
export {
  SENDING_HINT_DELAY_MS,
  sendingHintVisible,
  COPY_FEEDBACK_HOLD_MS,
  BACK_TO_BOTTOM_THRESHOLD_PX,
  BACK_TO_BOTTOM_SIZE_PX,
} from "./composer/interaction.ts"

export type ComposerStateId = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7"

/** 点击发送键后真正要做的事。none 表示现在没有可执行的发送动作。 */
export type SendKind = "none" | "send" | "queue" | "outbox"

/** 发送键为什么不可用；只用于标题/无障碍说明，不参与任何文案匹配。 */
export type ComposerBlockReason =
  | "empty"
  | "sending"
  | "generating"
  | "revoked"
  | "readonly"
  | "overlong"
  | "attachment-uploading"
  | "attachment-failed"
  | "attachment-count"
  | "attachment-size"

export type ComposerAttachmentFacts = {
  /** 当前附件条里的条目数（含上传中/失败） */
  count?: number
  /** 正在上传的条目数 */
  uploading?: number
  /** 上传失败的条目数 */
  failed?: number
  /** 附件合计字节数 */
  totalBytes?: number
}

export type ComposerFailureFacts = {
  /** 失败是否可重试（发送气泡上的「重试」）；默认 true */
  retryable?: boolean
}

export type ComposerFacts = {
  draft?: string
  /** 输入条上待发的图片数（P3-2）：>0 时即使正文为空也算有内容，纯图片可发送。 */
  pendingImages?: number
  /** 输入条上待发的文件引用数（P3-4）：>0 时即使正文为空也算有内容，纯引用可发送。 */
  pendingFiles?: number
  /** relay 连接可用（socket 已鉴权）。省略视为在线。 */
  online?: boolean
  /** 选中的设备在线。省略视为在线。 */
  deviceOnline?: boolean
  /** 设备级忙碌（不是当前回合 generating）；省略视为不忙。 */
  deviceBusy?: boolean
  /** 当前房间正在生成回复。 */
  generating?: boolean
  /** 忙时投递方式；产品路径始终由 relay 传入，省略时 S4 回落 follow_up（兼容旧调用）。 */
  sendMode?: SendMode
  /** 已发出一帧、正在等 ack（S2）。 */
  sending?: boolean
  /** 设备被撤销 / 会话只读（S7）。 */
  revoked?: boolean
  readonly?: boolean
  /**
   * 发送失败的那一帧传 true → S6；下一帧必须清掉。
   * S6 按规范立即回落 S1/S0（按当前输入），失败正文只进气泡，不回写草稿。
   */
  failurePulse?: boolean
  /** 最近一条发送失败；与 failurePulse 分开，便于气泡持续显示「重试」。 */
  lastFailure?: ComposerFailureFacts | null
  attachments?: ComposerAttachmentFacts | null
  deviceName?: string | null
  mobile?: boolean
  textMax?: number
  attachmentMaxCount?: number
  attachmentMaxTotalBytes?: number
}

export type ComposerUi = {
  state: ComposerStateId
  /** 调试/无障碍用的状态名；不参与业务判断。 */
  label: string
  canSend: boolean
  canType: boolean
  canAttach: boolean
  placeholder: string
  sendKind: SendKind
  /** 发送键 title / aria-label 的文案（含被限制的原因）。 */
  sendTitle: string
  stopVisible: boolean
  /** 不可发送时的首个原因；可发送时为 null。 */
  blockReason: ComposerBlockReason | null
  overLimit: boolean
  attachmentBlocked: boolean
  /** 现在点击发送应走的投递方式；canSend=false 或 S5（入 outbox）时为 null。 */
  delivery: DeliveryPlan | null
  failure: { retryable: boolean } | null
  canRetry: boolean
  /** 仅 S6 非空：这一帧的失败气泡之后回落到哪个稳定态。 */
  fallbackState: ComposerStateId | null
}

/** 规范 5.1.5：输入框总长上限 100000 字；浏览器 maxLength 不承担业务截断。 */
export const COMPOSER_TEXT_MAX = 100_000
/** 规范 5.1.4：附件最多 5 个、合计不超过 25MB。 */
export const ATTACHMENT_MAX_COUNT = 5
export const ATTACHMENT_MAX_TOTAL_BYTES = 25 * 1024 * 1024
/** 规范 5.2.1：ack 超时 8000ms。 */
export const ACK_TIMEOUT_MS = 8000

/** 省略 sendMode 时 S4 的历史缺省值（仅兼容旧调用/单测）；产品默认见 relay 的 parseSendMode。 */
export const S4_SEND_MODE = "follow_up" as const

const STATE_LABEL: Record<ComposerStateId, string> = {
  S0: "空",
  S1: "有内容·待发",
  S2: "发送中",
  S3: "生成中·无新草稿",
  S4: "生成中·有草稿",
  S5: "离线待发",
  S6: "发送失败",
  S7: "禁用",
}

const SEND_TITLE: Record<ComposerStateId, string> = {
  S0: "先输入内容",
  S1: "发送",
  S2: "正在发送，稍候",
  S3: "Pi 正在回复",
  S4: "排队发送：生成结束后自动发出",
  S5: "待发送：恢复后自动发送",
  S6: "发送失败",
  S7: "无法发送",
}

function nonEmpty(value: string | null | undefined): string {
  return (value || "").trim()
}

function deviceLabel(facts: ComposerFacts): string {
  return nonEmpty(facts.deviceName)
}

function isUnavailable(facts: ComposerFacts): boolean {
  return facts.online === false || facts.deviceOnline === false || facts.deviceBusy === true
}

function idlePlaceholder(facts: ComposerFacts): string {
  const name = deviceLabel(facts)
  if (facts.mobile) return name ? `给 ${name} 上的 Pi 发消息…` : "给本机 Pi 发消息…"
  return name ? `给 ${name} 上的 Pi 发消息，Enter 发送…` : "给本机 Pi 发消息，Enter 发送…"
}

function generatingPlaceholder(facts: ComposerFacts): string {
  if (facts.mobile) return "Pi 正在回复，可继续输入…"
  const mode = facts.sendMode ?? S4_SEND_MODE
  if (mode === "follow_up") return "Pi 正在回复，输入后 Enter 将排队发送…"
  return "Pi 正在回复，输入后 Enter 将插入当前回合…"
}

function unavailablePlaceholder(facts: ComposerFacts): string {
  const name = deviceLabel(facts)
  if (facts.online === false) {
    return facts.mobile ? "已离线，消息将排队发送…" : "已离线，写好后将排队，恢复连接自动发送…"
  }
  if (facts.deviceOnline === false) {
    return name ? `${name} 离线，可先写好，恢复后发送…` : "设备离线，可先写好，恢复后发送…"
  }
  if (facts.deviceBusy === true) return "设备忙，消息将排队，空闲后自动发送…"
  return idlePlaceholder(facts)
}

/** 状态对应的占位文案（规范 5.1.3）。移动端永不出现键名。 */
export function placeholderFor(state: ComposerStateId, facts: ComposerFacts = {}): string {
  if (state === "S7") {
    return facts.readonly && !facts.revoked ? "当前会话只读，无法发送消息" : "该设备已被撤销，无法发送消息"
  }
  if (state === "S2") return "正在发送，可继续输入…"
  if (state === "S3" || state === "S4") return generatingPlaceholder(facts)
  if (state === "S5" || isUnavailable(facts)) return unavailablePlaceholder(facts)
  return idlePlaceholder(facts)
}

function attachmentBlock(
  attachments: ComposerAttachmentFacts | null | undefined,
  maxCount: number,
  maxBytes: number,
): ComposerBlockReason | null {
  if (!attachments) return null
  if (Math.max(0, attachments.uploading ?? 0) > 0) return "attachment-uploading"
  if (Math.max(0, attachments.failed ?? 0) > 0) return "attachment-failed"
  if (Math.max(0, attachments.count ?? 0) > maxCount) return "attachment-count"
  if (Math.max(0, attachments.totalBytes ?? 0) > maxBytes) return "attachment-size"
  return null
}

function attachmentTitle(reason: ComposerBlockReason | null): string | null {
  if (reason === "attachment-uploading") return "附件还在上传，完成后才能发送"
  if (reason === "attachment-failed") return "附件上传失败，请先重试或移除附件"
  if (reason === "attachment-count") return "附件最多 5 个，请先移除一部分"
  if (reason === "attachment-size") return "附件合计不能超过 25MB，请先移除一部分"
  return null
}

function sendTitleFor(state: ComposerStateId, reason: ComposerBlockReason | null, sendMode?: SendMode): string {
  const blocked = attachmentTitle(reason)
  if (blocked) return blocked
  if (reason === "overlong") return `内容超过 ${COMPOSER_TEXT_MAX} 字，请先删减`
  if (reason === "empty") return "先输入内容"
  if (reason === "sending") return "正在发送，稍候"
  if (state === "S3") return "Pi 正在回复"
  if (state === "S4") {
    const mode = sendMode ?? S4_SEND_MODE
    if (mode === "follow_up") return "排队发送：生成结束后自动发出"
    if (mode === "steer") return "插入当前回合：当前工具结束后发出"
    return "自动：插入当前回合（当前工具结束后发出）"
  }
  return SEND_TITLE[state]
}

function deliveryForState(state: ComposerStateId, sendMode?: SendMode): DeliveryPlan | null {
  if (state === "S1") return deliveryPlan(sendMode ?? "auto", false)
  // S4 按用户当前选择投递；省略 sendMode 的旧调用仍回落 pi 原生 follow_up。
  if (state === "S4") return deliveryPlan(sendMode ?? S4_SEND_MODE, true)
  return null
}

/** 忙时 steer 与 follow_up 的发送键语义不同：前者是“立刻插话”，后者才是“排队”。 */
function sendKindFor(state: ComposerStateId, delivery: DeliveryPlan | null): "none" | "send" | "queue" | "outbox" {
  if (state === "S1") return "send"
  if (state === "S4") return delivery?.command === "follow_up" ? "queue" : "send"
  if (state === "S5") return "outbox"
  return "none"
}

/**
 * S0–S7 派生。S6 只存在一帧（failurePulse），其余字段与回落态完全一致，
 * 这样「发送键立即回落」不靠组件二次判断。
 */
export function deriveComposer(facts: ComposerFacts = {}): ComposerUi {
  const draft = facts.draft ?? ""
  const hasDraft = draft.trim().length > 0
  // P3-2：待发图片也算内容。旧调用方没传 pendingImages 时回落 attachments.count（同一批图）。
  const imageCount = Math.max(0, facts.pendingImages ?? facts.attachments?.count ?? 0)
  // P3-4：待发文件引用也算内容（chip 在、正文为空同样可发送）。
  const fileCount = Math.max(0, facts.pendingFiles ?? 0)
  const hasContent = hasDraft || imageCount > 0 || fileCount > 0
  const textMax = facts.textMax ?? COMPOSER_TEXT_MAX
  const overLimit = draft.length > textMax
  const maxCount = facts.attachmentMaxCount ?? ATTACHMENT_MAX_COUNT
  const maxBytes = facts.attachmentMaxTotalBytes ?? ATTACHMENT_MAX_TOTAL_BYTES
  const attachProblem = attachmentBlock(facts.attachments, maxCount, maxBytes)
  const attachmentBlocked = attachProblem !== null
  const attachmentCount = Math.max(0, facts.attachments?.count ?? 0)
  const attachmentBytes = Math.max(0, facts.attachments?.totalBytes ?? 0)
  const failure = facts.lastFailure ? { retryable: facts.lastFailure.retryable !== false } : null
  const terminal: "revoked" | "readonly" | null = facts.revoked ? "revoked" : facts.readonly ? "readonly" : null

  if (terminal === null && !facts.sending && facts.failurePulse) {
    const fallback = deriveComposer({ ...facts, failurePulse: false })
    return {
      ...fallback,
      state: "S6",
      label: STATE_LABEL.S6,
      fallbackState: fallback.state,
      failure,
      canRetry: failure?.retryable === true,
    }
  }

  let state: ComposerStateId
  if (terminal) state = "S7"
  else if (facts.sending) state = "S2"
  else if (facts.generating) state = hasContent ? "S4" : "S3"
  else if (isUnavailable(facts)) state = hasContent ? "S5" : "S0"
  else if (hasContent) state = "S1"
  else state = "S0"

  let blockReason: ComposerBlockReason | null = null
  if (state === "S7") blockReason = terminal
  else if (state === "S2") blockReason = "sending"
  else if (state === "S3") blockReason = "generating"
  else if (attachProblem) blockReason = attachProblem
  else if (overLimit) blockReason = "overlong"
  else if (!hasContent) blockReason = "empty"

  const sendable = (state === "S1" || state === "S4" || state === "S5") && blockReason === null
  const canAttach =
    state !== "S7" && attachmentCount < maxCount && attachmentBytes < maxBytes
  const delivery = sendable ? deliveryForState(state, facts.sendMode) : null

  return {
    state,
    label: STATE_LABEL[state],
    canSend: sendable,
    // S5 也要能打字：断线/设备离线只锁发送，不锁输入（与旧 composerGate 的 canType=canSend 相反）。
    canType: state !== "S7",
    canAttach,
    placeholder: placeholderFor(state, facts),
    sendKind: sendKindFor(state, delivery),
    sendTitle: sendTitleFor(state, blockReason, facts.sendMode),
    // 生成中的停止键必须一直在；S2 若与 generating 叠加（例如排队消息等 ack），也不能把停止键藏掉。
    stopVisible: state === "S3" || state === "S4" || (state === "S2" && facts.generating === true),
    blockReason,
    overLimit,
    attachmentBlocked,
    delivery,
    failure,
    canRetry: failure?.retryable === true,
    fallbackState: null,
  }
}

export type EnterAction = "send" | "queue" | "enqueue" | "noop" | "newline" | "menu" | "ime"

export type EnterDecision = {
  action: EnterAction
  reason: string
}

export type EnterContext = {
  ui: ComposerUi
  shiftKey?: boolean
  mobile?: boolean
  isComposing?: boolean
  /** compositionend 同一事件循环内的 Enter 仍按组字确认处理。 */
  compositionJustEnded?: boolean
  menuOpen?: boolean
}

/** 键盘唯一入口（规范 5.2.2）。组件只负责把事件字段填进来，不再各自判断 busy/IME。 */
export function decideEnter(input: EnterContext): EnterDecision {
  if (input.isComposing || input.compositionJustEnded) return { action: "ime", reason: "ime" }
  if (input.menuOpen) return { action: "menu", reason: "menu" }
  if (input.shiftKey) return { action: "newline", reason: "shift" }
  if (input.mobile) return { action: "newline", reason: "mobile" }

  const state = input.ui.state === "S6" ? input.ui.fallbackState ?? "S0" : input.ui.state
  if (!input.ui.canSend) return { action: "noop", reason: `locked:${input.ui.blockReason ?? state}` }
  if (state === "S1") return { action: "send", reason: "send" }
  if (state === "S4") return { action: "queue", reason: "queue" }
  if (state === "S5") return { action: "enqueue", reason: "outbox" }
  return { action: "noop", reason: `idle:${state}` }
}

export type EscapeAction = "menu" | "popover" | "modal" | "notice" | "stop" | "none"

export type EscapeContext = {
  menuOpen?: boolean
  popoverOpen?: boolean
  modalOpen?: boolean
  noticeCount?: number
  generating?: boolean
}

/**
 * Esc 的单一优先级（与后续 chat/escape.ts 的栈一致）：
 * 菜单 → 浮层 → 模态 → 通知 → 停止生成 → 无操作。
 */
export function decideEscape(input: EscapeContext = {}): EscapeAction {
  if (input.menuOpen) return "menu"
  if (input.popoverOpen) return "popover"
  if (input.modalOpen) return "modal"
  if ((input.noticeCount ?? 0) > 0) return "notice"
  if (input.generating) return "stop"
  return "none"
}

export type InFlight = {
  token: string
  startedAt: number
  timeoutMs: number
}

export type InFlightState = InFlight | null

export type AcquireResult = {
  next: InFlightState
  acquired: boolean
  /** 被这次获取顶掉的过期 token（没有则为 null）。 */
  expired: string | null
}

function timeoutOf(timeoutMs: number): number {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : ACK_TIMEOUT_MS
}

export function inFlightExpired(current: InFlightState, now: number): boolean {
  return !!current && now - current.startedAt >= current.timeoutMs
}

export function isInFlight(current: InFlightState, now: number): boolean {
  return !!current && !inFlightExpired(current, now)
}

/**
 * 纯函数版同步锁：同 tick 的第二次 acquire 会看到第一次写入的 current，因此必然失败。
 * 这里不调用任何异步 API；取快照、清草稿、生成 cid 必须发生在 acquire 成功之后。
 */
export function acquireInFlight(
  current: InFlightState,
  token: string,
  now: number,
  timeoutMs: number = ACK_TIMEOUT_MS,
): AcquireResult {
  if (!token) return { next: current, acquired: false, expired: null }
  if (current && !inFlightExpired(current, now)) return { next: current, acquired: false, expired: null }
  const expired = current && inFlightExpired(current, now) ? current.token : null
  return {
    next: { token, startedAt: now, timeoutMs: timeoutOf(timeoutMs) },
    acquired: true,
    expired,
  }
}

/** 晚到的 ack 不能清掉下一条的锁：token 不匹配就原样返回。 */
export function releaseInFlight(current: InFlightState, token: string): InFlightState {
  return current && current.token === token ? null : current
}

export function expireInFlight(
  current: InFlightState,
  now: number,
): { next: InFlightState; expired: string | null } {
  if (!inFlightExpired(current, now)) return { next: current, expired: null }
  return { next: null, expired: current?.token ?? null }
}

export type SendLockOptions = {
  now?: () => number
  timeoutMs?: number
}

/** 发送控制器的可变外壳；内部状态迁移仍是上面的纯函数，便于单测和以后接 reducer。 */
export type SendLock = {
  acquire(token: string): boolean
  release(token: string): boolean
  expire(): string | null
  locked(): boolean
  current(): InFlight | null
  reset(): void
}

export function createSendLock(options: SendLockOptions = {}): SendLock {
  const now = options.now ?? (() => Date.now())
  const timeoutMs = timeoutOf(options.timeoutMs ?? ACK_TIMEOUT_MS)
  let state: InFlightState = null

  const dropExpired = (): void => {
    if (state && inFlightExpired(state, now())) state = null
  }

  return {
    acquire(token: string): boolean {
      const result = acquireInFlight(state, token, now(), timeoutMs)
      state = result.next
      return result.acquired
    },
    release(token: string): boolean {
      const next = releaseInFlight(state, token)
      const changed = next !== state
      state = next
      return changed
    },
    expire(): string | null {
      const result = expireInFlight(state, now())
      state = result.next
      return result.expired
    },
    locked(): boolean {
      dropExpired()
      return state !== null
    },
    current(): InFlight | null {
      dropExpired()
      return state
    },
    reset(): void {
      state = null
    },
  }
}
