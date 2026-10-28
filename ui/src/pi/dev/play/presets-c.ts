import type { PlayPreset } from "./state"

/**
 * c 线的起始状态（#/play/<id>，PlayRoute 合并；同 id 时覆盖外壳的，R2/p4-lanes.md §4）。归 c 线。
 * 外壳已有 session-list、conversation、conversation-streaming、new-session、changes-pane、settings（state.ts）。
 * 线自己的起始数据按 ui.screen 在 play/c.tsx 的 initialState 里摆（排队面板开着、用量弹窗开着、目录菜单开着）。
 * id 和 c 区设计屏同名；手机的 sheet id 见 play/c.tsx 的 C_SHEET_*。
 */
export const PLAY_PRESETS_C: Record<string, PlayPreset> = {
  /** 运行中，tray 多一颗"排队 2"，排队面板开着（桌面 tray 上方浮层 / 手机半高 sheet） */
  "queue-panel": { running: true, sheet: "c:queue" },
  /** 命令面板开着（桌面 PiOverlay / 手机全高 sheet） */
  "command-palette": { paletteOpen: true },
  /** 用量与费用弹窗开着 */
  "dialog-usage": {},
  /** 新建会话，目录选择开着（桌面锚定菜单 / 手机 sheet） */
  "new-session-picker": { view: "new", sheet: "c:new-folder" },
  /** 手机列表页 + 显示选项 sheet（桌面的入口在账户区滑杆，a 线接） */
  "quick-settings": { phonePage: "list", sheet: "c:display-options" },
}
