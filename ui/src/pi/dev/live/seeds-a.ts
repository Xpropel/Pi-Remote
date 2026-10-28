import { A_SESSION_INFO } from "@/pi/containers/SessionInfoContainer"
import { A_SESSION_MENU } from "@/pi/containers/SessionMenuContainer"
import { PI_UI_IDS } from "@/pi/containers/types"
import type { PiLiveSeed } from "./seeds"

/*
 * a 线 11 屏的界面起始状态（#/live，R2/p5-lanes.md §4）：login、boot-loading、session-list、session-search、session-menu、
 * session-info、no-devices、reconnecting、device-offline、device-pairing、background-alerts。
 * 只写界面状态；relay 的原始字段改 fixtures/live/<id>.ts（会改 L2，写进 a 线日志）。
 * 没写的屏不用起始状态：login（没有 token）、boot-loading（首次连接，手机自动是列表页）、no-devices（没有会话，手机自动是列表页）、
 * reconnecting / device-offline / background-alerts（当前会话的对话页）；session-list 的手机列表页在外壳级 seeds.ts。
 */
export const LIVE_SEEDS_A: Record<string, PiLiveSeed> = {
  // 查询"键盘"（静态态的 SearchContainer 会顺带发一次正文搜索 = 画廊屏"已点过在正文中搜索"）
  "session-search": { ui: { search: "键盘" } },
  // 对 r-s4 打开会话菜单：桌面右键菜单（静态态由 SessionMenuContainer 按画廊屏摆在行旁边），手机列表页长按出 sheet
  "session-menu": {
    desktop: { menu: { id: A_SESSION_MENU, arg: "r-s4" } },
    phone: { phonePage: "list", sheet: { id: A_SESSION_MENU, arg: "r-s4" } },
  },
  // r-s1 的会话信息：桌面标题悬停卡钉开，手机点标题出的 sheet
  "session-info": {
    desktop: { menu: { id: A_SESSION_INFO } },
    phone: { sheet: { id: A_SESSION_INFO } },
  },
  // 设备与配对：桌面弹窗压在会话上，手机是列表页上的全高 sheet（从设置进来，齿轮按下）
  "device-pairing": {
    desktop: { dialog: { id: PI_UI_IDS.pairing } },
    phone: { phonePage: "list", sheet: { id: PI_UI_IDS.pairing } },
  },
}
