/** a/no-devices：已连接，room_list.devices = []、rooms 为空；relay 声明了 device.token（能配对）。 */
import { BASE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "no-devices",
  now: MOCK_NOW,
  relay: {
    ...BASE,
    devices: [],
    rooms: [],
    sessionsByDevice: {},
    selectedDeviceId: null,
    roomId: "",
    online: false,
    roomTurnEnds: [],
    transcript: { items: [], liveKey: null, seq: 0, bashKey: null, pendingTools: {} },
    usage: null,
  },
}
export default fixture
