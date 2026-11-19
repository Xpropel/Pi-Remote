import test, { describe } from "node:test"
import assert from "node:assert/strict"
import {
  DEVICE_HUB_PICKED_KEY,
  deviceHubCardsOf,
  hasHubDeepLink,
  platformKindOf,
  platformLabelOf,
  readDeviceHubPicked,
  shouldAutoOpenDeviceHub,
  writeDeviceHubPicked,
} from "../ui/src/pi/model/deviceHub.ts"

describe("deviceHub model", () => {
  test("深链判断：?session= 或 ?device= 非空视为深链", () => {
    assert.equal(hasHubDeepLink(""), false)
    assert.equal(hasHubDeepLink("?"), false)
    assert.equal(hasHubDeepLink("?session=%20%20&device="), false)
    assert.equal(hasHubDeepLink("?device=mac-1"), true)
    assert.equal(hasHubDeepLink("?session=room-1"), true)
    assert.equal(hasHubDeepLink("?device=mac-1&session=room-1"), true)
  })

  test("自动弹窗：仅产品模式、非静态、已登录、无深链且未选过时开启；按 startView 决定", () => {
    const base = { isProduct: true, isStatic: false, token: "tok", search: "", hubPicked: false }
    assert.equal(shouldAutoOpenDeviceHub(base), true)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, startView: "hub" }), true)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, startView: "last" }), false)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, startView: "list" }), false)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, isProduct: false }), false)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, isStatic: true }), false)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, token: "   " }), false)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, search: "?session=s1" }), false)
    assert.equal(shouldAutoOpenDeviceHub({ ...base, hubPicked: true }), false)
  })

  test("sessionStorage 读写：安全持久化与清理", () => {
    const mem = new Map()
    const storage = {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    }
    assert.equal(readDeviceHubPicked(storage), false)
    writeDeviceHubPicked(true, storage)
    assert.equal(mem.get(DEVICE_HUB_PICKED_KEY), "1")
    assert.equal(readDeviceHubPicked(storage), true)
    writeDeviceHubPicked(false, storage)
    assert.equal(readDeviceHubPicked(storage), false)
  })

  test("平台映射与卡片汇总：在线优先、运行计数、目录去重与离线文案", () => {
    assert.equal(platformKindOf("darwin"), "mac")
    assert.equal(platformLabelOf("darwin"), "macOS")
    assert.equal(platformKindOf("win32"), "windows")
    assert.equal(platformLabelOf("win32"), "Windows")
    assert.equal(platformKindOf("linux"), "linux")
    assert.equal(platformLabelOf("linux"), "Linux")

    const devices = [
      {
        id: "d-off",
        accountId: "a",
        name: "Ubuntu Box",
        platform: "linux",
        online: false,
        projects: ["/srv/api"],
        browseRoots: [],
        lastAttachAt: 1000,
        firstSeenAt: 1000,
        windowExpiresAt: null,
        auth: "token",
      },
      {
        id: "d-on",
        accountId: "a",
        name: "MacBook Pro",
        platform: "darwin",
        online: true,
        projects: ["/Users/a/CLI/Pi-Remote", "/Users/a/CLI/Docs"],
        browseRoots: ["/Users/a/CLI/Pi-Remote"],
        lastAttachAt: 2000,
        firstSeenAt: 2000,
        windowExpiresAt: null,
        auth: "token",
      },
    ]
    const rooms = [
      {
        id: "r1",
        label: null,
        name: "重构设备面板",
        cwd: "/Users/a/CLI/Pi-Remote",
        online: true,
        busy: true,
        viewers: 1,
        lastActivity: 5000,
        deviceId: "d-on",
      },
    ]
    const sessionsByDevice = {
      "d-off": [
        {
          id: "s-off",
          name: "旧任务",
          firstMessage: "排查 nginx",
          cwd: "/srv/api",
          updatedAt: 1200,
          path: "/srv/api/s-off.jsonl",
        },
      ],
    }

    const cards = deviceHubCardsOf({
      devices,
      rooms,
      sessionsByDevice,
      selectedDeviceId: "d-on",
    })
    assert.equal(cards.length, 2)
    assert.equal(cards[0].id, "d-on", "在线设备排第一")
    assert.equal(cards[0].selected, true)
    assert.equal(cards[0].runningCount, 1)
    assert.equal(cards[0].activityLabel, "1 个会话运行中")
    assert.equal(cards[0].recentTitle, "重构设备面板")
    assert.deepEqual(cards[0].folders, ["Pi-Remote", "Docs"])

    assert.equal(cards[1].id, "d-off")
    assert.equal(cards[1].online, false)
    assert.equal(cards[1].activityLabel, "离线 · 1 个历史会话")
    assert.equal(cards[1].recentTitle, "旧任务")
    assert.deepEqual(cards[1].folders, ["api"])
  })
})
