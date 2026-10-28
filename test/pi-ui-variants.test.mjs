// PI-UI-REFS 架构线（P1）的隔离 / 契约测试：纯函数直接 import（node 的类型剥离），跨文件规则静态读源码。
// 1. 变体 id 与元数据（ui/src/pi/variants/types.ts）：三套、默认 cursor、非法回退、卡片 testid 稳定；
// 2. 偏好 ui 字段（ui/src/pi/model/prefs.ts）：默认 / 非法回退 / 迁移兼容（版本号不升、旧键不受影响）；
// 3. 设置页偏好读写口径（ui/src/pi/model/settingsView.ts）：ui 进 settingsPrefsOf，并只写新偏好键；
// 4. 注册表与挂载：cursor 静态（现有 PiRoot + PiAppBody）、claude / codex 用 React.lazy、PiApp 只调一次 useRelay、根节点 data-pi-ui；
// 5. 变体目录隔离：变体之间不互相 import、不 import variants/index（避免循环）；每个变体只读自己的目录 + @/ 共享基础设施；
// 6. 样式作用域：变体 CSS 的每条选择器都必须以 [data-pi-ui="<id>"] 开头，token 命名空间 --<id>-*，不定义 --cw-*；
// 7. 入口接线：设置页三张卡片的 data-testid、画廊 ?ui= 参数、测试文件注册进根 package.json。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { DEFAULT_PI_PREFS, LEGACY_STYLE_KEY, migratePiPrefs, PI_PREFS_VERSION, setPiPref } from "../ui/src/pi/model/prefs.ts"
import { settingsPrefsOf, settingsWritesOf } from "../ui/src/pi/model/settingsView.ts"
import {
  DEFAULT_PI_UI_VARIANT,
  isPiUiVariant,
  PI_UI_VARIANT_IDS,
  PI_UI_VARIANT_LIST,
  PI_UI_VARIANT_META,
  piUiVariantOf,
} from "../ui/src/pi/variants/types.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "ui/src")
const VARIANTS_DIR = path.join(SRC, "pi/variants")
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/")

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}
const isCode = (p) => /\.(ts|tsx)$/.test(p)
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")

/* ------------------------------------------------------------------ 1. 变体 id 与元数据 */

describe("变体 id 与元数据（variants/types.ts）", () => {
  test('三套变体固定为 cursor / claude / codex，默认 cursor', () => {
    assert.deepEqual([...PI_UI_VARIANT_IDS], ["cursor", "claude", "codex"])
    assert.equal(DEFAULT_PI_UI_VARIANT, "cursor")
    assert.equal(isPiUiVariant("cursor") && isPiUiVariant("claude") && isPiUiVariant("codex"), true)
  })

  test("配套的注册表 / 卡片列表覆盖全部变体，且顺序与 id 一致", () => {
    assert.equal(PI_UI_VARIANT_LIST.length, PI_UI_VARIANT_IDS.length)
    assert.deepEqual(
      PI_UI_VARIANT_LIST.map((m) => m.id),
      [...PI_UI_VARIANT_IDS],
    )
    for (const id of PI_UI_VARIANT_IDS) {
      const meta = PI_UI_VARIANT_META[id]
      assert.equal(meta.id, id)
      assert.ok(meta.label && meta.description, `${id} 缺显示名 / 描述`)
      // 设置页卡片的稳定 testid：验证线按它点，格式固定
      assert.equal(meta.testId, `pi-ui-variant-${id}`)
    }
  })

  test("非法 / 缺失的变体值一律回退 cursor（存储迁移、画廊参数同一入口）", () => {
    assert.equal(piUiVariantOf("claude"), "claude")
    assert.equal(piUiVariantOf("codex"), "codex")
    for (const bad of [undefined, null, "", "CURSOR", "pi", 0, false, {}, ["claude"], "claude "]) {
      assert.equal(isPiUiVariant(bad), false, `${String(bad)} 不应是合法变体`)
      assert.equal(piUiVariantOf(bad), "cursor", `${String(bad)} 应回退 cursor`)
    }
  })
})

/* ------------------------------------------------------------------ 2. 偏好 ui 字段（纯函数） */

describe("偏好 ui 字段：默认 / 回退 / 迁移兼容（model/prefs.ts）", () => {
  test("默认偏好带 ui = cursor，版本号保持 1（旧存储缺 ui 即默认值，不需要新版本）", () => {
    assert.equal(DEFAULT_PI_PREFS.ui, "cursor")
    assert.equal(PI_PREFS_VERSION, 1)
    assert.equal(migratePiPrefs(null).ui, "cursor")
    assert.deepEqual(migratePiPrefs(undefined), DEFAULT_PI_PREFS)
  })

  test("新键里的合法 ui 原样保留；非法值回落 cursor；多余字段丢掉", () => {
    for (const id of PI_UI_VARIANT_IDS) {
      assert.equal(migratePiPrefs(JSON.stringify({ v: 1, ui: id })).ui, id)
    }
    for (const bad of [undefined, null, "", "CURSOR", "claude-ui", 3, {}, ["claude"], true]) {
      const stored = { v: 1, ...(bad === undefined ? {} : { ui: bad }) }
      assert.equal(migratePiPrefs(JSON.stringify(stored)).ui, "cursor", `${JSON.stringify(bad)} 应回退 cursor`)
    }
    const extra = migratePiPrefs(JSON.stringify({ v: 1, ui: "codex", junk: 1 }))
    assert.deepEqual(Object.keys(extra).sort(), Object.keys(DEFAULT_PI_PREFS).sort())
  })

  test("迁移兼容：旧键 pi_remote_style 里的字段不搬 ui（旧界面没有变体概念），旧键内容不影响 ui", () => {
    const legacy = JSON.stringify({ uiRevision: 4, theme: "claudeDark", queueSend: "steer", completionSound: true, dialogRemoteAnswer: true })
    assert.equal(migratePiPrefs(null, legacy).ui, "cursor")
    assert.equal(migratePiPrefs({ v: 1, ui: "claude" }, legacy).ui, "claude")
    assert.equal(LEGACY_STYLE_KEY, "pi_remote_style")
    // 主题迁移只影响 theme，不碰 ui
    assert.equal(migratePiPrefs({ v: 1 }, null, "dark").ui, "cursor")
  })

  test("setPiPref 可以改 ui，且不触发「更多 N」清空（只有改分组才清）", () => {
    const next = setPiPref(DEFAULT_PI_PREFS, "ui", "claude")
    assert.equal(next.prefs.ui, "claude")
    assert.equal(next.clearExpanded, false)
    assert.deepEqual(setPiPref(DEFAULT_PI_PREFS, "ui", "codex").prefs, { ...DEFAULT_PI_PREFS, ui: "codex" })
  })
})

/* ------------------------------------------------------------------ 3. 设置页偏好读写口径 */

describe("设置页偏好：ui 进 settingsPrefsOf，写入只落新偏好键（model/settingsView.ts）", () => {
  test("settingsPrefsOf 带出 ui；settingsWritesOf 把 ui 写成 [{ kind: pref, key: ui }]", () => {
    assert.equal(settingsPrefsOf(DEFAULT_PI_PREFS, {}, "auto").ui, "cursor")
    assert.equal(settingsPrefsOf({ ...DEFAULT_PI_PREFS, ui: "codex" }, {}, "auto").ui, "codex")
    assert.deepEqual(settingsWritesOf({ ui: "claude" }), [{ kind: "pref", key: "ui", value: "claude" }])
    // ui 之外不额外写旧键 / sendMode
    assert.deepEqual(settingsWritesOf({ ui: "cursor" }).map((w) => w.kind), ["pref"])
  })
})

/* ------------------------------------------------------------------ 4. 注册表与挂载（静态读源码） */

describe("变体注册表与挂载（variants/index.ts、PiApp.tsx、PiRoot.tsx）", () => {
  const variantsIndex = stripComments(fs.readFileSync(path.join(VARIANTS_DIR, "index.ts"), "utf8"))
  const piApp = stripComments(fs.readFileSync(path.join(SRC, "pi/PiApp.tsx"), "utf8"))
  const piRoot = stripComments(fs.readFileSync(path.join(SRC, "components/pi/shared/PiRoot.tsx"), "utf8"))

  test("cursor 静态 import（= 现有 PiRoot + PiAppBody），claude / codex 各一个 React.lazy", () => {
    assert.match(variantsIndex, /import\s*\{\s*CursorApp\s*\}\s*from\s*"\.\/cursor\/CursorApp"/)
    assert.match(variantsIndex, /lazy\(\(\)\s*=>\s*import\("\.\/claude\/ClaudeApp"\)/)
    assert.match(variantsIndex, /lazy\(\(\)\s*=>\s*import\("\.\/codex\/CodexApp"\)/)
    // 只允许两处 lazy：cursor 不能懒加载（默认界面首屏不能闪）
    assert.equal((variantsIndex.match(/\blazy\(/g) ?? []).length, 2)
    assert.match(variantsIndex, /PI_UI_VARIANT_REGISTRY/)
    for (const id of PI_UI_VARIANT_IDS) assert.ok(variantsIndex.includes(`PI_UI_VARIANT_META.${id}`), `注册表缺 ${id}`)
  })

  test("三个变体入口文件都存在，导出 <PascalCase>App，且根节点带 data-pi-ui 或经 PiRoot 的 ui 参数", () => {
    const files = {
      cursor: path.join(VARIANTS_DIR, "cursor/CursorApp.tsx"),
      claude: path.join(VARIANTS_DIR, "claude/ClaudeApp.tsx"),
      codex: path.join(VARIANTS_DIR, "codex/CodexApp.tsx"),
    }
    for (const [id, file] of Object.entries(files)) {
      assert.ok(fs.existsSync(file), `缺 ${rel(file)}`)
      const src = stripComments(fs.readFileSync(file, "utf8"))
      const name = id[0].toUpperCase() + id.slice(1) + "App"
      assert.match(src, new RegExp(`export function ${name}\\(`), `${rel(file)} 要导出 ${name}`)
      assert.ok(src.includes(`ui="${id}"`) || src.includes(`data-pi-ui="${id}"`) || src.includes("data-pi-ui"), `${rel(file)} 的根节点要写 ${id} 变体标记`)
      assert.match(src, /VariantAppProps/, `${rel(file)} 的 props 走 VariantAppProps 契约`)
    }
    // cursor = 现有展示树，不改行为
    const cursor = stripComments(fs.readFileSync(files.cursor, "utf8"))
    assert.match(cursor, /<PiRoot/)
    assert.match(cursor, /PiAppBody/)
    assert.match(cursor, /PiLayerProvider/)
    // claude / codex 骨架样式只在自己的 CSS 里，组件文件不写内联色值（pi-structure 的白名单也是 0）
    for (const id of ["claude", "codex"]) {
      const src = stripComments(fs.readFileSync(files[id], "utf8"))
      assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${rel(files[id])} 不应写字面色值（样式放 CSS）`)
    }
  })

  test("PiApp 在 useRelay / usePiUiState / usePiTheme 之后按 prefs.ui 挂载；useRelay 只调一次", () => {
    assert.equal((piApp.match(/\buseRelay\(\)/g) ?? []).length, 1, "useRelay() 只能出现在 PiApp 一处，切换变体不能重连")
    assert.match(piApp, /piVariantDefOf\(ui\.prefs\.ui\)/)
    assert.match(piApp, /Suspense/)
    assert.match(piApp, /PiVariantLoading/)
    // 展示树经注册表挂载：PiApp 不再直接 import PiAppBody / PiLayerProvider（挪到 variants/cursor/CursorApp）
    assert.doesNotMatch(piApp, /PiAppBody|PiLayerProvider/)
    assert.doesNotMatch(piApp, /from "@\/components\/pi\/shared"/)
  })

  test('根部 data-pi-ui：默认 "cursor"（现有屏幕不传也有根标记），布局委托 headless（P2.5）', () => {
    // P2.5：根节点的布局 / 视口帧逻辑挪到 @/pi/headless；data-pi-ui 由 PiHeadlessRoot 统一写。
    const headlessRoot = stripComments(fs.readFileSync(path.join(SRC, "pi/headless/root.tsx"), "utf8"))
    assert.match(headlessRoot, /data-pi-ui=\{ui\}/)
    assert.match(headlessRoot, /data-pi-theme=\{theme\}/)
    assert.match(headlessRoot, /data-pi-layout=\{viewport\}/)
    assert.match(headlessRoot, /data-pi-mode=\{product \? "product" : undefined\}/)
    assert.match(headlessRoot, /PiFrameContext\.Provider/)
    assert.match(piRoot, /PiHeadlessRoot/)
    assert.match(piRoot, /usePiRootGeometry/)
    assert.match(piRoot, /ui=\{ui\}/)
    assert.match(piRoot, /ui = "cursor"/)
    assert.match(piRoot, /PiUiVariant/)
    // cursor 的视觉类名 / token 不变（零回归）
    assert.match(piRoot, /overflow-hidden bg-\(--cw-bg\)/)
    assert.match(piRoot, /absolute inset-0/)
  })

  test("usePiUiState 暴露 setUiVariant 动作（设置页写 prefs.ui 的便捷入口）", () => {
    const hook = fs.readFileSync(path.join(SRC, "pi/hooks/usePiUiState.ts"), "utf8")
    assert.match(hook, /setUiVariant\(variant: PiUiVariant\): void/)
    assert.match(hook, /setUiVariant: \(variant\) =>/)
    assert.match(hook, /setPiPref\(cur\.prefs, "ui", variant\)/)
  })
})

/* ------------------------------------------------------------------ 5. 变体目录隔离（静态扫描） */

const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".css"]
function resolveImport(from, spec) {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null
  if (!base) return null
  for (const ext of EXTS) {
    const file = base + ext
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file
  }
  return null
}
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g

describe("变体目录隔离：互不 import，只依赖 @/ 共享基础设施（静态扫描）", () => {
  const variantDirs = new Map(PI_UI_VARIANT_IDS.map((id) => [id, path.join(VARIANTS_DIR, id)]))
  const inferred = (target) => [...variantDirs].find(([, dir]) => target === dir || target.startsWith(dir + path.sep))?.[0] ?? null

  test("每个变体都有独立目录", () => {
    for (const [id, dir] of variantDirs) {
      assert.ok(fs.existsSync(dir), `缺变体目录 ${rel(dir)}`)
      assert.ok(walk(dir, isCode).length > 0, `${id} 变体目录里没有代码文件`)
    }
  })

  test("变体之间禁止互相 import；变体不 import variants/index.ts（避免循环依赖）", () => {
    const bad = []
    for (const [id, dir] of variantDirs) {
      for (const file of walk(dir, isCode)) {
        for (const match of stripComments(fs.readFileSync(file, "utf8")).matchAll(IMPORT_RE)) {
          const spec = match[1] ?? match[2]
          const target = resolveImport(file, spec)
          if (!target) continue
          if (path.resolve(target) === path.resolve(VARIANTS_DIR, "index.ts")) bad.push(`${rel(file)} → ${spec}（不能 import variants/index）`)
          const owner = inferred(target)
          if (owner && owner !== id) bad.push(`${rel(file)} → ${spec}（${id} 变体不能 import ${owner} 变体）`)
        }
      }
    }
    assert.deepEqual(bad, [])
  })

  test("变体只 import 自己目录内的文件或 @/ 共享基础设施（不 import 开发画廊、旧界面、别处 .css）", () => {
    const bad = []
    for (const [id, dir] of variantDirs) {
      for (const file of walk(dir, isCode)) {
        for (const match of stripComments(fs.readFileSync(file, "utf8")).matchAll(IMPORT_RE)) {
          const spec = match[1] ?? match[2]
          if (!spec.startsWith(".") && !spec.startsWith("@/")) continue
          const target = resolveImport(file, spec)
          if (!target) {
            bad.push(`${rel(file)} → ${spec}（解析不到）`)
            continue
          }
          const insideOwn = target === dir || target.startsWith(dir + path.sep)
          if (insideOwn) continue
          const r = rel(target)
          if (!(r.startsWith("ui/src/pi/") || r.startsWith("ui/src/components/") || r.startsWith("ui/src/lib/") || r.startsWith("ui/src/relay/"))) {
            bad.push(`${rel(file)} → ${spec}（变体不 import ${r}）`)
          } else if (r.includes("/pi/dev/") || r.endsWith(".tsx") === false && r.includes("style/")) {
            bad.push(`${rel(file)} → ${spec}（变体不能 import 开发画廊 / 旧界面样式）`)
          }
        }
      }
    }
    assert.deepEqual(bad, [])
  })
})

/* ------------------------------------------------------------------ 6. 变体 CSS 作用域 */

/** 抽出 CSS 里的选择器（递归进 @media / @supports；@keyframes / @font-face 等规则体不是选择器，跳过） */
function cssSelectors(css) {
  const out = []
  const walkRules = (source) => {
    let i = 0
    while (i < source.length) {
      const brace = source.indexOf("{", i)
      if (brace < 0) break
      const prelude = source.slice(i, brace).trim()
      let depth = 1
      let j = brace + 1
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth += 1
        else if (source[j] === "}") depth -= 1
        j += 1
      }
      const body = source.slice(brace + 1, j - 1)
      if (/^@(media|supports|layer|container)\b/.test(prelude)) walkRules(body)
      else if (!prelude.startsWith("@")) out.push(...prelude.split(",").map((s) => s.trim()).filter(Boolean))
      i = j
    }
  }
  walkRules(css)
  return out
}

describe('变体 CSS 作用域：选择器必须带 [data-pi-ui="<id>"] 前缀（契约 §5）', () => {
  /**
   * 允许两种作用域写法（design-spec §3）：
   * 1. `[data-pi-ui="<id>"] …` —— 浅色 / 通用规则；
   * 2. `:root[data-pi-theme="dark"] [data-pi-ui="<id>"] …` —— 深色重设（data-pi-theme 镜像在 <html>，必须用祖先选择器）。
   * 两种都以变体作用域开头，等价于「不写全局元素选择器」。
   */
  const scoped = (selector, id) =>
    selector.startsWith(`[data-pi-ui="${id}"]`) ||
    selector.startsWith(`:root[data-pi-theme="dark"] [data-pi-ui="${id}"]`) ||
    selector.startsWith(`:root[data-pi-theme="light"] [data-pi-ui="${id}"]`)

  test("claude / codex 都有独立 CSS，且每条选择器都以自己的变体作用域开头", () => {
    for (const id of PI_UI_VARIANT_IDS) {
      const dir = path.join(VARIANTS_DIR, id)
      const cssFiles = walk(dir, (p) => p.endsWith(".css"))
      if (id === "cursor") continue // cursor 复用现有 --cw-* 样式树，不要求自己的 CSS
      assert.ok(cssFiles.length > 0, `${id} 变体没有自己的 CSS`)
      for (const file of cssFiles) {
        const css = stripComments(fs.readFileSync(file, "utf8"))
        const selectors = cssSelectors(css)
        assert.ok(selectors.length > 0, `${rel(file)} 没有解析出选择器`)
        const bad = selectors.filter((selector) => !scoped(selector, id))
        assert.deepEqual(bad, [], `${rel(file)} 有选择器没挂在 [data-pi-ui="${id}"] 作用域下`)
      }
    }
  })

  test("变体 CSS 用 --<id>-* 命名空间，不定义 / 不覆盖 --cw-*", () => {
    for (const id of ["claude", "codex"]) {
      const dir = path.join(VARIANTS_DIR, id)
      for (const file of walk(dir, (p) => p.endsWith(".css"))) {
        const css = stripComments(fs.readFileSync(file, "utf8"))
        assert.match(css, new RegExp(`--${id}-[a-z0-9-]+\\s*:`), `${rel(file)} 缺 --${id}-* token 命名空间`)
        const cwDeclarations = [...css.matchAll(/(?:^|[{;\s])(--cw-[a-z0-9-]+)\s*:/g)].map((m) => m[1])
        assert.deepEqual(cwDeclarations, [], `${rel(file)} 不能定义 / 覆盖 --cw-* 变量`)
      }
    }
  })
})

/* ------------------------------------------------------------------ 7. 入口接线 */

describe("入口接线：设置页三卡片 / 画廊 ?ui= / 测试注册", () => {
  const settingsPage = stripComments(fs.readFileSync(path.join(SRC, "components/pi/composer/PiSettingsPage.tsx"), "utf8"))
  const piStage = stripComments(fs.readFileSync(path.join(SRC, "pi/dev/PiStage.tsx"), "utf8"))
  const liveRoute = stripComments(fs.readFileSync(path.join(SRC, "pi/dev/LiveRoute.tsx"), "utf8"))
  const piApp = stripComments(fs.readFileSync(path.join(SRC, "pi/PiApp.tsx"), "utf8"))
  const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))

  test("设置页「外观」里的界面卡片用变体元数据渲染，data-testid 稳定、选中即时写回 prefs.ui", () => {
    assert.match(settingsPage, /PI_UI_VARIANT_LIST/)
    assert.match(settingsPage, /data-testid=\{item\.testId\}/)
    assert.match(settingsPage, /data-ui-variant=\{item\.id\}/)
    assert.match(settingsPage, /change\(\{ ui: item\.id \}\)/)
    for (const id of PI_UI_VARIANT_IDS) assert.ok(settingsPage.includes(`PI_UI_VARIANT_LIST`) && PI_UI_VARIANT_META[id].testId.includes(id))
  })

  test("画廊支持 ?ui=：索引有变体切换链接，#/live 按变体渲染（cursor 原树 / claude·codex 注册表入口）", () => {
    assert.match(piStage, /data-gallery-ui-link/)
    assert.match(piStage, /isPiUiVariant/)
    assert.match(piStage, /data-pi-ui=\{uiVariant\}/)
    assert.match(liveRoute, /piVariantDefOf\(uiVariant\)/)
    assert.match(liveRoute, /PiVariantLoading variant=\{uiVariant\}/)
    assert.match(liveRoute, /uiVariant === "cursor"/)
    assert.match(liveRoute, /data-pi-ui=\{uiVariant\}/)
  })

  test("test/pi-ui-variants.test.mjs 已注册进根 package.json 的 npm test", () => {
    assert.ok(rootPackage.scripts.test.split(/\s+/).includes("test/pi-ui-variants.test.mjs"), "npm test 里要包含本文件")
  })

  /* Lead 裁决 Q2：首帧脚本按 pi_remote_pi_prefs.ui 预写 data-pi-ui + claude/codex 的 S0 底色，避免首帧闪 cursor；
   * React（PiApp）接管后以偏好为准。规则逐条在 test/pi-p6-a.test.mjs 的 vm 用例里跑，这里只钉住两端接线。 */
  test("首帧脚本预写 data-pi-ui 与 S0 底色；PiApp 接管 <html> 上的 data-pi-ui 并清掉临时底色", () => {
    const indexHtml = fs.readFileSync(path.join(ROOT, "ui/index.html"), "utf8")
    assert.match(indexHtml, /setAttribute\("data-pi-ui", ui\)/)
    assert.match(indexHtml, /__PI_UI_READY__/)
    // S0 底色（design-spec §1.2 表 1-A / §2.2）
    for (const color of ["#f9f9f7", "#0b0b0b", "#ececec", "#0d0d0d"]) assert.ok(indexHtml.includes(color), `首帧脚本缺 S0 底色 ${color}`)
    assert.match(piApp, /__PI_UI_READY__ = true/)
    assert.match(piApp, /setAttribute\("data-pi-ui", ui\.prefs\.ui\)/)
    assert.match(piApp, /removeProperty\("background-color"\)/)
  })
})
