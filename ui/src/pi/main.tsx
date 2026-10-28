import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// 顺序照 replica 的 src/main.tsx：kit 补充 token → 官方 tokens（同名以官方为准）→ Tailwind + 主题映射 + 基础样式
import "./styles/tokens.local.css"
import "./styles/tokens.css"
import "./styles/index.css"
import PiApp from "./PiApp"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PiApp />
  </StrictMode>,
)
