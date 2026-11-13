import type { PiSessionTone, PiSidebarGroup } from "../sidebar/types.ts"

const TONE_RANK: Record<PiSessionTone, number> = { idle: 0, running: 1, waiting: 2, error: 3 }

export const MOBILE_GROUP_TONE_LABEL: Record<Exclude<PiSessionTone, "idle">, string> = {
  running: "有会话在运行",
  waiting: "有会话在等你",
  error: "有会话出错",
}

/** 折叠的组在组头挂组内最需要注意的状态（出错 > 等你 > 运行，同桌面侧栏）；全空闲不挂。只是状态点，不是会话数 */
export function mobileGroupToneOf(group: PiSidebarGroup): PiSessionTone {
  let tone: PiSessionTone = "idle"
  for (const session of group.sessions) if (TONE_RANK[session.status.tone] > TONE_RANK[tone]) tone = session.status.tone
  return tone
}
