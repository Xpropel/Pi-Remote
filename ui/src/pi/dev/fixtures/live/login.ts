/** a/login：空表单，「连接」禁用（token 去空白后为空）。没有 token、没连过，名册和房间都是空的。 */
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const fixture: PiLiveFixture = {
  id: "login",
  now: MOCK_NOW,
  note: "states 里的「token 错误」= authError 非空（auth_result.ok=false 后 4003 清 token）；这里是空表单。",
  relay: {
    token: "",
    authed: false,
    status: "未连接",
    everConnected: false,
    retryAt: null,
    retryCount: 0,
    trying: false,
    authError: "",
    devices: [],
    rooms: [],
    sessionsByDevice: {},
    selectedDeviceId: null,
    roomId: "",
    online: false,
  },
}
export default fixture
