import type { ReactNode } from "react"
import type { PiUi, PiUiActions, PiUiOverlay } from "@/pi/hooks/usePiUiState"
import type { Relay } from "@/relay/useRelay"

/*
 * 容器的公共契约（plan §7.0、P5.3–5.5；p5-base 定，R2/p5-lanes.md §2）。
 * 数据怎么流：useRelay() 只在 PiApp 里调一次 → 容器从 relay 里取自己那一片 → pi/model 的纯函数 → 部件的 props。部件不认识 relay（D10）。
 * 本文件归 p5-base：各线只读；要改写 R2/lane-requests/p5-<线>.md。
 */

export type { Relay }

export type PiVariant = "desktop" | "phone"

/** PiAppBody 交给 DesktopApp / PhoneApp 的 */
export interface PiAppProps {
  relay: Relay
  ui: PiUi
  act: PiUiActions
  /** 手机键盘开着（产品：P6.1 接 useMobileViewport；开发画廊 #/live：屏幕的 keyboard 标记）。桌面恒为 false */
  keyboardOpen: boolean
}

/** 所有容器收到的 props */
export interface PiContainerProps extends PiAppProps {
  variant: PiVariant
}

/**
 * 外壳（a 线，DeviceOfflineContainer）按设备 / 房间状态算好、交给对话流（b）和 composer（c）的附加内容。
 * 例：设备离线时流顶"ThinkPad 未连接，只能看历史"、桌面状态行右端的 attach 命令复制框、手机状态行下的整宽复制框。
 */
export interface PiSessionExtras {
  /** 对话流顶部的说明行（PiTranscript 的 topLine） */
  topLine?: ReactNode
  /** composer 状态行右端（PiComposerDock 的 statusTrailing，桌面） */
  statusTrailing?: ReactNode
  /** composer 状态行下的整宽复制框（PiStatusRowData.copy，手机） */
  statusCopy?: string
}

/**
 * 跨线打开的浮层 id（PiUi 的 menu / sheet / dialog）。只在一条线里用的 id 写在那条线自己的文件里，带线名前缀。
 * 弹窗类的约定：桌面 act.openDialog、手机 act.openSheet（PiDialog 在 390 下就是全高 sheet，要放进 PiPhonePage 的 sheet 槽），
 * 用下面的 openPiDialog / piDialogOf / closePiDialog，不用自己分支。arg = 作用的对象（会话 id 等）。
 */
export const PI_UI_IDS = {
  /** 改名 / 删除确认（a：SessionMenuContainer）。c 的命令面板可以开 */
  rename: "a:rename",
  delete: "a:delete",
  /** 定时消息列表弹层（a：SessionMenuContainer，设计 D §3.7 房级管理）。会话菜单的"定时消息（N）"开它 */
  schedules: "a:schedules",
  /** 设备与配对（a：PairingContainer）。c 的设置页、设备菜单里的"配对新设备…"开它 */
  pairing: "a:pairing",
  /** 任务面板（b：TaskPanelContainer）。c 的 tray "任务 n/m"：桌面 act.openMenu（dock 的 panel 槽），手机 act.openSheet */
  tasks: "b:tasks",
  /** 显示选项（c：DisplayOptionsContainer）。桌面是 PiSidebar 的 optionsMenu（锚定菜单，不走 id）；手机 a 的账户栏滑杆 act.openSheet 它 */
  displayOptions: "c:display-options",
  /** 弹窗家族（c：DialogsContainer，plan 5.5、design §2 H）。a 的会话菜单、c 的斜杠命令 / 命令面板都能开 */
  usage: "c:usage",
  regenerate: "c:regenerate",
  compact: "c:compact",
  fork: "c:fork",
  clone: "c:clone",
  tree: "c:tree",
  export: "c:export",
  hostSettings: "c:host-settings",
  systemPrompt: "c:system-prompt",
  tools: "c:tools",
  sessionState: "c:session-state",
  inspect: "c:inspect",
  /** 主机诊断（c：HostDiagContainer，design B07「设置 › 设备 › 某台 › 诊断」）：arg = 设备 id。设置页的设备行开它 */
  hostDiag: "c:host-diag",
} as const

/** 部件的 viewport（布局）：PiVariant 的取值就是 PiLayout，换算统一在 shared/viewport.ts */
export { piLayoutOf } from "@/components/pi/shared/viewport"

/** 开一个弹窗类浮层：桌面 dialog 槽，手机 sheet 槽 */
export function openPiDialog(p: Pick<PiContainerProps, "act" | "variant">, overlay: PiUiOverlay): void {
  if (p.variant === "phone") p.act.openSheet(overlay)
  else p.act.openDialog(overlay)
}

/** 当前开着的弹窗类浮层（桌面读 dialog，手机读 sheet） */
export function piDialogOf(p: Pick<PiContainerProps, "ui" | "variant">): PiUiOverlay | null {
  return p.variant === "phone" ? p.ui.sheet : p.ui.dialog
}

export function closePiDialog(p: Pick<PiContainerProps, "act" | "variant">): void {
  if (p.variant === "phone") p.act.closeSheet()
  else p.act.closeDialog()
}
