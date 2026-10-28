/**
 * 被删会话信号（relay.purgedRoom）的容器层决策（UI 低危：延迟处理误弹新建页）。
 *
 * useRelay 只发一次性信号；PiAppBody 的 effect 要等 roomId 真正清空后才切新建页。
 * 原来只按「信号 at 去重 + roomId 非空就等」处理：如果用户在等待期间自己打开了别的
 * 会话 / 新建页 / 设置页，信号会一直挂着；等 roomId 恰好再次为空（例如离开那个会话）
 * 时，迟到的信号仍会把界面抢去新建页。
 *
 * 这里把判断抽成纯函数：
 *  - idle：没有新信号；
 *  - consume：信号已过期（用户离开会话视图，或已打开另一个会话）→ 只记账，不导航；
 *  - wait：roomId 还指向被删的那个房间 → 等 clearRoom 落地；
 *  - navigate：符合一次性信号的本意 → 进新建会话页。
 *
 * 纯函数，node --test 直接加载。
 */
export type PurgeSignal = { id: string; at: number }

export type PurgeSignalDecision = "idle" | "consume" | "wait" | "navigate"

export type PurgeSignalInput = {
  purge: PurgeSignal | null
  /** 已经处理过的信号时刻（PiAppBody 的 ref） */
  handledAt: number
  /** relay.roomId：当前打开的会话；空串 = 没有会话 */
  roomId: string
  /** ui.view：session / new / settings */
  view: string
}

export function purgeSignalDecision(input: PurgeSignalInput): PurgeSignalDecision {
  const { purge, handledAt, roomId, view } = input
  if (!purge || purge.at === handledAt) return "idle"
  // 用户已经离开会话视图（设置 / 新建页 / 手机别页）：不再事后抢界面
  if (view !== "session") return "consume"
  // 已经打开了另一个会话（不是被删的这个）：说明用户自己走开了，信号过期
  if (roomId && roomId !== purge.id) return "consume"
  // roomId 还是被删的房间：等 clearRoom 把 roomId 清空后的那次 effect
  if (roomId === purge.id) return "wait"
  return "navigate"
}
