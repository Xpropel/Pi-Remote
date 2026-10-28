/** b/stream-errors：r-s6（Mac Studio/billing-service）：补拉失败、终端失败、已拒绝 / 超时、回合出错 overloaded_error、用户卡 ack 超时。 */
import { BASE, CONVO_ERRORS, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "stream-errors",
  now: MOCK_NOW,
  note: "replica 的「自动重试 3/3 都没成功」收据在 relay 的 Item 里没有对应种类（缺口 G8）；进入 r-s6 后它的出错条目由 attentionItemsOf 自动去掉。",
  relay: {
    ...BASE,
    selectedDeviceId: "d-studio",
    roomId: "r-s6",
    transcript: transcriptOf(CONVO_ERRORS),
    history: { room: "r-s6", status: "error", error: "没有收到回应", truncated: false, loads: 1, lastAdded: 0 },
    usage: null,
  },
}
export default fixture
