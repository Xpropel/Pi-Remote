/**
 * 手机导航（PLAN 6.2，a 线；design §4.1、J08；R2/p6-lanes.md §2.5）：页面与浏览器历史栈的对应。纯函数，node --test 直接加载。
 * - 路由只有两种（mobile/model.ts 的 MobileRoute：index / conversation，URL 上是 ?device=&session=），由 useMobileNavigation 管
 *   pushState / popstate 和弹层哨兵。
 * - 推入页（新会话、设置、终端 / 改动 / 文件）不改 URL：和 sheet、命令面板一样算"一层弹层"进历史（overlayCount），
 *   系统返回从最上面一层关起（sheet → 命令面板 → 推入页）。
 * - 渲染仍以 usePiUiState 的 phonePage / view / pane 为准；这里只算"现在是哪一页""历史该怎么动""界面该怎么跟"。
 */
import type { MobileRoute } from "../../mobile/model.ts"

/** 手机上的页面：列表页、对话页，以及推入页（新会话/设置/收件箱/右 pane） */
export type PiPhonePageKey = "list" | "chat" | "new" | "settings" | "pane" | "inbox"
/** 推入页下面那一页 */
export type PiPhoneBase = "list" | "chat"
/** 历史栈里的弹层 */
export type PiPhoneLayer = "push" | "palette" | "sheet"

/** 同 model/boot.ts 的 PiBootView.kind */
export type PiPhoneBoot = "connecting" | "no-devices" | "all-offline" | "ready"

export interface PiPhonePageInput {
  boot: PiPhoneBoot
  view: "session" | "new" | "settings" | "inbox"
  pane: string | null
  phonePage: "list" | "chat"
  search: string | null
  roomId: string
  /** 导航正在找深链 / 前进到的会话（relay 还没切过去）：画对话页的"正在打开会话…" / "会话不可用" */
  opening?: boolean
}

/**
 * 现在是哪一页（P5 PhoneApp 的分支原样搬来，加上 opening）。
 *
 * P12 修复（评审总-高-5）：**推入页（新建/设置）不受连接状态影响**——手机冷启动连不上 relay 时
 * `boot=connecting/no-devices` 仍必须能进设置/新建；connecting 只压对话页（退回列表），
 * 不能连推入页一起吞掉。pane 是对话页的一层，仍跟着对话页受 connecting 压制。
 */
export function phonePageOf(i: PiPhonePageInput): PiPhonePageKey {
  if (i.view === "new") return "new"
  if (i.view === "settings") return "settings"
  if (i.view === "inbox") return "inbox"
  if (i.boot !== "connecting" && !i.opening && i.pane && i.roomId && i.phonePage === "chat") return "pane"
  if (i.opening) return "chat"
  if (i.boot === "connecting" || i.boot === "no-devices" || !i.roomId || i.phonePage === "list" || i.search != null) return "list"
  return "chat"
}

export function isPhonePushPage(page: PiPhonePageKey): page is "new" | "settings" | "pane" | "inbox" {
  return page === "new" || page === "settings" || page === "pane" || page === "inbox"
}

/** 页面深度：转场方向按它定（变深 = 推入，变浅 = 返回） */
export function phonePageDepth(page: PiPhonePageKey): number {
  return page === "list" ? 0 : page === "chat" ? 1 : 2
}

/** 推入页下面那一页，按界面状态推断（开发路由的起始状态直接是推入页、之前没有画过别的页时用） */
export function phoneBaseOf(i: Pick<PiPhonePageInput, "boot" | "phonePage" | "roomId">): PiPhoneBase {
  return i.phonePage === "chat" && !!i.roomId && i.boot !== "connecting" && i.boot !== "no-devices" ? "chat" : "list"
}

/** 历史栈里开着的弹层，从下到上：推入页 → 命令面板 → sheet（系统返回关最上面一层） */
export function phoneLayersOf(i: { page: PiPhonePageKey; paletteOpen: boolean; sheet: boolean }): PiPhoneLayer[] {
  const out: PiPhoneLayer[] = []
  if (isPhonePushPage(i.page)) out.push("push")
  if (i.paletteOpen) out.push("palette")
  if (i.sheet) out.push("sheet")
  return out
}

/** 界面所在的路由：对话页 = 当前会话，其余 = 列表 */
export function phoneRouteOf(base: PiPhoneBase, roomId: string, deviceId?: string | null): MobileRoute {
  if (base !== "chat" || !roomId) return { screen: "index" }
  return deviceId ? { screen: "conversation", sessionId: roomId, deviceId } : { screen: "conversation", sessionId: roomId }
}

/** 两个路由是不是同一屏（同一个会话就算同一屏，设备 id 只是 URL 上的附带信息） */
export function samePhoneRoute(a: MobileRoute, b: MobileRoute): boolean {
  if (a.screen === "index" || b.screen === "index") return a.screen === b.screen
  return a.sessionId === b.sessionId
}

/** 进手机外壳时（第一次渲染）URL 和界面怎么对上 */
export type PiPhoneNavInit =
  /** 路由是列表：钉在列表页（之后 relay 自己接上的会话不会把页面带走，同旧手机壳） */
  | { kind: "list" }
  /** 界面已经在一个会话的对话页（开发路由的起始状态、平板转回竖屏）：用它改写当前历史项，之后照常建 [列表, 对话] */
  | { kind: "rewrite"; route: MobileRoute; keepState: boolean }
  /** 路由指着一个会话（深链、刷新）：去找它 */
  | { kind: "open"; sessionId: string; deviceId?: string }

/**
 * ownConversation：当前历史项是 useMobileNavigation 自己写的对话项（history.state.__piMobile === "conversation"），
 * 也就是刷新 / 外壳重新挂载，不是外面来的深链。这时界面已经换到别的会话（平板横屏时在桌面外壳里换过），以界面为准。
 */
export function phoneNavInit(i: { route: MobileRoute; ownConversation: boolean; base: PiPhoneBase; roomId: string; deviceId?: string | null }): PiPhoneNavInit {
  if (i.route.screen === "index") {
    return i.base === "chat" && i.roomId ? { kind: "rewrite", route: phoneRouteOf("chat", i.roomId, i.deviceId), keepState: false } : { kind: "list" }
  }
  if (i.ownConversation && i.base === "chat" && i.roomId && i.roomId !== i.route.sessionId) {
    return { kind: "rewrite", route: phoneRouteOf("chat", i.roomId, i.deviceId), keepState: true }
  }
  return i.route.deviceId ? { kind: "open", sessionId: i.route.sessionId, deviceId: i.route.deviceId } : { kind: "open", sessionId: i.route.sessionId }
}

/** 用户按了系统返回 / 前进（popstate 换了路由）以后界面怎么跟 */
export type PiPhoneRouteStep = { kind: "none" } | { kind: "list" } | { kind: "chat" } | { kind: "open"; sessionId: string; deviceId?: string }

export function phoneRouteStep(route: MobileRoute, base: PiPhoneBase, roomId: string): PiPhoneRouteStep {
  if (route.screen === "index") return base === "chat" ? { kind: "list" } : { kind: "none" }
  if (route.sessionId === roomId) return base === "chat" ? { kind: "none" } : { kind: "chat" }
  return route.deviceId ? { kind: "open", sessionId: route.sessionId, deviceId: route.deviceId } : { kind: "open", sessionId: route.sessionId }
}

/** 界面换了页（点了会话行、‹、换了会话）以后历史怎么跟：push = openConversation，back = goIndex（history.back） */
export type PiPhoneHistoryStep = { kind: "none" } | { kind: "push"; deviceId?: string; sessionId: string } | { kind: "back" }

export function phoneHistoryStep(route: MobileRoute, want: MobileRoute): PiPhoneHistoryStep {
  if (samePhoneRoute(route, want)) return { kind: "none" }
  if (want.screen === "index") return { kind: "back" }
  return want.deviceId ? { kind: "push", deviceId: want.deviceId, sessionId: want.sessionId } : { kind: "push", sessionId: want.sessionId }
}

/**
 * 推入页被界面关上（‹、发出第一条；不是系统返回）以后：
 * - 新会话起好了（会话换了、要回对话页）：forward，进这个会话的对话页（先让哨兵退掉，再压对话项）；
 * - 下面原来是列表页而界面落到了对话页（新会话 / 设置的 ‹ 调的是 act.openSession，newSession 也会先把 phonePage 设成 chat）：回列表页；
 * - 其余：就是下面那一页。
 */
export type PiPhonePushClose = { kind: "none" } | { kind: "list" } | { kind: "forward"; sessionId: string }

export function phonePushClosed(i: { base: PiPhoneBase; roomAtOpen: string; roomId: string; phonePage: "list" | "chat" }): PiPhonePushClose {
  if (i.phonePage === "chat" && i.roomId && i.roomId !== i.roomAtOpen) return { kind: "forward", sessionId: i.roomId }
  if (i.base === "list" && i.phonePage === "chat") return { kind: "list" }
  return { kind: "none" }
}

/** 240ms 页面转场的关键帧（照旧手机壳 mobile.css 的 L0 / L1：推入从右边进、略透明；返回时下面那页从 −24% 回来、由暗变亮） */
export const PHONE_PAGE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)"

export function phonePageFrames(direction: "forward" | "back"): Keyframe[] {
  return direction === "forward"
    ? [
        { transform: "translateX(100%)", opacity: 0.82 },
        { transform: "translateX(0)", opacity: 1 },
      ]
    : [
        { transform: "translateX(-24%)", filter: "brightness(0.92)" },
        { transform: "translateX(0)", filter: "brightness(1)" },
      ]
}

/** 从 from 到 to 要不要放转场、往哪个方向（同一页、第一次进来不放） */
export function phonePageTransition(from: PiPhonePageKey | null, to: PiPhonePageKey): "forward" | "back" | null {
  if (from == null || from === to) return null
  return phonePageDepth(to) >= phonePageDepth(from) ? "forward" : "back"
}
