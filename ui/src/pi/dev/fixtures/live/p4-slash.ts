/** P4 画廊 fixture：composer 草稿为 "/" → 斜杠菜单（CX-COMP-06）默认展开，供 #/p4 场景驱动。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "p4-slash",
  now: MOCK_NOW,
  note: "draft 以 / 开头，Codex 变体 composer 的斜杠菜单渲染 CX-COMP-06。",
  relay: { ...BASE, draft: "/", roomId: "r-s1" },
}
export default fixture
