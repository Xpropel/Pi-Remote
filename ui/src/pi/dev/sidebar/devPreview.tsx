import { createRoot } from "react-dom/client"
import { SidebarPreview } from "./SidebarPreview.tsx"
import { p11PreviewParamsOf } from "./fixtures.ts"

/** dev-only：P11 统一侧栏预览（六套合板 / 单套可交互）。`/src/pi/dev/sidebar/dev-preview.html?...` */
const params = p11PreviewParamsOf(new URLSearchParams(window.location.search))
document.documentElement.dataset.piTheme = params.theme
createRoot(document.getElementById("root")!).render(<SidebarPreview params={params} />)
