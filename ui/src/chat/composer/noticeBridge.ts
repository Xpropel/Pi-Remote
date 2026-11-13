/** 旧 `Notice` 单槽 → 第 5 章通知栈 V2 的过渡分流（纯逻辑，可单测）。
 *
 *  只按稳定 code 分通道，**绝不按 title/body 文案猜类别**：
 *  - connectivity → 连接状态片
 *  - progress / compaction / summarization / truncated / lazy-send → 输入区状态行
 *  - 其余 → noticeCore 通知栈（槽位准入在 noticeCore 里再兜一层）
 *
 *  这样既有调用点的文案不用改，改文案也不会改变生命周期。
 */

import { NOTICE_CONNECTIVITY_CODES, NOTICE_PROGRESS_CODES, type NoticeInput } from "../noticeCore.ts"
import { httpStatusOf, TURN_ERROR_TEXT, turnErrorKindOf } from "../../pi/model/turnError.ts"

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

/** 旧 tone → noticeCore level：bad=error（12s），warn=warning（8s）。 */
export function noticeLevelForTone(tone: LegacyNoticeTone): "warning" | "error" {
  return tone === "bad" ? "error" : "warning"
}

/** 断线期间推出的提示（命令被拒「连接不可用」等）归这个 scope：同 scope 新的顶掉旧的，重新连上整体撤回。 */
export const NOTICE_LINK_DOWN_SCOPE = "link-down"

/**
 * 旧 setNotice 进栈的入参。旧调用点没有稳定 code：同级 + 原文完全相同 = 同一提示连发，
 * 用它当合并键（×n 计数，不多占一格队列）；不做任何模糊匹配或类别推断。
 * 调用方自带 scope 时照用；否则断线期间推的归 link-down。context 原样带上（noticeCore N9）。
 */
export function legacyNoticeInput(
  notice: { text: string; tone: LegacyNoticeTone; scope?: string; context?: string },
  linkDown: boolean,
): NoticeInput {
  const level = noticeLevelForTone(notice.tone)
  return {
    level,
    title: notice.text,
    scope: notice.scope ?? (linkDown ? NOTICE_LINK_DOWN_SCOPE : undefined),
    dedupeKey: `legacy:${level}:${notice.text}`,
    ...(notice.context ? { context: notice.context } : {}),
  }
}

/** pi 自动重试的提示共用一个 scope：下一次尝试、成功、放弃都顶掉上一张，不排成一串。 */
export const AUTO_RETRY_NOTICE_SCOPE = "auto-retry"

type AutoRetryNotice = { text: string; tone: LegacyNoticeTone; codes?: ["progress"]; scope?: string }
/** pi 的事件帧原样传进来（字段都是 unknown，这里自己验） */
type RetryEvent = Readonly<Record<string, unknown>>

/** 模型服务报错的人话，与流里出错行（turnErrorOf）同一套认法：「模型服务繁忙（529）」；认不出返回 null。 */
function modelErrorReasonOf(errorMessage: unknown): string | null {
  const raw = typeof errorMessage === "string" ? errorMessage.trim() : ""
  const kind = turnErrorKindOf(raw)
  if (!kind) return null
  const status = httpStatusOf(raw)
  return `${TURN_ERROR_TEXT[kind]}${status != null ? `（${status}）` : ""}`
}

/**
 * 重试原因的人话：认不出写「模型服务报错」——原文（常是英文或 JSON）不进提示，出错行的「详情」里有。
 */
export function autoRetryReasonOf(errorMessage: unknown): string {
  return modelErrorReasonOf(errorMessage) ?? "模型服务报错"
}

function countOf(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** auto_retry_start → 「模型服务繁忙（529），正在重试（1/3）」；没带错误原文时只是输入区状态行的过场。 */
export function autoRetryStartNotice(event: RetryEvent): AutoRetryNotice {
  if (!event.errorMessage) return { text: "正在重试", tone: "warn", codes: ["progress"] }
  const attempt = countOf(event.attempt)
  const max = countOf(event.maxAttempts)
  const count = attempt && max ? `（${attempt}/${max}）` : ""
  return { text: `${autoRetryReasonOf(event.errorMessage)}，正在重试${count}`, tone: "warn", scope: AUTO_RETRY_NOTICE_SCOPE }
}

/** pi 在等待间隔里被停止时的 finalError */
const RETRY_CANCELLED = /^retry (?:was )?cancell?ed\.?$/i

/** auto_retry_end → 成功 / 被停止 / 「重试 3 次仍未成功：模型服务繁忙（529）」。 */
export function autoRetryEndNotice(event: RetryEvent): AutoRetryNotice {
  if (event.success) return { text: "重试已成功", tone: "warn", scope: AUTO_RETRY_NOTICE_SCOPE }
  const raw = typeof event.finalError === "string" ? event.finalError.trim() : ""
  if (RETRY_CANCELLED.test(raw)) return { text: "已停止重试", tone: "warn", scope: AUTO_RETRY_NOTICE_SCOPE }
  const attempt = countOf(event.attempt)
  const head = attempt ? `重试 ${attempt} 次仍未成功` : "自动重试没有成功"
  return { text: raw ? `${head}：${autoRetryReasonOf(raw)}` : head, tone: "bad", scope: AUTO_RETRY_NOTICE_SCOPE }
}

/** pi 压缩失败的 errorMessage 前缀（手动 / 阈值自动 / 溢出恢复），冒号后面才是原因 */
const COMPACTION_FAILED_PREFIX = /^(?:(?:auto-)?compaction|context overflow recovery) failed:\s*/i
/** pi 自己写死的几种压缩结果（不是模型服务出错），单独写人话 */
const COMPACTION_OUTCOMES: readonly (readonly [RegExp, string, LegacyNoticeTone])[] = [
  [/^already compacted\b/i, "上下文刚压缩过，没有新内容可压缩", "warn"],
  [/^nothing to compact\b/i, "会话还很短，不需要压缩", "warn"],
  [/^(?:auto-)?compaction cancell?ed\b/i, "上下文压缩已中止", "warn"],
  [/^context overflow recovery failed after\b/i, "压缩后上下文仍超出模型上限，可换用上下文更大的模型", "bad"],
  [/^truncated response recovery failed\b/i, "回复被截断，压缩后重试仍没有恢复", "bad"],
]

/**
 * compaction_end 出错时的提示，原始 errorMessage 不进提示：pi 自己的几种结果单独写；
 * 其余与回合出错同一套认法——「上下文压缩失败：模型服务繁忙（529）」，认不出只写「上下文压缩失败」。
 */
export function compactionErrorNotice(errorMessage: unknown): { text: string; tone: LegacyNoticeTone } {
  const raw = typeof errorMessage === "string" ? errorMessage.trim() : ""
  const reason = raw.replace(COMPACTION_FAILED_PREFIX, "")
  for (const [pattern, text, tone] of COMPACTION_OUTCOMES) if (pattern.test(reason)) return { text, tone }
  const said = modelErrorReasonOf(reason)
  return { text: said ? `上下文压缩失败：${said}` : "上下文压缩失败", tone: "bad" }
}
