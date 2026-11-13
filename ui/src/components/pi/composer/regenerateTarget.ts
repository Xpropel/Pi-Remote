import type { Item } from "../../../relay/transcript.ts"

/** 重新回答会重发的那条用户消息：text 为空 = 只有图片（扩展会拒绝，图片本来也不重发） */
export interface PiRegenerateTarget {
  text: string
  images: number
}

/** 和扩展 cmdRegenerate 取同一条：最后一条已交给 pi 的用户消息；发送失败、还在发、排队等注入的都不算 */
export function regenerateTargetOf(items: readonly Item[]): PiRegenerateTarget | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind !== "user" || item.failed || item.queued || item.status === "sending" || item.status === "awaiting") continue
    return { text: item.text.trim(), images: item.images.length }
  }
  return null
}
