import type { VariantAppProps } from "@/pi/variants/types"
import { CodexComposer } from "../composer/CodexComposer"

/** 手机 composer 容器（§2.5：25 圆角、控件 28、黑圆发送、触控 ≥44；距底 16 + 安全区由外壳给） */
export function CodexPhoneComposer({ p }: { p: VariantAppProps }) {
  return (
    <div className="cx-phone-dock" data-pi-ui-part="composer">
      <CodexComposer p={p} phone />
    </div>
  )
}
