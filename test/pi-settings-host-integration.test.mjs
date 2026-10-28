// Pi-Remote 设置页 v2 · 宿主消费接线守卫（纯 Node，无浏览器）。
//
// 设置页实现不改；本测试守住「宿主真的消费了本机偏好」：
//   - PiApp / #/live 都挂 PiSettingsHost（产品与画廊同一棵树）；
//   - 默认设备、通知四通道、快捷键、隐私 data 属性都有接线；
//   - 隐私 CSS 覆盖三套桌面与移动壳的标题/摘要，并且 hover / 焦点可还原；
//   - 16 个快捷键动作在宿主分发器里都有分支；
//   - 不申请系统通知权限、不改真实数据。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

const FILES = {
  piApp: "ui/src/pi/PiApp.tsx",
  liveRoute: "ui/src/pi/dev/LiveRoute.tsx",
  host: "ui/src/pi/hooks/PiSettingsHost.tsx",
  prefsHook: "ui/src/pi/hooks/usePiSettingsPrefs.ts",
  noticeHook: "ui/src/pi/hooks/useCompletionNotice.ts",
  pure: "ui/src/pi/model/settingsHost.ts",
  headlessRoot: "ui/src/pi/headless/root.tsx",
  privacyContext: "ui/src/pi/headless/privacyContext.ts",
  privacyProvider: "ui/src/pi/headless/privacy.tsx",
  privacyCss: "ui/src/pi/styles/privacy.css",
  pageTitle: "ui/src/chat/hooks.ts",
  badge: "ui/src/chat/composer/faviconBadge.ts",
  sound: "ui/src/chat/composer/sound.ts",
  soundDecision: "ui/src/chat/composer/soundDecision.ts",
  sidebarLocal: "ui/src/pi/sidebar/useSidebarLocal.ts",
  shortcutsLogic: "ui/src/pi/settings/pages/shortcutsLogic.ts",
  settingsModel: "ui/src/pi/settings/model.ts",
  privacyPage: "ui/src/pi/settings/pages/PrivacyPage.tsx",
  mobilePrivacyPage: "ui/src/pi/settings/mobile/pages/PrivacyPage.tsx",
}
const code = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, stripComments(read(file))]))

const types = await import("../ui/src/pi/settings/types.ts")
const model = await import("../ui/src/pi/settings/model.ts")
const hostLogic = await import("../ui/src/pi/model/settingsHost.ts")
const allowlist = await import("../ui/src/pi/headless/allowlist.ts")
const shortcutsLogic = await import("../ui/src/pi/settings/pages/shortcutsLogic.ts")

/* ------------------------------------------------------------------ 入口接线 */

test("产品入口 PiApp 挂 PiSettingsHost；旧的三个通知 hook 不再在这里各自接线", () => {
  assert.match(code.piApp, /from "@\/pi\/hooks\/PiSettingsHost"/)
  assert.match(code.piApp, /<PiSettingsHost\b[^>]*relay=\{relay\}[^>]*ui=\{ui\}[^>]*act=\{act\}/, "PiSettingsHost 必须拿到 relay / ui / act")
  assert.match(code.piApp, /<Variant \{\.\.\.app\} \/>/, "变体仍在 PiSettingsHost 内")
  assert.doesNotMatch(code.piApp, /useCompletionBadge\(|useCompletionSound\(|usePageTitle\(/, "PiApp 不应再各自调用通知 hook")
  assert.match(code.piApp, /import "@\/pi\/styles\/privacy\.css"/, "产品入口未加载隐私样式")
})

test("开发画廊 #/live：舞台与设备模式都挂 PiSettingsHost；静态态关掉通知/快捷键副作用", () => {
  assert.match(code.liveRoute, /from "@\/pi\/hooks\/PiSettingsHost"/)
  const hosts = code.liveRoute.match(/<PiSettingsHost\b[\s\S]*?>/g) ?? []
  assert.equal(hosts.length, 2, "#/live 的舞台 / 设备两条分支都应挂 PiSettingsHost")
  assert.match(code.liveRoute, /notifications=\{interactive\}/, "舞台静态态不应消费通知")
  assert.match(code.liveRoute, /shortcuts=\{interactive\}/, "舞台静态态不应抢快捷键")
  assert.match(code.liveRoute, /defaultDevice=\{interactive\}/, "舞台静态态不应改设备选择")
  assert.match(code.liveRoute, /import "@\/pi\/styles\/privacy\.css"/)
})

test("画廊假 relay 的 selectDevice 是状态回写（默认设备自动选中在 e2e 里可见）", () => {
  assert.match(code.liveRoute, /const \[devicePick, setDevicePick\] = useState<string \| null>\(null\)/)
  assert.match(code.liveRoute, /const selectDevice = useCallback\(\(id: string\) => \{\s*setDevicePick\(id\)/)
  assert.match(code.liveRoute, /selectedDeviceId = devicePick \?\? fake\.selectedDeviceId/)
  assert.match(code.liveRoute, /selectedDevice, selectDevice/)
})

/* ------------------------------------------------------------------ 默认设备 */

test("默认设备接线：只在 authed 后跑，交给纯函数判断，并记录手动选择 / 已应用", () => {
  assert.match(code.host, /useDefaultDeviceSelection\(relay, prefs, defaultDevice\)/)
  assert.match(code.host, /if \(!enabled \|\| !authed\) return/, "未连接成功不自动选设备")
  assert.match(code.host, /defaultDevicePickOf\(\{/)
  assert.match(code.host, /manual: manual\.current/)
  assert.match(code.host, /appliedDefaultId: applied\.current/)
  assert.match(code.host, /selectDevice\(pick\)/)
  // 手动选择检测：用户交互后 selectedDeviceId 变化（且不是宿主自己应用的默认设备）→ manual
  assert.match(code.host, /window\.addEventListener\("pointerdown", mark/)
  assert.match(code.host, /window\.addEventListener\("keydown", mark/)
  assert.match(code.host, /current !== applied\.current && interacted\.current/)
})

/* ------------------------------------------------------------------ 通知 */

test("四个通知消费者都从同一份 gate 取开关（等待/出错/完成、仅页面外/总是、声音、角标）", () => {
  assert.match(code.host, /notificationGateOf\(prefs\)/)
  assert.match(code.host, /usePageTitle\(relay, waitingVisible/)
  assert.match(code.host, /completion: notifications && titleCompletionEnabled\(gate\)/)
  assert.match(code.host, /privacy: gate\.privacy/)
  assert.match(code.host, /always: !gate\.onlyWhenAway/)
  assert.match(code.host, /useCompletionBadge\(relay, waitingVisible/)
  assert.match(code.host, /enabled: notifications && gate\.badge/)
  assert.match(code.host, /waitingEnabled: gate\.waiting/)
  assert.match(code.host, /doneEnabled: gate\.complete/)
  assert.match(code.host, /errorEnabled: gate\.error/)
  assert.match(code.host, /useCompletionSound\(relay, \{\s*enabled: notifications && gate\.sound/)
  assert.match(code.host, /useCompletionNotice\(relay, \{ gate, enabled: notifications \}\)/)
  assert.match(code.noticeHook, /notificationNoticeOf\(gate, signal\.error \? "error" : "done", away\)/)
  assert.match(code.noticeHook, /const pushNotice = relay\.pushNotice/)
  assert.match(code.noticeHook, /pushNotice\(notice\)/)
})

test("通知 hook 的偏好参数接上了，且旧入口默认行为不变", () => {
  assert.match(code.pageTitle, /export interface UsePageTitleOptions/)
  assert.match(code.pageTitle, /completion = true, privacy = false, always = false/)
  assert.match(code.pageTitle, /room: privacy \? "" : room \? roomTitle\(room\) : ""/)
  assert.match(code.badge, /export interface UseCompletionBadgeOptions/)
  assert.match(code.badge, /enabled = true, waitingEnabled = true, doneEnabled = true, errorEnabled = true, onlyWhenAway = true/)
  assert.match(code.badge, /const waitingCount = enabled && waitingEnabled \? waiting : 0/)
  assert.match(code.sound, /export interface UseCompletionSoundOptions/)
  assert.match(code.sound, /const soundEnabled = enabled \?\? completionSoundEnabled\(\)/)
  assert.match(code.soundDecision, /enabled\?: boolean/)
  assert.match(code.soundDecision, /awayOnly\?: boolean/)
  assert.match(code.soundDecision, /input\.awayOnly === false \|\| input\.away/)
})

test("通知偏好关闭时对应提醒不发（纯逻辑口径）", () => {
  const prefs = model.createDefaultSettingsPrefs()
  const gate = hostLogic.notificationGateOf(prefs)
  assert.equal(gate.complete, false)
  assert.equal(gate.sound, false)
  assert.equal(hostLogic.notificationSoundVisible(gate, "done", true), false)
  assert.equal(hostLogic.notificationBadgeVisible(gate, "done", true), false)
  assert.equal(hostLogic.notificationNoticeOf(gate, "done", true), null)
  const soundOn = hostLogic.notificationGateOf(model.mergeSettingsPrefs(prefs, { notifySound: true, notifyComplete: true }))
  assert.equal(hostLogic.notificationSoundVisible(soundOn, "done", false), false, "默认仅页面外：在场不响")
  assert.equal(
    hostLogic.notificationSoundVisible(hostLogic.notificationGateOf(model.mergeSettingsPrefs(prefs, { notifySound: true, notifyComplete: true, notifyOnlyWhenAway: false })), "done", false),
    true,
    "总是提醒：在场也响",
  )
})

/* ------------------------------------------------------------------ 隐私 */

test("隐私模式：偏好字段存在；根节点写 data-pi-privacy 并镜像 <html>；真实数据只在标题通道脱敏", () => {
  assert.equal(Object.hasOwn(model.DEFAULT_SETTINGS_PREFS, "privacyMode"), true)
  assert.equal(model.DEFAULT_SETTINGS_PREFS.privacyMode, false)

  assert.match(code.privacyContext, /export const PiPrivacyContext = createContext\(false\)/)
  assert.match(code.privacyContext, /export function usePiPrivacy\(\)/)
  assert.match(code.privacyProvider, /<PiPrivacyContext\.Provider value=\{value\}>/)

  assert.match(code.headlessRoot, /const privacy = usePiPrivacy\(\)/)
  assert.match(code.headlessRoot, /data-pi-privacy=\{privacy \? "on" : undefined\}/)
  assert.match(code.headlessRoot, /if \(privacy\) el\.setAttribute\("data-pi-privacy", "on"\)/)
  assert.match(code.headlessRoot, /el\.removeAttribute\("data-pi-privacy"\)/)
  assert.match(code.host, /<PiPrivacyProvider value=\{gate\.privacy\}>/)
})

test("隐私 CSS：覆盖三套桌面 / 移动壳标题与摘要，模糊且 hover / 焦点可看清", () => {
  const css = code.privacyCss
  for (const selector of [
    ".sb-row-title",
    ".sb-bubble-title",
    ".claude-row-title",
    ".claude-session-pill-title",
    ".cx-row-title",
    ".cx-thread-head-title",
    ".pm-row-title",
    ".pm-row-line2",
    ".pm-drawer-session-title",
    '[data-slot="titlebar-title"]',
  ]) {
    assert.ok(css.includes(selector), `隐私 CSS 缺 ${selector}`)
  }
  assert.match(css, /filter: blur\(/)
  assert.match(css, /\.sb-row-title:hover/)
  assert.match(css, /\.sb-row:focus-within \.sb-row-title/)
  assert.match(css, /filter: none;/)
  assert.match(css, /\[data-pi-privacy="on"\]/, "隐私样式必须由根属性触发")
})

test("设置页的隐私模式已接本机偏好：桌面 / 手机都可写，只影响本机显示", () => {
  for (const [label, page] of [
    ["桌面", code.privacyPage],
    ["手机", code.mobilePrivacyPage],
  ]) {
    assert.match(page, /prefs\.privacyMode/, `${label}隐私开关未读本机偏好`)
    assert.match(page, /act\.setPref\("privacyMode"/, `${label}隐私开关未写本机偏好`)
    assert.match(page, /仅本机显示脱敏，不改设备数据/, `${label}隐私开关缺少本机脱敏说明`)
    assert.doesNotMatch(page, /隐私模式（设计预留）|status="reserved"/, `${label}隐私开关仍是设计预留`)
    assert.doesNotMatch(page, /writer\.save\("privacyMode"/, `${label}隐私模式不得走 settings_set 写桥`)
  }
})

/* ------------------------------------------------------------------ 快捷键 */

test("16 个快捷键动作在宿主分发器里都有分支，并且 routes 与设置页映射表一致", () => {
  const ids = types.SETTINGS_SHORTCUT_ACTIONS.map((action) => action.id)
  assert.equal(ids.length, 16)
  for (const id of ids) {
    assert.ok(id in shortcutsLogic.SHORTCUT_ACTION_ROUTES, `${id} 缺路由映射`)
    assert.match(code.host, new RegExp(`case "${id}":`), `宿主分发器缺 ${id} 分支`)
  }
  // 设置页仍是录制 / 校验的唯一实现
  assert.match(code.shortcutsLogic, /export function shortcutConflictsOf/)
  assert.match(code.host, /shortcutHitOf\(/)
  assert.match(code.host, /shortcutBlockedByOverlay/)
  assert.match(code.host, /shortcutBlockedByFocus/)
  assert.match(code.host, /focusKindOf\(event\.target\)/)
  assert.match(code.host, /window\.addEventListener\("keydown", onKeyDown\)/)
})

test("快捷键不与设置页抢键：设置页/菜单/弹窗/命令面板打开时一律不分发", () => {
  assert.match(code.host, /settings: current\.ui\.view === "settings"/)
  assert.match(code.host, /menu: !!current\.ui\.menu/)
  assert.match(code.host, /sheet: !!current\.ui\.sheet/)
  assert.match(code.host, /dialog: !!current\.ui\.dialog/)
  assert.match(code.host, /palette: current\.ui\.paletteOpen/)
  assert.match(code.host, /if \(event\.defaultPrevented\) return/, "子壳已处理的键不重复分发")
  assert.match(code.host, /if \(current\.keyboardOpen && !shortcutHasStrongModifier\(hit\.keys\)\) return/)
  assert.match(code.host, /isInteractiveTarget\(event\.target\) && !shortcutHasStrongModifier/)
})

test("浏览器保留键：执行动作但每个组合只提示一次", () => {
  assert.match(code.host, /hit\.browserConflict && !hinted\.current\.has\(hit\.signature\)/)
  assert.match(code.host, /hinted\.current\.add\(hit\.signature\)/)
  assert.match(code.host, /browserShortcutHintOf\(hit\)/)
  assert.match(code.pure, /设置 › 快捷键/)
})

test("存档 / 置顶经本机 store；同一标签页内其它侧栏实例能同步", () => {
  assert.match(code.host, /useSidebarLocalState\(relay\.serverName \|\| "local", relay\.selectedDeviceId \?\? ""\)/)
  assert.match(code.host, /sidebar\.togglePin\(key\)/)
  assert.match(code.host, /sidebar\.toggleArchive\(key\)/)
  assert.match(code.sidebarLocal, /const localListeners = new Set/)
  assert.match(code.sidebarLocal, /publishSidebarLocal\(next\)/)
  assert.match(code.sidebarLocal, /window\.addEventListener\("storage", onStorage\)/)
})

/* ------------------------------------------------------------------ 安全 / 边界 */

test("不申请系统通知权限、不新增 Notification / ServiceWorker", () => {
  for (const key of ["host", "noticeHook", "prefsHook", "piApp", "liveRoute"]) {
    assert.doesNotMatch(code[key], /Notification\.requestPermission|new Notification\(|serviceWorker\.register/, `${FILES[key]} 不应申请系统通知`)
  }
  assert.match(code.noticeHook, /relay\.pushNotice/, "应用内提醒走现有通知栈")
})

test("变体独立性：新宿主 hook 不在变体白名单里，变体源码没有直接 import", () => {
  assert.equal(allowlist.PI_VARIANT_ALLOWED_HOOKS.includes("@/pi/hooks/PiSettingsHost"), false)
  assert.equal(allowlist.PI_VARIANT_ALLOWED_HOOKS.includes("@/pi/hooks/usePiSettingsPrefs"), false)
  for (const dir of ["claude", "codex"]) {
    const root = path.join(ROOT, "ui/src/pi/variants", dir)
    const walk = (current, out = []) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full, out)
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
      }
      return out
    }
    for (const file of walk(root)) {
      const source = stripComments(fs.readFileSync(file, "utf8"))
      assert.doesNotMatch(source, /from "@\/pi\/hooks\/(?:PiSettingsHost|usePiSettingsPrefs)"/, `${file} 不应直接 import 宿主设置 hook`)
    }
  }
})

test("宿主读取键仍是 pi_remote_pi_settings_v2，且只读不写", () => {
  assert.equal(model.SETTINGS_STORAGE_KEY, "pi_remote_pi_settings_v2")
  assert.match(code.prefsHook, /SETTINGS_STORAGE_KEY/)
  assert.match(code.prefsHook, /storage\.getItem\(/)
  assert.doesNotMatch(code.prefsHook, /storage\.setItem\(|localStorage\.setItem\(/, "宿主不得回写设置页偏好")
  assert.match(code.host, /usePiSettingsPrefs\(\)/)
})
