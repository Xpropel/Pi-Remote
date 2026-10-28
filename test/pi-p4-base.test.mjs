// P4 底座（p4-base）：浮层登记表的纯逻辑 + 交互层契约的源码检查（R2/p4-lanes.md）。
// 交互行为本身（焦点进出、Tab 圈住、Esc 分层、背后 inert、⌘ 快捷键）在 #/play 上由 R2/tools/ui-interact.mjs 验，不在这里。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createPiLayerStore, PI_LAYERS_EMPTY } from "../ui/src/pi/model/layers.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8")
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/")
/** 去掉 /* *\/ 和 // 注释 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
function walk(dir, pred, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, pred, out)
    else if (pred(p)) out.push(p)
  }
  return out
}
/** 从 src[at]（"<"）起取 JSX 开标签的顶层文字：{…} 里的内容（表达式、嵌套 JSX、字符串）换成 {}，到顶层的 > 为止 */
function openingTag(src, at) {
  let out = ""
  let depth = 0
  let quote = null
  for (let i = at; i < src.length; i++) {
    const ch = src[i]
    if (depth > 0) {
      if (quote) {
        if (ch === "\\") i++
        else if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch
      else if (ch === "{") depth++
      else if (ch === "}" && --depth === 0) out += "{}"
      continue
    }
    if (ch === "{") {
      depth = 1
      continue
    }
    out += ch
    if (ch === ">") break
  }
  return out
}

describe("浮层登记表 createPiLayerStore", () => {
  test("空表：两个开关都是 false，快照引用稳定", () => {
    const store = createPiLayerStore()
    assert.equal(store.getSnapshot(), PI_LAYERS_EMPTY)
    assert.deepEqual({ ...store.getSnapshot() }, { menuOpen: false, overlayOpen: false, count: 0 })
    assert.equal(store.getSnapshot(), store.getSnapshot())
    assert.equal(store.closeTop("menu"), false)
  })

  test("登记 / 注销：按 kind 分开，注销重复调用无副作用", () => {
    const store = createPiLayerStore()
    const menu = store.open("menu")
    assert.deepEqual({ ...store.getSnapshot() }, { menuOpen: true, overlayOpen: false, count: 1 })
    const sheet = store.open("overlay")
    assert.deepEqual({ ...store.getSnapshot() }, { menuOpen: true, overlayOpen: true, count: 2 })
    menu.dispose()
    menu.dispose()
    assert.deepEqual({ ...store.getSnapshot() }, { menuOpen: false, overlayOpen: true, count: 1 })
    sheet.dispose()
    assert.equal(store.getSnapshot(), PI_LAYERS_EMPTY)
  })

  test("closeTop 关同类里最后打开、带 close 的一层；不带 close 的（Radix 自己关）跳过", () => {
    const store = createPiLayerStore()
    const closed = []
    store.open("overlay", () => closed.push("dialog"))
    store.open("menu", () => closed.push("menu-1"))
    store.open("menu") // Radix 菜单：只登记，不归这里关
    store.open("overlay", () => closed.push("sheet"))
    assert.equal(store.closeTop("menu"), true)
    assert.deepEqual(closed, ["menu-1"])
    assert.equal(store.closeTop("overlay"), true)
    assert.deepEqual(closed, ["menu-1", "sheet"])
    // closeTop 只调用 close，注销由部件在关闭后自己做
    assert.equal(store.getSnapshot().count, 4)
  })

  test("subscribe：内容变了才通知，取消订阅后不再通知", () => {
    const store = createPiLayerStore()
    let n = 0
    const off = store.subscribe(() => n++)
    const a = store.open("menu")
    const b = store.open("menu") // menuOpen 不变，但 count 变了
    assert.equal(n, 2)
    const snap = store.getSnapshot()
    a.dispose()
    assert.equal(n, 3)
    assert.notEqual(store.getSnapshot(), snap)
    off()
    b.dispose()
    assert.equal(n, 3)
  })
})

describe("P4 交互层契约（源码）", () => {
  test("画廊舞台用 PiStaticProvider 包住整屏；#/play 不包（可交互）", () => {
    const stage = code(read("ui/src/pi/dev/PiStage.tsx"))
    assert.match(stage, /<PiStaticProvider>\s*<Screen /)
    const play = code(read("ui/src/pi/dev/play/PlayRoute.tsx"))
    assert.doesNotMatch(play, /PiStaticProvider/)
    assert.match(play, /<PiLayerProvider>/)
  })

  test("层级只用 --cw-pi-z-* 五档：pi-theme.css 定义，components/pi/** 不写 z 数字（卡内 / 行内的局部层叠列白名单）", () => {
    const css = read("ui/src/components/pi/shared/pi-theme.css")
    const want = { raised: 10, popover: 30, sheet: 40, modal: 50, chrome: 60 }
    for (const [name, value] of Object.entries(want)) assert.match(css, new RegExp(`--cw-pi-z-${name}:\\s*${value};`), name)
    // R2/p4-lanes.md §2：卡片 / chip 行内部的局部层叠可以留（展开钮的 44 点击区压住卡内渐隐层；引用 chip 的外扩压在同一行 chip 下面），
    // 其余一律换成五档。新增的局部层叠要在这里登记
    const ALLOW = [
      "ui/src/components/pi/composer/PiFollowUpComposer.tsx: after:-z-10",
      "ui/src/components/pi/conversation/PiCodeBlock.tsx: z-[1]",
      "ui/src/components/pi/conversation/PiDiffCard.tsx: z-[3]",
      "ui/src/components/pi/conversation/PiProse.tsx: z-[1]",
    ]
    const found = []
    for (const file of walk(path.join(ROOT, "ui/src/components/pi"), (p) => /\.(tsx?|css)$/.test(p))) {
      const src = code(read(rel(file)))
      for (const m of src.matchAll(/(?<![\w-])(?:[\w-]+:)*-?z-(?:\d+|\[\d+\])(?![\w-])/g)) found.push(`${rel(file)}: ${m[0]}`)
      assert.doesNotMatch(src, /\bzIndex\b|\bz-index\s*:\s*-?\d/, `${rel(file)} 里有 z-index 数字`)
    }
    assert.deepEqual(found.sort(), ALLOW)
    const overlay = code(read("ui/src/components/pi/shared/PiOverlay.tsx"))
    assert.match(overlay, /z-\(--cw-pi-z-modal\)/)
    assert.match(overlay, /z-\(--cw-pi-z-sheet\)/)
  })

  test("PiOverlay = Radix Dialog（modal）+ 背后 inert + 登记 overlay 层，默认 portal；PiDialog 用默认，PiSheet 不 portal、在 sheet 层", () => {
    // 先按原文的分节注释切开，再去注释（去掉注释以后分节标记就找不到了）
    const raw = read("ui/src/components/pi/shared/PiOverlay.tsx")
    const part = (from, to) => {
      const i = raw.indexOf(from)
      const j = raw.indexOf(to, i)
      assert.ok(i >= 0 && j > i, `${from} … ${to}`)
      return code(raw.slice(i, j))
    }
    const overlay = part("export function PiOverlay(", "/* ======================= 手机底部 sheet")
    const dialog = part("function PiDialogInteractive", "/* ======================= 锚定菜单")
    const sheet = part("function PiSheetInteractive", "/* ======================= 弹窗")
    assert.match(overlay, /portal = true/)
    assert.match(overlay, /<Dialog\.Root open=\{open\} onOpenChange=\{setOpen\}>/)
    assert.match(overlay, /portal \? <Dialog\.Portal>\{node\}<\/Dialog\.Portal> : open && node/)
    assert.match(overlay, /aria-modal="true"/)
    assert.match(overlay, /usePiLayer\(open, "overlay"/)
    assert.match(overlay, /usePiInertOthers\(layer, open\)/)
    assert.match(overlay, /usePiDialogFocus\(open, focus, returnFocus\)/)
    assert.match(dialog, /<PiOverlay\b/)
    assert.doesNotMatch(dialog, /portal=\{false\}/)
    assert.match(sheet, /<PiOverlay\b/)
    assert.match(sheet, /portal=\{false\}/)
    assert.match(sheet, /tier="sheet"/)
    assert.match(sheet, /sheetSlide && "animate-\[pi-sheet-in/)
    assert.match(read("ui/src/components/pi/shared/pi-theme.css"), /@keyframes pi-sheet-in/)
  })

  test("PiStatusLine：倒计时不进 live region（播报文字视觉隐藏、只在状态变化时更新，屏幕上的文字 aria-hidden）", () => {
    const src = read("ui/src/components/pi/shared/PiFeedback.tsx")
    const line = code(src.slice(src.indexOf("export function PiStatusLine"), src.indexOf("/* ======================= 通知卡")))
    assert.match(line, /role="status"/)
    assert.match(line, /className="sr-only"/)
    assert.match(line, /<span aria-hidden className="min-w-0 truncate">\s*\{text\}/)
    assert.doesNotMatch(line, /aria-label=\{/)
    assert.match(line, /if \(leaving && !fadeOut\) return null/)
  })

  test("画廊屏和外框里，可交互浮层部件（props extends PiOverlayControl）的每处用法都传 static；带 hoverCardOpen 的 PiTopBar 也传", () => {
    const overlays = new Set()
    for (const file of walk(path.join(ROOT, "ui/src/components/pi"), (p) => p.endsWith(".tsx"))) {
      for (const m of read(rel(file)).matchAll(/export interface (Pi\w+)Props\b([^{]*)\{/g)) if (/\bPiOverlayControl\b/.test(m[2])) overlays.add(m[1])
    }
    assert.ok(["PiSheet", "PiDialog", "PiMenu"].every((n) => overlays.has(n)), [...overlays].join(","))
    const missing = []
    for (const dir of ["ui/src/pi/dev/screens", "ui/src/pi/dev/frames"]) {
      for (const file of walk(path.join(ROOT, dir), (p) => p.endsWith(".tsx"))) {
        const src = code(read(rel(file)))
        for (const m of src.matchAll(/<(Pi\w+)\b/g)) {
          const name = m[1]
          const tag = openingTag(src, m.index)
          const needs = overlays.has(name) || (name === "PiTopBar" && /\shoverCardOpen\b/.test(tag))
          if (needs && !/\sstatic\b/.test(tag)) missing.push(`${rel(file)}: <${name}>`)
        }
      }
    }
    assert.deepEqual(missing, [])
  })

  test('index.html、gallery.html 的 <html lang="zh-CN">', () => {
    for (const f of ["ui/index.html", "ui/gallery.html"]) assert.match(read(f), /<html lang="zh-CN">/, f)
  })

  test("外壳快捷键：usePiShellShortcuts 用登记表拼 escState，Esc 第 1 / 2 层走 closeTop", () => {
    const src = code(read("ui/src/pi/hooks/usePiShellShortcuts.ts"))
    assert.match(src, /usePiLayerState\(\)/)
    assert.match(src, /menuOpen: layers\.menuOpen, overlayOpen: layers\.overlayOpen, canStop/)
    assert.match(src, /closeTop\("menu"\)/)
    assert.match(src, /closeTop\("overlay"\)/)
  })
})
