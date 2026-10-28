// P3.3 结构检查（实施计划 §4.4「新增」、§8.4）：静态读 ui/src 的源码，不加载 tsx。
// 1. 开发画廊（ui/src/pi/dev/**）只能在 pi/dev 里面被 import；部件和产品目录里不出现 "pi/dev/" 和 "MOCK_"（P3.3 的 grep 口径）。
// 2. TSX 里的字面色值只许减少（design §9.3「组件不写色值」）：P3 时的存量列成白名单，按文件计数，新文件为 0。
// 3. 产品目录里没有 --cw-ch5- 引用（D5：MarketplaceNav、FileBreadcrumbs 的章节变量不进产品；注释不算）。
// 4. kit 不导出 Cursor 专有件：index.ts 的出口都指向搬进来的文件，不含没搬的件，也没有 *.catalog.tsx。
// 5. PiSidebar 的搜索行没有 kbd="⌘K"（⌘K 只开命令面板，design §10，D-01）。
// 6. pi-theme.css 有 --cw-pi-lightbox-bg、--cw-pi-focus-ring、:focus-visible、prefers-reduced-motion（design §12.2 a 行）。
// 7. P5 整合（R2/lane-requests/p5-b.md 第 3 条，编排会话定为 blocker）：ui/src/pi/**、ui/src/components/pi/** 不 import 旧界面的 .tsx
//    （@/chat/*.tsx 等）、不 import @/style/*、不 import 新界面以外的 .css；从 index.html（P7 B1 前是 next.html）和 gallery.html 的入口顺着 import 走，
//    能到达的 .css 只有新界面自己的（旧界面的 composer.css 有全局 :focus-visible { outline: none !important }，会让 Pi 的焦点环失效，design §4.7）。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SRC = path.join(ROOT, "ui/src")
const DEV = path.join(SRC, "pi/dev")
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/")

function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}
const isCode = (p) => /\.(ts|tsx)$/.test(p)
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
const inDev = (p) => p === DEV || p.startsWith(DEV + path.sep)

/** 产品目录：kit、Pi 部件、新入口（不含开发画廊） */
const PRODUCT_DIRS = ["components/kit", "components/pi", "pi"].map((d) => path.join(SRC, d))
const productFiles = (pred) => PRODUCT_DIRS.flatMap((d) => walk(d, pred)).filter((p) => !inDev(p))

/* ---------- 7：import 图（静态 + 动态 import、export … from；import type 不算，编译后不存在） ---------- */
const NEW_UI_ROOTS = ["pi", "components/pi"].map((d) => path.join(SRC, d))
const NEW_UI_DIRS = ["pi", "components/pi", "components/kit", "lib"].map((d) => path.join(SRC, d))
const isNewUi = (p) => NEW_UI_DIRS.some((d) => p.startsWith(d + path.sep))
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?!type\b)(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
const EXTS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]
function resolveImport(from, spec) {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null
  if (!base) return null
  for (const ext of EXTS) {
    const f = base + ext
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f
  }
  return null
}
function importsOf(file) {
  const src = stripComments(fs.readFileSync(file, "utf8"))
  return [...src.matchAll(IMPORT_RE)].map((m) => {
    const spec = m[1] || m[2]
    return { spec, target: resolveImport(file, spec) }
  })
}
/** 入口能到达的模块（含 .css）→ 它的上一跳 */
function reachable(entry) {
  const parent = new Map([[entry, null]])
  const queue = [entry]
  while (queue.length) {
    const file = queue.shift()
    if (!isCode(file)) continue
    for (const { target } of importsOf(file)) {
      if (target && !parent.has(target)) {
        parent.set(target, file)
        queue.push(target)
      }
    }
  }
  return parent
}

describe("pi structure", () => {
  test("pi/dev 只在 pi/dev 里面被 import", () => {
    const bad = []
    for (const file of walk(SRC, isCode).filter((p) => !inDev(p))) {
      const src = fs.readFileSync(file, "utf8")
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
        const spec = m[1]
        const target = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(file), spec) : null
        if (target && inDev(target)) bad.push(`${rel(file)} → ${spec}`)
      }
    }
    assert.deepEqual(bad, [])
  })

  test('部件和产品目录里不出现 "pi/dev/" 和 "MOCK_"（P3.3 验证的 grep）', () => {
    const bad = productFiles(isCode).filter((p) => /pi\/dev\/|MOCK_/.test(fs.readFileSync(p, "utf8")))
    assert.deepEqual(bad.map(rel), [])
  })

  test("开发画廊的 mock 和外框不在部件目录里", () => {
    const pi = path.join(SRC, "components/pi")
    const left = walk(pi, (p) => /(^|\/)(mock[A-Za-z]*\.ts|[ABC]Frames\.tsx|AConversation\.tsx)$/.test(rel(p)))
    assert.deepEqual(left.map(rel), [])
  })

  test("TSX 字面色值只许减少（P3 存量白名单）", () => {
    /** P3.3（2026-10-24）统计的存量：文件 → 个数。改少了就把这里一起改小 */
    const ALLOW = {
      "components/kit/stream/ChatColumn.tsx": 1, // 底部渐隐的遮罩 rgb(0 0 0 / 0.15)（只管透明度）
      "components/pi/conversation/PiApprovalCard.tsx": 2,
      "components/pi/conversation/PiLightbox.tsx": 2, // 灯箱文字不跟主题（design §2 D15）
      "components/pi/shared/PiSidebar.tsx": 1, // 深色下出错标记"!"的字色 #161617（design §4.7）
    }
    const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g
    const over = []
    for (const file of productFiles((p) => p.endsWith(".tsx"))) {
      const key = path.relative(SRC, file).split(path.sep).join("/")
      const n = (stripComments(fs.readFileSync(file, "utf8")).match(COLOR) ?? []).length
      const max = ALLOW[key] ?? 0
      if (n > max) over.push(`${key}: ${n} > ${max}`)
    }
    assert.deepEqual(over, [])
  })

  test("产品目录里没有 --cw-ch5- 引用（注释不算）", () => {
    const dirs = ["components/kit", "components/pi", "pi"].map((d) => path.join(SRC, d))
    const files = dirs.flatMap((d) => walk(d, (p) => /\.(ts|tsx|css)$/.test(p)))
    const bad = files.filter((p) => stripComments(fs.readFileSync(p, "utf8")).includes("--cw-ch5-"))
    assert.deepEqual(bad.map(rel), [])
    assert.equal(fs.existsSync(path.join(SRC, "components/kit/sidebar/category-nav.css")), false, "category-nav.css 应已删除（P3.1 c4）")
  })

  test("kit 只导出搬进来的件，不含 Cursor 专有件", () => {
    const kit = path.join(SRC, "components/kit")
    const index = fs.readFileSync(path.join(kit, "index.ts"), "utf8")
    const targets = [...stripComments(index).matchAll(/from\s+"(\.\/[^"]+)"/g)].map((m) => m[1])
    assert.ok(targets.length > 0)
    const missing = targets.filter((t) => ![".ts", ".tsx"].some((ext) => fs.existsSync(path.join(kit, t + ext))))
    assert.deepEqual(missing, [], "index.ts 的出口都要指向存在的文件")
    // 留在 replica、不搬的件（计划 §4.1「留在 replica、不搬的有 79 个文件」）
    const CURSOR_ONLY = /\b(SplitPaneLayout|Composer|ComposerSelectorRow|RepoPicker|ActionPillRow|SplitButton|ChangesPaneHeader|PrHeader|PrStatusPill|AccountFooter|AgentRow|RowContextMenu|TurnSummary|VideoCard)\b/
    const exported = targets.filter((t) => CURSOR_ONLY.test(path.basename(t)))
    assert.deepEqual(exported, [])
    assert.deepEqual(walk(kit, (p) => p.endsWith(".catalog.tsx")).map(rel), [])
    assert.equal(fs.existsSync(path.join(kit, "stage")), false)
  })

  test('PiSidebar 搜索行没有 kbd="⌘K"', () => {
    const src = fs.readFileSync(path.join(SRC, "components/pi/shared/PiSidebar.tsx"), "utf8")
    assert.doesNotMatch(src, /kbd=\{?["']⌘K["']\}?/)
  })

  test("pi-theme.css 有灯箱底色、焦点环、:focus-visible 和 reduced-motion", () => {
    const css = fs.readFileSync(path.join(SRC, "components/pi/shared/pi-theme.css"), "utf8")
    for (const needle of ["--cw-pi-lightbox-bg", "--cw-pi-focus-ring", ":focus-visible", "prefers-reduced-motion"]) {
      assert.ok(css.includes(needle), `缺 ${needle}`)
    }
  })

  test("新界面目录不 import 旧界面的 .tsx、@/style/* 和别处的 .css", () => {
    const bad = []
    for (const file of NEW_UI_ROOTS.flatMap((d) => walk(d, isCode))) {
      for (const { spec, target } of importsOf(file)) {
        if (!target) continue
        const r = rel(target)
        if (r.startsWith("ui/src/style/")) bad.push(`${rel(file)} → ${spec}（@/style/*）`)
        else if (r.endsWith(".tsx") && !isNewUi(target)) bad.push(`${rel(file)} → ${spec}（旧界面 .tsx）`)
        else if (r.endsWith(".css") && !isNewUi(target)) bad.push(`${rel(file)} → ${spec}（旧界面 .css）`)
      }
    }
    assert.deepEqual(bad, [])
  })

  test("从 index.html / gallery.html 的入口能到达的 .css 只有新界面自己的（没有 composer.css 这类旧界面样式）", () => {
    for (const entry of ["ui/src/pi/main.tsx", "ui/src/pi/dev/main.tsx"]) {
      const parent = reachable(path.join(ROOT, entry))
      const chain = (f) => {
        const out = []
        for (let cur = f; cur; cur = parent.get(cur)) out.unshift(rel(cur))
        return out.join(" → ")
      }
      const css = [...parent.keys()].filter((f) => f.endsWith(".css"))
      assert.ok(css.some((f) => rel(f) === "ui/src/components/pi/shared/pi-theme.css"), `${entry} 走不到 pi-theme.css（解析有问题）`)
      assert.deepEqual(css.filter((f) => !isNewUi(f)).map(chain), [], entry)
    }
  })
})

test("Codex 桌面走 P11 UnifiedSidebar，自写 CodexSidebar/行组件已退场", async () => {
  const fs = await import("node:fs/promises")
  const desktop = await fs.readFile(new URL("../ui/src/pi/variants/codex/shell/CodexDesktop.tsx", import.meta.url), "utf8")
  const adapter = await fs.readFile(new URL("../ui/src/pi/variants/codex/sidebar/CodexUnifiedSidebar.tsx", import.meta.url), "utf8")
  assert.equal(desktop.includes("<CodexUnifiedSidebar"), true, "CodexDesktop 只渲染统一侧栏适配")
  assert.equal(/import .*CodexSidebar"/.test(desktop), false, "CodexDesktop 不得再 import 旧 CodexSidebar")
  assert.equal(adapter.includes("UnifiedSidebar"), true, "适配层使用共享 UnifiedSidebar")
  const dir = new URL("../ui/src/pi/variants/codex/sidebar/", import.meta.url)
  for (const dead of ["CodexSidebar.tsx", "CodexPinnedSection.tsx", "CodexProjectGroup.tsx", "CodexThreadRow.tsx"]) {
    await assert.rejects(fs.access(new URL(dead, dir)), `${dead} 应已删除（死代码）`)
  }
  await assert.rejects(fs.access(new URL("../ui/src/pi/variants/codex/phone/CodexPhoneList.tsx", import.meta.url)), "CodexPhoneList.tsx 应已删除")
})

test("Codex 产品标题栏无 macOS 假窗口三色点（移除 cx-dots/WindowDots）", async () => {
  const fs = await import("node:fs/promises")
  const titlebar = await fs.readFile(new URL("../ui/src/pi/variants/codex/chrome/CodexTitleBar.tsx", import.meta.url), "utf8")
  const css = await fs.readFile(new URL("../ui/src/pi/variants/codex/styles/codex.css", import.meta.url), "utf8")
  for (const marker of ["WindowDots", "cx-dots", "cx-dot-close", "cx-dot-min", "cx-dot-max"]) {
    assert.equal(titlebar.includes(marker), false, `产品标题栏不应出现 ${marker}`)
  }
  for (const marker of [".cx-dots", ".cx-dot {", ".cx-dot-close", ".cx-dot-min", ".cx-dot-max"]) {
    assert.equal(css.includes(marker), false, `产品 CSS 不应出现 ${marker}`)
  }
})
