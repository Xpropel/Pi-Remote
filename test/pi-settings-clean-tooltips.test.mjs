// 设置页去冗文案与 1.5s 标题悬停提示契约测试（纯 Node，无浏览器）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const uiSource = read("ui/src/pi/settings/ui.tsx")
const mobileAtomsSource = read("ui/src/pi/settings/mobile/atoms.tsx")
const settingsCss = read("ui/src/pi/settings/settings.css")

const DESKTOP_PAGES = [
  "UsagePage.tsx",
  "GeneralPage.tsx",
  "ModelPage.tsx",
  "ApprovalPage.tsx",
  "ExtensionsPage.tsx",
  "AppearancePage.tsx",
  "DevicesPage.tsx",
  "IdentitySection.tsx",
  "NotificationsPage.tsx",
  "ShortcutsPage.tsx",
  "PrivacyPage.tsx",
  "AboutPage.tsx",
]

const MOBILE_PAGES = DESKTOP_PAGES

test("SettingsHoverTitle：固定 1500ms 延迟触发，移出 / 点击 / 滚动 / Esc 立即清理", () => {
  assert.match(uiSource, /export const SETTINGS_TITLE_TOOLTIP_DELAY_MS = 1500/)
  assert.match(uiSource, /export function SettingsHoverTitle\(/)
  assert.match(uiSource, /window\.setTimeout\([\s\S]*?SETTINGS_TITLE_TOOLTIP_DELAY_MS\)/)
  assert.match(uiSource, /role="tooltip"/)
  for (const event of ["onMouseEnter", "onMouseLeave", "onPointerDown", "scroll", "Escape"]) {
    assert.ok(uiSource.includes(event), `SettingsHoverTitle 缺 ${event} 清理/触发链路`)
  }
  assert.match(uiSource, /setTip\(null\)/)
})

test("桌面与手机端原语均已透传 tooltip 到标题与分组标签", () => {
  assert.match(uiSource, /export interface SettingsRowProps[\s\S]{0,200}tooltip\?: string/)
  assert.match(mobileAtomsSource, /export interface MobileRowProps[\s\S]{0,200}tooltip\?: string/)
  for (const fn of [
    "SettingsPageTitle",
    "SettingsGroup",
    "SettingsRow",
    "SettingsReadOnlyRow",
    "SettingsActionRow",
    "SettingsActionBar",
    "SettingsRadioGroup",
    "SettingsInlineRadio",
    "SettingsSelect",
    "SettingsSlider",
    "SettingsColorDots",
  ]) {
    assert.match(uiSource, new RegExp(`export function ${fn}\\b[\\s\\S]{0,600}\\btooltip\\b`), `${fn} 缺 tooltip prop`)
  }

  for (const fn of [
    "MobileGroup",
    "MobileRow",
    "MobileReadOnlyRow",
    "MobileActionRow",
    "MobileActionBar",
    "MobileSwitchRow",
    "MobileField",
    "MobileSelect",
  ]) {
    assert.match(mobileAtomsSource, new RegExp(`export function ${fn}\\b[\\s\\S]{0,600}\\btooltip\\b`), `${fn} 缺 tooltip prop`)
  }
  assert.match(mobileAtomsSource, /import \{[\s\S]*SettingsHoverTitle[\s\S]*\} from "\.\.\/ui\.tsx"/)
})

test("settings.css 悬停提示条仅用 --st-* 令牌、配对 squircle 与无障碍减动效", () => {
  const start = settingsCss.indexOf(".settings-has-tooltip")
  assert.ok(start >= 0, "settings.css 缺 .settings-has-tooltip 规则")
  const block = settingsCss.slice(start)
  assert.deepEqual(block.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [], [])
  assert.match(block, /\.settings-title-tip\b/)
  assert.match(block, /\.settings-title-tip--above\b/)
  assert.match(block, /--cw-pi-z-raised/)
  assert.match(block, /border-radius:\s*var\(--st-radius-row\)/)
  assert.match(block, /corner-shape:\s*squircle/)
  assert.match(settingsCss, /prefers-reduced-motion:\s*reduce[\s\S]*?\.settings-title-tip/)
})

test("使用活动页已清除冗余引导文案与图例废话，保留技术悬停解释", () => {
  const desktopUsage = stripComments(read("ui/src/pi/settings/pages/UsagePage.tsx"))
  const mobileUsage = stripComments(read("ui/src/pi/settings/mobile/pages/UsagePage.tsx"))

  for (const banned of [
    "你在这台机器上使用 pi 的情况",
    "每格代表一天，颜色越深用量越高",
    "可在右上角设定月度预算",
    "按近 30 天活跃日计算",
    "近一年共使用",
    "settings-usage-legend",
    "settings-usage-heat-foot",
    "settings-usage-footnote",
  ]) {
    assert.ok(!desktopUsage.includes(banned), `桌面 UsagePage 仍残留废话：${banned}`)
  }

  for (const banned of [
    "每格代表一天",
    "颜色越深用量越高",
    "可在右上角设定月度预算",
    "按近 30 天活跃日计算",
    "sm-heat-foot",
  ]) {
    assert.ok(!mobileUsage.includes(banned), `手机 UsagePage 仍残留废话：${banned}`)
  }

  assert.match(desktopUsage, /usageCoverageText/)
  assert.match(desktopUsage, /tooltip=/)
  assert.match(mobileUsage, /offlineCache/)
  assert.match(mobileUsage, /tooltip=/)
})

test("全部设置页已清扫显而易见的废话并保留核心概念 1.5s 悬停提示", () => {
  const allDesktop = DESKTOP_PAGES.map((name) => stripComments(read(`ui/src/pi/settings/pages/${name}`))).join("\n")
  const allMobile = MOBILE_PAGES.map((name) => stripComments(read(`ui/src/pi/settings/mobile/pages/${name}`))).join("\n")

  for (const banned of [
    "关闭时用功能键唤出搜索",
    "对话太长时自动把旧消息总结成摘要，腾出空间",
    "发送首条消息时自动截取首行作为会话标题",
    "把技能注册成 /skill:名字 命令；关了仍可手动输入调用",
    "停用的技能与服务器不会出现在会话里。",
    "切换立即应用到整个界面，只保存在这个浏览器里。",
    "点任意一行右侧的键位即可改键。",
    "个人远程会话 · 单用户",
    "Pi-Remote 为个人项目，仅供本人使用。",
    "导出脱敏诊断 JSON、检查 GitHub 新版本或查看开源许可",
    "填入名称、接口地址与 API 密钥；支持 OpenAI / Anthropic / Google 端点",
  ]) {
    assert.ok(!allDesktop.includes(banned), `桌面设置页仍残留冗余文案：${banned}`)
    assert.ok(!allMobile.includes(banned), `手机设置页仍残留冗余文案：${banned}`)
  }

  for (const [page, requiredTooltipToken] of [
    ["ModelPage.tsx", "触发上下文压缩时为模型下一轮输出"],
    ["ModelPage.tsx", "MODEL_THINKING_LEVELS_COPY"],
    ["ApprovalPage.tsx", "APPROVAL_TRUST_NOTE"],
    ["ExtensionsPage.tsx", "扩展拥有完整系统权限"],
    ["DevicesPage.tsx", "DEVICE_RTT_SCOPE"],
    ["IdentitySection.tsx", "IDENTITY_PHASE_NOTE"],
    ["NotificationsPage.tsx", "离开页面时通过浏览器发送系统通知"],
    ["PrivacyPage.tsx", "仅本机显示脱敏，不改设备数据"],
    ["AboutPage.tsx", "清理后只移除本机浏览器缓存"],
  ]) {
    const d = read(`ui/src/pi/settings/pages/${page}`)
    const m = read(`ui/src/pi/settings/mobile/pages/${page}`)
    assert.match(d, new RegExp(`tooltip=[\\s\\S]{0,240}${requiredTooltipToken}`), `桌面 ${page} 缺 tooltip：${requiredTooltipToken}`)
    assert.match(m, new RegExp(`tooltip=[\\s\\S]{0,240}${requiredTooltipToken}`), `手机 ${page} 缺 tooltip：${requiredTooltipToken}`)
  }
})
