// P4 R4 共享层可访问性/健壮性基建测试（静态扫描 + 纯函数，不需要浏览器）：
// - 界面树渲染异常的共享错误边界（友好错误态 + 恢复动作 + role=alert）
// - reduced-motion / focus-visible 共享 CSS 覆盖 [data-pi-root] 全子树
// - v1.4：文本输入的焦点提示改为中性描边（按钮/链接仍用共享外环）
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const UI = "ui/src"

test("错误边界：PiApp 用 PiVariantBoundary 包住界面树，渲染失败可重新加载", () => {
  const app = read(`${UI}/pi/PiApp.tsx`)
  assert.match(app, /<PiVariantBoundary>\s*<CursorApp \{\.\.\.app\} \/>\s*<\/PiVariantBoundary>/)
  const boundary = read(`${UI}/pi/PiVariantBoundary.tsx`)
  for (const needle of ['role="alert"', 'aria-live="assertive"', "data-pi-variant-error", "window.location.reload()", "getDerivedStateFromError", "componentDidCatch"]) {
    assert.ok(boundary.includes(needle), `错误边界缺 ${needle}`)
  }
  // 只在 dev 打错误详情；生产不暴露堆栈
  assert.match(boundary, /import\.meta\.env\?\.DEV/)
  // 边界不 import 它包住的界面树 / 旧 UI（出错时自身还要能渲染）
  assert.doesNotMatch(boundary, /from "@\/pi\/variants\/cursor/)
  assert.doesNotMatch(boundary, /from "@\/components|from "@\/chat|from "@\/shell/)
})

test("reduced-motion：共享 CSS 覆盖 [data-pi-root] 全子树（界面根 = PiHeadlessRoot）", () => {
  const css = read(`${UI}/components/pi/shared/pi-theme.css`)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
  assert.match(block, /\[data-pi-root\],\s*\n\s*\[data-pi-root\] \*/)
  assert.match(block, /animation: none !important/)
  assert.match(block, /transition: none !important/)
  assert.match(block, /scroll-behavior: auto !important/)
  // 界面根 PiRoot 用 PiHeadlessRoot（渲染 data-pi-root），共享规则因此生效
  assert.match(read(`${UI}/components/pi/shared/PiRoot.tsx`), /<PiHeadlessRoot/)
  assert.match(read(`${UI}/pi/headless/root.tsx`), /"data-pi-root": ""|data-pi-root=""/)
})

test("focus-visible：按钮/链接共享 token 外环；文本输入改用中性描边", () => {
  const css = read(`${UI}/components/pi/shared/pi-theme.css`)
  assert.match(css, /\[data-pi-root\] :focus-visible/)
  assert.match(css, /var\(--cw-pi-focus-ring\)/)
  assert.match(css, /:root:root\[data-pi-theme\] :focus-visible/)
  // token 定义在主题文件（不是硬编码颜色）
  assert.match(css, /--cw-pi-focus-ring:/)
  // v1.4：文本输入不吃蓝外环，浅 / 深各有一个中性描边 token；不再出现 UA 蓝框
  assert.match(css, /--cw-pi-field-focus-border:/)
  assert.match(css, /:is\(input, textarea, select\):focus-visible/)
  assert.match(css, /:is\(input, textarea, select\):focus-visible[\s\S]{0,80}?outline: none;/)
  assert.match(css, /--cw-pi-field-focus-border: #8b8b91/)
})

test("a11y 基线：错误态不依赖鼠标（静态线索）", () => {
  const app = read(`${UI}/pi/PiApp.tsx`)
  assert.match(app, /PiVariantBoundary/)
  // 错误态带 data-pi 标记，验证线可定位；恢复按钮自动聚焦，键盘可直接重新加载
  const boundary = read(`${UI}/pi/PiVariantBoundary.tsx`)
  assert.ok(boundary.includes("data-pi-variant-error"))
  assert.match(boundary, /autoFocus/)
})
