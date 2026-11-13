/**
 * UI entry contract. The product ships exactly one interface, the Cursor style
 * (light / dark / follow-system themes), entered via `./cursor/CursorApp`.
 *
 * `PiUiVariant` is narrowed to the single value "cursor": PiRoot's `ui` prop and
 * the composer's CPrefs still carry the field, and the runtime value has been
 * constantly "cursor" since the Claude/Codex shells were removed.
 * Stored `ui: "claude" | "codex"` values from older versions are dropped by the
 * migration in model/prefs.ts — no error, no version bump.
 */
import type { PiDeviceFrame } from "@/components/pi/shared/frame"
import type { PiTheme } from "@/components/pi/shared/viewport"
import type { PiAppProps, PiVariant } from "@/pi/containers/types"

export type PiUiVariant = "cursor"

/** 旧设置页（components/pi/composer/PiSettingsPage）「界面」卡片的元数据 */
export interface PiUiVariantMeta {
  id: PiUiVariant
  label: string
  description: string
  /** 稳定 data-testid，固定为 `pi-ui-variant-<id>` */
  testId: string
}

export const PI_UI_VARIANT_LIST: readonly PiUiVariantMeta[] = [
  { id: "cursor", label: "Cursor", description: "浅色 / 深色跟随主题设置", testId: "pi-ui-variant-cursor" },
]

/**
 * 界面入口收到的 props：= PiAppProps（relay / ui / act / keyboardOpen，由 PiApp 只创建一份）+ 展示层需要的三项。
 */
export interface VariantAppProps extends PiAppProps {
  /** usePiTheme 解析后的实际主题（light / dark）；根节点写 data-pi-theme 用 */
  theme: PiTheme
  /** 布局：1024 断点，取值同 PiAppBody 内部分支（桌面 / 手机外壳） */
  layout: PiVariant
  /** 产品模式的视口帧（PiApp / 画廊 vp=device）；开发画廊舞台不传 = PiRoot 走舞台模式 */
  device?: PiDeviceFrame
}
