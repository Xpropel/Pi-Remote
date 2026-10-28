import type { VariantAppProps } from "@/pi/variants/types"
import { CodexPhoneBar } from "../chrome/CodexTitleBar"
import { CodexReviewPanel } from "../panels/CodexReviewPanel"

/** 手机右栏 = 整页推入（X-04-4）：顶页签在 CodexReviewPanel 内、‹ 返回在顶栏 */
export function CodexPhonePanel({ p, onBack }: { p: VariantAppProps; onBack: () => void }) {
  return (
    <div className="cx-phone-page" data-pi-ui-part="page" data-p4-surface="CX-PHONE-PANEL" data-p4-ready="">
      <CodexPhoneBar title="审查" onBack={onBack} />
      <div className="cx-phone-panel">
        <CodexReviewPanel p={p} phone />
      </div>
    </div>
  )
}
