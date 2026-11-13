// P2.5 headless 基础设施（无视觉的根 / 视口 / frame）与 cursor PiRoot 复用回归。
// 原在 pi-ui-independence.test.mjs；变体独立性守卫随 Claude / Codex 皮肤一并移除，这里只保留与 Cursor 界面相关的结构检查。
import test, { describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { PI_SAFE_AREA, PI_KEYBOARD_HEIGHT, PI_STAGE_HEIGHT, piRootGeometry } from "../ui/src/pi/headless/geometry.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const HEADLESS = path.join(ROOT, "ui/src/pi/headless")
/** 去掉 /* *\/ 和 // 注释（不碰字符串里的 "https://"） */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), "utf8")

describe("headless：根 / 视口 / frame", () => {
  const headlessFiles = ["frame.ts", "geometry.ts", "root.tsx", "index.ts"]
  const headlessSource = (name) => stripComments(fs.readFileSync(path.join(HEADLESS, name), "utf8"))

  test("headless 模块文件齐全，index.ts 导出 frame / geometry / root", () => {
    for (const name of headlessFiles) assert.ok(fs.existsSync(path.join(HEADLESS, name)), `缺 ui/src/pi/headless/${name}`)
    const index = headlessSource("index.ts")
    for (const part of ["./frame", "./geometry", "./root"]) assert.ok(index.includes(part), `index.ts 缺 ${part} 导出`)
  })

  test("headless 无视觉：不 import CSS / cursor 组件 / kit，不声明 --cw-* token", () => {
    for (const name of headlessFiles) {
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
    // data-pi-ui（pi-theme.css 产品模式宽度规则按 "cursor" 命中）/ data-pi-theme / data-pi-layout / data-pi-mode 写在根节点上
    assert.match(src, /data-pi-ui=\{ui\}/)
    assert.match(src, /data-pi-theme=\{theme\}/)
    assert.match(src, /data-pi-layout=\{viewport\}/)
    assert.match(src, /data-pi-mode=\{product \? "product" : undefined\}/)
    assert.match(src, /PiFrameContext\.Provider value=\{geometry\.frame\}/)
    // 无视觉：headless 不定义任何 class 名 / 不 import CSS
    assert.doesNotMatch(src, /from\s+"[^"]+\.css"/)
    assert.doesNotMatch(src, /className="[^"]+"/)
  })

  test("cursor 的 PiRoot 复用 headless：布局逻辑委托、DOM/类名零回归", () => {
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

  test("cursor 回归：pi-theme.css 的根几何规则仍在（headless 的行内值只是同值覆盖，原有 CSS 兜底不变）", () => {
    const css = stripComments(read("ui/src/components/pi/shared/pi-theme.css"))
    assert.match(css, /\[data-pi-root\]\[data-pi-mode="product"\] \{\s*position: fixed;/)
    assert.match(css, /height: 100vh;/)
    assert.match(css, /@supports \(height: 100dvh\)/)
  })
})
