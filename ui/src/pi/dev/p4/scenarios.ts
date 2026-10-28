/**
 * P4 mock 画廊场景表（P4.2 M2）：`#/p4/<surface>` 的驱动脚本。
 *
 * 目的：两套变体把 P4 surface 做成**可交互的真实树**后，验证线/mock 线用一条 URL + 一段驱动脚本
 * 就能到达任意 surface 状态，做「disabled / simulated 双态截图」与 e2e 断言：
 *   #/p4/CL-CODE-02?ui=claude&vp=1440x900&theme=light&caps=all
 *
 * 约定：
 * - `surface` = 台账 surface ID（`CL-…` / `CX-…`），与变体 DOM 的 `data-p4-surface` 一一对应；
 * - `capability` = 该 surface 的能力门控 ID（`@/pi/extensions` 的 `PiUiCapability`）；
 * - `seed` = 初始界面状态（右栏 pane / 搜索浮层 / 设置页等），合并进 `usePiUiState` seed；
 * - `steps` = 到达该 surface 的点击序列（只使用稳定选择器：`data-p4-action` / `data-p4-surface` / `data-pi-*`
 *   或键盘 press），页面初始即可见的面步骤为空；
 * - `pending` = 两线尚未落地的面（e2e/截图脚本据此 SKIP，不算 FAIL；落地后删掉 pending 即激活）。
 *
 * 覆盖节奏：先激活两线已在主检出的面（Wave1/W2 + W3 第一二批），W3 剩余（窗格拖拽 / artifacts 面板 /
 * browser / plan / side-chat / subagent 独立面板等）保留 pending，等两线继续落地后逐条转 active。
 */
import { PI_UI_CAPABILITY_IDS } from "../../extensions/types.ts"

/** 单步驱动：点击（可带 index）/ 等待出现 / 键盘 / 按住(pointerDown，用于听写等按住态) / 纯等待 */
export type P4DriverStep =
  | { click: string; index?: number }
  | { waitFor: string; timeoutMs?: number }
  | { press: string }
  | { pointerDown: string }
  | { waitMs: number }

export interface P4Scenario {
  /** 台账 surface ID（= 变体 DOM 的 data-p4-surface 值） */
  surface: string
  /** 能力门控；缺省 = available（无需能力） */
  capability?: (typeof PI_UI_CAPABILITY_IDS)[number]
  /** 变体 */
  variant: "claude" | "codex"
  /** live fixture id（`ui/src/pi/dev/fixtures/live/<id>.ts`） */
  fixture: string
  /** 初始界面状态（如 { pane: "changes" } 开右栏；{ view: "settings" } 设置页）；P4Route 合并进 usePiUiState seed */
  seed?: Record<string, unknown>
  /** 到达该 surface 的步骤（只点稳定选择器 / 键盘） */
  steps: P4DriverStep[]
  /** 未落地原因（有值 = SKIP；落地后清空） */
  pending?: string
  note?: string
}

export const P4_SCENARIOS: readonly P4Scenario[] = [
  { surface: "CL-SHELL-01", variant: "claude", fixture: "conversation", steps: [] },
  { surface: "CL-SHELL-02", variant: "claude", fixture: "conversation", steps: [] },
  { surface: "CL-SHELL-03", variant: "claude", fixture: "conversation", steps: [], pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CL-SHELL-04", variant: "claude", fixture: "conversation", steps: [], pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CL-SHELL-05", variant: "claude", fixture: "p4-devices", steps: [{ click: '[data-p4-action="platform-tab"]', index: 2 }], capability: "device-platform-tabs" },
  { surface: "CL-SHELL-06", variant: "claude", fixture: "conversation", steps: [] },
  { surface: "CL-SHELL-07", variant: "claude", fixture: "conversation", steps: [], capability: "session-rail-extra" },
  { surface: "CL-SHELL-08", variant: "claude", fixture: "conversation", steps: [], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CHAT-01", variant: "claude", fixture: "conversation", steps: [] },
  { surface: "CL-CHAT-02", variant: "claude", fixture: "new-session", steps: [] },
  { surface: "CL-CHAT-03", variant: "claude", fixture: "new-session", steps: [] },
  { surface: "CL-CHAT-04", variant: "claude", fixture: "conversation", steps: [{ click: '[data-p4-action="open-starred"]' }], pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CL-CHAT-05", variant: "claude", fixture: "conversation", steps: [], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CHAT-06", variant: "claude", fixture: "new-session", steps: [] },
  { surface: "CL-CHAT-07", variant: "claude", fixture: "conversation", steps: [{ click: '[data-p4-action="open-artifacts"]' }], capability: "artifacts" },
  { surface: "CL-CHAT-08", variant: "claude", fixture: "conversation", steps: [{ click: '[data-p4-action="open-artifacts"]' }], capability: "artifacts" },
  { surface: "CL-COWORK-01", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }] },
  { surface: "CL-COWORK-02", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }] },
  { surface: "CL-COWORK-03", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }] },
  { surface: "CL-COWORK-04", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }], capability: "plan-pane" },
  { surface: "CL-COWORK-05", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }], capability: "plan-pane" },
  { surface: "CL-COWORK-06", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }], capability: "plan-pane" },
  { surface: "CL-COWORK-07", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }], capability: "artifacts" },
  { surface: "CL-COWORK-08", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+2" }], capability: "browser-pane" },
  { surface: "CL-CODE-01", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }] },
  { surface: "CL-CODE-02", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], capability: "pane-workspace" },
  { surface: "CL-CODE-03", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], capability: "pane-workspace" },
  { surface: "CL-CODE-04", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], capability: "pane-dock-drag" },
  { surface: "CL-CODE-05", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], capability: "pane-workspace" },
  { surface: "CL-CODE-06", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], note: "窗格开关菜单（工作台模式）" },
  { surface: "CL-CODE-07", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }, { click: '[data-p4-action="pane-tab"]', index: 8 }], capability: "background-tasks" },
  { surface: "CL-CODE-08", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CODE-09", variant: "claude", fixture: "conversation", steps: [{ click: '[data-p4-action="diff-comment"]' }], capability: "code-review-comments" },
  { surface: "CL-CODE-10", variant: "claude", fixture: "conversation", steps: [], capability: "code-review-comments", note: "/code-review 结果卡（thread 顶部）" },
  { surface: "CL-CODE-11", variant: "claude", fixture: "conversation", steps: [], capability: "context-usage", note: "session rail 卡片 + context 细分（完整入口；细分弹层为 partial 可点）" },
  { surface: "CL-CODE-12", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }, { click: '[data-p4-action="pane-tab"]', index: 5 }], capability: "side-chat", note: "Side chat 窗格（切到 side-chat pane）" },
  { surface: "CL-CODE-13", variant: "claude", fixture: "conversation", steps: [], capability: "pr-review", pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CL-CODE-14", variant: "claude", fixture: "conversation", steps: [], capability: "permission-tiers" },
  { surface: "CL-CODE-15", variant: "claude", fixture: "conversation", steps: [], capability: "skills", note: "composer 入口（skills/connectors/plugins 与附件按钮）" },
  { surface: "CL-CODE-16", variant: "claude", fixture: "conversation", steps: [{ click: '[data-p4-action="permission-open"]' }], capability: "permission-tiers" },
  { surface: "CL-CODE-17", variant: "claude", fixture: "conversation", steps: [], capability: "density-modes", pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CL-CODE-18", variant: "claude", fixture: "conversation", steps: [], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CODE-19", variant: "claude", fixture: "conversation", steps: [], capability: "suggestions" },
  { surface: "CL-CODE-20", variant: "claude", fixture: "conversation", steps: [], capability: "model-menu", pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CODE-21", variant: "claude", fixture: "conversation", steps: [], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CODE-22", variant: "claude", fixture: "conversation", steps: [], capability: "artifacts" },
  { surface: "CL-CODE-23", variant: "claude", fixture: "conversation", steps: [], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CODE-24", variant: "claude", fixture: "conversation", steps: [], capability: "mcp-tools", pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-CODE-25", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }, { click: '[data-p4-action="pane-tab"]', index: 9 }], capability: "subagent-orchestration" },
  { surface: "CL-CODE-26", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], capability: "git-commit" },
  { surface: "CL-CODE-27", variant: "claude", fixture: "p4-workbench", steps: [{ press: "Meta+3" }], capability: "git-commit" },
  { surface: "CL-CODE-28", variant: "claude", fixture: "conversation", steps: [], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CL-XCUT-01", variant: "claude", fixture: "conversation", steps: [] },
  { surface: "CL-XCUT-02", variant: "claude", fixture: "conversation", steps: [], pending: "P11 设计未包含/变体已删除的 target" },
  { surface: "CX-SHELL-01", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-SHELL-02", variant: "codex", fixture: "conversation", steps: [], capability: "multi-tab" },
  { surface: "CX-SHELL-03", variant: "codex", fixture: "conversation", steps: [], capability: "git-commit" },
  { surface: "CX-SHELL-04", variant: "codex", fixture: "changes-pane", steps: [] },
  { surface: "CX-SHELL-05", variant: "codex", fixture: "conversation", steps: [], capability: "multi-tab" },
  { surface: "CX-SHELL-06", variant: "codex", fixture: "conversation", steps: [], capability: "theme-custom", seed: { view: "settings" } },
  { surface: "CX-SIDE-01", variant: "codex", fixture: "conversation", steps: [], capability: "plugins", pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CX-SIDE-02", variant: "codex", fixture: "conversation", steps: [], capability: "automations" },
  { surface: "CX-SIDE-03", variant: "codex", fixture: "conversation", steps: [], capability: "session-pin", pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CX-SIDE-04", variant: "codex", fixture: "conversation", steps: [], pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CX-SIDE-05", variant: "codex", fixture: "conversation", steps: [], pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CX-SIDE-06", variant: "codex", fixture: "conversation", steps: [], pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CX-SIDE-07", variant: "codex", fixture: "conversation", steps: [], pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CX-SIDE-08", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-surface="CX-SHELL-01"] [data-pi-sidebar] .sb-localpage:nth-child(3)' }], capability: "automations" },
  { surface: "CX-THREAD-01", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-THREAD-02", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-THREAD-03", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-THREAD-04", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-THREAD-05", variant: "codex", fixture: "conversation", steps: [], capability: "context-usage" },
  { surface: "CX-THREAD-06", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-THREAD-07", variant: "codex", fixture: "conversation", steps: [], capability: "thread-fork-feedback" },
  { surface: "CX-THREAD-08", variant: "codex", fixture: "conversation", steps: [], capability: "file-editor" },
  { surface: "CX-THREAD-09", variant: "codex", fixture: "conversation-streaming", steps: [] },
  { surface: "CX-COMP-01", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-COMP-02", variant: "codex", fixture: "conversation", steps: [], capability: "permission-tiers" },
  { surface: "CX-COMP-03", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-action="pick-model-open"]' }], capability: "model-menu", note: "模型菜单（点模型 chip 打开）" },
  { surface: "CX-COMP-04", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-action="approval-open"]' }], capability: "permission-tiers", note: "审批档位菜单（点审批 chip 打开）" },
  { surface: "CX-COMP-05", variant: "codex", fixture: "queue-panel", steps: [] },
  { surface: "CX-COMP-06", variant: "codex", fixture: "p4-slash", steps: [] },
  { surface: "CX-COMP-07", variant: "codex", fixture: "new-session", steps: [] },
  { surface: "CX-COMP-08", variant: "codex", fixture: "p4-mention", steps: [], capability: "plugins" },
  { surface: "CX-PANEL-01", variant: "codex", fixture: "changes-pane", steps: [], capability: "pr-review", seed: { pane: "changes" } },
  { surface: "CX-PANEL-02", variant: "codex", fixture: "changes-pane", steps: [{ click: '[data-p4-action="panel-tab-files"]' }], capability: "file-preview", seed: { pane: "changes" } },
  { surface: "CX-PANEL-03", variant: "codex", fixture: "changes-pane", steps: [{ click: '[data-p4-action="panel-tab-changes"]' }], capability: "pr-review", seed: { pane: "changes" } },
  { surface: "CX-PANEL-04", variant: "codex", fixture: "changes-pane", steps: [], capability: "pr-review", seed: { pane: "changes" } },
  { surface: "CX-PANEL-05", variant: "codex", fixture: "changes-pane", steps: [{ click: '[data-p4-action="panel-tab-changes"]' }, { click: '[data-p4-action="scope-staged"]' }], capability: "git-stage", seed: { pane: "changes" } },
  { surface: "CX-PANEL-06", variant: "codex", fixture: "changes-pane", steps: [{ click: '[data-p4-action="panel-tools"]' }], capability: "pr-review", seed: { pane: "changes" } },
  { surface: "CX-PANEL-07", variant: "codex", fixture: "changes-pane", steps: [{ click: '[data-p4-action="panel-tools"]' }, { click: '[data-p4-action="tool-browser"]' }], capability: "browser-pane", seed: { pane: "changes" } },
  { surface: "CX-PANEL-08", variant: "codex", fixture: "conversation", steps: [], capability: "session-rail-extra" },
  { surface: "CX-PANEL-09", variant: "codex", fixture: "p4-workbench", steps: [], capability: "subagents-panel" },
  { surface: "CX-PANEL-10", variant: "codex", fixture: "conversation", steps: [{ press: "Control+j" }] },
  { surface: "CX-PANEL-11", variant: "codex", fixture: "changes-pane", steps: [{ click: '[data-p4-action="panel-tools"]' }, { click: '[data-p4-action="tool-sidechat"]' }], capability: "side-chat", seed: { pane: "changes" } },
  { surface: "CX-PANEL-12", variant: "codex", fixture: "changes-pane", steps: [], capability: "file-editor", seed: { pane: "changes" }, pending: "文件编辑器未落地" },
  { surface: "CX-DLG-01", variant: "codex", fixture: "conversation", steps: [{ press: "Control+k" }] },
  { surface: "CX-DLG-02", variant: "codex", fixture: "conversation", steps: [], seed: { search: "验收" }, pending: "旧侧栏组件退役（ClaudeSidebar/CodexSidebar 已不在 active 路径，surface 仅存于退役组件）" },
  { surface: "CX-DLG-03", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-surface="CX-SHELL-01"] [data-pi-sidebar] .sb-localpage:nth-child(3)' }, { click: '[data-p4-action="automation-create"]' }], capability: "automations" },
  { surface: "CX-DLG-04", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-action="run-folder"]' }, { click: '[data-p4-action="create-isolated-copy"]' }], capability: "worktree", note: "Branch ready 弹窗（运行位置→指定文件夹→创建隔离副本）" },
  { surface: "CX-DLG-05", variant: "codex", fixture: "approval-waiting", steps: [] },
  { surface: "CX-DLG-06", variant: "codex", fixture: "changes-pane", steps: [{ click: '[data-p4-action="commit"]', index: 0 }], capability: "git-commit", seed: { pane: "changes" } },
  { surface: "CX-PAGE-01", variant: "codex", fixture: "conversation", steps: [], seed: { view: "settings" } },
  { surface: "CX-PAGE-02", variant: "codex", fixture: "conversation", steps: [], capability: "theme-custom", seed: { view: "settings" } },
  { surface: "CX-PAGE-03", variant: "codex", fixture: "conversation", steps: [], capability: "work-mode", seed: { view: "settings" } },
  { surface: "CX-PAGE-04", variant: "codex", fixture: "conversation", steps: [], capability: "permission-tiers", seed: { view: "settings" } },
  { surface: "CX-PAGE-05", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-surface="CX-SHELL-01"] [data-pi-sidebar] .sb-localpage:nth-child(3)' }], capability: "automations" },
  { surface: "CX-PAGE-06", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-surface="CX-SHELL-01"] [data-pi-sidebar] .sb-localpage:nth-child(2)' }], capability: "pr-review" },
  { surface: "CX-PAGE-07", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-surface="CX-SHELL-01"] [data-pi-sidebar] .sb-localpage:nth-child(2)' }, { click: '[data-p4-action="select-pr"]' }], capability: "pr-review" },
  { surface: "CX-PAGE-08", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-surface="CX-SHELL-01"] [data-pi-sidebar] .sb-localpage:nth-child(1)' }], capability: "plugins" },
  { surface: "CX-PAGE-09", variant: "codex", fixture: "conversation", steps: [], capability: "skills", seed: { view: "settings" } },
  { surface: "CX-PAGE-10", variant: "codex", fixture: "login", steps: [] },
  { surface: "CX-PAGE-11", variant: "codex", fixture: "login", steps: [{ click: '[data-p4-action="pair-device-login"]' }], capability: "device-code-login" },
  { surface: "CX-PAGE-12", variant: "codex", fixture: "boot-loading", steps: [] },
  { surface: "CX-XCUT-01", variant: "codex", fixture: "conversation", steps: [] },
  { surface: "CX-XCUT-02", variant: "codex", fixture: "conversation", steps: [{ click: '[data-p4-action="dictate"]' }], capability: "dictation" },
  { surface: "CX-XCUT-03", variant: "codex", fixture: "conversation", steps: [] },

]


/** 台账 §1/§2 的 U/S（unavailable/simulated）surface 全集（P4 验收双态覆盖基线；inventory v1.4 实测 64 行） */
export const P4_LEDGER_UNAVAILABLE_SIMULATED: readonly { surface: string; status: "unavailable" | "simulated" }[] = [
  { surface: "CL-SHELL-06", status: "simulated" },
  { surface: "CL-SHELL-08", status: "simulated" },
  { surface: "CL-CHAT-04", status: "simulated" },
  { surface: "CL-CHAT-07", status: "simulated" },
  { surface: "CL-CHAT-08", status: "simulated" },
  { surface: "CL-COWORK-04", status: "simulated" },
  { surface: "CL-COWORK-05", status: "simulated" },
  { surface: "CL-COWORK-06", status: "simulated" },
  { surface: "CL-COWORK-07", status: "simulated" },
  { surface: "CL-COWORK-08", status: "unavailable" },
  { surface: "CL-CODE-02", status: "unavailable" },
  { surface: "CL-CODE-03", status: "unavailable" },
  { surface: "CL-CODE-04", status: "simulated" },
  { surface: "CL-CODE-05", status: "simulated" },
  { surface: "CL-CODE-06", status: "unavailable" },
  { surface: "CL-CODE-09", status: "simulated" },
  { surface: "CL-CODE-10", status: "simulated" },
  { surface: "CL-CODE-11", status: "simulated" },
  { surface: "CL-CODE-12", status: "simulated" },
  { surface: "CL-CODE-13", status: "simulated" },
  { surface: "CL-CODE-14", status: "simulated" },
  { surface: "CL-CODE-15", status: "simulated" },
  { surface: "CL-CODE-16", status: "unavailable" },
  { surface: "CL-CODE-19", status: "simulated" },
  { surface: "CL-CODE-22", status: "simulated" },
  { surface: "CL-CODE-25", status: "unavailable" },
  { surface: "CL-CODE-26", status: "simulated" },
  { surface: "CL-CODE-27", status: "unavailable" },
  { surface: "CX-SHELL-02", status: "simulated" },
  { surface: "CX-SHELL-03", status: "unavailable" },
  { surface: "CX-SHELL-05", status: "unavailable" },
  { surface: "CX-SHELL-06", status: "simulated" },
  { surface: "CX-SIDE-01", status: "simulated" },
  { surface: "CX-SIDE-02", status: "simulated" },
  { surface: "CX-SIDE-03", status: "simulated" },
  { surface: "CX-SIDE-08", status: "unavailable" },
  { surface: "CX-THREAD-06", status: "simulated" },
  { surface: "CX-THREAD-07", status: "simulated" },
  { surface: "CX-THREAD-08", status: "simulated" },
  { surface: "CX-COMP-02", status: "simulated" },
  { surface: "CX-COMP-04", status: "unavailable" },
  { surface: "CX-COMP-06", status: "simulated" },
  { surface: "CX-COMP-08", status: "simulated" },
  { surface: "CX-PANEL-01", status: "simulated" },
  { surface: "CX-PANEL-04", status: "simulated" },
  { surface: "CX-PANEL-05", status: "simulated" },
  { surface: "CX-PANEL-06", status: "simulated" },
  { surface: "CX-PANEL-07", status: "unavailable" },
  { surface: "CX-PANEL-08", status: "simulated" },
  { surface: "CX-PANEL-09", status: "simulated" },
  { surface: "CX-PANEL-10", status: "simulated" },
  { surface: "CX-PANEL-11", status: "simulated" },
  { surface: "CX-DLG-03", status: "unavailable" },
  { surface: "CX-DLG-04", status: "simulated" },
  { surface: "CX-DLG-06", status: "unavailable" },
  { surface: "CX-PAGE-02", status: "simulated" },
  { surface: "CX-PAGE-04", status: "unavailable" },
  { surface: "CX-PAGE-05", status: "unavailable" },
  { surface: "CX-PAGE-06", status: "unavailable" },
  { surface: "CX-PAGE-07", status: "unavailable" },
  { surface: "CX-PAGE-08", status: "unavailable" },
  { surface: "CX-PAGE-09", status: "unavailable" },
  { surface: "CX-PAGE-11", status: "simulated" },
  { surface: "CX-XCUT-02", status: "unavailable" },
]

/** 覆盖统计：哪些 U/S 行有场景（active/pending）、哪些还没有 */
export function p4CoverageOf(): {
  total: number
  active: number
  pending: number
  missing: string[]
  activeIds: string[]
  pendingIds: string[]
} {
  const byId = new Map(P4_SCENARIOS.map((scenario) => [scenario.surface, scenario]))
  const activeIds: string[] = []
  const pendingIds: string[] = []
  const missing: string[] = []
  for (const row of P4_LEDGER_UNAVAILABLE_SIMULATED) {
    const scenario = byId.get(row.surface)
    if (!scenario) missing.push(row.surface)
    else if (scenario.pending) pendingIds.push(row.surface)
    else activeIds.push(row.surface)
  }
  return { total: P4_LEDGER_UNAVAILABLE_SIMULATED.length, active: activeIds.length, pending: pendingIds.length, missing, activeIds, pendingIds }
}

const BY_SURFACE = new Map(P4_SCENARIOS.map((scenario) => [scenario.surface, scenario]))

/** 取场景；未知 surface 返回 null（P4Route 会报 data-p4-error） */
export function p4ScenarioOf(surface: string): P4Scenario | null {
  return BY_SURFACE.get(surface) ?? null
}

/** surface ID → 变体（CL- = claude / CX- = codex） */
export function p4VariantOfSurface(surface: string): "claude" | "codex" | null {
  if (surface.startsWith("CL-")) return "claude"
  if (surface.startsWith("CX-")) return "codex"
  return null
}

/** 场景表自检（测试 / 画廊诊断；返回问题清单，空 = 通过） */
export function p4ScenarioProblems(): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const capabilityIds = new Set<string>(PI_UI_CAPABILITY_IDS)
  const STABLE = /^\[data-(p4-(action|surface|row|pane)|pi-(capability|capability-disabled|ui-part))/
  for (const scenario of P4_SCENARIOS) {
    if (!/^(CL|CX)-[A-Z]+-\d{2}$/.test(scenario.surface)) problems.push(`surface ID 不合法：${scenario.surface}`)
    if (seen.has(scenario.surface)) problems.push(`surface 重复：${scenario.surface}`)
    seen.add(scenario.surface)
    if (p4VariantOfSurface(scenario.surface) !== scenario.variant) problems.push(`${scenario.surface} 的 variant 与 ID 前缀不一致`)
    if (scenario.capability && !capabilityIds.has(scenario.capability)) problems.push(`${scenario.surface} 的能力不存在：${scenario.capability}`)
    if (!scenario.fixture) problems.push(`${scenario.surface} 缺 fixture`)
    if (scenario.pending != null && scenario.pending.trim() === "") problems.push(`${scenario.surface} pending 原因不能为空串`)
    if (scenario.seed != null && (typeof scenario.seed !== "object" || Array.isArray(scenario.seed))) problems.push(`${scenario.surface} seed 必须是对象`)
    for (const step of scenario.steps) {
      if ("click" in step) {
        if (!step.click) problems.push(`${scenario.surface} 有空 click 选择器`)
        else if (!STABLE.test(step.click)) problems.push(`${scenario.surface} 非稳定选择器：${step.click}`)
      } else if ("waitFor" in step) {
        if (!step.waitFor) problems.push(`${scenario.surface} 有空 waitFor 选择器`)
        else if (!STABLE.test(step.waitFor)) problems.push(`${scenario.surface} 非稳定选择器：${step.waitFor}`)
      } else if ("pointerDown" in step) {
        if (!step.pointerDown) problems.push(`${scenario.surface} 空 pointerDown 选择器`)
        else if (!STABLE.test(step.pointerDown)) problems.push(`${scenario.surface} 非稳定选择器：${step.pointerDown}`)
      } else if ("press" in step) {
        if (!/^(Control|Meta|Alt|Shift)(\+(Control|Meta|Alt|Shift))*\+[A-Za-z0-9]$/.test(step.press)) problems.push(`${scenario.surface} press 组合键不合法：${step.press}`)
      } else if ("waitMs" in step) {
        if (!(step.waitMs >= 0)) problems.push(`${scenario.surface} waitMs 非法`)
      } else {
        problems.push(`${scenario.surface} 未知步骤`)
      }
    }
  }
  return problems
}

/** 已实现（非 pending）场景（e2e / 截图脚本先跑这些） */
export function p4ActiveScenarios(): P4Scenario[] {
  return P4_SCENARIOS.filter((scenario) => !scenario.pending)
}

/** pending 场景（用于报告覆盖率） */
export function p4PendingScenarios(): P4Scenario[] {
  return P4_SCENARIOS.filter((scenario) => !!scenario.pending)
}
