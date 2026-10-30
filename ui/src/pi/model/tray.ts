/**
 * 功能 tray 与排队面板（design §1.7、§6.4 PiTrayItem、§10；v1.2 D-06，v1.3 R2-M-10）。纯函数，node --test 直接加载。
 * outbox 只用下面的最小结构类型；P5.6 的 OutboxEntry 满足它，这里不 import outbox.ts。
 */
import type { RemoteQueueItem } from "../../relay/remoteQueue.ts"

/** outbox 条目的最小视图（lane-outbox 的 OutboxEntry 结构上满足它）。 */
export type PiOutboxItemView = { cid: string; text: string; status: "queued" | "replaying" | "failed" }

/** 本机队列（useRelay 的 queue：queue_update 的 steering + followUp）。条目形状这里不关心，只取文字。 */
export type PiLocalQueue = { steering: readonly unknown[]; followUp: readonly unknown[] }

export type PiTrayKind = "tasks" | "queue" | "terminal" | "changes"
/** 与 components/pi/composer 的 PiTrayItem 同形 */
export type PiTrayItem = { kind: PiTrayKind; label: string; running?: boolean; added?: number; removed?: number; active?: boolean; title?: string }

export type PiTrayInput = {
  /** relay.taskList */
  taskList?: readonly { status: string }[] | null
  /** relay.remoteQueue.items */
  remoteQueue?: readonly Pick<RemoteQueueItem, "status">[] | null
  /** relay.queue */
  localQueue?: PiLocalQueue | null
  outbox?: readonly PiOutboxItemView[] | null
  /** relay.terminalItems（只看 state） */
  terminals?: readonly { state: string }[] | null
  /** changesOfSession 的汇总；null = 没有改动数据 */
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

/** 等重连的条件：pill 后缀与排队面板第一段段名共用（R2-M-10）。 */
function waitingForLink(linkOk: boolean, deviceOnline: boolean): boolean {
  return !linkOk || !deviceOnline
}

/**
 * tray pill 列表，顺序：任务 → 排队 → 终端 → 改动。只有有内容的 pill 才出现。
 * 排队：outbox > 0 且（断线或设备离线）时写"排队 N · 等重连"，否则"排队 N"；计数 0 不出。
 */
export function trayItemsOf(input: PiTrayInput): PiTrayItem[] {
  const items: PiTrayItem[] = []
  const tasks = input.taskList ?? []
  if (tasks.length > 0) {
    const done = tasks.filter((x) => x.status === "completed").length
    const item: PiTrayItem = { kind: "tasks", label: `任务 ${done}/${tasks.length}` }
    if (tasks.some((x) => x.status === "in_progress")) item.running = true
    items.push(item)
  }
  const queued = queueCountOf(input)
  if (queued > 0) {
    const suffix = (input.outbox?.length ?? 0) > 0 && waitingForLink(input.linkOk, input.deviceOnline) ? " · 等重连" : ""
    // F4: the pill is the only way into the queue panel -- say so on hover.
    items.push({ kind: "queue", label: `排队 ${queued}${suffix}`, title: "排队中的消息，点开可编辑、取消或立即发送" })
  }
  const terminals = input.terminals ?? []
  if (terminals.length > 0) {
    const running = terminals.filter((x) => x.state === "running").length
    const item: PiTrayItem = { kind: "terminal", label: `终端 ${running || terminals.length}` }
    if (running > 0) item.running = true
    items.push(item)
  }
  const changes = input.changes
  if (changes && changes.files.length > 0) {
    items.push({ kind: "changes", label: `改动 +${changes.added} −${changes.removed}`, added: changes.added, removed: changes.removed })
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
