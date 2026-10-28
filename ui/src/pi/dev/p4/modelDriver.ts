/**
 * mock model 画廊驱动（P4.2 M2e）：`#/p4/<surface>?...&model=<scenario>` 时按时间线推进剧本，
 * 每步调用 `apply.ts` 写 provider store → 变体 UI 实时更新；e2e 等 `data-p4-model-status="done"` 后断言。
 *
 * 纯前端 dev harness；生产入口不 import（mock 模块整体不进生产包）。
 */
import { useEffect, useState } from "react"
import { piUiDemoStore } from "../../extensions/mock/provider.ts"
import { applyPiUiDemoModelStep } from "../../extensions/mock/model/apply.ts"
import { PiUiDemoTurnRunner } from "../../extensions/mock/model/runner.ts"
import { piUiDemoModelScenarioOf } from "../../extensions/mock/model/scenarios.ts"

export type P4ModelStatus = "idle" | "running" | "done" | "blocked"

export interface P4ModelState {
  scenario: string | null
  status: P4ModelStatus
  /** 已应用步数 */
  steps: number
  /** 已产生事件数 */
  events: number
  error: string | null
}

const TICK_MS = 220

/** 场景时间线速度系数：e2e 默认 3x（约 2–4s 跑完），截图/人工可用 1 */
function speedOf(): number {
  const raw = Number(new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("modelSpeed") ?? "3")
  return Number.isFinite(raw) && raw > 0 ? raw : 3
}

/** 在 P4Route 里跑 mock model 场景；enabled=false（caps=none / 无 model 参数）时不动 */
export function useP4ModelDriver(modelId: string | null, enabled: boolean): P4ModelState {
  const [state, setState] = useState<P4ModelState>({ scenario: modelId, status: "idle", steps: 0, events: 0, error: null })

  useEffect(() => {
    if (!enabled || !modelId) {
      setState({ scenario: modelId, status: "idle", steps: 0, events: 0, error: null })
      return
    }
    let cancelled = false
    let timer = 0
    let retryTimer = 0
    let elapsed = 0
    const deadline = Date.now() + 5_000
    const scenario = piUiDemoModelScenarioOf(modelId)
    const runner = new PiUiDemoTurnRunner(scenario.id)
    const speed = speedOf()
    setState({ scenario: scenario.id, status: "running", steps: 0, events: 0, error: null })
    const begin = () => {
      if (cancelled) return
      const store = piUiDemoStore()
      if (!store) {
        // caps= 的 mock 安装 effect 可能晚于本 hook（React effect 顺序）：等 store 出现再跑
        if (Date.now() > deadline) {
          setState({ scenario: scenario.id, status: "blocked", steps: 0, events: 0, error: "mock provider 未安装（caps 必须非 none）" })
          return
        }
        retryTimer = window.setTimeout(begin, 120)
        return
      }
      timer = window.setInterval(() => {
        if (cancelled) return
        elapsed += TICK_MS * speed
        const fresh = runner.advanceTo(elapsed)
        for (const event of fresh) {
          try {
            applyPiUiDemoModelStep(store, event.step)
          } catch (error) {
            setState((prev) => ({ ...prev, status: "blocked", error: String((error as Error)?.message ?? error) }))
            window.clearInterval(timer)
            return
          }
        }
        setState({
          scenario: scenario.id,
          status: runner.done ? "done" : "running",
          steps: runner.emitted.length,
          events: store.eventsOf().length,
          error: null,
        })
        if (runner.done) window.clearInterval(timer)
      }, TICK_MS)
    }
    begin()
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.clearTimeout(retryTimer)
    }
  }, [modelId, enabled])

  return state
}
