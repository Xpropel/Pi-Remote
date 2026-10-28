// Pi-Remote 手机端设置 · 独立系统契约测试（纯 Node，无浏览器）。
// 守卫：13 页 IA / 首页 12 入口 / 单列触控与安全区 / 26 周热力图 / 交互页默认列表与 mobileNav 接线 /
//       外观五组（无内容列宽与字体）/ ○ 本机项持久化 / ◐◌ 只读与设计预留标注 / 六皮肤同源 token /
//       桌面外壳未被手机端改动。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const MOBILE_DIR = path.join(ROOT, "ui/src/pi/settings/mobile")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const readMobile = (rel) => fs.readFileSync(path.join(MOBILE_DIR, rel), "utf8")

const types = await import("../ui/src/pi/settings/mobile/types.ts")
const model = await import("../ui/src/pi/settings/mobile/model.ts")
const settingsTypes = await import("../ui/src/pi/settings/types.ts")
const settingsModel = await import("../ui/src/pi/settings/model.ts")

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|css)$/.test(entry.name) && !full.includes(`${path.sep}dev${path.sep}`)) out.push(full)
  }
  return out
}

const mobileSources = walk(MOBILE_DIR)
const mobileText = mobileSources.map((file) => fs.readFileSync(file, "utf8")).join("\n")
const css = readMobile("mobile.css")
const shell = readMobile("MobileSettingsPage.tsx")
const indexPage = readMobile("pages/IndexPage.tsx")
const interactionPage = readMobile("pages/InteractionPage.tsx")
const appearancePage = readMobile("pages/AppearancePage.tsx")
const appearanceCode = appearancePage.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
const usagePage = readMobile("pages/UsagePage.tsx")
const generalPage = readMobile("pages/GeneralPage.tsx")
const privacyPage = readMobile("pages/PrivacyPage.tsx")
const modelPage = readMobile("pages/ModelPage.tsx")
const extensionsPage = readMobile("pages/ExtensionsPage.tsx")
const approvalPage = readMobile("pages/ApprovalPage.tsx")
const mobileDevicesPage = readMobile("pages/DevicesPage.tsx")
const mobileAboutPage = readMobile("pages/AboutPage.tsx")

test("13 个界面：首页 + 11 页同名内容 + 交互；顺序 / 文案 / 入口完整", () => {
  assert.deepEqual(
    [...types.MOBILE_SETTINGS_PAGE_IDS],
    [
      "index",
      "general",
      "model",
      "approval",
      "extensions",
      "appearance",
      "devices",
      "notifications",
      "shortcuts",
      "privacy",
      "usage",
      "about",
      "interaction",
    ],
  )
  assert.equal(types.MOBILE_SETTINGS_PAGE_IDS.length, 13)
  assert.equal(new Set(types.MOBILE_SETTINGS_PAGE_IDS).size, 13)
  assert.equal(types.MOBILE_SETTINGS_PAGE_LABELS.index, "设置")
  assert.equal(types.MOBILE_SETTINGS_PAGE_LABELS.interaction, "交互")
  for (const id of settingsTypes.SETTINGS_PAGE_IDS) {
    assert.equal(types.MOBILE_SETTINGS_PAGE_LABELS[id], settingsTypes.SETTINGS_PAGE_META[id].label, `${id} 与桌面同名`)
  }
  assert.equal(types.MOBILE_INDEX_ENTRIES.length, 12)
  assert.equal(new Set(types.MOBILE_INDEX_ENTRIES).size, 12)
  assert.deepEqual([...types.MOBILE_INDEX_ENTRIES].sort(), [...settingsTypes.SETTINGS_PAGE_IDS, "interaction"].sort())
  assert.equal(types.MOBILE_INDEX_GROUPS[0].label, "移动端")
  assert.deepEqual(types.MOBILE_INDEX_GROUPS[0].entries, ["interaction"])
  assert.equal(types.mobilePageIdOf("nope"), "index")
  assert.equal(types.mobilePageIdOf("usage"), "usage")
  assert.equal(types.mobileContentPageOf("index"), null)
  assert.equal(types.mobileContentPageOf("interaction"), null)
  assert.equal(types.mobileContentPageOf("general"), "general")
})

test("手机几何：单列全宽、触控 ≥44、安全区、26 周热力图", () => {
  assert.deepEqual(types.MOBILE_SETTINGS_METRICS, {
    singleColumn: true,
    touchMin: 44,
    topBarH: 54,
    rowMinH: 48,
    cardRadius: 14,
    contentPaddingX: 16,
    safeAreaBottom: 30,
    heatmapWeeks: 26,
  })
  assert.match(css, /--sm-columns:\s*1;/)
  assert.match(css, /--sm-touch:\s*44px/)
  assert.match(css, /min-height:\s*var\(--sm-touch\)/)
  assert.match(css, /min-height:\s*calc\(var\(--sm-topbar-h\) \+ env\(safe-area-inset-top/)
  // 分段控件：命中区 44，视觉内胆仍按设计（透明 border + 负 margin，不抬高整条控件的节奏）。
  assert.match(
    css,
    /\[data-pi-settings-mobile\] \.sm-segment \{[\s\S]*?min-height:\s*var\(--sm-touch\)[\s\S]*?margin-block:\s*-3px[\s\S]*?border:\s*3px solid transparent/,
    ".sm-segment 命中区必须补到 44",
  )
  assert.match(
    css,
    /\.sm-segmented--compact \.sm-segment \{[\s\S]*?min-height:\s*var\(--sm-touch\)/,
    "compact 分段控件命中区也必须 44",
  )
  assert.match(css, /env\(safe-area-inset-bottom/)
  assert.match(css, /max-width:\s*none/)
  assert.equal(types.MOBILE_SETTINGS_COPY.heatmapWeeksNote, "按屏幕宽度显示近 26 周")
  assert.match(usagePage, /heatmapWeekDates\(todayKey,\s*26\)|MOBILE_SETTINGS_METRICS\.heatmapWeeks/)
  assert.ok(usagePage.includes("MOBILE_SETTINGS_COPY.heatmapWeeksNote"))
  assert.ok(!/52\s*\*\s*7|52 周/.test(usagePage), "手机端不画 52 周")
})

test("26 周日历：26 列 × 7 行、周日开头、含今天与未来格", () => {
  const weeks = model.heatmapWeekDates("2026-10-27", 26)
  assert.equal(weeks.length, 26)
  assert.equal(weeks.every((week) => week.length === 7), true)
  const days = weeks.flat()
  assert.equal(days.length, 182)
  assert.equal(new Set(days).size, 182)
  assert.equal(model.weekdayOf(days[0]), 0)
  assert.equal(model.weekdayOf(days[6]), 6)
  assert.ok(days.includes("2026-10-27"))
  assert.equal(days[0], "2026-05-03")
  assert.equal(days[days.length - 1], "2026-10-31")
  assert.equal(model.addDayKeys("2026-02-28", 1), "2026-03-01")
  assert.equal(model.weekdayOf("2026-02-31"), Number.NaN)
  assert.equal(model.heatmapWeekDates("bad-date").length, 26, "坏锚点回落今天，不崩")
})

test("主机清单解析：供应商 / MCP / 命令（仅手动调用）/ get_settings 宽容读取", () => {
  assert.deepEqual(model.providersOf({ providers: [{ id: "stepfun", displayName: "StepFun", configured: true, models: 2, authSource: "api_key" }] }), [
    { id: "stepfun", name: "StepFun", connected: true, configured: true, models: 2, authSource: "api_key" },
  ])
  assert.deepEqual(model.providersOf(null), [])
  assert.deepEqual(
    model.mcpServersOf({
      servers: [{ name: "github", connected: true, enabled: true, exposure: "direct", toolCount: 12 }],
    }),
    [{ name: "github", connected: true, enabled: true, transport: null, exposure: "direct", toolCount: 12 }],
  )
  const commands = model.commandsOf(
    {
      commands: [
        { name: "review", description: "审查", source: "skill", sourceInfo: { disableModelInvocation: true } },
        { name: "summarize", description: "总结", source: "prompt" },
      ],
    },
    "skill",
  )
  assert.deepEqual(commands, [{ name: "review", description: "审查", source: "skill", manualOnly: true }])
  assert.equal(model.commandsOf({ commands: [{ name: "review", source: "prompt" }] }, "prompt").length, 1)
  const settings = model.hostSettingsOf({ settings: { compaction: { enabled: false }, enableSkillCommands: true } })
  assert.equal(model.settingBool(settings, ["compaction.enabled"], true), false)
  assert.equal(model.settingText(settings, ["defaultModel", "model"], "—"), "—")
  assert.deepEqual(model.nameListAt({ packages: ["a", { name: "b" }, "a"] }, ["packages"]), ["a", "b"])
  assert.deepEqual(model.modelThinkingRowsOf(model.hostSettingsOf({ settings: { modelThinkingLevels: { "step-5-preview": "max", "step-3.7-flash": "high" } } })), [
    { model: "step-5-preview", level: "max" },
    { model: "step-3.7-flash", level: "high" },
  ])
  assert.deepEqual(model.modelThinkingRowsOf({ modelThinkingLevels: {} }), [])
  assert.equal(model.settingNumber({ compaction: { reserveTokens: 16384 } }, ["compaction.reserveTokens"]), 16384)
  assert.equal(model.settingNumber({ compaction: { reserveTokens: -1 } }, ["compaction.reserveTokens"]), null)
  assert.equal(model.settingNumber({}, ["compaction.reserveTokens"]), null)
  assert.equal(model.availableModelCountOf({ models: [{}, {}] }), 2)
  assert.equal(model.availableModelCountOf(null), 0)
  assert.equal(model.cacheSizeLabel(2048), "2 KB")
  assert.equal(model.connectionLabel({ authed: true, browserOnline: true }), "已连接")
})

test("13 页均有导出与外壳挂载；首页 → 内容页 / 内容页 → 首页 / 退出回原会话", () => {
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
    InteractionPage: "interaction",
  }
  for (const [component, id] of Object.entries(pageFiles)) {
    const source = readMobile(`pages/${component}.tsx`)
    assert.match(source, new RegExp(`export function ${component}\\(`), `${component} 缺导出`)
    assert.ok(source.includes(id), `${component} 缺页 id`)
    assert.ok(shell.includes(component), `外壳未挂载 ${component}`)
  }
  assert.ok(shell.includes("MobileIndexPage"))
  assert.ok(indexPage.includes("MOBILE_INDEX_GROUPS"))
  assert.match(shell, /p\.act\.openSession\(\)/)
  assert.match(shell, /initialPage/)
  assert.match(shell, /onPageChange/)
  assert.match(shell, /data-pi-settings-mobile=""/)
  assert.match(shell, /data-pi-settings-style=\{activeStyle\}/)
  assert.match(shell, /data-pi-theme=\{activeTheme\}/)
  assert.match(shell, /data-pi-settings-page=\{activePage\}/)
  assert.match(shell, /aria-modal="true"/)
  assert.match(shell, /Escape/)
  assert.match(shell, /settings-mobile/)
  assert.match(shell, /useSettingsLocalState/)
  assert.match(shell, /settingsStyleOf\(p\.ui\.prefs\.ui\)/)
})

test("交互页：默认列表式、接 ui.prefs.mobileNav、即时写宿主偏好、文案逐字", () => {
  assert.equal(types.MOBILE_NAV_DEFAULT, "list")
  assert.deepEqual([...types.MOBILE_NAV_MODES], ["list", "drawer"])
  assert.match(interactionPage, /p\.ui\.prefs\.mobileNav/)
  assert.match(interactionPage, /p\.act\.setPref\("mobileNav"/)
  assert.match(interactionPage, /MOBILE_NAV_DEFAULT/)
  assert.ok(interactionPage.includes("PI_MOBILE_NAV_COPY"))
  assert.ok(interactionPage.includes("PI_MOBILE_NAV_COPY.footnote"))
  assert.match(interactionPage, /data-mobile-nav-option/)
  assert.match(interactionPage, /role="radiogroup"/)
})

test("外观：五组、去掉内容列宽与字体、六皮肤 / 字号 / 密度 / 动态效果即时持久化", () => {
  const groups = appearancePage.match(/<MobileGroup/g) ?? []
  assert.equal(groups.length, 5, "手机外观只保留五组")
  assert.equal((appearancePage.match(/<MobileGroup label="界面风格"/g) ?? []).length, 1)
  assert.equal((appearancePage.match(/<MobileGroup label="明暗"/g) ?? []).length, 1)
  assert.equal((appearancePage.match(/<MobileGroup label="强调色"/g) ?? []).length, 1)
  assert.equal((appearancePage.match(/<MobileGroup label="字号"/g) ?? []).length, 1)
  assert.equal((appearancePage.match(/<MobileGroup label="界面密度"/g) ?? []).length, 1)
  assert.doesNotMatch(appearanceCode, /内容列宽|界面字体|等宽字体|uiFont|monoFont|contentWidth/)
  for (const key of ["fontSize", "density", "reducedMotion"]) {
    assert.ok(appearancePage.includes(`setPref("${key}"`), `外观缺 ${key} 的即时写入`)
  }
  assert.match(appearancePage, /setPref\("appearanceTheme"/)
  assert.match(appearancePage, /mergePrefs\(\{ appearanceStyle: next, accent: IDENTITY_ACCENT\[next\] \}\)/)
  assert.match(appearancePage, /p\.act\.setUiVariant\(next\)/, "界面风格立即换宿主皮肤")
  assert.match(appearancePage, /p\.act\.setPref\("theme"/, "明暗立即换宿主主题")
  assert.ok(appearancePage.includes("IDENTITY_ACCENT"))
  assert.ok(appearancePage.includes("SETTINGS_ACCENTS"))
  assert.ok(appearancePage.includes("ACCENT_SWATCH"))
  assert.ok(appearancePage.includes("onPreviewStyle"))
  assert.ok(appearancePage.includes("onPreviewTheme"))
})

test("○ 本机项即时持久化；◐ / ◌ 只读与标注；● 接真实 relay / 主机能力", () => {
  // 隐私模式与宿主消费的其它本机偏好一样，直接写 prefs.privacyMode（不是 settings_set）。
  assert.match(privacyPage, /<MobileSwitchRow[\s\S]*?title="隐私模式"[\s\S]*?checked=\{prefs\.privacyMode\}/)
  assert.match(privacyPage, /act\.setPref\("privacyMode"/)
  assert.match(privacyPage, /仅本机显示脱敏，不改设备数据/)
  assert.doesNotMatch(privacyPage, /隐私模式（设计预留）|status="reserved"/)
  assert.doesNotMatch(privacyPage, /writer\.save\("privacyMode"/, "隐私模式不得走 settings_set 写桥")
  // ○：通用 / 通知 / 快捷键 / 隐私 / 外观 / 设备 / 使用活动都走 act.setPref。
  const setPrefCount = (mobileText.match(/act\.setPref\(/g) ?? []).length
  assert.ok(setPrefCount >= 20, `本机项写入过少：${setPrefCount}`)
  for (const source of [generalPage, privacyPage, usagePage, appearancePage]) {
    assert.ok(source.includes("act.setPref("), "本地页必须即时写偏好")
  }
  // 存储契约仍由共享 model 提供（本机 localStorage）。
  assert.equal(settingsModel.SETTINGS_STORAGE_KEY, "pi_remote_pi_settings_v2")

  // ◐ / ◌：徽标由共享原子给，页面必须传状态；可写项已从只读集合移出，但剩下的仍要标。
  assert.ok((mobileText.match(/status="bridge"/g) ?? []).length >= 12)
  assert.ok((mobileText.match(/status="reserved"/g) ?? []).length >= 9)
  assert.match(readMobile("atoms.tsx"), /SettingsStatusBadge/)
  assert.ok(mobileText.includes("settingsItemInert"))
  assert.ok(mobileText.includes("inert={inert"))

  // settings_set 写桥：五个内容页都接 useSettingsWriter，值从 get_settings 读，不写本机偏好。
  for (const page of ["GeneralPage.tsx", "ModelPage.tsx", "PrivacyPage.tsx", "ExtensionsPage.tsx", "ApprovalPage.tsx"]) {
    const source = readMobile(`pages/${page}`)
    assert.ok(source.includes("useSettingsWriter"), `${page} 缺 settings_set 写桥`)
    assert.ok(source.includes("useSettingsDocument"), `${page} 值必须从 get_settings 读`)
    assert.ok(source.includes("MobileSettingsWriteNote"), `${page} 缺保存 / 失败提示`)
    assert.doesNotMatch(source, /setPref\("(steeringMode|followUpMode|enableInstallTelemetry|enableSkillCommands|defaultProjectTrust|defaultModel|defaultThinkingLevel|hideThinkingBlock|compaction)/)
  }

  // ●：真实 relay / 命令。
  assert.ok(readMobile("pages/GeneralPage.tsx").includes("relay.serverName"))
  assert.ok(readMobile("pages/GeneralPage.tsx").includes("act.openPairing"))
  assert.ok(readMobile("pages/DevicesPage.tsx").includes("relay.devices"))
  assert.ok(readMobile("pages/ApprovalPage.tsx").includes("set_active_tools"))
  assert.ok(readMobile("pages/ApprovalPage.tsx").includes("get_active_tools"))
  assert.ok(readMobile("pages/ModelPage.tsx").includes("get_provider_auth"))
  assert.ok(readMobile("pages/ExtensionsPage.tsx").includes("get_mcp_servers"))
  assert.ok(usagePage.includes("useUsageActivity"))
  assert.ok(readMobile("pages/AboutPage.tsx").includes("serverDisplayName"))
  assert.ok(readMobile("pages/PrivacyPage.tsx").includes("buildDataExport"))
  assert.ok(readMobile("pages/PrivacyPage.tsx").includes("parseSettingsImport"))
  assert.ok(readMobile("pages/PrivacyPage.tsx").includes("downloadTextFile"))
  assert.ok(readMobile("pages/PrivacyPage.tsx").includes("clearCacheStorage"))
})

test("手机数据真实性：模型 / 扩展 / 审批不再用设计示例兜底，模型刷新接真命令", () => {
  // 模型：默认模型只认 get_settings；不拿当前会话模型 / 思考档冒充
  assert.match(modelPage, /get_settings/)
  assert.match(modelPage, /get_available_models/)
  assert.match(modelPage, /modelsQuery\.reload/)
  assert.match(modelPage, /重新向 pi 读取模型清单/)
  assert.match(modelPage, /setLastModels\(\{ room: roomKey, data: modelsQuery\.data \}\)/)
  assert.match(modelPage, /仍显示上次读取的清单/)
  assert.match(modelPage, /disabled=\{!ready \|\| modelsLoading\}/)
  assert.doesNotMatch(modelPage.replace(/\/\*[\s\S]*?\*\//g, ""), /relay\.modelMeta|relay\.thinkingLevel|claude-sonnet-4-5/)
  assert.doesNotMatch(modelPage.replace(/\/\*[\s\S]*?\*\//g, ""), /fallbackModel|currentThinking/)

  // 扩展：主机无回包时显示空态 / 连接提示，不列固定技能 / MCP / 模板
  assert.doesNotMatch(mobileText, /SKILL_FALLBACK|MCP_FALLBACK|PROMPT_FALLBACK/)
  for (const text of ["连接主机后显示技能清单", "连接主机后显示 MCP 服务器", "连接主机后显示提示词模板", "尚未发现技能", "尚未配置 MCP 服务器", "尚未发现提示词模板"]) {
    assert.ok(extensionsPage.includes(text), `扩展页缺空态文案：${text}`)
  }

  // 审批：没有工具表时不摆 8 个设计示例工具
  assert.doesNotMatch(mobileText, /FALLBACK_TOOLS|FALLBACK_ACTIVE/)
  assert.match(approvalPage, /连接主机后显示可用工具/)
  assert.match(approvalPage, /可用工具读取失败/)
  assert.match(approvalPage, /rows\.length === 0/)
})

test("手机设备 / 关于：延迟、测试连接、默认设备、pi 版本、诊断导出、检查更新", () => {
  assert.match(mobileDevicesPage, /deviceLatencyTextOf\(device\.latencyMs\)/)
  assert.match(mobileDevicesPage, /DEVICE_RTT_SCOPE/)
  assert.match(mobileDevicesPage, /deviceRoundTripTextOf/)
  assert.match(mobileDevicesPage, /runDeviceCommand/)
  assert.match(mobileDevicesPage, /runCommand\("get_state"\)/)
  assert.match(mobileDevicesPage, /defaultDeviceId/)
  assert.match(mobileDevicesPage, /act\.setPref\("defaultDeviceId"/)
  assert.match(mobileDevicesPage, /默认设备/)
  assert.doesNotMatch(mobileDevicesPage, /data-sources?|暂无数据源或接口/)

  assert.match(mobileAboutPage, /get_host_diag/)
  assert.match(mobileAboutPage, /normalizeHostDiag/)
  assert.match(mobileAboutPage, /buildDiagnosticsExport/)
  assert.match(mobileAboutPage, /downloadTextFile/)
  assert.match(mobileAboutPage, /checkLatestRelease/)
  assert.match(mobileAboutPage, /CLIENT_VERSION/)
})

test("样式作用域 / 六皮肤 token / Claude 衬线范围 / 无旧偏好键与窗口控制", () => {
  // 所有规则都在 [data-pi-settings-mobile] 下；正文单列，不出现 260/692 桌面几何。
  assert.doesNotMatch(css, /(^|\n)\.sm-[a-z-]+\s*\{/, "存在未作用域化的 .sm- 规则")
  assert.ok(!css.includes("--st-rail-w"))
  assert.ok(!css.includes("--st-content-w"))
  assert.match(css, /--st-font-display/)
  assert.equal((css.match(/var\(--st-font-display\)/g) ?? []).length, 2, "衬线只给顶栏标题与分组标题")
  assert.match(css, /--st-font-sans/)
  // 颜色只用 token；唯一例外是使用活动的陶土两点（Codex 改蓝）。
  const colors = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []
  assert.deepEqual(colors.sort(), ["#6cb0ee", "#d97757"], "mobile.css 只允许设计册两处陶土/Codex 蓝")
  assert.match(css, /data-pi-settings-style="codex"\]\s*\{\s*--sm-usage-clay:\s*#6cb0ee/)
  assert.match(tokensImported(), /\.\/tokens\.css|\.\.\/tokens\.css/)
  for (const style of types.MOBILE_SKIN_STYLES) {
    assert.ok(fs.existsSync(path.join(ROOT, `ui/src/pi/settings/tokens.css`)), "六皮肤 token 同源")
    assert.ok(css.includes("var(--st-"), `${style} 应消费 --st-*`)
  }
  assert.doesNotMatch(mobileText, /pi_remote_pi_prefs|PI_PREFS_KEY/, "手机端设置不得读写旧偏好键")
  assert.doesNotMatch(mobileText, /traffic[-_ ]?light|红绿灯|window-controls?/i)
})

function tokensImported() {
  return shell
}

test("桌面外壳未被手机端改动（手机端只落 settings/mobile/**）", () => {
  const desktopShell = read("ui/src/pi/settings/SettingsPage.tsx")
  assert.ok(desktopShell.includes("settings-rail"))
  assert.ok(desktopShell.includes("SETTINGS_PAGES.map"))
  assert.ok(!desktopShell.includes("MobileSettingsPage"))
  assert.ok(!desktopShell.includes("settings-mobile"))
  assert.ok(!read("ui/src/pi/settings/index.ts").includes("MobileSettingsPage"), "桌面包不混入手机端入口")
  assert.ok(!shell.includes("../SettingsPage"), "手机外壳不反向依赖桌面外壳")
  assert.ok(!shell.includes("../pages/"), "手机外壳不依赖桌面页面")
  assert.equal(fs.existsSync(path.join(MOBILE_DIR, "index.ts")), true)
  const barrel = readMobile("index.ts")
  assert.match(barrel, /export \{ MobileSettingsPage, MobileSettingsPage as default \}/)
  assert.match(barrel, /export \* from "\.\/types\.ts"/)
  assert.match(barrel, /export \* from "\.\/model\.ts"/)
})
