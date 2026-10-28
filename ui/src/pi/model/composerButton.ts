/**
 * 黑圆钮与审批禁用（design §1.6 表、§6.4 blockedBy、§4.7 名称、§10；v1.2 D-08）。纯函数，node --test 直接加载。
 * 状态机 S0–S7 由 chat/composerMachine.ts 的 deriveComposer 给出，这里不改写它。
 */
import type { ComposerStateId } from "../../chat/composerMachine.ts"

export type PiComposerButtonVariant = "send" | "send-muted" | "stop"
/** ghostStop = S4 黑圆钮左侧的裸线条停止图标 */
export type PiComposerButton = { variant: PiComposerButtonVariant; disabled: boolean; ghostStop: boolean }
export type PiBlockedBy = "approval" | null

const IDLE: PiComposerButton = { variant: "send-muted", disabled: true, ghostStop: false }
const READY: PiComposerButton = { variant: "send", disabled: false, ghostStop: false }

/** S0–S7 → 黑圆钮四态（replica 的写法，多一个 hasContent：S5 / S6 要看框里有没有东西）。 */
export function composerButtonOf(state: ComposerStateId, hasContent: boolean): PiComposerButton {
  switch (state) {
    case "S0":
    case "S7":
      return { ...IDLE }
    case "S1":
      return { ...READY }
    case "S2":
      // 发送中：短暂禁用（ack 超过 200ms 才在框下写"发送中…"）
      return { variant: "send", disabled: true, ghostStop: false }
    case "S3":
      return { variant: "stop", disabled: false, ghostStop: false }
    case "S4":
      return { variant: "send", disabled: false, ghostStop: true }
    case "S5":
    case "S6":
      // S5 离线照常可发（进 outbox）；S6 失败一帧回落 S0 / S1
      return hasContent ? { ...READY } : { ...IDLE }
  }
}

/** 黑圆钮的无障碍名称（§4.7）：发送 / 停止 / 发送（不可用） */
export function composerButtonLabel(button: PiComposerButton): string {
  if (button.variant === "stop") return "停止"
  return button.disabled ? "发送（不可用）" : "发送"
}

export type PiComposerBlock = {
  button: PiComposerButton
  /** 输入框只读（草稿保留） */
  readOnly: boolean
  /** + / / / @ 菜单能不能打开 */
  menusEnabled: boolean
  /** 手机上隐藏模型选择器（S7、审批禁用） */
  hideModelOnPhone: boolean
}

/**
 * blockedBy 叠在 composerButtonOf 上（D-08）：审批时 S1 / S2 / S4 / S5 按 send-muted 渲染、不可点；
 * S3 的黑圆停止和 S4 的裸停止保留。S7 本身就整体禁用。blockedBy 为 null 时 button 与 composerButtonOf 一致。
 * hasContent 只影响 S5 / S6，缺省 false（计划里的两参写法照样能用）。
 */
export function composerBlockOf(state: ComposerStateId, blockedBy: PiBlockedBy | undefined, hasContent = false): PiComposerBlock {
  const base = composerButtonOf(state, hasContent)
  const blocked = blockedBy === "approval"
  const button = blocked && base.variant !== "stop" ? { variant: "send-muted" as const, disabled: true, ghostStop: base.ghostStop } : base
  const readOnly = blocked || state === "S7"
  return { button, readOnly, menusEnabled: !readOnly, hideModelOnPhone: readOnly }
}
