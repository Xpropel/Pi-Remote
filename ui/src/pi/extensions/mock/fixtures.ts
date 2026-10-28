/**
 * dev-only mock fixtures（P4.2）：每项能力一份**固定、确定性**的演示数据（无随机、无时间漂移）。
 * 只被 `./provider.ts` / `./store.ts` / 测试 / dev mock 入口 import；生产入口不引用本目录。
 *
 * 口径（P4.2 M1）：
 * - `PI_UI_DEMO_FIXTURES`：40 项契约能力的**初始快照**（含 9 项 builtin 的演示数据，供画廊确定性截图；builtin 不注册 provider）。
 * - `PI_UI_DEMO_PROVIDER_FIXTURES`：31 项 provider-backed（`PI_UI_CAPABILITY_PROVIDER_IDS`）的可注入快照，mock 只注入这些。
 * - `PI_UI_DEMO_CONTRACT_FIXTURES`：9 项 contract-only（builtin）的演示快照，不注入 provider（硬规则 2：available 面不冒充）。
 * - 数据量按 `plan-ui-mock.md` §13.4 扩到参考设计可演示规模；id 一律带 `-demo-` 段（同时作为生产排除 grep 的 sentinel）。
 * - 时间基准 `PI_UI_DEMO_NOW`；禁止 Math.random / Date.now / 网络。
 *
 * **适配审计（Pi 语义）**：所有可见数据一律用 Pi-Remote 自己的语义（设备/平台/目录/会话/任务/MCP 工具），
 * 不借用 Cowork/Worktree/PR 等参考 app 的假数据冒充真实能力；能力数据（pr-review/worktree 等）只是 provider
 * 契约的模拟值，UI 必须显示「模拟演示」标识并走统一禁用/启用门控。
 * **unavailable 基线**：按台账 v1.6 的 64 项 U/S（Claude 28 / Codex 36）逐项给 deterministic 数据；生产默认无 provider。
 */
import type {
  PiUiArtifact,
  PiUiAutomation,
  PiUiBackgroundTask,
  PiUiBareTab,
  PiUiBrowserTab,
  PiUiCapability,
  PiUiCapabilityDataMap,
  PiUiConnector,
  PiUiContextUsage,
  PiUiDensityMode,
  PiUiDeviceCodeLogin,
  PiUiDictationState,
  PiUiEditableFile,
  PiUiFilePreview,
  PiUiGitStageState,
  PiUiGitState,
  PiUiInteractiveTerminal,
  PiUiLayoutPreset,
  PiUiMcpServer,
  PiUiMcpTool,
  PiUiModelOption,
  PiUiNotificationRule,
  PiUiPaneDescriptor,
  PiUiPermissionTier,
  PiUiPinnedSession,
  PiUiPlan,
  PiUiPlatformTabDescriptor,
  PiUiPlugin,
  PiUiPullRequest,
  PiUiReviewThread,
  PiUiSessionRailEntry,
  PiUiSideChatThread,
  PiUiSkill,
  PiUiSubagent,
  PiUiSubagentOrchestration,
  PiUiSuggestion,
  PiUiTerminalDescriptor,
  PiUiThemeCustomization,
  PiUiThreadForkFeedback,
  PiUiWorkModeOption,
  PiUiWorkspaceConnectorCard,
  PiUiWorkspaceMode,
  PiUiWorktree,
} from "../types.ts"
import { PI_UI_CAPABILITY_CONTRACT_IDS, PI_UI_CAPABILITY_PROVIDER_IDS } from "../capabilities.ts"

/** 固定基准时间（2026-10-26T12:00:00Z），保证 mock 截图/断言稳定 */
export const PI_UI_DEMO_NOW = Date.UTC(2026, 9, 26, 12, 0, 0)

const M = 60_000
const H = 60 * M

/** 生产包隔离检查用的 sentinel 串（e2e / 构建脚本 grep；生产命中任意一个 = mock 泄漏） */
export const PI_UI_DEMO_SENTINELS: readonly string[] = [
  "pi-ui-mock",
  "pi_dev_ui_mock_caps",
  "art-demo-deck",
  "side-demo-thread-1",
  "plan-demo-p4",
  "mcp-demo-filesystem",
]

/* ------------------------------------------------------------------ 窗格 / 布局 */

const panes: PiUiPaneDescriptor[] = [
  { id: "pane-demo-changes", title: "改动", kind: "changes", badge: "3", dockable: true, order: 0 },
  { id: "pane-demo-files", title: "文件", kind: "files", dockable: true, order: 1 },
  { id: "pane-demo-terminal", title: "终端", kind: "terminal", badge: "2", dockable: true, order: 2 },
  { id: "pane-demo-browser", title: "浏览器", kind: "browser", dockable: true, order: 3 },
  { id: "pane-demo-plan", title: "计划", kind: "plan", dockable: false, order: 4 },
  { id: "pane-demo-side-chat", title: "侧聊", kind: "side-chat", dockable: true, order: 5 },
  // 台账 CL-CODE-07 / CL-CODE-25：Tasks 看板 / Subagent 窗格（kind 已入契约 PiUiPaneDescriptor.kind）
  { id: "pane-demo-subagent", title: "子 agent", kind: "subagent", badge: "3", dockable: true, order: 6 },
  { id: "pane-demo-tasks", title: "Tasks", kind: "tasks", badge: "2", dockable: true, order: 7 },
]

const layouts: PiUiLayoutPreset[] = [
  { id: "layout-demo-review", title: "审查", paneIds: ["pane-demo-changes", "pane-demo-files"], sizes: [0.6, 0.4] },
  { id: "layout-demo-run", title: "运行", paneIds: ["pane-demo-terminal", "pane-demo-plan"] },
  { id: "layout-demo-all", title: "全开", paneIds: ["pane-demo-changes", "pane-demo-files", "pane-demo-terminal", "pane-demo-plan"] },
]

/* ------------------------------------------------------------------ 内容 / 产物 */

const artifacts: PiUiArtifact[] = [
  {
    id: "art-demo-deck",
    title: "P4 全量对齐 · 演示 deck",
    kind: "html",
    updatedAt: PI_UI_DEMO_NOW - 2 * M,
    content:
      '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;margin:0;padding:24px;background:#fcfcfb;color:#1a1c1f}h1{font-size:22px}li{margin:6px 0}</style></head><body><h1>P4 全量对齐</h1><ul><li>40 能力（31 provider-backed）</li><li>117 surface 台账（22 unavailable / 43 simulated）</li><li>mock 双态可截</li></ul></body></html>',
    meta: { size: "3.2 KB", source: "cowork-plan" },
  },
  {
    id: "art-demo-report",
    title: "验收报告",
    kind: "markdown",
    updatedAt: PI_UI_DEMO_NOW - 61 * M,
    content: "# 验收报告\n\n- 独立性守卫 37/37\n- DOM 归因 16/16\n- e2e 双态 23 条\n\n> 演示数据 · 非真实",
    meta: { size: "1.1 KB", source: "review-flow" },
  },
  {
    id: "art-demo-chart",
    title: "能力覆盖",
    kind: "chart",
    updatedAt: PI_UI_DEMO_NOW - 2 * H,
    content: '{"series":[{"label":"available","value":52},{"label":"unavailable","value":22},{"label":"simulated","value":43}]}',
    meta: { size: "0.6 KB", source: "session-rail" },
  },
]

const browserTabs: PiUiBrowserTab[] = [
  { id: "tab-demo-docs", title: "设计规格 · 预览", url: "https://example.com/p4/design-spec", openedBy: "user" },
  { id: "tab-demo-pr", title: "PR #42 · Review", url: "https://example.com/p4/pr/42", openedBy: "agent" },
  { id: "tab-demo-artifact", title: "Artifact · deck", url: "https://example.com/p4/artifact/deck", openedBy: "agent" },
]

const plan: PiUiPlan = {
  id: "plan-demo-p4",
  title: "P4 全量对齐",
  summary: "把参考设计的能力补齐为可解释 + 可模拟的 UI",
  updatedAt: PI_UI_DEMO_NOW,
  steps: [
    { id: "step-demo-1", title: "能力契约层（40 ID 唯一清单）", status: "completed", detail: "task-18 已合并" },
    { id: "step-demo-2", title: "mock providers / 双态截图", status: "in_progress", detail: "task-19" },
    { id: "step-demo-3", title: "两线 Wave1 外壳与设备平台标签", status: "in_progress" },
    { id: "step-demo-4", title: "两线 Wave3 窗格/专属功能", status: "pending" },
    { id: "step-demo-5", title: "全量验收矩阵 + 终审", status: "pending" },
  ],
}

/* ------------------------------------------------------------------ 对话 / agent */

const sideChatThreads: PiUiSideChatThread[] = [
  {
    id: "side-demo-thread-1",
    title: "解释下一个 tool 调用",
    roomId: "r-s1",
    updatedAt: PI_UI_DEMO_NOW - 30_000,
    messages: [
      { id: "side-demo-m1", role: "user", text: "这个 shell 会改什么？", at: PI_UI_DEMO_NOW - 30_000 },
      { id: "side-demo-m2", role: "assistant", text: "只会读取 git 状态，不写文件。", at: PI_UI_DEMO_NOW - 29_000 },
      { id: "side-demo-m3", role: "user", text: "那 diff 里的 +12 −1 是哪来的？", at: PI_UI_DEMO_NOW - 28_000 },
    ],
  },
  {
    id: "side-demo-thread-2",
    title: "为什么选这个方案",
    updatedAt: PI_UI_DEMO_NOW - 5 * M,
    messages: [
      { id: "side-demo-m4", role: "user", text: "为什么窗格用 mock provider 而不是真协议？", at: PI_UI_DEMO_NOW - 5 * M },
      { id: "side-demo-m5", role: "assistant", text: "Pi 暂无多窗格协议；provider 让 UI 先完整可演示，接入扩展后即真实可用。", at: PI_UI_DEMO_NOW - 5 * M + 2_000 },
    ],
  },
]

const subagents: PiUiSubagent[] = [
  { id: "agent-demo-explorer", name: "explorer", role: "代码检索", status: "running", task: "定位设备平台标签的渲染入口", startedAt: PI_UI_DEMO_NOW - 90_000 },
  { id: "agent-demo-verifier", name: "verifier", role: "验证", status: "done", task: "跑独立性守卫 37/37", startedAt: PI_UI_DEMO_NOW - 300_000, finishedAt: PI_UI_DEMO_NOW - 200_000 },
  { id: "agent-demo-reviewer", name: "reviewer", role: "审查", status: "running", task: "核对 diff 行内评论攒批", startedAt: PI_UI_DEMO_NOW - 60_000 },
  { id: "agent-demo-writer", name: "doc-writer", role: "文档", status: "failed", task: "扩展接入文档 示例校验（失败：锚点缺 1 个）", startedAt: PI_UI_DEMO_NOW - 420_000, finishedAt: PI_UI_DEMO_NOW - 360_000 },
]

const orchestration: PiUiSubagentOrchestration = {
  nodes: [
    { agentId: "agent-demo-explorer", label: "explorer", column: 0, status: "running" },
    { agentId: "agent-demo-verifier", label: "verifier", column: 1, status: "done" },
    { agentId: "agent-demo-reviewer", label: "reviewer", column: 1, status: "running" },
  ],
  edges: [
    { from: "agent-demo-explorer", to: "agent-demo-verifier", label: "结果交接" },
    { from: "agent-demo-explorer", to: "agent-demo-reviewer", label: "并行分派" },
  ],
  revision: 1,
}

const forkFeedback: PiUiThreadForkFeedback = {
  fork: {
    available: true,
    branches: [
      { id: "branch-demo-1", label: "从第 3 轮 fork", lastMessageAt: PI_UI_DEMO_NOW - M },
      { id: "branch-demo-2", label: "从第 7 轮 fork", lastMessageAt: PI_UI_DEMO_NOW - 3 * H },
    ],
  },
  feedback: { enabled: true, lastVote: null },
}

/* ------------------------------------------------------------------ 工作流 / 集成 */

const automations: PiUiAutomation[] = [
  { id: "auto-demo-nightly", name: "每晚回归", description: "跑 npm test + 独立性守卫", trigger: "cron 0 2 * * *", enabled: true, lastRunAt: PI_UI_DEMO_NOW - 3 * H, lastResult: "success" },
  { id: "auto-demo-pr", name: "PR 打开时审查", description: "新 PR 自动拉取 diff 并评论", trigger: "event: pr.opened", enabled: true, lastRunAt: PI_UI_DEMO_NOW - 26 * H, lastResult: "failed" },
  { id: "auto-demo-manual", name: "手动截图矩阵", trigger: "manual", enabled: false, lastResult: "never" },
]

const pullRequests: PiUiPullRequest[] = [
  { id: "pr-demo-42", number: 42, title: "P4 能力契约层（40 ID）", repo: "pi-remote", author: "ui-arch", state: "open", reviewState: "pending", updatedAt: PI_UI_DEMO_NOW - 10 * M, url: "https://example.com/p4/pr/42" },
  { id: "pr-demo-43", number: 43, title: "mock providers + 双态截图", repo: "pi-remote", author: "mock-engineer", state: "draft", reviewState: "commented", updatedAt: PI_UI_DEMO_NOW - H, url: "https://example.com/p4/pr/43" },
  { id: "pr-demo-41", number: 41, title: "Claude v2.1 深色补偿", repo: "pi-remote", author: "claude-dev", state: "merged", reviewState: "approved", updatedAt: PI_UI_DEMO_NOW - 30 * H },
  { id: "pr-demo-40", number: 40, title: "CSS scope reset（已关闭）", repo: "pi-remote", author: "web-c-dev", state: "closed", reviewState: "approved", updatedAt: PI_UI_DEMO_NOW - 48 * H },
  { id: "pr-demo-39", number: 39, title: "旧版视觉修正（已归档）", repo: "pi-remote", author: "device-scout", state: "archived", reviewState: "commented", updatedAt: PI_UI_DEMO_NOW - 72 * H },
]

const gitStates: PiUiGitState[] = [
  { repoPath: "~/code/pi-remote", branch: "pi-ui-mock", staged: ["ui/src/pi/extensions/mock/fixtures.ts"], unstaged: ["ui/src/pi/extensions/mock/store.ts", "test/pi-ui-mock.test.mjs"], canCommit: true },
]

const gitStages: PiUiGitStageState[] = [
  { repoPath: "~/code/pi-remote", staged: ["扩展接入文档.md"], unstaged: ["ui/src/pi/extensions/types.ts", "ui/src/pi/extensions/mock/store.ts"], canStage: true, canRevert: true },
]

const worktrees: PiUiWorktree[] = [
  { id: "wt-demo-1", path: "~/code/pi-remote-wt/wave2", branch: "feat/wave2", repoPath: "~/code/pi-remote", status: "dirty" },
  { id: "wt-demo-2", path: "~/code/pi-remote-wt/docs", branch: "docs/doc74", repoPath: "~/code/pi-remote", status: "clean" },
]

const plugins: PiUiPlugin[] = [
  { id: "plugin-demo-lint", name: "eslint 面板", version: "1.2.0", description: "在右栏显示 lint 结果", installed: true, enabled: true },
  { id: "plugin-demo-docs", name: "docs viewer", version: "0.4.1", description: "DOC/ 目录浏览与锚点跳转", installed: false, enabled: false },
  { id: "plugin-demo-theme", name: "theme studio", version: "2.0.0", description: "自定义表面色 / 强调色", installed: true, enabled: false },
]

const connectors: PiUiConnector[] = [
  { id: "connector-demo-github", name: "GitHub", kind: "git", status: "connected", account: "pi-remote", lastSyncAt: PI_UI_DEMO_NOW - 2 * M },
  { id: "connector-demo-slack", name: "Slack", kind: "chat", status: "disconnected" },
  { id: "connector-demo-notes", name: "Notes", kind: "docs", status: "error", account: "workspace-1" },
]

const workspaceConnectorCards: PiUiWorkspaceConnectorCard[] = [
  { id: "conn-demo-github", name: "GitHub", status: "connected", detail: "pi-remote" },
  { id: "conn-demo-slack", name: "Slack", status: "disconnected", detail: "未授权" },
  { id: "conn-demo-notes", name: "Notes", status: "error", detail: "令牌过期，重新连接" },
]

const skills: PiUiSkill[] = [
  { id: "skill-demo-review", name: "代码审查", description: "按仓库规范审查改动", source: "user", enabled: true },
  { id: "skill-demo-doc", name: "写文档", description: "按 DOC 编号生成骨架", source: "user", enabled: false },
  { id: "skill-demo-verify", name: "验收截图", description: "双态驱动 + 截图矩阵", source: "project", enabled: true },
  { id: "skill-demo-release", name: "发布检查", description: "lint/build/test/sync 门禁", source: "project", enabled: true },
]

const permissionTiers: PiUiPermissionTier[] = [
  { id: "tier-demo-manual", label: "手动", description: "逐个查看 diff 后批准", allows: ["读文件", "看 diff", "逐次批准"] },
  { id: "tier-demo-accept-edits", label: "接受编辑", description: "文件改动自动通过，命令仍确认", allows: ["读文件", "写文件", "命令需确认"] },
  { id: "tier-demo-plan", label: "计划", description: "只读探索，先给方案", allows: ["只读", "生成计划"] },
  { id: "tier-demo-auto", label: "自动", description: "后台分类器先审动作与请求是否对齐", allows: ["读文件", "写文件", "运行测试", "危险命令仍确认"] },
  { id: "tier-demo-bypass", label: "完全放行", description: "基本不询问（需设置显式开启）", allows: ["任意命令", "安装依赖", "改配置"] },
]

const suggestions: PiUiSuggestion[] = [
  { id: "sug-demo-1", text: "继续补齐 Wave2 窗格工作台", kind: "followup", command: "/goal wave2" },
  { id: "sug-demo-2", text: "跑一次双态截图矩阵", kind: "action", command: "/shots" },
  { id: "sug-demo-3", text: "把这段 diff 行内评论攒批提交", kind: "refine", command: "/review" },
  { id: "sug-demo-4", text: "用 Artifacts 面板预览验收报告", kind: "action", command: "/artifacts" },
  { id: "sug-demo-5", text: "解释一下 providerBacked 与 contract-only 的区别", kind: "reply" },
  { id: "sug-demo-6", text: "把 session rail 的 Context 卡展开按类别细分", kind: "action", command: "/context" },
]

const reviewThreads: PiUiReviewThread[] = [
  {
    id: "thread-demo-1",
    path: "ui/src/pi/extensions/mock/store.ts",
    line: 42,
    resolved: false,
    comments: [
      { id: "c-demo-1", body: "这里需要处理 getData 抛错的情况", author: "reviewer", createdAt: PI_UI_DEMO_NOW - 60_000, resolved: false, path: "ui/src/pi/extensions/mock/store.ts", line: 42 },
      { id: "c-demo-2", body: "已加 try/catch 兜底，返回上一份快照", author: "mock-engineer", createdAt: PI_UI_DEMO_NOW - 30_000, resolved: false, path: "ui/src/pi/extensions/mock/store.ts", line: 43 },
    ],
  },
  {
    id: "thread-demo-2",
    path: "ui/src/pi/extensions/mock/provider.ts",
    line: 12,
    resolved: true,
    comments: [{ id: "c-demo-3", body: "contract-only 能力不注入，符合硬规则 2", author: "reviewer", createdAt: PI_UI_DEMO_NOW - 20 * M, resolved: true, path: "ui/src/pi/extensions/mock/provider.ts", line: 12 }],
  },
]

const editableFiles: PiUiEditableFile[] = [
  { path: "ui/src/pi/extensions/mock/store.ts", content: "// P4.2 mock store（演示内容）\nexport const demo = true\n", language: "typescript", dirty: true, updatedAt: PI_UI_DEMO_NOW - 10_000 },
  { path: "扩展接入文档.md", content: "# UI 变体扩展接入（演示摘录）\n\n## cap-artifacts\n\n演示数据 · 非真实\n", language: "markdown", dirty: false, updatedAt: PI_UI_DEMO_NOW - 2 * H },
  { path: "test/pi-ui-mock.test.mjs", content: "// 双态 / provider 门禁演示\n", language: "javascript", dirty: false, updatedAt: PI_UI_DEMO_NOW - 3 * H },
]

const bareTabs: PiUiBareTab[] = [
  { id: "tab-demo-1", title: "pi-remote · pi-ui-mock", kind: "session" },
  { id: "tab-demo-2", title: "billing-service", kind: "session" },
  { id: "tab-demo-3", title: "扩展接入文档 预览", kind: "doc" },
]

const themeCustomization: PiUiThemeCustomization = { accent: "#d97757", surface: "#f9f9f7", fontFamily: "Newsreader", importedFrom: "design-spec §1" }

const pinned: PiUiPinnedSession[] = [
  { sessionId: "r-s1", pinnedAt: PI_UI_DEMO_NOW - H },
  { sessionId: "r-s3", pinnedAt: PI_UI_DEMO_NOW - 26 * H },
]

const interactiveTerminal: PiUiInteractiveTerminal = {
  terminalId: "term-demo-1",
  running: true,
  cwd: "~/code/pi-remote",
  recentLines: ["$ npm test", "ℹ tests 1453", "ℹ pass 1448", "ℹ fail 0"],
}

const dictationState: PiUiDictationState = { supported: true, listening: false, language: "zh-CN" }

const deviceCodeLogin: PiUiDeviceCodeLogin = { code: "PI-42-REMOTE", expiresAt: PI_UI_DEMO_NOW + 5 * M, verificationUrl: "https://example.com/device" }

const railEntries: PiUiSessionRailEntry[] = [
  { id: "rail-demo-context", label: "Context", badge: "30.9%", order: 0, actionId: "context" },
  { id: "rail-demo-artifacts", label: "产出", badge: "3", order: 1, actionId: "artifacts" },
  { id: "rail-demo-changes", label: "变更", badge: "+32 −9", order: 2, actionId: "changes" },
  { id: "rail-demo-servers", label: "服务器", badge: "1", order: 3, actionId: "servers" },
  { id: "rail-demo-background", label: "后台任务", badge: "2", order: 4, actionId: "background" },
]

const notificationRules: PiUiNotificationRule[] = [
  { id: "rule-demo-done", label: "回合结束", enabled: true, channel: "system", trigger: "turn.completed" },
  { id: "rule-demo-waiting", label: "等你回答", enabled: true, channel: "badge", trigger: "attention.waiting" },
  { id: "rule-demo-error", label: "出错", enabled: true, channel: "sound", trigger: "turn.error" },
  { id: "rule-demo-automation", label: "Automation 结果", enabled: false, channel: "none", trigger: "automation.result" },
]

const terminals: PiUiTerminalDescriptor[] = [
  { id: "term-demo-1", title: "zsh", status: "running", cwd: "~/code/pi-remote" },
  { id: "term-demo-2", title: "npm test", status: "exited", exitCode: 0 },
  { id: "term-demo-3", title: "vite dev", status: "exited", exitCode: 1 },
]

/* ------------------------------------------------------------------ builtin（contract-only）演示数据 */

const platformTabs: PiUiPlatformTabDescriptor[] = [
  { id: "all", label: "全部", deviceCount: 3 },
  { id: "macos", label: "macOS", deviceCount: 2, lastDeviceId: "d-mbp" },
  { id: "windows", label: "Windows", deviceCount: 1, lastDeviceId: "d-win" },
  { id: "linux", label: "Linux", deviceCount: 0 },
]

const workspaceModes: PiUiWorkspaceMode[] = [
  { id: "chat", label: "会话", description: "现有会话流" },
  { id: "tasks", label: "任务", description: "文件夹任务 + Progress 卡" },
  { id: "workspace", label: "工作台", description: "窗格工作台 + session rail" },
]

const densityModes: PiUiDensityMode[] = [
  { id: "density-demo-normal", label: "舒适", rowHeight: 44, fontSize: 15 },
  { id: "density-demo-thinking", label: "思考", rowHeight: 36, fontSize: 14 },
  { id: "density-demo-verbose", label: "详细", rowHeight: 30, fontSize: 13 },
]

const backgroundTasks: PiUiBackgroundTask[] = [
  { id: "task-demo-1", title: "全量测试", status: "running", progress: 0.62, startedAt: PI_UI_DEMO_NOW - 4 * M },
  { id: "task-demo-2", title: "截图矩阵", status: "done", progress: 1, startedAt: PI_UI_DEMO_NOW - 15 * M, finishedAt: PI_UI_DEMO_NOW - 10 * M },
  { id: "task-demo-3", title: "生产排除检查", status: "failed", progress: 0.3, startedAt: PI_UI_DEMO_NOW - 30 * M, finishedAt: PI_UI_DEMO_NOW - 28 * M, detail: "命中 sentinel（模拟失败）" },
]

const mcpServers: PiUiMcpServer[] = [
  { id: "mcp-demo-filesystem", name: "filesystem", status: "connected", toolCount: 3 },
  { id: "mcp-demo-github", name: "github", status: "error", toolCount: 2 },
]

const mcpTools: PiUiMcpTool[] = [
  { id: "mcp-demo-fs-read", serverId: "mcp-demo-filesystem", name: "read_file", description: "读取文件", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { id: "mcp-demo-fs-list", serverId: "mcp-demo-filesystem", name: "list_dir", description: "列目录", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { id: "mcp-demo-fs-search", serverId: "mcp-demo-filesystem", name: "search", description: "搜索文件内容", inputSchema: { type: "object", properties: { pattern: { type: "string" } } } },
  { id: "mcp-demo-gh-pr", serverId: "mcp-demo-github", name: "get_pr", description: "读取 PR", inputSchema: { type: "object", properties: { number: { type: "number" } } } },
]

const contextUsage: PiUiContextUsage = { tokensUsed: 61_800, contextWindow: 200_000, percent: 30.9, detail: "缓存命中 87%" }

const modelOptions: PiUiModelOption[] = [
  { id: "model-demo-opus", provider: "anthropic", modelId: "claude-opus-4", label: "Opus 4", current: true, contextWindow: 200_000 },
  { id: "model-demo-sonnet", provider: "anthropic", modelId: "claude-sonnet-4", label: "Sonnet 4", contextWindow: 200_000 },
  { id: "model-demo-haiku", provider: "anthropic", modelId: "claude-haiku-4", label: "Haiku 4", contextWindow: 200_000 },
]

const filePreview: PiUiFilePreview = {
  path: "ui/src/pi/extensions/types.ts",
  kind: "text",
  content: "export const PI_UI_CAPABILITY_IDS = [ /* 40 项 */ ] as const\n",
}

const workModes: PiUiWorkModeOption[] = [
  { id: "work-mode-demo-code", label: "编码", description: "在仓库里改代码" },
  { id: "work-mode-demo-chat", label: "聊天", description: "只对话，不写文件" },
]

/* ------------------------------------------------------------------ 汇总 */

/** 全量 40 项能力的初始数据（含 builtin 的演示快照） */
export const PI_UI_DEMO_FIXTURES: { [K in PiUiCapability]?: PiUiCapabilityDataMap[K] } = {
  "device-platform-tabs": { platforms: platformTabs, activeTabId: "all", deviceByPlatform: { macos: "d-mbp", windows: "d-win" } },
  "workspace-modes": { modes: workspaceModes, activeModeId: "chat" },
  "pane-workspace": { panes },
  "pane-dock-drag": { layouts, activeLayoutId: "layout-demo-review" },
  artifacts: { artifacts },
  "browser-pane": { tabs: browserTabs, activeTabId: "tab-demo-docs" },
  "plan-pane": { plan },
  "side-chat": { threads: sideChatThreads },
  "subagents-panel": { agents: subagents },
  automations: { automations },
  "pr-review": { pullRequests },
  "git-commit": { repos: gitStates },
  plugins: { plugins },
  connectors: { connectors },
  skills: { skills },
  "permission-tiers": { tiers: permissionTiers, currentTierId: "tier-demo-accept-edits" },
  "density-modes": { modes: densityModes, currentModeId: "density-demo-normal" },
  suggestions: { suggestions },
  "code-review-comments": { threads: reviewThreads },
  "background-tasks": { tasks: backgroundTasks },
  "mcp-tools": { servers: mcpServers, tools: mcpTools },
  "context-usage": { usage: contextUsage },
  "model-menu": { models: modelOptions, currentModelId: "model-demo-opus" },
  "file-editor": { files: editableFiles, activeFileId: "ui/src/pi/extensions/mock/store.ts" },
  "file-preview": { preview: filePreview },
  worktree: { worktrees },
  "multi-tab": { tabs: bareTabs, activeTabId: "tab-demo-1" },
  "theme-custom": { customization: themeCustomization },
  "session-pin": { pinned },
  "terminal-interactive": { terminal: interactiveTerminal },
  dictation: { dictation: dictationState },
  "work-mode": { modes: workModes, activeModeId: "work-mode-demo-code" },
  "workspace-connectors": { connectors: workspaceConnectorCards },
  "device-code-login": { login: deviceCodeLogin },
  "session-rail-extra": { entries: railEntries },
  notifications: { rules: notificationRules },
  "terminal-panes": { terminals },
  "subagent-orchestration": orchestration,
  "git-stage": { states: gitStages },
  "thread-fork-feedback": forkFeedback,
}

/** 31 项 provider-backed（可注入）能力的初始快照；mock provider 只提供这些 */
export const PI_UI_DEMO_PROVIDER_FIXTURES: { [K in PiUiCapability]?: PiUiCapabilityDataMap[K] } = Object.fromEntries(
  PI_UI_CAPABILITY_PROVIDER_IDS.map((capability) => [capability, PI_UI_DEMO_FIXTURES[capability]]),
)

/** 9 项 contract-only（builtin）能力的演示快照：**只给画廊确定性截图用，不注入 provider**（硬规则 2） */
export const PI_UI_DEMO_CONTRACT_FIXTURES: { [K in PiUiCapability]?: PiUiCapabilityDataMap[K] } = Object.fromEntries(
  PI_UI_CAPABILITY_CONTRACT_IDS.map((capability) => [capability, PI_UI_DEMO_FIXTURES[capability]]),
)

/** 取某项能力的 mock 数据（没有 = undefined） */
export function piUiMockFixtureOf<K extends PiUiCapability>(capability: K): PiUiCapabilityDataMap[K] | undefined {
  return PI_UI_DEMO_FIXTURES[capability]
}

/** 全部 fixture 的深拷贝（store 初始化用；避免 action 改到模块常量） */
export function piUiDemoFixtureClone(): { [K in PiUiCapability]?: PiUiCapabilityDataMap[K] } {
  return JSON.parse(JSON.stringify(PI_UI_DEMO_FIXTURES)) as { [K in PiUiCapability]?: PiUiCapabilityDataMap[K] }
}
