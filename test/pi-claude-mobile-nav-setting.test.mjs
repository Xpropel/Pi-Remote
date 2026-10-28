// task-35 收尾：Claude 设置页必须挂共享「移动端交互 UI」两卡（与 Codex/Cursor 同组件），改 prefs.mobileNav。
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

test("Claude 设置页挂 MobileNavSetting 且写 prefs.mobileNav", async () => {
  const source = await readFile(new URL("../ui/src/pi/variants/claude/pages/ClaudeSettingsPage.tsx", import.meta.url), "utf8")
  assert.equal(source.includes('from "@/pi/mobile"'), true)
  assert.equal(source.includes("MobileNavSetting"), true)
  assert.equal(source.includes('{ id: "mobile", label: "移动端" }'), true)
  assert.equal(source.includes('setPref("mobileNav"'), true)
  assert.equal(source.includes("p.ui.prefs.mobileNav"), true)
})
