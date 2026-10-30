// Pi-Remote 设置页 v2 · 第 5 轮 A11Y 回归（纯 Node，无浏览器）：
//   1. 桌面 / 手机设置根是 dialog（role / aria-modal / 可访问名）+ 焦点管理接线（进入 / 循环 / Esc / 还原）；
//   2. select / 滑杆的 :focus-visible 焦点环用中性 token、特异性压过 pi-theme、手机 select 同样；
//   3. 六皮肤次级文字 ≥4.5、关闭/开启开关与滑杆非文字 ≥3（token 层直接复算）；
//   4. radiogroup 支持 ArrowLeft/Right（循环、跳过 disabled），Space 走原生。
//
// token 复算用与 CSS 相同的 hex / rgba / color-mix / var() 解析；不是浏览器像素验收
// （真实截图验收见 docs/pi-settings-v2-a11y-r5/verify.cjs）。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "")

const radio = await import("../ui/src/pi/settings/radioNav.ts")

/* ------------------------------------------------------------------ */
/* 颜色解析（hex / rgb[a] / color(srgb) / var / color-mix / transparent） */
/* ------------------------------------------------------------------ */

function hexColor(text) {
  const h = text.slice(1)
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h
  const alpha = full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: alpha }
}

function parseColor(text, vars, depth = 0) {
  if (depth > 12) throw new Error(`颜色解析递归过深：${text}`)
  const value = String(text).trim()
  if (!value) return null
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 }
  if (value.startsWith("var(")) {
    const name = value.slice(4, value.indexOf(")")).trim()
    assert.ok(vars.has(name), `缺少 token：${name}`)
    return parseColor(vars.get(name), vars, depth + 1)
  }
  if (value.startsWith("#")) return hexColor(value)
  if (value.startsWith("color(srgb")) {
    const parts = value.slice(value.indexOf("srgb") + 4, value.lastIndexOf(")")).replace("/", " ").trim().split(/\s+/)
    return {
      r: Math.round(Number(parts[0]) * 255),
      g: Math.round(Number(parts[1]) * 255),
      b: Math.round(Number(parts[2]) * 255),
      a: parts[3] == null ? 1 : Number(parts[3]),
    }
  }
  if (value.startsWith("rgb")) {
    const parts = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")")).split(/[,/ ]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] == null ? 1 : parts[3] }
  }
  if (value.startsWith("color-mix(")) {
    const inner = value.slice(value.indexOf("(") + 1, value.lastIndexOf(")"))
    assert.match(inner, /^in srgb,/i, `只支持 srgb color-mix：${value}`)
    const rest = inner.replace(/^in srgb,\s*/i, "")
    // 形如：var(--x) 54%, var(--y) 46% —— 允许省略一个百分比。
    const match = /^(.*?)\s+([\d.]+)%\s*,\s*(.*?)(?:\s+([\d.]+)%)?$/s.exec(rest)
    assert.ok(match, `color-mix 解析失败：${value}`)
    const left = parseColor(match[1], vars, depth + 1)
    const right = parseColor(match[3], vars, depth + 1)
    const leftPct = Number(match[2]) / 100
    const rightPct = match[4] == null ? 1 - leftPct : Number(match[4]) / 100
    const sum = leftPct + rightPct
    // CSS color-mix 在 premultiplied alpha 下插值：和白 / transparent 混合时
    // 88% 白色 + 12% 透明 = rgba(255,255,255,.88)，不是 rgb(224,224,224,.88)。
    const alpha = (left.a * leftPct + right.a * rightPct) / sum
    assert.ok(alpha > 0, `color-mix 结果全透明：${value}`)
    return {
      r: (left.r * left.a * leftPct + right.r * right.a * rightPct) / sum / alpha,
      g: (left.g * left.a * leftPct + right.g * right.a * rightPct) / sum / alpha,
      b: (left.b * left.a * leftPct + right.b * right.a * rightPct) / sum / alpha,
      a: alpha,
    }
  }
  throw new Error(`未识别的颜色：${value}`)
}

function over(fg, bg) {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  }
}

function luminance(color) {
  const f = (v) => {
    const x = v / 255
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(color.r) + 0.7152 * f(color.g) + 0.0722 * f(color.b)
}

function contrast(a, b) {
  const l1 = luminance(a)
  const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

/* ------------------------------------------------------------------ */
/* token 块                                                            */
/* ------------------------------------------------------------------ */

const TOKENS = stripComments(read("ui/src/pi/settings/tokens.css"))
const STYLES = ["cursor", "claude", "codex"]
const THEMES = ["light", "dark"]

function blockOf(source, selectorStart) {
  const at = source.indexOf(selectorStart)
  assert.notEqual(at, -1, `缺少选择器：${selectorStart}`)
  const open = source.indexOf("{", at)
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

function declarationsOf(source) {
  const map = new Map()
  for (const line of source.split(";")) {
    const at = line.indexOf(":")
    if (at < 0) continue
    const name = line.slice(0, at).trim()
    if (!name.startsWith("--")) continue
    map.set(name, line.slice(at + 1).trim())
  }
  return map
}

const baseVars = declarationsOf(blockOf(TOKENS, "[data-pi-settings] {"))
const SKIN_VARS = {}
for (const style of STYLES) {
  for (const theme of THEMES) {
    const selector = `[data-pi-settings][data-pi-settings-style="${style}"][data-pi-theme="${theme}"]`
    const vars = new Map(baseVars)
    for (const [name, value] of declarationsOf(blockOf(TOKENS, selector))) vars.set(name, value)
    SKIN_VARS[`${style}-${theme}`] = vars
  }
}

/** 产品里最不利的合成底：浅色取白，深色取比卡底更亮的玻璃底（文字对比更低）。 */
const PAGE_BASE = { light: { r: 255, g: 255, b: 255 }, dark: { r: 42, g: 42, b: 46 } }

function paletteOf(key) {
  const vars = SKIN_VARS[key]
  const theme = key.endsWith("dark") ? "dark" : "light"
  const base = PAGE_BASE[theme]
  const page = over(parseColor(vars.get("--st-page-bg"), vars), base)
  const menu = over(parseColor(vars.get("--st-menu-bg"), vars), base)
  const card = over(parseColor(vars.get("--st-card-bg"), vars), page)
  const tile = over(parseColor(vars.get("--st-tile-bg"), vars), card)
  const pick = (name) => over(parseColor(vars.get(name), vars), card)
  return {
    vars,
    theme,
    page,
    menu,
    card,
    tile,
    text1: pick("--st-text-1"),
    text2: pick("--st-text-2"),
    text3: pick("--st-text-3"),
    text4: pick("--st-text-4"),
    switchOff: pick("--st-switch-off"),
    switchOn: pick("--st-switch-on"),
    switchKnobOn: pick("--st-switch-knob-on"),
    sliderAccent: pick("--st-slider-accent"),
    accentStrong: pick("--st-accent-strong"),
    accentSoft: over(parseColor(vars.get("--st-accent-soft"), vars), card),
    focusRing: over(parseColor(vars.get("--st-field-focus-ring"), vars), card),
    wait: pick("--st-wait"),
    badgeBridgeBg: over(parseColor(vars.get("--st-badge-bridge-bg"), vars), card),
    badgeBridgeFg: pick("--st-badge-bridge-fg"),
  }
}

/* ------------------------------------------------------------------ */
/* 1. dialog 语义与焦点接线                                             */
/* ------------------------------------------------------------------ */

const settingsPage = stripComments(read("ui/src/pi/settings/SettingsPage.tsx"))
const mobilePage = stripComments(read("ui/src/pi/settings/mobile/MobileSettingsPage.tsx"))
const focusHook = stripComments(read("ui/src/pi/settings/dialogFocus.ts"))

test("A11Y-01 桌面 / 手机设置根：role=dialog + aria-modal + aria-label=设置 + 程序化焦点兜底", () => {
  for (const [name, source] of [["desktop", settingsPage], ["mobile", mobilePage]]) {
    assert.match(source, /role="dialog"/, `${name} 根缺 role=dialog`)
    assert.match(source, /aria-modal="true"/, `${name} 根缺 aria-modal`)
    assert.match(source, /aria-label="设置"/, `${name} 根缺 aria-label=设置`)
    assert.match(source, /tabIndex=\{-1\}/, `${name} 根缺 tabIndex=-1（无焦点项时的兜底）`)
    assert.match(source, /useSettingsDialogFocus\(\{/, `${name} 未接焦点管理`)
  }
})

test("A11Y-01 打开聚焦导航首项 / 手机返回键；Esc 回原会话；关闭还焦点给触发器", () => {
  assert.match(settingsPage, /initialFocusSelector:\s*"\.settings-nav-item"/, "桌面未聚焦导航首项")
  assert.match(settingsPage, /onEscape:\s*act\.back/, "桌面 Esc 未回原会话")
  assert.match(settingsPage, /escapeBlocked:\s*\(\)\s*=>\s*piDialogOf\(p\)\s*!=\s*null/, "桌面 Esc 没让位给设置内浮层")
  assert.match(mobilePage, /initialFocusSelector:\s*"\.sm-back"/, "手机未聚焦返回键")
  assert.match(mobilePage, /onEscape:\s*back/, "手机 Esc 未走分层返回")
  assert.match(mobilePage, /escapeBlocked:\s*\(\)\s*=>\s*piDialogOf\(p\)\s*!=\s*null/, "手机 Esc 没让位给 sheet")

  assert.match(focusHook, /focusableWithin\(root\)/, "缺 Tab 可聚焦清单")
  assert.match(focusHook, /event\.shiftKey/, "缺 Shift+Tab 反向循环")
  assert.match(focusHook, /focusables\[focusables\.length - 1\]\.focus/, "Shift+Tab 未从首项回末项")
  assert.match(focusHook, /focusables\[0\]\.focus/, "Tab 未从末项回首项")
  assert.match(focusHook, /window\.addEventListener\("keydown", onKeyDownCapture, true\)/, "缺 Esc 捕获阶段判定（浮层先关自己）")
  assert.match(focusHook, /if \(claimed \|\| event\.defaultPrevented\) return/, "Esc 未尊重浮层的 preventDefault")
  assert.match(focusHook, /event\.stopPropagation\(\)/, "设置在最上层时未截住手机壳 / 桌面壳的全局 Esc")
  assert.match(focusHook, /hasOpenNestedOverlay\(root\)/, "Esc / Tab 未让位给设置内浮层")
  assert.match(focusHook, /requestAnimationFrame\(\(\) => \{/, "关闭未在下一帧还原焦点")
  assert.match(focusHook, /restoreTriggerOf\(returnFocus\.current\)/, "关闭未按触发器还原焦点")
  assert.match(focusHook, /visibleSettingsTrigger\(\)/, "手机入口重挂载时缺按 aria-label 找回")
  assert.match(focusHook, /firstFocusableOutsideSettings\(\)/, "触发器已卸载时缺焦点兜底")
  assert.match(focusHook, /cancelAnimationFrame\(restoreFrame\.current\)/, "StrictMode 双执行时未取消上一帧还原")
})

test("A11Y-01 支持 Esc 关闭且不与设置内浮层连关两层", () => {
  assert.match(settingsPage, /piDialogOf\(p\)/, "桌面未识别宿主 dialog / sheet")
  assert.match(mobilePage, /piDialogOf\(p\)/, "手机未识别宿主 dialog / sheet")
  assert.match(focusHook, /\[role="dialog"\]\[aria-modal="true"\]/, "DOM 层未识别更高一层的 dialog")
  assert.match(focusHook, /\[role="menu"\]/, "DOM 层未识别菜单")
  assert.match(focusHook, /\[data-pi-dialog\]/, "DOM 层未识别 Pi 弹窗")
})

/* ------------------------------------------------------------------ */
/* 2. select / 滑杆焦点环                                               */
/* ------------------------------------------------------------------ */

const settingsCss = stripComments(read("ui/src/pi/settings/settings.css"))
const mobileCss = stripComments(read("ui/src/pi/settings/mobile/mobile.css"))

test("A11Y-02 select / 滑杆有高特异性可见焦点环（中性色、2px、非 pi-theme 蓝）", () => {
  assert.match(
    settingsCss,
    /\[data-pi-settings\]\[data-pi-settings-style\]\[data-pi-theme\]\s+\.settings-select:focus-visible/,
    "桌面 select 焦点环特异性不足",
  )
  assert.match(
    settingsCss,
    /\[data-pi-settings\]\[data-pi-settings-style\]\[data-pi-theme\]\s+\.settings-slider:focus-visible/,
    "桌面滑杆焦点环特异性不足",
  )
  assert.match(settingsCss, /outline:\s*2px solid var\(--st-field-focus-ring\)/, "焦点环不是 2px 中性 token")
  assert.match(settingsCss, /outline-offset:\s*2px/, "焦点环缺 offset")
  assert.doesNotMatch(settingsCss, /outline:\s*2px solid var\(--cw-blue\)/, "焦点环不许用品牌 / 浏览器蓝")
  assert.match(
    mobileCss,
    /\[data-pi-settings\]\[data-pi-settings-mobile\]\[data-pi-settings-style\]\[data-pi-theme\]\s+\.sm-select:focus-visible/,
    "手机 select 焦点环特异性不足",
  )
  const tokens = stripComments(read("ui/src/pi/settings/tokens.css"))
  assert.match(tokens, /--st-field-focus-ring:\s*color-mix\(in srgb, var\(--st-text-1\) 72%, var\(--st-menu-bg\)\)/, "缺中性焦点环 token")
})

/* ------------------------------------------------------------------ */
/* 3. 对比度（六皮肤 token 复算）                                       */
/* ------------------------------------------------------------------ */

test("A11Y-03 六皮肤次级文字：text-3 / text-4 对卡底与页面 ≥4.5，层级保持", () => {
  for (const style of STYLES) {
    for (const theme of THEMES) {
      const key = `${style}-${theme}`
      const p = paletteOf(key)
      for (const [name, color] of [
        ["text-3/card", p.text3],
        ["text-4/card", p.text4],
        ["text-4/page", over(parseColor(p.vars.get("--st-text-4"), p.vars), p.page)],
      ]) {
        const ratio = contrast(color, name.endsWith("/page") ? p.page : p.card)
        assert.ok(ratio >= 4.5, `${key} ${name} 仅 ${ratio.toFixed(2)}:1`)
      }
      // 层级：浅色越浅越弱、深色越暗越弱；text-4 仍是四档里最弱的一档。
      const weakens = (a, b) => (theme === "light" ? luminance(a) > luminance(b) : luminance(a) < luminance(b))
      assert.ok(weakens(p.text4, p.text3), `${key} text-4 应比 text-3 弱（保持层级）`)
      assert.ok(weakens(p.text3, p.text2), `${key} text-3 应比 text-2 弱（保持层级）`)
    }
  }
})

test("A11Y-03 徽标文字 ≥4.5（桥接 / 设计预留，含自身底色合成）", () => {
  for (const style of STYLES) {
    for (const theme of THEMES) {
      const key = `${style}-${theme}`
      const p = paletteOf(key)
      const bridge = contrast(p.badgeBridgeFg, p.badgeBridgeBg)
      assert.ok(bridge >= 4.5, `${key} 桥接徽标仅 ${bridge.toFixed(2)}:1`)
      const reserved = contrast(p.text3, p.tile)
      assert.ok(reserved >= 4.5, `${key} 设计预留徽标仅 ${reserved.toFixed(2)}:1`)
    }
  }
})

test("A11Y-04 六皮肤开关：关闭态轨道 / 白 thumb ≥3；深色开启态 thumb/轨道 ≥3", () => {
  for (const style of STYLES) {
    for (const theme of THEMES) {
      const key = `${style}-${theme}`
      const p = paletteOf(key)
      const offCard = contrast(p.switchOff, p.card)
      assert.ok(offCard >= 3, `${key} 关闭态轨道/卡底 ${offCard.toFixed(2)}:1`)
      const thumbOff = contrast({ r: 255, g: 255, b: 255, a: 1 }, p.switchOff)
      assert.ok(thumbOff >= 3, `${key} 关闭态 thumb/轨道 ${thumbOff.toFixed(2)}:1`)
      const onCard = contrast(p.switchOn, p.card)
      assert.ok(onCard >= 3, `${key} 开启态轨道/卡底 ${onCard.toFixed(2)}:1`)
      const thumbOn = contrast(p.switchKnobOn, p.switchOn)
      assert.ok(thumbOn >= 3, `${key} 开启态 thumb/轨道 ${thumbOn.toFixed(2)}:1`)
    }
  }
})

test("A11Y-04 手机开关开启态 thumb / 中性轨道 ≥3", () => {
  for (const style of STYLES) {
    for (const theme of THEMES) {
      const key = `${style}-${theme}`
      const p = paletteOf(key)
      const ratio = contrast(p.switchKnobOn, p.switchOn)
      assert.ok(ratio >= 3, `${key} 手机开启态 thumb/轨道 ${ratio.toFixed(2)}:1`)
    }
  }
  const mobileCss = stripComments(read("ui/src/pi/settings/mobile/mobile.css"))
  assert.match(mobileCss, /\.sm-switch\.is-on \.sm-switch-track \{[^}]*background: var\(--st-switch-on\)/, "手机开启态轨道未用中性开启色")
  assert.match(mobileCss, /\.sm-switch\.is-on \.sm-switch-thumb \{[^}]*background: var\(--st-switch-knob-on\)/, "手机开启态 thumb 未用开启态圆点色")
})

test("A11Y-04 六皮肤滑杆强调 / 卡底 ≥3；Claude 浅色单独加深", () => {
  for (const style of STYLES) {
    for (const theme of THEMES) {
      const key = `${style}-${theme}`
      const p = paletteOf(key)
      const ratio = contrast(p.sliderAccent, p.card)
      assert.ok(ratio >= 3, `${key} 滑杆强调/卡底 ${ratio.toFixed(2)}:1`)
    }
  }
  const claudeLight = paletteOf("claude-light")
  assert.ok(contrast(claudeLight.sliderAccent, claudeLight.card) >= 3.3, "Claude 浅色滑杆没有足够余量")
})

test("A11Y-02 焦点环 token 中性且对卡底 ≥3", () => {
  for (const style of STYLES) {
    for (const theme of THEMES) {
      const key = `${style}-${theme}`
      const p = paletteOf(key)
      const ratio = contrast(p.focusRing, p.card)
      assert.ok(ratio >= 3, `${key} 焦点环/卡底 ${ratio.toFixed(2)}:1`)
      const spread = Math.max(p.focusRing.r, p.focusRing.g, p.focusRing.b) - Math.min(p.focusRing.r, p.focusRing.g, p.focusRing.b)
      assert.ok(spread <= 16, `${key} 焦点环不够中性（通道差 ${spread.toFixed(0)}）`)
    }
  }
})

/* ------------------------------------------------------------------ */
/* 4. radiogroup 方向键                                                 */
/* ------------------------------------------------------------------ */

test("P3 radiogroup：←/→/↑/↓ 循环、跳过 disabled、无值从两端开始", () => {
  assert.equal(radio.radioArrowStep("ArrowRight"), 1)
  assert.equal(radio.radioArrowStep("ArrowDown"), 1)
  assert.equal(radio.radioArrowStep("ArrowLeft"), -1)
  assert.equal(radio.radioArrowStep("ArrowUp"), -1)
  assert.equal(radio.radioArrowStep("Space"), 0)
  assert.equal(radio.radioArrowStep("Enter"), 0)

  const options = [{}, {}, {}]
  assert.equal(radio.nextEnabledOptionIndex(options, 0, 1), 1)
  assert.equal(radio.nextEnabledOptionIndex(options, 2, 1), 0, "右移循环")
  assert.equal(radio.nextEnabledOptionIndex(options, 0, -1), 2, "左移循环")
  assert.equal(radio.nextEnabledOptionIndex(options, -1, 1), 0, "无选中时右移选第一项")
  assert.equal(radio.nextEnabledOptionIndex(options, -1, -1), 2, "无选中时左移选最后一项")
  assert.equal(radio.nextEnabledOptionIndex([{}, { disabled: true }, {}], 0, 1), 2, "跳过 disabled")
  assert.equal(radio.nextEnabledOptionIndex([{ disabled: true }, { disabled: true }], -1, 1), -1, "全 disabled")
  assert.equal(radio.nextEnabledOptionIndex([], -1, 1), -1)
})

test("P3 四个 radiogroup（整行 / 行内 / 分段 / 色点）都接方向键，Space 不拦", () => {
  const ui = stripComments(read("ui/src/pi/settings/ui.tsx"))
  assert.equal((ui.match(/handleRadioArrow\(event, options, value/g) ?? []).length, 4, "不是四个 radiogroup 都接了方向键")
  assert.match(ui, /if \(!step \|\| blocked\) return/, "方向键未跳过 inert / 禁用组")
  assert.match(ui, /buttons\[next\]\?\.focus\(\)/, "方向键未同步焦点")
  assert.match(ui, /if \(!options\[next\]\?\.disabled\) onChange\?\.\(options\[next\]\.value\)/, "方向键未同步选中")
  assert.doesNotMatch(ui, /event\.key === " "\) \{[\s\S]*?preventDefault/, "Space 不应被方向键处理拦截")
})

/* ------------------------------------------------------------------ */
/* 5. 源码回归：开关轨道必须压过壳按钮复位                                */
/* ------------------------------------------------------------------ */

test("A11Y-04 开关轨道用 .settings-root 作用域压过 .settings-root button 的 background:none", () => {
  assert.match(settingsCss, /\.settings-root \.settings-switch \{[\s\S]*?background:\s*var\(--st-switch-off\)/, "关闭态轨道仍会被壳复位清掉")
  assert.match(settingsCss, /\.settings-root \.settings-switch\.is-on \{[\s\S]*?background:\s*var\(--st-switch-on\)/, "开启态轨道仍会被壳复位清掉")
  assert.match(settingsCss, /linear-gradient\([\s\S]*?var\(--st-slider-accent\)/, "滑杆强调段未用加深后的 token")
  assert.match(settingsCss, /\.settings-badge--bridge \{[\s\S]*?color:\s*var\(--st-badge-bridge-fg\)/, "桥接徽标未用加深文字 token")
  assert.match(settingsCss, /\.settings-badge--reserved \{[\s\S]*?color:\s*var\(--st-text-3\)/, "设计预留徽标未用更深文字 token")
  assert.match(
    settingsCss,
    /\[data-pi-settings\]\[data-pi-settings-style="claude"\] \.settings-slider \{[\s\S]*?linear-gradient/,
    "Claude reset 打穿的滑杆轨道未补回",
  )
})
