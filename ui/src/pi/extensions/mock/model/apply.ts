/**
 * mock model → provider store 副作用（P4.2 M2e）：把场景步骤落到 31 项 provider 的可观察状态/事件上。
 *
 * 用途：`#/p4/<surface>?caps=all&model=<scenario>` 时 P4Route 用 `PiUiDemoTurnRunner` 逐步推进，
 * 每步调用本文件 → 变体 UI（订阅 provider 的组件）实时更新；e2e 断言 store 事件与数据变化。
 * 只依赖纯数据 + store 公开 API（actions/emitDemo），不碰 relay / DOM。
 */
import type { PiUiDemoModelStep } from "./scenarios"
import type { PiUiDemoStore } from "../store.ts"

/** 一步产生的副作用描述（供 e2e 断言 / 调试） */
export interface PiUiDemoApplyResult {
  capability: string
  kind: PiUiDemoModelStep["kind"]
  /** 该步触发的事件数 */
  events: number
}

/** 把一步应用到 mock store；返回副作用摘要（不抛错：缺能力时只留事件） */
export function applyPiUiDemoModelStep(store: PiUiDemoStore, step: PiUiDemoModelStep): PiUiDemoApplyResult {
  let events = 0
  const before = store.eventsOf().length
  switch (step.kind) {
    case "tool": {
      store.emitDemo("session-rail-extra", "model:tool", { name: step.name, input: step.input, output: step.output ?? "", state: step.state ?? "ok" })
      break
    }
    case "approval": {
      store.emitDemo("permission-tiers", "model:approval", { title: step.title, message: step.message, options: step.options, answer: step.answer })
      break
    }
    case "plan": {
      const plan = store.snapshotOf("plan-pane").plan
      for (const next of step.steps) store.actionsOf("plan-pane").updateStep?.(plan.id, next.id, next.status)
      store.emitDemo("plan-pane", "model:plan", { steps: step.steps })
      break
    }
    case "artifact": {
      store.emitDemo("artifacts", "artifact:created", { artifactId: step.artifactId })
      break
    }
    case "text":
    case "thinking": {
      store.emitDemo("suggestions", step.kind === "text" ? "model:text" : "model:thinking", { text: step.text })
      break
    }
    case "error": {
      store.emitDemo("background-tasks", "model:error", { message: step.message })
      break
    }
    case "done": {
      store.emitDemo("session-rail-extra", "model:done")
      break
    }
  }
  events = store.eventsOf().length - before
  return { capability: step.kind === "tool" ? "session-rail-extra" : step.kind, kind: step.kind, events }
}

/** 一次性把场景跑完（node/单测用；不推进计时） */
export function applyPiUiDemoModelStepList(store: PiUiDemoStore, steps: readonly PiUiDemoModelStep[]): PiUiDemoApplyResult[] {
  return steps.map((step) => applyPiUiDemoModelStep(store, step))
}
