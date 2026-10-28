/**
 * P4 场景驱动（P4.2 M2）：把 `#/p4/<surface>` 自动点到位，供双态截图与 e2e 使用。
 *
 * 行为：等变体树就绪 → 按 `scenarios.ts` 的 steps 依次点稳定选择器 → 断言目标 `[data-p4-surface]` 出现。
 * 状态通过 `data-p4-driver-status` 暴露，P4Route 据此写 `data-p4-ready` / `data-p4-error`。
 * 只读 DOM、不注入产品逻辑；超时/缺面不抛错，标记 blocked 供脚本判 SKIP/FAIL。
 */
import { useEffect, useState } from "react"
import type { P4DriverStep, P4Scenario } from "./scenarios"

export type P4DriverStatus = "waiting" | "running" | "ready" | "blocked"

export interface P4DriverState {
  status: P4DriverStatus
  /** blocked 原因（选择器超时 / 未知 surface 等） */
  error: string | null
  /** 已执行步骤数 */
  stepsDone: number
}

const POLL_MS = 120
const STEP_TIMEOUT_MS = 2_500
const TOTAL_TIMEOUT_MS = 9_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForElement(selector: string, timeoutMs: number, cancelled: () => boolean): Promise<Element | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (cancelled()) return null
    const found = document.querySelector(selector)
    if (found) return found
    if (Date.now() > deadline) return null
    await sleep(POLL_MS)
  }
}

async function runStep(step: P4DriverStep, cancelled: () => boolean): Promise<boolean> {
  if ("press" in step) {
    const parts = step.press.split("+")
    const key = parts.pop() ?? ""
    const event = new KeyboardEvent("keydown", {
      key,
      ctrlKey: parts.includes("Control"),
      metaKey: parts.includes("Meta"),
      altKey: parts.includes("Alt"),
      shiftKey: parts.includes("Shift"),
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    await sleep(250)
    return !cancelled()
  }
  if ("pointerDown" in step) {
    const element = await waitForElement(step.pointerDown, STEP_TIMEOUT_MS, cancelled)
    if (!element) return false
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 }))
    await sleep(300)
    return !cancelled()
  }
  if ("waitMs" in step) {
    await sleep(step.waitMs)
    return !cancelled()
  }
  const selector = "click" in step ? step.click : step.waitFor
  const element = await waitForElement(selector, "timeoutMs" in step && step.timeoutMs ? step.timeoutMs : STEP_TIMEOUT_MS, cancelled)
  if (!element) return false
  if ("click" in step) {
    const target = step.index == null ? element : [...document.querySelectorAll(selector)][step.index]
    if (!target) return false
    ;(target as HTMLElement).scrollIntoView({ block: "center" })
    ;(target as HTMLElement).click()
    await sleep(200)
  }
  return !cancelled()
}

/** 驱动一个场景到目标 surface；enabled=false 时不动（静态截图用） */
export function useP4ScenarioDriver(scenario: P4Scenario | null, enabled: boolean): P4DriverState {
  const [state, setState] = useState<P4DriverState>({ status: enabled ? "waiting" : "ready", error: null, stepsDone: 0 })

  useEffect(() => {
    if (!enabled) {
      setState({ status: "ready", error: null, stepsDone: 0 })
      return
    }
    if (!scenario) {
      setState({ status: "blocked", error: "未知 surface（scenarios.ts 没有该面）", stepsDone: 0 })
      return
    }
    let cancelled = false
    const isCancelled = () => cancelled
    const targetSelector = `[data-p4-surface="${scenario.surface}"]`
    setState({ status: "waiting", error: null, stepsDone: 0 })
    void (async () => {
      const deadline = Date.now() + TOTAL_TIMEOUT_MS
      // 1) 等变体根挂载（data-p4-surface 通常挂在 shell 上；没有 data-p4-* 的旧变体也能走到 blocked 而不是白屏）
      await waitForElement(targetSelector, 1, isCancelled)
      await sleep(350)
      if (isCancelled()) return
      if (document.querySelector(targetSelector) && scenario.steps.length === 0) {
        setState({ status: "ready", error: null, stepsDone: 0 })
        return
      }
      // 2) 逐步骤点击
      setState({ status: "running", error: null, stepsDone: 0 })
      let done = 0
      for (const step of scenario.steps) {
        if (isCancelled()) return
        if (Date.now() > deadline) {
          setState({ status: "blocked", error: "驱动超时", stepsDone: done })
          return
        }
        const ok = await runStep(step, isCancelled)
        if (!ok) {
          setState({ status: "blocked", error: `步骤失败（${JSON.stringify(step)}）`, stepsDone: done })
          return
        }
        done += 1
        setState({ status: "running", error: null, stepsDone: done })
      }
      // 3) 等目标出现
      const target = await waitForElement(targetSelector, STEP_TIMEOUT_MS, isCancelled)
      if (isCancelled()) return
      if (target) setState({ status: "ready", error: null, stepsDone: done })
      else setState({ status: "blocked", error: `目标未出现：${targetSelector}`, stepsDone: done })
    })()
    return () => {
      cancelled = true
    }
  }, [scenario, enabled])

  return state
}
