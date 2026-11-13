// S2 第五轮 · 外观偏好真正全局生效：PiSettingsHost 把强调色 / 字号 / 密度 / 界面字体镜像到 <html data-pi-*>，
// pi-theme.css 第 5 节按属性改令牌（强调 → --sb-run / --st-accent；字号 → --cw-text-* 与侧栏行；密度 → 行高档位）。
// 做不到全局的（内容列宽、等宽字体、手机密度）从设置里去掉。另：JS 文件徽章的新令牌 --cw-file-icon-js。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const host = await import("../ui/src/pi/model/settingsHost.ts")
const settings = await import("../ui/src/pi/settings/model.ts")
const types = await import("../ui/src/pi/settings/types.ts")

const read = (p) => fs.readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const css = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "")

const THEME = css(read("src/components/pi/shared/pi-theme.css"))
const TOKENS = css(read("src/pi/styles/tokens.css"))
const ST_TOKENS = css(read("src/pi/settings/tokens.css"))
const SB_TOKENS = css(read("src/pi/sidebar/tokens.css"))
const SIDEBAR_CSS = css(read("src/pi/sidebar/sidebar.css"))

/** 选择器（逗号列表里的最后一项）后面那个块的声明 */
const blockOf = (src, selector) => {
  const at = src.indexOf(`${selector} {`)
  assert.ok(at >= 0, `找不到 ${selector}`)
  const open = src.indexOf("{", at + selector.length)
  return src.slice(open + 1, src.indexOf("}", open))
}
const varOf = (body, name) => {
  const m = new RegExp(`(?:^|[;\\s])${name}:\\s*([^;]+);`).exec(body)
  assert.ok(m, `找不到 ${name}`)
  return m[1].trim()
}
const px = (value) => {
  assert.match(value, /^\d+px$/)
  return Number.parseInt(value, 10)
}

/** 只数类一列（属性、伪类）：:where 不计，:is / :not 取参数里最高的一项 */
const specificity = (selector) => {
  let extra = 0
  const rest = selector
    .replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "")
    .replace(/:(?:is|not)\(((?:[^()]|\([^()]*\))*)\)/g, (_, args) => {
      extra += Math.max(...args.split(",").map((arg) => specificity(arg.trim())))
      return ""
    })
  const attrs = rest.match(/\[[^\]]*\]/g) ?? []
  const bare = rest.replace(/\[[^\]]*\]/g, "")
  return attrs.length + (bare.match(/:[a-z-]+/g) ?? []).length + (bare.match(/\.[a-z][\w-]*/gi) ?? []).length + extra
}

const rgbOf = (hex) => [0, 2, 4].map((i) => Number.parseInt(hex.replace("#", "").slice(i, i + 2), 16))
const channel = (c) => {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const luminance = (hex) => {
  const [r, g, b] = rgbOf(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const mix = (fg, pct, bg) =>
  `#${rgbOf(fg).map((v, i) => Math.round((v * pct + rgbOf(bg)[i] * (100 - pct)) / 100).toString(16).padStart(2, "0")).join("")}`

const accentSel = (accent, theme) => `:root[data-pi-accent="${accent}"][data-pi-theme="${theme}"] :is([data-pi-sidebar], [data-pi-settings])`
const nonDefault = (list, fallback) => list.filter((value) => value !== fallback)

test("appearanceAttrsOf：默认档（紫 / 标准 / 紧凑 / 系统）不写属性，其余原样写", () => {
  assert.deepEqual([...host.PI_APPEARANCE_ATTRS], ["data-pi-accent", "data-pi-font-size", "data-pi-density", "data-pi-ui-font"])
  const d = settings.DEFAULT_SETTINGS_PREFS
  assert.deepEqual(
    { accent: d.accent, fontSize: d.fontSize, density: d.density, uiFont: d.uiFont },
    { accent: "violet", fontSize: "standard", density: "compact", uiFont: "system" },
  )
  assert.deepEqual(Object.values(host.appearanceAttrsOf(d)), [null, null, null, null])
  assert.deepEqual(host.appearanceAttrsOf({ accent: "clay", fontSize: "large", density: "relaxed", uiFont: "geist" }), {
    "data-pi-accent": "clay",
    "data-pi-font-size": "large",
    "data-pi-density": "relaxed",
    "data-pi-ui-font": "geist",
  })
})

test("PiSettingsHost：同步镜像到 <html>（layout effect），默认档删属性、卸载全删；字体文件随宿主引入", () => {
  const src = code(read("src/pi/hooks/PiSettingsHost.tsx"))
  assert.match(src, /import "@fontsource-variable\/inter\/wght\.css"/)
  assert.match(src, /import "@fontsource-variable\/geist\/wght\.css"/)
  const at = src.indexOf("const { accent, fontSize, density, uiFont } = prefs")
  assert.ok(at >= 0)
  const effect = src.slice(at, src.indexOf("}, [accent, fontSize, density, uiFont])", at))
  assert.match(effect, /useLayoutEffect\(\(\) => \{\s*const el = document\.documentElement/)
  assert.match(effect, /const attrs = appearanceAttrsOf\(\{ accent, fontSize, density, uiFont \}\)/)
  assert.match(effect, /if \(value\) el\.setAttribute\(name, value\)\s*else el\.removeAttribute\(name\)/)
  assert.match(effect, /return \(\) => \{\s*for \(const name of PI_APPEARANCE_ATTRS\) el\.removeAttribute\(name\)/)
})

describe("pi-theme.css 第 5 节", () => {
  test("每个非默认档都有规则（缺一个就是「设置里能选、界面不变」）", () => {
    for (const accent of nonDefault(types.SETTINGS_ACCENTS, "violet")) {
      for (const theme of ["light", "dark"]) blockOf(THEME, accentSel(accent, theme))
    }
    for (const size of nonDefault(types.SETTINGS_FONT_SIZES, "standard")) {
      blockOf(THEME, `:root:root[data-pi-font-size="${size}"]:not([data-pi-layout="phone"])`)
      assert.ok(THEME.includes(`:root:root[data-pi-font-size="${size}"][data-pi-layout="phone"],`), size)
      blockOf(THEME, `:root[data-pi-font-size="${size}"] [data-pi-root][data-pi-layout="phone"]`)
    }
    for (const density of nonDefault(types.SETTINGS_DENSITIES, "compact")) {
      blockOf(THEME, `:root:root[data-pi-density="${density}"]:not([data-pi-layout="phone"])`)
    }
    for (const font of nonDefault(types.SETTINGS_UI_FONTS, "system")) {
      assert.ok(THEME.includes(`:root:root[data-pi-ui-font="${font}"],`), font)
      blockOf(THEME, `:root:root[data-pi-ui-font="${font}"] :is([data-pi-sidebar], [data-pi-settings])`)
    }
  })

  test("优先级压过要改的那一层：侧栏 / 设置页主题块、手机尺寸（第 3 节）", () => {
    const beats = (ours, theirs, where) => {
      assert.ok(where.includes(theirs), `找不到被压的选择器 ${theirs}`)
      assert.ok(specificity(ours) > specificity(theirs), `${ours} 要压过 ${theirs}`)
    }
    const accent = accentSel("blue", "light")
    beats(accent, '[data-pi-sidebar][data-pi-sidebar-style="cursor"][data-pi-theme="light"]', SB_TOKENS)
    beats(accent, '[data-pi-settings][data-pi-settings-style="cursor"][data-pi-theme="light"]', ST_TOKENS)
    beats(':root[data-pi-font-size="large"] [data-pi-root][data-pi-layout="phone"]', '[data-pi-root][data-pi-layout="phone"]', THEME)
    beats(':root:root[data-pi-font-size="large"][data-pi-layout="phone"]', ':root:root[data-pi-layout="phone"]', THEME)
    beats(':root:root[data-pi-ui-font="inter"] :is([data-pi-sidebar], [data-pi-settings])', '[data-pi-sidebar][data-pi-sidebar-style="cursor"][data-pi-theme="dark"]', SB_TOKENS)
    assert.equal(specificity(':where([data-pi-theme="light"]) [data-pi-settings][data-pi-settings-style="cursor"]'), 2, "自检：:where 不计")
  })

  test("强调色：文字（--st-accent）在设置页底 / 卡底 ≥ 4.5，状态环（--sb-run）在侧栏底 ≥ 3；浅色亮度不高于默认紫", () => {
    const cardPct = {
      light: Number(/--st-card-bg: color-mix\(in srgb, var\(--st-text-1\) (\d+)%, var\(--st-page-bg\)\)/.exec(blockOf(ST_TOKENS, "[data-pi-settings]"))[1]),
      dark: Number(/--st-card-bg: color-mix\(in srgb, var\(--st-text-1\) (\d+)%, var\(--st-page-bg\)\)/.exec(blockOf(ST_TOKENS, ':where([data-pi-theme="dark"]) [data-pi-settings][data-pi-settings-style="cursor"]'))[1]),
    }
    for (const theme of ["light", "dark"]) {
      const st = blockOf(ST_TOKENS, `:where([data-pi-theme="${theme}"]) [data-pi-settings][data-pi-settings-style="cursor"]`)
      const sb = blockOf(SB_TOKENS, `[data-pi-theme="${theme}"] [data-pi-sidebar][data-pi-sidebar-style="cursor"]`)
      const page = varOf(st, "--st-page-bg")
      const card = mix(varOf(st, "--st-text-1"), cardPct[theme], page)
      const sidebar = varOf(sb, "--sb-bg")
      const violet = varOf(sb, "--sb-run")
      const alphaOf = (value) => /,\s*([\d.]+)\)$/.exec(value)[1]
      for (const accent of nonDefault(types.SETTINGS_ACCENTS, "violet")) {
        const body = blockOf(THEME, accentSel(accent, theme))
        const color = varOf(body, "--st-accent")
        const label = `${accent}/${theme}`
        assert.match(color, /^#[0-9a-f]{6}$/i, label)
        assert.equal(varOf(body, "--sb-run"), color, `${label}：侧栏运行色与设置页强调同一个颜色`)
        assert.ok(contrast(color, page) >= 4.5, `${label} 页底 ${contrast(color, page).toFixed(2)}`)
        assert.ok(contrast(color, card) >= 4.5, `${label} 卡底 ${contrast(color, card).toFixed(2)}`)
        assert.ok(contrast(color, sidebar) >= 3, `${label} 侧栏底 ${contrast(color, sidebar).toFixed(2)}`)
        if (theme === "light") assert.ok(luminance(color) <= luminance(violet), `${label} 亮度不高于默认紫（淡底徽章不变差）`)
        const rgb = rgbOf(color).join(", ")
        for (const [name, base] of [["--sb-run-soft", "--sb-run-soft"], ["--sb-run-glow", "--sb-run-glow"], ["--st-accent-soft", "--sb-run-soft"]]) {
          assert.equal(varOf(body, name), `rgba(${rgb}, ${alphaOf(varOf(sb, base))})`, `${label} ${name} 与默认紫同透明度`)
        }
      }
    }
  })

  test("字号：小 / 大各挪一档（正文、代码、界面字号、侧栏行），桌面与手机各自的基准上挪", () => {
    const phone = blockOf(THEME, '[data-pi-root][data-pi-layout="phone"]')
    const desktopBase = { text: px(varOf(TOKENS, "--cw-text-base")), code: px(varOf(TOKENS, "--cw-text-code")), leading: px(varOf(TOKENS, "--cw-leading-base")) }
    const phoneBase = { text: px(varOf(phone, "--cw-text-base")), code: px(varOf(phone, "--cw-text-code")), leading: px(varOf(phone, "--cw-leading-base")) }
    for (const [size, sign] of [["small", -1], ["large", 1]]) {
      const desktop = blockOf(THEME, `:root:root[data-pi-font-size="${size}"]:not([data-pi-layout="phone"])`)
      const mobile = blockOf(THEME, `:root[data-pi-font-size="${size}"] [data-pi-root][data-pi-layout="phone"]`)
      for (const [body, base, label] of [[desktop, desktopBase, "桌面"], [mobile, phoneBase, "手机"]]) {
        assert.equal(px(varOf(body, "--cw-text-base")), base.text + sign, `${label} ${size} 正文`)
        assert.equal(px(varOf(body, "--cw-text-code")), base.code + sign, `${label} ${size} 代码`)
        assert.equal(Math.sign(px(varOf(body, "--cw-leading-base")) - base.leading), sign, `${label} ${size} 行高跟着走`)
      }
      assert.equal(px(varOf(desktop, "--sb-font-size")), 13 + sign, `侧栏 ${size}`)
    }
    const root = blockOf(SIDEBAR_CSS, ".sb-root")
    assert.match(root, /font-size: var\(--sb-font-size, 13px\);/)
    assert.match(root, /line-height: var\(--sb-line-height, 18px\);/)
  })

  test("密度：标准 / 宽松给桌面列表行、菜单行、浮层行各加 2 / 4px；紧凑（默认）= 令牌原值；手机不跟", () => {
    for (const [density, step] of [["standard", 2], ["relaxed", 4]]) {
      const body = blockOf(THEME, `:root:root[data-pi-density="${density}"]:not([data-pi-layout="phone"])`)
      assert.equal(px(varOf(body, "--cw-pi-density-step")), step)
      for (const name of ["--cw-row-h", "--cw-menu-row-h", "--cw-popover-row-h"]) {
        assert.equal(px(varOf(body, name)), px(varOf(TOKENS, name)) + step, `${density} ${name}`)
      }
    }
    assert.equal((SIDEBAR_CSS.match(/height: calc\(30px \+ var\(--cw-pi-density-step, 0px\)\);/g) ?? []).length, 3, "会话 / 工作区 / 普通行")
    assert.equal((SIDEBAR_CSS.match(/height: calc\(28px \+ var\(--cw-pi-density-step, 0px\)\);/g) ?? []).length, 2, "分组头 / 更多")
    const settingsCss = css(read("src/pi/settings/pages/appearance.css"))
    assert.doesNotMatch(settingsCss, /\[data-density/, "不再只改外观页自己")
    const row = ".settings-row:not(.settings-row--stack, .settings-row--note, .settings-row--subhead)"
    assert.match(blockOf(settingsCss, `:root[data-pi-density="standard"] [data-pi-settings] ${row}`), /min-height: 50px;\s*padding-block: 12px;/)
    assert.match(blockOf(settingsCss, `:root[data-pi-density="relaxed"] [data-pi-settings] ${row}`), /min-height: 54px;\s*padding-block: 14px;/)
  })

  test("界面字体：kit / 侧栏 / 设置页三套字体变量一起换，字体名与引入的字体文件一致", () => {
    for (const [font, family] of [["inter", "Inter Variable"], ["geist", "Geist Variable"]]) {
      const body = blockOf(THEME, `:root:root[data-pi-ui-font="${font}"] :is([data-pi-sidebar], [data-pi-settings])`)
      assert.ok(varOf(body, "--cw-font-sans").startsWith(`"${family}", `), font)
      assert.match(varOf(body, "--cw-font-sans"), /, sans-serif$/)
      assert.equal(varOf(body, "--sb-font-sans"), "var(--cw-font-sans)")
      assert.equal(varOf(body, "--st-font-sans"), "var(--cw-font-sans)")
      assert.ok(read(`node_modules/@fontsource-variable/${font}/wght.css`).includes(`font-family: '${family}'`), `${font} 字体文件的字体名`)
    }
  })
})

test("外观页：做不到全局的（内容列宽、等宽字体；手机的密度）不提供，文案说实话", () => {
  const page = code(read("src/pi/settings/pages/AppearancePage.tsx"))
  assert.doesNotMatch(page, /data-density=|pageStyle|SETTINGS_CONTENT_WIDTH|SETTINGS_MONO_FONTS|jetbrains-mono|contentWidth|monoFont/)
  assert.match(page, /切换立即应用到整个界面，只保存在这个浏览器里。/)
  for (const key of ["accent", "fontSize", "density", "uiFont"]) assert.match(page, new RegExp(`act\\.setPref\\("${key}", `), key)
  const mobile = code(read("src/pi/settings/mobile/pages/AppearancePage.tsx"))
  assert.doesNotMatch(mobile, /density|DENSIT/, "手机列表行是触控尺寸，不跟密度")
  assert.match(mobile, /<MobileGroup label="动态效果">/)
  assert.match(mobile, /对话里的正文与代码/, "手机的字号预览只说真的会变的部分")
})

test("--cw-file-icon-js：浅 / 深各一值、与 json 分开；在正文 / 卡 / pane 底上 ≥ 4.5", () => {
  const light = blockOf(css(read("src/pi/styles/tokens.local.css")), ":root")
  const dark = blockOf(THEME, '[data-pi-root][data-pi-theme="dark"]')
  const lightBase = blockOf(TOKENS, ":root")
  for (const [label, body, bgs] of [
    ["浅", light, ["--cw-bg", "--cw-surface", "--cw-surface-pane"].map((name) => varOf(lightBase, name))],
    ["深", dark, ["--cw-bg", "--cw-surface", "--cw-surface-pane", "--cw-code-chip-bg"].map((name) => varOf(dark, name))],
  ]) {
    const js = varOf(body, "--cw-file-icon-js")
    assert.match(js, /^#[0-9a-f]{6}$/i)
    assert.notEqual(js.toLowerCase(), varOf(body, "--cw-file-icon-json").toLowerCase(), `${label}：不再借用 json 色`)
    for (const bg of bgs) assert.ok(contrast(js, bg) >= 4.5, `${label} ${js} 在 ${bg} 上 ${contrast(js, bg).toFixed(2)}`)
  }
})
