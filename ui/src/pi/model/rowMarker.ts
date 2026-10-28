/**
 * 会话行行首标记（design §6.3 PiRowMarker、§4.7 无障碍、§10）。纯函数，node --test 直接加载。
 * test/*.test.mjs 用 node 直接跑 .ts 源文件，相对导入必须带扩展名。
 */
import type { AttentionItem } from "../../relay/attention.ts"
import { relativeTime } from "../../relay/devices.ts"

export type PiRowMarkerKind = "waiting" | "error" | "unread" | "running" | "idle" | "unloaded"

/**
 * 行首标记（复用 attention 的优先级）：等你回答 > 出错未读 > 运行中 > 完成未读 > 未载入 > 空闲。
 * - attention：这一行最要紧的注意力条目（attentionForRoom 的结果），没有就是 null；设备掉线条目不落行。
 * - busy：房间在跑；online 为 false 时不算运行（离线房间不会有进行中的回合）。
 * - loaded：false = 只有本机记录、还没载入的会话（ListedSession.openable 为假）。
 * 离线不改标记，只由行的 dimmed 淡化（§3.3）。
 */
export function rowMarkerOf(
  attention: Pick<AttentionItem, "kind"> | null | undefined,
  busy: boolean,
  online: boolean,
  loaded: boolean,
): PiRowMarkerKind {
  const kind = attention?.kind
  if (kind === "waiting") return "waiting"
  if (kind === "error") return "error"
  if (busy && online) return "running"
  if (kind === "done") return "unread"
  if (!loaded) return "unloaded"
  return "idle"
}

export type PiRowMarkerShape = "question-circle" | "error-dot" | "dot" | "spinner" | "hollow-circle"
export type PiRowMarkerA11y = { hidden: true } | { hidden?: false; shape: PiRowMarkerShape; role: "img"; label: string }

const A11Y: Record<Exclude<PiRowMarkerKind, "idle">, { shape: PiRowMarkerShape; label: string }> = {
  waiting: { shape: "question-circle", label: "等你回答" },
  error: { shape: "error-dot", label: "出错未读" },
  unread: { shape: "dot", label: "完成未读" },
  running: { shape: "spinner", label: "运行中" },
  unloaded: { shape: "hollow-circle", label: "未载入" },
}

/** §4.7 的形状与中文 aria-label；idle 不画，对读屏隐藏。 */
export function rowMarkerA11y(kind: PiRowMarkerKind): PiRowMarkerA11y {
  if (kind === "idle") return { hidden: true }
  const { shape, label } = A11Y[kind]
  return { shape, role: "img", label }
}

/**
 * 行的可访问名（§4.7，v1.3 R2-M-05）："标题，标记 label，时间全称"，例如"退款对账脚本报错，出错未读，38 分钟前"。
 * idle 没有 label 就不写；没有时间戳就不写时间（§1.9，不伪造）。
 */
export function sessionRowName(title: string, kind: PiRowMarkerKind, ts: number | null | undefined, now: number): string {
  const parts = [title]
  const a11y = rowMarkerA11y(kind)
  if (!a11y.hidden) parts.push(a11y.label)
  const time = relativeTime(ts, now)
  if (time) parts.push(time)
  return parts.join("，")
}
