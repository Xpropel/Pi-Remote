/** b/conversation-streaming：r-s1 运行中，工具执行这一刻（终端卡运行中），任务 2/4、终端 1、改动；一条 explorer subagent。 */
import { STREAMING } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "conversation-streaming",
  now: MOCK_NOW,
  note: "agent_state 目前没有生产者，fixture 照 AgentEntry 形状写了一条，界面按「有上报才出现」画。",
  relay: { ...STREAMING },
}
export default fixture
