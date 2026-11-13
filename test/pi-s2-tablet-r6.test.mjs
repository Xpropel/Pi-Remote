// S2 第六轮 · 平板档右侧面板：浮层最多盖住正文一半（--cw-pi-pane-float-max-w）；点正文空处收起（按钮 / 链接 / 通知卡不算，
// 触屏等 click 再收、滑动不收）；Esc 收起（菜单 / 浮层开着时让它们先关；不登记 overlay 层，免得挡住 ⌘ 快捷键）；
// 收起时焦点掉到 body 就回顶栏的「右侧面板」钮。接线看源码。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const read = (p) => fs.readFileSync(new URL(`../ui/${p}`, import.meta.url), "utf8")
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("PiDesktopShell", () => {
  const shell = code(read("src/components/pi/shared/PiShell.tsx"))

  test("宽度：平板档取 pane 宽与正文一半的较小者，通知卡的右边界跟着它；桌面档不变", () => {
    assert.match(
      shell,
      /const paneFloatW = `min\(\$\{paneWidth != null \? `\$\{paneWidth\}px` : "var\(--cw-pi-pane-w\)"\}, var\(--cw-pi-pane-float-max-w\)\)`/,
    )
    assert.match(shell, /style=\{\{ width: tablet \? paneFloatW : \(paneWidth \?\? "var\(--cw-pi-pane-w\)"\) \}\}/)
    assert.match(shell, /style=\{paneOpen && tablet \? \{ right: paneFloatW \} : undefined\}/)
    assert.match(
      read("src/components/pi/shared/pi-theme.css"),
      /--cw-pi-pane-float-max-w: calc\(\(100vw - var\(--cw-pi-tablet-rail-w\)\) \/ 2\);/,
    )
  })

  test("点外面：只在平板档、pane 开着、侧栏浮层没开时监听；只认正文 / 窄栏，控件与通知卡不算", () => {
    assert.match(shell, /const paneDismissable = paneOpen && tablet && !drawerOpen && onPaneDismiss != null/)
    assert.match(shell, /root\.addEventListener\("pointerdown", onPointerDown, true\)/)
    assert.match(
      shell,
      /if \(!target\?\.closest\("\[data-pi-main\], \[data-pi-sidebar-slot\]"\) \|\| target\.closest\(PANE_DISMISS_SKIP\)\) return/,
    )
    const skip = /const PANE_DISMISS_SKIP =\s*"([^"]+)"/.exec(shell)
    assert.ok(skip, "PANE_DISMISS_SKIP")
    for (const selector of ["[data-pi-notice-slot]", "button", "a[href]", "[role='button']", "[role='link']", "[role='tab']"]) {
      assert.ok(skip[1].split(", ").includes(selector), selector)
    }
  })

  test("触屏 / 笔：等 click 真来了再收（滑动正文不收）；下一次按下先作废上一次的等待", () => {
    assert.match(shell, /if \(event\.pointerType === "mouse"\) \{\s*dismissPane\.current\?\.\(\)\s*return\s*\}/)
    assert.match(shell, /root\.addEventListener\("click", pendingTap, \{ capture: true, once: true \}\)/)
    assert.match(shell, /const onPointerDown = \(event: PointerEvent\) => \{\s*dropPendingTap\(\)/)
    assert.match(shell, /return \(\) => \{\s*dropPendingTap\(\)\s*root\.removeEventListener\("pointerdown", onPointerDown, true\)/)
  })
})

describe("DesktopApp", () => {
  const app = code(read("src/pi/containers/DesktopApp.tsx"))

  test("点外面收起 = act.setPane(null)", () => {
    assert.match(app, /const closePane = useCallback\(\(\) => act\.setPane\(null\), \[act\]\)/)
    assert.match(app, /onSidebarOverlayClose=\{closeDrawer\}\s+onPaneDismiss=\{closePane\}/)
  })

  test("Esc：只在 pane 浮着、没有菜单 / 浮层开着时收；不登记 overlay 层；赶在外壳快捷键（window）之前处理", () => {
    assert.match(app, /const paneFloating = tablet && session && ready && !!ui\.pane/)
    assert.match(app, /const layerOpen = layers\.menuOpen \|\| layers\.overlayOpen/)
    assert.match(app, /if \(!paneFloating \|\| layerOpen\) return/)
    assert.match(
      app,
      /if \(event\.key !== "Escape" \|\| event\.defaultPrevented \|\| event\.isComposing\) return\s*event\.preventDefault\(\)\s*closePane\(\)/,
    )
    assert.match(app, /document\.addEventListener\("keydown", onKeyDown\)/)
    assert.doesNotMatch(app, /usePiLayer\(paneFloating/)
    const shortcuts = code(read("src/pi/hooks/usePiShortcuts.ts"))
    assert.match(shortcuts, /window\.addEventListener\("keydown", onKeyDown\)/)
    assert.match(shortcuts, /if \(event\.defaultPrevented\) return/)
  })

  test("收起时焦点掉到 body：回顶栏的「右侧面板」钮（产品顶栏和默认顶栏都打了标记）", () => {
    assert.match(
      app,
      /if \(!was \|\| paneFloating \|\| \(document\.activeElement \?\? document\.body\) !== document\.body\) return\s*document\.querySelector<HTMLElement>\("\[data-pi-pane-toggle\]"\)\?\.focus\(\)/,
    )
    assert.match(read("src/pi/containers/SessionInfoContainer.tsx"), /<GhostIconButton\s+data-pi-pane-toggle=""\s+label="右侧面板"/)
    assert.match(read("src/components/pi/shared/PiTopBar.tsx"), /<GhostIconButton\s+data-pi-pane-toggle=""\s+label="右侧面板"/)
  })
})

test("README：平板档右侧面板最多盖住正文一半，点正文空处或 Esc 收起", () => {
  assert.match(read("README.md"), /右侧面板（改动 \/ 终端 \/ 文件）也浮在正文上，不挤压对话列，最多盖住正文的一半，点正文空处或按 Esc 收起/)
})
