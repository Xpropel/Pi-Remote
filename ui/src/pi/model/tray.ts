/**
 * 功能 tray 与排队面板（design §1.7、§6.4 PiTrayItem、§10；v1.2 D-06，v1.3 R2-M-10）。纯函数，node --test 直接加载。
 * outbox 只用下面的最小结构类型；P5.6 的 OutboxEntry 满足它，这里不 import outbox.ts。
 */
import type { RemoteQueueItem } from "../../relay/remoteQueue.ts"

/** outbox 条目的最小视图（lane-outbox 的 OutboxEntry 结构上满足它）。awaiting = 已到设备、等 pi 确认（B-3）。 */
export type PiOutboxItemView = { cid: string; text: string; status: "queued" | "replaying" | "awaiting" | "failed"; handedAt?: number }

/** 本机队列（useRelay 的 queue：queue_update 的 steering + followUp）。条目形状这里不关心，只取文字。 */
export type PiLocalQueue = { steering: readonly unknown[]; followUp: readonly unknown[] }

export type PiTrayKind = "tasks" | "subagents" | "queue" | "terminal" | "changes"
/** 与 components/pi/composer 的 PiTrayItem 同形 */
export type PiTrayItem = { kind: PiTrayKind; label: string; running?: boolean; added?: number; removed?: number; active?: boolean; title?: string }

export type PiTrayInput = {
  /** relay.taskList */
  taskList?: readonly { status: string }[] | null
  /** active running subagents count or list */
  subagents?: number | readonly unknown[] | null
  /** relay.remoteQueue.items */
  remoteQueue?: readonly Pick<RemoteQueueItem, "status">[] | null
  /** relay.queue */
  localQueue?: PiLocalQueue | null
  outbox?: readonly PiOutboxItemView[] | null
  /** armed schedules (count or entries with optional state) */
  scheduled?: number | readonly { state?: string }[] | null
  /** relay.terminalItems（只看 state） */
  terminals?: readonly { state: string }[] | null
  /** changesOfSession 的汇总；保留入参兼容，当前不再进 tray pill */
  changes?: { added: number; removed: number; files: readonly unknown[] } | null
  /** 与服务器连着 */
  linkOk: boolean
  /** 当前会话的设备在线 */
  deviceOnline: boolean
}

/** 排队计数 = 远程 pending + 本机 steering / followUp + outbox；已注入（及失败）的远程条目不计。 */
export function queueCountOf(input: Pick<PiTrayInput, "remoteQueue" | "localQueue" | "outbox">): number {
  const remote = (input.remoteQueue ?? []).filter((x) => x.status === "pending").length
  const local = (input.localQueue?.steering.length ?? 0) + (input.localQueue?.followUp.length ?? 0)
  return remote + local + (input.outbox?.length ?? 0)
}

/** 定时待触发计数 = 数字直接取非负值，数组只计未写 state 或 state === "armed" 的项。 */
export function scheduledCountOf(input: Pick<PiTrayInput, "scheduled">): number {
  if (typeof input.scheduled === "number") return Number.isFinite(input.scheduled) ? Math.max(0, input.scheduled) : 0
  return (input.scheduled ?? []).filter((x) => !x.state || x.state === "armed").length
}

/** 等重连的条件：pill 后缀与排队面板第一段段名共用（R2-M-10）。 */
function waitingForLink(linkOk: boolean, deviceOnline: boolean): boolean {
  return !linkOk || !deviceOnline
}

/**
 * tray pill 列表，顺序：Tasks → Subagents → Queued → Terminal。
 * 只有正在运行或仍在等待发送的条目才会显示；运行结束或静态项不占输入框上方空间。
 */
export function trayItemsOf(input: PiTrayInput): PiTrayItem[] {
  const items: PiTrayItem[] = []
  const tasks = input.taskList ?? []
  if (tasks.some((x) => x.status === "in_progress")) {
    const done = tasks.filter((x) => x.status === "completed").length
    items.push({
      kind: "tasks",
      label: `Tasks ${done}/${tasks.length}`,
      running: true,
      title: "Running tasks — click to view progress",
    })
  }
  const subagentCount = typeof input.subagents === "number" ? input.subagents : (input.subagents?.length ?? 0)
  if (subagentCount > 0) {
    items.push({
      kind: "subagents",
      label: subagentCount > 1 ? `Subagents ${subagentCount}` : "Subagent 1",
      running: true,
      title: "Running subagent — click to jump to live activity",
    })
  }
  const queued = queueCountOf(input)
  const scheduled = scheduledCountOf(input)
  if (queued > 0 || scheduled > 0) {
    const suffix = (input.outbox?.length ?? 0) > 0 && waitingForLink(input.linkOk, input.deviceOnline) ? " · Reconnecting" : ""
    const label =
      queued > 0 && scheduled > 0
        ? `Queued ${queued} · Scheduled ${scheduled}${suffix}`
        : queued > 0
          ? `Queued ${queued}${suffix}`
          : `Scheduled ${scheduled}`
    const title =
      queued > 0 && scheduled > 0
        ? "Queued and scheduled messages — click to edit, cancel, or send now"
        : queued > 0
          ? "Queued messages — click to edit, cancel, or send now"
          : "Scheduled messages — click to view, add, or cancel"
    items.push({
      kind: "queue",
      label,
      title,
    })
  }
  const runningTerminals = (input.terminals ?? []).filter((x) => x.state === "running").length
  if (runningTerminals > 0) {
    items.push({
      kind: "terminal",
      label: `Terminal ${runningTerminals}`,
      running: true,
      title: "Running command — click to open terminal",
    })
  }
  return items
}

export type PiQueueSection =
  | { kind: "outbox"; title: string; items: PiOutboxItemView[] }
  | { kind: "remote"; title: string; items: RemoteQueueItem[] }
  | { kind: "local"; title: string; items: { segment: "steer" | "follow_up"; text: string }[] }

/** 本机队列条目（AgentMessage）里的文字；取不到就是空串（面板照样占一行，不编内容）。 */
function messageText(message: unknown): string {
  if (typeof message === "string") return message
  if (!message || typeof message !== "object") return ""
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n")
  }
  return ""
}

/**
 * 排队面板三段（§1.7），顺序固定，空段省略：
 * ①"本页待发 · 等重连"（outbox；连着且设备在线时只写"本页待发"，v1.3 R2-M-10）→ ②"网页发的"（远程待发，已注入的不出）→ ③"终端里排的 · 只读"。
 */
export function queueSectionsOf(
  remoteQueue: readonly RemoteQueueItem[] | null | undefined,
  localQueue: PiLocalQueue | null | undefined,
  outbox: readonly PiOutboxItemView[] | null | undefined,
  linkOk: boolean,
  deviceOnline: boolean,
): PiQueueSection[] {
  const sections: PiQueueSection[] = []
  if (outbox && outbox.length > 0) {
    sections.push({ kind: "outbox", title: waitingForLink(linkOk, deviceOnline) ? "本页待发 · 等重连" : "本页待发", items: [...outbox] })
  }
  const remote = (remoteQueue ?? []).filter((x) => x.status !== "injected")
  if (remote.length > 0) sections.push({ kind: "remote", title: "网页发的", items: remote })
  const local = [
    ...(localQueue?.steering ?? []).map((m) => ({ segment: "steer" as const, text: messageText(m) })),
    ...(localQueue?.followUp ?? []).map((m) => ({ segment: "follow_up" as const, text: messageText(m) })),
  ]
  if (local.length > 0) sections.push({ kind: "local", title: "终端里排的 · 只读", items: local })
  return sections
}
