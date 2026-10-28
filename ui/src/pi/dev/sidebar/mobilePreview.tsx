import { createRoot } from "react-dom/client"
import { MobilePreviewEntry } from "./MobilePreviewPage.tsx"
import { p11PreviewParamsOf } from "./fixtures.ts"

/** dev-only：P11 移动双模式预览。`/src/pi/dev/sidebar/mobile-dev-preview.html?...` */
const raw = new URLSearchParams(window.location.search)
raw.set("surface", "mobile")
const params = p11PreviewParamsOf(raw)
document.documentElement.dataset.piTheme = params.theme
createRoot(document.getElementById("root")!).render(<MobilePreviewEntry params={params} />)
