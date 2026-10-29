/**
 * c 区画廊 mock（design §3.5；P3.3 从 components/pi/composer/mock.ts 搬来，只给 pi/dev 用；类型在 components/pi/composer/types.ts，文案和选项在 c/options.ts）：草稿、待发图片、斜杠命令表、@ 候选池、模型表、排队、偏好、命令面板、用量统计。
 * 字段形状照 ui/src 的类型抄写（经 shared/types.ts），值是假的但自洽：截图里出现的每个时间、计数都能从这里或 shared/mock.ts 算出来。
 * 时间一律按 C_NOW 算（= shared/mock.ts 的 MOCK_NOW，2026-10-24 10:42 +08:00）。
 */
import { piBaseName } from "@/components/pi/shared/format"
import type { PiRemoteQueueState } from "@/components/pi/shared/types"
import type { CHostMessage, CImage, CModel, CPrefs, PaletteCommand, PaletteSession, SlashGroup, SlashRow } from "@/components/pi/composer/types"
import { MOCK_NOW, mockDevice, mockSession, piSessionRow } from "./shared"

export const C_NOW = MOCK_NOW
const S = 1000
const M = 60 * S

/* ---------------- composer：草稿与附件 ---------------- */

/** composer-keyboard 的草稿（S1）：两行文字 + 1 个 @ 引用 + 1 张图 */
export const C_DRAFT = "横屏的时候也测一下，键盘弹出时\n输入框要一直贴着键盘"
export const C_DRAFT_MENTIONS = ["ui/src/mobile/useMobileViewport.ts"]
export const C_DRAFT_IMAGES: CImage[] = [{ mimeType: "image/jpeg", bytes: 96 * 1024 }]

/** 当前会话 r-s1 的模型与思考级别（shared MOCK_MODEL + thinkingLevel "medium"） */
export const C_MODEL_LABEL = { name: "Sonnet 4.5", thinking: "medium" }

/* ---------------- 斜杠命令（E09，以 ui/src/chat/slash.tsx 的 COMMANDS 为准） ---------------- */

/** slash.tsx COMMANDS 的 19 条内置命令，顺序与说明照抄（/commands 的说明随 G01 改名为"命令面板"，推断） */
export const SLASH_BUILTINS: SlashRow[] = [
  { key: "model", name: "/model", desc: "切换模型" },
  { key: "thinking", name: "/thinking", desc: "切换思考级别" },
  { key: "name", name: "/name", desc: "修改会话名，后面写上新名字" },
  { key: "compact", name: "/compact", desc: "压缩上下文" },
  { key: "regenerate", name: "/regenerate", desc: "重新回答上一条" },
  { key: "session", name: "/session", desc: "查看当前会话" },
  { key: "copy", name: "/copy", desc: "复制上一条回答" },
  { key: "settings", name: "/settings", desc: "查看设置项名称" },
  { key: "system", name: "/system", desc: "查看当前系统提示词" },
  { key: "follow", name: "/follow", desc: "等这轮结束后再发后面的文字" },
  { key: "new", name: "/new", desc: "新建会话" },
  { key: "resume", name: "/resume", desc: "切换到另一个会话" },
  { key: "fork", name: "/fork", desc: "从一条用户消息分叉" },
  { key: "clone", name: "/clone", desc: "把当前分支复制成新会话" },
  { key: "tree", name: "/tree", desc: "跳到会话树的某个节点" },
  { key: "stats", name: "/stats", desc: "消息数、token 和费用" },
  { key: "usage", name: "/usage", desc: "上下文占用" },
  { key: "tools", name: "/tools", desc: "管理启用的工具" },
  { key: "commands", name: "/commands", desc: "打开命令面板" },
]

/** get_commands 的资源命令（MacBook Pro 上的 pi）：desc = [执行, 来源, 说明].join(" · ")（slash.tsx resourceRow） */
export const SLASH_RESOURCES: SlashRow[] = [
  { key: "resource:review-pr", name: "/review-pr", desc: "执行 · 模板 · 按团队清单审一遍改动" },
  { key: "resource:release-notes", name: "/release-notes", desc: "执行 · 技能 · 从提交记录整理发布说明" },
]

/** slashUsage 计数（count 降序，同数按最近）：常用组按它取行 */
export const SLASH_USAGE_ORDER = ["compact", "model", "fork"]

/** 空查询浏览分组（slashParse.ts groupSlashBrowse 的口径；组名按 design：常用 / 内置 / 本机资源） */
export function slashBrowseGroups(): SlashGroup[] {
  const frequent = SLASH_USAGE_ORDER.map((k) => SLASH_BUILTINS.find((r) => r.key === k)).filter(
    (r): r is SlashRow => !!r,
  )
  const taken = new Set(frequent.map((r) => r.key))
  return [
    { title: "常用", rows: frequent },
    { title: "内置", rows: SLASH_BUILTINS.filter((r) => !taken.has(r.key)) },
    { title: "本机资源", rows: SLASH_RESOURCES },
  ]
}

/* ---------------- @ 引用（E08，ui/src/chat/composer/mention.ts） ---------------- */

/** 候选池：本会话工具入参 + 文件视图读过的文件（最近优先，上限 MENTION_CANDIDATE_MAX = 20） */
export const MENTION_POOL = [
  "ui/src/mobile/useMobileViewport.ts",
  "ui/src/mobile/MobileConversation.tsx",
  "test/mobile.test.mjs",
  "ui/src/mobile/mobile.css",
  "ui/src/shell/shell.css",
  "ui/src/relay/presence.ts",
]

/** mention-menu 屏的输入："看一下 @mob"，已选引用 shell.css */
export const MENTION_QUERY = "mob"
export const MENTION_TEXT_BEFORE = "看一下 "
export const MENTION_SELECTED = ["ui/src/shell/shell.css"]

/* ---------------- 模型与思考级别（E10 E11 G02） ---------------- */

export const C_MODELS: CModel[] = [
  { key: "anthropic/claude-sonnet-4-5", provider: "anthropic", modelId: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", spec: "200k · 可发图片", current: true },
  { key: "anthropic/claude-opus-4-1", provider: "anthropic", modelId: "claude-opus-4-1", name: "Claude Opus 4.1", spec: "200k · 可发图片" },
  { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5", name: "GPT-5", spec: "400k · 可发图片" },
  { key: "google/gemini-2.5-pro", provider: "google", modelId: "gemini-2.5-pro", name: "Gemini 2.5 Pro", spec: "1M · 可发图片", costNote: "输入超过 200k 时单价翻倍" },
  { key: "deepseek/deepseek-v3.1", provider: "deepseek", modelId: "deepseek-v3.1", name: "DeepSeek V3.1", spec: "128k" },
  { key: "qwen/qwen3-coder", provider: "qwen", modelId: "qwen3-coder", name: "Qwen3 Coder", spec: "262k", unconfigured: true },
]

/** 悬停 Gemini 时的说明卡（ch4/ModelExplainer 形状） */
export const GEMINI_EXPLAINER = {
  title: "Gemini 2.5 Pro",
  tagline: ["Google 的长上下文模型"],
  context: "上下文窗口 1M",
  cost: ["输入超过 200k tokens 时", "单价翻倍"],
  version: ["google/gemini-2.5-pro"],
}

/** get_available_thinking_levels 的结果（当前 medium） */
export const THINKING_LEVELS = [
  { value: "off", label: "关" },
  { value: "minimal", label: "最少" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
]
export const THINKING_CURRENT = "medium"

/* ---------------- 排队（F08 F09） ---------------- */

/**
 * r-s1 运行中的 remote_queue_state：q1 还在等，q2 已插入当前回合。
 * q1 的正文没用 design 写的"顺便把横屏也测一下"：那句与 b 区 CONVO_LIVE 本回合的用户消息（NOW−42s）几乎相同，同时出现不自洽。
 * q2 已插入但流里看不到：data-interface §5.3"忙时 steer 折进当前轮：pi 不发 user 消息事件，queue_update 也不触发"。
 */
export const C_REMOTE_QUEUE: PiRemoteQueueState = {
  rev: 12,
  items: [
    { id: "q1", segment: "follow_up", source: "web", text: "测完把 README 里的键盘说明也补上", images: [], status: "pending", at: C_NOW - 40 * S },
    // design 写 at NOW−55s / injectedAt NOW−10s：NOW−55s 时 pi 还空闲（本回合 NOW−42s 才开始），不会进排队；
    // steer 在工具结束、下一次调模型前注入，b 区 CONVO_LIVE 里那个时刻是 NOW−32s（a-r1-52 开始）。
    { id: "q2", segment: "steer", source: "web", text: "先别动 shell.css", images: [], status: "injected", at: C_NOW - 38 * S, injectedAt: C_NOW - 32 * S },
  ],
}

/** 本机终端的 queue_update（只读）：在终端里排了一条"等这轮结束" */
export const C_HOST_QUEUE: { steering: CHostMessage[]; followUp: CHostMessage[] } = {
  steering: [],
  followUp: [{ role: "user", content: [{ type: "text", text: "跑一下 lint" }], timestamp: C_NOW - 25 * S }],
}

/** tray "排队 N" 的 N = 仍在等待的条目（远程 pending + 本机） */
export function queueWaitingCount(): number {
  return (
    C_REMOTE_QUEUE.items.filter((i) => i.status === "pending").length +
    C_HOST_QUEUE.steering.length +
    C_HOST_QUEUE.followUp.length
  )
}

/* ---------------- 偏好（设置页与显示选项） ---------------- */

export const C_PREFS: CPrefs = {
  ui: "cursor",
  theme: "system",
  fontSize: "standard",
  density: "balanced",
  /** 忙时发送的默认投递（待用户确认 10） */
  busyDelivery: "steer",
  /** 排队消息"立即发送"时 */
  sendNow: "interrupt",
  /** 网页回答电脑上的确认框 */
  dialogRemote: true,
  /** G1：允许智能体用 ask_user 工具提问（默认关） */
  askUser: false,
  /** G2：工具执行审批门（默认关） */
  approvalGate: false,
  /** G2 审批档位（默认只问高危） */
  approvalGateTier: "high-risk",
  /** 完成提示音（默认关） */
  sound: false,
  /** 列表：设备筛选与分组 */
  deviceFilter: "all",
  grouping: "device",
}

/* ---------------- 命令面板（G01 G07 B14） ---------------- */

export const PALETTE_COMMANDS: PaletteCommand[] = [
  { key: "new", label: "新建会话", keys: ["⇧", "⌘", "O"], icon: "new" },
  { key: "sidebar", label: "切换侧栏", keys: ["⌘", "B"], icon: "sidebar" },
  { key: "pane", label: "打开 / 关闭右侧面板", keys: ["⌘", "."], icon: "pane" },
  { key: "compact", label: "压缩上下文", icon: "compact" },
  { key: "regenerate", label: "重新回答", icon: "regenerate" },
  { key: "tree", label: "会话树", icon: "tree" },
  { key: "usage", label: "用量与费用", icon: "usage" },
  { key: "inspect", label: "检视本机信息", icon: "inspect" },
  { key: "settings", label: "设置", keys: ["⌘", ","], icon: "settings" },
]

/**
 * 最近 4 个会话（r-s1…r-s4）：标题与行首标记从 shared mock 算（piSessionRow：r-s1 空闲、r-s2 运行中、r-s3 等你回答、r-s4 完成未读），
 * 组名 = "设备名/目录名"。
 */
export const PALETTE_SESSIONS: PaletteSession[] = ["r-s1", "r-s2", "r-s3", "r-s4"].flatMap((id) => {
  const s = mockSession(id)
  if (!s) return []
  const row = piSessionRow(s)
  const device = mockDevice(s.deviceId)
  return [{ id, title: row.title, marker: row.marker, group: `${device?.name ?? s.deviceId}/${piBaseName(s.cwd)}` }]
})

/* ---------------- 用量（G05 G06） ---------------- */

/**
 * get_session_stats 的计数（r-s1）。字段名照 data-interface §4.11.2：
 * `{ sessionFile, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens, cost, usageByKind, costByModel, contextUsage? }`；
 * token、费用、costByModel、contextUsage 取 shared MOCK_USAGE（同一份 usage_state）。
 * totalMessages 是全部消息（含 toolResult）：8 + 20 + 20 = 48 = shared mock 里 r-s1 的 messageCount。
 * design 写的"你 12 · pi 36 · 工具调用 63"凑不出 48（63 次调用就有 63 条 toolResult），所以改了计数。
 */
export const C_STATS = {
  userMessages: 8,
  assistantMessages: 20,
  toolCalls: 20,
  toolResults: 20,
  totalMessages: 48,
}

/* ---------------- 新建会话（C06 D22） ---------------- */

/** 空会话建议（来源 = 现有空会话建议列表） */
export const NEW_SESSION_SUGGESTIONS = [
  { key: "tests", label: "看看测试为什么失败", primary: true },
  { key: "explain", label: "解释这个目录的结构" },
  { key: "todo", label: "列出代码里的 TODO" },
]

/** 目录选择：最近使用（按会话 updatedAt：pi-remote 2m 前、notes-app 5h 前） */
export const RECENT_FOLDERS = ["/Users/dev/code/pi-remote", "/Users/dev/code/notes-app"]

export const MINUTE = M
