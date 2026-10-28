/** c/composer-keyboard：S1：两行草稿 + 1 个 @ 引用 + 1 张待发图（jpeg）；手机键盘开着（可视视口 508）。 */
import { BASE, VIEWPORT_PATH, commandTable } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "composer-keyboard",
  now: MOCK_NOW,
  note: "键盘开着、可视视口 508 是浏览器状态（useMobileViewport），不在 relay 里；待发图不带像素（data 为空），replica 的「96 KB」在产品里由 base64 长度推出，fixture 推不出。分支 main 来自 get_git_branch（扩展回包 { branch, repoRoot, detached }，P5 c 线加）。",
  relay: {
    ...BASE,
    draft: "横屏的时候也测一下，键盘弹出时\n输入框要一直贴着键盘",
    pendingImages: [{ data: "", mimeType: "image/jpeg" }],
    pendingFiles: [{ path: VIEWPORT_PATH, label: "useMobileViewport.ts" }],
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: "/Users/dev/code/pi-remote", detached: false } }),
  },
}
export default fixture
