// Pi-Remote 设置页 v2 · 集成守卫（纯 Node，无浏览器）。
//
// 第二阶段页面已落在 ui/src/pi/settings/**；本测试守住「桌面 / 手机真的挂上新设置页」：
// - 桌面：DesktopApp → SettingsRoute → 统一 SettingsPage，显式传 theme；
// - 手机：PhoneApp → SettingsRoute → mobile 独立系统 MobileSettingsPage；
// - 返回原会话：设置页默认 back / exit 调 p.act.openSession()，宿主不另接 onBack / onExit；
// - 根属性：data-pi-settings-style 恒为 cursor，theme 由宿主解析后传入；
// - 配对浮层（共享 PI_UI_IDS.pairing / hostDiag）；
// - 移动端交互页读写 ui.prefs.mobileNav；
// - 旧设置页保留作 fallback，但 active settings 路径不再渲染它们。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const settingsTypes = await import("../ui/src/pi/settings/types.ts")

const FILES = {
  desktopApp: "ui/src/pi/containers/DesktopApp.tsx",
  phoneApp: "ui/src/pi/containers/PhoneApp.tsx",
  settingsRoute: "ui/src/pi/containers/SettingsRoute.tsx",
  settingsPage: "ui/src/pi/settings/SettingsPage.tsx",
  mobilePage: "ui/src/pi/settings/mobile/MobileSettingsPage.tsx",
  interaction: "ui/src/pi/settings/mobile/pages/InteractionPage.tsx",
}
const code = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, stripComments(read(file))]))

/* ------------------------------------------------------------------ 桌面入口 */

test("桌面 active settings 挂统一 SettingsPage（旧 Pi 设置页不再渲染）", () => {
  // 桌面 / 手机共用 SettingsRoute（桌面分支）
  assert.match(code.desktopApp, /import \{ SettingsRoute \} from "\.\/SettingsRoute"/)
  assert.equal((code.desktopApp.match(/<SettingsRoute\b/g) ?? []).length, 2, "DesktopApp 的两个设置兜底分支都应走 SettingsRoute")
  assert.match(code.settingsRoute, /<SettingsPage\b/, "SettingsRoute 桌面分支未渲染 SettingsPage")
  assert.match(code.settingsRoute, /theme=\{theme \?\? themeFromDocument\(\)\}/, "SettingsRoute 未把解析后的 theme 传给 SettingsPage")
  assert.doesNotMatch(code.desktopApp, /<SettingsContainer\b|<PiSettingsPage\b/, "DesktopApp 仍在渲染旧设置页")
})

/* ------------------------------------------------------------------ 手机入口 */

test("手机 active settings 挂 mobile 独立系统（不再是桌面页挤窄）", () => {
  assert.match(code.phoneApp, /from "\.\/SettingsRoute"/)
  assert.match(code.phoneApp, /page === "settings"\) return <SettingsRoute\b/, "PhoneApp 的 settings 页未走 SettingsRoute")
  assert.match(code.settingsRoute, /<MobileSettingsPage\b/, "SettingsRoute 手机分支未渲染 MobileSettingsPage")
  assert.match(code.settingsRoute, /<PairingContainer\b/, "手机设置页缺配对 sheet（旧 SettingsContainer 的 sheet 槽行为）")
  assert.match(code.settingsRoute, /<HostDiagContainer\b/, "手机设置页缺主机诊断 sheet")
  assert.doesNotMatch(code.phoneApp, /<SettingsContainer\b/, "PhoneApp 仍在渲染旧设置页")
})

test("设置页保持「返回原会话」：默认 back / exit = p.act.openSession；移动端 Esc 也走同一返回", () => {
  assert.match(code.settingsPage, /p\.act\.openSession\(\)/, "桌面设置页默认返回没有回原会话")
  assert.match(code.mobilePage, /p\.act\.openSession\(\)/, "手机设置页默认退出没有回原会话")
  // R5 a11y：Esc 统一接进 useSettingsDialogFocus（与桌面共用模态焦点/返回逻辑），不再各自写 keydown。
  assert.match(code.mobilePage, /useSettingsDialogFocus\(\{/, "手机设置页缺共用对话框焦点 / Esc 接线")
  assert.match(code.mobilePage, /onEscape: back/, "手机设置页 Esc 未走同一条返回")
  // 宿主不要另接 onBack / onExit（设置页自己管返回）
  const settingsTags = code.settingsRoute.match(/<(?:SettingsPage|MobileSettingsPage)\b[\s\S]*?\/>/g) ?? []
  assert.ok(settingsTags.length >= 2, "设置页挂载点少于预期")
  for (const tag of settingsTags) {
    assert.doesNotMatch(tag, /\bon(?:Back|Exit)=/, "宿主不要覆盖设置页默认返回（否则回不到原会话）")
  }
})

test("进入方式与快捷键保留：桌面仍有 openSettings 入口", () => {
  assert.match(code.desktopApp, /onOpenSettings: act\.openSettings/, "DesktopApp 的快捷键 openSettings 接线丢了")
})

/* ------------------------------------------------------------------ 根属性 / 交互偏好 */

test("根属性：两个设置壳都输出 data-pi-settings-style=\"cursor\" 与宿主解析后的明暗", () => {
  assert.deepEqual([...settingsTypes.SETTINGS_THEMES], ["dark", "light"])
  for (const theme of settingsTypes.SETTINGS_THEMES) assert.equal(settingsTypes.settingsThemeOf(theme), theme)
  for (const key of ["settingsPage", "mobilePage"]) {
    assert.match(code[key], /data-pi-settings-style="cursor"/, `${FILES[key]} 缺风格属性`)
    assert.match(code[key], /data-pi-theme=\{activeTheme\}/, `${FILES[key]} 缺明暗属性`)
  }
})

test("移动端交互页读写 ui.prefs.mobileNav；手机壳消费该偏好", () => {
  assert.match(code.interaction, /p\.ui\.prefs\.mobileNav/, "交互页没有读宿主偏好")
  assert.match(code.interaction, /p\.act\.setPref\("mobileNav"/, "交互页没有即时写宿主偏好")
  assert.match(code.phoneApp, /ui\.prefs\.mobileNav/, "手机壳没有消费 mobileNav")
})

/* ------------------------------------------------------------------ 配对浮层 */

test("共享配对 id 能打开配对浮层（不出现点了没反应）", () => {
  // 桌面 overlay 槽有 PairingContainer；手机 SettingsRoute 自己补挂
  assert.match(code.desktopApp, /<PairingContainer\b/)
  assert.match(code.settingsRoute, /<PairingContainer\b/)
})

/* ------------------------------------------------------------------ 旧页保留 */

test("旧设置页保留作 fallback（文件仍在），无引用的旧设置容器已删除，active 路径不再引用", () => {
  const legacyPage = "ui/src/components/pi/composer/PiSettingsPage.tsx"
  assert.ok(fs.existsSync(path.join(ROOT, legacyPage)), `旧设置文件被删了：${legacyPage}`)
  assert.ok(!fs.existsSync(path.join(ROOT, "ui/src/pi/containers/SettingsContainer.tsx")), "旧设置容器已无引用，应已删除")
  for (const key of ["desktopApp", "phoneApp"]) {
    assert.doesNotMatch(code[key], /from "\.\/SettingsContainer"/, `${FILES[key]} 仍引用旧设置容器`)
  }
})

test("本测试已注册进根 package.json 的 npm test", () => {
  const pkg = JSON.parse(read("package.json"))
  assert.ok(pkg.scripts.test.split(/\s+/).includes("test/pi-settings-v2-integration.test.mjs"))
})
