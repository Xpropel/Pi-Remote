/**
 * 变体消费入口（P4.1）：`usePiUiCapabilities()` → 能力视图（状态 / 数据 / 动作 / 禁用态）。
 *
 * 用法（两套变体）：
 * ```tsx
 * const caps = usePiUiCapabilities()
 * if (caps.statusOf("artifacts") === "unavailable") return <ClaudeDisabled caps={caps.disabledOf("artifacts")!} />
 * return <ClaudeArtifacts data={caps.dataOf("artifacts")!} actions={caps.actionsOf("artifacts")} />
 * ```
 * 生产默认无 provider → 全部 unavailable（禁用态）；dev mock 见 `./mock/index.ts`。
 * 注册表变化（扩展注入 / mock 卸载）会触发重渲染；切换 UI 变体不影响该状态。
 */
import { useMemo, useSyncExternalStore } from "react"
import { piUiCapabilitiesOf, piUiExtensionSnapshot, subscribePiUiExtensions, type PiUiCapabilities } from "./registry.ts"

export function usePiUiCapabilities(): PiUiCapabilities {
  const snapshot = useSyncExternalStore(subscribePiUiExtensions, piUiExtensionSnapshot, piUiExtensionSnapshot)
  return useMemo(() => piUiCapabilitiesOf(snapshot.providers, snapshot.version), [snapshot])
}
