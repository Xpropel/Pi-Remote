/**
 * 平板档（视口 768–1023）桌面外壳的侧栏浮层。
 *
 * 这个宽度下侧栏默认收成 56 窄栏，展开时盖在正文上，点外面 / Esc / 打开会话后收回。
 * 浮层开关只是界面上的临时状态：不进偏好、不持久化；桌面档（≥ 1024）的展开 / 收起偏好
 * （prefs.sidebarCollapsed）在平板档上不读也不写，回到桌面宽度时仍按用户自己的选择。
 *
 * 桌面外壳（DesktopApp）按平板档摆时 active = true。「切换侧栏」的所有入口（侧栏按钮、⌘B、
 * 命令面板、设置里改过的快捷键）都经 toggleSidebarOrDrawer 分流，所以只在这里判断一次。
 */
import { useSyncExternalStore } from "react"
import { bpOf } from "../../shell/breakpoints.ts"

export interface SidebarDrawerState {
  /** 桌面外壳正按平板档摆（侧栏 = 窄栏 + 浮层） */
  active: boolean
  /** 浮层开着 */
  open: boolean
}

/** 容器拿到的浮层控制：只在平板档传；不传 = 桌面档，侧栏按偏好展开 / 收起 */
export interface SidebarDrawerControl {
  open: boolean
  toggle: () => void
  close: () => void
}

const IDLE: SidebarDrawerState = Object.freeze({ active: false, open: false })
let state: SidebarDrawerState = IDLE
const listeners = new Set<() => void>()

function commit(next: SidebarDrawerState): void {
  if (next.active === state.active && next.open === state.open) return
  state = next.active || next.open ? Object.freeze(next) : IDLE
  for (const listener of [...listeners]) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function sidebarDrawerState(): SidebarDrawerState {
  return state
}

/** 平板档：视口宽 768–1023（断点 sm）。 */
export function isTabletWidth(width: number): boolean {
  return bpOf(width) === "sm"
}

/** 桌面外壳进 / 出平板档；离开时浮层一并收起。 */
export function setSidebarDrawerActive(active: boolean): void {
  commit({ active, open: active && state.open })
}

/** 开 / 关浮层；不在平板档时什么都不做。 */
export function setSidebarDrawerOpen(open: boolean): void {
  if (state.active) commit({ active: true, open })
}

/** 「切换侧栏」：平板档开关浮层，其余宽度交给桌面偏好（toggleDesktop）。 */
export function toggleSidebarOrDrawer(toggleDesktop: () => void): void {
  if (state.active) commit({ active: true, open: !state.open })
  else toggleDesktop()
}

export function useSidebarDrawer(): SidebarDrawerState {
  return useSyncExternalStore(subscribe, sidebarDrawerState, () => IDLE)
}
