/**
 * 外壳级的快捷键接线（PLAN 4.2；design B14、§1.10、K06）：usePiShortcuts + 浮层登记表。
 *
 * 桌面外壳（P4 的可交互路由、P5 的 DesktopApp）在 PiLayerProvider 里调用一次：
 *   - escState.menuOpen / overlayOpen 来自 usePiLayerState()（可交互的 PiMenu、PiSheet、PiDialog、悬停卡会自动登记；
 *     自己实现的菜单 / 面板用 usePiLayer 登记）；
 *   - Esc 第 1 / 2 层 = 关掉最后打开的菜单 / 浮层（closeTop）；Radix 原语自己先关并 preventDefault，这里不会再关一层；
 *   - Esc 第 3 层 = onStop，只在 canStop 时（调用方用 composerBlockOf(state, blockedBy) 算：button.variant === "stop" 或 ghostStop）；
 *   - 五个 ⌘ 组合在有菜单 / 浮层开着时不触发（shortcuts.ts 的 piShortcutAllowed）。
 * 手机不挂：enabled 传 false。
 */
import { usePiLayerState } from "@/components/pi/shared/layers"
import { usePiShortcuts, type PiShortcutHandlers } from "./usePiShortcuts.ts"
import type { PiPlatform } from "../model/shortcuts.ts"

export interface UsePiShellShortcutsOptions extends Omit<PiShortcutHandlers, "onCloseMenu" | "onCloseOverlay"> {
  enabled: boolean
  /** 现在能不能停止生成（S3 黑圆停止、S4 裸停止） */
  canStop: boolean
  platform?: PiPlatform
  isComposerElement?: (element: Element) => boolean
}

export function usePiShellShortcuts({ enabled, canStop, platform, isComposerElement, ...handlers }: UsePiShellShortcutsOptions): void {
  const layers = usePiLayerState()
  usePiShortcuts({
    ...handlers,
    enabled,
    platform,
    isComposerElement,
    escState: { menuOpen: layers.menuOpen, overlayOpen: layers.overlayOpen, canStop },
    onCloseMenu: () => {
      layers.closeTop("menu")
    },
    onCloseOverlay: () => {
      layers.closeTop("overlay")
    },
  })
}
