import { useMemo, useState } from "react"

/**
 * 可交互路由 #/play/<id> 的界面状态（P4，R2/p4-lanes.md §4）。只用画廊数据，不接 relay；P5 的 DesktopApp / PhoneApp
 * 换成真实容器和 usePiUiState。这里的状态是外壳级的（视图、侧栏、右 pane、命令面板、回合在跑、手机页、当前 sheet / 弹窗），
 * 各线自己的菜单开合放在各自的部件或 play/<线>.tsx 里，不进这里。
 */

export type PlayView = "session" | "new" | "settings"
export type PlayPane = "changes" | "terminal" | "file" | null
export type PlayPhonePage = "list" | "chat"

export interface PlayUi {
  /** 打开时的起始状态 id（= 路由里的 <id>）；各线据此摆自己的起始数据（例如 b 线在 "approval-waiting" 上放审批卡） */
  screen: string
  view: PlayView
  /** 当前会话 */
  roomId: string
  sidebar: "expanded" | "rail"
  pane: PlayPane
  paletteOpen: boolean
  /** 回合在跑（S3，黑圆是停止） */
  running: boolean
  phonePage: PlayPhonePage
  /** 手机当前打开的 sheet / 桌面当前打开的弹窗：id 由各线自己起，带线名前缀（"a:session-info"、"c:model"） */
  sheet: string | null
  dialog: string | null
  /** 最近一次外壳动作（给人看，也给 ui-interact 的 text 断言用） */
  lastAction: string | null
}

export interface PlayActions {
  newSession(): void
  openSettings(): void
  openSession(roomId?: string): void
  toggleSidebar(): void
  togglePane(): void
  setPane(pane: PlayPane): void
  setPaletteOpen(open: boolean): void
  stop(): void
  setPhonePage(page: PlayPhonePage): void
  openSheet(id: string): void
  closeSheet(): void
  openDialog(id: string): void
  closeDialog(): void
}

/** 各线的 play 部件收到的 props */
export interface PlaySlotProps {
  ui: PlayUi
  act: PlayActions
  variant: "desktop" | "phone"
}

/** 起始状态（不含 screen，由路由填） */
export type PlayPreset = Partial<Omit<PlayUi, "screen">>

/**
 * 外壳的起始状态：id 和设计屏同名，ui-interact 的用例按屏幕 id 打开（--route "#/play/{id}?vp={vp}&theme={theme}"）。
 * 各线自己的起始状态写在 play/<线>.tsx 的 PLAY_PRESETS_<线>，PlayRoute 合并（同 id 时线的覆盖这里的）。
 */
export const PLAY_PRESETS: Record<string, PlayPreset> = {
  "session-list": { phonePage: "list" },
  conversation: {},
  "conversation-streaming": { running: true },
  "new-session": { view: "new" },
  "changes-pane": { pane: "changes" },
  settings: { view: "settings" },
}

/** 外壳原语自测页（PiDialog / PiSheet / PiMenu 的焦点进出、Esc、背后 inert），不是设计屏 */
export const PLAY_PRIMITIVES_ID = "overlays"

const BASE: Omit<PlayUi, "screen"> = {
  view: "session",
  roomId: "r-s1",
  sidebar: "expanded",
  pane: null,
  paletteOpen: false,
  running: false,
  phonePage: "chat",
  sheet: null,
  dialog: null,
  lastAction: null,
}

export function usePlayUi(screen: string, preset: PlayPreset): [PlayUi, PlayActions] {
  const [ui, setUi] = useState<PlayUi>(() => ({ ...BASE, ...preset, screen }))
  const act = useMemo<PlayActions>(() => {
    const patch = (lastAction: string, next: (ui: PlayUi) => Partial<PlayUi>) => setUi((cur) => ({ ...cur, ...next(cur), lastAction }))
    return {
      newSession: () => patch("new-session", () => ({ view: "new", pane: null, phonePage: "chat" })),
      openSettings: () => patch("settings", () => ({ view: "settings", pane: null })),
      openSession: (roomId) => patch("open-session", (cur) => ({ view: "session", roomId: roomId ?? cur.roomId, phonePage: "chat" })),
      toggleSidebar: () => patch("toggle-sidebar", (cur) => ({ sidebar: cur.sidebar === "expanded" ? "rail" : "expanded" })),
      // 右 pane 只在会话视图里有；关着时 ⌘. 打开上一次的视图（默认改动）
      togglePane: () => patch("toggle-pane", (cur) => (cur.view !== "session" ? {} : { pane: cur.pane ? null : "changes" })),
      setPane: (pane) => patch("set-pane", () => ({ pane })),
      setPaletteOpen: (paletteOpen) => patch(paletteOpen ? "open-palette" : "close-palette", () => ({ paletteOpen })),
      stop: () => patch("stop", () => ({ running: false })),
      setPhonePage: (phonePage) => patch(`phone-${phonePage}`, () => ({ phonePage })),
      openSheet: (sheet) => patch(`sheet:${sheet}`, () => ({ sheet })),
      closeSheet: () => patch("close-sheet", () => ({ sheet: null })),
      openDialog: (dialog) => patch(`dialog:${dialog}`, () => ({ dialog })),
      closeDialog: () => patch("close-dialog", () => ({ dialog: null })),
    }
  }, [])
  return [ui, act]
}
