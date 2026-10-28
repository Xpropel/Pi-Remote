/** a/session-menu：对 r-s4「整理 README 的配对步骤」（不是当前会话、不忙、已载入）打开会话菜单；当前仍是 r-s1。 */
import { BASE, commandTable, PI_REMOTE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "session-menu",
  now: MOCK_NOW,
  note: "菜单目标 r-s4 是界面状态（右键 / 长按的行，#/live 的 seeds-a.ts），不在 relay 里。",
  relay: {
    ...BASE,
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: PI_REMOTE, detached: false } }),
  },
}
export default fixture
