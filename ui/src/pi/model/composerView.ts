/**
 * composer 的框下状态行与占位（plan §7.3 composer-keyboard、P5.5 c 线；design §1.6、§4.7、§6.4，D-02 / D-08 / K08 / 决定 8）。
 * 纯函数，node --test 直接加载。ComposerContainer 从 relay 取一片交给这里，得到 PiComposerDock 的 placeholder 与 status。
 * 原因一律由 composerReasonOf 算（D14）；占位只有四种短句；缺数据的段整段不出（§1.9）。
 */
import type { ComposerStateId } from "../../chat/composerMachine.ts"
import type { PiBlockedBy } from "./composerButton.ts"
import { composerReasonOf, type PiReasonDevice, type PiReasonLink } from "./composerReason.ts"

/** 与 components/pi/composer 的 PiStatusRowData 同形（这里只写容器会给的字段） */
export type PiComposerStatus = {
  device?: string
  branch?: string | null
  delivery?: "steer" | "follow_up" | null
  running?: boolean
  context?: { percent: number; trusted: boolean } | null
  note?: string
  tone?: "default" | "warn" | "error"
  live?: boolean
  copy?: string
  extra?: string[]
  turnError?: boolean
}

export type PiComposerViewInput = {
  /** relay.composer.state（deriveComposer，不改写） */
  state: ComposerStateId
  /** relay.composer.blockReason：S7 的 revoked / readonly 进原因 */
  blockReason?: string | null
  /** relay.composer.overLimit：框下红字"太长了" */
  overLimit?: boolean
  blockedBy: PiBlockedBy | undefined
  /** 连接口径（linkView 的 kind；浏览器断网时容器按 reconnecting 给） */
  link: PiReasonLink
  /** 当前会话的设备；不在设备模式时为 null */
  device: PiReasonDevice
  /** false = 只点选、还没载入的会话 */
  loaded: boolean
  /** S2 超过 200ms 还没 ack（容器计时） */
  slowAck?: boolean
  /** relay.busy：运行中出投递选择器和行尾 Spinner */
  busy: boolean
  /** relay.sendMode（auto / steer / follow_up） */
  sendMode?: string | null
  /** get_git_branch 的 branch；没有就是 null */
  branch?: string | null
  /** usage.contextUsage 的读数（contextReadout 之后）：state ok 且有比例时才可信 */
  context?: { state: "none" | "untrusted" | "ok"; percent: number | null } | null
  /** extStatus.statuses 的值（K08） */
  extra?: readonly string[] | null
  /** 外壳 a 线给的整宽复制框（手机，attach 命令等） */
  copy?: string
  /** 上一个回合以出错结束（回合结束播报区读） */
  turnError?: boolean
}

export const PI_OVERLIMIT_NOTE = "太长了，最多 100000 字"

/** 投递选择器的值：sendMode 是 follow_up 时"等这轮结束"，其余（auto / steer）按默认"插入当前回合"（决定 10） */
export function deliveryOf(sendMode: string | null | undefined): "steer" | "follow_up" {
  return sendMode === "follow_up" ? "follow_up" : "steer"
}

/**
 * placeholder + status。规则：
 * - 原因（note / tone / live）来自 composerReasonOf；showDevice false 时不写设备（原因里已经有设备名），分支跟着设备走。
 * - 没有别的原因、输入超长时写红字"太长了，最多 100000 字"。
 * - 运行中：投递选择器 + 行尾 Spinner。
 * - 上下文：只在窗口可信时给 percent（百分点），状态行自己判断 ≥ 70% 才出预警环（决定 8）。
 * - extra：扩展 statuses 原样给，段数 / 字数上限由状态行截（K08）；手机有原因时状态行自己不显示。
 */
export function composerViewOf(input: PiComposerViewInput): { placeholder: string; status: PiComposerStatus } {
  const s7 = input.blockReason === "revoked" || input.blockReason === "readonly" ? input.blockReason : null
  const reason = composerReasonOf(input.link, input.device, { state: input.state, s7, slowAck: input.slowAck }, input.blockedBy, input.loaded)
  const status: PiComposerStatus = {}
  const deviceName = input.device?.name?.trim()
  if (reason.showDevice && deviceName) {
    status.device = deviceName
    if (input.branch) status.branch = input.branch
  }
  // 审批卡挡着输入（D-08）时不出投递选择器和行尾 Spinner：输入只读，投递方式无从谈起；回合在跑由流里的审批卡和停止钮表达（design b/approval-waiting）
  if (input.busy && input.blockedBy !== "approval") {
    status.delivery = deliveryOf(input.sendMode)
    status.running = true
  }
  if (reason.note) {
    status.note = reason.note
    status.tone = reason.tone
    if (!reason.live) status.live = false
  } else if (input.overLimit) {
    status.note = PI_OVERLIMIT_NOTE
    status.tone = "error"
  }
  const ctx = input.context
  if (ctx && ctx.state === "ok" && ctx.percent != null) status.context = { percent: Math.round(ctx.percent * 1000) / 10, trusted: true }
  const extra = (input.extra ?? []).map((s) => s.trim()).filter(Boolean)
  if (extra.length) status.extra = extra
  if (input.copy) status.copy = input.copy
  if (input.turnError) status.turnError = true
  return { placeholder: reason.placeholder, status }
}

/** S2 慢 ack 的阈值（design §1.6：ack 超过 200ms 才写"发送中…"） */
export const PI_SLOW_ACK_MS = 200
