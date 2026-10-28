import type { PiRemoteQueueStatus } from "@/components/pi/shared/types"

/**
 * 远程待发队列在网页端的两个小守卫（UI·perf 中-6，纯逻辑，node --test 直接测）。
 *
 * 1. `createSendNowLock`：「立即发送」是**命令**，连点两下就是两条注入指令。上一帧（成功/失败）回来之前
 *    同一个条目按 id 锁住，只下发一次；失败也解锁，用户可以重试。
 * 2. `queueEditInvalidationOf`：编辑稿只在条目还在 pending 时有落点。条目被注入 / 发了 / 失败 / 别处取消后，
 *    编辑器必须作废并告知用户（旧实现只在打开编辑器那一刻查一次可编辑性，之后编辑稿会静默消失）。
 */

export type SendNowLock = {
  /** 抢锁：第一次 true（该发），重复请求 false（忽略） */
  begin(id: string): boolean
  /** 释放：成功 / 失败都要解，失败后用户还能再点 */
  end(id: string): void
  /** 是否有在飞请求（测试与按钮态用） */
  has(id: string): boolean
}

export function createSendNowLock(): SendNowLock {
  const inFlight = new Set<string>()
  return {
    begin(id) {
      if (!id || inFlight.has(id)) return false
      inFlight.add(id)
      return true
    },
    end(id) {
      inFlight.delete(id)
    },
    has(id) {
      return inFlight.has(id)
    },
  }
}

/** 编辑稿失效的原因：sent = 条目已经从 pending 走掉（注入 / 失败 / 取消），gone = 条目不在清单里了 */
export type QueueEditInvalidation = "sent" | "gone"

/**
 * 当前正在编辑的条目还能不能继续编辑：null = 还能；否则给出作废原因。
 * 只认 `status === "pending"`（和 relay/remoteQueue.ts 的 canMutateRemoteQueueItem 同口径）。
 */
export function queueEditInvalidationOf(
  items: readonly { id: string; status: PiRemoteQueueStatus }[],
  id: string,
): QueueEditInvalidation | null {
  const item = items.find((entry) => entry.id === id)
  if (!item) return "gone"
  return item.status === "pending" ? null : "sent"
}
