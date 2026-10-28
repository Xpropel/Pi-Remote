/** c/slash-menu：输入「/」，空查询分组浏览：常用 → 内置 → 本机资源（get_commands 的 1 个模板 + 1 个技能）。 */
import { BASE, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

/** get_commands 回包（replica c/mock.ts SLASH_RESOURCES 的来源） */
export const GET_COMMANDS = {
  commands: [
    { name: "review-pr", description: "按团队清单审一遍改动", source: "prompt", kind: "prompt" },
    { name: "release-notes", description: "从提交记录整理发布说明", source: "skill", kind: "skill" },
  ],
}

const fixture: PiLiveFixture = {
  id: "slash-menu",
  now: MOCK_NOW,
  note: "常用组按 slashUsage 计数（本机 localStorage 的 pi_remote_slash_usage_v1），不是 relay 字段；内置清单在 chat/slash.tsx 的 COMMANDS（.tsx，node 测试加载不了）。",
  relay: {
    ...BASE,
    draft: "/",
    // get_git_branch（扩展回包 { branch, repoRoot, detached }）给状态行的分支：P5 c 线加
    runCommand: commandTable({ get_commands: GET_COMMANDS, get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }),
  },
}
export default fixture
