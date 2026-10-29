/**
 * 一行实时状态（设计 D §2.2）：一个纯函数，全 UI 共用——attention 条目的 detail
 * 与会话行状态（侧边栏时间位/悬停气泡/移动端第二行/会话信息卡）都吃它，
 * 杜绝各写各的文案。输入只用已下发字段（online / busy / waiting /
 * waitingPrompt / lastTurnEnd / lastActivity）+ relay 的 lastEvent 摘要
 * （cap room.activity，设计 D §2.3）；只用事件类型与工具名这类元数据，
 * 绝不取命令正文/文件内容/消息正文。
 *
 * 相对时间全 UI 统一走 devices.relativeTime（刚刚 / N 分钟前 / N 小时前 /
 * N 天前 / M 月 D 日）；状态行的重算节拍由列表层的一个低频 tick（30 秒）
 * 驱动，本函数不持有任何定时器。
 */
// test/*.test.mjs 用 node 直接跑 .ts 源文件，相对导入必须带扩展名
import { relativeTime, type RoomLastEvent, type RoomWaiting, type RoomWaitingPrompt } from "./devices.ts"

export type RoomStatusTone = "waiting" | "error" | "running" | "done" | "idle" | "offline"

export type RoomStatusLine = { text: string; tone: RoomStatusTone }

/** 状态行的输入（结构化子集：RoomInfo 的相关字段 + 调用方手里的未读落定摘要）。 */
export type RoomStatusInput = {
  online: boolean
  busy: boolean
  /** 未决 dialog 摘要（room.dialogs）；离线房间恒空 */
  waiting?: readonly Pick<RoomWaiting, "kind" | "startedAt">[] | null
  /** 旧单槽 ui_prompt 兜底信号；只在 waiting 为空时有意义 */
  waitingPrompt?: RoomWaitingPrompt | null
  /** 未读的回合落定摘要（在场房间由调用方按"进房即已读"口径传 null）；旧 relay 无此面时不传 */
  lastTurnEnd?: { kind: "done" | "error"; at: number } | null
  /** 最近事件摘要（room.activity）；旧 relay 不下发时为 null/缺失 */
  lastEvent?: RoomLastEvent | null
  /** 最近活动时刻（离线/空闲行的相对时间用）；0 = 无 */
  lastActivity?: number
  /** 回合开始时刻（可选）：busy 且无 lastEvent 时回落用；没有就只写"运行中" */
  turnStartedAt?: number
}

/**
 * dialog 等待短语（与 attention.ts 的 dialogWaitingText 同表：select/confirm/
 * input/editor 三档同文案；未知种类在状态行里回落"等你回复"——attention 的
 * detail 默认句是"有弹窗等你处理"，两处面向不同（detail 是说明句、这里是状态短语），
 * 三个具名种类严格同表，未知种类不强求一致）。
 */
export function dialogStatusPhrase(kind: string): string {
  switch (kind) {
    case "select":
      return "等你选择"
    case "confirm":
      return "等你确认"
    case "input":
    case "editor":
      return "等你输入"
    default:
      return "等你回复"
  }
}

/** 文件类工具（事件短语映射用）：读/写/改文件归一类。工具名是协议元数据，非正文。 */
const FILE_TOOLS = new Set(["read", "edit", "write"])

/**
 * 最近事件 → 状态短语（设计 D §2.2 映射表）。只用事件类型与工具名；
 * 未知类型/缺工具名返回 null，调用方回落到"运行中"行。
 */
export function roomEventPhrase(event: RoomLastEvent | null | undefined): string | null {
  if (!event || typeof event.type !== "string") return null
  switch (event.type) {
    case "tool_execution_start": {
      const tool = typeof event.toolName === "string" ? event.toolName : ""
      if (!tool) return null
      if (tool === "bash") return "正在执行命令"
      if (FILE_TOOLS.has(tool)) return "正在读写文件"
      return `正在使用 ${tool}`
    }
    case "message_update":
      return "正在回复"
    case "turn_start":
    case "agent_start":
      return "正在思考"
    case "compaction_start":
      return "正在压缩上下文"
    default:
      return null
  }
}

/** "短语 · 相对时间"拼装：没有可用时刻（0/非法）时只出短语，不挂空尾巴。 */
function withTime(phrase: string, at: number | undefined, now: number): string {
  const rel = at ? relativeTime(at, now) : ""
  return rel ? `${phrase} · ${rel}` : phrase
}

/**
 * 房间 → 一行状态（设计 D §2.2 文案表，优先级自上而下先命中先用）：
 * 离线 > waiting（多条取最早）> waitingPrompt 兜底 > busy+lastEvent >
 * busy 无 lastEvent（旧 relay 回落）> 未读 error > 未读 done > 空闲。
 */
export function roomStatusLine(room: RoomStatusInput, now: number): RoomStatusLine {
  if (!room.online) {
    return { text: withTime("已结束", room.lastActivity, now), tone: "offline" }
  }
  const waiting = room.waiting ?? []
  if (waiting.length) {
    let earliest = waiting[0]
    for (const w of waiting) if ((w.startedAt || 0) < (earliest.startedAt || 0)) earliest = w
    return { text: withTime(dialogStatusPhrase(earliest.kind), earliest.startedAt, now), tone: "waiting" }
  }
  if (room.waitingPrompt) {
    return { text: withTime("等你处理", room.waitingPrompt.at, now), tone: "waiting" }
  }
  if (room.busy) {
    const phrase = roomEventPhrase(room.lastEvent)
    if (phrase) return { text: `运行中 · ${phrase}`, tone: "running" }
    if (room.turnStartedAt) return { text: withTime("运行中", room.turnStartedAt, now), tone: "running" }
    return { text: "运行中", tone: "running" }
  }
  if (room.lastTurnEnd?.kind === "error") {
    return { text: withTime("出错了", room.lastTurnEnd.at, now), tone: "error" }
  }
  if (room.lastTurnEnd?.kind === "done") {
    return { text: withTime("已完成", room.lastTurnEnd.at, now), tone: "done" }
  }
  return { text: withTime("空闲", room.lastActivity, now), tone: "idle" }
}
