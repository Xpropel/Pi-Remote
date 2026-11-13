import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// 开发画廊入口（实施计划 P2.4、D6）：gallery.html 加载，只在 PI_GALLERY=1 时进构建，不进生产包。
// 样式和新界面（src/pi/main.tsx）同一套，顺序照 replica 的 src/main.tsx：kit 补充 token → 官方 tokens（同名以官方为准）→ Tailwind + 主题映射 + 基础样式
import "../styles/tokens.local.css"
import "../styles/tokens.css"
import "../styles/index.css"
import { PiGallery } from "./PiStage"
import { piErrors, piGalleryExpose } from "./registry"

// 给截图脚本（R2/tools/ui-pi-shots.mjs）枚举屏幕；注册问题只警告，由脚本判失败
window.__PI_GALLERY__ = piGalleryExpose()
for (const e of piErrors) console.warn(`[pi registry] ${e.where}: ${e.message}`)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PiGallery />
  </StrictMode>,
)
