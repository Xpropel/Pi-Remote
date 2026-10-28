import type { PiUiSeed } from "@/pi/hooks/usePiUiState"

/*
 * #/live/<id> 的界面起始状态（plan P5.2；R2/p5-lanes.md §4）。fixture（fixtures/live/<id>.ts）只管 relay 的原始字段，
 * 菜单开着、右 pane 在哪个视图、手机在列表页这类界面状态写在这里，交给 usePiUiState 的 seed（persist: false）。
 * 本文件是外壳级的起始状态（p5-base）；各线自己的写在 seeds-<线>.ts，同 id 时线的覆盖这里的（逐层浅合并：ui → desktop / phone）。
 */

/** 一屏的起始状态：ui 两个视口都用，desktop / phone 只在对应视口上叠加 */
export interface PiLiveSeed {
  ui?: PiUiSeed
  desktop?: PiUiSeed
  phone?: PiUiSeed
}

export const LIVE_SEEDS: Record<string, PiLiveSeed> = {
  "session-list": { phone: { phonePage: "list" } },
  "new-session": { ui: { view: "new" } },
  "new-session-picker": { ui: { view: "new" } },
  settings: { ui: { view: "settings" } },
  "changes-pane": { ui: { pane: "changes" } },
  "terminal-pane": { ui: { pane: "terminal" } },
  "file-pane": { ui: { pane: "file" } },
}
