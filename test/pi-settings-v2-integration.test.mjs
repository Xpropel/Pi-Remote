// Pi-Remote 设置页 v2 · 集成守卫（纯 Node，无浏览器）。
//
// 第二阶段页面已落在 ui/src/pi/settings/**；本测试守住「三套桌面 / 三套手机真的挂上新设置页」：
// - 桌面：ClaudeDesktopShell / CodexDesktop / DesktopApp → 统一 SettingsPage，显式传 style + theme；
// - 手机：ClaudePhoneShell / CodexPhone / PhoneApp → mobile 独立系统 MobileSettingsPage；
// - 返回原会话：设置页默认 back / exit 调 p.act.openSession()，各宿主不另接 onBack / onExit；
// - 六皮肤属性：style 跟随 prefs.ui，theme 由宿主解析后传入；
// - 配对浮层转接（共享 PI_UI_IDS.pairing / hostDiag → 各变体自己的浮层）；
// - 移动端交互页读写 ui.prefs.mobileNav；
// - 旧设置页保留作 fallback，但 active settings 路径不再渲染它们；
// - 变体独立性白名单只放行两个设置入口，禁止借道页面内部模块。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const settingsTypes = await import("../ui/src/pi/settings/types.ts")
const { PI_VARIANT_ALLOWED_SETTINGS_MODULES, piVariantImportVerdict } = await import(
  "../ui/src/pi/headless/allowlist.ts"
)

const FILES = {
  claudeDesktop: "ui/src/pi/variants/claude/shell/ClaudeDesktopShell.tsx",
  claudePhone: "ui/src/pi/variants/claude/shell/ClaudePhoneShell.tsx",
  claudeHost: "ui/src/pi/variants/claude/shell/settingsHost.ts",
  codexDesktop: "ui/src/pi/variants/codex/shell/CodexDesktop.tsx",
  codexPhone: "ui/src/pi/variants/codex/shell/CodexPhone.tsx",
  codexHost: "ui/src/pi/variants/codex/shell/settingsHost.ts",
  desktopApp: "ui/src/pi/containers/DesktopApp.tsx",
  phoneApp: "ui/src/pi/containers/PhoneApp.tsx",
  settingsRoute: "ui/src/pi/containers/SettingsRoute.tsx",
  settingsPage: "ui/src/pi/settings/SettingsPage.tsx",
  mobilePage: "ui/src/pi/settings/mobile/MobileSettingsPage.tsx",
  interaction: "ui/src/pi/settings/mobile/pages/InteractionPage.tsx",
}
const code = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, stripComments(read(file))]))

/* ------------------------------------------------------------------ 桌面入口 */

test("三套桌面 active settings 都挂统一 SettingsPage（旧 Claude/Codex/Pi 设置页不再渲染）", () => {
  for (const key of ["claudeDesktop", "codexDesktop"]) {
    assert.match(code[key], /from "@\/pi\/settings"/, `${FILES[key]} 未 import 统一设置页`)
    assert.match(code[key], /<SettingsPage\b/, `${FILES[key]} 未渲染 SettingsPage`)
    assert.match(code[key], /settingsStyleOf\((?:p|props)\.ui\.prefs\.ui\)/, `${FILES[key]} 的 style 未跟随 prefs.ui`)
    assert.doesNotMatch(code[key], /<(?:ClaudeSettingsPage|CodexSettingsPage|PiSettingsPage)\b/, `${FILES[key]} 仍在渲染旧设置页`)
  }
  assert.match(code.claudeDesktop, /theme=\{theme\}/, "Claude 桌面设置页未显式传 theme")
  assert.match(code.codexDesktop, /theme=\{props\.theme\}/, "Codex 桌面设置页未显式传 theme")
  // Cursor：桌面 / 手机共用 SettingsRoute（桌面分支）
  assert.match(code.desktopApp, /import \{ SettingsRoute \} from "\.\/SettingsRoute"/)
  assert.equal((code.desktopApp.match(/<SettingsRoute\b/g) ?? []).length, 2, "DesktopApp 的两个设置兜底分支都应走 SettingsRoute")
  assert.match(code.settingsRoute, /<SettingsPage\b/, "SettingsRoute 桌面分支未渲染 SettingsPage")
  assert.match(code.settingsRoute, /settingsStyleOf\(p\.ui\.prefs\.ui\)/, "SettingsRoute 的 style 未跟随 prefs.ui")
  assert.match(code.settingsRoute, /theme=\{theme \?\? themeFromDocument\(\)\}/, "SettingsRoute 未把解析后的 theme 传给 SettingsPage")
  assert.doesNotMatch(code.desktopApp, /<SettingsContainer\b|<PiSettingsPage\b/, "DesktopApp 仍在渲染旧设置页")
})

/* ------------------------------------------------------------------ 手机入口 */

test("三套手机 active settings 都挂 mobile 独立系统（不再是桌面页挤窄）", () => {
  for (const key of ["claudePhone", "codexPhone"]) {
    assert.match(code[key], /from "@\/pi\/settings\/mobile"/, `${FILES[key]} 未 import mobile 设置系统`)
    assert.match(code[key], /page === "settings"/, `${FILES[key]} 缺 settings 推入页`)
    assert.match(code[key], /<MobileSettingsPage\b/, `${FILES[key]} 未渲染 MobileSettingsPage`)
    assert.doesNotMatch(code[key], /<(?:ClaudeSettingsPage|CodexSettingsPage)\b/, `${FILES[key]} 仍在渲染旧设置页`)
  }
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
  // 宿主不要另接 onBack / onExit（旧 Claude/Codex 设置页才自己管返回）
  const settingsTags = [
    ...(code.claudeDesktop.match(/<SettingsPage\b[\s\S]*?\/>/g) ?? []),
    ...(code.codexDesktop.match(/<SettingsPage\b[\s\S]*?\/>/g) ?? []),
    ...(code.claudePhone.match(/<MobileSettingsPage\b[\s\S]*?\/>/g) ?? []),
    ...(code.codexPhone.match(/<MobileSettingsPage\b[\s\S]*?\/>/g) ?? []),
    ...(code.settingsRoute.match(/<(?:SettingsPage|MobileSettingsPage)\b[\s\S]*?\/>/g) ?? []),
  ]
  assert.ok(settingsTags.length >= 6, "设置页挂载点少于预期")
  for (const tag of settingsTags) {
    assert.doesNotMatch(tag, /\bon(?:Back|Exit)=/, "宿主不要覆盖设置页默认返回（否则回不到原会话）")
  }
})

test("进入方式与快捷键保留：三套桌面仍有 openSettings 入口", () => {
  for (const key of ["claudeDesktop", "codexDesktop"]) {
    assert.match(code[key], /event\.key === ","/, `${FILES[key]} 的 ⌘, 快捷键丢了`)
    assert.match(code[key], /act\.openSettings\(\)/, `${FILES[key]} 缺 openSettings 入口`)
  }
  assert.match(code.desktopApp, /onOpenSettings: act\.openSettings/, "DesktopApp 的快捷键 openSettings 接线丢了")
})

/* ------------------------------------------------------------------ 六皮肤 / 交互偏好 */

test("六皮肤属性：三套桌面显式传 style/theme，两个设置壳输出六皮肤根属性", () => {
  assert.deepEqual([...settingsTypes.SETTINGS_STYLES], ["cursor", "claude", "codex"])
  assert.deepEqual([...settingsTypes.SETTINGS_THEMES], ["dark", "light"])
  for (const style of settingsTypes.SETTINGS_STYLES) {
    assert.equal(settingsTypes.settingsStyleOf(style), style)
    for (const theme of settingsTypes.SETTINGS_THEMES) assert.equal(settingsTypes.settingsThemeOf(theme), theme)
  }
  for (const key of ["settingsPage", "mobilePage"]) {
    assert.match(code[key], /data-pi-settings-style=\{activeStyle\}/, `${FILES[key]} 缺皮肤属性`)
    assert.match(code[key], /data-pi-theme=\{activeTheme\}/, `${FILES[key]} 缺明暗属性`)
  }
  // 桌面三入口都不写死皮肤 / 明暗，统一从宿主偏好解析
  for (const key of ["claudeDesktop", "codexDesktop"]) {
    assert.doesNotMatch(code[key], /style="(?:cursor|claude|codex)"/, `${FILES[key]} 写死了皮肤`)
    assert.doesNotMatch(code[key], /theme="(?:dark|light)"/, `${FILES[key]} 写死了明暗`)
  }
})

test("移动端交互页读写 ui.prefs.mobileNav；三套手机壳都消费该偏好", () => {
  assert.match(code.interaction, /p\.ui\.prefs\.mobileNav/, "交互页没有读宿主偏好")
  assert.match(code.interaction, /p\.act\.setPref\("mobileNav"/, "交互页没有即时写宿主偏好")
  assert.match(code.claudePhone, /ui\.prefs\.mobileNav/, "Claude 手机壳没有消费 mobileNav")
  assert.match(code.codexPhone, /ui\.prefs\.mobileNav/, "Codex 手机壳没有消费 mobileNav")
  assert.match(code.phoneApp, /ui\.prefs\.mobileNav/, "Cursor 手机壳没有消费 mobileNav")
})

/* ------------------------------------------------------------------ 配对浮层转接 */

test("共享配对 id 在三套宿主都能打开各自原生配对浮层（不出现点了没反应）", () => {
  // Claude：a:pairing → CLAUDE_OVERLAY.pairing；桌面 openDialog / 手机 openSheet 都映射
  assert.match(code.claudeHost, /"a:pairing"/)
  assert.match(code.claudeHost, /CLAUDE_OVERLAY\.pairing/)
  assert.match(code.claudeHost, /openDialog: \(overlay\) => p\.act\.openDialog\(mapOverlay\(overlay\)\)/)
  assert.match(code.claudeHost, /openSheet: \(overlay\) => p\.act\.openSheet\(mapOverlay\(overlay\)\)/)
  assert.match(code.claudeDesktop, /claudeSettingsHostProps\(p\)/)
  assert.match(code.claudePhone, /claudeSettingsHostProps\(p\)/)
  // Codex：a:pairing → overlay.pairing；桌面 / 手机各自 patchOverlay
  assert.match(code.codexHost, /"a:pairing"/)
  assert.match(code.codexHost, /onPairing\(\)/)
  assert.match(code.codexDesktop, /codexSettingsHostProps\(props, "desktop", \(\) => patchOverlay\(\{ pairing: true \}\)\)/)
  assert.match(code.codexPhone, /codexSettingsHostProps\(props, "phone", \(\) => patchOverlay\(\{ pairing: true \}\)\)/)
  // Cursor：桌面 overlay 槽有 PairingContainer；手机 SettingsRoute 自己补挂
  assert.match(code.desktopApp, /<PairingContainer\b/)
  assert.match(code.settingsRoute, /<PairingContainer\b/)
})

/* ------------------------------------------------------------------ 旧页保留 / 白名单 */

test("旧设置页保留作 fallback（文件仍在），active 路径已不被引用", () => {
  for (const file of [
    "ui/src/components/pi/composer/PiSettingsPage.tsx",
    "ui/src/pi/variants/claude/pages/ClaudeSettingsPage.tsx",
    "ui/src/pi/variants/codex/pages/CodexSettingsPage.tsx",
    "ui/src/pi/containers/SettingsContainer.tsx",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `旧设置文件被删了：${file}`)
  }
  for (const key of ["claudeDesktop", "claudePhone", "codexDesktop", "codexPhone", "desktopApp", "phoneApp"]) {
    assert.doesNotMatch(code[key], /from "\.\.\/pages\/(?:Claude|Codex)SettingsPage"|from "\.\/SettingsContainer"/, `${FILES[key]} 仍引用旧设置容器`)
  }
})

test("变体白名单只放行两个设置入口；深层设置模块 / 页面实现禁止借道", () => {
  assert.deepEqual([...PI_VARIANT_ALLOWED_SETTINGS_MODULES], ["@/pi/settings", "@/pi/settings/mobile"])
  for (const spec of PI_VARIANT_ALLOWED_SETTINGS_MODULES) {
    assert.equal(piVariantImportVerdict(spec).ok, true, `${spec} 应放行`)
  }
  for (const spec of ["@/pi/settings/pages/GeneralPage", "@/pi/settings/SettingsPage", "@/pi/settings/types", "@/pi/settings/mobile/pages/GeneralPage"]) {
    assert.equal(piVariantImportVerdict(spec).ok, false, `${spec} 不应被变体直接 import`)
  }
  // 变体源码里的设置 import 只能是白名单精确入口（独立守卫同时跑全量 verdict）
  for (const [id, dir] of [
    ["claude", path.join(ROOT, "ui/src/pi/variants/claude")],
    ["codex", path.join(ROOT, "ui/src/pi/variants/codex")],
  ]) {
    const walk = (current, out = []) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full, out)
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
      }
      return out
    }
    for (const file of walk(dir)) {
      for (const match of stripComments(fs.readFileSync(file, "utf8")).matchAll(/from\s+"(@\/pi\/settings[^"]*)"/g)) {
        const spec = match[1]
        assert.ok(PI_VARIANT_ALLOWED_SETTINGS_MODULES.includes(spec), `${id} 变体 import 了未登记设置模块：${spec}`)
      }
    }
  }
})

test("本测试已注册进根 package.json 的 npm test", () => {
  const pkg = JSON.parse(read("package.json"))
  assert.ok(pkg.scripts.test.split(/\s+/).includes("test/pi-settings-v2-integration.test.mjs"))
})
