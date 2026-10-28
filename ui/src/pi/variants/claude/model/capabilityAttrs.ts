import type { PiUiCapabilityStatus } from "@/pi/extensions"

/**
 * 能力 surface 稳定属性（P4.6 终审工装口径）：
 * - `data-pi-capability` + `data-capability-state` 始终标注；
 * - 仅 `unavailable` 才带 `data-pi-capability-disabled`（无值 = 禁用态容器）；
 *   `simulated`/`available` **不得**带 disabled 标记，否则会被 capability-inert 判为「假解锁/失活」。
 * 说明：契约 `piUiCapabilityAttrs()` 目前对 simulated 也加了 disabled 标记，与 O1 工装口径冲突；本变体按工装口径构造，
 * 待契约修订后可替换（不影响视觉/行为）。
 */
export function claudeCapabilityAttrs(capability: string, status: PiUiCapabilityStatus): Record<string, string> {
  const attrs: Record<string, string> = { "data-pi-capability": capability, "data-capability-state": status }
  if (status === "unavailable") attrs["data-pi-capability-disabled"] = ""
  return attrs
}
