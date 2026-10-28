import { usePiUiCapabilities, type PiUiCapability, type PiUiCapabilityActions, type PiUiCapabilityData, type PiUiCapabilityStatus, type PiUiDisabledStateView } from "@/pi/extensions"

/**
 * 变体侧的能力门控封装（P4.1 契约 `@/pi/extensions`）：
 * - 统一 `usePiUiCapabilities()`（注册表订阅，provider 注入后无需刷新即重渲染）；
 * - `interactive` = 有 provider binding（真实或 dev mock）或 builtin available —— mocked/simulated 下 UI 可走通；
 * - `view` = 契约的禁用/模拟态视图（`piUiDisabledStateOf` 的产物），变体只负责按 Codex 视觉渲染；
 * - 生产无 provider → `interactive=false`（禁用态），页面仍完整可见。
 */
export type CodexCapabilityView<K extends PiUiCapability> = {
  status: PiUiCapabilityStatus
  view: PiUiDisabledStateView | null
  /** UI 是否可交互（provider 已注入或 builtin available） */
  interactive: boolean
  /** 是否 dev mock 的 simulated 数据（显示「模拟演示」标识） */
  simulated: boolean
  data: PiUiCapabilityData<K> | undefined
  actions: PiUiCapabilityActions<K> | null
  binding: ReturnType<ReturnType<typeof usePiUiCapabilities>["bindingOf"]>
}

export function useCodexCapability<K extends PiUiCapability>(capability: K): CodexCapabilityView<K> {
  const caps = usePiUiCapabilities()
  const status = caps.statusOf(capability)
  const binding = caps.bindingOf(capability)
  const interactive = status === "available" || binding != null
  return {
    status,
    view: caps.disabledOf(capability),
    interactive,
    simulated: status === "simulated" && binding != null,
    data: caps.dataOf(capability),
    actions: caps.actionsOf(capability),
    binding: caps.bindingOf(capability),
  }
}
