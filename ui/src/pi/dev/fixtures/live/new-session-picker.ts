/** c/new-session-picker：新建会话的目录选择打开：只能选 MacBook Pro 的 projects；「最近」按会话 updatedAt。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "new-session-picker",
  now: MOCK_NOW,
  note: "选择器开着是界面状态。「最近」由容器从 sessionsByDevice 的 updatedAt 排出来，不是 relay 字段。",
  relay: {
    ...BASE,
    roomId: "",
    online: false,
    transcript: { items: [], liveKey: null, seq: 0, bashKey: null, pendingTools: {} },
    usage: null,
  },
}
export default fixture
