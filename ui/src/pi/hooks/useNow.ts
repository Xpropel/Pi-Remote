import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react"

/*
 * 容器的时钟（plan §7.0「要显示相对时间的容器，用 useNow(1000) 拿 now，再传进视图模型；视图模型自己不读时钟」）。
 * 开发画廊的 #/live 路由放一个 PiNowProvider，把 now 钉在 fixture 的 now 上，L2 对图才稳定；产品里不放 provider，按 intervalMs 走。
 */

const PiNowContext = createContext<number | null>(null)

/** 固定时钟：给了它，子树里的 useNow 都返回这个值、不起计时器 */
export function PiNowProvider({ now, children }: { now: number; children?: ReactNode }) {
  return createElement(PiNowContext.Provider, { value: now }, children)
}

/** 当前时刻（ms）：有 PiNowProvider 时返回固定值；否则每 intervalMs 更新一次 */
export function useNow(intervalMs = 1000): number {
  const fixed = useContext(PiNowContext)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (fixed != null) return
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [fixed, intervalMs])
  return fixed ?? now
}
