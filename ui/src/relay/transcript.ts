import type { RemoteQueueItem } from "./remoteQueue"
import { toolRenderConfigFor } from "../chat/tools/toolConfigs.ts"

/** 图片可寻址位置：get_image {entryId, blockIndex} 的口径，blockIndex 是条目原始 content 下标。 */
export type ImageAddress = { entryId: string; blockIndex: number }

/** 图片块。omitted = 扩展/relay 因体积过大没有传输原图，只保留 mime 与原始字节数。
 *  投影/历史能真实定位到会话条目时，块上会带 entryId + blockIndex（用于按需补拉原图）；
 *  定位信息不全就不带，UI 也不猜。 */
export type ImagePart = {
  data: string
  mimeType: string
  omitted?: boolean
  bytes?: number
} & Partial<ImageAddress>

/** 桌面发送附图：base64 字符数上限，与扩展/relay 的 128KB 降级阈值相同。超过就不发送。 */
export const SEND_IMAGE_MAX_CHARS = 131072

const SEND_IMAGE_MIME: Record<string, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
}

/** 只接受 png、jpeg、gif、webp。image/jpg 按 jpeg。 */
export function normalizeSendImageMime(type: string): string | null {
  return SEND_IMAGE_MIME[type.toLowerCase()] ?? null
}

export type SendImage = { data: string; mimeType: string }

/** 输入条上的那一张图能不能随 prompt/steer 发出。发不了时 reason 说明原因，图本身仍留在输入条。 */
export function prepareSendImage(image: SendImage | null | undefined): { image: SendImage | null; reason: string } {
  if (!image) return { image: null, reason: "" }
  if (!image.data) return { image: null, reason: "这张图没有内容，没有发送" }
  const mimeType = normalizeSendImageMime(image.mimeType)
  if (!mimeType) return { image: null, reason: "只接受 png、jpeg、gif、webp" }
  if (image.data.length > SEND_IMAGE_MAX_CHARS) {
    return {
      image: null,
      reason: `这张图的 base64 有 ${image.data.length} 个字符，超过 ${SEND_IMAGE_MAX_CHARS}，没有发送`,
    }
  }
  return { image: { data: image.data, mimeType }, reason: "" }
}

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error"
  /** 以下四态由未来数据源提供；只有数据真的出现时才映射，不从缺失字段推断。 */
  | "queued"
  | "waiting_approval"
  | "denied"
  | "cancelled"

/** 工具结果里提升出来的一等展示字段（由 toolConfigs 的 fields 清单驱动提取）。 */
export type ToolTaskEntry = {
  id: string
  content: string
  status: "pending" | "in_progress" | "completed"
}

/** 未被提升的 details 键的通用呈现条目：值已压成短摘要，绝不塞原始大对象。 */
export type ToolDetailEntry = { key: string; value: string }

/**
 * 结果性质推导（只认 pi 自己的样板文本，只在失败结果上做）：
 * denied = 结果文本以 “Tool execution was blocked” 开头（扩展拦截/用户拒绝）；
 * timeout = 文本以 “Command timed out after N seconds” 结尾（与扩展 termStatus 同一原文）。
 * 其余失败一律不贴标签，保持普通 failed。
 */
export type ToolOutcome = "denied" | "timeout"

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool"
      id: string
      name: string
      argsText: string
      input?: Record<string, unknown>
      outputText: string
      images?: ImagePart[]
      state: ToolState
      errorText?: string
      /** 展示字段：只在消息确实带退出码时出现（不猜）。 */
      exitCode?: number
      /** 展示字段：数据层能分流 stderr 时才出现；合并文本不猜、不染。 */
      stderr?: string
      /** 展示字段：配置表声明 tasks 的工具（todo 类）才从 details 提升任务清单。 */
      tasks?: ToolTaskEntry[]
      /** 展示字段：配置表声明 patch 的工具（edit 类）才从 details 提升 unified diff 原文（G5）；超过上限按整行截断。 */
      patch?: string
      /** 展示字段：与 patch 同来源，新文件里第一处改动的行号（pi EditToolDetails.firstChangedLine）。 */
      firstChangedLine?: number
      /** patch 超过 TOOL_PATCH_MAX_CHARS 被截断时才出现；截断后的计数只是下限。 */
      patchTruncated?: true
      /** 展示字段：未被提升的 details 键的通用键值摘要（上限条数，值已截断）。 */
      detailEntries?: ToolDetailEntry[]
      /** 展示字段：结果性质（拒绝/超时），只在样板文本命中时出现。 */
      outcome?: ToolOutcome
    }

/**
 * 工具卡的展示态。数据层可能出现 8 种 state：
 *   input-streaming / input-available / output-available / output-error
 *   queued / waiting_approval / denied / cancelled
 *
 * 前四种是既有数据，映射保持原样（准备中 / 运行中 / 成功 / 失败）。后四种在
 * 协议与事件里目前都还没有来源，UI 只做一一映射，绝不根据缺失字段猜成
 * queued / 审批 / 拒绝 / 取消；没有数据时仍按原来的四态展示。
 *
 * input-streaming 期间参数可能还没到（argsText 为空、input 未定义），这时是
 * “准备中”；一旦拿到参数（toolcall_end 或 tool_execution_start 的 input），
 * 就按“运行中”展示。input-available 是参数已就绪、等待/正在执行。
 */
export type ToolDisplayState =
  | "preparing"
  | "running"
  | "succeeded"
  | "failed"
  | "queued"
  | "waiting_approval"
  | "denied"
  | "cancelled"

export function toolDisplayState(tool: Extract<Block, { kind: "tool" }>): ToolDisplayState {
  // denied 有两个来源：数据层直接给 denied 态（下方 switch），或失败结果的
  // 文本命中 pi 的拦截样板（outcome 推导）。后者只认样板原文，不从缺失字段猜。
  if (tool.outcome === "denied" && tool.state === "output-error") return "denied"
  switch (tool.state) {
    case "output-error":
      return "failed"
    case "output-available":
      return "succeeded"
    case "queued":
      return "queued"
    case "waiting_approval":
      return "waiting_approval"
    case "denied":
      return "denied"
    case "cancelled":
      return "cancelled"
    case "input-available":
      return "running"
    case "input-streaming":
      return tool.input ? "running" : "preparing"
    default:
      // 旧 relay 可能给空 / 未知 state：保持既有降级，不新增猜测分支。
      return tool.input ? "running" : "preparing"
  }
}

/** 思考块是否仍在该消息的“活动尾部”。历史 thinking 不能跟着 live 常亮：
 *  只有它是最后一个有内容的块、且消息本身仍在流式时才算进行中。 */
export function isLiveThinking(blocks: Block[], index: number, live: boolean | undefined): boolean {
  if (!live) return false
  for (let k = index + 1; k < blocks.length; k += 1) {
    const block = blocks[k]
    if (!block) continue
    if (block.kind === "text" && !block.text.trim()) continue
    if (block.kind === "thinking" && !block.text.trim()) continue
    return false
  }
  const current = blocks[index]
  return !!current && current.kind === "thinking" && !!current.text.trim()
}

/** 正文尾部是否是正在流式生成的文本：只有最后一个非空块是 text 时才给光标。 */
export function isLiveText(blocks: Block[], index: number, live: boolean | undefined): boolean {
  if (!live) return false
  for (let k = index + 1; k < blocks.length; k += 1) {
    const block = blocks[k]
    if (!block) continue
    if (block.kind === "text" && !block.text.trim()) continue
    if (block.kind === "thinking" && !block.text.trim()) continue
    return false
  }
  const current = blocks[index]
  return !!current && current.kind === "text" && !!current.text.trim()
}

export type Usage = {
  totalTokens?: number
  cost?: { total?: number }
}

/** 乐观气泡的投递进度（v4 按 cid 对号，DOC/71 §3）：发送中 → 已回显（扩展收到）→ 已送达（进了 pi）。失败看 failed。 */
export type SendStatus = "sending" | "echoed" | "delivered"

export type UserItem = {
  kind: "user"
  key: string
  text: string
  images: ImagePart[]
  /** relay/扩展消息上的毫秒时间戳；没有就留空，TimeDivider 不伪造 */
  timestamp?: number
  echo?: string
  remote?: boolean
  failed?: string
  from?: "local" | "remote"
  cid?: string
  status?: SendStatus
  /** View-layer mark (F4): this bubble is a remote-queue entry still waiting
   *  to be injected; queueId is that entry's id. The reducer never sets
   *  these -- thread views derive them from relay.remoteQueue by cid. */
  queued?: boolean
  queueId?: string
}

export type Item =
  | UserItem
  | {
      kind: "assistant"
      key: string
      blocks: Block[]
      model?: string
      usage?: Usage
      stopReason?: string
      errorMessage?: string
      live?: boolean
      /** 消息开始时间（message.timestamp，pi 记录的是请求开始时刻）。 */
      startedAt?: number
      /** 消息结束时间：只有真实 durationMs 时才由 startedAt + durationMs 得出。 */
      endedAt?: number
      /** pi 的 AssistantMessage.durationMs；历史消息缺失时保持 undefined。 */
      durationMs?: number
      timestamp?: number
    }
  | { kind: "summary"; key: string; title: string; text: string; timestamp?: number }
  | { kind: "bash"; key: string; command: string; output: string; label: string; timestamp?: number }
  | { kind: "custom"; key: string; label: string; text: string; timestamp?: number }

export type ItemGroupRole = "user" | "assistant" | "system"

/** 消息组是间距与 TimeDivider 的单位；组内 item 顺序保持原样。 */
export type ItemGroup = {
  key: string
  role: ItemGroupRole
  items: Item[]
}

/**
 * 同角色连续消息并组。summary 是系统注脚：每条独立成组、不跟随相邻
 * assistant/user；bash/custom 属于工具/自定义输出，跟 assistant 同组。
 */
export function groupItems(items: Item[]): ItemGroup[] {
  const groups: ItemGroup[] = []
  for (const item of items) {
    const role: ItemGroupRole = item.kind === "user" ? "user" : item.kind === "summary" ? "system" : "assistant"
    if (item.kind === "summary") {
      groups.push({ key: `g-${item.key}`, role, items: [item] })
      continue
    }
    const last = groups[groups.length - 1]
    if (last && last.role === role && last.items[last.items.length - 1]?.kind !== "summary") {
      last.items.push(item)
    } else {
      groups.push({ key: `g-${item.key}`, role, items: [item] })
    }
  }
  return groups
}

/** 组内第一条有时间戳的消息；历史缺失时返回 undefined。 */
export function groupStartAt(group: ItemGroup): number | undefined {
  for (const item of group.items) if (typeof item.timestamp === "number" && Number.isFinite(item.timestamp)) return item.timestamp
  return undefined
}

/** 组内最后一条有时间戳的消息；用于跨组 30 分钟/跨日判断。 */
export function groupEndAt(group: ItemGroup): number | undefined {
  for (let k = group.items.length - 1; k >= 0; k -= 1) {
    const item = group.items[k]
    if (typeof item.timestamp === "number" && Number.isFinite(item.timestamp)) return item.timestamp
  }
  return undefined
}

export type DividerKind = "time" | "day" | "resume" | null

export const DIVIDER_GAP_MS = 30 * 60 * 1000

function localDayKey(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}

/**
 * 相邻两组之间要不要插时间分隔条：
 *   - 下一组没有时间戳：不画（P0 不做“伪造的今天”）；
 *   - 上一组没有时间戳（会话第一组/恢复后）：画 resume 型；
 *   - 跨自然日优先 day；同一天间隔 ≥30 分钟才是 time。
 */
export function dividerFor(previous: number | undefined, next: number | undefined): DividerKind {
  if (typeof next !== "number" || !Number.isFinite(next)) return null
  if (typeof previous !== "number" || !Number.isFinite(previous)) return "resume"
  if (previous === next) return null
  if (localDayKey(previous) !== localDayKey(next)) return "day"
  if (next - previous >= DIVIDER_GAP_MS) return "time"
  return null
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 时间分隔条文案：今天 HH:mm / 昨天 HH:mm / 同年 M月d日 HH:mm /
 * 跨年 yyyy年M月d日 HH:mm。只显示时间点，不显示“30 分钟前”。
 */
export function formatDivider(timestamp: number, now = Date.now()): string {
  const date = new Date(timestamp)
  const current = new Date(now)
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  const dayKey = localDayKey(timestamp)
  if (dayKey === localDayKey(now)) return `今天 ${time}`
  const yesterday = new Date(now)
  yesterday.setHours(0, 0, 0, 0)
  yesterday.setDate(yesterday.getDate() - 1)
  if (dayKey === localDayKey(yesterday.getTime())) return `昨天 ${time}`
  if (date.getFullYear() === current.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${time}`
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${time}`
}

export type AgentMessage = {
  role?: string
  content?: unknown
  model?: string
  usage?: Usage
  stopReason?: string
  errorMessage?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  display?: boolean
  summary?: string
  command?: string
  output?: string
  exitCode?: number
  cancelled?: boolean
  customType?: string
  /** 仅 assistant：pi 记录的本次请求耗时；缺失 = 老消息，不补。 */
  durationMs?: number
  [key: string]: unknown
}

type ToolPatch = {
  name?: string
  input?: Record<string, unknown>
  argsText?: string
  outputText?: string
  state?: ToolState
  images?: ImagePart[]
  errorText?: string
  exitCode?: number
  stderr?: string
  tasks?: ToolTaskEntry[]
  patch?: string
  firstChangedLine?: number
  patchTruncated?: true
  detailEntries?: ToolDetailEntry[]
  outcome?: ToolOutcome
}

export type Transcript = {
  items: Item[]
  liveKey: string | null
  seq: number
  bashKey: string | null
  pendingTools: Record<string, ToolPatch>
}

/** 体积估算跟着 state 对象走，不往公开的 Transcript 形状里加字段（fixture/测试都按旧字面量构造） */
const stateBytes = new WeakMap<Transcript, number>()

/*
 * 补拉账（R2-5 / 第 2 轮审查 B-6）：与字节账同范式挂在 state 对象上。
 * head = 当前头部有多少条是 prepend 并入的补拉页；trimmed = 累计被 trimTranscript
 * 从头部吃掉的补拉条数。prepend 只增 head、trim 只减 head 增 trimmed；
 * useRelay 盯 trimmed 的变化：一旦增长，说明刚补的页被后续动作静默裁掉，
 * 而补拉游标已越过该段——必须作废游标、下次从当前头部重新对齐把该段补回来，
 * 绝不留无提示的中间空洞。
 */
type BackfillMark = { head: number; trimmed: number }
const stateBackfill = new WeakMap<Transcript, BackfillMark>()

function backfillOf(state: Transcript): BackfillMark {
  return stateBackfill.get(state) ?? { head: 0, trimmed: 0 }
}

function setBackfill(state: Transcript, mark: BackfillMark): void {
  stateBackfill.set(state, mark)
}

/** 补拉账只读出口（useRelay 的 trim 接缝与测试用）：head=头部现存补拉条数，trimmed=累计被 trim 吃掉的补拉条数。 */
export function backfillInfoOf(state: Transcript): BackfillMark {
  return { ...backfillOf(state) }
}

export const emptyTranscript = (): Transcript => {
  const state: Transcript = {
    items: [],
    liveKey: null,
    seq: 0,
    bashKey: null,
    pendingTools: {},
  }
  stateBytes.set(state, 0)
  setBackfill(state, { head: 0, trimmed: 0 })
  return state
}

export type AssistantEvent = {
  type?: string
  contentIndex?: number
  delta?: string
  content?: string
  id?: string
  /** 部分 relay/事件源把工具 id 放在 toolCallId（toolcall_delta 常见只带 contentIndex） */
  toolCallId?: string
  toolName?: string
  toolCall?: { id?: string; name?: string; arguments?: unknown }
  error?: string
  reason?: string
}

export type TranscriptAction =
  | { type: "reset" }
  | { type: "snapshot"; messages: AgentMessage[] }
  /** 增量快照（断线重连 / 扩展补尾部）：按顺序追加已定稿消息 */
  | { type: "append"; messages: AgentMessage[] }
  /** 历史补拉（R2-5）：更旧的一片定稿消息前置并入；游标/锚点口径在 relay/history.ts */
  | { type: "prepend"; messages: AgentMessage[] }
  | { type: "message-start"; message: AgentMessage }
  | { type: "message-update"; event: AssistantEvent }
  /** useRelay 把 50ms 内的流式事件合成一批：整段 items 只复制一次，而不是每个 delta 一次 */
  | { type: "message-update-batch"; events: AssistantEvent[] }
  | { type: "message-end"; message: AgentMessage }
  | { type: "tool"; id: string; patch: ToolPatch }
  | { type: "bash-delta"; delta: string }
  /**
   * useRelay 把 50ms 内的 bash 输出增量合成一批（UI·perf 中-3）：整段 items 只复制一次、
   * 输出只拼接一次，而不是每帧一次。语义与逐条 bash-delta 完全一致（顺序拼接）。
   */
  | { type: "bash-delta-batch"; deltas: string[] }
  /** 带 cid（relay 有 msg.cid 能力）时按 cid 对号；不带时退回旧的按文本对号。images 只出现在本地乐观气泡上，不带则和原来一样 */
  | { type: "echo"; text: string; cid?: string; images?: ImagePart[] }
  | { type: "remote"; text: string; cid?: string }
  | { type: "remote-failed"; text: string; error: string; cid?: string }
  /** 扩展确认这条消息真正进了 pi */
  | { type: "delivered"; cid: string }
  /** 网页自己的发送命令失败：还在发送中的气泡 drop=true 时摘掉（草稿已退回），否则标失败；已回显的说明消息到了本机，不动 */
  | { type: "send-failed"; cid: string; error: string; drop: boolean }
  /** 重发前摘掉原来那条失败气泡 */
  | { type: "drop"; key: string }
  /** 远程待发状态整帧：按 cid 把编辑后的正文/失败状态同步到本地乐观气泡 */
  | { type: "queue-sync"; items: RemoteQueueItem[] }
  /** 远程待发被取消：撤掉还没注入的本地乐观气泡（已送达的绝不删） */
  | { type: "queue-drop"; cid: string }
  | { type: "settle" }

/** 乐观气泡（echo / remote 回显）总在尾部附近被真实消息取代：只回看这么多条，保证每条消息 O(1) */
const ECHO_WINDOW = 50

/*
 * 长会话状态上限。渲染层每次只挂 300 条（parts.tsx 的 TRANSCRIPT_PAGE），
 * 10k 条约等于 33 屏历史，足够回看；更早的完整历史仍在 pi 的本机会话文件里。
 * 条数留到 10k 而不是更小，是为了兼容现有契约测试「1 万条消息的快照重建」。
 * 字节上限主要防大工具输出 / 图片把网页内存撑爆（base64 按 UTF-16 约 2 字节/字符估算）。
 */
export const TRANSCRIPT_MAX_ITEMS = 10_000
export const TRANSCRIPT_MAX_BYTES = 8 * 1024 * 1024
/*
 * 补拉（prepend）的额外额度（UI·perf 中-4）：用户每点一次「加载更早」都会往头部并入一页，
 * 而 prepend 分支刻意不跑常规 trim（否则刚补的那页立刻被裁掉）。没有硬顶时，静止的历史会话
 * 连点下去能把转录推到条数/字节上限之外且不自收敛。这里给补拉留一档额外额度：总量涨到
 * TRANSCRIPT_BACKFILL_MAX_* 就在头部回收（回收走 trimTranscript，补拉账 trimmed 照记，
 * useRelay 会作废越过该段的游标，被吃掉的段仍可重新补拉），于是内存有上界、功能不丢。
 */
export const TRANSCRIPT_BACKFILL_MAX_ITEMS = TRANSCRIPT_MAX_ITEMS + 3_000
export const TRANSCRIPT_BACKFILL_MAX_BYTES = TRANSCRIPT_MAX_BYTES + 4 * 1024 * 1024
/**
 * bash 输出现场的单条上限（字符，只留尾部 = 最新输出，UI·perf 中-3）。
 * bash 条目在 trimTranscript 里被当作“现场”保护，单条输出不封顶时它会一路长过全局字节上限，
 * 全局上限就永远收不回来；封顶后单条输出有确定上界，全局账才收敛。
 */
export const BASH_OUTPUT_MAX_CHARS = 200_000

/** 输出只留尾部（最新几行）：超长时切掉头部，长度恒定不超过 BASH_OUTPUT_MAX_CHARS */
export function bashOutputTail(output: string): string {
  return output.length > BASH_OUTPUT_MAX_CHARS ? output.slice(output.length - BASH_OUTPUT_MAX_CHARS) : output
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

const EXIT_CODE_KEYS = ["exitCode", "exit_code", "code"] as const
const STDERR_KEYS = ["stderr", "standardError"] as const
const TASK_LIST_KEYS = ["tasks", "todos"] as const
/** edit 的 details.patch 单条上限（字符）：超出按整行截断并标 patchTruncated（G5，protocol-followups §3）。 */
export const TOOL_PATCH_MAX_CHARS = 200_000
/** 通用 details 呈现的条数/值长上限：防大对象灌进转录（体积上限另有 TRANSCRIPT_MAX_BYTES 兜底）。 */
const DETAIL_ENTRY_LIMIT = 12
const DETAIL_VALUE_LIMIT = 160
/*
 * 快照解析器的条数上限（UI 低危 18）：textOf / imagesOf / blocksFromContent / toolTasksOf 都直接吃
 * 快照消息里的数组，原来没有上限，一个异常大的消息（或恶意回包）会在 trimTranscript 之前就把
 * 整段内容展开/拼接一遍，内存与耗时都无界。同仓其它解析器都按条数截断（DIR_LIST_MAX、
 * remoteQueue 的 200 / 16），这里补齐同一口径：只取前 N 条，跳过而不是伪造。
 * 数值按“远大于真实消息”取：2000 个内容块、64 张图、500 条任务，正常会话碰不到；
 * 真超了也只丢尾部（快照最终另有 TRANSCRIPT_MAX_ITEMS/BYTES 兜底）。
 */
export const SNAPSHOT_CONTENT_BLOCKS_MAX = 2_000
export const SNAPSHOT_IMAGES_MAX = 64
export const SNAPSHOT_TASKS_MAX = 500

/** 任务状态归一：与扩展 taskListFromDetails 的口径一致（同义词 + done/completed 布尔）。 */
function toolTaskStatusOf(raw: Record<string, unknown>): ToolTaskEntry["status"] {
  const value = raw.status
  if (typeof value === "string") {
    const s = value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    if (s === "in_progress" || s === "inprogress" || s === "running" || s === "active") return "in_progress"
    if (s === "completed" || s === "complete" || s === "done") return "completed"
    if (s === "pending" || s === "todo" || s === "open" || s === "not_started") return "pending"
  }
  if (typeof raw.done === "boolean") return raw.done ? "completed" : "pending"
  if (typeof raw.completed === "boolean") return raw.completed ? "completed" : "pending"
  return "pending"
}

/** 从候选记录里提升任务清单：认 tasks / todos 数组；一条都认不出（且非空）时当没找到。
 *  条数封顶 SNAPSHOT_TASKS_MAX，异常大的清单不整份展开进任务面板。 */
function toolTasksOf(candidates: Record<string, unknown>[]): ToolTaskEntry[] | undefined {
  for (const record of candidates) {
    for (const key of TASK_LIST_KEYS) {
      const list = record[key]
      if (!Array.isArray(list)) continue
      const out: ToolTaskEntry[] = []
      const limit = Math.min(list.length, SNAPSHOT_CONTENT_BLOCKS_MAX)
      for (let index = 0; index < limit; index += 1) {
        if (out.length >= SNAPSHOT_TASKS_MAX) break
        const raw = list[index]
        if (!isRecord(raw)) continue
        const content =
          typeof raw.content === "string" ? raw.content : typeof raw.text === "string" ? raw.text : typeof raw.title === "string" ? raw.title : ""
        if (!content.trim()) continue
        const id =
          typeof raw.id === "string" && raw.id
            ? raw.id
            : typeof raw.id === "number" && Number.isFinite(raw.id)
              ? String(raw.id)
              : typeof raw.step === "number" && Number.isFinite(raw.step)
                ? String(raw.step)
                : String(index + 1)
        out.push({ id, content, status: toolTaskStatusOf(raw) })
      }
      if (out.length || list.length === 0) return out
    }
  }
  return undefined
}

/** 通用 details 值摘要：只给人看的短文本，对象/数组只报规模，不展开。 */
function detailValueSummary(value: unknown): string {
  if (typeof value === "string") return value.length > DETAIL_VALUE_LIMIT ? `${value.slice(0, DETAIL_VALUE_LIMIT)}…` : value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  if (Array.isArray(value)) return `共 ${value.length} 项`
  if (isRecord(value)) return `共 ${Object.keys(value).length} 个字段`
  return ""
}

/**
 * 未被提升的 details 键 → 通用键值条目。合并扫描全部候选记录（顺序即优先级：
 * details → structuredContent → details.structuredContent，同名键先到先得），
 * 否则两记录并存时后一记录的独有键会漏出通用区。已提升的键不重复出现，
 * 上限与值摘要口径不变。
 */
function toolDetailEntriesOf(records: readonly (Record<string, unknown> | undefined)[], lifted: ReadonlySet<string>): ToolDetailEntry[] | undefined {
  const entries: ToolDetailEntry[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (!record) continue
    for (const key of Object.keys(record)) {
      if (entries.length >= DETAIL_ENTRY_LIMIT) break
      if (lifted.has(key) || key === "structuredContent" || seen.has(key)) continue
      const value = record[key]
      if (value === undefined) continue
      const summary = detailValueSummary(value)
      if (!summary && typeof value !== "string") continue
      seen.add(key)
      entries.push({ key, value: summary })
    }
    if (entries.length >= DETAIL_ENTRY_LIMIT) break
  }
  return entries.length ? entries : undefined
}

/** pi 自己的样板文本（只锚定首/尾，不做全文模糊匹配）：拦截样板在结果开头，超时样板在结尾。 */
const DENIED_RESULT_PREFIX = /^\s*Tool execution was blocked\b/
const TIMEOUT_RESULT_SUFFIX = /Command timed out after \d+(?:\.\d+)? seconds\s*$/

function toolOutcomeOf(message: AgentMessage, outputText: string): ToolOutcome | undefined {
  if (message.isError !== true || !outputText) return undefined
  if (DENIED_RESULT_PREFIX.test(outputText)) return "denied"
  if (TIMEOUT_RESULT_SUFFIX.test(outputText)) return "timeout"
  return undefined
}

export type ToolDisplayFields = {
  exitCode?: number
  stderr?: string
  tasks?: ToolTaskEntry[]
  patch?: string
  firstChangedLine?: number
  patchTruncated?: true
  detailEntries?: ToolDetailEntry[]
  outcome?: ToolOutcome
}

/**
 * 工具结果的展示字段生产者（表驱动）：提取哪些结构化字段由
 * chat/tools/toolConfigs.ts 里该工具的 fields 清单决定（exitCode/stderr 是
 * 既有口径，tasks / patch 只给声明过的工具）；未被提升的 details 键在 genericDetails
 * 开启时走通用键值摘要，一个键都不丢。全部字段只读消息里真实存在的数据，
 * 缺失就留空，UI 不猜、不染色。
 */
function toolDisplayFieldsOf(message: AgentMessage, outputText: string): ToolDisplayFields {
  const candidates: Record<string, unknown>[] = []
  if (isRecord(message.details)) candidates.push(message.details)
  if (isRecord(message.structuredContent)) candidates.push(message.structuredContent)
  if (isRecord(message.details) && isRecord(message.details.structuredContent)) candidates.push(message.details.structuredContent)
  const config = toolRenderConfigFor(typeof message.toolName === "string" ? message.toolName : "")
  const fields: ToolDisplayFields = {}
  const lifted = new Set<string>()
  if (config.fields.includes("exitCode")) {
    for (const value of candidates) {
      for (const key of EXIT_CODE_KEYS) {
        const code = value[key]
        if (typeof code === "number" && Number.isFinite(code)) {
          fields.exitCode = code
          break
        }
      }
      if (fields.exitCode !== undefined) break
    }
    EXIT_CODE_KEYS.forEach((key) => lifted.add(key))
  }
  if (config.fields.includes("stderr")) {
    for (const value of candidates) {
      for (const key of STDERR_KEYS) {
        const text = value[key]
        if (typeof text === "string" && text.length) {
          fields.stderr = text
          break
        }
      }
      if (fields.stderr !== undefined) break
    }
    STDERR_KEYS.forEach((key) => lifted.add(key))
  }
  if (config.fields.includes("tasks")) {
    const tasks = toolTasksOf(candidates)
    if (tasks !== undefined) {
      fields.tasks = tasks
      TASK_LIST_KEYS.forEach((key) => lifted.add(key))
    }
  }
  if (config.fields.includes("patch")) {
    // pi EditToolDetails：patch（标准 unified diff）+ firstChangedLine；不是字符串的 patch 不认，留给通用区
    for (const value of candidates) {
      const patch = value.patch
      if (typeof patch !== "string" || !patch) continue
      if (patch.length > TOOL_PATCH_MAX_CHARS) {
        // 截在最后一个完整行之后，免得半行被当成代码行
        const cut = patch.slice(0, TOOL_PATCH_MAX_CHARS)
        const end = cut.lastIndexOf("\n")
        fields.patch = end > 0 ? cut.slice(0, end + 1) : cut
        fields.patchTruncated = true
      } else {
        fields.patch = patch
      }
      lifted.add("patch")
      const line = value.firstChangedLine
      if (typeof line === "number" && Number.isInteger(line) && line > 0) {
        fields.firstChangedLine = line
        lifted.add("firstChangedLine")
      }
      break
    }
  }
  if (config.genericDetails) {
    const entries = toolDetailEntriesOf(candidates, lifted)
    if (entries) fields.detailEntries = entries
  }
  const outcome = toolOutcomeOf(message, outputText)
  if (outcome) fields.outcome = outcome
  return fields
}

/** 消息时间戳：relay/扩展发毫秒数；少量旧数据可能是 ISO 字符串。非法值当没有。 */
function stampOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/** 助手耗时：只接受真实的正有限毫秒数；0 / 负 / 缺失都当没有，不补。 */
export function durationOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/** usage 行的用时文案（`5.3s`）；没有真实耗时时返回 null，调用方不渲染。 */
export function formatUsageDuration(durationMs: unknown): string | null {
  const value = durationOf(durationMs)
  if (value == null) return null
  // 十分之一秒精度；整秒不拖 .0（5s / 5.3s）。
  const seconds = Math.round(value / 100) / 10
  return `${seconds}s`
}

/**
 * 从图片块上读可寻址字段。只接受真实的 entryId + 非负整数 blockIndex（数字或数字字符串），
 * 缺一个、类型不对、负数/小数都返回 null——绝不按数组位置或消息内容猜。
 */
export function imageAddressOf(value: unknown): ImageAddress | null {
  if (!isRecord(value)) return null
  const entryId = typeof value.entryId === "string" ? value.entryId.trim() : ""
  const raw = value.blockIndex
  const blockIndex =
    typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN
  if (!entryId || !Number.isInteger(blockIndex) || blockIndex < 0) return null
  return { entryId, blockIndex }
}

/** 消息 content 里的正文块 → 文本；只扫前 SNAPSHOT_CONTENT_BLOCKS_MAX 个块（快照解析条数上限）。 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  const limit = Math.min(content.length, SNAPSHOT_CONTENT_BLOCKS_MAX)
  for (let index = 0; index < limit; index += 1) {
    const block = content[index]
    if (!isRecord(block)) continue
    if (block.type === "text" && typeof block.text === "string" && block.text) parts.push(block.text)
  }
  return parts.join("\n")
}

/** 消息 content 里的图片块 → ImagePart；单条消息最多 SNAPSHOT_IMAGES_MAX 张、最多扫 SNAPSHOT_CONTENT_BLOCKS_MAX 个块。 */
export function imagesOf(content: unknown): ImagePart[] {
  if (!Array.isArray(content)) return []
  const images: ImagePart[] = []
  const limit = Math.min(content.length, SNAPSHOT_CONTENT_BLOCKS_MAX)
  for (let index = 0; index < limit; index += 1) {
    if (images.length >= SNAPSHOT_IMAGES_MAX) break
    const block = content[index]
    if (!isRecord(block) || block.type !== "image") continue
    if (typeof block.mimeType !== "string") continue
    const address = imageAddressOf(block)
    if (block.omitted === true) {
      const bytes = typeof block.omittedBytes === "number" ? block.omittedBytes : undefined
      // omitted 占位也保留定位字段与 mime/字节数：能补拉就补拉，补不了就老实显示占位。
      images.push({ data: "", mimeType: block.mimeType, omitted: true, bytes, ...(address ?? {}) })
      continue
    }
    if (typeof block.data !== "string") continue
    images.push({ data: block.data, mimeType: block.mimeType, ...(address ?? {}) })
  }
  return images
}

/*
 * 每个 action 只复制一次 items 数组（draft），之后的修改都在 draft 上就地进行。
 * 每条消息都复制整个数组的话，快照重建是 O(n²)，会话越长订阅/重连越卡。
 *
 * 流式 delta 不再每个都走这里：useRelay 把 50ms 内的事件合成一次 message-update-batch，
 * 一次 batch 只复制一次数组（且只复制引用，旧 item 对象原样共享）。状态另有条数/字节上限，
 * 因此单次复制成本有固定上界，长会话不会随历史无限变慢。
 */
type Draft = Transcript

const ITEM_OVERHEAD_BYTES = 64
const BLOCK_OVERHEAD_BYTES = 32

function stringBytes(value: unknown): number {
  return typeof value === "string" ? value.length * 2 : 0
}

/** 工具 input 的估算按对象缓存：流式 delta 反复估同一条 item 时不重复遍历整份参数 */
const inputByteEstimates = new WeakMap<object, number>()

function estimateInputBytes(value: unknown, depth = 0): number {
  if (typeof value === "string") return value.length * 2
  if (typeof value === "number") return 8
  if (typeof value === "boolean") return 4
  if (!value || typeof value !== "object") return 0
  const cached = inputByteEstimates.get(value)
  if (cached !== undefined) return cached
  if (depth > 6) return BLOCK_OVERHEAD_BYTES
  let bytes = BLOCK_OVERHEAD_BYTES
  if (Array.isArray(value)) {
    for (const item of value) bytes += estimateInputBytes(item, depth + 1)
  } else {
    for (const [key, item] of Object.entries(value)) bytes += key.length * 2 + estimateInputBytes(item, depth + 1)
  }
  inputByteEstimates.set(value, bytes)
  return bytes
}

/** 粗估一条 item 的常驻体积。只读字符串 length（O(1)）和块数，不对内容做 JSON.stringify。 */
export function estimateItemBytes(item: Item): number {
  let bytes = ITEM_OVERHEAD_BYTES
  if (item.kind === "user") {
    bytes += stringBytes(item.key) + stringBytes(item.text) + stringBytes(item.echo) + stringBytes(item.failed) + stringBytes(item.cid)
    for (const image of item.images || []) bytes += BLOCK_OVERHEAD_BYTES + stringBytes(image.data) + stringBytes(image.mimeType)
    return bytes
  }
  if (item.kind === "assistant") {
    bytes += stringBytes(item.key) + stringBytes(item.model) + stringBytes(item.stopReason) + stringBytes(item.errorMessage)
    for (const block of item.blocks) {
      bytes += BLOCK_OVERHEAD_BYTES
      if (block.kind === "text" || block.kind === "thinking") {
        bytes += stringBytes(block.text)
        continue
      }
      bytes +=
        stringBytes(block.id) +
        stringBytes(block.name) +
        stringBytes(block.argsText) +
        stringBytes(block.outputText) +
        stringBytes(block.errorText) +
        stringBytes(block.patch)
      if (block.input) bytes += estimateInputBytes(block.input)
      for (const image of block.images || []) bytes += BLOCK_OVERHEAD_BYTES + stringBytes(image.data) + stringBytes(image.mimeType)
    }
    return bytes
  }
  if (item.kind === "summary") return bytes + stringBytes(item.key) + stringBytes(item.title) + stringBytes(item.text)
  if (item.kind === "bash") return bytes + stringBytes(item.key) + stringBytes(item.command) + stringBytes(item.output) + stringBytes(item.label)
  return bytes + stringBytes(item.key) + stringBytes(item.label) + stringBytes(item.text)
}

function estimatedBytesOf(state: Transcript): number {
  const cached = stateBytes.get(state)
  if (cached !== undefined) return cached
  // 外部按旧字面量构造的 Transcript（fixture）没有计数：第一次用时扫一遍并挂在 state 上
  let bytes = 0
  for (const item of state.items) bytes += estimateItemBytes(item)
  stateBytes.set(state, bytes)
  return bytes
}

function setEstimatedBytes(state: Transcript, bytes: number): void {
  stateBytes.set(state, Math.max(0, bytes))
}

function draftOf(state: Transcript): Draft {
  const d: Draft = { ...state, items: state.items.slice() }
  setEstimatedBytes(d, estimatedBytesOf(state))
  setBackfill(d, { ...backfillOf(state) })
  return d
}

function addItem(d: Draft, item: Item): void {
  d.items.push(item)
  setEstimatedBytes(d, estimatedBytesOf(d) + estimateItemBytes(item))
}

function setItem(d: Draft, at: number, item: Item): void {
  const previous: Item | undefined = d.items[at]
  d.items[at] = item
  setEstimatedBytes(d, estimatedBytesOf(d) - (previous ? estimateItemBytes(previous) : 0) + estimateItemBytes(item))
}

function removeItemAt(d: Draft, at: number): Item | undefined {
  const removed = d.items.splice(at, 1)[0]
  if (removed) setEstimatedBytes(d, estimatedBytesOf(d) - estimateItemBytes(removed))
  return removed
}

function issueKey(d: Draft, prefix: string): string {
  d.seq += 1
  return `${prefix}${d.seq}`
}

function indexOfKey(items: Item[], key: string | null): number {
  if (!key) return -1
  for (let k = items.length - 1; k >= 0; k -= 1) if (items[k].key === key) return k
  return -1
}

/*
 * 从头部裁到条数/字节上限内。永远保留尾部（最新消息、live 流式项、bash 输出现场），
 * 并顺手丢掉已经被裁掉的工具卡对应的 pendingTools，避免旧会话的补丁在尾部复活。
 * 只在 action 收尾调用；流式 delta 期间 O(1) 判断（计数在 WeakMap 里增量维护）。
 * 上限可调：补拉（prepend）走更高的一档额度（UI·perf 中-4）。
 */
function trimTranscript(d: Draft, itemsMax: number = TRANSCRIPT_MAX_ITEMS, bytesMax: number = TRANSCRIPT_MAX_BYTES): void {
  const items = d.items
  if (!items.length) return
  // live 气泡和 bash 输出现场都可能在尾部之外（例如流式回答前的 !cmd）：谁更靠前就保护谁
  let protectedAt = Number.POSITIVE_INFINITY
  for (const at of [indexOfKey(items, d.liveKey), indexOfKey(items, d.bashKey)]) {
    if (at >= 0 && at < protectedAt) protectedAt = at
  }
  if (protectedAt === 0) return
  const total = estimatedBytesOf(d)
  let remove = Math.max(0, items.length - itemsMax)
  if (total > bytesMax) {
    let remaining = total
    let k = 0
    // 至少保留最后一条、且不越过 live/bash：单条工具输出/图片本身超限时没有别的办法
    while (k < items.length - 1 && k < protectedAt && remaining > bytesMax) {
      remaining -= estimateItemBytes(items[k])
      k += 1
    }
    if (k > remove) remove = k
  }
  if (remove > protectedAt) remove = protectedAt
  if (remove <= 0) return
  if (remove >= items.length) remove = items.length - 1

  let removedBytes = 0
  let pending: Record<string, ToolPatch> | null = null
  for (let k = 0; k < remove; k += 1) {
    const item = items[k]
    removedBytes += estimateItemBytes(item)
    if (item.kind !== "assistant") continue
    for (const block of item.blocks) {
      if (block.kind !== "tool" || !block.id || !(block.id in d.pendingTools)) continue
      pending = pending || { ...d.pendingTools }
      delete pending[block.id]
    }
  }
  if (pending) d.pendingTools = pending
  items.splice(0, remove)
  setEstimatedBytes(d, total - removedBytes)
  // 补拉账：头部 remove 条里属于补拉页的部分记进 trimmed（第 2 轮审查 B-6）——
  // useRelay 据此作废已越过该段的补拉游标，让被吃段可重新补拉，不留静默空洞。
  const mark = backfillOf(d)
  if (mark.head > 0) {
    const eaten = Math.min(remove, mark.head)
    if (eaten > 0) setBackfill(d, { head: mark.head - eaten, trimmed: mark.trimmed + eaten })
  }
}

/** 带 cid 的帧每条消息只有几个，全表从尾部找：排队很久的消息可能已经被几十条工具卡压到窗口外 */
function indexOfCid(items: Item[], cid: string): number {
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const item = items[k]
    if (item.kind === "user" && item.cid === cid) return k
  }
  return -1
}

function echoedStatus(item: UserItem): SendStatus {
  return item.status === "delivered" ? "delivered" : "echoed"
}

/** 助手消息 content → 可渲染块；只扫前 SNAPSHOT_CONTENT_BLOCKS_MAX 个块（快照解析条数上限）。 */
function blocksFromContent(content: unknown, pending: Record<string, ToolPatch>): Block[] {
  const list = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : []
  const blocks: Block[] = []
  const limit = Math.min(list.length, SNAPSHOT_CONTENT_BLOCKS_MAX)
  for (let index = 0; index < limit; index += 1) {
    const raw = list[index]
    if (!isRecord(raw)) continue
    if (raw.type === "text") blocks.push({ kind: "text", text: typeof raw.text === "string" ? raw.text : "" })
    else if (raw.type === "thinking") {
      blocks.push({ kind: "thinking", text: raw.redacted ? "" : typeof raw.thinking === "string" ? raw.thinking : "" })
    } else if (raw.type === "toolCall") {
      const id = typeof raw.id === "string" ? raw.id : ""
      const saved = id ? pending[id] : undefined
      const input = isRecord(raw.arguments) ? raw.arguments : saved?.input
      blocks.push({
        kind: "tool",
        id,
        name: (typeof raw.name === "string" && raw.name) || saved?.name || "tool",
        argsText: saved?.argsText || "",
        input,
        outputText: saved?.outputText || "",
        images: saved?.images,
        state: saved?.state || (input ? "input-available" : "input-streaming"),
        errorText: saved?.errorText,
        exitCode: saved?.exitCode,
        stderr: saved?.stderr,
        tasks: saved?.tasks,
        patch: saved?.patch,
        firstChangedLine: saved?.firstChangedLine,
        patchTruncated: saved?.patchTruncated,
        detailEntries: saved?.detailEntries,
        outcome: saved?.outcome,
      })
    }
  }
  return blocks
}

function assistantItem(pending: Record<string, ToolPatch>, message: AgentMessage, key: string, live: boolean): Item {
  const timestamp = stampOf(message.timestamp)
  const durationMs = durationOf(message.durationMs)
  return {
    kind: "assistant",
    key,
    blocks: blocksFromContent(message.content, pending),
    model: typeof message.model === "string" ? message.model : undefined,
    usage: message.usage,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    live,
    // start/end 都是展示字段：start 取 pi 的请求开始时间，end 只在 duration 真实存在时相加。
    startedAt: timestamp,
    endedAt: timestamp != null && durationMs != null ? timestamp + durationMs : undefined,
    durationMs,
    timestamp,
  }
}

function appendSettled(d: Draft, message: AgentMessage): void {
  if (!message || message.role === "system") return
  if (message.role === "custom" && message.display === false) return
  const items = d.items
  if (message.role === "user") {
    const raw = textOf(message.content)
    const text = raw.trim()
    const images = imagesOf(message.content)
    const timestamp = stampOf(message.timestamp)
    let remote = message.remote === true
    const cid = remote && typeof message.cid === "string" ? message.cid : ""
    if (cid) {
      // relay 存储里还没被取代的远程回显（v4 带 cid）：并进同 cid 的乐观气泡；
      // 没有就按回显气泡放，等 pi 的 user 消息来取代
      const at = indexOfCid(items, cid)
      const item = at >= 0 ? items[at] : undefined
      if (item && item.kind === "user") {
        setItem(d, at, { ...item, remote: true, failed: undefined, status: echoedStatus(item), timestamp: item.timestamp ?? timestamp })
        return
      }
      addItem(d, { kind: "user", key: issueKey(d, "r"), text: raw, images, echo: text, remote: true, from: "remote", cid, status: "echoed", timestamp })
      return
    }
    // pi 的 user 消息取代同文本的乐观气泡：同文本有多条时先进先出取最早一条，失败的不算（DOC/71 §3）。
    // 按 echo 字段是否存在判乐观气泡，不能按真值：纯图片气泡的 echo 是空串，按真值判永远取代不掉、会与正文并存
    for (let k = Math.max(0, items.length - ECHO_WINDOW); k < items.length; k += 1) {
      const item = items[k]
      if (item.kind === "user" && item.echo !== undefined && !item.failed && item.echo.trim() === text) {
        if (item.remote) remote = true
        removeItemAt(d, k)
        break
      }
    }
    const last = items[items.length - 1]
    // 只并旧快照里的远程记录（不带 echo）；乐观气泡（失败的、别的 cid 的）不能被并掉
    if (
      last &&
      last.kind === "user" &&
      !last.echo &&
      last.images.length === 0 &&
      images.length === 0 &&
      last.text.trim() === text &&
      !!last.remote !== remote
    ) {
      setItem(d, items.length - 1, { kind: "user", key: last.key, text: raw || last.text, images, remote: true, timestamp: timestamp ?? last.timestamp })
      return
    }
    addItem(d, { kind: "user", key: issueKey(d, "u"), text: raw, images, remote: remote || undefined, timestamp })
    return
  }
  if (message.role === "assistant") {
    const at = indexOfKey(items, d.liveKey)
    d.liveKey = null
    if (at >= 0) {
      setItem(d, at, assistantItem(d.pendingTools, message, items[at].key, false))
      return
    }
    addItem(d, assistantItem(d.pendingTools, message, issueKey(d, "a"), false))
    return
  }
  if (message.role === "toolResult") {
    const outputText = textOf(message.content)
    const display = toolDisplayFieldsOf(message, outputText)
    patchTool(d, message.toolCallId || "", {
      name: message.toolName,
      outputText,
      images: imagesOf(message.content),
      state: message.isError ? "output-error" : "output-available",
      errorText: message.isError ? outputText : undefined,
      exitCode: display.exitCode,
      stderr: display.stderr,
      tasks: display.tasks,
      patch: display.patch,
      firstChangedLine: display.firstChangedLine,
      patchTruncated: display.patchTruncated,
      detailEntries: display.detailEntries,
      outcome: display.outcome,
    })
    return
  }
  if (message.role === "bashExecution") {
    const failed = !!message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0)
    const label = message.cancelled ? "已取消" : typeof message.exitCode === "number" ? `退出 ${message.exitCode}` : failed ? "出错" : "完成"
    const command = message.command || ""
    // 落定的输出同样按尾部封顶（UI·perf 中-3）：否则流式期间封了顶，定稿又把整份塞回来
    const output = bashOutputTail(message.output || "")
    // 流式 "输出" 气泡（bash-delta）在这里被正式结果**取代**（同 key 同位），
    // 否则同一条 !cmd 会显示两遍，且 bashKey 一直指着旧气泡，下一条命令的输出会接进它
    const at = d.bashKey ? indexOfKey(items, d.bashKey) : -1
    d.bashKey = null
    if (at >= 0 && items[at].kind === "bash") {
      setItem(d, at, { kind: "bash", key: items[at].key, command, output, label, timestamp: items[at].timestamp ?? stampOf(message.timestamp) })
      return
    }
    addItem(d, { kind: "bash", key: issueKey(d, "b"), command, output, label, timestamp: stampOf(message.timestamp) })
    return
  }
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    addItem(d, {
      kind: "summary",
      key: issueKey(d, "s"),
      title: message.role === "compactionSummary" ? "已折叠早期对话" : "分支摘要",
      text: message.summary || "",
      timestamp: stampOf(message.timestamp),
    })
    return
  }
  if (message.role === "custom") {
    addItem(d, {
      kind: "custom",
      key: issueKey(d, "c"),
      label: message.customType === "remote-bash" ? "命令输出" : message.customType || "custom",
      text: textOf(message.content),
      timestamp: stampOf(message.timestamp),
    })
    return
  }
  const text = textOf(message.content) || message.summary || ""
  if (!text) return
  addItem(d, { kind: "custom", key: issueKey(d, "n"), label: message.role || "消息", text, timestamp: stampOf(message.timestamp) })
}

function patchTool(d: Draft, id: string, patch: ToolPatch): void {
  const items = d.items
  if (!id) {
    addItem(d, {
      kind: "assistant",
      key: issueKey(d, "t"),
      blocks: [
        {
          kind: "tool",
          id: "",
          name: patch.name || "tool",
          argsText: patch.argsText || "",
          input: patch.input,
          outputText: patch.outputText || "",
          images: patch.images,
          state: patch.state || "output-available",
          errorText: patch.errorText,
          exitCode: patch.exitCode,
          stderr: patch.stderr,
          tasks: patch.tasks,
          patch: patch.patch,
          firstChangedLine: patch.firstChangedLine,
          patchTruncated: patch.patchTruncated,
          detailEntries: patch.detailEntries,
          outcome: patch.outcome,
        },
      ],
    })
    return
  }
  // 存一份：在飞的助手消息定稿时 blocks 会从 message.content 重建，工具状态要从这里补回
  d.pendingTools = { ...d.pendingTools, [id]: { ...d.pendingTools[id], ...patch } }
  // 工具卡几乎总在最后一两条助手消息里：从尾部找，找到即停
  for (let k = items.length - 1; k >= 0; k -= 1) {
    const item = items[k]
    if (item.kind !== "assistant") continue
    const b = item.blocks.findIndex((block) => block.kind === "tool" && block.id === id)
    if (b < 0) continue
    const block = item.blocks[b]
    if (block.kind !== "tool") return
    const blocks = item.blocks.slice()
    blocks[b] = {
      ...block,
      name: patch.name || block.name,
      argsText: patch.argsText ?? block.argsText,
      input: patch.input ?? block.input,
      outputText: patch.outputText ?? block.outputText,
      state: patch.state || block.state,
      images: patch.images ?? block.images,
      errorText: patch.errorText ?? block.errorText,
      exitCode: patch.exitCode ?? block.exitCode,
      stderr: patch.stderr ?? block.stderr,
      tasks: patch.tasks ?? block.tasks,
      patch: patch.patch ?? block.patch,
      firstChangedLine: patch.firstChangedLine ?? block.firstChangedLine,
      patchTruncated: patch.patchTruncated ?? block.patchTruncated,
      detailEntries: patch.detailEntries ?? block.detailEntries,
      outcome: patch.outcome ?? block.outcome,
    }
    setItem(d, k, { ...item, blocks })
    return
  }
  const saved = d.pendingTools[id]
  addItem(d, {
    kind: "assistant",
    key: issueKey(d, "t"),
    blocks: [
      {
        kind: "tool",
        id,
        name: saved.name || "tool",
        argsText: saved.argsText || "",
        input: saved.input,
        outputText: saved.outputText || "",
        images: saved.images,
        state: saved.state || "input-streaming",
        errorText: saved.errorText,
        exitCode: saved.exitCode,
        stderr: saved.stderr,
        tasks: saved.tasks,
        patch: saved.patch,
        firstChangedLine: saved.firstChangedLine,
        patchTruncated: saved.patchTruncated,
        detailEntries: saved.detailEntries,
        outcome: saved.outcome,
      },
    ],
  })
}

/** 工具块定位：contentIndex 是助手消息内容槽位（流式事件的主键），id/toolCallId 是工具调用 id。
 *  两者都有时要求互相印证（槽位里必须是同一个工具，或该槽位的工具还没拿到 id）；
 *  只有一个时按那一个找；都没有、或都对不上就返回 -1 —— 调用方必须安全忽略，
 *  绝不能退回"最后一个工具块"，否则并行工具调用的参数会串卡。 */
function toolBlockIndex(blocks: Block[], event: AssistantEvent): number {
  const id =
    typeof event.id === "string" && event.id
      ? event.id
      : typeof event.toolCallId === "string" && event.toolCallId
        ? event.toolCallId
        : ""
  const raw = event.contentIndex
  const idx = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : -1
  if (idx >= 0) {
    const block = blocks[idx]
    if (block && block.kind === "tool" && (!id || !block.id || block.id === id)) return idx
  }
  // 没有 contentIndex，或槽位不是工具块/槽位 id 与事件 id 冲突：只有明确 id 时才按 id 找
  if (id) {
    for (let k = blocks.length - 1; k >= 0; k -= 1) {
      const block = blocks[k]
      if (block.kind === "tool" && block.id === id) return k
    }
  }
  return -1
}

/** 把一个流式事件应用到 draft 里的 live item；返回 false 表示这一帧该被安全忽略。 */
function applyLiveEvent(d: Draft, event: AssistantEvent): boolean {
  if (!d.liveKey || !event.type) return false
  const at = indexOfKey(d.items, d.liveKey)
  const item = at >= 0 ? d.items[at] : undefined
  if (!item || item.kind !== "assistant") return false
  const idx = typeof event.contentIndex === "number" ? event.contentIndex : 0
  const blocks = item.blocks.slice()
  const current = blocks[idx]
  if (event.type === "text_start" || event.type === "text_delta" || event.type === "text_end") {
    const prev = current?.kind === "text" ? current.text : ""
    const text = event.type === "text_end" && typeof event.content === "string" ? event.content : event.type === "text_delta" ? prev + (event.delta || "") : prev
    blocks[idx] = { kind: "text", text }
  } else if (event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end") {
    const prev = current?.kind === "thinking" ? current.text : ""
    const text =
      event.type === "thinking_end" && typeof event.content === "string"
        ? event.content
        : event.type === "thinking_delta"
          ? prev + (event.delta || "")
          : ""
    blocks[idx] = { kind: "thinking", text }
  } else if (event.type === "toolcall_start") {
    const id = event.id || ""
    const saved = id ? d.pendingTools[id] : undefined
    blocks[idx] = {
      kind: "tool",
      id,
      name: event.toolName || saved?.name || "tool",
      argsText: saved?.argsText || "",
      input: saved?.input,
      outputText: saved?.outputText || "",
      state: saved?.state || "input-streaming",
      errorText: saved?.errorText,
      exitCode: saved?.exitCode,
      stderr: saved?.stderr,
      tasks: saved?.tasks,
      patch: saved?.patch,
      firstChangedLine: saved?.firstChangedLine,
      patchTruncated: saved?.patchTruncated,
      detailEntries: saved?.detailEntries,
      outcome: saved?.outcome,
    }
  } else if (event.type === "toolcall_delta") {
    // 按 contentIndex/id 精确定位：并行工具调用的参数流会交错，找"最后一个工具块"必然串卡
    const index = toolBlockIndex(blocks, event)
    const tool = index >= 0 ? blocks[index] : undefined
    // 没有匹配（start 还没到 / contentIndex 对不上 / 工具块已被定稿清掉）：丢弃这一帧
    if (!tool || tool.kind !== "tool") return false
    const argsText = tool.argsText + (event.delta || "")
    blocks[index] = { ...tool, argsText, state: tool.state === "output-available" || tool.state === "output-error" ? tool.state : "input-streaming" }
  } else if (event.type === "toolcall_end" && event.toolCall) {
    const id = event.toolCall.id || ""
    const input = isRecord(event.toolCall.arguments) ? event.toolCall.arguments : undefined
    const index = blocks.findIndex((block) => block?.kind === "tool" && (block.id === id || !id))
    const target = index >= 0 ? blocks[index] : blocks[idx]
    if (target && target.kind === "tool") {
      blocks[index >= 0 ? index : idx] = {
        ...target,
        id: id || target.id,
        name: event.toolCall.name || target.name,
        input: input || target.input,
        state: target.state === "output-available" || target.state === "output-error" ? target.state : "input-available",
      }
    }
  } else {
    return false
  }
  setItem(d, at, { ...item, blocks })
  return true
}

function updateLive(state: Transcript, event: AssistantEvent): Transcript {
  if (!state.liveKey || !event.type) return state
  const d = draftOf(state)
  if (!applyLiveEvent(d, event)) return state
  trimTranscript(d)
  return d
}

/** 一批流式事件只创建一次 draft、只复制一次 items（每帧本身仍是不可变对象，memo 才能继续生效）。 */
function updateLiveBatch(state: Transcript, events: AssistantEvent[]): Transcript {
  if (!state.liveKey || !events.length) return state
  const d = draftOf(state)
  let changed = false
  for (const event of events) if (applyLiveEvent(d, event)) changed = true
  if (!changed) return state
  trimTranscript(d)
  return d
}

/** 定稿后清理已落进 blocks 的待定工具（只看尾部：工具卡都在最近几条助手消息里） */
function prunePending(d: Draft): void {
  const ids = Object.keys(d.pendingTools)
  if (!ids.length) return
  const used = new Set<string>()
  for (let k = d.items.length - 1, stop = Math.max(0, d.items.length - ECHO_WINDOW); k >= stop; k -= 1) {
    const item = d.items[k]
    if (item.kind !== "assistant") continue
    for (const block of item.blocks) if (block.kind === "tool") used.add(block.id)
  }
  if (!ids.some((id) => used.has(id))) return
  const pending: Record<string, ToolPatch> = {}
  for (const id of ids) if (!used.has(id)) pending[id] = d.pendingTools[id]
  d.pendingTools = pending
}

/**
 * bash 输出增量落进流尾的“输出”气泡（同一条 !cmd 的现场）。逐条 delta 与合批一起走这里：
 * 输出按尾部封顶（UI·perf 中-3），单条再长也不会把全局条数/字节账撑过上限。
 */
function appendBashOutput(state: Transcript, delta: string): Transcript {
  if (!delta) return state
  const at = state.bashKey ? indexOfKey(state.items, state.bashKey) : -1
  const d = draftOf(state)
  const item = at >= 0 ? d.items[at] : undefined
  if (item && item.kind === "bash") {
    setItem(d, at, { ...item, output: bashOutputTail(item.output + delta) })
    trimTranscript(d)
    return d
  }
  const key = issueKey(d, "sh")
  addItem(d, { kind: "bash", key, command: "", output: bashOutputTail(delta), label: "输出" })
  d.bashKey = key
  trimTranscript(d)
  return d
}

export function reduceTranscript(state: Transcript, action: TranscriptAction): Transcript {
  switch (action.type) {
    case "reset":
      return emptyTranscript()
    case "snapshot": {
      const d = emptyTranscript()
      for (const message of action.messages) appendSettled(d, message)
      // 换房/重连 = 全新会话：待定工具卡必须一起清，否则旧会话的 pendingTools 会越攒越多
      d.pendingTools = {}
      // 先裁到上限内，再识别尾部 pending 气泡；裁剪永远保留最后一条，不会把 live 删掉
      trimTranscript(d)
      // 本机正在输出时订阅/重连：pi 的内存 branch 含 stopReason:"pending" 的在飞助手消息
      // （docs/message-types.md：pending = 流式中的部分消息，不落 JSONL），必须把它标成 live
      // 气泡——否则后续 message_update 被 updateLive 全部丢弃（没有打字机），message_end 又会
      // 因 liveKey 为空追加第二条同内容气泡，同一张回答渲染两遍。
      const last = d.items[d.items.length - 1]
      if (last && last.kind === "assistant" && last.stopReason === "pending") {
        setItem(d, d.items.length - 1, { ...last, live: true })
        d.liveKey = last.key
      }
      return d
    }
    case "append": {
      if (!action.messages.length) return state
      // 断线期间在飞的助手消息若已定稿，会作为增量里的第一条 assistant 取代 live 气泡
      const d = draftOf(state)
      for (const message of action.messages) appendSettled(d, message)
      prunePending(d)
      trimTranscript(d)
      return d
    }
    case "prepend": {
      if (!action.messages.length || !state.items.length) return state
      const d = draftOf(state)
      const mainItems = d.items
      const liveKey = d.liveKey
      const bashKey = d.bashKey
      // 在空数组上按快照同路把这一片建出来，再整段前置：issueKey 共用 d.seq 不撞键；
      // live / bash 现场指针先摘下再装回，免得片内助手/命令消息误伤在飞状态。
      d.items = []
      d.liveKey = null
      d.bashKey = null
      for (const message of action.messages) appendSettled(d, message)
      const pageItems = d.items
      d.items = [...pageItems, ...mainItems]
      d.liveKey = liveKey
      d.bashKey = bashKey
      // 补拉账：新并入的这一片记到头部账上，供 trim 吃页时对账（B-6）
      const mark = backfillOf(d)
      setBackfill(d, { head: mark.head + pageItems.length, trimmed: mark.trimmed })
      // 字节账走增量：建这一片时 addItem/setItem 已经在主账上加了片内条目（d.items 曾经是空数组，
      // 片内每个增删都按 delta 记进了同一个计数），这里不必再全量扫一遍（UI·perf 中-4）。
      // 不跑常规 trim：补拉是用户显式加载，常规上限会把刚补的页立刻裁掉。
      // 但要有硬顶（UI·perf 中-4）：连点「加载更早」把总量推过补拉额度时，在头部回收。
      // 回收走 trimTranscript，补拉账 trimmed 照记 → useRelay 作废越过该段的游标，
      // 用户再点「加载更早」还能重新补回来，内存因此有上界而历史不静默丢。
      trimTranscript(d, TRANSCRIPT_BACKFILL_MAX_ITEMS, TRANSCRIPT_BACKFILL_MAX_BYTES)
      return d
    }
    case "settle": {
      if (!state.liveKey) {
        // 没有活动气泡时也可能残留 pendingTools（工具调用被中断）：一并清掉
        if (!Object.keys(state.pendingTools).length) return state
        const next: Transcript = { ...state, pendingTools: {} }
        setBackfill(next, { ...backfillOf(state) })
        return next
      }
      const d = draftOf(state)
      const at = indexOfKey(d.items, d.liveKey)
      const item = at >= 0 ? d.items[at] : undefined
      if (item && item.kind === "assistant" && item.live) setItem(d, at, { ...item, live: false })
      d.liveKey = null
      d.pendingTools = {}
      trimTranscript(d)
      return d
    }
    case "message-start": {
      if (action.message.role !== "assistant") return state
      const d = draftOf(state)
      const key = issueKey(d, "a")
      addItem(d, assistantItem(d.pendingTools, action.message, key, true))
      d.liveKey = key
      trimTranscript(d)
      return d
    }
    case "message-update":
      return updateLive(state, action.event)
    case "message-update-batch":
      return updateLiveBatch(state, action.events)
    case "message-end": {
      const d = draftOf(state)
      appendSettled(d, action.message)
      prunePending(d)
      trimTranscript(d)
      return d
    }
    case "tool": {
      const d = draftOf(state)
      patchTool(d, action.id, action.patch)
      trimTranscript(d)
      return d
    }
    case "bash-delta":
      return appendBashOutput(state, action.delta)
    case "bash-delta-batch": {
      // 一整批只创建一次 draft、只拼接一次输出（与逐条 bash-delta 等价）
      let out = ""
      for (const delta of action.deltas) if (delta) out += delta
      return out ? appendBashOutput(state, out) : state
    }
    case "echo": {
      const text = action.text.trim()
      if (!text && !action.images?.length) return state
      const images = action.images?.length ? action.images : []
      if (action.cid) {
        // 按 cid 对号：同样内容连发两条就是两个气泡
        if (indexOfCid(state.items, action.cid) >= 0) return state
        const d = draftOf(state)
        addItem(d, { kind: "user", key: issueKey(d, "e"), text, images, echo: text, from: "local", cid: action.cid, status: "sending" })
        trimTranscript(d)
        return d
      }
      for (let k = state.items.length - 1, stop = Math.max(0, state.items.length - ECHO_WINDOW); k >= stop; k -= 1) {
        const item = state.items[k]
        if (item.kind === "user" && item.echo?.trim() === text) return state
      }
      const d = draftOf(state)
      addItem(d, { kind: "user", key: issueKey(d, "e"), text, images, echo: text, from: "local" })
      trimTranscript(d)
      return d
    }
    case "remote": {
      const text = action.text.trim()
      if (action.cid) {
        const at = indexOfCid(state.items, action.cid)
        const item = at >= 0 ? state.items[at] : undefined
        if (item && item.kind === "user") {
          // 按 cid 对上已有气泡时，帧本身无文本也有效：纯图片消息 text 为空、
          // 图片在气泡上，这里只需把它落成已回显
          const d = draftOf(state)
          setItem(d, at, { ...item, remote: true, from: item.from ?? "remote", failed: undefined, status: echoedStatus(item) })
          trimTranscript(d)
          return d
        }
        // 没有可对号的气泡且帧无文本：帧不带图片数据，没有可呈现的内容，
        // 丢弃等 pi 的 settled 消息带图落地，避免造无文本无图的幽灵气泡
        if (!text) return state
        // 别的网页发的，或者自己的气泡被全量快照冲掉了
        const d = draftOf(state)
        addItem(d, { kind: "user", key: issueKey(d, "r"), text, images: [], echo: text, remote: true, from: "remote", cid: action.cid, status: "echoed" })
        trimTranscript(d)
        return d
      }
      if (!text) return state
      for (let k = state.items.length - 1, stop = Math.max(0, state.items.length - ECHO_WINDOW); k >= stop; k -= 1) {
        const item = state.items[k]
        if (item.kind === "user" && item.echo && item.text.trim() === text) {
          const d = draftOf(state)
          setItem(d, k, { ...item, remote: true, from: item.from ?? "remote", failed: undefined })
          trimTranscript(d)
          return d
        }
      }
      const last = state.items[state.items.length - 1]
      if (last && last.kind === "user" && last.remote && last.text.trim() === text) return state
      const d = draftOf(state)
      addItem(d, { kind: "user", key: issueKey(d, "r"), text, images: [], echo: text, remote: true, from: "remote" })
      trimTranscript(d)
      return d
    }
    case "remote-failed": {
      const text = action.text.trim()
      const error = action.error || "发送失败"
      if (action.cid) {
        const at = indexOfCid(state.items, action.cid)
        const item = at >= 0 ? state.items[at] : undefined
        if (item && item.kind === "user") {
          const d = draftOf(state)
          setItem(d, at, { ...item, failed: error, from: item.from ?? (item.remote ? "remote" : "local") })
          trimTranscript(d)
          return d
        }
        if (!text) return state
        const d = draftOf(state)
        addItem(d, { kind: "user", key: issueKey(d, "e"), text, images: [], echo: text, remote: true, from: "remote", failed: error, cid: action.cid })
        trimTranscript(d)
        return d
      }
      if (!text) return state
      for (let k = state.items.length - 1, stop = Math.max(0, state.items.length - ECHO_WINDOW); k >= stop; k -= 1) {
        const item = state.items[k]
        if (item.kind === "user" && (item.echo || item.remote) && item.text.trim() === text) {
          const d = draftOf(state)
          setItem(d, k, { ...item, failed: error, from: item.from ?? (item.remote ? "remote" : "local") })
          trimTranscript(d)
          return d
        }
      }
      const d = draftOf(state)
      addItem(d, { kind: "user", key: issueKey(d, "e"), text, images: [], echo: text, remote: true, from: "remote", failed: error })
      trimTranscript(d)
      return d
    }
    case "delivered": {
      // 送达确认可能晚于 pi 的 user 消息：气泡已被取代就什么都不用做
      const at = indexOfCid(state.items, action.cid)
      const item = at >= 0 ? state.items[at] : undefined
      if (!item || item.kind !== "user" || item.status === "delivered") return state
      const d = draftOf(state)
      setItem(d, at, { ...item, status: "delivered", failed: undefined })
      trimTranscript(d)
      return d
    }
    case "queue-sync": {
      // 只更新已有乐观气泡：别人发的远程消息没有本地 cid，等注入时的 remote 回显再出现。
      const byCid = new Map<string, RemoteQueueItem>()
      for (const item of action.items) if (item.cid) byCid.set(item.cid, item)
      if (!byCid.size) return state
      let d: Draft | null = null
      for (let k = 0; k < state.items.length; k += 1) {
        const item = state.items[k]
        if (item.kind !== "user" || !item.cid) continue
        const queued = byCid.get(item.cid)
        if (!queued) continue
        const failed = queued.status === "failed" ? queued.error || "注入失败" : undefined
        const text = queued.text || item.text
        if (text === item.text && failed === item.failed) continue
        if (!d) d = draftOf(state)
        setItem(d, k, { ...item, text, echo: text, ...(failed ? { failed } : { failed: undefined }) })
      }
      if (!d) return state
      trimTranscript(d)
      return d
    }
    case "queue-drop": {
      const at = indexOfCid(state.items, action.cid)
      const item = at >= 0 ? state.items[at] : undefined
      // 已送达/已注入的气泡属于会话正文，不能因为一次取消命令误删。
      if (!item || item.kind !== "user" || item.status === "delivered") return state
      const d = draftOf(state)
      removeItemAt(d, at)
      trimTranscript(d)
      return d
    }
    case "send-failed": {
      const at = indexOfCid(state.items, action.cid)
      const item = at >= 0 ? state.items[at] : undefined
      if (!item || item.kind !== "user" || item.status !== "sending") return state
      const d = draftOf(state)
      if (action.drop) removeItemAt(d, at)
      else setItem(d, at, { ...item, failed: action.error || "发送失败" })
      trimTranscript(d)
      return d
    }
    case "drop": {
      const at = indexOfKey(state.items, action.key)
      if (at < 0) return state
      const d = draftOf(state)
      removeItemAt(d, at)
      trimTranscript(d)
      return d
    }
    default:
      return state
  }
}

/* ---------------- viewer 传输层竞态守卫 ----------------
 * 这些判断不依赖 React/浏览器全局，放在纯模块里（而不是 useRelay.ts）才能被
 * node --test 直接 import 覆盖；transcript.ts 仍然不引入任何 UI 依赖。
 */

/** socket 代际守卫：connect() 换代后，旧 socket 的迟到帧必须整帧丢弃，
 *  否则旧连接上的 room_event 会被当成当前连接的事件再 dispatch 一次（流式翻倍/串房）。
 *  onclose 已有同一守卫，onmessage 入口同样需要。只接受文本（JSON）帧。 */
export function acceptSocketFrame(frameGen: number, currentGen: number, data: unknown): data is string {
  return frameGen === currentGen && typeof data === "string"
}

/** 普通发送失败时退回草稿：只有输入框仍为空、或仍是这条发送文本时才回填；
 *  失败在飞期间用户新打的字必须原样保留（不能被失败回滚覆盖）。 */
export function draftAfterSendFailure(current: string, sent: string): string {
  if (!current.trim()) return sent
  if (current.trim() === sent.trim()) return sent
  return current
}

/** 每台设备独立的 get_sessions 请求序号：同一设备只允许最新一次请求落地，
 *  并发拉取别的设备时互不作废（只接受 (deviceId, ticket) 都匹配的响应）。 */
export type DeviceRequestTickets = {
  issue(deviceId: string): number
  isCurrent(deviceId: string, ticket: number): boolean
}

export function createDeviceRequestTickets(): DeviceRequestTickets {
  const latest = new Map<string, number>()
  return {
    issue(deviceId) {
      const next = (latest.get(deviceId) || 0) + 1
      latest.set(deviceId, next)
      return next
    },
    isCurrent(deviceId, ticket) {
      return ticket > 0 && latest.get(deviceId) === ticket
    },
  }
}
