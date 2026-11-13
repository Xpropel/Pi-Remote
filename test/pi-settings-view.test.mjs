// 生产阻断回归守卫：设置是全局视图，无设备 / 全离线时也必须可达（配对入口不死锁）。
import test from "node:test"
import assert from "node:assert/strict"

test("手机路由：无设备/全离线时 ui.view=settings 仍得到 settings 页（配对可达）", async () => {
  const { phonePageOf } = await import("../ui/src/pi/model/phoneRoute.ts")
  const base = { view: "settings", pane: null, phonePage: "list", search: null, roomId: "" }
  assert.equal(phonePageOf({ ...base, boot: "no-devices" }), "settings")
  assert.equal(phonePageOf({ ...base, boot: "all-offline" }), "settings")
  assert.equal(phonePageOf({ ...base, boot: "ready" }), "settings")
})
