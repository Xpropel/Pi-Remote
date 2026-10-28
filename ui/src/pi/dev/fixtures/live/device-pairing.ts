/** a/device-pairing：管理员令牌已存，pair_create 回了 8 位码（剩 9:12），等新设备出现；已登记 3 台设备。 */
import { BASE, commandTable, PI_REMOTE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

/** pair_create 回包（replica a/mock.ts A_PAIR） */
export const PAIR = { code: "K7Q4MX2P", expiresAt: MOCK_NOW + 9 * 60_000 + 12_000 }

const fixture: PiLiveFixture = {
  id: "device-pairing",
  now: MOCK_NOW,
  note: "配对码是 PairingContainer 打开后点「生成配对码」拿到的（静态态 = 已经生成过一次）；弹窗开着是界面状态（seeds-a.ts）。",
  relay: {
    ...BASE,
    adminToken: "fixture-admin-token",
    createPairCode: async () => PAIR,
    revokeDevice: async () => {},
    runCommand: commandTable({ get_git_branch: { branch: "main", repoRoot: PI_REMOTE, detached: false } }),
  },
}
export default fixture
