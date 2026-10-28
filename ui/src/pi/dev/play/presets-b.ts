import type { PlayPreset } from "./state"

/**
 * b 线的起始状态（#/play/<id>，PlayRoute 合并；同 id 时覆盖外壳的，R2/p4-lanes.md §4）。归 b 线。
 * 外壳已有 session-list、conversation、conversation-streaming、new-session、changes-pane、settings（state.ts）。
 * 线自己的起始数据按 ui.screen 在 play/b.tsx 里摆。
 */

/** b 区的 sheet / 弹窗 id（act.openSheet / openDialog；带线名前缀） */
export const B_SHEET_TASKS = "b:tasks"
export const B_LIGHTBOX = "b:lightbox"

export const PLAY_PRESETS_B: Record<string, PlayPreset> = {
  /** 右 pane 开在文件视图（页签可切到改动 / 终端） */
  "file-pane": { pane: "file" },
  /** 右 pane 开在终端视图，回合在跑 */
  "terminal-pane": { pane: "terminal", running: true },
  /** 等你回答：回合在跑（流末尾不画运行行）；审批卡在 dock 里，由 c 线的 PlayDock 摆 play/b.tsx 的 PlayApproval */
  "approval-waiting": { running: true },
  /** 任务面板：手机一打开就是半高 sheet（桌面的 tray 上方浮层归 c 线） */
  "task-panel": { running: true, sheet: B_SHEET_TASKS },
  /** 用户卡里三张图，点哪张开哪张（灯箱） */
  lightbox: {},
  /** 流在长：回合在跑，每 0.6 秒追加一条（最多 40 条），测吸底跟随、上滑松开、新消息计数 */
  "stream-grow": { running: true },
  /** 1 万条的长会话：渲染窗 300 条 +「显示更早的 300 条」 */
  "long-transcript": {},
}
