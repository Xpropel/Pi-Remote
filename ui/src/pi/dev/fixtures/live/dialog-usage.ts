/** c/dialog-usage：用量与费用弹窗：get_session_stats（48 条 = 你 8 + pi 20 + 工具结果 20）+ r-s1 的 usage_state。 */
import { BASE, USAGE, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

/** get_session_stats 回包（字段名照 data-interface §4.11.2，replica c/mock.ts C_STATS） */
export const SESSION_STATS = {
  sessionFile: "/Users/dev/.pi/agent/sessions/r-s1.jsonl",
  sessionId: "r-s1",
  userMessages: 8,
  assistantMessages: 20,
  toolCalls: 20,
  toolResults: 20,
  totalMessages: 48,
  tokens: USAGE.tokens,
  cost: USAGE.cost,
  costByModel: USAGE.costByModel,
  contextUsage: USAGE.contextUsage,
}

const fixture: PiLiveFixture = {
  id: "dialog-usage",
  now: MOCK_NOW,
  note: "totalMessages 是否含 toolResult 没有验证（notes-c）；这里按含 toolResult 写，和会话清单的 messageCount 48 对上。",
  relay: {
    ...BASE,
    // get_git_branch（扩展回包 { branch, repoRoot, detached }）给状态行的分支：P5 c 线加
    runCommand: commandTable({ get_session_stats: SESSION_STATS, get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }),
  },
}
export default fixture
