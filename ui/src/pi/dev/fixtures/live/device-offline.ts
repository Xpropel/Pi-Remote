/** a/device-offline：打开离线设备 ThinkPad 上的 r-s8，可读最后快照；服务器连着。 */
import { BASE, CONVO_OFFLINE, transcriptOf } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "device-offline",
  now: MOCK_NOW,
  note: "r-s8 没有在线房间（room_list 里没有它）；正文是 relay 留的最后快照。",
  relay: {
    ...BASE,
    selectedDeviceId: "d-win",
    roomId: "r-s8",
    online: false,
    roomDown: true,
    transcript: transcriptOf(CONVO_OFFLINE),
    usage: null,
  },
}
export default fixture
