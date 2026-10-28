/** c/mention-menu：输入「看一下 @mob」，已选一个引用 shell.css；候选池 = 本会话工具入参里的路径。 */
import { BASE, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "mention-menu",
  now: MOCK_NOW,
  note: "replica 的候选池还含「文件视图读过的文件」（mention.ts 的 viewedMentionFiles，存在本机），不是 relay 字段；这里只有转录里的路径。分支 main 来自 get_git_branch（P5 c 线加）。",
  relay: {
    ...BASE,
    draft: "看一下 @mob",
    pendingFiles: [{ path: "ui/src/shell/shell.css", label: "shell.css" }],
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }),
  },
}
export default fixture
