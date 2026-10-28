/**
 * 稳定选择器契约（P4.1，mock/验证线与两套变体统一使用；Lead 终审判定 P2-①）。
 *
 * 禁止两线各自起名：所有带行为/可测语义的 DOM 标记只用本文件导出的属性常量。
 * - `data-p4-surface`：一个可测 surface 的根（值 = 台账 surface ID，如 CL-CODE-02 / CX-PANEL-01）
 * - `data-p4-action`：动作按钮/可点区域（值 = 语义动作名，如 artifacts.open / plan.step.toggle）
 * - `data-p4-row` / `data-p4-pane`：列表行 / 窗格
 * - `data-pi-capability` + `data-capability-state`：能力 surface（available / unavailable / simulated）
 * - `data-pi-capability-disabled`：禁用态容器（无值，存在即禁用；与 data-capability-state 配套）
 * - `data-p4-ready`：surface 可截图/可断言就绪标记（根节点；无值）
 */
export const PI_UI_STABLE_SELECTORS = {
  surface: "data-p4-surface",
  action: "data-p4-action",
  row: "data-p4-row",
  pane: "data-p4-pane",
  capability: "data-pi-capability",
  capabilityState: "data-capability-state",
  disabled: "data-pi-capability-disabled",
  ready: "data-p4-ready",
} as const

/** 全部稳定选择器属性名（文档 / 验证线巡检用） */
export const PI_UI_STABLE_SELECTOR_ATTRIBUTES: readonly string[] = Object.values(PI_UI_STABLE_SELECTORS)

export interface PiUiSurfaceAttrs {
  "data-p4-surface": string
  "data-p4-action"?: string
  "data-p4-row"?: string
  "data-p4-pane"?: string
}

/** 构造 surface 属性（值必须来自台账 surface ID / 契约能力 ID，避免两线各起名） */
export function piUiSurfaceAttrs(input: { surface: string; action?: string; row?: string; pane?: string }): PiUiSurfaceAttrs {
  const out: PiUiSurfaceAttrs = { "data-p4-surface": input.surface }
  if (input.action) out["data-p4-action"] = input.action
  if (input.row) out["data-p4-row"] = input.row
  if (input.pane) out["data-p4-pane"] = input.pane
  return out
}

/** 构造能力 surface 属性（能力处于 unavailable/simulated 时额外标 disabled + state） */
export function piUiCapabilityAttrs(capability: string, status: "available" | "unavailable" | "simulated"): Record<string, string> {
  const attrs: Record<string, string> = { "data-pi-capability": capability, "data-capability-state": status }
  if (status !== "available") attrs["data-pi-capability-disabled"] = ""
  return attrs
}

/** 就绪标记（surface 根节点在数据/字体就绪后挂上；截图与 e2e 等它） */
export function piUiReadyAttr(ready: boolean): { "data-p4-ready"?: "" } {
  return ready ? { "data-p4-ready": "" } : {}
}
