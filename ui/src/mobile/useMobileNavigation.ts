import { useCallback, useEffect, useRef, useState } from "react"
import { mobileRouteUrl, parseMobileRoute, routeSession, type MobileRoute } from "./model"

type OverlayOptions = {
  /** 当前打开的弹层数：UiProvider 的 dialog stack + 移动壳自己的 Sheet/菜单。 */
  overlayCount: number
  /** 按层级从高到低关闭一层（dialog → 菜单 → Sheet）。 */
  closeTopOverlay: () => void
}

export type MobileNavigation = {
  route: MobileRoute
  openConversation: (deviceId: string | undefined, sessionId: string) => void
  goIndex: () => void
  replaceIndexDevice: (deviceId: string | undefined) => void
}

type HistoryState = {
  __piMobile?: "index" | "conversation"
  __piMobileLayer?: boolean
}

function state(): HistoryState {
  return (window.history.state || {}) as HistoryState
}

function currentUrl(route: MobileRoute): string {
  return mobileRouteUrl(location.pathname, location.search, location.hash, route)
}

/**
 * 第 3 章 §3.1.1 的 L0/L1 导航栈。
 *
 * - 列表是根；打开会话 pushState，返回用浏览器回退，不自己造第二套栈。
 * - 深链首次进入时先把当前历史项改写成 index，再 push conversation，
 *   所以刷新/分享后按一次返回一定回到对应设备的列表，不会直接退出站点。
 * - 弹层打开时压一条同 URL 的哨兵；popstate 先关最上层，再回列表，最后才退出。
 * - URL 只写 device/session 两个 query，其他 query 原样保留。
 */
export function useMobileNavigation({ overlayCount, closeTopOverlay }: OverlayOptions): MobileNavigation {
  const [route, setRoute] = useState<MobileRoute>(() => parseMobileRoute(location.search))
  const routeRef = useRef(route)
  const overlayRef = useRef(overlayCount)
  const closeRef = useRef(closeTopOverlay)
  const prevOverlayRef = useRef(0)
  const ignorePopRef = useRef(0)
  const poppedRef = useRef(false)
  const initRef = useRef(false)
  /** 转场期间锁第二次路由（350ms 超时保护，§3.1.4）。 */
  const routeLockRef = useRef(0)

  useEffect(() => {
    routeRef.current = route
  }, [route])

  useEffect(() => {
    overlayRef.current = overlayCount
  }, [overlayCount])

  useEffect(() => {
    closeRef.current = closeTopOverlay
  }, [closeTopOverlay])

  const applyRoute = useCallback((next: MobileRoute) => {
    routeRef.current = next
    setRoute((prev) => (routeSession(prev) === routeSession(next) && prev.screen === next.screen && prev.deviceId === next.deviceId ? prev : next))
  }, [])

  // 首次挂载：把历史栈整理成 [index, conversation?]。
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    const initial = parseMobileRoute(location.search)
    const saved = state()
    if (initial.screen === "conversation") {
      if (saved.__piMobile !== "conversation") {
        const indexUrl = currentUrl({ screen: "index", deviceId: initial.deviceId })
        window.history.replaceState({ __piMobile: "index" }, "", indexUrl)
        window.history.pushState({ __piMobile: "conversation" }, "", currentUrl(initial))
      }
    } else if (saved.__piMobile !== "index") {
      window.history.replaceState({ __piMobile: "index" }, "", currentUrl(initial))
    }
    applyRoute(initial)
  }, [applyRoute])

  useEffect(() => {
    const onPop = () => {
      if (ignorePopRef.current > 0) {
        ignorePopRef.current -= 1
        return
      }
      if (overlayRef.current > 0) {
        // 用户按返回：关闭最上层，保留当前路由。
        poppedRef.current = true
        closeRef.current()
        return
      }
      applyRoute(parseMobileRoute(location.search))
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [applyRoute])

  // 每个弹层对应一条哨兵；关闭按钮主动关层时把它消费掉，避免留下空历史项。
  useEffect(() => {
    const prev = prevOverlayRef.current
    prevOverlayRef.current = overlayCount
    if (overlayCount > prev) {
      for (let index = prev; index < overlayCount; index += 1) {
        window.history.pushState({ ...(window.history.state || {}), __piMobileLayer: true }, "", location.href)
      }
      return
    }
    if (overlayCount < prev) {
      if (poppedRef.current) {
        poppedRef.current = false
        return
      }
      for (let index = overlayCount; index < prev; index += 1) {
        if (!state().__piMobileLayer) continue
        ignorePopRef.current += 1
        window.history.back()
      }
    }
  }, [overlayCount])

  const openConversation = useCallback(
    (deviceId: string | undefined, sessionId: string) => {
      if (Date.now() < routeLockRef.current) return
      const current = routeRef.current
      if (current.screen === "conversation" && current.sessionId === sessionId && (current.deviceId || undefined) === (deviceId || undefined)) return
      routeLockRef.current = Date.now() + 350
      const next: MobileRoute = { screen: "conversation", sessionId, ...(deviceId ? { deviceId } : {}) }
      // 让即将成为「下层」的列表历史项也带上设备，返回后刷新仍停在同一台设备。
      window.history.replaceState({ __piMobile: "index" }, "", currentUrl({ screen: "index", deviceId }))
      window.history.pushState({ __piMobile: "conversation" }, "", currentUrl(next))
      applyRoute(next)
    },
    [applyRoute],
  )

  const goIndex = useCallback(() => {
    if (routeRef.current.screen === "index") return
    if (Date.now() < routeLockRef.current) return
    routeLockRef.current = Date.now() + 350
    window.history.back()
  }, [])

  const replaceIndexDevice = useCallback(
    (deviceId: string | undefined) => {
      const current = routeRef.current
      if (current.screen !== "index") return
      const next: MobileRoute = { screen: "index", ...(deviceId ? { deviceId } : {}) }
      window.history.replaceState({ __piMobile: "index" }, "", currentUrl(next))
      applyRoute(next)
    },
    [applyRoute],
  )

  return { route, openConversation, goIndex, replaceIndexDevice }
}
