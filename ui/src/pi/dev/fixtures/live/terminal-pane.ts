/** b/terminal-pane：r-s1 运行中，本会话 3 条命令：git diff --stat 成功、npm run lint 失败、横屏用例运行中；结束的两条还在保留期内。 */
import { STREAMING } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "terminal-pane",
  now: MOCK_NOW,
  relay: { ...STREAMING },
}
export default fixture
