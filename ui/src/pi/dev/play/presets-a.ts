import { A_PAIRING, A_SESSION_MENU, A_SHEET_SESSION_INFO } from "./a"
import type { PlayPreset } from "./state"

/**
 * a 线的起始状态（#/play/<id>，PlayRoute 合并；同 id 时覆盖外壳的，R2/p4-lanes.md §4）。归 a 线。
 * 外壳已有 session-list、conversation、conversation-streaming、new-session、changes-pane、settings（state.ts）。
 * 线自己的起始数据按 ui.screen 在 play/a.tsx 里摆（initialA：session-search 带查询词"键盘"，session-menu 的目标是 r-s4）。
 * 手机的 sheet 和桌面的弹窗共用一个 preset：sheet 只在手机渲染，dialog 只在桌面渲染。
 */
export const PLAY_PRESETS_A: Record<string, PlayPreset> = {
  /** 标题搜索开着（桌面左栏搜索框 / 手机顶栏搜索框），查询词"键盘" */
  "session-search": { phonePage: "list" },
  /** 手机：长按 r-s4 后的会话菜单 sheet；桌面右键菜单不能预先打开，就是会话列表 */
  "session-menu": { phonePage: "list", sheet: A_SESSION_MENU },
  /** 手机：点标题后的会话信息 sheet；桌面：标题悬停卡开着 */
  "session-info": { sheet: A_SHEET_SESSION_INFO },
  /** 设备与配对弹窗（桌面 560 / 手机全高 sheet），从列表页打开 */
  "device-pairing": { phonePage: "list", dialog: A_PAIRING, sheet: A_PAIRING },
}
