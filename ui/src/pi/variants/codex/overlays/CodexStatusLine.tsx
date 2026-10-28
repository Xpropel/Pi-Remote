import { useEffect, useRef, useState } from "react"
import type { VariantAppProps } from "@/pi/variants/types"
import { pageLinkView } from "@/relay/presence"
import { useNow } from "../hooks/useCodex"

type State = { kind: "hidden" | "waiting" | "reconnecting" | "offline" | "restored"; seconds?: number }

/** 连接状态行（推导 / X-12：重连倒计时 / 已重新连接淡出）；不 import LinkStatusContainer */
export function CodexStatusLine({ p }: { p: VariantAppProps }) {
  const { relay } = p
  const now = useNow(1000)
  const link = pageLinkView(relay, now)
  const [state, setState] = useState<State>({ kind: "hidden" })
  const prev = useRef(link.kind)
  const broken = useRef<number | null>(null)
  useEffect(() => {
    const was = prev.current
    prev.current = link.kind
    if (link.kind === "ok") {
      broken.current = null
      setState(was !== "ok" && was !== "first" ? { kind: "restored" } : { kind: "hidden" })
      return
    }
    if (link.kind === "first") {
      setState({ kind: "hidden" })
      return
    }
    if (broken.current == null) broken.current = Date.now()
    if (relay.everConnected && Date.now() - broken.current > 30_000) {
      setState({ kind: "offline" })
      return
    }
    setState({ kind: link.kind === "waiting" ? "waiting" : "reconnecting", seconds: link.kind === "waiting" ? link.seconds : undefined })
  }, [link.kind, link.kind === "waiting" ? link.seconds : 0, relay.everConnected])
  useEffect(() => {
    if (state.kind !== "restored") return
    const timer = window.setTimeout(() => setState({ kind: "hidden" }), 3000)
    return () => window.clearTimeout(timer)
  }, [state.kind])
  if (state.kind === "hidden" || link.kind === "first") return null
  const text = state.kind === "restored" ? "已重新连接" : state.kind === "offline" ? "已断开" : state.kind === "waiting" ? `与服务器断开，${state.seconds ?? 0} 秒后重试` : "正在重新连接…"
  return (
    <div className="cx-statusline" role="status" data-pi-ui-part="statusline">
      <span className="cx-statusline-dot" data-tone={state.kind === "restored" ? "ok" : "bad"} aria-hidden />
      <span className="cx-statusline-text">{text}</span>
      {state.kind === "offline" || state.kind === "waiting" ? (
        <button type="button" className="cx-inline-link" onClick={() => relay.reconnectNow()}>
          立即重连
        </button>
      ) : null}
    </div>
  )
}
