// P2.5 独立组件基础设施（headless 根 / 视口）+ 变体独立性守卫。
//
// 背景：用户新增硬性要求（brief「用户新增硬性要求」）——两套变体必须完全自包含，禁止复用 cursor 版本的 UI 组件/样式。
// 本文件分两部分：
//   - `structure` 组：headless 基础设施与 cursor 零回归的**立即全绿**结构检查（含 scanner 自测、hooks/model/relay 白名单审计）；
//   - `independence` 组：**硬断言（0 容忍，不允许 skip 兜底）**——v2 两线必须真绿；任何违规都带着文件清单失败。
//     检查项：禁止 import、--cw-*（注释外）、cursor 组件标识符、CSS 作用域（逐条选择器）、cursor DOM 结构标记、
//     直接读写浏览器存储、require()、headless 根使用覆盖。浏览器 DOM 归因另见 开发工具（未随公开仓提供）（P3 用，不进单测）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  PI_SAFE_AREA,
  PI_KEYBOARD_HEIGHT,
  PI_STAGE_HEIGHT,
  piRootGeometry,
} from "../ui/src/pi/headless/geometry.ts"
import {
  PI_UI_INDEPENDENCE_VARIANTS,
  PI_VARIANT_ALLOWED_HOOKS,
  PI_VARIANT_ALLOWED_HOOK_EXPORTS,
  PI_VARIANT_ALLOWED_IMPORT_PREFIXES,
  PI_VARIANT_ALLOWED_MODEL_MODULES,
  PI_VARIANT_ALLOWED_RELAY_MODULES,
  PI_VARIANT_ALLOWED_THIRD_PARTY,
  PI_VARIANT_ALLOWED_UTILITY_CLASSES,
  PI_VARIANT_CURSOR_CLASS_PREFIXES,
  PI_VARIANT_CURSOR_COMPONENT_NAMES,
  PI_VARIANT_ENTRIES,
  PI_VARIANT_FORBIDDEN_CLASS_PREFIXES,
  PI_VARIANT_FORBIDDEN_DOM_MARKERS,
  PI_VARIANT_FORBIDDEN_STORAGE_APIS,
  PI_VARIANT_FORBIDDEN_GLOBAL_SELECTORS,
  PI_VARIANT_FORBIDDEN_IMPORT_PREFIXES,
  PI_VARIANT_FORBIDDEN_TOKENS,
  PI_VARIANT_HEADLESS_LOGIC_CANDIDATES,
  PI_VARIANT_HEADLESS_LOGIC_PREFIX,
  PI_VARIANT_PORTING_REQUIRED,
  PI_VARIANT_TYPE_EXPORT_SOURCES,
  PI_VARIANT_OWN_CLASS_PREFIX,
  PI_VARIANT_TYPE_ONLY_IMPORTS,
  classifyVariantClassToken,
  isTailwindUtilityClass,
  piVariantImportVerdict,
  variantCssImportVerdict,
} from "../ui/src/pi/headless/allowlist.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "ui/src")
const HEADLESS = path.join(SRC, "pi/headless")
const VARIANTS = path.join(SRC, "pi/variants")
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
const isCss = (p) => p.endsWith(".css")
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8")

/* ------------------------------------------------------------------ structure：headless 基础设施 */

describe("headless：根 / 视口 / frame（structure，立即全绿）", () => {
  const headlessFiles = ["frame.ts", "geometry.ts", "root.tsx", "allowlist.ts", "index.ts"]
  const headlessSource = (name) => stripComments(fs.readFileSync(path.join(HEADLESS, name), "utf8"))

  test("headless 模块文件齐全，index.ts 导出 frame / geometry / root / allowlist", () => {
    for (const name of headlessFiles) assert.ok(fs.existsSync(path.join(HEADLESS, name)), `缺 ui/src/pi/headless/${name}`)
    const index = headlessSource("index.ts")
    for (const part of ["./frame", "./geometry", "./root", "./allowlist"]) assert.ok(index.includes(part), `index.ts 缺 ${part} 导出`)
  })

  test("headless 无视觉：不 import CSS / cursor 组件 / kit，不声明 --cw-* token", () => {
    for (const name of headlessFiles) {
      if (name === "allowlist.ts") continue // 白名单本身要写 "--cw-" 字面量做事规则
      const src = headlessSource(name)
      assert.doesNotMatch(src, /from\s+"[^"]+\.css"/, `${name} 不应 import CSS`)
      assert.doesNotMatch(src, /from\s+"@\/components\/kit/, `${name} 不应 import kit`)
      assert.doesNotMatch(src, /from\s+"@\/components\/pi\/(?!shared\/viewport|shared\/frame)/, `${name} 不应 import cursor 部件（类型除外）`)
      assert.doesNotMatch(src, /--cw-/, `${name} 不应出现 --cw- token`)
    }
  })

  test("piRootGeometry：舞台 / 产品两种模式的几何与 PiFrame 口径和 P6.1 PiRoot 一致", () => {
    // 舞台 1440×900（无键盘）
    const desktopStage = piRootGeometry({ viewport: "desktop" })
    assert.deepEqual(
      [desktopStage.mode, desktopStage.product, desktopStage.phone, desktopStage.keyboardOpen, desktopStage.keyboardH, desktopStage.vvHeight, desktopStage.vvOffsetTop, desktopStage.safeTop],
      ["stage", false, false, false, 0, PI_STAGE_HEIGHT.desktop, 0, PI_SAFE_AREA.desktop.top],
    )
    // 舞台 390×844 键盘屏：安全区 47/34，可视视口 = 844 − 336
    const phoneStageKb = piRootGeometry({ viewport: "phone", keyboard: true })
    assert.deepEqual([phoneStageKb.keyboardOpen, phoneStageKb.keyboardH, phoneStageKb.vvHeight, phoneStageKb.safeTop], [true, PI_KEYBOARD_HEIGHT, PI_STAGE_HEIGHT.phone - PI_KEYBOARD_HEIGHT, PI_SAFE_AREA.phone.top])
    // 桌面布局传 keyboard=true 不生效（键盘只在手机布局）
    assert.equal(piRootGeometry({ viewport: "desktop", keyboard: true }).keyboardOpen, false)
    // 产品模式：手机键盘开着 → 根节点平移 offsetTop、keyboardH = 布局视口底 − 可视视口底；frame 交给部件
    const device = { keyboard: true, height: 508, offsetTop: 96, layoutHeight: 844 }
    const product = piRootGeometry({ viewport: "phone", device, safeTop: 47 })
    assert.deepEqual(
      [product.mode, product.product, product.keyboardOpen, product.keyboardH, product.vvHeight, product.vvOffsetTop, product.safeTop],
      ["product", true, true, 844 - 96 - 508, 508, 96, 47],
    )
    assert.deepEqual(product.frame, { mode: "product", keyboardOpen: true, vvHeight: 508, vvOffsetTop: 96, safeTop: 47, keyboardH: 844 - 96 - 508 })
    // 产品模式：桌面（键盘恒收起）、手机键盘收起
    const productDesktop = piRootGeometry({ viewport: "desktop", device: { keyboard: false, height: 900, offsetTop: 0, layoutHeight: 900 }, safeTop: 0 })
    assert.deepEqual([productDesktop.keyboardOpen, productDesktop.keyboardH, productDesktop.vvHeight], [false, 0, 900])
    // 纯函数：同输入同输出（无副作用）
    assert.deepEqual(piRootGeometry({ viewport: "phone", keyboard: true }), phoneStageKb)
  })

  test("PiHeadlessRoot：写 <html> data 属性、产品 fixed/100dvh 几何、安全区探针、PiFrameContext、data-pi-ui", () => {
    const src = headlessSource("root.tsx")
    // <html> 镜像 + 卸载清理
    assert.match(src, /el\.setAttribute\("data-pi-theme", theme\)/)
    assert.match(src, /el\.setAttribute\("data-pi-layout", viewport\)/)
    assert.match(src, /el\.setAttribute\("data-pi-mode", "product"\)/)
    // 产品模式 fixed 铺满 + 100dvh；键盘开着时平移到 offsetTop、底边贴布局视口底
    assert.match(src, /position: "fixed"/)
    assert.match(src, /height: "100dvh"/)
    assert.match(src, /geometry\.keyboardOpen \? \{ top: geometry\.vvOffsetTop, bottom: 0, height: "auto" \} : null/)
    // 舞台模式 absolute inset-0
    assert.match(src, /position: "absolute", top: 0, right: 0, bottom: 0, left: 0/)
    // 安全区实测探针不依赖 cursor token（env 直接量）
    assert.match(src, /env\(safe-area-inset-top, 0px\)/)
    assert.match(src, /data-pi-safe-probe=""/)
    // data-pi-ui / data-pi-theme / data-pi-layout / data-pi-mode 写在根节点上
    assert.match(src, /data-pi-ui=\{ui\}/)
    assert.match(src, /data-pi-theme=\{theme\}/)
    assert.match(src, /data-pi-layout=\{viewport\}/)
    assert.match(src, /data-pi-mode=\{product \? "product" : undefined\}/)
    assert.match(src, /PiFrameContext\.Provider value=\{geometry\.frame\}/)
    // 无视觉：headless 不定义任何 class 名 / 不 import CSS
    assert.doesNotMatch(src, /from\s+"[^"]+\.css"/)
    assert.doesNotMatch(src, /className="[^"]+"/)
  })

  test("cursor 的 PiRoot 改为复用 headless：布局逻辑委托、DOM/类名零回归", () => {
    const piRoot = stripComments(read("ui/src/components/pi/shared/PiRoot.tsx"))
    assert.match(piRoot, /from "@\/pi\/headless"/)
    assert.match(piRoot, /PiHeadlessRoot/)
    assert.match(piRoot, /usePiRootGeometry/)
    // 它自己不再算几何 / 不再写 <html> 属性 / 不再渲染探针（都归 headless）
    for (const gone of ["ResizeObserver", "STAGE_HEIGHT =", "useLayoutEffect", "useRef", "useState", "data-pi-root=", "data-pi-mode="]) {
      assert.ok(!piRoot.includes(gone), `PiRoot 仍包含已抽走的逻辑：${gone}`)
    }
    // cursor 视觉 class / token 保持原样（零回归）：产品模式 base、舞台模式多 absolute inset-0
    for (const cls of [
      "overflow-hidden bg-(--cw-bg) text-(length:--cw-text-base) leading-(--cw-leading-base) text-(--cw-text) antialiased",
      "absolute inset-0",
      '"--cw-pi-safe-top"',
      '"--cw-pi-safe-bottom"',
      '"--cw-pi-keyboard-h"',
    ]) {
      assert.ok(piRoot.includes(cls), `PiRoot 缺原有视觉 / 变量：${cls}`)
    }
    // PI_SAFE_AREA / PI_KEYBOARD_HEIGHT 仍从 PiRoot 导出（历史 import 不变）
    assert.match(piRoot, /export \{ PI_KEYBOARD_HEIGHT, PI_SAFE_AREA, PI_STAGE_HEIGHT \} from "@\/pi\/headless\/geometry"/)
  })

  test("components/pi/shared/frame.ts 仍是历史入口：再导出 headless 的 frame 类型 / context / usePiFrame，保留 cursor 手机 dock context", () => {
    const frame = stripComments(read("ui/src/components/pi/shared/frame.ts"))
    assert.match(frame, /export \{ PiFrameContext, usePiFrame \} from "@\/pi\/headless\/frame"/)
    assert.match(frame, /export type \{ PiDeviceFrame, PiFrame \} from "@\/pi\/headless\/frame"/)
    assert.match(frame, /PiDockLayoutContext/)
    assert.match(frame, /usePiDockLayout/)
  })
})

/* ------------------------------------------------------------------ structure：白名单与 scanner 自测 */

describe("共享逻辑白名单 + 独立性 scanner（structure，立即全绿）", () => {
  test("allowlist：白名单与禁令不互相打架（headless/model/relay/白名单 hook 都不能被禁）", () => {
    const allowed = [...PI_VARIANT_ALLOWED_IMPORT_PREFIXES, "@/pi/variants/types", ...PI_VARIANT_ALLOWED_HOOKS, ...PI_VARIANT_TYPE_ONLY_IMPORTS]
    for (const spec of allowed) {
      for (const forbidden of PI_VARIANT_FORBIDDEN_IMPORT_PREFIXES) {
        // type-only 例外：containers/types、shared/viewport 会被更宽的禁令前缀命中，但只允许 import type（见下一条自测）
        if (PI_VARIANT_TYPE_ONLY_IMPORTS.includes(spec)) continue
        assert.ok(!spec.startsWith(forbidden), `${spec} 同时出现在白名单和禁令 ${forbidden}`)
      }
    }
    assert.deepEqual([...PI_UI_INDEPENDENCE_VARIANTS], ["claude", "codex"])
  })

  test("piVariantImportVerdict：白名单放行、cursor UI / 容器值 import / 越界相对 import 拒绝", () => {
    const ok = (spec, check) => assert.equal(piVariantImportVerdict(spec, check).ok, true, `${spec} 应放行`)
    const bad = (spec, check, match) => {
      const v = piVariantImportVerdict(spec, check)
      assert.equal(v.ok, false, `${spec} 应拒绝`)
      if (match) assert.match(v.reason, match)
    }
    // 允许：headless / model / relay / 白名单 hook / 变体契约类型 / 自己的相对文件 / 裸包
    for (const spec of ["@/pi/headless", "@/pi/headless/root", "@/pi/model/prefs", "@/relay", "@/relay/attention", "@/pi/variants/types", "react", "@fontsource-variable/inter"]) ok(spec)
    for (const hook of PI_VARIANT_ALLOWED_HOOKS) ok(hook)
    ok("./parts/ClaudeTitleBar", { ownDir: true })
    ok("./styles/tokens.css", { ownDir: true })
    // 拒绝：cursor 组件 / kit / 容器值 import / 非白名单 hook / 注册表 / 变体间 / 样式越界
    bad("@/components/pi/shared", {}, /cursor/)
    bad("@/components/kit/icons", {}, /cursor/)
    bad("@/components/pi/shared/viewport", {}, /import type/)
    bad("@/pi/containers/TranscriptContainer", {}, /containers/)
    bad("@/pi/hooks/usePiShellShortcuts", {}, /hook 不在白名单/)
    bad("@/pi/variants/index", {}, /注册表/)
    bad("@/pi/dev/main", {})
    bad("@/pi/styles/tokens.css", {})
    bad("../claude/ClaudeApp", {})
    // 例外：containers/types 与 viewport 的 import type 放行
    ok("@/pi/containers/types", { typeOnly: true })
    ok("@/components/pi/shared/viewport", { typeOnly: true })
  })

  test("白名单 hook：存在、无 JSX（.ts）、无 className / kit / cursor DOM 依赖", () => {
    for (const spec of PI_VARIANT_ALLOWED_HOOKS) {
      const file = path.join(SRC, `${spec.replace("@/", "")}.ts`)
      assert.ok(fs.existsSync(file), `白名单 hook 不存在：${spec}`)
      assert.equal(path.extname(file), ".ts", `白名单 hook 必须是 .ts（无 JSX）：${spec}`)
      const src = stripComments(fs.readFileSync(file, "utf8"))
      assert.doesNotMatch(src, /className|@\/components\/kit/, `${spec} 含样式依赖，不能进白名单`)
      // 白名单 hook 允许 type-only 依赖 components/pi，但值 import 不行（值 import 会带进 cursor 实现）
      for (const m of src.matchAll(/(?:^|[\s;])import\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/g)) {
        assert.ok(!m[1].startsWith("@/components/"), `${spec} 值 import 了 cursor 实现：${m[1]}`)
      }
    }
  })

  test("白名单 model / relay：无 JSX / className / cursor 组件依赖（逻辑可复用）", () => {
    for (const dir of [path.join(SRC, "pi/model"), path.join(SRC, "relay")]) {
      for (const file of walk(dir, isCode)) {
        const src = stripComments(fs.readFileSync(file, "utf8"))
        assert.doesNotMatch(src, /className/, `${rel(file)} 含 className，不能作为变体共享逻辑`)
        assert.doesNotMatch(src, /from\s+"@\/components\/(pi|kit)\//, `${rel(file)} import 了 cursor UI 组件`)
      }
    }
  })

  test("cursor 回归：pi-theme.css 的根几何规则仍在（headless 的行内值只是同值覆盖，原有 CSS 兜底不变）", () => {
    const css = stripComments(read("ui/src/components/pi/shared/pi-theme.css"))
    assert.match(css, /\[data-pi-root\]\[data-pi-mode="product"\] \{\s*position: fixed;/)
    assert.match(css, /height: 100vh;/)
    assert.match(css, /@supports \(height: 100dvh\)/)
  })
})

/* ------------------------------------------------------------------ 审计扫描（结构件，供 v2 清单与 independence 组）

  扫描口径与 allowlist.ts 完全一致：import 用 piVariantImportVerdict 判定；token / cursor 标识符 / 全局选择器用常量表。 */

const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx", ".css"]
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec)
  for (const ext of EXTS) {
    const f = base + ext
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f
  }
  return null
}
/** 变体契约类型文件（@/pi/variants/types 的等价相对写法 ../types 也算允许） */
const VARIANT_CONTRACT_TYPES = path.join(VARIANTS, "types.ts")
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(type\s+)?([^"'`;]*?)\s*from\s*["']([^"']+)["']|(?:^|[\s;])import\s*\(\s*["']([^"']+)["']\s*\)/g

/** `import type {...}` 或 `import { type A, type B }`（全部命名都是 type）都算只取类型 */
function isTypeOnlyImport(typeToken, clause) {
  if (typeToken) return true
  const brace = clause.match(/\{([\s\S]*)\}/)
  if (!brace) return false
  const names = brace[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return names.length > 0 && names.every((n) => /^type\s+[\w$]+/.test(n))
}

/** 抽 CSS 选择器（递归进 @media/@supports；@keyframes 等规则体不是选择器，跳过） */
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
      else if (!prelude.startsWith("@")) out.push(...prelude.split(",").map((x) => x.trim()).filter(Boolean))
      i = j
    }
  }
  walkRules(css)
  return out
}

/** 提取 className / cx() / cn() 表达式里的 class token（「完全自写样式」口径：只有这些上下文里的 token 算类名） */
function classNameTokensOf(src) {
  const tokens = new Set()
  /** 从 openIndex（指向 { 或 (）起扫平衡括号，返回 [expr, nextIndex]（字符串/模板内容不参与配对） */
  const scanBalanced = (openIndex) => {
    const open = src[openIndex]
    const close = open === "{" ? "}" : ")"
    let depth = 0
    let i = openIndex
    let inString = null
    while (i < src.length) {
      const ch = src[i]
      if (inString) {
        if (ch === "\\") i += 1
        else if (ch === inString) inString = null
      } else if (ch === '"' || ch === "'" || ch === "`") inString = ch
      else if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) return [src.slice(openIndex + 1, i), i + 1]
      }
      i += 1
    }
    return [src.slice(openIndex + 1), src.length]
  }
  const collect = (expr) => {
    for (const lit of expr.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
      const text = (lit[1] ?? lit[2] ?? lit[3] ?? "").replace(/\$\{[^}]*\}/g, " ")
      for (const token of text.split(/\s+/).filter(Boolean)) {
        // 模板静态片段（`claude-btn-${kind}` 的 claude-btn-）也按自有前缀归类，不当作完整 token 命中的 class 违规
        tokens.add(token)
      }
    }
  }
  // className="..." / className={`...`} / className={cx(...)}
  for (const m of src.matchAll(/className\s*=\s*/g)) {
    let i = m.index + m[0].length
    const ch = src[i]
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = src.indexOf(ch, i + 1)
      if (end > i) collect(src.slice(i, end + 1))
    } else if (ch === "{") {
      const [expr, next] = scanBalanced(i)
      collect(expr)
      i = next
    }
  }
  // cx(...) / cn(...) / clsx(...) / classNames(...) 调用（变体自己的 class 组合器）
  for (const m of src.matchAll(/\b(?:cx|cn|clsx|classNames)\s*\(/g)) {
    const open = src.indexOf("(", m.index)
    if (open < 0) continue
    const [expr] = scanBalanced(open)
    collect(expr)
  }
  return [...tokens]
}

/** side-effect import（`import "./x.css"` / `import "@fontsource-variable/inter"`）：不带 from 的 import */
const SIDE_EFFECT_IMPORT_RE = /(?:^|[\s;])import\s*["']([^"']+)["']/g
/** CSS 里的 @import（字符串或 url(...) 两种写法） */
const CSS_AT_IMPORT_RE = /@import\s+(?:url\(\s*)?["']?([^"'\s)]+)["']?\s*\)?/g

/** 变体 CSS 选择器是否挂在该变体作用域：`[data-pi-ui="<id>"]` 前缀或深色祖先写法 */
function isScopedSelector(selector, id) {
  return (
    selector.startsWith(`[data-pi-ui="${id}"]`) ||
    selector.startsWith(`:root[data-pi-theme="dark"] [data-pi-ui="${id}"]`) ||
    selector.startsWith(`:root[data-pi-theme="light"] [data-pi-ui="${id}"]`)
  )
}

function auditVariant(id) {
  const dir = path.join(VARIANTS, id)
  const out = { id, dir, imports: [], tokens: [], cursorNames: [], dom: [], classes: [], cssImports: [], storage: [], requires: [], cssScope: [], globals: [], headless: [], files: 0 }
  for (const file of walk(dir, isCode)) {
    out.files += 1
    const raw = fs.readFileSync(file, "utf8")
    const src = stripComments(raw)
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[3] ?? m[4]
      if (!spec) continue
      const typeOnly = isTypeOnlyImport(m[1], m[2] ?? "")
      let ownDir = false
      if (spec.startsWith(".")) {
        const target = resolveRelative(file, spec)
        if (target && (target.startsWith(dir + path.sep) || target === VARIANT_CONTRACT_TYPES)) ownDir = true
      }
      const verdict = piVariantImportVerdict(spec, { typeOnly, ownDir })
      if (!verdict.ok) out.imports.push({ file: rel(file), spec, reason: verdict.reason, typeOnly })
    }
    for (const token of PI_VARIANT_FORBIDDEN_TOKENS) if (src.includes(token)) out.tokens.push({ file: rel(file), token })
    for (const name of PI_VARIANT_CURSOR_COMPONENT_NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(src)) out.cursorNames.push({ file: rel(file), name })
    }
    // DOM 归因（静态）：只允许 data-pi-ui / data-pi-ui-part / data-<id>-*；cursor 结构标记 / data-slot="pi-…" 一律违规
    for (const marker of PI_VARIANT_FORBIDDEN_DOM_MARKERS) {
      if (src.includes(marker)) out.dom.push({ file: rel(file), marker })
    }
    for (const prefix of PI_VARIANT_FORBIDDEN_CLASS_PREFIXES) {
      if (src.includes(prefix)) out.dom.push({ file: rel(file), marker: prefix })
    }
    // 变体不直接读写浏览器存储（偏好 / 状态只经入口传下来的 act / props）
    for (const api of PI_VARIANT_FORBIDDEN_STORAGE_APIS) {
      if (new RegExp(`\\b${api}\\b`).test(src)) out.storage.push({ file: rel(file), api })
    }
    if (/\brequire\(/.test(src)) out.requires.push({ file: rel(file) })
    // side-effect import（CSS / 字体入口）：只允许「变体自己目录内的相对路径」+ 白名单第三方字体样式
    for (const match of src.matchAll(SIDE_EFFECT_IMPORT_RE)) {
      const spec = match[1]
      let ownDir = false
      if (spec.startsWith(".")) {
        const target = resolveRelative(file, spec)
        if (target && target.startsWith(dir + path.sep)) ownDir = true
      }
      const verdict = variantCssImportVerdict(spec, ownDir)
      if (!verdict.ok) out.imports.push({ file: rel(file), spec, reason: verdict.reason, typeOnly: false })
    }
    // className / cx() / cn() 里的 cursor 类名前缀与 Tailwind 工具类注入（完全自写样式口径）
    for (const token of classNameTokensOf(src)) {
      const verdict = classifyVariantClassToken(token, id)
      if (verdict === "cursor-prefix") out.classes.push({ file: rel(file), token, kind: "cursor-class-prefix" })
      else if (verdict === "tailwind-utility") out.classes.push({ file: rel(file), token, kind: "tailwind-utility" })
    }
    // 入口必须走 headless 根（v2 验收）；v1 用 cursor PiRoot，会命中
    if (rel(file) === PI_VARIANT_ENTRIES[id]) {
      const usesHeadless = /@\/pi\/headless/.test(src) && /PiHeadlessRoot/.test(src)
      const rootMarker = new RegExp(`ui="${id}"`).test(src) || new RegExp(`data-pi-ui="${id}"`).test(src)
      if (!usesHeadless) out.headless.push({ file: rel(file), reason: "入口没有 import @/pi/headless 的 PiHeadlessRoot" })
      if (!rootMarker) out.headless.push({ file: rel(file), reason: `入口根节点没有 ui="${id}" / data-pi-ui="${id}" 标记` })
    }
  }
  for (const file of walk(dir, isCss)) {
    const raw = fs.readFileSync(file, "utf8")
    const css = stripComments(raw)
    for (const token of PI_VARIANT_FORBIDDEN_TOKENS) if (css.includes(token)) out.tokens.push({ file: rel(file), token })
    // CSS @import：只允许相对变体自己目录内的样式（禁止 @import cursor CSS / 绝对路径 / 网络样式）
    for (const match of css.matchAll(CSS_AT_IMPORT_RE)) {
      const spec = match[1]
      let ownDir = false
      if (spec.startsWith(".")) {
        const target = resolveRelative(file, spec)
        if (target && target.startsWith(dir + path.sep)) ownDir = true
      }
      const verdict = variantCssImportVerdict(spec, ownDir)
      if (!verdict.ok) out.cssImports.push({ file: rel(file), spec, reason: verdict.reason })
    }
    const selectors = cssSelectors(css)
    const unscoped = selectors.filter((selector) => !isScopedSelector(selector, id))
    if (unscoped.length) out.cssScope.push({ file: rel(file), selectors: unscoped.slice(0, 10), count: unscoped.length })
    for (const sel of PI_VARIANT_FORBIDDEN_GLOBAL_SELECTORS) {
      // 只把「没挂在变体作用域下、且以全局选择器开头」的当违规；深色祖先写法 `:root[data-pi-theme=…] [data-pi-ui=…]` 合法
      if (selectors.some((selector) => !isScopedSelector(selector, id) && new RegExp(`^${sel === "*" ? "\\*" : sel}(?:\\s|\\[|\\.|#|:|$)`).test(selector))) {
        out.globals.push({ file: rel(file), selector: sel })
      }
    }
  }
  out.violations =
    out.imports.length +
    out.tokens.length +
    out.cursorNames.length +
    out.dom.length +
    out.classes.length +
    out.cssImports.length +
    out.storage.length +
    out.requires.length +
    out.cssScope.length +
    out.headless.length
  return out
}

const AUDIT = Object.fromEntries(PI_UI_INDEPENDENCE_VARIANTS.map((id) => [id, auditVariant(id)]))
const totalViolations = (key) => PI_UI_INDEPENDENCE_VARIANTS.reduce((n, id) => n + AUDIT[id][key].length, 0)
const summary = () =>
  PI_UI_INDEPENDENCE_VARIANTS.map(
    (id) =>
      `${id}: imports ${AUDIT[id].imports.length} / --cw- ${AUDIT[id].tokens.length} / cursor 标识符 ${AUDIT[id].cursorNames.length} / DOM 标记 ${AUDIT[id].dom.length} / 类名注入 ${AUDIT[id].classes.length} / CSS@import ${AUDIT[id].cssImports.length} / 存储 ${AUDIT[id].storage.length} / require ${AUDIT[id].requires.length} / CSS 作用域 ${AUDIT[id].cssScope.length} / 未走 headless ${AUDIT[id].headless.length}`,
  ).join("；")

describe("变体独立性审计快照（structure，立即全绿；数字供 v2 清单核对）", () => {
  test("当前两线违规统计（v1 基线；v2 归零后 independence 组自动启用）", () => {
    // 这是报告型用例：只断言扫描结果结构完整，数字写进测试输出 + progress 文档；
    // 真正「必须为 0」的断言在下面 independence 组（违规清零后自动从 skip 转为运行）。
    for (const id of PI_UI_INDEPENDENCE_VARIANTS) {
      const a = AUDIT[id]
      assert.ok(a.files > 0, `${id} 变体目录没有源码`)
      assert.equal(
        a.violations,
        a.imports.length + a.tokens.length + a.cursorNames.length + a.dom.length + a.classes.length + a.cssImports.length + a.storage.length + a.requires.length + a.cssScope.length + a.headless.length,
      )
    }
    console.log(`[pi-ui-independence] 违规快照：${summary()}；总计 ${PI_UI_INDEPENDENCE_VARIANTS.reduce((n, id) => n + AUDIT[id].violations, 0)} 处`)
    // v2 修复清单（按文件）：这些就是两线要清掉的具体位置
    for (const id of PI_UI_INDEPENDENCE_VARIANTS) {
      const a = AUDIT[id]
      const byFile = {}
      for (const v of a.imports) byFile[v.file] = (byFile[v.file] ?? 0) + 1
      const rows = Object.entries(byFile).sort((x, y) => y[1] - x[1]).map(([f, n]) => `${f}(${n})`)
      console.log(`[pi-ui-independence] ${id} 禁止 import 按文件：${rows.join("、") || "无"}`)
      console.log(`[pi-ui-independence] ${id} --cw- 文件：${a.tokens.map((v) => v.file).join("、") || "无"}`)
      console.log(`[pi-ui-independence] ${id} cursor 标识符：${a.cursorNames.map((v) => `${v.file}:${v.name}`).join("、") || "无"}`)
      if (a.dom.length) console.log(`[pi-ui-independence] ${id} DOM 标记：${a.dom.map((v) => `${v.file}:${v.marker}`).join("、")}`)
      if (a.classes.length) console.log(`[pi-ui-independence] ${id} 类名注入：${a.classes.map((v) => `${v.file}:${v.token}(${v.kind})`).join("、")}`)
      if (a.cssImports.length) console.log(`[pi-ui-independence] ${id} CSS@import：${a.cssImports.map((v) => `${v.file}:${v.spec}`).join("、")}`)
      if (a.storage.length) console.log(`[pi-ui-independence] ${id} 直接存储：${a.storage.map((v) => `${v.file}:${v.api}`).join("、")}`)
      if (a.cssScope.length) console.log(`[pi-ui-independence] ${id} CSS 未作用域：${a.cssScope.map((v) => `${v.file}(${v.count})`).join("、")}`)
    }
  })
})

/* ------------------------------------------------------------------ independence：硬断言（0 容忍；v2 完成后必须真绿）

   Lead 要求（final 集成）：不再按违规数 skip，违规 = 测试失败，失败信息带按文件清单。
   浏览器 DOM 归因（渲染结果里不能有 cursor 结构/类名）不在本文件跑，见 开发工具（未随公开仓提供）（P3 脚本）。 */

const failuresOf = (key, format) => PI_UI_INDEPENDENCE_VARIANTS.flatMap((id) => AUDIT[id][key].map((v) => `${id}: ${format(v)}`))

describe("变体独立性守卫（independence，硬断言：0 容忍，不允许 skip）", () => {
  test("禁止 import：0 处 cursor UI / kit / 容器值 import / 非白名单 hook / 越界相对 import", () => {
    assert.deepEqual(failuresOf("imports", (v) => `${v.file} → ${v.spec}（${v.reason}）`), [])
  })

  test("禁止 cursor 样式 token：源码 / CSS 注释外 0 处 --cw-*", () => {
    assert.deepEqual(failuresOf("tokens", (v) => `${v.file} 含 ${v.token}`), [])
  })

  test("禁止 cursor 组件标识符：0 处 PiRoot / PiSidebar / PiLayerProvider 等引用", () => {
    assert.deepEqual(failuresOf("cursorNames", (v) => `${v.file} 引用 ${v.name}`), [])
  })

  test("DOM 归因（静态）：0 处 cursor 结构标记 / data-slot=\"pi-…\"（只允许 data-pi-ui、data-pi-ui-part、data-<id>-*）", () => {
    assert.deepEqual(failuresOf("dom", (v) => `${v.file} 输出 ${v.marker}`), [])
  })

  test("禁止 cursor 类名 / Tailwind 工具类注入：className(cx/cn) 只用变体自有 class（白名单仅 sr-only）", () => {
    assert.deepEqual(failuresOf("classes", (v) => `${v.file} 类名 ${v.token}（${v.kind}）`), [])
  })

  test("CSS 样式入口：@import 只允许变体自己目录内的相对样式（禁止 import cursor CSS / 绝对路径 / 网络样式）", () => {
    assert.deepEqual(failuresOf("cssImports", (v) => `${v.file} @import ${v.spec}（${v.reason}）`), [])
  })

  test("side-effect CSS import 只允许自己的目录（`@/components/pi/**` 的 CSS / 越界相对 CSS 在 import 检查里拦）", () => {
    // side-effect import 复用 imports 类别（scanner 已把不合规的 side-effect import 记进 imports）
    assert.deepEqual(failuresOf("imports", (v) => `${v.file} → ${v.spec}（${v.reason}）`), [])
  })

  test("变体不直接读写 localStorage / sessionStorage / indexedDB（偏好只经 act / props）", () => {
    assert.deepEqual(failuresOf("storage", (v) => `${v.file} 用了 ${v.api}`), [])
  })

  test("变体源码 0 处 require()（ESM 产物，动态 import 走静态扫描）", () => {
    assert.deepEqual(failuresOf("requires", (v) => `${v.file} 使用了 require()`), [])
  })

  test("变体 CSS 作用域：每条选择器都以 [data-pi-ui=\"<id>\"]（或深色祖先形式）开头，无全局选择器", () => {
    assert.deepEqual(failuresOf("cssScope", (v) => `${v.file} 有 ${v.count} 条未作用域选择器：${v.selectors.join(" ; ")}`), [])
    assert.deepEqual(failuresOf("globals", (v) => `${v.file} 有全局选择器 ${v.selector}`), [])
  })

  test("每个变体自己的根：入口 import @/pi/headless 的 PiHeadlessRoot，根节点 data-pi-ui 正确", () => {
    assert.deepEqual(failuresOf("headless", (v) => `${v.file}：${v.reason}`), [])
  })

  test("汇总：两线独立性违规合计 = 0（一次性输出完整清单，便于定位）", () => {
    const all = PI_UI_INDEPENDENCE_VARIANTS.flatMap((id) => {
      const a = AUDIT[id]
      return [
        ...a.imports.map((v) => `${id}: import ${v.file} → ${v.spec}`),
        ...a.tokens.map((v) => `${id}: token ${v.file}`),
        ...a.cursorNames.map((v) => `${id}: 标识符 ${v.file}:${v.name}`),
        ...a.dom.map((v) => `${id}: DOM ${v.file}:${v.marker}`),
        ...a.classes.map((v) => `${id}: 类名 ${v.file}:${v.token}(${v.kind})`),
        ...a.cssImports.map((v) => `${id}: CSS@import ${v.file}:${v.spec}`),
        ...a.storage.map((v) => `${id}: 存储 ${v.file}:${v.api}`),
        ...a.requires.map((v) => `${id}: require ${v.file}`),
        ...a.cssScope.map((v) => `${id}: CSS 作用域 ${v.file}(${v.count})`),
        ...a.headless.map((v) => `${id}: headless ${v.file}：${v.reason}`),
      ]
    })
    console.log(`[pi-ui-independence] independence 组审计：${summary()}；违规合计 ${all.length} 处`)
    assert.deepEqual(all, [])
  })
})

/* ------------------------------------------------------------------ structure：类型出口 + 白名单细化（Lead 追加要求 1–2） */

/** `@/x` → ui/src/x 的文件路径（试 .ts/.tsx/index.ts） */
function resolveAliasSource(spec) {
  if (!spec.startsWith("@/")) return null
  const base = path.join(SRC, spec.slice(2))
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const f = base + ext
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f
  }
  return null
}
const IDENT_DECL = (name) => new RegExp(`(?:export\\s+)?(?:type|interface|const|function|class|enum)\\s+${name}\\b`)

describe("公共类型出口 headless/types.ts（structure，立即全绿；checklist D3）", () => {
  const TYPES = path.join(HEADLESS, "types.ts")
  const src = fs.readFileSync(TYPES, "utf8")
  const stripped = stripComments(src)

  test("只 re-export 类型：每条 export 都是 `export type { … } from`，没有值导出 / 运行时 import", () => {
    assert.ok(fs.existsSync(TYPES), "缺 ui/src/pi/headless/types.ts")
    const codes = stripped.split("\n").filter((line) => /^\s*(import|export)\b/.test(line))
    for (const line of codes) {
      assert.match(line, /^\s*export type \{/, `headless/types.ts 只能有 export type：${line}`)
    }
    assert.doesNotMatch(stripped, /^\s*import\b/m, "headless/types.ts 不应有运行时 import")
    assert.doesNotMatch(stripped, /export \{[^}]*\b(?:const|function|class)\b/, "不能转发值")
  })

  test("类型源模块都在 allowlist 的 PI_VARIANT_TYPE_EXPORT_SOURCES 里，且能被解析", () => {
    const sources = [...stripped.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])
    assert.ok(sources.length > 0)
    for (const spec of sources) {
      assert.ok(PI_VARIANT_TYPE_EXPORT_SOURCES.includes(spec), `类型源未登记：${spec}`)
      assert.ok(resolveAliasSource(spec), `类型源模块不存在：${spec}`)
    }
  })

  test("re-export 的每个类型名都在源模块里有定义（D3 验收：PiItem / PiTopLine / PiDialogCardView / Relay…）", () => {
    const missing = []
    for (const block of stripped.matchAll(/export type \{([\s\S]*?)\} from "([^"]+)"/g)) {
      const names = block[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
      const file = resolveAliasSource(block[2])
      if (!file) continue
      const text = fs.readFileSync(file, "utf8")
      for (const name of names) if (!IDENT_DECL(name).test(text) && !text.includes(`type ${name} `)) missing.push(`${block[2]} → ${name}`)
    }
    assert.deepEqual(missing, [])
    for (const name of ["PiItem", "PiTopLine", "PiDialogCardView", "Relay", "PiAppProps"]) assert.ok(stripped.includes(name), `缺类型出口 ${name}`)
  })

  test("变体可以从 @/pi/headless 取类型（verdict 放行），但仍不能直接 import 源 cursor 模块", () => {
    for (const spec of ["@/pi/headless", "@/pi/headless/types"]) assert.equal(piVariantImportVerdict(spec, { typeOnly: true }).ok, true, spec)
    assert.equal(piVariantImportVerdict("@/components/pi/shared/types", { typeOnly: true }).ok, false, "cursor 类型模块仍禁止直接 import（只经 headless）")
    assert.equal(piVariantImportVerdict("@/pi/containers/types", { typeOnly: true }).ok, true, "containers/types 的 import type 例外仍保留")
  })
})

describe("白名单细化 + 重逻辑裁决（structure，立即全绿；Lead 追加要求 2）", () => {
  test("pi/model 白名单：每个模块都存在、在 model 目录里、审计为纯函数", () => {
    const cleanModel = new Set(walk(path.join(SRC, "pi/model"), isCode).map((p) => rel(p)))
    assert.equal(PI_VARIANT_ALLOWED_MODEL_MODULES.length, cleanModel.size, "model 白名单应覆盖全部 model 模块（审计结论：全部无样式纯函数）")
    for (const spec of PI_VARIANT_ALLOWED_MODEL_MODULES) {
      const file = resolveAliasSource(spec)
      assert.ok(file, `白名单 model 模块不存在：${spec}`)
      assert.ok(cleanModel.has(rel(file)), `白名单 model 模块不在 pi/model 目录：${spec}`)
    }
  })

  test("relay 白名单：每个模块都存在，且 audit 无 cursor UI 依赖（relay 是数据层，可整目录复用）", () => {
    for (const spec of PI_VARIANT_ALLOWED_RELAY_MODULES) {
      const file = resolveAliasSource(spec)
      assert.ok(file, `白名单 relay 模块不存在：${spec}`)
      const text = stripComments(fs.readFileSync(file, "utf8"))
      assert.doesNotMatch(text, /from\s+"@\/components\/(pi|kit)\//, `${spec} import 了 cursor UI`)
      assert.doesNotMatch(text, /className/, `${spec} 含 className（不是纯逻辑）`)
    }
  })

  test("hook 白名单细化：每个 hook 的导出名都在模块里（纯行为、无样式）", () => {
    for (const [spec, exports] of Object.entries(PI_VARIANT_ALLOWED_HOOK_EXPORTS)) {
      const file = path.join(SRC, `${spec.replace("@/", "")}.ts`)
      assert.ok(fs.existsSync(file), `hook 不存在：${spec}`)
      const text = fs.readFileSync(file, "utf8")
      for (const name of exports) assert.ok(IDENT_DECL(name).test(text), `${spec} 缺导出 ${name}`)
    }
    assert.deepEqual(Object.keys(PI_VARIANT_ALLOWED_HOOK_EXPORTS).sort(), [...PI_VARIANT_ALLOWED_HOOKS].sort(), "hook 白名单与导出表要一致")
  })

  test("third-party 清单含框架/解析渲染库；不引 cursor 样式类库", () => {
    for (const pkg of ["react", "react-dom", "react-markdown", "remark-gfm", "shiki"]) assert.ok(PI_VARIANT_ALLOWED_THIRD_PARTY.includes(pkg), `第三方清单缺 ${pkg}`)
    for (const spec of PI_VARIANT_ALLOWED_THIRD_PARTY) assert.ok(!spec.startsWith("@/") && !spec.startsWith("."), `${spec} 不是裸包名`)
    // 裸包 import 默认放行（由 verdict 保证），但样式类库约定不在此清单里
    for (const spec of PI_VARIANT_ALLOWED_THIRD_PARTY) assert.equal(piVariantImportVerdict(spec).ok, true, `${spec} 应放行`)
  })

  test("重逻辑裁决：@/chat、@/shell、@/components/ui 的纯逻辑禁止直接 import，允许移植进 variants/<id>/，并预留 headless/logic 上移路径", () => {
    assert.ok(PI_VARIANT_PORTING_REQUIRED.length >= 8, "移植清单要覆盖 slash / mention / terminal / streaming-markdown / 状态机等重逻辑")
    for (const item of PI_VARIANT_PORTING_REQUIRED) {
      assert.ok(item.module && item.use, `移植清单项缺 module/use：${JSON.stringify(item)}`)
      // 原件存在（存在即证明「可移植」；不存在说明清单过期）
      assert.ok(resolveAliasSource(item.module), `移植清单里的原件不存在：${item.module}`)
      // 守卫：变体 import 原件 = 违规；移植副本放 variants/<id>/model/ported/ 内则合法（相对 import / ownDir）
      assert.equal(piVariantImportVerdict(item.module).ok, false, `${item.module} 必须禁止直接 import`)
    }
    // 流式 markdown / 终端 / 斜杠 都必须在清单里
    for (const needle of ["streaming-markdown-core", "terminalModel", "slashParse", "mention"]) {
      assert.ok(PI_VARIANT_PORTING_REQUIRED.some((i) => i.module.includes(needle)), `移植清单缺 ${needle}`)
    }
    // 预留 headless/logic：未来两线共用实现的上移路径，现在 import 即合法（没人写也不会报错）
    assert.ok(PI_VARIANT_HEADLESS_LOGIC_PREFIX.startsWith("@/pi/headless"))
    assert.equal(piVariantImportVerdict(`${PI_VARIANT_HEADLESS_LOGIC_PREFIX}slashParse`).ok, true)
    assert.ok(PI_VARIANT_HEADLESS_LOGIC_CANDIDATES.includes("streaming-markdown-core"))
  })

  test("移植裁决落地：移植目标目录约定存在（variants/<id>/model/ported/ 的相对 import 由 ownDir 放行）", () => {
    for (const id of PI_UI_INDEPENDENCE_VARIANTS) {
      assert.ok(fs.existsSync(path.join(VARIANTS, id, "model")), `${id} 变体缺 model/ 目录（移植目标）`)
      // 模拟：变体里 import "./model/ported/terminalModel" → ownDir 放行
      assert.equal(piVariantImportVerdict("./model/ported/terminalModel", { ownDir: true }).ok, true)
      // 越出目录/直接引原件 → 拒绝
      assert.equal(piVariantImportVerdict("../codex/CodexApp").ok, false)
      assert.equal(piVariantImportVerdict("@/chat/capsules/terminalModel").ok, false)
    }
  })
})


/* ------------------------------------------------------------------ structure：CI 加固自测（终审 3 条绕过；立即全绿） */

describe("CI 加固自测：cursor 类名 / Tailwind 工具类 / CSS 样式入口（structure，立即全绿）", () => {
  test("classifyVariantClassToken：自有 / 白名单 / cursor 前缀 / Tailwind 工具类 / 中立修饰词 各自的归类", () => {
    // 自有
    assert.equal(classifyVariantClassToken("claude-row", "claude"), "own")
    assert.equal(classifyVariantClassToken("claude-btn-primary", "claude"), "own")
    assert.equal(classifyVariantClassToken("cx-row", "codex"), "own")
    assert.equal(classifyVariantClassToken("cx-approval-card", "codex"), "own")
    // 白名单通用类
    for (const okToken of PI_VARIANT_ALLOWED_UTILITY_CLASSES) assert.equal(classifyVariantClassToken(okToken, "claude"), "allowed-utility", okToken)
    // cursor 组件类名前缀（cw- / pi-）
    for (const bad of ["cw-btn", "cw-titlebar-bg", "pi-sidebar", "pi-composer-dock"]) assert.equal(classifyVariantClassToken(bad, "claude"), "cursor-prefix", bad)
    for (const prefix of PI_VARIANT_CURSOR_CLASS_PREFIXES) assert.ok(prefix === "cw-" || prefix === "pi-")
    // Tailwind 工具类注入（含任意值 / 变体前缀）
    for (const tw of ["flex", "items-center", "p-2", "text-sm", "bg-(--cw-bg)", "after:absolute", "hover:bg-x", "rounded-(--x)", "-mt-2", "group-hover:flex", "sr-only"]) {
      if (tw === "sr-only") continue // 白名单单独断言
      assert.equal(classifyVariantClassToken(tw, "claude"), "tailwind-utility", tw)
      assert.equal(isTailwindUtilityClass(tw), true, tw)
    }
    // 中立：变体自己的状态修饰词 / 模板静态片段，不算违规
    // 中立：变体自己的状态修饰词；模板静态片段（`claude-btn-${kind}` 的 claude-btn-）属于自有前缀
    for (const okToken of ["completed", "primary", "denied"]) assert.equal(classifyVariantClassToken(okToken, "claude"), "neutral", okToken)
    for (const ownToken of ["claude-btn-", "cx-row-"]) assert.equal(classifyVariantClassToken(ownToken, ownToken.startsWith("cx-") ? "codex" : "claude"), "own", ownToken)
    // 自有前缀映射
    assert.equal(PI_VARIANT_OWN_CLASS_PREFIX.claude, "claude-")
    assert.equal(PI_VARIANT_OWN_CLASS_PREFIX.codex, "cx-")
  })

  test("variantCssImportVerdict：自目录相对样式 / @fontsource 字体包放行；cursor alias / 绝对路径 / 网络样式拒绝", () => {
    // 允许
    assert.equal(variantCssImportVerdict("./styles/tokens.css", true).ok, true)
    assert.equal(variantCssImportVerdict("./styles/dark.css", true).ok, true)
    assert.equal(variantCssImportVerdict("@fontsource-variable/inter", false).ok, true)
    assert.equal(variantCssImportVerdict("@fontsource/jetbrains-mono/400.css", false).ok, true)
    // 拒绝（side-effect CSS / @import 共用同一判定）
    for (const spec of ["@/components/pi/shared/pi-theme.css", "@/components/kit/x.css", "../cursor.css", "../../styles/tokens.css", "/abs/x.css", "https://cdn/x.css"]) {
      const verdict = variantCssImportVerdict(spec, false)
      assert.equal(verdict.ok, false, spec)
      assert.match(verdict.reason, /样式只能相对 import|第三方样式入口/, spec)
    }
    // 变异：越界相对样式即使外部文件存在也不放行（ownDir=false）
    assert.equal(variantCssImportVerdict("./styles/tokens.css", false).ok, false)
  })

  test("scanner 已经接上这两条规则（源码交叉检查，防规则漂移）", () => {
    const src = fs.readFileSync(new URL("./pi-ui-independence.test.mjs", import.meta.url), "utf8")
    // 本文件自身：scanner 里出现 side-effect import 扫描、CSS @import 扫描、className token 扫描三个调用点
    for (const needle of ["SIDE_EFFECT_IMPORT_RE", "CSS_AT_IMPORT_RE", "classNameTokensOf(src)", "out.classes.push", "out.cssImports.push"]) {
      assert.ok(src.includes(needle), `守卫 scanner 缺 ${needle}`)
    }
  })
})
