import { C_IDS } from "@/pi/containers/cShared"
import { PI_UI_IDS } from "@/pi/containers/types"
import type { PiLiveSeed } from "./seeds"

/*
 * c 线 12 屏的界面起始状态（#/live，R2/p5-lanes.md §4）：new-session、new-session-picker、composer-keyboard、slash-menu、mention-menu、
 * attach-menu、model-menu、queue-panel、command-palette、dialog-usage、settings、quick-settings。
 * 只写界面状态（哪个菜单 / sheet / 弹窗开着、模型菜单悬停哪一行）；草稿、引用、待发图这些 relay 原始字段在 fixtures/live/<id>.ts。
 * 没写的屏：composer-keyboard / slash-menu / mention-menu 的菜单由草稿打开；new-session / settings 的视图在外壳级 seeds.ts。
 */
export const LIVE_SEEDS_C: Record<string, PiLiveSeed> = {
  "new-session-picker": { desktop: { menu: { id: C_IDS.newFolder } }, phone: { sheet: { id: C_IDS.newFolder } } },
  "attach-menu": { desktop: { menu: { id: C_IDS.plus } }, phone: { sheet: { id: C_IDS.plus } } },
  // 桌面悬停 Gemini 2.5 Pro（出费用说明卡，同画廊屏 c/model-menu 的 hoverKey）
  "model-menu": { desktop: { menu: { id: C_IDS.model, arg: "google/gemini-2.5-pro" } }, phone: { sheet: { id: C_IDS.model } } },
  "queue-panel": { desktop: { menu: { id: C_IDS.queue } }, phone: { sheet: { id: C_IDS.queue } } },
  "command-palette": { ui: { paletteOpen: true } },
  "dialog-usage": { desktop: { dialog: { id: PI_UI_IDS.usage, arg: "r-s1" } }, phone: { sheet: { id: PI_UI_IDS.usage, arg: "r-s1" } } },
  // 桌面：账户区滑杆的显示选项菜单开着；手机：列表页 + 显示选项 sheet
  "quick-settings": { desktop: { menu: { id: PI_UI_IDS.displayOptions } }, phone: { phonePage: "list", sheet: { id: PI_UI_IDS.displayOptions } } },
}
