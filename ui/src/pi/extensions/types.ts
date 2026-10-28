/**
 * UI 扩展能力层：能力 id、状态、每项能力的**数据契约 / 动作回调 / 事件**、provider 接口。
 *
 * 背景（brief「P4 全量对齐计划」§原则 3/4）：参考设计里的很多 surface（窗格拖拽、Artifacts、Browser、Plan、
 * Side-chat、Subagent、Automations、PR、Plugins、Connectors、Skills、权限档位、密度模式、建议词、评论、后台任务、
 * 文件编辑器、MCP tools、session rail 扩展…）是 Pi-Remote / pi 目前没有的能力。两套变体必须**有完整 UI**，
 * 但运行时按本层能力状态渲染：
 *   - `available`：真实 provider 已注册（未来由扩展 / relay 提供），UI 可用；
 *   - `unavailable`：没有 provider（生产默认）→ 统一禁用态「本机 pi 未提供此能力」+ 原因 + 「如何接入」文档锚点；
 *   - `simulated`：dev/mock provider 注入的演示数据 → UI 可完整走通，但显示「模拟演示」标识。
 *
 * 本文件**只有类型与常量**（无 React / 无 relay / 无协议依赖），可被两套变体（claude/codex）、cursor 与测试共同 import。
 * 运行时实现在 `./registry.ts`（provider 注册 / 解析）、`./capabilities.ts`（能力元数据）、`./disabled.ts`（禁用态契约）、
 * `./mock/**`（dev-only 注入）；hook 见 `./usePiUiCapabilities.ts`。
 */

/* ------------------------------------------------------------------------------------------------
 * 能力 id（台账：P4 全量对齐需要补齐的 surface）
 * ---------------------------------------------------------------------------------------------- */

/** 全部 UI 能力 id（新增能力必须同时补 `PI_UI_CAPABILITY_META` 与数据契约；测试会校验） */
export const PI_UI_CAPABILITY_IDS = [
  // ---- 台账 §5/§6.1 的 34 项（ID 与台账逐字一致，映射表见 ./inventory-map.ts；两线不得另起名）----
  /** 设备平台标签（Mac / Windows / Linux / 全部）：台账 §3 核心适配 A；builtin（relay.devices[].platform） */
  "device-platform-tabs",
  /** 会话 / 任务 / 工作台 三段模式（Hub Rail）：台账 §3.5；builtin（变体本地状态） */
  "workspace-modes",
  /** 多窗格工作台（pane workspace）：右栏 / 底部可开合窗格列表 */
  "pane-workspace",
  /** 窗格拖拽 / 停靠 / 改尺寸（pane dock & drag） */
  "pane-dock-drag",
  /** Artifacts：可预览的产出物（markdown / html / 图表 / 代码 / 图片） */
  "artifacts",
  /** Browser 窗格：内嵌浏览器标签页 */
  "browser-pane",
  /** Plan 窗格：多步计划 / 进度（可编辑步骤） */
  "plan-pane",
  /** 侧边对话（side-chat）：不打断主对话的旁路问询 */
  "side-chat",
  /** 子 agent 面板：多代理运行状态 / 任务分派 */
  "subagents-panel",
  /** Automations：定时 / 触发式自动任务 */
  "automations",
  /** Pull request 审查（列表 / 详情 / 范围 chips / 评论 / merge） */
  "pr-review",
  /** git commit / stage / push / create PR 链路 */
  "git-commit",
  /** 插件市场与已装插件 */
  "plugins",
  /** Connectors：外部服务连接（GitHub / Slack / 其它） */
  "connectors",
  /** Skills：可复用技能包 */
  "skills",
  /** 权限档位（permission tiers：只读 / 编辑 / 完全权限…） */
  "permission-tiers",
  /** 密度模式（Normal / Thinking / Verbose → 舒适 / 紧凑 / 详细）：builtin（prefs.density） */
  "density-modes",
  /** 建议词 / 下一步建议（suggestions） */
  "suggestions",
  /** 代码审查评论（行内评论线程 / resolve / 攒批提交） */
  "code-review-comments",
  /** 后台任务（Tasks 看板 / 后台任务）：builtin（taskList + terminal items） */
  "background-tasks",
  /** MCP tools：MCP server / tool 列表、审批卡与调用状态：builtin（transcript tool blocks + dialog） */
  "mcp-tools",
  /** Context 用量（Context 卡 / 圆环 / 百分比）：builtin（contextReadout） */
  "context-usage",
  /** 模型 / 强度菜单：builtin（models / modelContextWindowOf） */
  "model-menu",
  /** 文件编辑器（应用内编辑 / 保存）：当前 Pi 只读 */
  "file-editor",
  /** 文件查看（file preview）：builtin（getFile） */
  "file-preview",
  /** Worktree 隔离副本 / 创建流程（Codex Local/Worktree/Cloud 的 worktree 段，默认禁用入口） */
  "worktree",
  /** 多标签页（multi-tab）：Pi 当前单会话 */
  "multi-tab",
  /** 主题自定义（表面色 / 强调色 / 导入导出）：当前仅 light/dark/system */
  "theme-custom",
  /** 会话置顶 / 收藏（session pin） */
  "session-pin",
  /** 交互式终端（输入 / 会话）：Pi 当前只读输出 */
  "terminal-interactive",
  /** 听写（dictation，浏览器 SpeechRecognition 可选 provider） */
  "dictation",
  /** 编码 / 聊天工作模式（work mode） */
  "work-mode",
  /** 服务器 / 连接器 rail 卡（workspace connectors） */
  "workspace-connectors",
  /** 设备码登录（device code login；与 Pi 配对码语义相近） */
  "device-code-login",
  // ---- candidate：台账 surface 行出现、§6.1 未单列；架构裁决 = 独立 capability（终版事实，台账 A.1/A.3 逐字一致）----
  /** 多代理编排画布（CL-CODE-25）：独立 capability（subagents-panel 管列表/状态，画布编排单独建模） */
  "subagent-orchestration",
  /** git stage / unstage / revert 等暂存区动作（CX-PANEL-05）：独立于 git-commit（commit/push 链路） */
  "git-stage",
  /** thread fork（Pi 现有 → fork.available=true）+ Good/Bad 反馈（缺失 → simulated）；一个 capability 两个子状态 */
  "thread-fork-feedback",
  // ---- 契约层扩展（台账未单列，但参考设计/两线 UI 需要；台账映射表标注 extra）----
  /** session rail / 侧栏扩展条目（第三方注入的会话维度入口） */
  "session-rail-extra",
  /** 通知规则（按事件 / 设备 / 房间配置通知渠道与开关） */
  "notifications",
  /** 多终端实例（创建 / 切换 / 结束；与 terminal-interactive 区分：后者是单终端的交互能力） */
  "terminal-panes",
] as const

/** UI 能力 id 联合类型 */
export type PiUiCapability = (typeof PI_UI_CAPABILITY_IDS)[number]

/** 能力状态：可用 / 未提供（禁用态）/ 模拟演示（dev+mock） */
export type PiUiCapabilityStatus = "available" | "unavailable" | "simulated"

/** 能力分组（设置页扩展区、文档、台账分组用） */
export type PiUiCapabilityGroup = "pane" | "content" | "workflow" | "customization" | "integration"

/** 能力元数据（展示名 / 文档锚点 / 默认状态 / 未提供原因） */
export interface PiUiCapabilityMeta {
  id: PiUiCapability
  /** 能力来源：builtin = Pi 现有数据/状态可直接支撑（无需扩展）；extension = 需要扩展 provider（生产默认禁用态） */
  source: "builtin" | "extension"
  /** 是否需要 provider 提供数据（= source === "extension"）；contract-only 的界面/标签类能力为 false */
  providerBacked: boolean
  /** 台账（full-parity-inventory §5）记录的状态（对齐用；运行态仍以 provider 探测为准） */
  ledgerStatus?: PiUiCapabilityStatus
  /** 展示名（设置页 / 禁用态标题用） */
  label: string
  group: PiUiCapabilityGroup
  /** 一句话说明（文档 + 禁用态原因） */
  description: string
  /** 用户文档锚点（`扩展接入文档.md#cap-<id>`） */
  docAnchor: string
  /** 初始状态：生产默认全部 `unavailable`（未来 relay / 扩展探测可覆盖） */
  defaultStatus: PiUiCapabilityStatus
  /** 未提供时给用户的原因（可被 provider / disabled 契约覆盖） */
  unavailableReason: string
}

/* ------------------------------------------------------------------------------------------------
 * 每项能力的数据契约（provider 返回的只读快照；字段命名与 UI 无关，两套变体各自映射成视觉）
 * 约定：所有时间用毫秒时间戳（number）；id 用字符串且在 provider 内稳定；列表顺序即展示顺序（除非带 order/rank）。
 * ---------------------------------------------------------------------------------------------- */

export interface PiUiPaneDescriptor {
  id: string
  title: string
  kind: "changes" | "files" | "terminal" | "browser" | "plan" | "side-chat" | "tasks" | "subagent" | "custom"
  /** 角标（数量 / 状态点文案；无 = 不显示） */
  badge?: string
  /** 是否允许拖动 / dock（drag-dock 能力缺失时 UI 忽略） */
  dockable?: boolean
  /** 排序（越小越靠前；缺省按数组顺序） */
  order?: number
}

export interface PiUiLayoutPreset {
  id: string
  title: string
  /** 已打开的 pane id 顺序（左→右 / 上→下） */
  paneIds: string[]
  /** 各 pane 相对尺寸（0–1；缺省均分） */
  sizes?: number[]
}

export interface PiUiArtifact {
  id: string
  title: string
  kind: "markdown" | "html" | "code" | "chart" | "image" | "other"
  updatedAt: number
  /** 预览内容（markdown/html/code 源；image 用 url / data URL） */
  content?: string
  url?: string
  meta?: Record<string, string | number | boolean>
}

export interface PiUiBrowserTab {
  id: string
  title: string
  url: string
  faviconUrl?: string
  /** 该标签页是否由 agent 打开（UI 可加 "agent" 标记） */
  openedBy?: "user" | "agent"
}

export interface PiUiPlanStep {
  id: string
  title: string
  status: "pending" | "in_progress" | "completed" | "failed" | "skipped"
  detail?: string
}

export interface PiUiPlan {
  id: string
  title: string
  summary?: string
  steps: PiUiPlanStep[]
  updatedAt: number
}

export interface PiUiSideChatMessage {
  id: string
  role: "user" | "assistant"
  text: string
  at: number
}

export interface PiUiSideChatThread {
  id: string
  title: string
  /** 关联的主对话 room / 会话 id（可空 = 全局） */
  roomId?: string
  messages: PiUiSideChatMessage[]
  updatedAt: number
}

export interface PiUiSubagent {
  id: string
  name: string
  role?: string
  status: "running" | "idle" | "done" | "failed"
  /** 当前任务一句话 */
  task?: string
  startedAt?: number
  finishedAt?: number
}

export interface PiUiAutomation {
  id: string
  name: string
  description?: string
  /** 触发描述（cron / event，UI 只展示） */
  trigger: string
  enabled: boolean
  lastRunAt?: number
  lastResult?: "success" | "failed" | "running" | "never"
}

export interface PiUiPullRequest {
  id: string
  number: number
  title: string
  repo: string
  author?: string
  state: "open" | "draft" | "merged" | "closed" | "archived"
  reviewState?: "pending" | "approved" | "changes_requested" | "commented"
  updatedAt: number
  url?: string
}

export interface PiUiPlugin {
  id: string
  name: string
  version: string
  description?: string
  installed: boolean
  enabled: boolean
}

export interface PiUiConnector {
  id: string
  name: string
  kind: string
  status: "connected" | "disconnected" | "error"
  /** 账号 / 工作区标识（脱敏展示） */
  account?: string
  lastSyncAt?: number
}

export interface PiUiSkill {
  id: string
  name: string
  description?: string
  source?: string
  enabled: boolean
}

export interface PiUiPermissionTier {
  id: string
  label: string
  description?: string
  /** 该档位允许的动作（UI 展示为能力清单） */
  allows: string[]
}

export interface PiUiDensityMode {
  id: string
  label: string
  description?: string
  /** 行高 / 字号档位提示（数值由变体自写样式映射） */
  rowHeight?: number
  fontSize?: number
}

export interface PiUiSuggestion {
  id: string
  text: string
  kind?: "reply" | "action" | "refine" | "followup"
  /** 点击后发送 / 执行的建议动作（UI 可只展示，动作由 provider 回调） */
  command?: string
}

export interface PiUiReviewComment {
  id: string
  body: string
  author?: string
  createdAt: number
  resolved: boolean
  path?: string
  line?: number
}

export interface PiUiReviewThread {
  id: string
  path: string
  line?: number
  resolved: boolean
  comments: PiUiReviewComment[]
}

export interface PiUiBackgroundTask {
  id: string
  title: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  progress?: number
  startedAt?: number
  finishedAt?: number
  detail?: string
}

export interface PiUiEditableFile {
  path: string
  /** 文件内容（provider 在 `file-editor` 契约里给；大文件由 provider 自行分页） */
  content: string
  language?: string
  dirty?: boolean
  updatedAt?: number
}

export interface PiUiMcpServer {
  id: string
  name: string
  status: "connected" | "disconnected" | "error"
  toolCount?: number
}

export interface PiUiMcpTool {
  id: string
  serverId: string
  name: string
  description?: string
  /** 工具入参 JSON Schema（UI 可渲染表单） */
  inputSchema?: Record<string, unknown>
}

export interface PiUiSessionRailEntry {
  id: string
  label: string
  /** 角标（数量 / 状态点文案） */
  badge?: string
  order?: number
  /** 点击时 provider 回调的 action id */
  actionId?: string
}

export interface PiUiTerminalDescriptor {
  id: string
  title: string
  status: "running" | "exited"
  cwd?: string
  exitCode?: number | null
}

export interface PiUiNotificationRule {
  id: string
  label: string
  enabled: boolean
  channel: "system" | "sound" | "badge" | "none"
  /** 触发描述（事件名 / 条件，UI 只展示） */
  trigger: string
}

export interface PiUiPlatformTabDescriptor {
  id: "all" | "macos" | "windows" | "linux"
  label: string
  deviceCount: number
  lastDeviceId?: string
}

export interface PiUiWorkspaceMode {
  id: string
  label: string
  description?: string
}

export interface PiUiGitState {
  repoPath: string
  branch: string
  staged: string[]
  unstaged: string[]
  canCommit: boolean
}

export interface PiUiContextUsage {
  tokensUsed?: number
  contextWindow?: number
  percent?: number
  detail?: string
}

export interface PiUiModelOption {
  id: string
  provider: string
  modelId: string
  label: string
  current?: boolean
  contextWindow?: number
}

export interface PiUiFilePreview {
  path: string
  kind: "text" | "image" | "binary" | "truncated"
  content?: string
  url?: string
  truncated?: boolean
}

export interface PiUiWorktree {
  id: string
  path: string
  branch: string
  repoPath: string
  status: "clean" | "dirty" | "missing"
}

export interface PiUiBareTab {
  id: string
  title: string
  kind: string
}

export interface PiUiThemeCustomization {
  surface?: string
  accent?: string
  fontFamily?: string
  importedFrom?: string
}

export interface PiUiPinnedSession {
  sessionId: string
  pinnedAt: number
}

export interface PiUiInteractiveTerminal {
  terminalId: string
  running: boolean
  cwd?: string
  recentLines?: string[]
}

export interface PiUiDictationState {
  supported: boolean
  listening: boolean
  language?: string
  transcript?: string
}

export interface PiUiWorkModeOption {
  id: string
  label: string
  description?: string
}

export interface PiUiWorkspaceConnectorCard {
  id: string
  name: string
  status: "connected" | "disconnected" | "error"
  detail?: string
}

export interface PiUiDeviceCodeLogin {
  code: string
  expiresAt: number
  verificationUrl?: string
}

export interface PiUiSubagentOrchestrationNode {
  agentId: string
  label: string
  column?: number
  status?: PiUiSubagent["status"]
}

export interface PiUiSubagentOrchestrationEdge {
  from: string
  to: string
  label?: string
}

export interface PiUiSubagentOrchestration {
  nodes: PiUiSubagentOrchestrationNode[]
  edges: PiUiSubagentOrchestrationEdge[]
  revision?: number
}

export interface PiUiGitStageState {
  repoPath: string
  staged: string[]
  unstaged: string[]
  canStage: boolean
  canRevert: boolean
}

export interface PiUiThreadForkFeedbackFork {
  /** fork 部分 Pi 现有能力 → true（available；数据由 relay 提供） */
  available: boolean
  branches?: { id: string; label: string; lastMessageAt?: number }[]
}

export interface PiUiThreadForkFeedbackFeedback {
  /** Good / Bad 反馈：Pi 无此能力 → false（extension / simulated） */
  enabled: boolean
  lastVote?: "good" | "bad" | null
}

export interface PiUiThreadForkFeedback {
  fork: PiUiThreadForkFeedbackFork
  feedback: PiUiThreadForkFeedbackFeedback
}

/** 能力 id → provider 返回的数据快照类型 */
export interface PiUiCapabilityDataMap {
  "device-platform-tabs": { platforms: PiUiPlatformTabDescriptor[]; activeTabId?: string; deviceByPlatform?: Partial<Record<"macos" | "windows" | "linux", string>> }
  "workspace-modes": { modes: PiUiWorkspaceMode[]; activeModeId?: string }
  "pane-workspace": { panes: PiUiPaneDescriptor[] }
  "pane-dock-drag": { layouts: PiUiLayoutPreset[]; activeLayoutId?: string }
  artifacts: { artifacts: PiUiArtifact[] }
  "browser-pane": { tabs: PiUiBrowserTab[]; activeTabId?: string }
  "plan-pane": { plan: PiUiPlan }
  "side-chat": { threads: PiUiSideChatThread[] }
  "subagents-panel": { agents: PiUiSubagent[] }
  automations: { automations: PiUiAutomation[] }
  "pr-review": { pullRequests: PiUiPullRequest[] }
  "git-commit": { repos: PiUiGitState[] }
  plugins: { plugins: PiUiPlugin[] }
  connectors: { connectors: PiUiConnector[] }
  skills: { skills: PiUiSkill[] }
  "permission-tiers": { tiers: PiUiPermissionTier[]; currentTierId?: string }
  "density-modes": { modes: PiUiDensityMode[]; currentModeId?: string }
  suggestions: { suggestions: PiUiSuggestion[] }
  "code-review-comments": { threads: PiUiReviewThread[] }
  "background-tasks": { tasks: PiUiBackgroundTask[] }
  "file-editor": { files: PiUiEditableFile[]; activeFileId?: string }
  "file-preview": { preview: PiUiFilePreview | null }
  worktree: { worktrees: PiUiWorktree[] }
  "multi-tab": { tabs: PiUiBareTab[]; activeTabId?: string }
  "theme-custom": { customization: PiUiThemeCustomization }
  "session-pin": { pinned: PiUiPinnedSession[] }
  "terminal-interactive": { terminal: PiUiInteractiveTerminal | null }
  dictation: { dictation: PiUiDictationState }
  "work-mode": { modes: PiUiWorkModeOption[]; activeModeId?: string }
  "workspace-connectors": { connectors: PiUiWorkspaceConnectorCard[] }
  "device-code-login": { login: PiUiDeviceCodeLogin | null }
  "mcp-tools": { servers: PiUiMcpServer[]; tools: PiUiMcpTool[] }
  "context-usage": { usage: PiUiContextUsage }
  "model-menu": { models: PiUiModelOption[]; currentModelId?: string }
  "session-rail-extra": { entries: PiUiSessionRailEntry[] }
  "terminal-panes": { terminals: PiUiTerminalDescriptor[] }
  "subagent-orchestration": PiUiSubagentOrchestration
  "git-stage": { states: PiUiGitStageState[] }
  "thread-fork-feedback": PiUiThreadForkFeedback
  notifications: { rules: PiUiNotificationRule[] }
}

/** 能力 id → 数据快照类型（按能力取值） */
export type PiUiCapabilityData<K extends PiUiCapability> = PiUiCapabilityDataMap[K]

/**
 * 能力 id → provider 暴露给 UI 的回调（事件 / 动作）。缺省 = 只读展示。
 * 约定：所有回调同步返回 void / Promise，失败由 provider 自己通过事件或数据快照表达；UI 不捕获协议细节。
 */
export interface PiUiCapabilityActionMap {
  "device-platform-tabs": { selectPlatform?(tab: "all" | "macos" | "windows" | "linux"): void; selectDevice?(platform: "macos" | "windows" | "linux", deviceId: string): void }
  "workspace-modes": { selectMode?(modeId: string): void }
  "pane-workspace": { openPane?: (paneId: string) => void; closePane?: (paneId: string) => void; focusPane?: (paneId: string) => void }
  "pane-dock-drag": { applyLayout?: (layoutId: string) => void; saveLayout?: (layout: PiUiLayoutPreset) => void; resetLayout?: () => void }
  "git-commit": { commit?: (repoPath: string, message: string) => void; push?: (repoPath: string) => void; createPr?: (repoPath: string) => void }
  artifacts: { openArtifact?: (artifactId: string) => void; revealArtifact?: (artifactId: string) => void }
  "browser-pane": { openUrl?: (url: string) => void; closeTab?: (tabId: string) => void; activateTab?: (tabId: string) => void }
  "plan-pane": { updateStep?: (planId: string, stepId: string, status: PiUiPlanStep["status"]) => void }
  "side-chat": { sendMessage?: (threadId: string | null, text: string) => void; createThread?: (title?: string) => void }
  "subagents-panel": { focusAgent?: (agentId: string) => void; cancelAgent?: (agentId: string) => void }
  automations: { runNow?: (automationId: string) => void; toggle?: (automationId: string, enabled: boolean) => void }
  "pr-review": {
    openPr?: (prId: string) => void
    approve?: (prId: string) => void
    requestChanges?: (prId: string, comment: string) => void
    /** 合并（state → merged；可带 merge 方式） */
    mergePr?: (prId: string, method?: "merge" | "squash" | "rebase") => void
    /** 关闭（state → closed） */
    closePr?: (prId: string) => void
    /** 归档（state → archived；Codex PR 面板有独立按钮，与 close 区分） */
    archivePr?: (prId: string) => void
    /** 重新打开（closed/archived → open） */
    reopenPr?: (prId: string) => void
  }
  plugins: { installPlugin?: (pluginId: string) => void; setPluginEnabled?: (pluginId: string, enabled: boolean) => void }
  connectors: { connect?: (connectorId: string) => void; disconnect?: (connectorId: string) => void }
  skills: { toggleSkill?: (skillId: string, enabled: boolean) => void }
  "permission-tiers": { selectTier?: (tierId: string) => void }
  "density-modes": { selectMode?: (modeId: string) => void }
  suggestions: { pickSuggestion?: (suggestionId: string) => void }
  "code-review-comments": { resolveThread?: (threadId: string) => void; reply?: (threadId: string, body: string) => void }
  "background-tasks": { cancelTask?: (taskId: string) => void; openTask?: (taskId: string) => void }
  "file-editor": { openFile?: (path: string) => void; saveFile?: (path: string, content: string) => void }
  "file-preview": { openFile?: (path: string) => void }
  worktree: { createWorktree?: (repoPath: string, branch: string) => void; openWorktree?: (worktreeId: string) => void }
  "multi-tab": { selectTab?: (tabId: string) => void; closeTab?: (tabId: string) => void }
  "theme-custom": { applyTheme?: (patch: PiUiThemeCustomization) => void; resetTheme?: () => void }
  "session-pin": { togglePin?: (sessionId: string) => void }
  "terminal-interactive": { sendInput?: (terminalId: string, input: string) => void }
  dictation: { start?: () => void; stop?: () => void }
  "work-mode": { selectWorkMode?: (modeId: string) => void }
  "workspace-connectors": { connect?: (connectorId: string) => void; disconnect?: (connectorId: string) => void }
  "device-code-login": { startDeviceCodeLogin?: () => void; cancel?: () => void }
  "mcp-tools": { callTool?: (toolId: string, input: Record<string, unknown>) => void }
  "context-usage": Record<string, never>
  "model-menu": { selectModel?: (modelId: string) => void }
  "session-rail-extra": { activateEntry?: (entryId: string) => void }
  "terminal-panes": { createTerminal?: () => void; killTerminal?: (terminalId: string) => void; focusTerminal?: (terminalId: string) => void }
  "subagent-orchestration": { focusNode?: (agentId: string) => void; openCanvas?: () => void }
  "git-stage": { stage?: (repoPath: string, paths: string[]) => void; unstage?: (repoPath: string, paths: string[]) => void; revert?: (repoPath: string, paths: string[]) => void }
  "thread-fork-feedback": { forkThread?: (branchId: string) => void; sendFeedback?: (vote: "good" | "bad") => void }
  notifications: { updateRule?: (ruleId: string, patch: Partial<Omit<PiUiNotificationRule, "id">>) => void }
}

/** 能力 id → 回调类型（按能力取值） */
export type PiUiCapabilityActions<K extends PiUiCapability> = PiUiCapabilityActionMap[K]

/* ------------------------------------------------------------------------------------------------
 * Provider 契约（运行时注册；生产默认无 provider）
 * ---------------------------------------------------------------------------------------------- */

/** 单项能力的 provider：给数据快照、可选订阅（数据变化时通知 UI 重渲染）、可选动作回调、可选事件流 */
export interface PiUiCapabilityProvider<K extends PiUiCapability = PiUiCapability> {
  /** available（真实扩展）/ simulated（dev mock）；缺省 available */
  mode?: Exclude<PiUiCapabilityStatus, "unavailable">
  /** 当前数据快照（UI 每次渲染读一次；需要实时更新时配合 subscribe） */
  getData: () => PiUiCapabilityData<K>
  /** 数据变化通知（返回取消订阅函数）；不实现 = 静态数据 */
  subscribe?: (listener: () => void) => () => void
  /** 动作回调（关闭 / 打开 / 提交 等） */
  getActions?: () => PiUiCapabilityActions<K>
  /** 扩展事件流（状态机 / 异步结果）；UI 可按需订阅，事件体见 PiUiExtensionEvent */
  onEvent?: (listener: (event: PiUiExtensionEvent<K>) => void) => () => void
}

/** 一个扩展 provider 可以一次提供多个能力（同一扩展的 artifacts + browser + plan…） */
export interface PiUiExtensionProvider {
  /** 扩展 id（稳定、全局唯一；重复注册以最后注册者为准） */
  id: string
  /** 展示名（设置页扩展区 / 禁用态"接入方式"用） */
  name?: string
  capabilities: { [K in PiUiCapability]?: PiUiCapabilityProvider<K> }
}

/** `pr-review` 能力的事件（provider → UI；UI 据此刷新 PR 列表/详情，不轮询） */
export type PiUiPrReviewEventType = "pr:opened" | "pr:approved" | "pr:changes-requested" | "pr:merged" | "pr:closed" | "pr:archived" | "pr:reopened"

export type PiUiPrReviewEvent = PiUiExtensionEvent<"pr-review"> & {
  type: PiUiPrReviewEventType
  /** 事件对应的 PR id */
  prId: string
}

/** 扩展事件（provider → UI 的单向通知；payload 由各能力契约定义） */
export interface PiUiExtensionEvent<K extends PiUiCapability = PiUiCapability> {
  capability: K
  /** 事件名（该能力契约里的字符串，如 "artifacts:opened"） */
  type: string
  payload?: unknown
  /** 发生时间（ms） */
  at: number
}

/** 能力解析结果：某个能力当前由哪个 provider 提供 */
export interface PiUiCapabilityBinding<K extends PiUiCapability = PiUiCapability> {
  capability: K
  providerId: string
  status: "available" | "simulated"
  data: PiUiCapabilityData<K>
  actions: PiUiCapabilityActions<K> | null
  /** 订阅该能力数据变化（无 subscribe 的 provider 返回空函数） */
  subscribe: (listener: () => void) => () => void
  /** 订阅扩展事件（无 onEvent 的 provider 返回空函数） */
  onEvent: (listener: (event: PiUiExtensionEvent<K>) => void) => () => void
}
