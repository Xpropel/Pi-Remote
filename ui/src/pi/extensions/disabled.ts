/**
 * 统一禁用 / 空态契约（P4.1）：两套变体在「能力未提供」或「模拟演示」时按同一份文案 + 文档锚点渲染，
 * 视觉由各变体自写；本文件只给数据契约（无 React / 无样式）。
 */
import { PI_UI_EXTENSION_DOC_PATH, piUiCapabilityMetaOf } from "./capabilities.ts"
import type { PiUiCapability, PiUiCapabilityStatus } from "./types.ts"

/** 统一文案（两变体、cursor、画廊与测试共用；改文案只改这里） */
export const PI_UI_DISABLED_COPY = {
  unavailableTitle: "本机 pi 未提供此能力",
  unavailableHint: "当前版本不内置该能力；接入扩展后启用，或在开发环境用 mock 预览。",
  simulatedTitle: "模拟演示：未接入真实扩展",
  simulatedHint: "当前展示的是开发用 mock 数据，仅用于预览与验收，不代表真实数据。",
  howToConnect: "如何接入",
  docsLabel: "扩展接入文档",
} as const

/** 禁用态 / 模拟态渲染契约（变体按此渲染标题、原因、链接、模拟标识） */
export interface PiUiDisabledStateView {
  capability: PiUiCapability
  label: string
  status: "unavailable" | "simulated"
  simulated: boolean
  title: string
  reason: string
  hint: string
  howToConnectLabel: string
  docAnchor: string
  /** 相对仓库根的用户文档路径 + 锚点（UI 链接可用 /DOC/... 或仓库文档站映射） */
  docsPath: string
  docsLabel: string
}

/**
 * 能力状态 → 禁用态契约；`available` 返回 null（不渲染禁用态）。
 * `status` 由 `registry.ts` 的 `piUiCapabilitiesOf()` 统一解析后传入，保证「探测 → 展示」同一份口径。
 */
export function piUiDisabledStateOf(capability: PiUiCapability, status: PiUiCapabilityStatus): PiUiDisabledStateView | null {
  if (status === "available") return null
  const meta = piUiCapabilityMetaOf(capability)
  const simulated = status === "simulated"
  const docsPath = `${PI_UI_EXTENSION_DOC_PATH}${meta.docAnchor}`
  return {
    capability,
    label: meta.label,
    status,
    simulated,
    title: simulated ? PI_UI_DISABLED_COPY.simulatedTitle : PI_UI_DISABLED_COPY.unavailableTitle,
    reason: meta.unavailableReason,
    hint: simulated ? PI_UI_DISABLED_COPY.simulatedHint : PI_UI_DISABLED_COPY.unavailableHint,
    howToConnectLabel: PI_UI_DISABLED_COPY.howToConnect,
    docAnchor: meta.docAnchor,
    docsPath,
    docsLabel: PI_UI_DISABLED_COPY.docsLabel,
  }
}
