/** c/attach-menu：r-s1 空闲，点 + 打开附件菜单；还没有待发图片和引用。 */
import { BASE, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "attach-menu",
  now: MOCK_NOW,
  note: "菜单开着是界面状态（live/seeds-c.ts）。「命令…」在未载入会话里禁用（lazySession 非空），这里是已载入的 r-s1。分支 main 来自 get_git_branch（P5 c 线加）。",
  relay: { ...BASE, runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }) },
}
export default fixture
