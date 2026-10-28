// P4 预制件（lane-p4pre）：快捷键匹配与 Esc 分层（PLAN 4.2）、代码高亮分流与 shiki 记号（PLAN 4.4）、
// reduced-motion 的纯逻辑（PLAN 4.5）。纯 Node 测试：直接加载 ui/src/pi 下的 .ts 源文件；
// shiki 在 Node 里能跑，python / bash / go 用真实的 shiki 出记号。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  PI_SHORTCUT_KEYS,
  escTargetOf,
  piPlatformOf,
  piShortcutAllowed,
  piShortcutOf,
} from "../ui/src/pi/model/shortcuts.ts"
import { focusKindOf, isEditableTarget } from "../ui/src/pi/hooks/usePiShortcuts.ts"
import {
  PI_SYNTAX_FOREGROUND,
  PI_SYNTAX_THEME,
  highlightLangOfPath,
  highlightRouteOf,
  highlightToLines,
  toHighlightLines,
} from "../ui/src/pi/model/highlight.ts"
import {
  HIGHLIGHT_CACHE_MAX_CHARS,
  HIGHLIGHT_CACHE_MAX_ENTRIES,
  HIGHLIGHT_CACHE_MAX_ENTRY_CHARS,
  cachedHighlight,
  clearHighlightCache,
  highlightCacheStats,
  highlightLinesFor,
} from "../ui/src/components/pi/conversation/highlightCache.ts"
import {
  PAGE_TRANSITION_MS,
  REDUCED_MOTION_QUERY,
  motionOf,
  readReducedMotion,
  subscribeReducedMotion,
} from "../ui/src/pi/hooks/useReducedMotion.ts"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")

/** 造一个键事件；默认什么修饰键都不按 */
function key(k, mods = {}) {
  return { key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods }
}
const mac = (k, mods = {}) => piShortcutOf(key(k, { metaKey: true, ...mods }), "mac")
const win = (k, mods = {}) => piShortcutOf(key(k, { ctrlKey: true, ...mods }), "other")

// ---------- 4.2 快捷键 ----------

test("shortcuts: mac 上五个 ⌘ 组合各对一个动作", () => {
  assert.equal(mac("O", { shiftKey: true }), "new-session")
  assert.equal(mac("o", { shiftKey: true }), "new-session")
  assert.equal(mac("k"), "command-palette")
  assert.equal(mac("b"), "toggle-sidebar")
  assert.equal(mac("."), "toggle-pane")
  assert.equal(mac(","), "settings")
})

test("shortcuts: Windows / Linux 用 Ctrl，⌘（Win 键）不算", () => {
  assert.equal(win("O", { shiftKey: true }), "new-session")
  assert.equal(win("k"), "command-palette")
  assert.equal(win("b"), "toggle-sidebar")
  assert.equal(win("."), "toggle-pane")
  assert.equal(win(","), "settings")
  assert.equal(piShortcutOf(key("k", { metaKey: true }), "other"), null)
})

test("shortcuts: mac 上 Ctrl 不能代替 ⌘；⌘ + Ctrl 同按也不算", () => {
  assert.equal(piShortcutOf(key("k", { ctrlKey: true }), "mac"), null)
  assert.equal(mac("k", { ctrlKey: true }), null)
  assert.equal(win("k", { metaKey: true }), null)
})

test("shortcuts: ⌘K 只有命令面板一个含义（D-01），⇧⌘K 不触发", () => {
  assert.equal(mac("k"), "command-palette")
  assert.equal(mac("K", { shiftKey: true }), null)
  assert.equal(PI_SHORTCUT_KEYS["command-palette"].mac, "⌘K")
  const actions = Object.keys(PI_SHORTCUT_KEYS)
  assert.equal(actions.filter((a) => PI_SHORTCUT_KEYS[a].mac === "⌘K").length, 1)
  assert.ok(!actions.some((a) => /search/.test(a)), "没有搜索快捷键")
})

test("shortcuts: ⇧ 只属于 ⇧⌘O；不带 ⇧ 的 ⌘O 不是新建会话（⌘O 留给浏览器）", () => {
  assert.equal(mac("o"), null)
  assert.equal(mac("B", { shiftKey: true }), null)
  assert.equal(mac(">", { shiftKey: true, code: "Period" }), null)
  assert.equal(mac("<", { shiftKey: true, code: "Comma" }), null)
})

test("shortcuts: 按着 Alt 一律不算", () => {
  for (const k of ["k", "b", ".", ","]) assert.equal(mac(k, { altKey: true }), null)
  assert.equal(mac("O", { shiftKey: true, altKey: true }), null)
  assert.equal(piShortcutOf(key("Escape", { altKey: true }), "mac"), null)
})

test("shortcuts: key 被布局改写时按 code 兜底", () => {
  assert.equal(mac("л", { code: "KeyK" }), "command-palette")
  assert.equal(mac("и", { code: "KeyB" }), "toggle-sidebar")
  assert.equal(mac("ю", { code: "Period" }), "toggle-pane")
  assert.equal(mac("б", { code: "Comma" }), "settings")
  assert.equal(mac("Щ", { shiftKey: true, code: "KeyO" }), "new-session")
})

test("shortcuts: 不带修饰键的字母、/、? 都不是快捷键（本界面没有单键）", () => {
  for (const k of ["k", "b", "o", "O", "/", "?", ".", ","]) {
    assert.equal(piShortcutOf(key(k), "mac"), null)
    assert.equal(piShortcutOf(key(k, { shiftKey: true }), "other"), null)
  }
})

test("shortcuts: 输入法组字（isComposing / keyCode 229）与长按重复都不触发，Esc 也不触发", () => {
  assert.equal(mac("k", { isComposing: true }), null)
  assert.equal(mac("k", { keyCode: 229 }), null)
  assert.equal(mac("k", { repeat: true }), null)
  assert.equal(piShortcutOf(key("Escape", { isComposing: true }), "mac"), null)
  assert.equal(piShortcutOf(key("Escape", { repeat: true }), "mac"), null)
})

test("shortcuts: 焦点在输入框里时五个 ⌘ 组合与 Esc 照样识别", () => {
  assert.equal(mac("k", { editable: true }), "command-palette")
  assert.equal(mac("O", { shiftKey: true, editable: true }), "new-session")
  assert.equal(win(",", { editable: true }), "settings")
  assert.equal(piShortcutOf(key("Escape", { editable: true }), "mac"), "escape")
})

test("shortcuts: 只有裸 Esc 进入分层；带修饰键的 Esc 不算", () => {
  assert.equal(piShortcutOf(key("Escape"), "mac"), "escape")
  assert.equal(piShortcutOf(key("Escape"), "other"), "escape")
  assert.equal(piShortcutOf(key("Escape", { metaKey: true }), "mac"), null)
  assert.equal(piShortcutOf(key("Escape", { shiftKey: true }), "other"), null)
})

test("shortcuts: 有菜单或浮层开着时 ⌘ 组合不触发，Esc 照样走分层", () => {
  const none = { menuOpen: false, overlayOpen: false }
  for (const a of ["new-session", "command-palette", "toggle-sidebar", "toggle-pane", "settings"]) {
    assert.equal(piShortcutAllowed(a, none), true)
    assert.equal(piShortcutAllowed(a, { menuOpen: true, overlayOpen: false }), false)
    assert.equal(piShortcutAllowed(a, { menuOpen: false, overlayOpen: true }), false)
  }
  assert.equal(piShortcutAllowed("escape", { menuOpen: true, overlayOpen: true }), true)
})

test("shortcuts: Esc 分层 = 菜单 → 浮层 → 停止生成（K06）→ 不处理", () => {
  const base = { menuOpen: false, overlayOpen: false, canStop: false, focus: "other" }
  assert.equal(escTargetOf({ ...base, menuOpen: true, overlayOpen: true, canStop: true }), "menu")
  assert.equal(escTargetOf({ ...base, overlayOpen: true, canStop: true }), "overlay")
  assert.equal(escTargetOf({ ...base, canStop: true }), "stop")
  assert.equal(escTargetOf({ ...base, canStop: true, focus: "composer" }), "stop")
  assert.equal(escTargetOf(base), "none")
  assert.equal(escTargetOf({ ...base, focus: "composer" }), "none")
})

test("shortcuts: 焦点在其他输入框（改名、搜索）时 Esc 不停止生成，但仍先关菜单 / 浮层", () => {
  const base = { menuOpen: false, overlayOpen: false, canStop: true, focus: "editable" }
  assert.equal(escTargetOf(base), "none")
  assert.equal(escTargetOf({ ...base, menuOpen: true }), "menu")
  assert.equal(escTargetOf({ ...base, overlayOpen: true }), "overlay")
})

test("shortcuts: 连按 Esc 时一次只退一层", () => {
  const state = { menuOpen: true, overlayOpen: true, canStop: true, focus: "composer" }
  const seen = []
  for (;;) {
    const t = escTargetOf(state)
    seen.push(t)
    if (t === "menu") state.menuOpen = false
    else if (t === "overlay") state.overlayOpen = false
    else if (t === "stop") state.canStop = false
    else break
  }
  assert.deepEqual(seen, ["menu", "overlay", "stop", "none"])
})

test("shortcuts: 平台判断与展示文案", () => {
  assert.equal(piPlatformOf({ platform: "MacIntel" }), "mac")
  assert.equal(piPlatformOf({ userAgentData: { platform: "macOS" } }), "mac")
  assert.equal(piPlatformOf({ platform: "iPad" }), "mac")
  assert.equal(piPlatformOf({ platform: "Win32" }), "other")
  assert.equal(piPlatformOf({ platform: "Linux x86_64" }), "other")
  assert.equal(piPlatformOf(null), "other")
  assert.deepEqual(PI_SHORTCUT_KEYS["new-session"], { mac: "⇧⌘O", other: "Ctrl+Shift+O" })
  assert.equal(PI_SHORTCUT_KEYS["toggle-pane"].mac, "⌘.")
  assert.equal(PI_SHORTCUT_KEYS.settings.mac, "⌘,")
})

test("shortcuts: 焦点分类（hook 用）", () => {
  const el = (tagName, extra = {}) => ({ tagName, closest: () => null, ...extra })
  assert.equal(isEditableTarget(el("INPUT")), true)
  assert.equal(isEditableTarget(el("textarea")), true)
  assert.equal(isEditableTarget(el("SELECT")), true)
  assert.equal(isEditableTarget(el("DIV", { isContentEditable: true })), true)
  assert.equal(isEditableTarget(el("SPAN", { closest: (s) => (s.includes("contenteditable") ? {} : null) })), true)
  assert.equal(isEditableTarget(el("BUTTON")), false)
  assert.equal(isEditableTarget(null), false)
  assert.equal(isEditableTarget({}), false)

  const composerBox = el("TEXTAREA", { closest: (s) => (s.includes("pi-follow-up-composer") ? {} : null) })
  const emptyBox = el("TEXTAREA", { closest: (s) => (s.includes("pi-empty-composer") ? {} : null) })
  assert.equal(focusKindOf(composerBox), "composer")
  assert.equal(focusKindOf(emptyBox), "composer")
  assert.equal(focusKindOf(el("INPUT")), "editable")
  assert.equal(focusKindOf(el("BUTTON")), "other")
  assert.equal(focusKindOf(el("INPUT"), () => true), "composer")
})

test("shortcuts: usePiShortcuts 在冒泡阶段监听、跳过 defaultPrevented、不改旧 useShortcuts", () => {
  const src = read("../ui/src/pi/hooks/usePiShortcuts.ts")
  assert.match(src, /addEventListener\("keydown", onKeyDown\)/)
  assert.doesNotMatch(src, /addEventListener\("keydown", onKeyDown, true\)/)
  assert.match(src, /if \(event\.defaultPrevented\) return/)
  assert.match(src, /from "\.\.\/model\/shortcuts\.ts"/)
  assert.doesNotMatch(src, /components\/pi\//, "hook 不依赖具体组件")
})

// ---------- 4.4 代码高亮 ----------

test("highlight: kit 支持的 6 种语言（含别名）走 kit tokenizer", () => {
  const cases = {
    ts: "ts", typescript: "ts", mts: "ts", TSX: "tsx", js: "js", javascript: "js", mjs: "js", cjs: "js",
    jsx: "jsx", json: "json", html: "html", " HTML ": "html",
  }
  for (const [input, lang] of Object.entries(cases)) {
    assert.deepEqual(highlightRouteOf(input), { via: "kit", lang }, input)
  }
})

test("highlight: 空、text、plaintext 走纯文本", () => {
  for (const input of [undefined, null, "", "  ", "text", "txt", "plain", "plaintext", "PlainText"]) {
    assert.deepEqual(highlightRouteOf(input), { via: "plain" }, String(input))
  }
})

test("highlight: 其余语言走 shiki，常见别名归一", () => {
  assert.deepEqual(highlightRouteOf("python"), { via: "shiki", lang: "python" })
  assert.deepEqual(highlightRouteOf("py"), { via: "shiki", lang: "python" })
  assert.deepEqual(highlightRouteOf("bash"), { via: "shiki", lang: "bash" })
  assert.deepEqual(highlightRouteOf("sh"), { via: "shiki", lang: "bash" })
  assert.deepEqual(highlightRouteOf("zsh"), { via: "shiki", lang: "bash" })
  assert.deepEqual(highlightRouteOf("shell"), { via: "shiki", lang: "bash" })
  assert.deepEqual(highlightRouteOf("go"), { via: "shiki", lang: "go" })
  assert.deepEqual(highlightRouteOf("golang"), { via: "shiki", lang: "go" })
  assert.deepEqual(highlightRouteOf("rust"), { via: "shiki", lang: "rust" })
  assert.deepEqual(highlightRouteOf("css"), { via: "shiki", lang: "css" })
  assert.deepEqual(highlightRouteOf("py title=a.py"), { via: "shiki", lang: "python" }, "围栏 meta 只取第一个词")
})

test("highlight: 文件路径 → 语言名，再分流", () => {
  assert.equal(highlightLangOfPath("ui/src/a.tsx"), "tsx")
  assert.equal(highlightLangOfPath("scripts/run.py"), "py")
  assert.equal(highlightLangOfPath("deploy/push.sh"), "sh")
  assert.equal(highlightLangOfPath("cmd/main.go"), "go")
  assert.equal(highlightLangOfPath("C:\\x\\y.MJS"), "mjs")
  assert.equal(highlightLangOfPath("Dockerfile"), "docker")
  assert.equal(highlightLangOfPath("Makefile"), "make")
  assert.equal(highlightLangOfPath("README"), "text")
  assert.equal(highlightLangOfPath(".gitignore"), "text")
  assert.equal(highlightRouteOf(highlightLangOfPath("a/b.ts")).via, "kit")
  assert.equal(highlightRouteOf(highlightLangOfPath("a/b.py")).via, "shiki")
  assert.equal(highlightRouteOf(highlightLangOfPath("README")).via, "plain")
})

const SYNTAX_VAR = /^var\(--cw-syntax-[a-z-]+(, var\(--(cw-syntax-[a-z-]+|cw-text(-2)?)\))?\)$/
const HEX_OR_RGB = /#[0-9a-f]{3,8}\b|rgba?\(/i

test("highlight: 主题的每个颜色都是 --cw-syntax-* 变量（默认前景色 = --cw-text），没有写死的色值", () => {
  assert.equal(PI_SYNTAX_THEME.colors["editor.foreground"], PI_SYNTAX_FOREGROUND)
  assert.equal(PI_SYNTAX_FOREGROUND, "var(--cw-text)")
  for (const rule of PI_SYNTAX_THEME.settings) {
    const fg = rule.settings.foreground
    if (!rule.scope) {
      assert.equal(fg, PI_SYNTAX_FOREGROUND)
      continue
    }
    assert.match(fg, SYNTAX_VAR, String(rule.scope))
    assert.doesNotMatch(fg, HEX_OR_RGB)
  }
})

test("highlight: toHighlightLines 去掉默认前景色、转斜体、合并同样式记号（纯函数）", () => {
  const lines = toHighlightLines([
    [
      { content: "def", color: "var(--cw-syntax-keyword)", fontStyle: 0 },
      { content: " ", color: "var(--cw-text)", fontStyle: 0 },
      { content: "f", color: "VAR(--CW-TEXT)", fontStyle: 0 },
      { content: "", color: "var(--cw-syntax-string)" },
    ],
    [{ content: "# c", color: "var(--cw-syntax-comment, var(--cw-text-2))", fontStyle: 1 }],
    [],
  ])
  assert.deepEqual(lines, [
    [{ text: "def", color: "var(--cw-syntax-keyword)" }, { text: " f" }],
    [{ text: "# c", color: "var(--cw-syntax-comment, var(--cw-text-2))", italic: true }],
    [],
  ])
})

const SAMPLES = {
  python: [
    "import os",
    "",
    "def load(path: str) -> dict:",
    "    # 读配置",
    '    return {"a": 1, "n": None}',
    'print(load("x"))',
  ].join("\n"),
  bash: [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'NAME="pi"',
    'if [ -n "$NAME" ]; then',
    '  echo "hi $NAME" && exit 0',
    "fi",
  ].join("\n"),
  go: [
    "package main",
    "",
    'import "fmt"',
    "",
    "// 入口",
    "func main() {",
    "\tx := 42",
    '\tfmt.Println("hi", x, nil)',
    "}",
  ].join("\n"),
}

/** 在记号行里找文字恰好是 text 的记号 */
const find = (lines, text) => lines.flat().find((t) => t.text === text)

for (const [lang, code] of Object.entries(SAMPLES)) {
  test(`highlight: ${lang} 经 shiki 出记号，颜色全是 --cw-syntax-* 变量`, async () => {
    const lines = await highlightToLines(code, lang)
    assert.ok(lines, "shiki 应能高亮")
    assert.equal(lines.length, code.split("\n").length, "行数与源码一致")
    assert.equal(lines.map((l) => l.map((t) => t.text).join("")).join("\n"), code, "文字原样保留")
    const colored = lines.flat().filter((t) => t.color)
    assert.ok(colored.length >= 5, "有足够多的着色记号")
    for (const t of lines.flat()) {
      if (t.color === undefined) continue
      assert.match(t.color, SYNTAX_VAR, `${lang}: ${JSON.stringify(t)}`)
      assert.doesNotMatch(t.color, HEX_OR_RGB)
    }
    const kinds = new Set(colored.map((t) => t.color.match(/--cw-syntax-([a-z-]+)/)[1]))
    for (const k of ["keyword", "string", "comment"]) assert.ok(kinds.has(k), `${lang} 有 ${k}`)
  })
}

test("highlight: 关键记号的颜色对得上（python / bash / go）", async () => {
  const py = await highlightToLines(SAMPLES.python, "py")
  assert.equal(find(py, "def").color, "var(--cw-syntax-keyword)")
  assert.equal(find(py, "load").color, "var(--cw-syntax-func, var(--cw-syntax-keyword))")
  assert.equal(find(py, "# 读配置").italic, true)
  assert.match(find(py, "# 读配置").color, /--cw-syntax-comment/)
  assert.match(find(py, "1").color, /--cw-syntax-number/)

  const sh = await highlightToLines(SAMPLES.bash, "sh")
  assert.match(find(sh, "#!/usr/bin/env bash").color, /--cw-syntax-comment/)
  assert.equal(find(sh, "if").color, "var(--cw-syntax-keyword)")
  assert.equal(find(sh, "fi").color, "var(--cw-syntax-keyword)")
  assert.equal(find(sh, '"pi"').color, "var(--cw-syntax-string)")

  const go = await highlightToLines(SAMPLES.go, "golang")
  assert.equal(find(go, "func").color, "var(--cw-syntax-keyword)")
  assert.equal(find(go, "package").color, "var(--cw-syntax-keyword)")
  assert.equal(find(go, '"fmt"').color, "var(--cw-syntax-string)")
  assert.match(find(go, "Println").color, /--cw-syntax-func/)
  assert.match(find(go, "// 入口").color, /--cw-syntax-comment/)
})

test("highlight: 不认识的语言返回 null（调用方按纯文本渲染），\\r\\n 视同 \\n", async () => {
  assert.equal(await highlightToLines("x = 1", "no-such-lang-xyz"), null)
  const lines = await highlightToLines("a = 1\r\nb = 2", "python")
  assert.equal(lines.length, 2)
  assert.equal(lines[1].map((t) => t.text).join(""), "b = 2")
})

test("highlight: shiki 只做动态 import，不静态引入（主 chunk 不含 shiki 语言包）", () => {
  const src = read("../ui/src/pi/model/highlight.ts")
  const staticImports = src.match(/^import\s[^\n]*from\s+["']shiki[^"']*["']/gm) ?? []
  for (const line of staticImports) assert.match(line, /^import type /, line)
  assert.doesNotMatch(src, /from\s+["']@shikijs\//)
  assert.match(src, /import\("shiki"\)/)
})

// ---------- 4.5 reduced-motion ----------

/** 假 matchMedia：记下查询、可切换 matches、可触发 change */
function fakeMatchMedia(initial, { legacy = false } = {}) {
  const listeners = new Set()
  const state = { matches: initial, queries: [], listeners }
  const mql = {
    get matches() {
      return state.matches
    },
  }
  if (legacy) {
    mql.addListener = (fn) => listeners.add(fn)
    mql.removeListener = (fn) => listeners.delete(fn)
  } else {
    mql.addEventListener = (type, fn) => type === "change" && listeners.add(fn)
    mql.removeEventListener = (type, fn) => type === "change" && listeners.delete(fn)
  }
  const matchMedia = (q) => {
    state.queries.push(q)
    return mql
  }
  const flip = (v) => {
    state.matches = v
    for (const fn of [...listeners]) fn()
  }
  return { matchMedia, state, flip }
}

test("reduced-motion: 查询串与读取", () => {
  assert.equal(REDUCED_MOTION_QUERY, "(prefers-reduced-motion: reduce)")
  const on = fakeMatchMedia(true)
  assert.equal(readReducedMotion(on.matchMedia), true)
  assert.deepEqual(on.state.queries, [REDUCED_MOTION_QUERY])
  assert.equal(readReducedMotion(fakeMatchMedia(false).matchMedia), false)
})

test("reduced-motion: 没有 window / matchMedia（Node、SSR）时为 false，matchMedia 抛错也为 false", () => {
  assert.equal(typeof globalThis.window, "undefined")
  assert.equal(readReducedMotion(), false)
  assert.equal(readReducedMotion(null), false)
  assert.equal(readReducedMotion(() => { throw new Error("boom") }), false)
  const unsubscribe = subscribeReducedMotion(() => {})
  assert.equal(typeof unsubscribe, "function")
  unsubscribe()
})

test("reduced-motion: 订阅系统设置变化，取消后不再通知（含旧 Safari 的 addListener）", () => {
  for (const legacy of [false, true]) {
    const mm = fakeMatchMedia(false, { legacy })
    let calls = 0
    const unsubscribe = subscribeReducedMotion(() => calls++, mm.matchMedia)
    assert.equal(mm.state.listeners.size, 1)
    mm.flip(true)
    assert.equal(calls, 1)
    assert.equal(readReducedMotion(mm.matchMedia), true)
    unsubscribe()
    assert.equal(mm.state.listeners.size, 0)
    mm.flip(false)
    assert.equal(calls, 1)
  }
})

test("reduced-motion: motionOf 的四种运动（design §4.7）", () => {
  assert.deepEqual(motionOf(false), {
    pageTransitionMs: PAGE_TRANSITION_MS,
    sheetSlide: true,
    fadeOut: true,
    scrollBehavior: "smooth",
  })
  assert.equal(PAGE_TRANSITION_MS, 240)
  assert.deepEqual(motionOf(true), { pageTransitionMs: 0, sheetSlide: false, fadeOut: false, scrollBehavior: "auto" })
})

test("reduced-motion: 文件头写明受控的运动，spinner 归 CSS", () => {
  const src = read("../ui/src/pi/hooks/useReducedMotion.ts")
  const header = src.slice(0, src.indexOf("*/"))
  for (const word of ["240ms 页面转场", "PiSheet 滑入", "已重新连接", "behavior \"auto\"", "spinner", "pi-theme.css"]) {
    assert.ok(header.includes(word), word)
  }
  assert.match(src, /useSyncExternalStore/)
})

// UI 低危 19：代码高亮跨挂载缓存 —— 翻页/切视图回来时同一代码块不再重新着色、也不先闪纯文本。
test("highlight cache：同 lang+code 跨挂载命中，第二次不再调 loader；语言不同各存一份", async () => {
  clearHighlightCache()
  const lines = [[{ text: "def", color: "var(--cw-syntax-keyword)" }], [{ text: "  1" }]]
  let calls = 0
  const load = async () => {
    calls += 1
    return lines
  }
  assert.equal(cachedHighlight("def x():\n  return 1", "python"), undefined, "未着色前缓存未命中")
  assert.equal(await highlightLinesFor("def x():\n  return 1", "python", load), lines)
  assert.equal(calls, 1)
  // 模拟卸载后重挂载：直接查缓存同步拿到（首帧就是高亮，不闪纯文本）
  assert.equal(cachedHighlight("def x():\n  return 1", "python"), lines)
  assert.equal(await highlightLinesFor("def x():\n  return 1", "python", load), lines)
  assert.equal(calls, 1, "第二次走缓存")
  // 同一段源码换了语言是另一把键
  assert.equal(cachedHighlight("def x():\n  return 1", "bash"), undefined)
  await highlightLinesFor("def x():\n  return 1", "bash", load)
  assert.equal(calls, 2)
  clearHighlightCache()
})

test("highlight cache：并发挂载共用同一次着色（in-flight 去重），失败/不认识的语言不缓存", async () => {
  clearHighlightCache()
  const lines = [[{ text: "ok" }]]
  let calls = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const load = async () => {
    calls += 1
    await gate
    return lines
  }
  const first = highlightLinesFor("x = 1", "go", load)
  const second = highlightLinesFor("x = 1", "go", load)
  assert.equal(calls, 1, "两个挂载只发一次着色")
  release()
  assert.equal(await first, lines)
  assert.equal(await second, lines)
  assert.equal(cachedHighlight("x = 1", "go"), lines)

  // null（不认识的语言 / 加载失败）不写缓存，下次还能重试
  clearHighlightCache()
  let nullCalls = 0
  const nullLoad = async () => {
    nullCalls += 1
    return null
  }
  assert.equal(await highlightLinesFor("lang?", "no-such-lang", nullLoad), null)
  assert.equal(cachedHighlight("lang?", "no-such-lang"), undefined)
  await highlightLinesFor("lang?", "no-such-lang", nullLoad)
  assert.equal(nullCalls, 2, "失败结果不缓存")
  // loader 抛错不冒泡，调用方仍拿到 null
  assert.equal(await highlightLinesFor("boom", "go", async () => { throw new Error("x") }), null)
  clearHighlightCache()
})

test("highlight cache：条数/字符双上限按最久未用淘汰；超过单条上限的大文件不缓存", async () => {
  clearHighlightCache()
  const lines = [[{ text: "z" }]]
  const load = async () => lines
  for (let index = 0; index <= HIGHLIGHT_CACHE_MAX_ENTRIES; index += 1) {
    await highlightLinesFor(`code-${index}`, "python", load)
  }
  const stats = highlightCacheStats()
  assert.equal(stats.entries, HIGHLIGHT_CACHE_MAX_ENTRIES, "条数封顶")
  assert.equal(cachedHighlight("code-0", "python"), undefined, "最久未用的先淘汰")
  assert.ok(cachedHighlight(`code-${HIGHLIGHT_CACHE_MAX_ENTRIES}`, "python"), "最新的留下")

  // 字符预算：每块 100KB，6 块就超过 512KB，必须在上限内收敛
  clearHighlightCache()
  for (let index = 0; index < 6; index += 1) {
    await highlightLinesFor(`${index}`.padEnd(100_000, "x"), "python", load)
  }
  const budget = highlightCacheStats()
  assert.ok(budget.chars <= HIGHLIGHT_CACHE_MAX_CHARS, `字符账 ${budget.chars} 应 ≤ ${HIGHLIGHT_CACHE_MAX_CHARS}`)
  assert.ok(budget.entries < 6)

  // 单块超过上限：结果照常返回，但不进缓存（下次重着色），避免一块把整个缓存顶穿
  clearHighlightCache()
  const huge = "y".repeat(HIGHLIGHT_CACHE_MAX_ENTRY_CHARS + 1)
  assert.equal(await highlightLinesFor(huge, "python", load), lines)
  assert.deepEqual(highlightCacheStats(), { entries: 0, chars: 0 })
  clearHighlightCache()
})

test("highlight cache 接线：PiCodeBlock / PiFilePane 用带缓存的 hook；原 hook 保持不动", () => {
  const block = read("../ui/src/components/pi/conversation/PiCodeBlock.tsx")
  const pane = read("../ui/src/components/pi/conversation/PiFilePane.tsx")
  assert.match(block, /useCachedHighlightLines/)
  assert.match(pane, /useCachedHighlightLines/)
  assert.doesNotMatch(block, /@\/pi\/hooks\/useHighlightLines/)
  assert.doesNotMatch(pane, /@\/pi\/hooks\/useHighlightLines/)
  const cache = read("../ui/src/components/pi/conversation/highlightCache.ts")
  // 只缓存成功结果：null 分支不能落缓存（loader 结果直接 if (lines) 才写）
  assert.match(cache, /if \(lines\) cacheHighlight\(code, lang, lines\)/)
})
