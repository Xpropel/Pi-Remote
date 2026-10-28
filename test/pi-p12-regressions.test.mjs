// P12 bug 门控回归：settings/new 不被 connecting/本地页压住；Codex 设备组可配对。
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

test("P12 中-1：CodexDesktop 设置/新建优先于本地页，进入时清本地页", async () => {
  const file = await read("ui/src/pi/variants/codex/shell/CodexDesktop.tsx")
  const settingsBranch = file.indexOf('ui.view === "settings" && !localPage')
  const localBranch = file.indexOf('localPage === "plugins"')
  assert.ok(settingsBranch >= 0 && localBranch >= 0)
  assert.ok(settingsBranch < localBranch, "设置分支应先于本地页")
  assert.match(file, /const openSettings = \(\) => \{\s*setLocalPage\(null\)/s)
  assert.match(file, /const startNewSession = \(\) => \{\s*setLocalPage\(null\)/s)
})

test("P12 中-3：Codex 设置设备组有配对新设备行，且误注文案已移除", async () => {
  const file = await read("ui/src/pi/variants/codex/pages/CodexSettingsPage.tsx")
  assert.equal(file.includes("配对新设备…"), true)
  assert.equal(file.includes("配对码在电脑上生成；配对后这台浏览器就连上你的 relay。"), false)
  assert.match(file, /onOpenPairing/)
})
