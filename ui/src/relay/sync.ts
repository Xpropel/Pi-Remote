/**
 * 镜像同步状态机（不依赖 React，便于单测）。
 *
 * relay 存储给每条落盘记录（message_end / remote_message）分配递增 seq，存储被重置时换新 rev。
 *  - 全量快照：{rev, seq, messages}
 *  - 增量快照：{delta:true, rev, baseSeq, seq, messages}——断线重连带 since 的回复，或扩展补尾部后的广播
 *  - room_event：落盘的事件带 {seq, rev}，流式事件不带
 * viewer 记住 {rev, seq}：重复帧丢弃，缺口带 since 补增量，rev 变了要全量。
 */

export type SyncState = { room: string; rev: string | null; seq: number }

export type SyncAction = "full" | "append" | "apply" | "ignore" | "resync-since" | "resync-full"

export const emptySync = (room = ""): SyncState => ({ room, rev: null, seq: 0 })

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

export function snapshotStep(
  sync: SyncState,
  frame: { delta?: unknown; rev?: unknown; seq?: unknown; baseSeq?: unknown },
): { action: SyncAction; next: SyncState } {
  const rev = str(frame.rev)
  const seq = num(frame.seq)
  const seqKnown = typeof frame.seq === "number" && Number.isFinite(frame.seq)
  if (frame.delta !== true) {
    // 全量快照同样是"某世代的某个 seq"：迟到的旧全量（同世代、seq 小于现值）必须整帧忽略，
    // 否则会把已经应用的增量打回去——序号倒退、正文重复出现（UI·relay 中-2）。
    // 无 rev 的旧 relay / 没带 seq 的帧没有可比世代，按原口径整份接受。
    if (rev !== null && sync.rev === rev && seqKnown && seq < sync.seq) return { action: "ignore", next: sync }
    return { action: "full", next: { room: sync.room, rev, seq } }
  }
  if (!rev || rev !== sync.rev) return { action: "resync-full", next: sync }
  const base = num(frame.baseSeq)
  if (base === sync.seq) return { action: "append", next: { ...sync, seq: Math.max(seq, sync.seq) } }
  if (seq <= sync.seq) return { action: "ignore", next: sync }
  return { action: "resync-since", next: sync }
}

export function eventStep(sync: SyncState, seqValue: unknown, revValue: unknown): { action: SyncAction; next: SyncState } {
  const seq = num(seqValue)
  if (!seq) return { action: "apply", next: sync }
  const rev = str(revValue)
  if (rev && rev !== sync.rev) {
    // 房间存储刚被创建（订阅时还没有任何记录）：第一条记录直接接上
    if (!sync.rev && sync.seq === 0 && seq === 1) return { action: "apply", next: { ...sync, rev, seq } }
    return { action: "resync-full", next: sync }
  }
  if (seq <= sync.seq) return { action: "ignore", next: sync }
  if (seq === sync.seq + 1) return { action: "apply", next: { ...sync, seq } }
  return { action: "resync-since", next: sync }
}
