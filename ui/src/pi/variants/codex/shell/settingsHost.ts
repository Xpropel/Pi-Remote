import type { PiContainerProps } from "@/pi/containers/types"
import type { VariantAppProps } from "@/pi/variants/types"

/**
 * 统一设置页 v2 的 Codex 宿主适配（只做动作转接，不改设置页内部）。
 *
 * 设置页「配对新设备 / 重新配对」走共享的 `PI_UI_IDS.pairing`（"a:pairing"），
 * 而 Codex 的配对弹窗由 CodexDesktop / CodexPhone 各自的 `overlay.pairing` 布尔状态托管。
 * 这里把共享 id 换到 Codex 自己的浮层，设置页仍然留在原位，配对弹窗压在它上面。
 *
 * 不 import `@/pi/containers/types` 的值（变体独立性守卫只允许 import type），
 * 共享 id 用字符串常量固定，与 containers/types.ts 的 PI_UI_IDS.pairing 对齐。
 */
export const SHARED_SETTINGS_PAIRING_OVERLAY = "a:pairing"

/** 给设置页用的 p：桌面 openDialog / 手机 openSheet 遇到共享配对 id 时改开 Codex 配对。 */
export function codexSettingsHostProps(
  props: VariantAppProps,
  variant: "desktop" | "phone",
  onPairing: () => void,
): PiContainerProps {
  type Overlay = { id: string; arg?: string }
  const route = (overlay: Overlay, open: (overlay: Overlay) => void) => {
    if (overlay.id === SHARED_SETTINGS_PAIRING_OVERLAY) {
      onPairing()
      return
    }
    open(overlay)
  }
  return {
    relay: props.relay,
    ui: props.ui,
    keyboardOpen: props.keyboardOpen,
    variant,
    act: {
      ...props.act,
      openDialog: (overlay) => route(overlay, props.act.openDialog),
      openSheet: (overlay) => route(overlay, props.act.openSheet),
    },
  }
}
