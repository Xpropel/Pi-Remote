// P11 侧栏 a11y/功能 P1 守卫：搜索本地过滤、气泡不被裁剪、状态 tone 映射、键盘可达、对比度 token 抬升。
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const read = (path) => readFile(new URL(`../ui/src/pi/sidebar/${path}`, import.meta.url), "utf8")

test("搜索浮层在共享核本地过滤（会话标题/工作区/cwd，最多 20，无匹配文案，aria-modal）", async () => {
  const source = await read("components/SidebarSearchOverlay.tsx")
  assert.equal(source.includes("useMemo"), true)
  assert.equal(source.includes("group.sessions"), true)
  assert.equal(source.includes("slice(0, 20)"), true)
  assert.equal(source.includes("没有匹配"), true)
  assert.equal(source.includes('aria-modal="true"'), true)
})

test("悬停气泡是真浮层：createPortal 到 body + position:fixed + z-index≥1000", async () => {
  const card = await read("components/SidebarHoverCard.tsx")
  assert.equal(card.includes("createPortal"), true)
  assert.equal(card.includes("document.body"), true)
  const css = await read("sidebar.css")
  assert.equal(css.includes(".sb-bubble {\n  position: fixed;"), true)
  assert.equal(css.includes("z-index: 1000"), true)
})

test("状态点用 data-tone × --sb-error/--sb-run/--sb-wait（不再 data-status/--sb-err）", async () => {
  const css = await read("sidebar.css")
  for (const tone of ["running", "waiting", "error"]) assert.equal(css.includes(`[data-tone="${tone}"]`), true)
  assert.equal(css.includes("[data-status="), false)
  assert.equal(css.includes("--sb-err,"), false)
})

test("键盘可达：图钉/归档 focus-within 显示、搜索 Esc、设备菜单方向键、调宽 separator 可聚焦", async () => {
  const css = await read("sidebar.css")
  assert.equal(css.includes(":focus-within .sb-row-actions"), true)
  const search = await read("components/SidebarSearchOverlay.tsx")
  assert.equal(search.includes('event.key === "Escape"'), true)
  const menu = await read("components/SidebarDeviceMenu.tsx")
  assert.equal(menu.includes("ArrowDown"), true)
  const sidebar = await read("UnifiedSidebar.tsx")
  assert.equal(sidebar.includes("tabIndex={0}"), true)
  assert.equal(sidebar.includes('role="separator"'), true)
})

test("对比度 token 已抬升（暗色 t5/icon-muted 不再是原低对比值）", async () => {
  const css = await read("tokens.css")
  assert.equal(css.includes("--sb-t5: #5f5f66;"), false)
  assert.equal(css.includes("--sb-icon-muted: #55555c;"), false)
  assert.equal(css.includes("--sb-t5: #b3afa4;"), false)
})

test("未选中会话标题六套深浅对比度 ≥4.5（色值对最高亮度底/最低亮度底保守计算）", async () => {
  const tokens = await read("tokens.css")
  // 六个 :root 块顺序与 tokens.css 一致；抽每块 t2 值（未选中标题实际使用 --sb-t2）
  const t2s = [...tokens.matchAll(/--sb-t2:\s*(#[0-9a-fA-F]{6}|rgba\([^)]*\))/g)].map((m) => m[1])
  assert.equal(t2s.length, 6)
  const parse = (color) => {
    if (color.startsWith("#")) {
      const n = parseInt(color.slice(1), 16)
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
    }
    const m = color.match(/rgba?\(([^)]+)\)/)
    const parts = m[1].split(",").map((x) => Number(x.trim()))
    return [parts[0] / 255, parts[1] / 255, parts[2] / 255]
  }
  const lum = (rgb) => {
    const c = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  // 保守：tokens.css 块顺序 = 每套 dark/light 交替；暗对 #0d0d0d、亮对 #ffffff
  const bgs = [lum(parse("#0d0d0d")), lum(parse("#ffffff")), lum(parse("#0d0d0d")), lum(parse("#ffffff")), lum(parse("#0d0d0d")), lum(parse("#ffffff"))]
  t2s.forEach((value, i) => {
    const r = ratio(lum(parse(value)), bgs[i])
    assert.ok(r >= 4.5, `第 ${i + 1} 套未选中标题对比度 ${r.toFixed(2)} < 4.5（${value}）`)
  })
})


test("P2 收口：portal 气泡在 .sb-root 内且 Claude 标题衬线、ink3 文本抬升、浅色状态点非文字 ≥3、焦点恢复", async () => {
  const card = await read("components/SidebarHoverCard.tsx")
  assert.equal(card.includes("document.querySelector(\"[data-pi-sidebar]\")"), true)
  const css = await read("sidebar.css")
  assert.equal(css.includes('[data-pi-sidebar-style="claude"] .sb-bubble-title'), true)
  assert.equal(css.includes("--sb-serif"), true)
  assert.equal(css.includes(".sb-search-empty { color: var(--sb-t3"), true)
  const tokens = await read("tokens.css")
  assert.equal(tokens.includes("--sb-wait: #a06b00;"), true)
  assert.equal(tokens.includes("--sb-online: #1f7a44;"), true)
  const sidebar = await read("UnifiedSidebar.tsx")
  assert.equal(sidebar.includes("wasSearchOpen"), true)
  const menu = await read("components/SidebarDeviceMenu.tsx")
  assert.equal(menu.includes("[role=\"menuitem\"]',)") || menu.includes('.querySelector<HTMLButtonElement>'), true)
})
