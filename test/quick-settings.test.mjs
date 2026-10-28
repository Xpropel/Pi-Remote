// R3-2 / P4-1 快捷设置滑出层：入口挂载 / prefs 同源 / 诚实态无假开关 / 关闭路径守卫。
// P7 B2f（决定 17）：旧快捷设置抽屉（shell/QuickSettings.tsx）、TopBar、SettingsPanel、shell.css 删了，读它们的 10 个用例删掉
// （抽屉宽度、玻璃令牌、诚实态灰名单等是设计改动：新界面是 PiSettingsPage + 显示选项 PiDisplayOptions）。
// 「顶栏不挂入口」照 plan §8.3 保留，改查新界面的 PiTopBar。
import test from "node:test"
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8")
const useRelayTs = source("../ui/src/relay/useRelay.ts")



test("应答开关不新造下达通道：下达仍归 useRelay 既有 effect", () => {
  assert.match(useRelayTs, /dialog_answer_switch/)
  assert.match(useRelayTs, /legacyStyle\.dialogRemoteAnswer/, "P7 B4：开关值改读 useLegacyStyle（同一个旧键）")
})
test("顶栏不挂快捷设置入口（P7 B2f 改查新界面 PiTopBar）：顶栏没有设置 / 快捷设置按钮", () => {
  const piTopBar = source("../ui/src/components/pi/shared/PiTopBar.tsx")
  assert.doesNotMatch(piTopBar, /QuickSettings|快捷设置|aria-label="设置"/)
})
