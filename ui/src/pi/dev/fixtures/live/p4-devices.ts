/** P4 mock 画廊 fixture：多平台设备（mac×2 / win×1 / linux×1 离线）+ 各平台会话，供 `#/p4/CL-SHELL-05` 等平台标签场景。 */
import { BASE, DEVICES, PI_REMOTE, SESSIONS_BY_DEVICE } from "../shared.ts"
import { MOCK_NOW, type PiLiveFixture } from "../types.ts"

const M = 60_000
const H = 60 * M
const D = 24 * H

const fixture: PiLiveFixture = {
  id: "p4-devices",
  now: MOCK_NOW,
  note: "P4 平台标签场景：mac×2（MBP/Studio 在线）、win×1（ThinkPad 离线）、linux×1（离线）；点 Linux 得到「设备未连接」分支，无平台分支需另造空设备 fixture。",
  relay: {
    ...BASE,
    devices: [
      ...DEVICES,
      // Pi 语义：Linux 平台设备（离线）——平台标签/设备筛选的可演示数据
      { id: "d-linux", accountId: "acct-dev", name: "Linux 工作站", platform: "linux", online: false, projects: ["/home/dev/apps/pi-tools"], browseRoots: ["/home/dev"], lastAttachAt: MOCK_NOW - 30 * H, firstSeenAt: MOCK_NOW - 8 * D, windowExpiresAt: null, auth: null, paired: true, latencyMs: null },
    ],
    sessionsByDevice: {
      ...SESSIONS_BY_DEVICE,
      "d-linux": [
        { id: "s-linux-1", name: "", firstMessage: "升级 pi-tools 的构建脚本", path: "/home/dev/.pi/agent/sessions/s-linux-1.jsonl", cwd: "/home/dev/apps/pi-tools", messageCount: 9, sizeBytes: 0, updatedAt: MOCK_NOW - 40 * H, active: false, online: false, parentSession: null },
      ],
    },
    selectedDeviceId: "d-mbp",
    rooms: BASE.rooms,
    // 让侧栏/新建页都看得到全部平台（不预置 deviceFilter）
    deviceMode: true,
    sessionsLoading: false,
    sessionsTruncated: false,
  },
}

/** 供场景表标注（测试断言 fixture 存在；避免 unused 警告） */
export const P4_DEVICES_FIXTURE_ID = fixture.id
export const P4_DEVICES_PROJECT = PI_REMOTE

export default fixture
