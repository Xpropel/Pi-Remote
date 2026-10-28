/**
 * 能力元数据注册表（P4.1）：每项 UI 能力的展示名 / 分组 / 来源 / 默认状态 / 文档锚点 / 未提供原因。
 *
 * **对齐台账**：`full-parity-inventory.md` §5/§6.1 的 34 项能力 ID 与契约**逐字一致**（映射表见 `./inventory-map.ts`）；
 * 契约额外有 3 项扩展（session-rail-extra / notifications / terminal-panes），台账映射标注 extra。
 *
 * 默认状态：Pi 现有数据/状态可直接支撑的 **builtin** 能力默认 `available`（如 device-platform-tabs / context-usage /
 * model-menu / file-preview…）；真正需要扩展的 **extension** 能力默认 `unavailable`（生产默认禁用态，dev ?caps= mock 可演示）。
 * 运行态仍以 provider 探测为准（builtin 由 relay/prefs 直供，不注册 provider）。
 */
import type { PiUiCapability, PiUiCapabilityGroup, PiUiCapabilityMeta, PiUiCapabilityStatus } from "./types.ts"

/** 用户文档路径（能力锚点 = `${PI_UI_EXTENSION_DOC_PATH}#cap-<id>`） */
export const PI_UI_EXTENSION_DOC_PATH = "DOC/74-ui-variants-extension.md"

const DEFAULT_REASON = "当前 pi 没有提供这项能力的数据源；接入扩展（或等待 relay/pi 支持）后即可启用。"

const meta = (
  id: PiUiCapability,
  label: string,
  group: PiUiCapabilityGroup,
  description: string,
  source: "builtin" | "extension",
  ledgerStatus: PiUiCapabilityStatus,
  unavailableReason: string = DEFAULT_REASON,
): PiUiCapabilityMeta => ({
  id,
  label,
  group,
  description,
  source,
  providerBacked: source === "extension",
  ledgerStatus,
  docAnchor: `#cap-${id}`,
  // builtin = Pi 现有数据可直接支撑；extension = 需要扩展 provider（生产默认禁用态）
  defaultStatus: source === "builtin" ? "available" : "unavailable",
  unavailableReason,
})

/** 全部能力元数据（顺序 = 台账 §5 顺序 + 契约扩展；设置页 / 文档 / 验收矩阵同序） */
export const PI_UI_CAPABILITIES: readonly PiUiCapabilityMeta[] = [
  // ---- 台账 §5 的 34 项 ----
  meta("device-platform-tabs", "设备平台标签", "pane", "按设备平台筛选：Mac / Windows / Linux / 全部。", "builtin", "available"),
  meta("workspace-modes", "会话 / 任务 / 工作台", "pane", "会话 / 任务 / 工作台 三种模式切换。", "builtin", "available"),
  meta("pane-workspace", "多窗格工作台", "pane", "多窗格工作台：可开合的改动 / 文件 / 终端 / 浏览器 / 计划 / 侧聊 / 任务 / 子 agent 窗格。", "extension", "unavailable", "pi 目前只有单右栏；扩展提供多窗格后启用。"),
  meta("pane-dock-drag", "窗格拖拽与停靠", "pane", "拖动窗格、停靠与保存布局。", "extension", "simulated", "pi 目前不支持窗格拖拽 / 停靠；扩展提供后启用。"),
  meta("artifacts", "产出物", "content", "会话产出物：markdown / 网页 / 图表 / 代码 / 图片预览。", "extension", "simulated"),
  meta("browser-pane", "设备端浏览器工具", "pane", "设备端浏览器工具：由设备端扩展提供的网页操作与点选。", "extension", "unavailable", "设备端浏览器需要设备端扩展；本机 pi 未提供。"),
  meta("plan-pane", "计划 / 进度", "content", "计划与进度：多步计划、进度与步骤编辑。", "extension", "simulated"),
  meta("side-chat", "侧边对话", "workflow", "侧边对话：不打断主对话的旁路问询。", "extension", "simulated"),
  meta("subagents-panel", "子 agent 状态（只读）", "workflow", "子 agent 状态（只读）：多代理运行状态与结果。", "extension", "simulated"),
  meta("automations", "计划任务", "workflow", "计划任务：定时 / 事件触发的自动任务。", "extension", "unavailable", "pi 目前没有计划任务调度；扩展提供后启用。"),
  meta("pr-review", "代码审查", "integration", "代码审查：PR 列表、详情、评论与审查动作。", "extension", "simulated", "当前无法直连远端代码平台；扩展提供代码审查数据后启用。"),
  meta("git-commit", "Git 提交链路", "integration", "Git 提交：commit / push / 创建 PR。", "extension", "unavailable"),
  meta("plugins", "扩展", "integration", "扩展：pi 扩展的安装与启用。", "extension", "unavailable", "pi 当前没有扩展安装入口；扩展系统提供后启用。"),
  meta("connectors", "连接器", "integration", "连接器：外部服务连接及状态。", "extension", "unavailable"),
  meta("skills", "技能", "integration", "技能：可复用的 pi 技能与斜杠命令。", "extension", "simulated"),
  meta("permission-tiers", "审批策略", "customization", "审批策略：权限档位切换（当前 pi 为逐次确认）。", "extension", "unavailable", "pi 当前为逐次确认（允许 / 拒绝），没有档位切换；扩展提供档位后启用。"),
  meta("density-modes", "密度模式", "customization", "显示密度：舒适 / 紧凑 / 详细。", "builtin", "available"),
  meta("suggestions", "建议词", "content", "建议词：下一步建议与快捷动作。", "extension", "simulated"),
  meta("code-review-comments", "代码审查评论", "workflow", "代码审查评论：行内评论、回复与解决。", "extension", "simulated"),
  meta("background-tasks", "后台任务", "workflow", "后台任务：任务看板、进度与取消。", "builtin", "available"),
  meta("mcp-tools", "MCP 工具", "integration", "MCP 工具：服务与工具列表、入参表单与审批。", "builtin", "available"),
  meta("context-usage", "上下文用量", "content", "上下文用量：用量卡片、百分比与费用。", "builtin", "available"),
  meta("model-menu", "模型 / 强度菜单", "content", "模型与思考强度选择。", "builtin", "available"),
  meta("file-editor", "文件编辑器", "content", "文件编辑器：在应用内编辑与保存文件。", "extension", "unavailable", "pi 的网页端目前只读文件；扩展提供编辑接口后启用。"),
  meta("file-preview", "文件查看", "content", "文件查看：文本与图片预览。", "builtin", "available"),
  meta("worktree", "git worktree（隔离副本）", "workflow", "git worktree（隔离副本）：创建与打开。", "extension", "unavailable", "Pi 当前无 git worktree（隔离副本）能力；扩展提供后启用。"),
  meta("multi-tab", "多标签页", "pane", "多标签页：多个会话标签切换。", "extension", "unavailable"),
  meta("theme-custom", "主题自定义", "customization", "主题自定义：界面颜色与字体。", "extension", "simulated"),
  meta("session-pin", "会话置顶", "workflow", "会话置顶与收藏。", "extension", "simulated"),
  meta("terminal-interactive", "设备端终端（只读）", "pane", "设备端终端：只读输出，输入需扩展。", "extension", "simulated", "设备端终端当前只读；输入 / 交互需扩展。"),
  meta("dictation", "听写", "content", "听写：语音转文字（需扩展提供）。", "extension", "unavailable"),
  meta("work-mode", "运行位置", "workflow", "运行位置：当前设备 / 指定文件夹 / 远端设备。", "builtin", "available"),
  meta("workspace-connectors", "连接 rail 卡", "integration", "连接入口：服务器与连接器卡片。", "extension", "unavailable"),
  meta("device-code-login", "Pi 配对", "integration", "Pi 配对：一次性配对码 + attach 命令；接入流程由扩展提供。", "extension", "simulated"),
  // ---- candidate：台账 surface 行（§6.1 未单列）→ 独立 capability（终版事实；台账 A.1/A.3 逐字一致）----
  meta("subagent-orchestration", "多代理编排", "workflow", "多代理编排：多 agent 画布与任务编排。", "extension", "simulated", "需多代理编排扩展；pi 当前无编排能力。"),
  meta("git-stage", "Git 暂存", "integration", "Git 暂存：stage / unstage / revert。", "extension", "simulated"),
  meta("thread-fork-feedback", "会话分叉与反馈", "workflow", "会话分叉与反馈：从任意回合分叉，Good / Bad 反馈。", "extension", "simulated"),

  // ---- 契约层扩展（台账 extra）----
  meta("session-rail-extra", "会话侧栏扩展", "pane", "会话侧栏扩展条目。", "extension", "unavailable"),
  meta("notifications", "通知规则", "customization", "通知规则：按事件与设备配置通知。", "extension", "unavailable"),
  meta("terminal-panes", "多终端（实例）", "pane", "多终端：创建、切换与结束终端。", "extension", "unavailable"),
]

const BY_ID: ReadonlyMap<PiUiCapability, PiUiCapabilityMeta> = new Map(PI_UI_CAPABILITIES.map((item) => [item.id, item]))

/** builtin 能力（Pi 现有数据/状态直供，默认 available，不需要 provider） */
export const PI_UI_BUILTIN_CAPABILITIES: readonly PiUiCapability[] = PI_UI_CAPABILITIES.filter((item) => item.source === "builtin").map((item) => item.id)

/** extension 能力（需要 provider；生产默认 unavailable / dev mock 可 simulated） */
export const PI_UI_EXTENSION_CAPABILITIES: readonly PiUiCapability[] = PI_UI_CAPABILITIES.filter((item) => item.source === "extension").map((item) => item.id)

/** 需要 provider 才有数据的契约能力 ID（= extension；全项目数据由 PI_UI_CAPABILITY_IDS 派生，不再手写数量） */
export const PI_UI_CAPABILITY_PROVIDER_IDS: readonly PiUiCapability[] = PI_UI_CAPABILITIES.filter((item) => item.providerBacked).map((item) => item.id)

/** 纯契约 / 标签 / 纯 UI 状态能力 ID（builtin，无需 provider） */
export const PI_UI_CAPABILITY_CONTRACT_IDS: readonly PiUiCapability[] = PI_UI_CAPABILITIES.filter((item) => !item.providerBacked).map((item) => item.id)

/** 能力 id → 元数据（id 必须合法；非法调用属编程错误） */
export function piUiCapabilityMetaOf(id: PiUiCapability): PiUiCapabilityMeta {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`未知的 Pi UI 能力：${String(id)}`)
  return found
}

/** 能力元数据列表（按 id 过滤） */
export function piUiCapabilityMetasOf(ids: readonly PiUiCapability[]): PiUiCapabilityMeta[] {
  return ids.map((id) => piUiCapabilityMetaOf(id))
}

/** 文档锚点 id 列表（用于文档校验：每个能力都必须有一个 `### cap-<id>` 小节） */
export function piUiCapabilityAnchors(): string[] {
  return PI_UI_CAPABILITIES.map((item) => item.docAnchor)
}

/** 能力分组（设置页 / 文档分类） */
export const PI_UI_CAPABILITY_GROUPS: readonly { id: PiUiCapabilityGroup; label: string }[] = [
  { id: "pane", label: "窗格与工作台" },
  { id: "content", label: "内容与产物" },
  { id: "workflow", label: "工作流" },
  { id: "customization", label: "外观与权限" },
  { id: "integration", label: "扩展与集成" },
]
