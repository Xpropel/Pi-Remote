/** P4 画廊 fixture：composer 草稿以 "@" 结尾 → 提及菜单（CX-COMP-08）默认展开。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "p4-mention",
  now: MOCK_NOW,
  note: "draft 以 @ 结尾，Codex 变体 composer 的 @ 文件/插件提及菜单渲染 CX-COMP-08。",
  relay: { ...BASE, draft: "@", roomId: "r-s1" },
}
export default fixture
