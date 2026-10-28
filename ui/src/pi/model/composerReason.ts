/**
 * composer 的短占位与框下状态行原因（design §1.6 表、§4.7 实时区域、§6.4、§10；v1.2 D-02，v1.3 R2-D-01 / R2-M-11）。
 * 纯函数，node --test 直接加载。所有容器都只用这里的结果，别处不传 placeholder（D14）。
 */
import type { ComposerStateId } from "../../chat/composerMachine.ts"
import type { PiBlockedBy } from "./composerButton.ts"

export const PI_PLACEHOLDER_DEFAULT = "继续追问…"
export const PI_PLACEHOLDER_QUEUE = "写好先排队"
export const PI_PLACEHOLDER_DISABLED = "输入已禁用"
export const PI_PLACEHOLDER_LAZY = "发送时载入"

export type PiReasonTone = "default" | "warn"

export type PiComposerReason = {
  /** 四种短句之一 */
  placeholder: string
  /** 状态行原因；没有原因时 null */
  note: string | null
  tone: PiReasonTone
  /** false = 容器不传 status.device（note 已写了设备名） */
  showDevice: boolean
  /** false = 原因段只作视觉、不播报（连接状态由 PiStatusLine 播报） */
  live: boolean
}

/** 连接口径：useLinkState / linkView 的 kind；只有 ok 算连着 */
export type PiReasonLink = { kind: "ok" | "first" | "waiting" | "reconnecting" } | null | undefined
/** 当前会话的设备；不知道是哪台设备时为 null */
export type PiReasonDevice = { name: string; online: boolean } | null | undefined
/**
 * 状态机状态，外加两个 composerMachine 的 id 里装不下的事实：
 * s7 = S7 的原因（ComposerUi 的 blockReason：revoked / readonly）；slowAck = S2 已超过 200ms 没收到 ack（容器计时）。
 */
export type PiReasonState = { state: ComposerStateId; s7?: "revoked" | "readonly" | null; slowAck?: boolean }

function reason(placeholder: string, note: string | null, tone: PiReasonTone, showDevice = true, live = true): PiComposerReason {
  return { placeholder, note, tone, showDevice, live }
}

/**
 * 优先级：S7（撤销 / 只读）> 审批禁用 > 与服务器断开 > 设备离线 > 未载入 > S2 慢 ack > 默认。
 * - 断开："未连接服务器 · 发送会排队"，warn，live false（PiStatusLine 已播报）。
 * - 设备离线："<设备> 未连接 · 上线后发送"，warn，showDevice false。
 * - 未载入："<设备> · 未载入，发第一条时载入"，default，showDevice false。
 * 设备名缺失时原因照写、不填假名（"设备未连接 · 上线后发送" / "未载入，发第一条时载入"），showDevice 也就无所谓。
 */
export function composerReasonOf(
  link: PiReasonLink,
  device: PiReasonDevice,
  composerState: PiReasonState,
  blockedBy: PiBlockedBy | undefined,
  loaded: boolean | null | undefined,
): PiComposerReason {
  const { state, s7, slowAck } = composerState
  if (state === "S7") {
    if (s7 === "revoked") return reason(PI_PLACEHOLDER_DISABLED, "这台设备已被撤销 · 到设置里重新配对", "warn")
    if (s7 === "readonly") return reason(PI_PLACEHOLDER_DISABLED, "这个会话只读 · 只能看历史", "warn")
    return reason(PI_PLACEHOLDER_DISABLED, null, "default")
  }
  if (blockedBy === "approval") return reason(PI_PLACEHOLDER_DISABLED, "先回答上面的问题", "warn")
  if (link && link.kind !== "ok") return reason(PI_PLACEHOLDER_QUEUE, "未连接服务器 · 发送会排队", "warn", true, false)
  const name = device?.name?.trim() ?? ""
  if (device && !device.online) return reason(PI_PLACEHOLDER_QUEUE, name ? `${name} 未连接 · 上线后发送` : "设备未连接 · 上线后发送", "warn", !name)
  if (loaded === false) return reason(PI_PLACEHOLDER_LAZY, name ? `${name} · 未载入，发第一条时载入` : "未载入，发第一条时载入", "default", !name)
  if (state === "S2" && slowAck) return reason(PI_PLACEHOLDER_DEFAULT, "发送中…", "default")
  return reason(PI_PLACEHOLDER_DEFAULT, null, "default")
}
