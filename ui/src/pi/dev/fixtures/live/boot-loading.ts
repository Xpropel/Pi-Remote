/** a/boot-loading：首次连接（LinkView first），已发 auth、没收到 auth_result / room_list；名册和房间为空。 */
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "boot-loading",
  now: MOCK_NOW,
  note: "主区「正在连接 relay.example.com…」的 host 来自页面 location，不是 relay 字段。",
  relay: {
    token: "fixture-viewer-token",
    authed: false,
    status: "连接中",
    everConnected: false,
    retryAt: null,
    retryCount: 0,
    trying: true,
    authError: "",
    deviceMode: false,
    devices: [],
    rooms: [],
    sessionsByDevice: {},
    sessionsLoading: false,
    selectedDeviceId: null,
    roomId: "",
    online: false,
    snapshotPending: false,
  },
}
export default fixture
