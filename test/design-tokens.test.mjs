// 设计令牌（P7 B2d 整份重写，plan §8.3、决定 17）：旧界面的令牌层（style/design-tokens.css、design-theme.ts、index.css、shell.css）删了，
// 旧的 V1–R4 令牌清单、三主题 / 皮肤、旧首帧脚本行为的用例随之删掉（逐条见 R2/test-rewrite.md）。现在检查新界面的令牌：
// - ui/src/pi/styles/tokens.css 的 :root 正好 131 个 --cw-* 名字（官方 token 表；P10 移除 2 个 traffic-light 尺寸 token）；
// - pi-theme.css 深色块只重设浅色已定义的名字（tokens.css / tokens.local.css / pi-theme.css 浅色块），不凭空多出 token；
// - index.html 的首帧主题脚本（结构；规则逐条在 test/pi-p6-a.test.mjs）。
// 文件末尾 P2.6 的对比度块（pi contrast）原样保留。
import test, { describe } from "node:test"
import { readFileSync } from "node:fs"
import assert from "node:assert/strict"
const THEME_STORAGE_KEY = "pi-remote.theme"
const THEME_BRIDGE_ATTRIBUTE = "data-pi-theme"
const indexHtml = readFileSync(new URL("../ui/index.html", import.meta.url), "utf8")
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "")
const piTokensCss = stripComments(readFileSync(new URL("../ui/src/pi/styles/tokens.css", import.meta.url), "utf8"))
const piTokensLocalCss = stripComments(readFileSync(new URL("../ui/src/pi/styles/tokens.local.css", import.meta.url), "utf8"))
const piThemeCss = stripComments(readFileSync(new URL("../ui/src/components/pi/shared/pi-theme.css", import.meta.url), "utf8"))
// 对比度块（文件末尾）用的两个小工具，照原文件

function blockAfter(source, marker) {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `缺少选择器 / 指令：${marker}`)
  const open = source.indexOf("{", at)
  assert.notEqual(open, -1, `${marker} 后没有 {`)
  let depth = 0
  for (let k = open; k < source.length; k += 1) {
    const char = source[k]
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, k)
    }
  }
  throw new Error(`块未闭合：${marker}`)
}

function declarations(source) {
  const out = new Map()
  const re = /(--[a-z0-9-]+)\s*:\s*([^;{}]+);/g
  let match
  while ((match = re.exec(source))) out.set(match[1], match[2].trim())
  return out
}
/** 选择器开头为 selector 的第一个块里声明的自定义属性名 */
function namesIn(css, selector) {
  const at = css.indexOf(selector)
  assert.ok(at >= 0, `找不到 ${selector}`)
  const open = css.indexOf("{", at)
  const close = css.indexOf("}", open)
  return [...css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
}
test("新令牌：pi/styles/tokens.css 的 :root 正好 131 个 --cw-* 名字，不重复", () => {
  const names = namesIn(piTokensCss, ":root")
  assert.equal(names.length, 131)
  assert.equal(new Set(names).size, 131)
  assert.deepEqual(names.filter((n) => !n.startsWith("--cw-")), [])
})
test("新令牌：pi-theme.css 深色块只重设浅色已定义的名字（同一套 token，浅 / 深各一份值）", () => {
  const lightNames = new Set([...namesIn(piTokensCss, ":root"), ...namesIn(piTokensLocalCss, ":root"), ...namesIn(piThemeCss, ":root:root[data-pi-theme],")])
  const dark = namesIn(piThemeCss, ':root:root[data-pi-theme="dark"],')
  assert.ok(dark.length > 0)
  assert.deepEqual(dark.filter((n) => !lightNames.has(n)), [], "深色块里出现了浅色没定义的 token")
  assert.equal(new Set(dark).size, dark.length, "深色块里同名重复")
})
// P7 B1：index.html 换成新界面的首帧脚本（原 next.html，P6.4）。规则逐条和 pi/model/prefs.ts 比的 vm 用例在 test/pi-p6-a.test.mjs；
// 这里只钉结构：脚本在 head 里、先于模块入口，读新键 pi_remote_pi_prefs 和旧键 pi-remote.theme（只读迁移），只写 data-pi-theme。
// 旧脚本的"写 data-theme、旧皮肤 ThemeId 还原"随旧界面下线（决定 1：只剩 data-pi-theme 一套）。
test("首帧主题：index.html 内联脚本先于模块脚本，读取固定 localStorage 键", () => {
  assert.match(indexHtml, /<html lang="zh-CN">/)
  assert.ok(indexHtml.includes('"pi_remote_pi_prefs"'), "首帧脚本读新界面偏好键")
  assert.ok(indexHtml.includes(`"${THEME_STORAGE_KEY}"`), "旧主题键 pi-remote.theme 只作迁移来源")
  assert.match(indexHtml, /prefers-color-scheme:\s*dark/)
  assert.ok(indexHtml.includes(`setAttribute("${THEME_BRIDGE_ATTRIBUTE}"`), "首帧脚本写 data-pi-theme")
  assert.doesNotMatch(indexHtml, /setAttribute\("data-theme"/, "不再写旧的 data-theme")
  assert.match(indexHtml, /<meta name="color-scheme" content="light dark" \/>/)
  const scriptAt = indexHtml.indexOf("pi_remote_pi_prefs")
  const headEnd = indexHtml.indexOf("</head>")
  const moduleAt = indexHtml.indexOf('type="module"')
  assert.ok(scriptAt > 0 && scriptAt < headEnd, "主题脚本必须在 head 内、样式/React 之前")
  assert.ok(moduleAt > headEnd, "模块入口仍在 body 末尾")
  assert.match(indexHtml, /<script type="module" src="\/src\/pi\/main\.tsx"><\/script>/, "入口是新界面")
})
// ---------------------------------------------------------------------------
// pi contrast（PLAN 2.6；design §4.6 对比度表，v1.2 D-03 / v1.3 R2-D-03）。P7.3 整份重写本文件时保留这个块（plan §8.3）。
// 读新界面的两份令牌：ui/src/pi/styles/tokens.css（浅色 :root）和 ui/src/components/pi/shared/pi-theme.css
// （Pi 变量与浅色压深在 `:root:root[data-pi-theme], [data-pi-root]`，深色重设在 `[data-pi-theme="dark"]`）。
// 三层落在同一个元素（PiRoot 根节点）上，所以按层叠顺序合并后再求 var()，和浏览器的计算结果一致。
// tokens.local.css 不定义表里的颜色，不读。出错标记"!"的字色写在 PiSidebar.tsx 的类名里，从那里读。
// 结论照 §4.6：需要读的文字 ≥ 4.5；焦点环、出错标记"!"这类非文字 ≥ 3；表里标"不用"的组合断言确实低于门槛，
// 防止以后误用时以为达标。每一对同时核对表里写的对比度（两位小数）。
const PI_TEXT_MIN = 4.5
const PI_NON_TEXT_MIN = 3
const PI_RATIO_TOLERANCE = 0.01
const PI_LIGHT_SELECTOR = ":root:root[data-pi-theme],"
const PI_DARK_SELECTOR = ':root:root[data-pi-theme="dark"],'
const PI_LIGHTBOX_ON_PAGE = ["--cw-pi-lightbox-bg", "--cw-bg"]

let piThemeCache
function piTheme() {
  if (piThemeCache) return piThemeCache
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "")
  const tokens = strip(readFileSync(new URL("../ui/src/pi/styles/tokens.css", import.meta.url), "utf8"))
  const theme = strip(readFileSync(new URL("../ui/src/components/pi/shared/pi-theme.css", import.meta.url), "utf8"))
  const root = declarations(blockAfter(tokens, ":root {"))
  const lightBlock = declarations(blockAfter(theme, PI_LIGHT_SELECTOR))
  const darkBlock = declarations(blockAfter(theme, PI_DARK_SELECTOR))
  piThemeCache = {
    lightBlock,
    darkBlock,
    vars: {
      light: new Map([...root, ...lightBlock]),
      dark: new Map([...root, ...lightBlock, ...darkBlock]),
    },
  }
  return piThemeCache
}

function piParseColor(value) {
  const text = value.trim()
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join("") : hex[1]
    const channel = (k) => Number.parseInt(digits.slice(k, k + 2), 16)
    return { r: channel(0), g: channel(2), b: channel(4), a: 1 }
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: rgb[4] === undefined ? 1 : Number(rgb[4]) }
  throw new Error(`不认识的颜色：${value}`)
}

// ref：令牌名按 theme 求值；"light:--x" 固定按浅色求（灯箱上的对照行）；"#…"、"rgba(…)" 是字面色。
// 值里有 var(--x) 时顺着引用往下找（复合值如 `2px solid var(--cw-blue)` 取其中的颜色引用）。
function piColor(theme, ref, trail = []) {
  if (ref.startsWith("light:")) return piColor("light", ref.slice("light:".length), trail)
  if (!ref.startsWith("--")) return piParseColor(ref)
  const vars = piTheme().vars[theme]
  assert.ok(vars.has(ref), `${theme} 下缺少令牌 ${ref}`)
  const value = vars.get(ref)
  const inner = value.match(/var\(\s*(--[a-z0-9-]+)/)
  if (!inner) return piParseColor(value)
  assert.ok(!trail.includes(inner[1]), `循环引用：${[...trail, ref, inner[1]].join(" → ")}`)
  return piColor(theme, inner[1], [...trail, ref])
}

// 底色：令牌 / 字面色，或 [上层, 下层]：半透明的上层按 alpha 合成到不透明的下层上，按 8 位取整
// （§4.6："rgba(0,0,0,.85) 合成到 #F7F7F7 上 = #252525"）。
function piBackdrop(theme, bg) {
  if (Array.isArray(bg)) {
    const [top, bottom] = [piColor(theme, bg[0]), piBackdrop(theme, bg[1])]
    const mix = (upper, lower) => Math.round(upper * top.a + lower * (1 - top.a))
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 }
  }
  const color = piColor(theme, bg)
  assert.equal(color.a, 1, `${theme} 下 ${bg} 是半透明色，要写成 [上层, 底色]`)
  return color
}

function piLuminance({ r, g, b }) {
  const linear = (value) => {
    const s = value / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

function piContrast(fg, bg) {
  const [high, low] = [piLuminance(fg), piLuminance(bg)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

function piHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

// PiRowMarker 的出错标记：红色实心圆 + 居中"!"（design §4.7）。底色令牌和两种主题的字色都从类名里读。
function piErrorMarker() {
  const source = readFileSync(new URL("../ui/src/components/pi/shared/PiSidebar.tsx", import.meta.url), "utf8")
  const className = source.match(/className="([^"]*\bbg-\(--cw-pi-error\)[^"]*)"/)?.[1]
  assert.ok(className, "PiSidebar.tsx 里找不到出错标记的类名（bg-(--cw-pi-error)）")
  const classes = className.split(/\s+/)
  const dark = classes.map((name) => name.match(/^in-data-\[pi-theme=dark\]:text-\[(#[0-9a-f]{6})\]$/i)?.[1]).find(Boolean)
  assert.ok(classes.includes("text-white"), `出错标记浅色字色不是 text-white：${className}`)
  assert.ok(dark, `出错标记缺少深色字色 in-data-[pi-theme=dark]:text-[#…]：${className}`)
  return { bg: "--cw-pi-error", light: "#ffffff", dark }
}

// §4.6 对比度表，一项对应表里一行。verdict：use = 要达到 min 才能用；avoid = 表里标"不用"，断言确实低于 min。
// pairs：[文字 / 标记色, 底色, 表里写的对比度]。
const PI_CONTRAST_TABLE = [
  {
    row: "secondary #6A6B6D 在 bg / 侧栏 / 卡上",
    theme: "light",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-text-secondary", "--cw-bg", 4.98],
      ["--cw-pi-text-secondary", "--cw-sidebar-bg", 4.6],
      ["--cw-pi-text-secondary", "--cw-surface", 5.24],
    ],
  },
  {
    row: "secondary #6A6B6D 在 chip / 选中行上（不用，换 text-2）",
    theme: "light",
    verdict: "avoid",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-text-secondary", "--cw-chip-bg", 4.27],
      ["--cw-pi-text-secondary", "--cw-row-selected", 4.12],
    ],
  },
  {
    row: "text-2 #57585A 在 chip / 选中行 / 面板选中 / 面板上",
    theme: "light",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-text-2", "--cw-chip-bg", 5.71],
      ["--cw-text-2", "--cw-row-selected", 5.5],
      ["--cw-text-2", "--cw-palette-row-selected", 5.09],
      ["--cw-text-2", "--cw-palette-bg", 5.97],
    ],
  },
  {
    row: "深色 secondary #8E8E93 在 bg / 侧栏 / 卡 / 状态行上",
    theme: "dark",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-text-secondary", "--cw-bg", 5.55],
      ["--cw-pi-text-secondary", "--cw-sidebar-bg", 5.22],
      ["--cw-pi-text-secondary", "--cw-surface", 4.87],
      ["--cw-pi-text-secondary", "--cw-pi-status-line-bg", 4.81],
    ],
  },
  {
    row: "深色 secondary #8E8E93 在选中行 / chip 上（不用，换 text-2）",
    theme: "dark",
    verdict: "avoid",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-text-secondary", "--cw-row-selected", 4.15],
      ["--cw-pi-text-secondary", "--cw-chip-bg", 4.27],
    ],
  },
  {
    row: "深色 text-2 #B4B4B8 在选中行 / chip / 面板选中上",
    theme: "dark",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-text-2", "--cw-row-selected", 6.55],
      ["--cw-text-2", "--cw-chip-bg", 6.74],
      ["--cw-text-2", "--cw-palette-row-selected", 6.09],
    ],
  },
  {
    row: "费用警告不用 --cw-orange #B88A2E 作文字",
    theme: "light",
    verdict: "avoid",
    min: PI_TEXT_MIN,
    pairs: [["--cw-orange", "--cw-surface", 3.08]],
  },
  {
    row: "费用警告 --cw-pi-warning #8A6516 在卡 / 白 / bg 上",
    theme: "light",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-warning", "--cw-surface", 5.22],
      ["--cw-pi-warning", "#ffffff", 5.31],
      ["--cw-pi-warning", "--cw-bg", 4.96],
    ],
  },
  {
    row: "深色费用警告 #D9AE57 在卡 / pane 上",
    theme: "dark",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-warning", "--cw-surface", 7.67],
      ["--cw-pi-warning", "--cw-surface-pane", 8.04],
    ],
  },
  {
    row: "思考正文 / 阶段小标题在 bg 上",
    theme: "light",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-thinking-body", "--cw-bg", 4.98],
      ["--cw-thinking-phase", "--cw-bg", 6.65],
    ],
  },
  {
    row: "深色思考正文 / 阶段小标题在 bg 上",
    theme: "dark",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-thinking-body", "--cw-bg", 5.55],
      ["--cw-thinking-phase", "--cw-bg", 8.75],
    ],
  },
  {
    row: "默认占位 --cw-text-4 #A8A8A8 不承载信息（只给\"继续追问…\"）",
    theme: "light",
    verdict: "avoid",
    min: PI_TEXT_MIN,
    pairs: [["--cw-text-4", "--cw-surface", 2.34]],
  },
  {
    row: "焦点环 --cw-pi-focus-ring（--cw-blue #047ABD）在 bg / 侧栏 / 选中行上（非文字）",
    theme: "light",
    verdict: "use",
    min: PI_NON_TEXT_MIN,
    pairs: [
      ["--cw-pi-focus-ring", "--cw-bg", 4.33],
      ["--cw-pi-focus-ring", "--cw-sidebar-bg", 4.0],
      ["--cw-pi-focus-ring", "--cw-row-selected", 3.58],
    ],
  },
  {
    row: "深色焦点环 #3A9BD9 在 bg / 选中行上（非文字）",
    theme: "dark",
    verdict: "use",
    min: PI_NON_TEXT_MIN,
    pairs: [
      ["--cw-pi-focus-ring", "--cw-bg", 5.92],
      ["--cw-pi-focus-ring", "--cw-row-selected", 4.43],
    ],
  },
  {
    row: "灯箱文字 --cw-pi-lightbox-fg #B4B4B8 / #FFFFFF，灯箱底合成到浅色页上",
    theme: "light",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-lightbox-fg", PI_LIGHTBOX_ON_PAGE, 7.42],
      ["#ffffff", PI_LIGHTBOX_ON_PAGE, 15.33],
    ],
  },
  {
    row: "灯箱文字 --cw-pi-lightbox-fg #B4B4B8 / #FFFFFF，灯箱底合成到深色页上",
    theme: "dark",
    verdict: "use",
    min: PI_TEXT_MIN,
    pairs: [
      ["--cw-pi-lightbox-fg", PI_LIGHTBOX_ON_PAGE, 9.98],
      ["#ffffff", PI_LIGHTBOX_ON_PAGE, 20.62],
    ],
  },
  {
    // 对照行：灯箱上不跟主题，所以两种页面都拿浅色的 #6A6B6D 来比
    row: "secondary #6A6B6D 在灯箱底上（不用：灯箱一律用固定色）",
    theme: "light",
    verdict: "avoid",
    min: PI_TEXT_MIN,
    pairs: [["--cw-pi-text-secondary", PI_LIGHTBOX_ON_PAGE, 2.87]],
  },
  {
    row: "secondary #6A6B6D 在灯箱底上，深色页（不用）",
    theme: "dark",
    verdict: "avoid",
    min: PI_TEXT_MIN,
    pairs: [["light:--cw-pi-text-secondary", PI_LIGHTBOX_ON_PAGE, 3.87]],
  },
  {
    row: "出错标记\"!\"：浅色白字在 #9C4558 上（非文字）",
    theme: "light",
    verdict: "use",
    min: PI_NON_TEXT_MIN,
    pairs: [["marker:light", "marker:bg", 6.17]],
  },
  {
    row: "出错标记\"!\"：深色 #161617 在 #E0899B 上（非文字）",
    theme: "dark",
    verdict: "use",
    min: PI_NON_TEXT_MIN,
    pairs: [["marker:dark", "marker:bg", 7.08]],
  },
  {
    row: "出错标记\"!\"：深色下不能用白字（只有 2.55）",
    theme: "dark",
    verdict: "avoid",
    min: PI_NON_TEXT_MIN,
    pairs: [["#ffffff", "marker:bg", 2.55]],
  },
]

describe("pi contrast", () => {
  const resolveMarker = (ref) => {
    if (!ref.startsWith("marker:")) return ref
    return piErrorMarker()[ref.slice("marker:".length)]
  }

  for (const { row, theme, verdict, min, pairs } of PI_CONTRAST_TABLE) {
    test(`${theme === "dark" ? "深色" : "浅色"} · ${row}：${verdict === "use" ? "≥" : "<"} ${min}`, () => {
      for (const [fgRef, bgRef, expected] of pairs) {
        const fg = piColor(theme, resolveMarker(fgRef))
        assert.equal(fg.a, 1, `${fgRef} 是半透明色`)
        const bg = piBackdrop(theme, Array.isArray(bgRef) ? bgRef : resolveMarker(bgRef))
        const ratio = piContrast(fg, bg)
        const label = `${fgRef} ${piHex(fg)} / ${Array.isArray(bgRef) ? bgRef.join(" 合成到 ") : bgRef} ${piHex(bg)} = ${ratio.toFixed(3)}`
        if (verdict === "use") assert.ok(ratio >= min, `${label}，低于 ${min}`)
        else assert.ok(ratio < min, `${label}，表里标"不用"，却达到了 ${min}`)
        assert.ok(Math.abs(ratio - expected) <= PI_RATIO_TOLERANCE, `${label}，§4.6 表写的是 ${expected}`)
      }
    })
  }

  test("取值和 §4.6 一致：secondary、费用警告、思考只引用现有令牌、焦点环读 --cw-blue", () => {
    const hex = (theme, ref) => piHex(piColor(theme, ref))
    assert.equal(hex("light", "--cw-pi-text-secondary"), "#6a6b6d")
    assert.equal(hex("dark", "--cw-pi-text-secondary"), "#8e8e93")
    assert.equal(hex("light", "--cw-pi-warning"), "#8a6516")
    assert.equal(hex("dark", "--cw-pi-warning"), "#d9ae57")
    assert.equal(hex("light", "--cw-blue"), "#047abd")
    assert.equal(hex("dark", "--cw-blue"), "#3a9bd9")
    const { lightBlock, darkBlock } = piTheme()
    assert.equal(lightBlock.get("--cw-pi-focus-ring"), "2px solid var(--cw-blue)")
    // 思考块：正文 = secondary、阶段 = text-2，浅色、深色都只引用现有令牌，不写死颜色（撤回 fix-a 的 #707070 / #8A8A8F）
    for (const block of [lightBlock, darkBlock]) {
      assert.equal(block.get("--cw-thinking-body"), "var(--cw-pi-text-secondary)")
      assert.equal(block.get("--cw-thinking-phase"), "var(--cw-text-2)")
    }
  })

  test("灯箱不跟主题：--cw-pi-lightbox-bg / -fg 只在浅色块定义，深色块不重设", () => {
    const { lightBlock, darkBlock } = piTheme()
    assert.equal(lightBlock.get("--cw-pi-lightbox-bg"), "rgba(0, 0, 0, 0.85)")
    assert.equal(lightBlock.get("--cw-pi-lightbox-fg")?.toLowerCase(), "#b4b4b8")
    assert.equal(darkBlock.has("--cw-pi-lightbox-bg"), false, "深色块不得重设 --cw-pi-lightbox-bg")
    assert.equal(darkBlock.has("--cw-pi-lightbox-fg"), false, "深色块不得重设 --cw-pi-lightbox-fg")
    // 合成底和 §4.6 写的一致：浅色页 #252525、深色页 #030303
    assert.equal(piHex(piBackdrop("light", PI_LIGHTBOX_ON_PAGE)), "#252525")
    assert.equal(piHex(piBackdrop("dark", PI_LIGHTBOX_ON_PAGE)), "#030303")
  })
})
