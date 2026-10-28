/** b/changes-pane：r-s1 的会话改动（由 edit / write 记录汇总，不是 git 状态）：3 个文件，viewport 改了两次。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "changes-pane",
  now: MOCK_NOW,
  note: "+32 −9 与行号来自 edit 的 details.patch（transcript 提升到工具块的 patch 字段，G5 前端修）；write 没有 details，只有 +N。",
  relay: { ...BASE },
}
export default fixture
