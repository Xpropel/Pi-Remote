/** 旧 `Notice` 单槽 → 第 5 章通知栈 V2 的过渡分流（纯逻辑，可单测）。
 *
 *  只按稳定 code 分通道，**绝不按 title/body 文案猜类别**：
 *  - connectivity → 连接状态片
 *  - progress / compaction / summarization / truncated / lazy-send → 输入区状态行
 *  - 其余 → noticeCore 通知栈（槽位准入在 noticeCore 里再兜一层）
 *
 *  这样既有调用点的文案不用改，改文案也不会改变生命周期。
 */

import { NOTICE_CONNECTIVITY_CODES, NOTICE_PROGRESS_CODES } from "../noticeCore.ts"

export type NoticeChannel = "connectivity" | "progress" | "stack"

/** 规范 5.5 的过渡通道：这些过场提示留在 StatusLine，不进通知栈。 */
export const PROGRESS_NOTICE_CODES = NOTICE_PROGRESS_CODES

const PROGRESS = new Set<string>(PROGRESS_NOTICE_CODES)

export function noticeChannel(codes?: readonly string[] | null): NoticeChannel {
  const list = codes ?? []
  if (list.some((code) => (NOTICE_CONNECTIVITY_CODES as readonly string[]).includes(code))) return "connectivity"
  for (const code of list) {
    if (PROGRESS.has(code)) return "progress"
  }
  return "stack"
}

export type LegacyNoticeTone = "warn" | "bad"

/** 旧 tone → noticeCore level：bad=error（常驻），warn=warning（8s）。 */
export function noticeLevelForTone(tone: LegacyNoticeTone): "warning" | "error" {
  return tone === "bad" ? "error" : "warning"
}
