import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

const ROOT = new URL("../", import.meta.url)
const read = (path) => fs.readFile(new URL(path, ROOT), "utf8")

test("P11 移动框架出口齐全（MobileTopBar/MobileListHome/SwipeRow/MobileDrawerNav/LongPressCard/MobileSearchPage/MobileNavSetting/MobileNavShell）", async () => {
  const index = await read("ui/src/pi/mobile/index.ts")
  for (const name of [
    "MobileTopBar",
    "MobileListHome",
    "SwipeRow",
    "MobileDrawerNav",
    "LongPressCard",
    "MobileSearchPage",
    "MobileNavSetting",
    "MobileNavShell",
  ]) {
    assert.equal(index.includes(name), true, `index 应导出 ${name}`)
  }
})

test("移动框架自包含：不 import 变体/cursor kit 值，不用 --cw-*/--claude-*/--codex-* 变量", async () => {
  const files = await fs.readdir(new URL("ui/src/pi/mobile/", ROOT))
  for (const file of files) {
    if (!/\.(tsx?|css)$/.test(file)) continue
    const text = await read(`ui/src/pi/mobile/${file}`)
    assert.equal(/from\s+"@\/components\//.test(text), false, `${file} 不应 import @/components`)
    assert.equal(/--cw-|--claude-|--codex-/.test(text), false, `${file} 不应使用变体私有变量`)
  }
})

test("移动 CSS 关键参数：抽屉宽 clamp(288,屏宽-68,340)、左滑 148、安全段 30、顶栏 54", async () => {
  const css = await read("ui/src/pi/mobile/mobile.css")
  assert.equal(css.includes("clamp(288px, calc(100vw - 68px), 340px)"), true)
  assert.equal(css.includes("width: 148px"), true)
  assert.equal(css.includes("--pm-safe-bottom: 30px"), true)
  assert.equal(css.includes("height: 54px"), true)
  const types = await read("ui/src/pi/mobile/types.ts")
  assert.equal(types.includes("MOBILE_SWIPE_WIDTH = 148"), true)
  assert.equal(types.includes("MOBILE_SAFE_BOTTOM = 30"), true)
})

test("移动 surface 标记：P11-MOB-01/02/03/04/05/06/07/08/09/10/11 都可选择", async () => {
  const dir = new URL("ui/src/pi/mobile/", ROOT)
  const files = await fs.readdir(dir)
  let all = ""
  for (const file of files) if (file.endsWith(".tsx")) all += await read(`ui/src/pi/mobile/${file}`)
  for (const id of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]) {
    assert.equal(all.includes(`P11-MOB-${id}`), true, `缺少 P11-MOB-${id}`)
  }
})

test("P11：文件夹默认折叠、折叠组头不显示会话数（Codex/Cursor 桌面 + 移动）", async () => {
  const desktop = await Promise.all([
    read("ui/src/pi/variants/codex/sidebar/CodexUnifiedSidebar.tsx"),
    read("ui/src/pi/containers/CursorUnifiedSidebar.tsx"),
  ])
  for (const file of desktop) assert.equal(file.includes("folders[group.key] !== false"), true, "桌面适配默认折叠")
  const mobile = await read("ui/src/pi/mobile/useMobileSidebarData.ts")
  assert.equal(mobile.includes("scopeState.folders[group.key] !== false"), true)
  assert.equal(mobile.includes("!(current.folders[groupId] ?? true)"), true, "首次点击展开写 false")
  const home = await read("ui/src/pi/mobile/MobileListHome.tsx")
  assert.equal(home.includes("pm-group-count"), false, "组头永不显示会话数")
})

test("P11 a11y/六套 token：mobile.css 映射真实 --sb-*；抽屉/长按卡/搜索/radio 键盘路径存在", async () => {
  const css = await read("ui/src/pi/mobile/mobile.css")
  for (const token of ["--sb-t1", "--sb-t2", "--sb-t3", "--sb-t4", "--sb-t5", "--sb-pill-bg", "--sb-hover-bg", "--sb-selected-bg", "--sb-run", "--sb-backdrop"]) {
    assert.equal(css.includes(`var(${token}`), true, `应映射 ${token}`)
  }
  assert.equal(/var\(--sb-(text-|surface|accent[,)])/.test(css), false, "不得再引用不存在的 --sb-text-*/--sb-surface/--sb-accent")
  assert.equal(css.includes("--pm-swipe-pin-bg"), true, "浅色左滑按钮需可读配色 token")
  const drawer = await read("ui/src/pi/mobile/MobileDrawerNav.tsx")
  assert.equal(drawer.includes('document.addEventListener("keydown", onKey)'), true)
  assert.equal(drawer.includes('event.key === "Escape"'), true)
  assert.equal(drawer.includes("focusables()[0]?.focus()"), true)
  const card = await read("ui/src/pi/mobile/LongPressCard.tsx")
  assert.equal(card.includes("firstRef.current?.focus()"), true)
  assert.equal(card.includes('event.key === "Escape"'), true)
  const search = await read("ui/src/pi/mobile/MobileSearchPage.tsx")
  assert.equal(search.includes('event.key === "Escape"'), true)
  const setting = await read("ui/src/pi/mobile/MobileNavSetting.tsx")
  assert.equal(setting.includes('event.key === "ArrowDown"'), true)
  assert.equal(setting.includes("tabIndex={checked ? 0 : -1}"), true)
  const shell = await read("ui/src/pi/mobile/MobileNavShell.tsx")
  for (const attr of ['"data-pi-sidebar"', '"data-pi-mobile"', '"data-pi-sidebar-style"', '"data-pi-theme"']) assert.equal(shell.includes(attr), true, `根缺 ${attr}`)
})
