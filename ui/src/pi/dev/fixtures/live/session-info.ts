/** a/session-info：r-s1 的标题悬停卡：设备、分支（get_git_branch）、目录、模型 · 思考级别、上下文 30.9%、$3.84、缓存命中 87%。 */
import { BASE, commandTable, PI_REMOTE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "session-info",
  now: MOCK_NOW,
  note: "get_git_branch 的回包照扩展 cmdGetGitBranch 的真实形状 { branch, repoRoot, detached }（G11 已核对，P5 整合时从 { branch } 改过来）。",
  relay: {
    ...BASE,
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: PI_REMOTE, detached: false } }),
  },
}
export default fixture
