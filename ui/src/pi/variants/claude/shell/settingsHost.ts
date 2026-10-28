import type { PiContainerProps } from "@/pi/containers/types"
import { CLAUDE_OVERLAY } from "../overlays/ids"

/**
 * 统一设置页 v2 的 Claude 宿主适配（只做动作转接，不改设置页内部）。
 *
 * 设置页「配对新设备 / 重新配对」走共享的 `PI_UI_IDS.pairing`（"a:pairing"），
 * 而 Claude 浮层只认自己的 `CLAUDE_OVERLAY.pairing`。这里在设置页宿主这一层把 id
 * 换成 Claude 自己的配对弹窗，返回 / 关闭仍由设置页与浮层各自处理。
 *
 * 不 import `@/pi/containers/types` 的值（变体独立性守卫只允许 import type），
 * 所以共享 id 用注释固定在这里的字符串常量，与 containers/types.ts 的 PI_UI_IDS.pairing 对齐。
 */
export const SHARED_SETTINGS_PAIRING_OVERLAY = "a:pairing"

type Overlay = { id: string; arg?: string }

function mapOverlay(overlay: Overlay): Overlay {
  return overlay.id === SHARED_SETTINGS_PAIRING_OVERLAY ? { ...overlay, id: CLAUDE_OVERLAY.pairing } : overlay
}

/** 给设置页用的 p：桌面 openDialog / 手机 openSheet 都换成 Claude 自己的配对浮层。 */
export function claudeSettingsHostProps(p: PiContainerProps): PiContainerProps {
  return {
    ...p,
    act: {
      ...p.act,
      openDialog: (overlay) => p.act.openDialog(mapOverlay(overlay)),
      openSheet: (overlay) => p.act.openSheet(mapOverlay(overlay)),
    },
  }
}
