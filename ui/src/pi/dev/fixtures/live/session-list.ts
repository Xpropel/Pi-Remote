/** a/session-list：已连接，3 台设备 17 个会话，当前 r-s1（MacBook Pro/pi-remote）；别房 r-s6 出错、r-s4 完成未读。 */
import { BASE, commandTable, PI_REMOTE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "session-list",
  now: MOCK_NOW,
  note:
    "replica 的需要处理组有 4 行（多 r-s3 等你回答）：relay 只对当前房间产出 dialog 条目（缺口 G1）；非选中设备掉线（ThinkPad）由侧栏补（G2，P5 a 线）。" +
    "get_git_branch 的回包照扩展 cmdGetGitBranch 的真实形状（G11 已核对）。",
  relay: {
    ...BASE,
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: PI_REMOTE, detached: false } }),
  },
}
export default fixture
