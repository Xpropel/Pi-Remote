// 生产阻断回归守卫：Claude 设置/新建是全局视图，必须优先于工作区 tab（任务/工作台）渲染。
// 背景：2026-10-27 用户反馈「切到 Claude UI 后点设置无反应」——ui.view="settings" 被 !chatMode 分支吞掉。
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(`../ui/src/pi/variants/claude/shell/${path}`, import.meta.url), "utf8")

test("Claude 桌面壳：settings/new 分支先于 !chatMode 工作区分支", async () => {
  const source = await read("ClaudeDesktopShell.tsx")
  const settingsAt = source.indexOf('ui.view === "settings"')
  const newAt = source.indexOf('ui.view === "new"')
  const chatModeAt = source.indexOf("!chatMode ? (")
  const bootAt = source.indexOf("!ready ? (")
  assert.ok(settingsAt > 0, "缺少 ui.view === \"settings\" 分支")
  assert.ok(newAt > 0, "缺少 ui.view === \"new\" 分支")
  assert.ok(chatModeAt > 0, "缺少 !chatMode 工作区分支")
  assert.ok(bootAt > 0, "缺少 !ready Boot 分支")
  assert.ok(settingsAt < chatModeAt, "settings 分支必须在 !chatMode 之前（否则点设置无反应）")
  assert.ok(newAt < chatModeAt, "new 分支必须在 !chatMode 之前")
  assert.ok(settingsAt < bootAt, "settings 分支必须在 !ready 之前（设备全离线时设置仍可达，避免配对死锁）")
  assert.ok(newAt < bootAt, "new 分支必须在 !ready 之前")
})

test("Claude 手机壳：settings/new push 页先于 workspace!==chat 模式页", async () => {
  const source = await read("ClaudePhoneShell.tsx")
  const settingsAt = source.indexOf('page === "settings"')
  const newAt = source.indexOf('page === "new"')
  const workspaceAt = source.indexOf("if (workspace !== \"chat\") return <PhoneModePage")
  assert.ok(settingsAt > 0 && newAt > 0 && workspaceAt > 0)
  assert.ok(settingsAt < workspaceAt, "手机 settings 页必须在 workspace 模式页之前")
  assert.ok(newAt < workspaceAt, "手机 new 页必须在 workspace 模式页之前")
})


test("手机路由：无设备/全离线时 ui.view=settings 仍得到 settings 页（配对可达）", async () => {
  const { phonePageOf } = await import("../ui/src/pi/model/phoneRoute.ts")
  const base = { view: "settings", pane: null, phonePage: "list", search: null, roomId: "" }
  assert.equal(phonePageOf({ ...base, boot: "no-devices" }), "settings")
  assert.equal(phonePageOf({ ...base, boot: "all-offline" }), "settings")
  assert.equal(phonePageOf({ ...base, boot: "ready" }), "settings")
})

test("Claude 设置页离线仍有配对入口（设备卡片「配对新设备…」）", async () => {
  const source = await readFile(new URL("../ui/src/pi/variants/claude/pages/ClaudeSettingsPage.tsx", import.meta.url), "utf8")
  assert.equal(source.includes("配对新设备…"), true)
  assert.equal(source.includes("还没有设备。配对新设备后"), true)
})
