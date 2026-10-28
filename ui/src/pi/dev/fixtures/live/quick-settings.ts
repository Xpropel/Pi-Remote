/** c/quick-settings：账户区滑杆打开的显示选项：设备筛选（含「全部设备」）→ 分组方式 → 主题 → 工具显示。 */
import { BASE, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "quick-settings",
  now: MOCK_NOW,
  note: "筛选与分组写 prefs（deviceFilter / grouping），不在 relay；设备行的会话数由容器从 sessionsByDevice 数。分支 main 来自 get_git_branch（P5 c 线加，桌面 dock 的状态行）。",
  relay: { ...BASE, runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }) },
}
export default fixture
