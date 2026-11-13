import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"
import { setPageTitleStandIn } from "@/chat/hooks"
import type { PiAppProps } from "@/pi/containers/types"
import { usePiMotion } from "@/pi/hooks/useReducedMotion"
import {
  isPhonePushPage,
  PHONE_PAGE_EASING,
  phoneBaseOf,
  phoneHistoryStep,
  phoneLayersOf,
  phoneNavInit,
  phonePageFrames,
  phonePageOf,
  phonePageTransition,
  phonePushClosed,
  phoneRouteOf,
  phoneRouteStep,
  samePhoneRoute,
  type PiPhoneBase,
  type PiPhoneBoot,
  type PiPhoneLayer,
  type PiPhonePageKey,
} from "@/pi/model/phoneRoute"
import { openSessionRow, sidebarSessionsOf } from "@/pi/model/sidebarSource"
import { mobileRouteUrl, parseMobileRoute, type MobileRoute } from "@/mobile/model"
import { useMobileNavigation } from "@/mobile/useMobileNavigation"

/*
 * 手机导航（PLAN 6.2，a 线；design §4.1、J08；R2/p6-lanes.md §2.5）。PhoneApp 在可交互时调一次（静态态 = 画廊、#/live 对图不调：不碰 history、不放转场）。
 * - 列表页 ↔ 对话页：useMobileNavigation（pushState / popstate、弹层哨兵、350ms 转场锁；mobile/*.ts 原样复用）。
 *   界面（usePiUiState 的 phonePage、relay.roomId）变了 → openConversation / goIndex；用户按系统返回 / 前进 → 改 phonePage。
 *   两边谁先变由这里的路由镜像（routeRef：popstate 时按 location.search 重读）判断，对应规则是 model/phoneRoute.ts 的纯函数。
 * - 搜索页、推入页（新会话、设置、终端 / 改动 / 文件）、命令面板、sheet 各算一层弹层（overlayCount）；系统返回关最上面一层（closeTopOverlay：
 *   sheet → 命令面板 → 推入页 → 搜索页）。推入页被界面关上时回到进来前的那一页（新会话 / 设置的 ‹ 调的是 act.openSession），新会话起好了就进它的对话页。
 *   搜索页不换页（列表式、抽屉式都盖在当前页上），从结果进会话时等它的哨兵退掉再压对话项。
 * - 深链 ?device=&session=：找回真实房间（openSessionRow：别的设备先 selectDevice，未载入的只本地选择）；
 *   房间、当前会话、会话清单 5 秒没变化还没找到 → "会话不可用"（同旧手机壳 MobileApp）。
 * - 240ms 转场（usePiMotion().pageTransitionMs，减少动效时 0）：新的一页用 Web Animations 滑进来（关键帧照旧手机壳）；
 *   系统自己已经放过返回动画（PopStateEvent.hasUAVisualTransition，iOS 边缘右滑）时不再放。
 * 本 hook 只用 usePiUiState 已有的字段和动作（P5B 契约不变）；"会话不可用"计时、推入页下面那一页这些导航自己的状态放在这里。
 */

/** 同 useMobileNavigation 的转场锁：锁期间它不接第二次路由，这里到时再补一次 */
const ROUTE_LOCK_MS = 350
/** 等 history.back() 回来的 popstate 最多这么久 */
const POP_WAIT_MS = 600
/** design J08 的 5 秒规则 */
export const PHONE_UNAVAILABLE_MS = 5000
/** popstate 之后这么久以内的换页算"系统返回带出来的" */
const UA_TRANSITION_WINDOW_MS = 400

type Target = { sessionId: string; deviceId?: string }
type NavLayer = PiPhoneLayer | "search"
type NavHistoryState = { __piMobile?: "index" | "conversation"; __piMobileLayer?: boolean } | null

const historyState = (): NavHistoryState => (window.history.state ?? null) as NavHistoryState

const routeOfTarget = (t: Target): MobileRoute => phoneRouteOf("chat", t.sessionId, t.deviceId)

const targetOf = (x: { sessionId: string; deviceId?: string }): Target => (x.deviceId ? { sessionId: x.sessionId, deviceId: x.deviceId } : { sessionId: x.sessionId })

export interface PiPhoneNav {
  /** 这一帧画哪一页（推入页从界面关上、要回列表页时，这一帧就画列表页） */
  page: PiPhonePageKey
  /** 深链 / 前进到的会话还没找到：对话页画"正在打开会话…"，5 秒后"会话不可用" */
  opening: { sessionId: string; unavailable: boolean } | null
  /** "正在打开会话" / "会话不可用"页上的 ‹ 和"返回会话列表" */
  back: () => void
  /** 页面后面那个隐藏的标记（转场动画放在它前面的页面根节点上，跳过中间的通知出口） */
  anchorRef: RefObject<HTMLSpanElement | null>
}

export function usePiPhoneNav({ relay, ui, act }: PiAppProps, boot: PiPhoneBoot): PiPhoneNav {
  const roomId = relay.roomId
  const deviceId = relay.rooms.find((r) => r.id === roomId)?.deviceId ?? relay.lazySession?.deviceId ?? relay.selectedDeviceId ?? undefined
  /** 推入页开着：它下面那一页、开时的会话、哪一页、开时那个会话输入框里的草稿 */
  const [push, setPush] = useState<{ base: PiPhoneBase; room: string; page: PiPhonePageKey; draft: string } | null>(null)
  /** 推入页是系统返回关的（closeTopOverlay 已经回到下面那一页） */
  const [pushByBack, setPushByBack] = useState(false)
  const [opening, setOpening] = useState<Target | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  // popstate、转场锁到时：再对一遍
  const [tick, setTick] = useState(0)
  const rerun = useCallback(() => setTick((t) => t + 1), [])

  // 搜索页是弹层（下面 layers 的 search），不是换页：抽屉式在对话页上开搜索不退回列表、不动历史
  const raw = phonePageOf({ boot, view: ui.view, pane: ui.pane, phonePage: ui.phonePage, search: null, roomId, opening: opening != null })
  const pushClose = push && !isPhonePushPage(raw) && !pushByBack ? phonePushClosed({ base: push.base, roomAtOpen: push.room, roomId, phonePage: ui.phonePage }) : null
  // 新会话撞上同目录已在运行的会话、而它正是进来前的当前会话：房间没换，但新会话页把草稿放进了它的输入框
  // （NewSessionContainer 的 existing；‹ 不动草稿）→ 也进它的对话页：草稿在那里的输入框里，「已切换到它」的通知卡也在那里
  const closed =
    pushClose?.kind === "list" && push?.page === "new" && roomId && relay.draft !== push.draft
      ? ({ kind: "forward", sessionId: roomId } as const)
      : pushClose
  const closedKind = closed?.kind ?? null
  const closedSession = closed?.kind === "forward" ? closed.sessionId : null
  const page: PiPhonePageKey = closedKind === "list" ? "list" : raw
  const overlays = phoneLayersOf({ page, paletteOpen: ui.paletteOpen, sheet: ui.sheet != null })
  // 搜索页整屏盖住列表 / 对话页，是最底下一层：系统返回先关上面的，最后关它
  const layers: NavLayer[] = ui.search != null ? ["search", ...overlays] : overlays

  const latest = useRef({ layers, page, base: null as PiPhoneBase | null, draft: relay.draft })
  useLayoutEffect(() => {
    latest.current = { layers, page, base: push?.base ?? null, draft: relay.draft }
  })
  const closeTopOverlay = useCallback(() => {
    const s = latest.current
    const top = s.layers[s.layers.length - 1]
    if (top === "sheet") act.closeSheet()
    else if (top === "palette") act.setPaletteOpen(false)
    else if (top === "push") {
      setPushByBack(true)
      if (s.page === "pane") act.setPane(null)
      else {
        act.setView("session")
        act.setPhonePage(s.base ?? "list")
      }
    } else if (top === "search") act.setSearch(null)
  }, [act])
  const { openConversation, goIndex } = useMobileNavigation({ overlayCount: layers.length, closeTopOverlay })

  /** 路由镜像：popstate 时按 location.search 重读；自己 openConversation 时直接写 */
  const routeRef = useRef<MobileRoute>({ screen: "index" })
  const startedRef = useRef(false)
  const seenRef = useRef<{ page: PiPhonePageKey; roomId: string } | null>(null)
  const lastBaseRef = useRef<PiPhoneBase | null>(null)
  const userPopRef = useRef(false)
  const waitBackRef = useRef(false)
  const waitOpenRef = useRef<Target | null>(null)
  const lockUntilRef = useRef(0)
  const popAtRef = useRef<{ at: number; ua: boolean } | null>(null)
  const timers = useRef(new Set<number>())
  const later = useCallback((fn: () => void, ms: number) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id)
      fn()
    }, ms)
    timers.current.add(id)
  }, [])
  useEffect(() => {
    const set = timers.current
    return () => {
      for (const id of set) window.clearTimeout(id)
      set.clear()
    }
  }, [])

  const pushConversation = useCallback(
    (to: Target) => {
      openConversation(to.deviceId, to.sessionId)
      routeRef.current = routeOfTarget(to)
      lockUntilRef.current = Date.now() + ROUTE_LOCK_MS
    },
    [openConversation],
  )
  /** 刚关掉的弹层哨兵还在：useMobileNavigation 正要 history.back() 把它退掉，等那次 popstate 再压对话项（没等到就到时直接压） */
  const pushAfterSentinel = useCallback(
    (to: Target) => {
      waitOpenRef.current = to
      later(() => {
        if (waitOpenRef.current !== to) return
        waitOpenRef.current = null
        pushConversation(to)
        rerun()
      }, POP_WAIT_MS)
    },
    [later, pushConversation, rerun],
  )
  const layerCountRef = useRef(0)

  const show = useCallback(
    (to: Target) => {
      if (ui.phonePage !== "chat") act.setPhonePage("chat")
      if (to.sessionId === roomId) {
        setOpening(null)
      } else {
        setOpening(to)
        setUnavailable(false)
      }
    },
    [act, roomId, ui.phonePage],
  )

  useEffect(() => {
    const onPop = (event: PopStateEvent) => {
      // 还没对上（正在退刷新留下的弹层哨兵）：那几次 popstate 不算用户返回
      if (!startedRef.current) return
      const next = parseMobileRoute(window.location.search)
      const changed = !samePhoneRoute(next, routeRef.current)
      routeRef.current = next
      popAtRef.current = { at: performance.now(), ua: (event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true }
      if (changed) {
        // 路由换了：自己 goIndex 发的，或者用户按了系统返回 / 前进
        if (waitBackRef.current) waitBackRef.current = false
        else userPopRef.current = true
        waitOpenRef.current = null
      } else if (waitOpenRef.current) {
        // 哨兵退掉了（URL 不变），再压对话项
        const to = waitOpenRef.current
        waitOpenRef.current = null
        pushConversation(to)
      }
      rerun()
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [pushConversation, rerun])

  // 第一次渲染：URL 和界面对上（布局 effect，赶在 useMobileNavigation 的首次挂载 effect 读 location 之前改写当前历史项）
  const drainRef = useRef<"draining" | "done" | null>(null)
  useLayoutEffect(() => {
    if (startedRef.current || drainRef.current === "draining") return
    // 刷新前开着的弹层没了、它的哨兵（同 URL）还在栈顶：先一条条退掉再对，不然系统返回要白按（刷新后退回 pushState 的项仍是同一文档，只来 popstate）
    if (drainRef.current === null && historyState()?.__piMobileLayer && layers.length === 0) {
      drainRef.current = "draining"
      const finish = () => {
        if (drainRef.current !== "draining") return
        window.removeEventListener("popstate", onDrainPop)
        drainRef.current = "done"
        rerun()
      }
      const onDrainPop = () => {
        if (historyState()?.__piMobileLayer) window.history.back()
        else finish()
      }
      window.addEventListener("popstate", onDrainPop)
      window.history.back()
      later(finish, POP_WAIT_MS)
      return
    }
    startedRef.current = true
    const route = parseMobileRoute(window.location.search)
    const base = isPhonePushPage(page) ? phoneBaseOf({ boot, phonePage: ui.phonePage, roomId }) : (page as PiPhoneBase)
    const init = phoneNavInit({ route, ownConversation: historyState()?.__piMobile === "conversation", base, roomId, deviceId })
    if (init.kind === "rewrite") {
      window.history.replaceState(init.keepState ? window.history.state : null, "", mobileRouteUrl(location.pathname, location.search, location.hash, init.route))
      routeRef.current = init.route
    } else {
      routeRef.current = route
      if (init.kind === "list") {
        if (ui.phonePage !== "list") act.setPhonePage("list")
      } else show(targetOf(init))
    }
    seenRef.current = { page, roomId }
    // 只在第一次渲染跑（退哨兵时等到退完那次 rerun）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  // 每次提交：推入页的开关、系统返回 / 前进、界面换页 → 历史
  useLayoutEffect(() => {
    if (!startedRef.current) return
    const layerClosed = layerCountRef.current > layers.length
    layerCountRef.current = layers.length
    if (opening && roomId === opening.sessionId) {
      setOpening(null)
      setUnavailable(false)
    }
    if (isPhonePushPage(page)) {
      if (!push) setPush({ base: lastBaseRef.current ?? phoneBaseOf({ boot, phonePage: ui.phonePage, roomId }), room: roomId, page, draft: latest.current.draft })
      seenRef.current = { page, roomId }
      return
    }
    lastBaseRef.current = page === "chat" ? "chat" : "list"
    if (push) {
      if (closedKind === "list") act.setPhonePage("list")
      else if (closedKind === "forward" && closedSession) {
        const to: Target = deviceId ? { sessionId: closedSession, deviceId } : { sessionId: closedSession }
        if (historyState()?.__piMobileLayer) pushAfterSentinel(to)
        else pushConversation(to)
      }
      setPush(null)
      setPushByBack(false)
      seenRef.current = { page, roomId }
      return
    }
    if (waitOpenRef.current || waitBackRef.current) return
    const route = routeRef.current
    const base: PiPhoneBase = page === "chat" ? "chat" : "list"
    if (userPopRef.current) {
      userPopRef.current = false
      const step = phoneRouteStep(route, base, opening ? opening.sessionId : roomId)
      if (step.kind === "list") {
        act.setPhonePage("list")
        setOpening(null)
        setUnavailable(false)
      } else if (step.kind === "chat") {
        act.setPhonePage("chat")
        setOpening(null)
      } else if (step.kind === "open") show(targetOf(step))
      seenRef.current = { page, roomId }
      return
    }
    const seen = seenRef.current
    if (seen && seen.page === page && seen.roomId === roomId) return
    const want = opening ? routeOfTarget(opening) : phoneRouteOf(base, roomId, deviceId)
    const step = phoneHistoryStep(route, want)
    if (step.kind !== "none") {
      const wait = lockUntilRef.current - Date.now()
      if (wait > 0) {
        // 转场锁里：到时再来（seen 不更新，那时还会再比一次）
        later(rerun, wait + 20)
        return
      }
      if (step.kind === "push") {
        // 从搜索结果（或命令面板）进会话：这一帧弹层刚关、哨兵还在，同上等它退掉，不然对话项压在哨兵上、留一条空的列表项
        if (layerClosed && layers.length === 0 && historyState()?.__piMobileLayer) pushAfterSentinel(targetOf(step))
        else pushConversation(targetOf(step))
      } else {
        waitBackRef.current = true
        goIndex()
        lockUntilRef.current = Date.now() + ROUTE_LOCK_MS
        later(() => {
          if (!waitBackRef.current) return
          // 没等到 popstate（goIndex 在锁里或已经在列表）：按 URL 重读，不再追
          waitBackRef.current = false
          routeRef.current = parseMobileRoute(window.location.search)
        }, POP_WAIT_MS)
      }
    }
    seenRef.current = { page, roomId }
  }, [tick, page, roomId, deviceId, boot, ui.phonePage, push, closedKind, closedSession, opening, layers.length, act, show, later, rerun, pushConversation, pushAfterSentinel, goIndex])

  // 深链 / 前进：找回真实房间（同旧手机壳 MobileApp；跨设备的会话行用 sidebarSessionsOf + openSessionRow）
  const triedRef = useRef("")
  const { authed, deviceMode, selectedDeviceId, devices, rooms, sessionsByDevice } = relay
  useEffect(() => {
    if (!opening || !authed || roomId === opening.sessionId) return
    const wantDevice = opening.deviceId
    if (wantDevice && deviceMode && selectedDeviceId !== wantDevice) {
      if (devices.some((d) => d.id === wantDevice)) relay.selectDevice(wantDevice)
      return
    }
    const row = sidebarSessionsOf(devices, rooms, sessionsByDevice).find((r) => r.id === opening.sessionId && (!wantDevice || r.deviceId === wantDevice))
    if (row) {
      const key = `${row.deviceId}:${row.id}:${row.openable ? 1 : 0}`
      if (triedRef.current === key) return
      triedRef.current = key
      openSessionRow(relay, row, () => {})
      return
    }
    if (!deviceMode && rooms.some((r) => r.id === opening.sessionId)) relay.selectRoom(opening.sessionId)
    // relay 的函数成员引用稳定；relay 本身每次渲染都是新对象，不放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, authed, roomId, deviceMode, selectedDeviceId, devices, rooms, sessionsByDevice])

  // 5 秒规则：房间、当前会话、会话清单 5 秒没有变化还没找到 → 会话不可用（变化一次重新计时；找到了 opening 就清掉）
  const { sessionsLoading } = relay
  useEffect(() => {
    if (!opening || roomId === opening.sessionId) return
    const id = window.setTimeout(() => setUnavailable(true), PHONE_UNAVAILABLE_MS)
    return () => window.clearTimeout(id)
  }, [opening, roomId, rooms, sessionsLoading])

  // 标签页标题：这时画的不是 relay 里还开着的上一个会话，标题也不写它
  const titleStandIn = opening ? (unavailable ? "会话不可用" : "正在打开会话…") : null
  useEffect(() => setPageTitleStandIn(titleStandIn), [titleStandIn])
  useEffect(() => () => setPageTitleStandIn(null), [])

  const back = useCallback(() => {
    setOpening(null)
    setUnavailable(false)
    act.setPhonePage("list")
  }, [act])

  // 240ms 转场：只给新的一页放（旧的一页已经卸掉）
  const { pageTransitionMs } = usePiMotion()
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const lastPageRef = useRef<PiPhonePageKey | null>(null)
  const animRef = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const from = lastPageRef.current
    lastPageRef.current = page
    const direction = phonePageTransition(from, page)
    if (!direction || pageTransitionMs <= 0) return
    const pop = popAtRef.current
    if (pop?.ua && performance.now() - pop.at < UA_TRANSITION_WINDOW_MS) return
    // 页面和标记之间可能隔着通知出口（PhoneApp 的 [data-pi-notice-slot]），跳过它找页面根
    let el = anchorRef.current?.previousElementSibling ?? null
    while (el?.hasAttribute("data-pi-notice-slot")) el = el.previousElementSibling
    if (!(el instanceof HTMLElement) || typeof el.animate !== "function") return
    animRef.current?.cancel()
    animRef.current = el.animate(phonePageFrames(direction), { duration: pageTransitionMs, easing: PHONE_PAGE_EASING })
  }, [page, pageTransitionMs])

  return { page, opening: opening ? { sessionId: opening.sessionId, unavailable } : null, back, anchorRef }
}
