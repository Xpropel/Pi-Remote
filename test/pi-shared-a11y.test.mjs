// P4 R4 共享层可访问性/健壮性基建测试（静态扫描 + 纯函数，不需要浏览器）：
// - 变体 chunk 加载失败的共享错误边界（友好错误态 + 恢复动作 + role=alert）
// - Suspense 加载占位的读屏语义（role=status / aria-live）
// - reduced-motion / focus-visible 共享 CSS 是否覆盖两套变体（都挂在 [data-pi-root] 下）
// - v1.4：文本输入的焦点提示改为中性描边（按钮/链接仍用共享外环），两套变体不再用品牌色/蓝光晕
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")
const UI = "ui/src"

test("变体错误边界：PiApp 包住 Suspense，失败可重新加载或回退 Cursor", () => {
  const app = read(`${UI}/pi/PiApp.tsx`)
  assert.match(app, /<PiVariantBoundary variant=\{variant\.id\} onFallback=\{\(\) => act\.setUiVariant\("cursor"\)\}>/)
  assert.match(app, /<Suspense fallback=\{<PiVariantLoading variant=\{variant\.id\} \/>\}>/)
  const boundary = read(`${UI}/pi/PiVariantBoundary.tsx`)
  for (const needle of ['role="alert"', 'aria-live="assertive"', "data-pi-variant-error", "window.location.reload()", "onFallback", "getDerivedStateFromError", "componentDidCatch"]) {
    assert.ok(boundary.includes(needle), `错误边界缺 ${needle}`)
  }
  // 只在 dev 打错误详情；生产不暴露堆栈
  assert.match(boundary, /import\.meta\.env\?\.DEV/)
  // 共享边界不能 import 变体/旧 UI（独立性守卫的延伸）
  assert.doesNotMatch(boundary, /from "@\/pi\/variants\/(claude|codex|cursor)/)
  assert.doesNotMatch(boundary, /from "@\/components|from "@\/chat|from "@\/shell/)
})

test("加载占位 a11y：role=status + aria-live=polite + 变体名朗读", () => {
  const src = read(`${UI}/pi/variants/index.ts`)
  for (const needle of ['role: "status"', '"aria-live": "polite"', "aria-label", "正在加载"]) {
    assert.ok(src.includes(needle), `PiVariantLoading 缺 ${needle}`)
  }
})

test("reduced-motion：共享 CSS 覆盖 [data-pi-root] 全子树（两变体根 = PiHeadlessRoot）", () => {
  const css = read(`${UI}/components/pi/shared/pi-theme.css`)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"))
  assert.match(block, /\[data-pi-root\],\s*\n\s*\[data-pi-root\] \*/)
  assert.match(block, /animation: none !important/)
  assert.match(block, /transition: none !important/)
  assert.match(block, /scroll-behavior: auto !important/)
  // 两变体根都用 PiHeadlessRoot（渲染 data-pi-root），共享规则因此生效
  for (const f of ["claude/ClaudeApp.tsx", "codex/CodexApp.tsx"]) {
    assert.match(read(`${UI}/pi/variants/${f}`), /<PiHeadlessRoot/)
  }
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

test("文本输入聚焦：Claude / Codex 不用品牌强调色外环或 3px 光晕", () => {
  const claude = read(`${UI}/pi/variants/claude/styles/claude.css`)
  assert.match(claude, /\.claude-input:focus-visible[\s\S]{0,160}?border-color: var\(--claude-field-focus-border\)/)
  assert.match(claude, /\.claude-input:focus-visible[\s\S]{0,160}?box-shadow: none/)
  assert.doesNotMatch(claude, /\.claude-input:focus-visible[^}]*claude-accent-soft/)
  assert.match(claude, /\[data-pi-ui="claude"\] input:focus-visible,[\s\S]{0,100}?outline: none;/)
  const claudeRing = claude.slice(claude.indexOf("R4 a11y：作用域内可见焦点环"), claude.indexOf("v1.4：输入控件"))
  assert.doesNotMatch(claudeRing, /input:focus-visible/)

  const codex = read(`${UI}/pi/variants/codex/styles/codex.css`)
  assert.match(codex, /\[data-pi-ui="codex"\] input:focus-visible,[\s\S]{0,220}?var\(--codex-field-focus-border\)/)
  assert.doesNotMatch(codex, /--codex-focus-ring/)
  assert.doesNotMatch(codex, /\.cx-composer:focus-within\s*\{[^}]*accent/)
  // 两套变体各有一份浅 / 深中性描边值
  assert.match(read(`${UI}/pi/variants/claude/styles/tokens.css`), /--claude-field-focus-border:/)
  assert.match(read(`${UI}/pi/variants/claude/styles/dark.css`), /--claude-field-focus-border:/)
  const codexTokens = read(`${UI}/pi/variants/codex/styles/tokens.css`)
  assert.equal((codexTokens.match(/--codex-field-focus-border:/g) ?? []).length, 2)
})

test("a11y 基线：两个变体设置页/错误态不依赖鼠标（静态线索）", () => {
  const app = read(`${UI}/pi/PiApp.tsx`)
  assert.match(app, /PiVariantBoundary/)
  // 加载态/错误态都带 data-pi 标记，验证线可定位
  assert.ok(read(`${UI}/pi/PiVariantBoundary.tsx`).includes("data-pi-variant-error"))
  assert.ok(read(`${UI}/pi/variants/index.ts`).includes("data-pi-variant-loading"))
})
