import { PI_UI_IDS } from "@/pi/containers/types"
import { VIEWPORT_PATH } from "../fixtures/shared"
import type { PiLiveSeed } from "./seeds"

/*
 * b 线 9 屏的界面起始状态（#/live，R2/p5-lanes.md §4）：conversation、conversation-streaming、approval-waiting、stream-errors、
 * session-archived、changes-pane、terminal-pane、file-pane、task-panel。
 * 只写界面状态；relay 的原始字段改 fixtures/live/<id>.ts（会改 L2，写进 b 线日志）。
 * - file-pane：右 pane 开在文件视图（外壳 seeds.ts 已给 pane: "file"），文件 = 从流里点开的 useMobileViewport.ts。
 * - task-panel：tray "任务 2/4" 选中、面板开着 —— 桌面是 tray 上方的浮层（ui.menu），手机是半高 sheet（ui.sheet）。
 */
export const LIVE_SEEDS_B: Record<string, PiLiveSeed> = {
  "file-pane": { ui: { file: VIEWPORT_PATH } },
  "task-panel": { desktop: { menu: { id: PI_UI_IDS.tasks } }, phone: { sheet: { id: PI_UI_IDS.tasks } } },
}
