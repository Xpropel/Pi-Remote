/** c/command-palette：⌘K 打开，命令组 + 最近 4 个会话（r-s1…r-s4）；在线，命令可用。 */
import { BASE, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "command-palette",
  now: MOCK_NOW,
  note: "replica 的 r-s3 行首是「等你回答」，relay 拿不到别房的 dialog（缺口 G1），真实函数算出来是空闲。分支 main 来自 get_git_branch（P5 c 线加）。",
  relay: { ...BASE, runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }) },
}
export default fixture
