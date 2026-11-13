// P12 bug 门控回归：settings/new 不被 connecting 压住。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

const ROOT = new URL("../", import.meta.url)
const read = (path) => fs.readFile(new URL(path, ROOT), "utf8")
const { phonePageOf } = await import("../ui/src/pi/model/phoneRoute.ts")

test("P12 高-2：connecting 时 settings/new 仍可路由（不被 connecting 门压住）", () => {
  const base = { boot: "connecting", view: "settings", pane: null, phonePage: "list", search: null, roomId: "", opening: false }
  assert.equal(phonePageOf(base), "settings")
  assert.equal(phonePageOf({ ...base, view: "new" }), "new")
  // connecting 下普通会话视图仍是列表页（connecting 只压会话视图）
  assert.equal(phonePageOf({ ...base, view: "session" }), "list")
})

test("P12 高-1：Cursor DesktopApp 设置/新建分支在 connecting 之前", async () => {
  const file = await read("ui/src/pi/containers/DesktopApp.tsx")
  const settings = file.indexOf('ui.view === "settings"')
  const connecting = file.indexOf('boot === "connecting"')
  assert.ok(settings >= 0 && connecting >= 0)
  assert.ok(settings < connecting, "settings 分支应先于 connecting")
})
