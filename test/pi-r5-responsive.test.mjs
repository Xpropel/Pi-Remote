// R5 P1 响应式回归：cursor 大屏版心分级 + headless root dvh 兜底 + gallery 对图舞台展示外框（仅 dev 工装）。
// 静态扫描：这些是 CSS / dev 组件契约，浏览器实测由 verify 的 round7-regress 覆盖。
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")

test("cursor 产品模式正文版心：1440 基准 768 不变，≥1680 逐级放宽且只作用产品 cursor", () => {
  const css = read("ui/src/components/pi/shared/pi-theme.css")
  assert.match(css, /--cw-pi-chat-max-w:\s*768px/)
  const steps = ["1680:832", "1920:880", "2560:960", "3200:1040"]
  for (const s of steps) {
    const [w, px] = s.split(":")
    const re = new RegExp(`@media \\(min-width: ${w}px\\) \\{\\s*\\[data-pi-root\\]\\[data-pi-ui="cursor"\\]\\[data-pi-mode="product"\\] \\{\\s*--cw-pi-chat-max-w: ${px}px;`)
    assert.match(css, re, `缺 ${w}px → ${px}px 的产品 cursor 覆盖`)
  }
  // 1440 设计基准必须落在第一档之下（P9 对图/几何断言不受影响）
  assert.ok(1680 > 1440)
})

test("headless 产品根 dvh 兜底：不支持 dvh 时用 100vh（键盘态不覆盖）", () => {
  const css = read("ui/src/pi/styles/base.css")
  assert.match(css, /@supports not \(height: 100dvh\)/)
  assert.match(css, /\[data-pi-root\]\[data-pi-mode="product"\]:not\(\[data-pi-keyboard\]\)/)
  assert.match(css, /height: 100vh !important/)
})

test("gallery 对图舞台：固定尺寸路由统一套 PiDevStageFrame；窗口=舞台尺寸时无外框（截图不变）", () => {
  const stage = read("ui/src/pi/dev/PiStage.tsx")
  assert.match(stage, /import \{ PiDevStageFrame \} from "\.\/StageFrame"/)
  for (const kind of ["case \"pi\"", "case \"play\"", "case \"p4\"", "case \"live\""]) assert.ok(stage.includes(kind), kind)
  assert.equal(stage.split("<PiDevStageFrame").length - 1 >= 4, true, "pi/play/p4/live 都要套外框")
  assert.match(stage, /data-pi-stage-note/)
  const frame = read("ui/src/pi/dev/StageFrame.tsx")
  assert.match(frame, /非产品响应式/)
  assert.match(frame, /winW !== size\.width \|\| winH !== size\.height/)
  assert.match(frame, /data-pi-stage-frame-chrome/)
  assert.match(frame, /产品 UI 是响应式的/)
  assert.match(frame, /index\.html/)
})

test("gallery stage 模式不读产品版心覆盖（对图仍 768）", () => {
  const css = read("ui/src/components/pi/shared/pi-theme.css")
  // 覆盖选择器必须含 data-pi-mode=product；stage 根没有该属性 → 不匹配
  for (const line of css.split("\n").filter((l) => l.includes("--cw-pi-chat-max-w") && l.includes("px"))) {
    if (line.trim().startsWith("--cw-pi-chat-max-w: 768px")) continue
    assert.match(line, /\[data-pi-mode="product"\]|--cw-pi-chat-max-w/, line)
  }
})
