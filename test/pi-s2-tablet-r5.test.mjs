// S2 第五轮 · 平板档（视口 768–1023）：桌面外壳的侧栏默认收成 56 窄栏，展开是覆盖式浮层（点外面 / Esc / 打开会话收回），
// 右侧面板浮在正文上不挤压对话列；≥ 1024 不变，平板档不读写桌面的展开 / 收起偏好。浮层 store 直接跑；接线看源码。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const drawer = await import("../ui/src/pi/hooks/useSidebarDrawer.ts")

const read = (p) => fs.readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
const numOf = (src, name, unit = "") => {
  const m = new RegExp(`${name}:\\s*(\\d+)${unit};`).exec(src)
  assert.ok(m, `找不到 ${name}`)
  return Number(m[1])
}
const pxOf = (src, name) => numOf(src, name, "px")

describe("浮层 store（useSidebarDrawer）", () => {
  test("isTabletWidth：768–1023 才是平板档", () => {
    assert.deepEqual(
      [767, 768, 820, 1000, 1023, 1024, 1440].map(drawer.isTabletWidth),
      [false, true, true, true, true, false, false],
    )
  })

  test("不在平板档：开浮层无效，「切换侧栏」交给桌面偏好", () => {
    drawer.setSidebarDrawerActive(false)
    const idle = drawer.sidebarDrawerState()
    assert.deepEqual({ ...idle }, { active: false, open: false })
    drawer.setSidebarDrawerOpen(true)
    assert.equal(drawer.sidebarDrawerState(), idle, "没变就不换快照（useSyncExternalStore 要稳定引用）")
    let desktop = 0
    drawer.toggleSidebarOrDrawer(() => desktop++)
    assert.equal(desktop, 1)
    assert.equal(drawer.sidebarDrawerState(), idle)
  })

  test("平板档：切换只开关浮层、不碰桌面偏好；离开平板档浮层收起，回来仍是窄栏", () => {
    drawer.setSidebarDrawerActive(true)
    assert.deepEqual({ ...drawer.sidebarDrawerState() }, { active: true, open: false }, "进平板档默认窄栏")
    let desktop = 0
    const toggleDesktop = () => desktop++
    drawer.toggleSidebarOrDrawer(toggleDesktop)
    assert.equal(drawer.sidebarDrawerState().open, true)
    const opened = drawer.sidebarDrawerState()
    drawer.setSidebarDrawerOpen(true)
    assert.equal(drawer.sidebarDrawerState(), opened, "同值不发新快照")
    drawer.toggleSidebarOrDrawer(toggleDesktop)
    assert.equal(drawer.sidebarDrawerState().open, false)
    assert.equal(desktop, 0, "平板档不写 sidebarCollapsed")
    drawer.setSidebarDrawerOpen(true)
    drawer.setSidebarDrawerActive(false)
    assert.deepEqual({ ...drawer.sidebarDrawerState() }, { active: false, open: false }, "到桌面宽度浮层一并收起")
    drawer.setSidebarDrawerActive(true)
    assert.equal(drawer.sidebarDrawerState().open, false, "回到平板档不记上次的展开")
    drawer.setSidebarDrawerActive(false)
  })
})

describe("PiDesktopShell 平板档", () => {
  const shell = code(read("src/components/pi/shared/PiShell.tsx"))

  test("侧栏槽固定窄栏宽，侧栏放进 sheet 层浮层；桌面档照旧直出", () => {
    assert.match(shell, /\{tablet \? \(\s*<div data-pi-sidebar-slot="" className="relative h-full w-\(--cw-pi-tablet-rail-w\) shrink-0">/)
    assert.match(
      shell,
      /data-pi-sidebar-float=""\s*data-open=\{drawerOpen \? "" : undefined\}\s*className=\{cn\("absolute inset-y-0 left-0 z-\(--cw-pi-z-sheet\) flex"/,
    )
    assert.match(shell, /\) : \(\s*sidebar\s*\)\}/)
    assert.match(shell, /const drawerOpen = tablet && sidebarOverlay/)
  })

  test("遮罩在 popover 层（盖住正文与 pane、低于侧栏浮层），点它收回", () => {
    assert.match(
      shell,
      /\{drawerOpen && \(\s*<div data-pi-sidebar-scrim="" aria-hidden className="absolute inset-0 z-\(--cw-pi-z-popover\)" onClick=\{onSidebarOverlayClose\} \/>/,
    )
    const theme = read("src/components/pi/shared/pi-theme.css")
    const z = (name) => numOf(theme, name)
    assert.ok(z("--cw-pi-z-raised") < z("--cw-pi-z-popover"), "遮罩盖住 pane")
    assert.ok(z("--cw-pi-z-popover") < z("--cw-pi-z-sheet"), "侧栏浮层在遮罩上面")
    assert.ok(z("--cw-pi-z-sheet") < z("--cw-pi-z-modal"), "弹窗仍在最上")
  })

  test("pane：平板档浮在正文上（raised 层），对话列照 pane 关着排；通知只在 pane 左边居中", () => {
    assert.match(shell, /const paneInFlow = paneOpen && !tablet/)
    assert.match(shell, /"--cw-pi-chat-w": paneInFlow \? "100%" : "var\(--cw-pi-chat-max-w\)"/)
    assert.match(shell, /"--cw-pi-chat-gutter": paneInFlow \? "24px" : "40px"/)
    assert.match(shell, /data-floating=\{tablet \? "" : undefined\}/)
    assert.match(shell, /tablet \? "absolute inset-y-0 right-0 z-\(--cw-pi-z-raised\) max-w-full shadow-\(--cw-shadow-popover\)" : "relative"/)
    assert.match(shell, /style=\{paneOpen && tablet \? \{ right: paneFloatW \} : undefined\}/)
  })

  test("窄栏宽 = 侧栏收起宽（56）", () => {
    const rail = pxOf(read("src/components/pi/shared/pi-theme.css"), "--cw-pi-tablet-rail-w")
    assert.equal(rail, 56)
    assert.equal(rail, pxOf(read("src/pi/sidebar/tokens.css"), "--sb-width-collapsed"))
  })
})

describe("DesktopApp / 侧栏 / 快捷键接线", () => {
  const app = code(read("src/pi/containers/DesktopApp.tsx"))

  test("只在产品模式的 768–1023 进平板档；卸载 / 变宽时退出", () => {
    assert.match(app, /const tabletWidth = useWidthValue\(isTabletWidth\)/)
    assert.match(app, /const tablet = tabletWidth && frame\.mode === "product"/)
    assert.match(app, /setSidebarDrawerActive\(tablet\)\s*return \(\) => setSidebarDrawerActive\(false\)\s*\}, \[tablet\]\)/)
    assert.match(app, /const drawerOpen = useSidebarDrawer\(\)\.open && tablet/)
  })

  test("Esc 走 overlay 层收浮层；换会话 / 换视图后收起；收起时焦点回窄栏的展开钮", () => {
    assert.match(app, /usePiLayer\(drawerOpen, "overlay", closeDrawer\)/)
    assert.match(app, /setSidebarDrawerOpen\(false\)\s*\}, \[relay\.roomId, ui\.view\]\)/)
    assert.match(app, /closest\("\[data-pi-sidebar-float\]"\) != null/)
    assert.match(app, /querySelector<HTMLElement>\("\[data-pi-sidebar-float\] \[data-sb-collapse\]"\)\?\.focus\(\)/)
    assert.match(read("src/pi/sidebar/components/SidebarToolRow.tsx"), /data-sb-collapse=""/)
  })

  test("「切换侧栏」所有入口都经 toggleSidebarOrDrawer：侧栏按钮、⌘B、命令面板、设置里改过的快捷键", () => {
    assert.match(app, /toggleSidebar: \(\) => toggleSidebarOrDrawer\(props\.act\.toggleSidebar\)/)
    assert.match(app, /onToggleSidebar: act\.toggleSidebar/)
    assert.match(app, /tablet \? \{ open: drawerOpen, toggle: act\.toggleSidebar, close: closeDrawer \} : undefined/)
    assert.match(app, /<PiDesktopShell\s+tablet=\{tablet\}\s+sidebarOverlay=\{drawerOpen\}\s+onSidebarOverlayClose=\{closeDrawer\}/)
    assert.match(app, /sidebar=\{<SidebarContainer \{\.\.\.p\} theme=\{theme\} drawer=\{drawer\} \/>\}/)
    const host = code(read("src/pi/hooks/PiSettingsHost.tsx"))
    assert.match(host, /case "toggleSidebar":\s*toggleSidebarOrDrawer\(act\.toggleSidebar\)\s*return true/)
  })

  test("侧栏：平板档窄栏 / 展开只跟浮层，桌面偏好不读不写；点了去处先收浮层", () => {
    assert.match(code(read("src/pi/containers/SidebarContainer.tsx")), /<CursorUnifiedSidebar p=\{p\} theme=\{theme\} drawer=\{drawer\} \/>/)
    const sb = code(read("src/pi/containers/CursorUnifiedSidebar.tsx"))
    assert.match(sb, /const collapsed = drawer \? !drawer\.open : ui\.prefs\.sidebarCollapsed/)
    assert.match(sb, /toggleCollapse: drawer \? drawer\.toggle : \(\) => act\.setPref\("sidebarCollapsed", !ui\.prefs\.sidebarCollapsed\)/)
    assert.equal((sb.match(/ui\.prefs\.sidebarCollapsed/g) ?? []).length, 2, "sidebarCollapsed 只在桌面档分支里读 / 写")
    assert.match(sb, /drawer\?\.close\(\)\s*run\(\.\.\.args\)/)
    for (const name of ["selectSession", "selectBodyHit", "newSession", "openSettings", "openInbox", "back"]) {
      assert.match(sb, new RegExp(`${name}: (?:ui\\.view === "session" \\? undefined : )?leave\\(`), name)
    }
  })
})

test("README：≥ 768 是桌面外壳，768–1023 是它的平板档；不再写「≥ 1024 是桌面」", () => {
  const readme = read("README.md")
  assert.match(readme, /≥ 768 是桌面外壳（`containers\/DesktopApp\.tsx`）/)
  assert.match(readme, /768–1023 是桌面外壳的平板档：侧栏默认收成 56 窄栏/)
  assert.match(readme, /平板档的展开 \/ 收起不写偏好，≥ 1024 仍按用户在桌面上的选择/)
  assert.doesNotMatch(readme, /≥ ?1024 是桌面|1024 断点/)
})
