/**
 * 台账（`full-parity-inventory.md` v1.4）↔ 契约能力 ID 的**双向映射表**（P4.1 唯一口径，终版）。
 *
 * 终版事实：契约共 **40 个能力 ID**，与台账逐字一致：
 *   - **34 个台账 §6.1 语义 ID**（A.1 前 34 行，契约 ID 逐字相同）；
 *   - **3 个 candidate**（台账 A.3；surface 行出现、§6.1 未单列 → 架构裁决为**独立 capability**）：
 *     `subagent-orchestration`（CL-CODE-25）、`git-stage`（CX-PANEL-05）、`thread-fork-feedback`（CX-THREAD-07）；
 *   - **3 个契约扩展**（A.2，台账未单列、两线 UI 需要）：`session-rail-extra` / `notifications` / `terminal-panes`。
 * 双向常量：`PI_UI_INVENTORY_CAPABILITY_MAP`（台账/surface → 契约，37 行 = 34+3）与
 * `PI_UI_CAPABILITY_INVENTORY_MAP`（契约 → 台账/surface，40 项，extra 记 "(none)"）。
 * DOC/74 附录 A 的映射表由这两个常量生成（doc-writer 不再手写）。
 *
 * **ID 口径**：保持台账逐字 ID（`pane-workspace` / `pane-dock-drag` / `subagents-panel`）；
 * 旧稿别名（workspace-panes / drag-dock / subagent-panel）只在 `PI_UI_LEGACY_CAPABILITY_ALIASES` 里作开发期兼容说明，
 * 代码/文档不得再使用。
 */
import type { PiUiCapability } from "./types.ts"
import { PI_UI_CAPABILITY_IDS } from "./types.ts"

export interface PiUiInventoryMapping {
  /** 台账语义 ID（A.1）或 surface 编号（candidate）；契约扩展为 "(none)" */
  inventoryId: string
  contractId: PiUiCapability
  /** exact = 台账 §6.1 逐字一致；candidate = surface 行裁决为独立 capability；extra = 契约扩展（A.2） */
  kind: "exact" | "candidate" | "extra"
  /** 附录 A 用的说明（两线/文档可直接展示） */
  note: string
}

/** 台账 §6.1 的 34 个语义 ID（顺序同台账；契约 ID 与它们逐字一致） */
export const PI_UI_LEDGER_CAPABILITIES = [
  "device-platform-tabs",
  "workspace-modes",
  "pane-workspace",
  "pane-dock-drag",
  "artifacts",
  "browser-pane",
  "plan-pane",
  "side-chat",
  "subagents-panel",
  "automations",
  "pr-review",
  "git-commit",
  "plugins",
  "connectors",
  "skills",
  "permission-tiers",
  "density-modes",
  "suggestions",
  "code-review-comments",
  "background-tasks",
  "mcp-tools",
  "context-usage",
  "model-menu",
  "file-editor",
  "file-preview",
  "worktree",
  "multi-tab",
  "theme-custom",
  "session-pin",
  "terminal-interactive",
  "dictation",
  "work-mode",
  "workspace-connectors",
  "device-code-login",
] as const

/** 台账 A.3 的 3 个 candidate（surface 行 → 独立 capability） */
export const PI_UI_SURFACE_CANDIDATES: readonly PiUiInventoryMapping[] = [
  { inventoryId: "CL-CODE-25", contractId: "subagent-orchestration", kind: "candidate", note: "多代理画布/编排；独立 capability（subagents-panel 仍管列表/状态）" },
  { inventoryId: "CX-PANEL-05", contractId: "git-stage", kind: "candidate", note: "stage/unstage/revert 暂存区动作；独立 capability（git-commit 只管 commit/push/PR）" },
  { inventoryId: "CX-THREAD-07", contractId: "thread-fork-feedback", kind: "candidate", note: "thread fork（fork.available=true → available）+ Good/Bad 反馈（feedback.enabled=false → simulated）；一个 capability 两个子状态" },
]

/** 台账 A.2 的 3 个契约扩展（台账未单列） */
export const PI_UI_CONTRACT_EXTRAS: readonly PiUiInventoryMapping[] = [
  { inventoryId: "(none)", contractId: "session-rail-extra", kind: "extra", note: "第三方 session rail 条目（参考设计 hub rail 扩展位）" },
  { inventoryId: "(none)", contractId: "notifications", kind: "extra", note: "通知规则（按事件/设备/房间）" },
  { inventoryId: "(none)", contractId: "terminal-panes", kind: "extra", note: "多终端实例（与 terminal-interactive 的交互能力区分）" },
]

/** 台账 A.1：34 语义 ID + 3 candidate = 37 行（正向映射：台账/surface → 契约能力） */
export const PI_UI_INVENTORY_CAPABILITY_MAP: readonly PiUiInventoryMapping[] = [
  ...PI_UI_LEDGER_CAPABILITIES.map((id) => ({ inventoryId: id, contractId: id, kind: "exact" as const, note: "台账 §6.1 ↔ 契约 ID 逐字一致" })),
  ...PI_UI_SURFACE_CANDIDATES,
]

/** 反向映射：40 个契约能力 → 台账/surface 落点（每个契约都有落点；extra 记 ["(none)"]） */
export const PI_UI_CAPABILITY_INVENTORY_MAP: Readonly<Record<PiUiCapability, readonly string[]>> = Object.fromEntries([
  ...PI_UI_LEDGER_CAPABILITIES.map((id) => [id, [id]] as const),
  ...PI_UI_SURFACE_CANDIDATES.map((row) => [row.contractId, [row.inventoryId]] as const),
  ...PI_UI_CONTRACT_EXTRAS.map((row) => [row.contractId, ["(none)"]] as const),
]) as unknown as Readonly<Record<PiUiCapability, readonly string[]>>

/** 全量映射表（附录 A 生成用）：37 行台账落点 + 3 行 extra = 40 行 */
export const PI_UI_INVENTORY_MAPPING: readonly PiUiInventoryMapping[] = [...PI_UI_INVENTORY_CAPABILITY_MAP, ...PI_UI_CONTRACT_EXTRAS]

/** 旧稿别名（只在开发期兼容说明；不改台账/契约 ID） */
export const PI_UI_LEGACY_CAPABILITY_ALIASES: Readonly<Record<string, PiUiCapability>> = {
  "workspace-panes": "pane-workspace",
  "drag-dock": "pane-dock-drag",
  "subagent-panel": "subagents-panel",
}

/** 台账/surface ID → 契约能力 ID；未知返回 null */
export function piUiContractIdOfInventoryId(inventoryId: string): PiUiCapability | null {
  return PI_UI_INVENTORY_MAPPING.find((row) => row.inventoryId === inventoryId)?.contractId ?? PI_UI_LEGACY_CAPABILITY_ALIASES[inventoryId] ?? null
}

/** 兼容别名（旧调用名） */
export const piUiContractIdOfLedgerId = piUiContractIdOfInventoryId

/** 双向覆盖统计（测试 / 文档附录 / 台账 §6 补表用；任何静默缺口都会出现在 missing*） */
export function piUiInventoryCoverage(): {
  inventory: number
  mappedInventory: number
  missingInventory: string[]
  contract: number
  mappedContract: number
  missingContract: string[]
  candidates: number
  extras: number
} {
  const mappedInventoryIds = PI_UI_INVENTORY_MAPPING.filter((row) => row.inventoryId !== "(none)").map((row) => row.inventoryId)
  const inventoryRows = PI_UI_INVENTORY_CAPABILITY_MAP.map((row) => row.inventoryId)
  const missingInventory = inventoryRows.filter((id) => !mappedInventoryIds.includes(id))
  const mappedContractIds = new Set(PI_UI_INVENTORY_MAPPING.map((row) => row.contractId))
  const missingContract = PI_UI_CAPABILITY_IDS.filter((id) => !mappedContractIds.has(id))
  return {
    inventory: inventoryRows.length,
    mappedInventory: inventoryRows.length - missingInventory.length,
    missingInventory,
    contract: PI_UI_CAPABILITY_IDS.length,
    mappedContract: PI_UI_CAPABILITY_IDS.length - missingContract.length,
    missingContract,
    candidates: PI_UI_SURFACE_CANDIDATES.length,
    extras: PI_UI_CONTRACT_EXTRAS.length,
  }
}
