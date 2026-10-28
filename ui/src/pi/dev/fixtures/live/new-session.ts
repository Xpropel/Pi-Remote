/** c/new-session：在 MacBook Pro 上新建会话：还没打开房间，选择器预选 pi-remote，输入框为空（黑圆钮浅灰）。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "new-session",
  now: MOCK_NOW,
  note: "选中的目录（pi-remote）是 NewSessionContainer 的本地状态；发送时才 harness_start（决定 12）。",
  relay: {
    ...BASE,
    roomId: "",
    online: false,
    transcript: { items: [], liveKey: null, seq: 0, bashKey: null, pendingTools: {} },
    pendingStarts: {},
    usage: null,
  },
}
export default fixture
