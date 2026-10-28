/** a/reconnecting：和服务器断开，等第 3 次重连（4 秒后）；离线时发的一条进了本页 outbox。列表和流保留最后状态。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "reconnecting",
  now: MOCK_NOW,
  note: "replica 的 dock 标 S5，但输入框是空的；真实状态机 S5 要有内容，空框断线是 S0（占位与原因照样由 composerReasonOf 给）。",
  outbox: [{ cid: "w1k2c9f0", text: "顺便看看横屏的时候是不是也跳", status: "queued" }],
  relay: {
    ...BASE,
    authed: false,
    status: "未连接",
    everConnected: true,
    retryAt: MOCK_NOW + 4000,
    retryCount: 3,
    trying: false,
    online: false,
  },
}
export default fixture
