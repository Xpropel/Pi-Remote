// Pi-Remote 设置页 v2 · 第一阶段框架契约测试（纯 Node，无浏览器）。
// 守卫：11 页 IA / 桌面几何 / 六套 --st-* token 与侧栏定版 token 同源 / 样式作用域 /
//       Claude 只给页标题与分组标题衬线 / 无窗口控制按钮 / ◐◌ 徽标与不可用口径 /
//       General 页交互与只读状态 / 新 localStorage 键的版本与逐字段校验。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SETTINGS_DIR = path.join(ROOT, "ui/src/pi/settings")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "")
const normalizeColor = (value) => value.replace(/\s+/g, "").toLowerCase()
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g

const types = await import("../ui/src/pi/settings/types.ts")
const model = await import("../ui/src/pi/settings/model.ts")

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full)
  }
  return out
}

const settingsSources = walk(SETTINGS_DIR)
const settingsSourceText = settingsSources.map((file) => fs.readFileSync(file, "utf8")).join("\n")

function blockOf(source, selectorStart) {
  const at = source.indexOf(selectorStart)
  assert.notEqual(at, -1, `缺少选择器：${selectorStart}`)
  const open = source.indexOf("{", at)
  assert.notEqual(open, -1, `${selectorStart} 后没有 {`)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1
    if (source[i] === "}") {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  throw new Error(`块未闭合：${selectorStart}`)
}

test("11 页 IA：顺序、文案、图标、分组、使用活动宽列", () => {
  assert.deepEqual([...types.SETTINGS_PAGE_IDS], [
    "general", "model", "approval", "extensions", "appearance", "devices",
    "notifications", "shortcuts", "privacy", "usage", "about",
  ])
  assert.equal(types.SETTINGS_PAGES.length, 11)
  assert.equal(new Set(types.SETTINGS_PAGE_IDS).size, 11)
  assert.deepEqual(types.SETTINGS_PAGES.map((page) => page.label), [
    "通用", "模型与会话", "审批与执行", "扩展", "外观", "设备",
    "通知", "快捷键", "数据与隐私", "使用活动", "关于",
  ])
  for (const page of types.SETTINGS_PAGES) {
    assert.ok(page.icon, `${page.id} 缺图标名`)
    assert.ok(Object.keys(types.SETTINGS_PAGE_GROUP_LABELS).includes(page.group), `${page.id} 分组不合法`)
  }
  assert.equal(types.SETTINGS_PAGE_META.usage.wide, true, "使用活动页例外 880")
  assert.deepEqual(types.SETTINGS_PAGES.filter((page) => page.wide).map((page) => page.id), ["usage"])
  assert.equal(types.settingsPageIdOf("usage"), "usage")
  assert.equal(types.settingsPageIdOf("nope"), "general")
})

test("桌面几何与皮肤契约：260 / 30 / 15 / 692 / 880，3×2 六套", () => {
  assert.deepEqual(types.SETTINGS_METRICS, {
    railWidth: 260,
    navRowHeight: 30,
    navIconSize: 15,
    contentWidth: 692,
    contentWidthWide: 880,
    pagePaddingTop: 24,
    pagePaddingX: 34,
  })
  assert.deepEqual([...types.SETTINGS_STYLES], ["cursor", "claude", "codex"])
  assert.deepEqual([...types.SETTINGS_THEMES], ["dark", "light"])
  assert.equal(types.settingsStyleOf("claude"), "claude")
  assert.equal(types.settingsStyleOf("nope"), "cursor")
  assert.equal(types.settingsThemeOf("light"), "light")
  assert.equal(types.settingsThemeOf(null), null)
})

test("六套 token：六组选择器齐全、每次 22 个色位、颜色字面值全部来自统一侧栏 token", () => {
  const tokens = stripComments(read("ui/src/pi/settings/tokens.css"))
  const sidebar = stripComments(read("ui/src/pi/sidebar/tokens.css"))
  const required = [
    "--st-page-bg", "--st-rail-bg", "--st-border",
    "--st-text-1", "--st-text-2", "--st-text-3", "--st-text-4", "--st-text-5", "--st-icon",
    "--st-menu-bg", "--st-menu-border", "--st-selected-bg", "--st-hover-bg",
    "--st-accent", "--st-accent-soft", "--st-online", "--st-wait", "--st-error", "--st-idle",
    "--st-tile-bg", "--st-backdrop", "--st-selected-ring",
  ]
  for (const style of types.SETTINGS_STYLES) {
    for (const theme of types.SETTINGS_THEMES) {
      const self = `[data-pi-settings][data-pi-settings-style="${style}"][data-pi-theme="${theme}"]`
      // 祖先主题选择器用 :where() 降低特异性（根属性优先）；兼容未降特异性的旧写法。
      const ancestor = `[data-pi-theme="${theme}"] [data-pi-settings][data-pi-settings-style="${style}"]`
      const ancestorWhere = `:where([data-pi-theme="${theme}"]) [data-pi-settings][data-pi-settings-style="${style}"]`
      assert.ok(tokens.includes(self), `${style}/${theme} 缺根属性选择器`)
      assert.ok(tokens.includes(ancestor) || tokens.includes(ancestorWhere), `${style}/${theme} 缺祖先主题选择器`)
      const block = blockOf(tokens, self)
      const missing = required.filter((name) => !block.includes(`${name}:`))
      assert.deepEqual(missing, [], `${style}/${theme} 缺色位：${missing.join(", ")}`)
      assert.ok((block.match(COLOR_RE) ?? []).length >= 21, `${style}/${theme} 颜色值不足`)
    }
  }

  // token 层的颜色字面值必须逐字来自统一侧栏定版令牌，禁止设置页另起颜色。
  const sidebarColors = new Set((sidebar.match(COLOR_RE) ?? []).map(normalizeColor))
  const tokenColors = [...new Set((tokens.match(COLOR_RE) ?? []).map(normalizeColor))]
  const bespoke = tokenColors.filter((color) => !sidebarColors.has(color))
  assert.deepEqual(bespoke, [], `设置页自造颜色：${bespoke.join(", ")}`)
  assert.ok(tokenColors.length >= 20)

  // 组件样式不得出现字面色；只消费语义 token。
  const css = stripComments(read("ui/src/pi/settings/settings.css"))
  assert.deepEqual(css.match(COLOR_RE) ?? [], [], "settings.css 不得写死颜色")
  assert.match(tokens, /--st-rail-w:\s*260px/)
  assert.match(tokens, /--st-content-w:\s*692px/)
  assert.match(tokens, /--st-content-w-wide:\s*880px/)
  assert.match(tokens, /--st-nav-h:\s*30px/)
  assert.match(tokens, /--st-nav-icon:\s*15px/)
})

test("样式全部作用域化；Claude 页标题 / 分组标题 / 左栏标题走衬线；无窗口控制按钮", () => {
  const css = stripComments(read("ui/src/pi/settings/settings.css"))
  const rules = [...css.matchAll(/([^{}]+)\{/g)]
    .map((match) => match[1].trim())
    .filter((selector) => selector && !selector.startsWith("@"))
  for (const selectorList of rules) {
    for (const raw of selectorList.split(",")) {
      const selector = raw.trim()
      if (!selector) continue
      assert.ok(
        selector.startsWith("[data-pi-settings]") || selector.startsWith(".settings-root") || selector.startsWith(".settings-"),
        `未命名空间化的设置页规则：${selector}`,
      )
    }
  }

  const tokens = stripComments(read("ui/src/pi/settings/tokens.css"))
  assert.equal((tokens.match(/--st-font-display:/g) ?? []).length, 3, "字体显示 token 只应有基础 + Claude 两套")
  for (const theme of types.SETTINGS_THEMES) {
    const marker = `[data-pi-settings-style="claude"][data-pi-theme="${theme}"]`
    assert.match(blockOf(tokens, marker), /--st-font-display:\s*var\(--st-font-serif\)/, `Claude ${theme} 必须衬线`)
  }
  assert.equal((css.match(/font-family:\s*var\(--st-font-display\)/g) ?? []).length, 2, "只有页标题与分组标题可用 display 字体")
  assert.match(css, /\.settings-page-title\s*\{[^}]*font-family:\s*var\(--st-font-display\)/)
  assert.match(css, /\.settings-group-label\s*\{[^}]*font-family:\s*var\(--st-font-display\)/)
  assert.match(css, /\.settings-rail-title\s*\{[^}]*font-family:\s*var\(--st-font-sans\)/, "左栏标题基础规则保持无衬线")
  assert.match(
    css,
    /\[data-pi-settings\]\[data-pi-settings-style="claude"\]\s+\.settings-rail-title\s*\{[^}]*font-family:\s*var\(--st-font-serif\)/,
    "Claude 左栏标题按设计源用衬线",
  )

  // Codex 变体 reset（[data-pi-ui="codex"] h2/p { margin:0 }）也必须在设置页作用域复位。
  assert.match(
    css,
    /\[data-pi-settings\]\[data-pi-settings-style="codex"\] \.settings-group-label \{[^}]*margin:\s*18px 0 8px/,
    "Codex 分组标题缺 18/8 复位",
  )
  assert.match(
    css,
    /\[data-pi-settings\]\[data-pi-settings-style="codex"\] \.settings-group--first \.settings-group-label \{[^}]*margin-top:\s*16px/,
    "Codex 首组分组标题缺 16px 复位",
  )
  assert.match(
    css,
    /\[data-pi-settings\]\[data-pi-settings-style="codex"\]\.settings-root \{[^}]*line-height:\s*21px/,
    "Codex 设置根行高未回到 21px",
  )
  assert.match(
    css,
    /\[data-pi-settings\]\[data-pi-settings-style="codex"\] \.settings-group-description \{[^}]*margin:\s*8px 2px 0/,
    "Codex 分组说明缺 8/2/0 复位",
  )

  // 设计册总则：网页端不放窗口红黄绿控制。
  assert.doesNotMatch(settingsSourceText, /traffic[-_ ]?light|红绿灯|window-controls?/i)
})

test("本机持久化：新键、版本、逐字段校验、坏数据回落、纯函数不污染入参", () => {
  assert.equal(model.SETTINGS_STORAGE_KEY, "pi_remote_pi_settings_v2")
  assert.equal(model.SETTINGS_STORAGE_VERSION, 1)
  assert.doesNotMatch(settingsSourceText, /pi_remote_pi_prefs|PI_PREFS_KEY/, "不得读写旧偏好键")

  const defaults = model.DEFAULT_SETTINGS_PREFS
  assert.equal(defaults.startView, "last")
  assert.equal(defaults.sendKey, "enter")
  assert.equal(defaults.autoScroll, true)
  assert.equal(defaults.autoArchive, "never")
  assert.equal(defaults.sidebarPersistentSearch, true)
  assert.equal(defaults.speechToText, true)
  assert.equal(defaults.dictationShortcut, "Caps Lock")
  assert.equal(defaults.appearanceStyle, "cursor")
  assert.equal(defaults.appearanceTheme, "system")
  assert.equal(defaults.fontSize, "standard")
  assert.equal(defaults.density, "compact")
  assert.equal(defaults.reducedMotion, false)
  assert.equal(defaults.notifyWaiting, true)
  assert.equal(defaults.notifyError, true)
  assert.equal(defaults.notifyComplete, false)
  assert.equal(defaults.notifyOnlyWhenAway, true)
  assert.equal(defaults.notifySound, false)
  assert.equal(defaults.notifyBadge, true)
  assert.equal(defaults.shortcuts.newSession.join(" "), "⌘ N")
  assert.equal(defaults.shortcuts.stopGeneration.join(" "), "Esc")
  assert.equal(defaults.shortcuts.steerSend.join(" "), "⌥ ⇧ Enter")
  assert.equal(Object.keys(defaults.shortcuts).length, 16)
  assert.equal(defaults.retention, "forever")
  assert.equal(defaults.autoConnectDevice, true)
  assert.equal(defaults.defaultDeviceId, "", "默认设备初始为空；由设备页「设为默认」写入本机偏好")

  const before = structuredClone(defaults)
  const next = model.setSettingsPref(defaults, "autoScroll", false)
  assert.equal(next.autoScroll, false)
  assert.equal(defaults.autoScroll, true, "setSettingsPref 不得原地改入参")
  assert.deepEqual(defaults, before)
  assert.equal(next.shortcuts.newSession.join(" "), "⌘ N", "改普通偏好不动快捷键")

  const merged = model.mergeSettingsPrefs(next, {
    notifySound: true,
    shortcuts: { ...next.shortcuts, newSession: ["Ctrl", "N"] },
  })
  assert.equal(merged.notifySound, true)
  assert.deepEqual(merged.shortcuts.newSession, ["Ctrl", "N"])
  assert.deepEqual(merged.shortcuts.globalSearch, ["⌘", "K"], "快捷键批量改是深合并")

  const dirty = model.parseSettingsLocal({
    v: 1,
    updatedAt: 17,
    prefs: {
      autoScroll: "no",
      sendKey: "nope",
      fontSize: "huge",
      contentWidth: 99999,
      shortcuts: { newSession: ["Alt", "N", "", 3], stopGeneration: [] },
      extraUnknown: "dropped",
    },
  })
  assert.equal(dirty.updatedAt, 17)
  assert.equal(dirty.prefs.autoScroll, true)
  assert.equal(dirty.prefs.sendKey, "enter")
  assert.equal(dirty.prefs.fontSize, "standard")
  assert.equal(dirty.prefs.contentWidth, types.SETTINGS_CONTENT_WIDTH_MAX)
  assert.deepEqual(dirty.prefs.shortcuts.newSession, ["Alt", "N"])
  assert.deepEqual(dirty.prefs.shortcuts.stopGeneration, ["Esc"], "空键位回落默认")
  assert.equal("extraUnknown" in dirty.prefs, false)

  const wrongVersion = model.parseSettingsLocal({ v: 99, prefs: { autoScroll: false }, updatedAt: 9 })
  assert.equal(wrongVersion.v, 1)
  assert.equal(wrongVersion.prefs.autoScroll, true, "版本不符整份回落默认")
  assert.equal(wrongVersion.updatedAt, 0)
  assert.deepEqual(model.parseSettingsLocal("{broken json").prefs, model.createDefaultSettingsPrefs())

  const memory = {
    value: null,
    getItem(key) {
      assert.equal(key, model.SETTINGS_STORAGE_KEY)
      return this.value
    },
    setItem(key, value) {
      assert.equal(key, model.SETTINGS_STORAGE_KEY)
      this.value = value
    },
  }
  assert.equal(model.saveSettingsLocal(memory, next, 1234), true)
  const raw = JSON.parse(memory.value)
  assert.equal(raw.v, 1)
  assert.equal(raw.updatedAt, 1234)
  assert.equal(raw.prefs.autoScroll, false)
  assert.deepEqual(model.loadSettingsLocal(memory).prefs, next)
  assert.equal(model.saveSettingsLocal(null, next), false)
})

test("●/◐/◌ 口径：徽标文案、inert 判定、General 页真实接线", () => {
  assert.equal(types.SETTINGS_STATUS_BADGE.bridge, "需扩展桥")
  assert.equal(types.SETTINGS_STATUS_BADGE.reserved, "设计预留")
  assert.equal(types.settingsItemInert("bridge"), true)
  assert.equal(types.settingsItemInert("reserved"), true)
  assert.equal(types.settingsItemInert("local"), false)
  assert.equal(types.settingsItemInert("existing", true), true)
  assert.equal(types.settingsItemInert("existing", false), false)

  const ui = read("ui/src/pi/settings/ui.tsx")
  const general = read("ui/src/pi/settings/pages/GeneralPage.tsx")
  assert.match(ui, /export function SettingsStatusBadge/)
  assert.match(ui, /data-settings-badge/)
  assert.match(read("ui/src/pi/settings/settings.css"), /\.settings-badge--reserved/)
  assert.match(ui, /export function SettingsReadOnlyRow/)
  assert.match(ui, /export function SettingsSwitch/)
  assert.match(ui, /export function SettingsRadioGroup/)
  assert.match(ui, /export function SettingsSegmented/)
  assert.match(ui, /export function SettingsSelect/)
  assert.match(ui, /export function SettingsSlider/)
  assert.match(ui, /export function SettingsColorDots/)
  assert.match(ui, /export function SettingsShortcutCapture/)

  // 通用页：投递 ×2 + 图片自动缩小改走 settings_set；连接诊断仍是 ◐ 只读。
  assert.ok((general.match(/status="bridge"/g) ?? []).length >= 1, "连接诊断仍要标 ◐")
  assert.match(general, /useSettingsDocument/)
  assert.match(general, /get_settings|settingsSetResultOf|useSettingsWriter/)
  assert.match(general, /steeringModePatch/)
  assert.match(general, /followUpModePatch/)
  assert.match(general, /autoResizeImagesPatch/)
  assert.doesNotMatch(general, /get_state/, "投递值改读 get_settings，不用当前会话状态冒充")
  assert.match(general, /relay\.authed/)
  assert.match(general, /act\.openPairing/)
  assert.ok((general.match(/act\.setPref\(/g) ?? []).length >= 8, "○ 本机项必须即时写偏好")
  assert.match(general, /serverDisplayName/)
})

test("壳与页文件：11 个入口齐、data 标记、内容列宽、返回原会话、统一 barrel", () => {
  const shell = read("ui/src/pi/settings/SettingsPage.tsx")
  assert.match(shell, /data-pi-settings=""/)
  assert.match(shell, /data-pi-settings-style=\{activeStyle\}/)
  assert.match(shell, /data-pi-theme=\{activeTheme\}/)
  assert.match(shell, /data-pi-settings-page=\{activePage\}/)
  assert.match(shell, /settings-column--wide/)
  assert.match(shell, /p\.act\.openSession\(\)/)
  assert.match(shell, /SETTINGS_PAGES\.map/)
  assert.match(shell, /aria-current=\{current \? "page" : undefined\}/)

  const pageFiles = {
    GeneralPage: "general",
    ModelPage: "model",
    ApprovalPage: "approval",
    ExtensionsPage: "extensions",
    AppearancePage: "appearance",
    DevicesPage: "devices",
    NotificationsPage: "notifications",
    ShortcutsPage: "shortcuts",
    PrivacyPage: "privacy",
    UsagePage: "usage",
    AboutPage: "about",
  }
  for (const [component, id] of Object.entries(pageFiles)) {
    const source = read(`ui/src/pi/settings/pages/${component}.tsx`)
    assert.match(source, new RegExp(`export function ${component}\\(`), `${component} 缺导出`)
    assert.ok(source.includes(id), `${component} 缺页 id`)
    assert.ok(shell.includes(component), `SettingsPage 未挂载 ${component}`)
  }

  const barrel = read("ui/src/pi/settings/index.ts")
  assert.match(barrel, /export \* from "\.\/types\.ts"/)
  assert.match(barrel, /export \* from "\.\/model\.ts"/)
  assert.match(barrel, /export \* from "\.\/ui\.tsx"/)
  assert.match(barrel, /export \{ SettingsPage, SettingsPage as default \}/)
  assert.match(barrel, /GeneralPage/)
  assert.match(barrel, /AboutPage/)

  // 文件 / 导出存在性（后续阶段可改内容，不锁占位文案）。
  for (const file of ["types.ts", "model.ts", "SettingsContext.tsx", "ui.tsx", "SettingsPage.tsx", "tokens.css", "settings.css", "index.ts"]) {
    assert.ok(fs.existsSync(path.join(SETTINGS_DIR, file)), `缺 ${file}`)
  }
})
