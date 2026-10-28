import { createRoot } from "react-dom/client"
import { UsagePreview, usagePreviewParamsOf } from "./UsagePreview.tsx"

/** dev-only 独立整窗预览：`/src/pi/dev/usage/dev-preview.html?usage=…&fixture=…&theme=…&host=…&metric=…&view=…&reason=…` */
const params = usagePreviewParamsOf(new URLSearchParams(window.location.search))
document.documentElement.dataset.piTheme = params.theme
createRoot(document.getElementById("root")!).render(<UsagePreview params={params} fill={false} />)
