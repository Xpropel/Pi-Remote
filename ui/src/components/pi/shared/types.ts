/**
 * Pi-Remote 的数据类型：照仓库 ui/src 的类型抄写（不 import ui/ 的旧模块），字段名、可选性保持一致。
 * 来源：
 * - relay/devices.ts：Device、RoomInfo、ListedSession
 * - relay/presence.ts：LinkView
 * - relay/attention.ts：AttentionKind、AttentionItem
 * - relay/useRelay.ts：UsageState
 * - relay/transcript.ts：ImagePart、ToolState、ToolOutcome、ToolTaskEntry、ToolDetailEntry、Block、Usage、SendStatus、UserItem、Item
 * - relay/remoteQueue.ts：RemoteQueueItem、RemoteQueueState
 * - chat/capsules/terminalModel.ts：TerminalItem
 * - chat/composer/PromptWaiting.tsx：DialogCard
 * - chat/composer/TaskListCard.tsx：TaskListItem
 * - chat/composerTools.ts：ModelMeta
 * 末尾是 Pi 设计稿自己的呈现层类型（PiSessionGroup、PiSessionRowData、PiLinkSummary、PiDensity…）。
 * transcript 一节另有几个"展示用"可选字段和 receipt 条目（标了来源）。P3.2：b 区原来的 b/types.ts 并进来了（PiTerminalState、
 * PiEditRecord、PiSubagent、PiFileResult 在末尾），b 一律从这里引。
 */

/* ---------------- relay/devices.ts ---------------- */

export type PiRoom = {
  id: string
  label: string | null
  /** 会话自定义名（session_info.name），没有就是 null */
  name?: string | null
  /** 会话首条用户消息，pi 未命名会话的默认标题 */
  firstMessage?: string | null
  cwd: string | null
  online: boolean
  busy: boolean
  viewers: number
  /** 房间最近活动时间（relay 内存态）；旧 relay 不下发时为 0 */
  lastActivity: number
  accountId?: string
  deviceId?: string
}

export type PiDevice = {
  id: string
  accountId: string
  name: string
  platform: string
  online: boolean
  projects: string[]
  lastAttachAt: number | null
  /** 首次登记时间；老 relay 没有时为 null */
  firstSeenAt: number | null
  /** 连接窗口到期时间（窗口在线时下发；离线或旧 relay 为 null） */
  windowExpiresAt: number | null
  /** 当前在线连接的鉴权方式：token = 设备令牌，legacy = 旧的共享 localToken；离线或旧 relay 为 null */
  auth: "token" | "legacy" | null
  /** 有没有有效的设备令牌（配过对且没被撤销） */
  paired: boolean
}

export type PiListedSession = {
  id: string
  title: string
  firstMessage?: string
  path?: string
  cwd: string
  online: boolean
  busy: boolean
  viewers: number
  messageCount: number
  updatedAt: number
  /** 设备已连接且这是活动会话时才能订阅打开正文 */
  openable: boolean
  /** fork 谱系："源自 <父会话当前名>"；非 fork 行不带 */
  parentLabel?: string
}

/* ---------------- relay/presence.ts ---------------- */

/** ok = 已连上；first = 第一次连接中；waiting = 断了、等下一次重连；reconnecting = 断了、正在重连 */
export type PiLinkView =
  | { kind: "ok" }
  | { kind: "first" }
  | { kind: "waiting"; seconds: number; first: boolean }
  | { kind: "reconnecting" }

/* ---------------- relay/attention.ts ---------------- */

export type PiAttentionKind = "waiting" | "error" | "done" | "device-offline"

export type PiAttentionItem = {
  /** 稳定键：dialog:<id> / prompt:<roomId> / turn:<roomId>:<seq> / device:<id> */
  key: string
  kind: PiAttentionKind
  /** 点击跳转的目标房间；没有房间归属时为 "" */
  roomId: string
  deviceId: string | null
  dialogId: string | null
  /** 一行标题：会话名或设备名 */
  title: string
  /** 一行说明：等什么 / 出了什么事 */
  detail: string
  /** 信号时刻；设备条目恒 0 */
  at: number
  /** P9 A：这条 waiting 这个网页能不能直接答；false = 只能在电脑上答，缺失 = 旧 relay / 无信息 */
  answerable?: boolean
}

/* ---------------- relay/useRelay.ts ---------------- */

export interface PiUsageState {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
  cost?: number
  usageByKind?: Record<
    string,
    {
      count?: number
      tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
      cost?: number
    }
  >
  costByModel?: Record<string, number>
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null } | null
}

/* ---------------- relay/transcript.ts ---------------- */

/** 图片可寻址位置（get_image 的 {entryId, blockIndex}） */
export type PiImageAddress = { entryId: string; blockIndex: number }

export type PiImagePart = {
  data: string
  mimeType: string
  omitted?: boolean
  bytes?: number
  /** 展示用：缩略图宽高比（宽 / 高）。真实数据从图片本身读，mock 里直接给 */
  aspect?: number
} & Partial<PiImageAddress>

export type PiToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  | "queued"
  | "waiting_approval"
  | "denied"
  | "cancelled"

export type PiToolTaskEntry = { id: string; content: string; status: "pending" | "in_progress" | "completed" }
export type PiToolDetailEntry = { key: string; value: string }
export type PiToolOutcome = "denied" | "timeout"

/**
 * 展示用（照 b/types.ts）：replica 里不解析 Markdown，text 块的 `prose` 写成节点（design §3.4）；产品里由 react-markdown 渲染成同样的部件。
 * 行内：字符串、{ code }（CodeChip）、{ file }（蓝色 FileChip，点开文件 pane）、{ link }（InlineLink）、{ b }（加粗）。
 */
export type PiInline = string | { code: string } | { file: string; label?: string } | { link: string } | { b: string }

export type PiProseNode =
  | { p: PiInline[] }
  /** 小标题（14/600，"改动""测试"这一档） */
  | { h: PiInline[] }
  | { ul: PiInline[][] }
  | { ol: PiInline[][] }
  | { task: { done: boolean; text: PiInline[] }[] }
  /** 表格：每格一个行内节点 */
  | { table: { head: string[]; rows: PiInline[][] } }
  /** 围栏代码块；lang = 围栏语言名（kit 6 种走 kit 分词器，其余走 shiki，P4.4）；"plain" / 不给 = 不高亮（P5.4 放宽成 string） */
  | { code: string; lang?: string }
  | { quote: PiInline[] }

export type PiToolBlock = {
  kind: "tool"
  id: string
  name: string
  argsText: string
  input?: Record<string, unknown>
  outputText: string
  images?: PiImagePart[]
  state: PiToolState
  errorText?: string
  exitCode?: number
  stderr?: string
  tasks?: PiToolTaskEntry[]
  detailEntries?: PiToolDetailEntry[]
  outcome?: PiToolOutcome
  /** 工具结果的 details：edit 的 `details.patch`（unified diff）协议里就有，旧投影没进 DiffView（K10）；write 没有 patch */
  details?: { patch?: string }
}

export type PiBlock =
  | {
      kind: "text"
      text: string
      /** 展示用：正文节点（见 PiProseNode） */
      prose?: PiProseNode[]
    }
  | {
      kind: "thinking"
      text: string
      /** 界面层实时观测到的思考起止差（§1.9）；快照恢复的历史没有，就写"已思考" */
      observedMs?: number
    }
  | PiToolBlock

export type PiUsage = { totalTokens?: number; cost?: { total?: number } }

/** 乐观气泡的投递进度：发送中 → 已回显 → 已送达。失败看 failed */
export type PiSendStatus = "sending" | "echoed" | "delivered"

export type PiUserItem = {
  kind: "user"
  key: string
  text: string
  images: PiImagePart[]
  timestamp?: number
  echo?: string
  remote?: boolean
  failed?: string
  from?: "local" | "remote"
  cid?: string
  status?: PiSendStatus
  /** 展示用：离线时进了本页 outbox（§1.12），卡下灰字"等重连后发送" */
  outbox?: boolean
}

export type PiAssistantItem = {
  kind: "assistant"
  key: string
  blocks: PiBlock[]
  model?: string
  usage?: PiUsage
  stopReason?: string
  errorMessage?: string
  live?: boolean
  startedAt?: number
  endedAt?: number
  durationMs?: number
  timestamp?: number
}

export type PiItem =
  | PiUserItem
  | PiAssistantItem
  | {
      kind: "summary"
      key: string
      title: string
      text: string
      timestamp?: number
      /** 展示用：压缩前后的上下文 token（"已压缩上下文 · 132k → 18k"）；来源未核对 */
      tokensBefore?: number
      tokensAfter?: number
    }
  | { kind: "bash"; key: string; command: string; output: string; label: string; timestamp?: number }
  | { kind: "custom"; key: string; label: string; text: string; timestamp?: number }
  /**
   * 展示用（照 b/types.ts）：流内状态收据，不是协议条目，是界面层事件的落点（压缩中、自动重试、拒绝回执等）。
   * tone=error 时红字；spinner=true 时行首小 Spinner。
   */
  | { kind: "receipt"; key: string; text: string; tone?: "muted" | "error"; spinner?: boolean; action?: string; timestamp?: number }

/* ---------------- relay/remoteQueue.ts ---------------- */

export type PiRemoteQueueSegment = "steer" | "follow_up"
export type PiRemoteQueueStatus = "pending" | "injected" | "failed"
export type PiRemoteQueueImage = { mimeType: string; bytes: number }
export type PiRemoteQueueItem = {
  id: string
  segment: PiRemoteQueueSegment
  source: string
  text: string
  truncated?: boolean
  textLen?: number
  textHash?: string
  images: PiRemoteQueueImage[]
  status: PiRemoteQueueStatus
  at: number
  cid?: string
  updatedAt?: number
  injectedAt?: number
  error?: string
  code?: string
}
export type PiRemoteQueueState = { rev: number; items: PiRemoteQueueItem[] }

/* ---------------- chat/capsules/terminalModel.ts ---------------- */

export type PiTerminalEntryState = "running" | "succeeded" | "failed" | "timed_out" | "aborted"
export type PiTerminalItem = {
  id: string
  toolName: string
  command: string
  startedAt: number | null
  endedAt: number | null
  durationMs: number | null
  state: PiTerminalEntryState
  exitCode?: number
  /** 输出尾巴（ANSI 已剥离、最多 200 行） */
  output: string
  outputTruncated: boolean
  stderr?: string
  inferredEnd: boolean
  metaEnded?: boolean
}

/* ---------------- chat/composer/PromptWaiting.tsx ---------------- */

export type PiDialogCard = {
  dialogId: string
  /** select / confirm / input / editor */
  kind: string
  title?: string
  options?: string[]
  optionsTotal?: number
  message?: string
  placeholder?: string
  prefill?: string
  /** 宿主给的超时（毫秒） */
  timeout?: number
  /** 扩展捕获时刻 */
  startedAt: number
  /** 网页端可直接应答；undefined = 只读观察 */
  answerable?: boolean
}

/* ---------------- chat/composer/TaskListCard.tsx ---------------- */

export type PiTaskStatus = "pending" | "in_progress" | "completed"
export type PiTaskListItem = { id: string; content: string; status: PiTaskStatus; activeForm?: string }

/* ---------------- chat/composerTools.ts ---------------- */

export type PiModelMeta = { provider?: string; modelId?: string; name?: string }

/* ================= Pi 设计稿的呈现层类型 ================= */

/** 工具显示密度：精简 / 平衡（默认）/ 详细 */
export type PiDensity = "compact" | "balanced" | "detailed"

/** 会话行行首标记（design §6.3 PiRowMarker） */
export type PiRowMarkerKind = "waiting" | "error" | "unread" | "running" | "idle" | "unloaded"

/** 一行会话（列表、需要处理组、搜索结果共用） */
export interface PiSessionRowData {
  /** 房间 / 会话 id */
  id: string
  title: string
  marker: PiRowMarkerKind
  /** 行尾相对时间（piRelativeTime 算好的："刚刚" / "5m" / "1d"）；没有就不显示 */
  time?: string
  /**
   * 同一时间的全称（piAgo 算好的："刚刚" / "38 分钟前" / "10 月 21 日"），只给读屏：写进行的 aria-label
   * （design §4.7、v1.3 §12.3-3：行名 = 标题，标记 label，时间全称；读屏不读"38m"）。没有就不读时间
   */
  timeLabel?: string
  deviceId?: string
  /** 设备离线：行变淡 */
  dimmed?: boolean
  /** 第二行灰字（搜索片段、说明）；手机行有第二行时行高 64 */
  subtitle?: string
  /** 行尾灰字，替换 time（搜索结果的 "命中 2 条"、"等你回答"） */
  trailingText?: string
  /** 行尾文字的语气（P9 A）：attention = 用 --cw-pi-attention 上色 */
  trailingTone?: "attention"
  /** 行首换成设备图标（需要处理组里的"设备未连接"条目），值 = Device.platform */
  platform?: string
  /** 标题里要加粗的片段（搜索命中） */
  highlight?: string
}

/** 一个（设备, 目录）分组 */
export interface PiSessionGroup {
  key: string
  /** 组头："MacBook Pro/pi-remote"；只有一台设备或筛选到一台时只写目录名 */
  label: string
  deviceId: string
  cwd: string
  /** 设备未连接：整组变淡，组头末尾灰字"未连接" */
  offline?: boolean
  rows: PiSessionRowData[]
  /** 折叠掉的行数（"… 更多 7"） */
  more?: number
  /** 这个目录没有会话：渲染成文件夹行（点它新建） */
  folderOnly?: boolean
  /** v1.2（M-08）："更多 N"已就地展开：rows 是本组全部行，末行换成"收起" */
  expanded?: boolean
  /** v1.2（D-07）：不分组模式的平铺列表（没有组头、不折叠，行带 subtitle"设备/目录"） */
  flat?: boolean
}

/** 带所在设备的会话（侧栏跨设备合并后的一行数据；adapters.ts 的输入，产品里由 mergeDeviceSessions 带上 deviceId） */
export type PiDeviceSession = PiListedSession & { deviceId: string }
/** 列表分组方式（v1.2，D-07）：device = 按设备与目录（默认）；flat = 不分组（按最近活动） */
export type PiGrouping = "device" | "flat"

/** 账户区 / 列表状态的连接摘要 */
export interface PiLinkSummary {
  /** 连接口径（PiLinkView 的 kind） */
  kind: PiLinkView["kind"]
  /** 账户区第二行："已连接 · 2 台设备在线" / "与服务器断开" / "正在连接…" */
  text: string
}
/* ---------------- b 区（原 b/types.ts，P3.2 并入） ---------------- */
/** 终端条目状态（原 b/types.ts 的名字，同 PiTerminalEntryState） */
export type PiTerminalState = PiTerminalEntryState
/** 一次 edit / write 记录（从会话里的工具块汇总，不是 git 状态） */
export type PiEditRecord = {
  toolCallId: string
  tool: "edit" | "write"
  path: string
  patch: string
  /** 编辑失败（工具 output-error）：行尾红字"未生效" */
  failed?: boolean
}
/** 子智能体上报（agent_state；只有真的上报才出现） */
export type PiSubagent = { name: string; task: string; startedAt: number }
/** 文件内容（get_file 的结果） */
export type PiFileResult = {
  path: string
  size: number
  mime: string
  encoding: "utf-8" | "base64"
  truncated: boolean
  text: string
}
