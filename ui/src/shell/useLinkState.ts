/**
 * 链路展示状态（§2.7.2）：即时三态 + 30s 离线降级 + 1.6s 恢复态。
 *
 * Relay 的 status 是过程文案（连接中/鉴权中/已断开），这里不读它；输入只取
 * authed / everConnected / retryAt 三个稳定字段。首次连接（never connected）
 * 不出离线条，交给首屏骨架与输入坞的加载文案。
 */
import { useEffect, useRef, useState } from "react"
import type { Relay } from "@/relay/useRelay"
import {
  LINK_RECOVERED_FADE_MS,
  LINK_RECOVERED_MS,
  degradedLinkState,
  linkStateOf,
  type LinkState,
} from "./shellModel"

export type OfflineBannerKind = "disconnected" | "reconnecting" | "recovered"

export type LinkInfo = {
  /** 叠加 30s 降级后的展示态：pill / 侧栏状态点 / 连接页共用。 */
  state: LinkState
  /** 离线条内容；null = 不显示。 */
  banner: OfflineBannerKind | null
  /** 恢复态正在做 200ms 收起；CSS 用高度过渡。 */
  closing: boolean
  /** 已断开多久（毫秒）；未断开为 0。 */
  downFor: number
}

type LinkInput = Pick<Relay, "authed" | "everConnected" | "retryAt">

export function useLinkState(relay: LinkInput): LinkInfo {
  const base = linkStateOf(relay)
  const [now, setNow] = useState(() => Date.now())
  const [recovered, setRecovered] = useState(false)
  const [closing, setClosing] = useState(false)
  const downSince = useRef<number | null>(base === "connected" ? null : Date.now())
  const wasDown = useRef(base !== "connected" && relay.everConnected)
  const prevBase = useRef(base)
  const recoveryTimers = useRef<number[]>([])

  // 断线期间每秒走一次，用于 30s 降级；恢复后停表。
  useEffect(() => {
    if (base === "connected") return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [base])

  useEffect(() => {
    const previous = prevBase.current
    prevBase.current = base

    if (base !== "connected") {
      if (relay.everConnected) wasDown.current = true
      if (downSince.current == null) downSince.current = Date.now()
      // 恢复态期间又断了：立即收掉绿色条，回到断线条。
      if (recovered || recoveryTimers.current.length) {
        for (const timer of recoveryTimers.current) window.clearTimeout(timer)
        recoveryTimers.current = []
        setRecovered(false)
        setClosing(false)
      }
      return
    }

    downSince.current = null
    if (previous === base || !wasDown.current) return
    wasDown.current = false
    setRecovered(true)
    setClosing(false)
    for (const timer of recoveryTimers.current) window.clearTimeout(timer)
    recoveryTimers.current = [
      window.setTimeout(() => setClosing(true), LINK_RECOVERED_MS),
      window.setTimeout(() => {
        recoveryTimers.current = []
        setRecovered(false)
        setClosing(false)
      }, LINK_RECOVERED_MS + LINK_RECOVERED_FADE_MS),
    ]
  }, [base, recovered, relay.everConnected])

  useEffect(
    () => () => {
      for (const timer of recoveryTimers.current) window.clearTimeout(timer)
      recoveryTimers.current = []
    },
    [],
  )

  // 首帧就断线时 downSince 已在 ref 初始化里落下；这里再兜一次非连接态的懒初始化。
  if (base !== "connected" && downSince.current == null) downSince.current = Date.now()
  const downFor = base === "connected" || downSince.current == null ? 0 : Math.max(0, now - downSince.current)
  const state = degradedLinkState(base, downFor)

  let banner: OfflineBannerKind | null = null
  if (recovered) banner = "recovered"
  else if (base !== "connected" && relay.everConnected) {
    // 刚断开、重连还没排上：先显示静态“连接已断开”，600ms 后转“正在重新连接…”。
    if (state === "offline") banner = "disconnected"
    else banner = downFor >= 600 ? "reconnecting" : "disconnected"
  }

  return { state, banner, closing: recovered ? closing : false, downFor }
}
